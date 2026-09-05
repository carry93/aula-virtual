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
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

// Configuración de multer para las subidas de alumnos y materiales del profesor
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// BASE DE DATOS EFÍMERA (En Memoria)
let activeTokens = [];
let uploadTokens = [];
let materials = [];
let studentSubmissions = [];

// NUEVAS VARIABLES DE ESTADO (Para controles avanzados)
let submissionsLocked = false;
let timerEndTime = null;
let latestAnnouncement = null;
let studentQuestions = [];

// MIDDLEWARE DE SEGURIDAD
const requireToken = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (token && activeTokens.includes(token)) {
        return next();
    }
    return res.status(403).json({ error: 'Token inválido o expirado.' });
};

// ==========================================
// RUTAS DEL ESTUDIANTE
// ==========================================

// 1. Ingresar a la clase
app.post('/api/student/login', (req, res) => {
    const { token } = req.body;
    if (activeTokens.includes(token)) {
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Token incorrecto o clase no iniciada.' });
    }
});

// 2. Obtener los datos en vivo de la clase
app.get('/api/student/materials', requireToken, (req, res) => {
    const safeMaterials = materials.map(m => {
        if (m.type === 'file') return { id: m.id, type: m.type, title: m.title }; 
        return m;
    });
    
    const safeSubmissions = studentSubmissions.map(s => ({ title: s.title }));

    res.json({
        materials: safeMaterials,
        activeTokens: activeTokens,
        uploadTokens: uploadTokens,
        submissions: safeSubmissions,
        locked: submissionsLocked,
        timerEndTime: timerEndTime,
        announcement: latestAnnouncement,
        questions: studentQuestions
    });
});

// 3. Descargar archivo
app.get('/api/download/:id', requireToken, (req, res) => {
    const material = materials.find(m => m.id === req.params.id && m.type === 'file');
    if (material && fs.existsSync(material.path)) {
        res.download(material.path, material.title);
    } else {
        res.status(404).send('Archivo no encontrado. Tal vez el profesor cerró la clase.');
    }
});

// 4. Subir un trabajo de estudiante
app.post('/api/student/upload', upload.single('file'), (req, res) => {
    // Verificamos si hay bloqueo o el tiempo se acabó
    if (submissionsLocked) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'Las entregas están pausadas por el profesor.' });
    }
    if (timerEndTime && Date.now() > timerEndTime) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: '¡El tiempo de entrega se ha agotado!' });
    }

    const { uploadToken, studentName, studentGrade } = req.body;
    if (!uploadToken || !uploadTokens.includes(uploadToken)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'Token de entrega inválido o clase inactiva.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    const safeName = (studentName || 'SinNombre').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const safeGrade = (studentGrade || 'SinGrado').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const extension = path.extname(req.file.originalname) || '';
    
    const finalTitle = `${safeGrade}_${safeName}${extension}`;

    const submission = {
        id: Date.now().toString(),
        title: finalTitle,
        name: studentName,
        grade: studentGrade,
        path: req.file.path,
        filename: req.file.filename,
        tokenUsed: uploadToken,
        size: req.file.size
    };
    
    studentSubmissions.push(submission);
    res.json({ success: true, fileId: submission.id });
});

