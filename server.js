const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares para procesar JSON, formularios y servir la carpeta pública (frontend)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Carpeta temporal de subidas (se crea si no existe)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

// Configuración de Multer: determina dónde y cómo guardar los archivos recibidos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Prefijo con la fecha actual para evitar sobreescribir archivos con el mismo nombre
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// ==========================================
// ESTADO EN MEMORIA (Base de datos volátil)
// ==========================================
let activeTokens = []; // Tokens válidos generados por el profesor
let materials = [];    // Lista de enlaces y archivos físicos
let uploadTokens = []; // Tokens de un solo uso para que alumnos envíen trabajos
let studentSubmissions = []; // Lista de trabajos recibidos

// ==========================================
// MIDDLEWARE DE SEGURIDAD
// ==========================================
const requireToken = (req, res, next) => {
    // Busca el token en los headers (petición fetch) o en la query string (descarga de archivo)
    const token = req.headers['authorization'] || req.query.token;
    
    if (token && activeTokens.includes(token)) {
        return next(); // El token es válido, continúa con la petición
    }
    res.status(403).json({ error: 'Acceso denegado. Token inválido o la clase ya fue cerrada.' });
};

// ==========================================
// RUTAS DEL PROFESOR (Panel de Administración)
// ==========================================

// 1. Generar un nuevo token para una clase
app.post('/api/admin/token', (req, res) => {
    // Genera un token aleatorio de 6 caracteres hexadecimales (ej. 4F2A1B)
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    activeTokens.push(newToken);
    res.json({ token: newToken, activeTokens });
});

// 2. Subir un enlace de texto
app.post('/api/admin/material/link', (req, res) => {
    const { title, url } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'Faltan datos' });

    const material = {
        id: Date.now().toString(),
        type: 'link',
        title,
        url
    };
    materials.push(material);
    res.json({ message: 'Enlace agregado con éxito', material });
});

// 3. Subir un archivo físico
app.post('/api/admin/material/file', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    const material = {
        id: Date.now().toString(),
        type: 'file',
        title: req.file.originalname,
        path: req.file.path, // Ruta física en el disco (necesaria para la descarga)
        filename: req.file.filename,
        size: req.file.size
    };
    materials.push(material);
    res.json({ message: 'Archivo subido con éxito', material });
});

// Generar token para permitir que un estudiante envíe un archivo
app.post('/api/admin/upload-token', (req, res) => {
    // Genera un token aleatorio de 6 caracteres hexadecimales al igual que la clave de acceso
    const newToken = crypto.randomBytes(3).toString('hex').toUpperCase();
    uploadTokens.push(newToken);
    res.json({ token: newToken, uploadTokens });
});

// Descargar un trabajo recibido de un estudiante
app.get('/api/admin/download-submission/:id', (req, res) => {
    const submission = studentSubmissions.find(s => s.id === req.params.id);
    if (submission && fs.existsSync(submission.path)) {
        res.download(submission.path, submission.title);
    } else {
        res.status(404).send('Archivo no encontrado.');
    }
});

// Eliminar trabajos seleccionados
app.post('/api/admin/delete-submissions', express.json(), (req, res) => {
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

// Descargar todos los trabajos en un archivo ZIP
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
    studentSubmissions.forEach(sub => {
        if (fs.existsSync(sub.path)) {
            hasFiles = true;
            archive.file(sub.path, { name: sub.title });
        }
    });
    
    if (!hasFiles) {
        archive.append('No se encontraron trabajos o los archivos fueron borrados.', { name: 'info.txt' });
    }
    
    archive.finalize();
});

// 4. Obtener el estado actual (para refrescar el panel del profesor)
app.get('/api/admin/status', (req, res) => {
    let totalBytes = 0;
    materials.forEach(m => { if (m.size) totalBytes += m.size; });
    studentSubmissions.forEach(s => { if (s.size) totalBytes += s.size; });
    
    res.json({ activeTokens, materials, uploadTokens, studentSubmissions, totalBytes });
});

