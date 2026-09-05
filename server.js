const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Función segura y asíncrona para eliminar archivos
const safeUnlink = async (filePath) => {
    try {
        if (filePath && fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
        }
    } catch (err) {
        console.error('Error eliminando archivo:', filePath, err.message);
    }
};

// Inicializar directorio y limpiar archivos huérfanos de sesiones previas
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} else {
    try {
        const files = fs.readdirSync(UPLOAD_DIR);
        for (const file of files) {
            safeUnlink(path.join(UPLOAD_DIR, file));
        }
    } catch (e) {
        console.error('Error al inicializar directorio de subidas:', e.message);
    }
}

// Configuración de Multer con límite estricto de tamaño en stream (50 MB)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${ext}`);
    }
});
const upload = multer({ 
    storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB límite físico para prevenir DoS
});

// BASE DE DATOS EFÍMERA (En Memoria)
let activeTokens = [];
let uploadTokens = [];
let materials = [];
let studentSubmissions = [];

// SESIONES DE ADMINISTRADOR
const ADMIN_USER = process.env.ADMIN_USER || 'profesorcito';
const ADMIN_PASS = process.env.ADMIN_PASS || 'edu.25694050';
let activeAdminSessions = new Set();

// ESTADO DE LA CLASE
let timerEndTime = null;
let latestAnnouncement = null;
let studentQuestions = [];
let liveSnippet = ""; 
let currentPoll = null; 
let maxFileSizeMB = 10; 
let lastStudentActivity = 0; // Rastrear si hay alumnos conectados

// Middleware para validar token de estudiante
const requireStudentToken = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (token && activeTokens.includes(token)) return next();
    return res.status(403).json({ error: 'Token inválido o expirado.' });
};

// Middleware para proteger rutas administrativas
const requireAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.startsWith('Bearer ')) 
        ? authHeader.slice(7) 
        : (req.headers['x-admin-token'] || req.query.adminToken);

    if (token && activeAdminSessions.has(token)) return next();
    return res.status(401).json({ error: 'Acceso no autorizado. Inicia sesión como docente.' });
};

// Función auxiliar para sanitizar nombres respetando caracteres españoles
const cleanString = (str, fallback) => {
    if (!str) return fallback;
    const normalized = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const cleaned = normalized.replace(/[^a-zA-Z0-9\s_-]/g, '').trim().replace(/\s+/g, '_');
    return cleaned || fallback;
};

// ==========================================
// RUTAS DEL ESTUDIANTE
// ==========================================

app.post('/api/student/login', (req, res) => {
    const { token } = req.body;
    if (token && activeTokens.includes(token.toUpperCase())) {
        res.json({ success: true, token: token.toUpperCase() });
    } else {
        res.status(401).json({ error: 'Token incorrecto o clase no iniciada.' });
    }
});

app.get('/api/student/materials', requireStudentToken, (req, res) => {
    lastStudentActivity = Date.now(); // Registrar actividad del alumno
    
    const safeMaterials = materials.map(m => {
        if (m.type === 'file') return { id: m.id, type: m.type, title: m.title }; 
        return m;
    });
    const safeSubmissions = studentSubmissions.map(s => ({ title: s.title }));

    let remaining = null;
    if (timerEndTime) {
        remaining = Math.max(0, Math.floor((timerEndTime - Date.now()) / 1000));
    }

    res.json({
        materials: safeMaterials,
        submissions: safeSubmissions,
        timerRemaining: remaining,
        announcement: latestAnnouncement,
        questions: studentQuestions,
        snippet: liveSnippet,
        poll: currentPoll,
        maxFileSize: maxFileSizeMB
    });
});

app.get('/api/download/:id', requireStudentToken, (req, res) => {
    const material = materials.find(m => m.id === req.params.id && m.type === 'file');
    if (material && fs.existsSync(material.path)) {
        res.download(material.path, material.title);
    } else {
        res.status(404).send('Archivo no encontrado.');
    }
});