// 5. Enviar una pregunta (Duda)
app.post('/api/student/question', requireToken, (req, res) => {
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

// ==========================================
// RUTAS DEL ADMINISTRADOR (Profesor)
// ==========================================

app.post('/api/admin/token', (req, res) => {
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    activeTokens.push(newToken);
    res.json({ token: newToken, activeTokens });
});

app.post('/api/admin/upload-token', (req, res) => {
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    uploadTokens.push(newToken);
    res.json({ token: newToken, uploadTokens });
});

app.post('/api/admin/material', upload.single('file'), (req, res) => {
    const { type, title, url } = req.body;
    const material = { id: Date.now().toString(), type, title };
    if (type === 'link') {
        material.url = url;
    } else if (type === 'file' && req.file) {
        material.path = req.file.path;
        material.filename = req.file.filename;
        material.size = req.file.size;
    } else {
        return res.status(400).json({ error: 'Datos inválidos' });
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

app.post('/api/admin/delete-submissions', (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Datos inválidos' });
    
    ids.forEach(id => {
        const index = studentSubmissions.findIndex(s => s.id === id);
        if (index !== -1) {
            const file = studentSubmissions[index];
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            studentSubmissions.splice(index, 1);
        }
    });
    res.json({ success: true });
});

// Descargar ZIP + Excel (CSV)
app.get('/api/admin/download-zip', (req, res) => {
    const { colegio, grado } = req.query;
    const safeColegio = (colegio || 'Colegio').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const safeGrado = (grado || 'Grado').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const zipName = `${safeColegio}_${safeGrado}_Trabajos.zip`;
    
    res.attachment(zipName);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('error', err => { res.status(500).send({ error: err.message }); });
    archive.pipe(res);
    
    let hasFiles = false;
    let csvContent = '\uFEFFAlumno,Grado,Archivo,Fecha,Hora\n'; // \uFEFF para que Excel lea los tildes (BOM UTF-8)

    studentSubmissions.forEach(sub => {
        if (fs.existsSync(sub.path)) {
            hasFiles = true;
            archive.file(sub.path, { name: sub.title });
            
            // Construir línea del Excel
            const dateObj = new Date(parseInt(sub.id));
            const dateStr = dateObj.toLocaleDateString('es-ES');
            const timeStr = dateObj.toLocaleTimeString('es-ES');
            const sName = (sub.name || 'Desconocido').replace(/"/g, '""');
            const sGrade = (sub.grade || 'Desconocido').replace(/"/g, '""');
            const sTitle = (sub.title || '').replace(/"/g, '""');
            
            csvContent += `"${sName}","${sGrade}","${sTitle}","${dateStr}","${timeStr}"\n`;
        }
    });
    
    if (hasFiles) {
        archive.append(csvContent, { name: 'Reporte_Entregas.csv' });
    } else {
        archive.append('No se encontraron trabajos.', { name: 'info.txt' });
    }
    
    archive.finalize();
});

// Controles de Clase (Megáfono, Pausa, Reloj)
app.post('/api/admin/toggle-lock', (req, res) => {
    submissionsLocked = !submissionsLocked;
    res.json({ success: true, locked: submissionsLocked });
});

app.post('/api/admin/timer', (req, res) => {
    const { minutes } = req.body;
    if (!minutes || minutes <= 0) {
        timerEndTime = null;
    } else {
        timerEndTime = Date.now() + (minutes * 60000);
    }
    res.json({ success: true, timerEndTime });
});

app.post('/api/admin/announce', (req, res) => {
    const { message } = req.body;
    if (message) {
        latestAnnouncement = { id: Date.now(), text: message };
    }
    res.json({ success: true });
});

app.post('/api/admin/delete-question', (req, res) => {
    const { id } = req.body;
    studentQuestions = studentQuestions.filter(q => q.id !== id);
    res.json({ success: true });
});

app.get('/api/admin/status', (req, res) => {
    let totalBytes = 0;
    materials.forEach(m => { if (m.size) totalBytes += m.size; });
    studentSubmissions.forEach(s => { if (s.size) totalBytes += s.size; });
    
    res.json({ 
        activeTokens, materials, uploadTokens, studentSubmissions, totalBytes,
        locked: submissionsLocked, timerEndTime, announcement: latestAnnouncement, questions: studentQuestions
    });
});

app.post('/api/admin/close', (req, res) => {
    const deleteFiles = (arr) => {
        arr.forEach(item => {
            if (item.path && fs.existsSync(item.path)) {
                try { fs.unlinkSync(item.path); } catch (e) { console.error('Error al borrar', e); }
            }
        });
    };
    deleteFiles(materials);
    deleteFiles(studentSubmissions);

    activeTokens = [];
    uploadTokens = [];
    materials = [];
    studentSubmissions = [];
    submissionsLocked = false;
    timerEndTime = null;
    latestAnnouncement = null;
    studentQuestions = [];

    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