// 5. CERRAR CLASE (CRÍTICO): Borra memoria y destruye archivos físicos
app.post('/api/admin/close', (req, res) => {
    // Vaciar variables de la memoria del servidor
    activeTokens = [];
    materials = [];
    uploadTokens = [];
    studentSubmissions = [];

    // Eliminar los archivos físicamente de la carpeta "uploads"
    fs.readdir(UPLOAD_DIR, (err, files) => {
        if (err) {
            console.error("Error al leer directorio de uploads", err);
            return res.status(500).json({ error: 'Error interno al leer directorio' });
        }

        for (const file of files) {
            // Se usa fs.unlink para eliminar cada archivo iterado
            fs.unlink(path.join(UPLOAD_DIR, file), err => {
                if (err) console.error("Error al eliminar el archivo físico:", err);
            });
        }
    });

    res.json({ message: 'Clase cerrada exitosamente. Toda la información fue destruida.' });
});

// ==========================================
// RUTAS DEL ESTUDIANTE
// ==========================================

// 1. Validar el token ingresado por el alumno
app.post('/api/student/login', (req, res) => {
    const { token } = req.body;
    if (activeTokens.includes(token)) {
        res.json({ message: 'Token válido, ingresando...', token });
    } else {
        res.status(403).json({ error: 'Token inválido o clase inactiva.' });
    }
});

// 2. Obtener los materiales de la clase (Protegido por requireToken)
app.get('/api/student/materials', requireToken, (req, res) => {
    // Mapeamos los materiales para no enviar las rutas físicas absolutas del disco al frontend
    const safeMaterials = materials.map(m => {
        if (m.type === 'file') {
            return { id: m.id, type: m.type, title: m.title }; 
        }
        return m; // Enlaces se envían completos
    });
    
    // Mapeamos los trabajos para enviar solo el título y no las rutas de los otros alumnos
    const safeSubmissions = studentSubmissions.map(s => ({ title: s.title }));

    res.json({
        materials: safeMaterials,
        activeTokens: activeTokens,
        uploadTokens: uploadTokens,
        submissions: safeSubmissions
    });
});

// 3. Descargar archivo (Protegido por requireToken pasado por Query String)
app.get('/api/download/:id', requireToken, (req, res) => {
    const material = materials.find(m => m.id === req.params.id && m.type === 'file');

    // Validamos que el material exista en nuestro registro y el archivo no haya sido borrado del disco
    if (material && fs.existsSync(material.path)) {
        res.download(material.path, material.title);
    } else {
        res.status(404).send('Archivo no encontrado. Tal vez el profesor cerró la clase.');
    }
});

// 4. Subir un trabajo de estudiante (Protegido por token de entrega)
app.post('/api/student/upload', upload.single('file'), (req, res) => {
    const { uploadToken, studentName, studentGrade } = req.body;
    
    // Verificar que el token exista y sea válido
    if (!uploadToken || !uploadTokens.includes(uploadToken)) {
        // Borrar el archivo si el token es inválido
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'Token de entrega inválido o clase inactiva.' });
    }
    
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    // Limpiar y formatear el nombre y grado para evitar caracteres extraños en el archivo
    const safeName = (studentName || 'SinNombre').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const safeGrade = (studentGrade || 'SinGrado').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    const extension = path.extname(req.file.originalname) || '';
    
    // El título con el que verá y descargará el profesor el archivo
    const finalTitle = `${safeGrade}_${safeName}${extension}`;

    const submission = {
        id: Date.now().toString(),
        title: finalTitle,
        path: req.file.path,
        filename: req.file.filename,
        tokenUsed: uploadToken,
        size: req.file.size
    };
    
    studentSubmissions.push(submission);
    
    // Ya no se elimina el token para que pueda usarse múltiples veces
    // uploadTokens = uploadTokens.filter(t => t !== uploadToken);

    res.json({ message: 'Trabajo enviado con éxito', submission });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor de Aula Virtual corriendo en: http://localhost:${PORT}`);
    console.log(`👨‍🎓 Estudiantes: http://localhost:${PORT}/index.html`);
    console.log(`👨‍🏫 Profesor:  http://localhost:${PORT}/admin.html`);
});