app.post('/api/student/upload', upload.single('file'), async (req, res) => {
    if (timerEndTime && Date.now() > timerEndTime) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(403).json({ error: '¡El tiempo de entrega se ha agotado!' });
    }

    const { uploadToken, studentName, studentGrade } = req.body;
    const cleanUploadToken = (uploadToken || '').trim().toUpperCase();

    if (!cleanUploadToken || !uploadTokens.includes(cleanUploadToken)) {
        if (req.file) await safeUnlink(req.file.path);
        return res.status(403).json({ error: 'Código de Envío inválido o no autorizado.' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No se subió ningún archivo.' });
    }

    if (maxFileSizeMB > 0 && req.file.size > maxFileSizeMB * 1024 * 1024) {
        await safeUnlink(req.file.path);
        return res.status(400).json({ error: `El archivo excede el límite de ${maxFileSizeMB} MB permitido.` });
    }

    const safeName = cleanString(studentName, 'SinNombre');
    const safeGrade = cleanString(studentGrade, 'SinGrado');
    const extension = path.extname(req.file.originalname) || '';
    const finalTitle = `${safeGrade}_${safeName}${extension}`;

    const submission = {
        id: Date.now().toString() + '_' + crypto.randomBytes(2).toString('hex'),
        title: finalTitle,
        name: studentName || 'Anónimo',
        grade: studentGrade || 'SinGrado',
        path: req.file.path,
        filename: req.file.filename,
        tokenUsed: cleanUploadToken,
        size: req.file.size
    };
    
    studentSubmissions.push(submission);
    res.json({ success: true, fileId: submission.id });
});

app.post('/api/student/question', requireStudentToken, (req, res) => {
    const { name, text } = req.body;
    if (!text || text.trim() === '') return res.status(400).json({ error: 'Pregunta vacía' });
    const q = {
        id: Date.now().toString(),
        name: (name || 'Anónimo').trim().substring(0, 30),
        text: text.trim().substring(0, 200),
        time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    };
    studentQuestions.push(q);
    res.json({ success: true });
});

app.post('/api/student/vote', requireStudentToken, (req, res) => {
    const { pollId, optionIndex } = req.body;
    if (currentPoll && currentPoll.id === pollId && currentPoll.options[optionIndex] !== undefined) {
        currentPoll.options[optionIndex].votes++;
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Encuesta inactiva o inválida' });
});

// ==========================================
// AUTENTICACIÓN Y RUTAS DEL ADMINISTRADOR
// ==========================================

// Login de administrador con credenciales seguras
app.post('/api/admin/login', (req, res) => {
    const { user, pass } = req.body;
    const cleanUser = (user || '').trim().toLowerCase();
    const cleanPass = (pass || '').trim();

    if (cleanUser === ADMIN_USER && (cleanPass === ADMIN_PASS || cleanPass === `${ADMIN_PASS}.`)) {
        const sessionToken = crypto.randomBytes(32).toString('hex');
        activeAdminSessions.add(sessionToken);
        return res.json({ success: true, token: sessionToken });
    }
    return res.status(401).json({ error: 'Credenciales de docente incorrectas.' });
});

// Aplicar middleware requireAdmin a todas las rutas bajo /api/admin/*
app.use('/api/admin', requireAdmin);

app.post('/api/admin/token', (req, res) => {
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    activeTokens.push(newToken);
    res.json({ token: newToken });
});

app.post('/api/admin/upload-token', (req, res) => {
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    uploadTokens.push(newToken);
    timerEndTime = null;
    res.json({ token: newToken });
});

app.post('/api/admin/material', upload.single('file'), (req, res) => {
    const { type, url } = req.body;
    const title = (req.body.title || (req.file ? req.file.originalname : 'Material')).trim();
    const material = { id: Date.now().toString(), type, title };

    if (type === 'link') {
        if (!url) return res.status(400).json({ error: 'URL requerida.' });
        material.url = url;
    } else if (type === 'file' && req.file) {
        material.path = req.file.path;
        material.filename = req.file.filename;
        material.size = req.file.size;
    } else {
        if (req.file) safeUnlink(req.file.path);
        return res.status(400).json({ error: 'Datos de material inválidos.' });
    }

    materials.push(material);
    res.json({ success: true, material });
});

app.get('/api/admin/download-submission/:id', (req, res) => {
    const submission = studentSubmissions.find(s => s.id === req.params.id);
    if (submission && fs.existsSync(submission.path)) {
        res.download(submission.path, submission.title);
    } else {
        res.status(404).send('Archivo no encontrado.');
    }
});

app.post('/api/admin/delete-submissions', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Datos inválidos.' });
    
    for (const id of ids) {
        const index = studentSubmissions.findIndex(s => s.id === id);
        if (index !== -1) {
            await safeUnlink(studentSubmissions[index].path);
            studentSubmissions.splice(index, 1);
        }
    }
    res.json({ success: true });
});

app.get('/api/admin/download-zip', (req, res) => {
    const { colegio, grado } = req.query;
    const safeColegio = cleanString(colegio, 'Colegio');
    const safeGrado = cleanString(grado, 'Grado');
    
    res.attachment(`${safeColegio}_${safeGrado}_Trabajos.zip`);
    const archive = archiver('zip', { zlib: { level: 1 } });
    
    req.on('close', () => archive.abort());
    archive.on('error', (err) => {
        if (!res.headersSent) res.status(500).send('Error generando archivo ZIP');
    });

    archive.pipe(res);
    
    let hasFiles = false;
    let csvContent = '\uFEFFAlumno,Grado,Archivo,Fecha,Hora\n';
    const usedFilenames = new Map();

    studentSubmissions.forEach(sub => {
        if (fs.existsSync(sub.path)) {
            hasFiles = true;
            
            // Garantizar nombres únicos en el ZIP para evitar colisiones/sobrescritura
            let entryName = sub.title;
            if (usedFilenames.has(entryName)) {
                const count = usedFilenames.get(entryName) + 1;
                usedFilenames.set(entryName, count);
                const ext = path.extname(entryName);
                const base = path.basename(entryName, ext);
                entryName = `${base}_${count}${ext}`;
            } else {
                usedFilenames.set(entryName, 1);
            }

            archive.file(sub.path, { name: entryName });
            const dateObj = new Date(parseInt(sub.id.split('_')[0]) || Date.now());
            csvContent += `"${(sub.name || '').replace(/"/g, '""')}","${(sub.grade || '').replace(/"/g, '""')}","${entryName.replace(/"/g, '""')}","${dateObj.toLocaleDateString('es-ES')}","${dateObj.toLocaleTimeString('es-ES')}"\n`;
        }
    });
    
    if (hasFiles) archive.append(csvContent, { name: 'Reporte_Entregas.csv' });
    else archive.append('No hay trabajos entregados.', { name: 'info.txt' });
    
    archive.finalize();
});

app.post('/api/admin/timer', (req, res) => {
    const { minutes } = req.body;
    timerEndTime = (!minutes || minutes <= 0) ? null : Date.now() + (minutes * 60000);
    res.json({ success: true });
});

app.post('/api/admin/announce', (req, res) => {
    if (req.body.message) latestAnnouncement = { id: Date.now(), text: req.body.message };
    res.json({ success: true });
});

app.post('/api/admin/delete-question', (req, res) => {
    studentQuestions = studentQuestions.filter(q => q.id !== req.body.id);
    res.json({ success: true });
});

app.post('/api/admin/snippet', (req, res) => {
    liveSnippet = req.body.text || "";
    res.json({ success: true });
});

app.post('/api/admin/poll', (req, res) => {
    const { action, question, options } = req.body;
    if (action === 'start') {
        currentPoll = { id: Date.now().toString(), question: question, options: (options || []).map(opt => ({ text: opt, votes: 0 })) };
    } else if (action === 'stop') currentPoll = null;
    res.json({ success: true, poll: currentPoll });
});

app.post('/api/admin/limit', (req, res) => {
    const size = parseInt(req.body.sizeMB);
    if (!isNaN(size) && size >= 0) maxFileSizeMB = size;
    res.json({ success: true, maxFileSizeMB });
});

app.get('/api/admin/status', (req, res) => {
    let totalBytes = 0;
    materials.forEach(m => { if (m.size) totalBytes += m.size; });
    studentSubmissions.forEach(s => { if (s.size) totalBytes += s.size; });
    
    res.json({ 
        activeTokens, materials, uploadTokens, studentSubmissions, totalBytes,
        announcement: latestAnnouncement, 
        questions: studentQuestions, snippet: liveSnippet, poll: currentPoll, maxFileSizeMB
    });
});

app.post('/api/admin/close', async (req, res) => {
    for (const item of [...materials, ...studentSubmissions]) {
        if (item.path) await safeUnlink(item.path);
    }

    activeTokens = []; uploadTokens = []; materials = []; studentSubmissions = [];
    timerEndTime = null; latestAnnouncement = null;
    studentQuestions = []; liveSnippet = ""; currentPoll = null; lastStudentActivity = 0;
    res.json({ success: true });
});

// Middleware global de manejo de errores
app.use((err, req, res, next) => {
    if (req.file) safeUnlink(req.file.path);
    console.error('Error no controlado en middleware:', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor.' });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
