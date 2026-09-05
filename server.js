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
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

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

// ESTADO DE LA CLASE
let submissionsLocked = true; // EMPIEZA BLOQUEADO POR DEFECTO
let timerEndTime = null;
let latestAnnouncement = null;
let studentQuestions = [];
let liveSnippet = ""; 
let currentPoll = null; 
let maxFileSizeMB = 10; 
let lastStudentActivity = 0; // PARA RASTREAR SI HAY ALUMNOS EN LÍNEA

const requireToken = (req, res, next) => {
    const token = req.headers['authorization'] || req.query.token;
    if (token && activeTokens.includes(token)) return next();
    return res.status(403).json({ error: 'Token inválido o expirado.' });
};

// ==========================================
// RUTAS DEL ESTUDIANTE
// ==========================================

app.post('/api/student/login', (req, res) => {
    const { token } = req.body;
    if (activeTokens.includes(token)) res.json({ success: true, token });
    else res.status(401).json({ error: 'Token incorrecto o clase no iniciada.' });
});

app.get('/api/student/materials', requireToken, (req, res) => {
    lastStudentActivity = Date.now(); // REGISTRAR ACTIVIDAD DEL ALUMNO
    
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
        activeTokens: activeTokens,
        uploadTokens: uploadTokens,
        submissions: safeSubmissions,
        locked: submissionsLocked,
        timerRemaining: remaining, // ENVIAR SEGUNDOS RESTANTES (EVITA DESINCRONIZACIÓN DE RELOJ)
        announcement: latestAnnouncement,
        questions: studentQuestions,
        snippet: liveSnippet,
        poll: currentPoll,
        maxFileSize: maxFileSizeMB
    });
});

app.get('/api/download/:id', requireToken, (req, res) => {
    const material = materials.find(m => m.id === req.params.id && m.type === 'file');
    if (material && fs.existsSync(material.path)) res.download(material.path, material.title);
    else res.status(404).send('Archivo no encontrado.');
});

