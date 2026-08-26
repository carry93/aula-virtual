const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
        filename: req.file.filename
    };
    materials.push(material);
    res.json({ message: 'Archivo subido con éxito', material });
});

// 4. Obtener el estado actual (para refrescar el panel del profesor)
app.get('/api/admin/status', (req, res) => {
    res.json({ activeTokens, materials });
});

// 5. CERRAR CLASE (CRÍTICO): Borra memoria y destruye archivos físicos
app.post('/api/admin/close', (req, res) => {
    // Vaciar variables de la memoria del servidor
    activeTokens = [];
    materials = [];

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
    res.json(safeMaterials);
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

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor de Aula Virtual corriendo en: http://localhost:${PORT}`);
    console.log(`👨‍🎓 Estudiantes: http://localhost:${PORT}/index.html`);
    console.log(`👨‍🏫 Profesor:  http://localhost:${PORT}/admin.html`);
});