app.post('/api/student/upload', upload.single('file'), (req, res) => {
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
        return res.status(403).json({ error: 'Código de Envío inválido.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    if (maxFileSizeMB > 0 && req.file.size > maxFileSizeMB * 1024 * 1024) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: `El archivo excede el límite de ${maxFileSizeMB} MB permitido por el profesor.` });
    }

    const safeName = (studentName || 'SinNombre').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const safeGrade = (studentGrade || 'SinGrado').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const extension = path.extname(req.file.originalname) || '';
    const finalTitle = `${safeGrade}_${safeName}${extension}`;

    const submission = {
        id: Date.now().toString(), title: finalTitle, name: studentName, grade: studentGrade,
        path: req.file.path, filename: req.file.filename, tokenUsed: uploadToken, size: req.file.size
    };
    
    studentSubmissions.push(submission);
    res.json({ success: true, fileId: submission.id });
});

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

app.post('/api/student/vote', requireToken, (req, res) => {
    const { pollId, optionIndex } = req.body;
    if (currentPoll && currentPoll.id === pollId && currentPoll.options[optionIndex] !== undefined) {
        currentPoll.options[optionIndex].votes++;
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Encuesta inactiva o inválida' });
});

// ==========================================
// RUTAS DEL ADMINISTRADOR
// ==========================================

app.post('/api/admin/token', (req, res) => {
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    activeTokens.push(newToken);
    res.json({ token: newToken });
});

app.post('/api/admin/upload-token', (req, res) => {
    // REGLA: No generar si no hay alumnos (última actividad > 15s)
    if (Date.now() - lastStudentActivity > 15000) {
        return res.status(400).json({ error: '⚠️ No puedes generar un código de envío porque aún no hay estudiantes conectados a la clase.' });
    }
    
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    uploadTokens.push(newToken);
    
    // Al generar pase de entrega, habilitar automáticamente y borrar timer
    submissionsLocked = false;
    timerEndTime = null;

    res.json({ token: newToken });
});

app.post('/api/admin/material', upload.single('file'), (req, res) => {
    const { type, title, url } = req.body;
    const material = { id: Date.now().toString(), type, title };
    if (type === 'link') material.url = url;
    else if (type === 'file' && req.file) {
        material.path = req.file.path; material.filename = req.file.filename; material.size = req.file.size;
    } else return res.status(400).json({ error: 'Datos inválidos' });
    materials.push(material);
    res.json({ success: true, material });
});

app.get('/api/admin/download-submission/:id', (req, res) => {
    const submission = studentSubmissions.find(s => s.id === req.params.id);
    if (submission && fs.existsSync(submission.path)) res.download(submission.path, submission.title);
    else res.status(404).send('Archivo no encontrado.');
});

app.post('/api/admin/delete-submissions', (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Datos inválidos' });
    ids.forEach(id => {
        const index = studentSubmissions.findIndex(s => s.id === id);
        if (index !== -1) {
            if (fs.existsSync(studentSubmissions[index].path)) fs.unlinkSync(studentSubmissions[index].path);
            studentSubmissions.splice(index, 1);
        }
    });
    res.json({ success: true });
});

app.get('/api/admin/download-zip', (req, res) => {
    const { colegio, grado } = req.query;
    const safeColegio = (colegio || 'Colegio').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const safeGrado = (grado || 'Grado').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    
    res.attachment(`${safeColegio}_${safeGrado}_Trabajos.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    
    let hasFiles = false;
    let csvContent = '\uFEFFAlumno,Grado,Archivo,Fecha,Hora\n';
    studentSubmissions.forEach(sub => {
        if (fs.existsSync(sub.path)) {
            hasFiles = true;
            archive.file(sub.path, { name: sub.title });
            const dateObj = new Date(parseInt(sub.id));
            csvContent += `"${(sub.name || '').replace(/"/g, '""')}","${(sub.grade || '').replace(/"/g, '""')}","${(sub.title || '').replace(/"/g, '""')}","${dateObj.toLocaleDateString('es-ES')}","${dateObj.toLocaleTimeString('es-ES')}"\n`;
        }
    });
    
    if (hasFiles) archive.append(csvContent, { name: 'Reporte_Entregas.csv' });
    else archive.append('No hay trabajos.', { name: 'info.txt' });
    
    archive.finalize();
});

app.post('/api/admin/toggle-lock', (req, res) => {
    submissionsLocked = !submissionsLocked;
    // Si estamos desbloqueando manualmente, quitamos cualquier timer residual
    if (!submissionsLocked) timerEndTime = null;
    res.json({ success: true, locked: submissionsLocked });
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
        currentPoll = { id: Date.now().toString(), question: question, options: options.map(opt => ({ text: opt, votes: 0 })) };
    } else if (action === 'stop') currentPoll = null;
    res.json({ success: true, poll: currentPoll });
});

app.post('/api/admin/limit', (req, res) => {
    const size = parseInt(req.body.sizeMB);
    if (!isNaN(size)) maxFileSizeMB = size;
    res.json({ success: true, maxFileSizeMB });
});

app.get('/api/admin/status', (req, res) => {
    let totalBytes = 0;
    materials.forEach(m => { if (m.size) totalBytes += m.size; });
    studentSubmissions.forEach(s => { if (s.size) totalBytes += s.size; });
    
    res.json({ 
        activeTokens, materials, uploadTokens, studentSubmissions, totalBytes,
        locked: submissionsLocked, announcement: latestAnnouncement, 
        questions: studentQuestions, snippet: liveSnippet, poll: currentPoll, maxFileSizeMB
    });
});

app.post('/api/admin/close', (req, res) => {
    const deleteFiles = (arr) => {
        arr.forEach(item => { if (item.path && fs.existsSync(item.path)) fs.unlinkSync(item.path); });
    };
    deleteFiles(materials); deleteFiles(studentSubmissions);

    activeTokens = []; uploadTokens = []; materials = []; studentSubmissions = [];
    submissionsLocked = true; timerEndTime = null; latestAnnouncement = null;
    studentQuestions = []; liveSnippet = ""; currentPoll = null; lastStudentActivity = 0;
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
