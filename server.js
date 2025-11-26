// Microservicio que llama a la Web App de Google Apps Script
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios'); // Necesario para hacer la llamada HTTP a Apps Script

dotenv.config();

// Variables del entorno (solo necesitamos el URL del Apps Script y el Puerto)
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const PORT = process.env.PORT || 4000;

// Inicialización de Express
const app = express();
app.use(cors());
app.use(express.json()); // Middleware para parsear JSON

// Middleware de verificación crítica al inicio (solo para verificar el URL)
if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === "[PEGA AQUÍ LA URL COMPLETA DE TU WEB APP]") {
    console.error("🚨 ERROR CRÍTICO DE CONFIGURACIÓN.");
    console.error("Asegúrate de que la variable APPS_SCRIPT_URL está correctamente definida y no es el placeholder en tu archivo .env.");
    // No salimos, pero la API fallará si es llamada.
} else {
    console.log(`✅ URL de Apps Script configurada.`);
}


/**
 * Endpoint para buscar estudios complementarios usando la Web App de Apps Script.
 * Acepta DNI y el TIPO de estudio ('laboratorio', 'mamografia', etc.) para una búsqueda específica.
 */
app.get('/api/buscar-estudios', async (req, res) => {
    const dni = req.query.dni;
    const tipo = req.query.tipo; // <-- NUEVO: Capturamos el tipo de estudio
    
    // Verificación de parámetros: DNI y TIPO son ahora obligatorios
    if (!dni || !tipo) {
        return res.status(400).json({ error: "Parámetros 'dni' y 'tipo' son requeridos." });
    }

    try {
        console.log(`Buscando estudio complementario TIPO: ${tipo} para DNI: ${dni} a través de Apps Script...`);

        // Construye el URL de la Web App con AMBOS parámetros 'dni' y 'tipo'
        const urlFinal = `${APPS_SCRIPT_URL}?dni=${dni}&tipo=${tipo}`; // <-- URL final
        console.log(`Llamando a: ${urlFinal}`);

        // Realiza la solicitud GET a la API de Apps Script
        const response = await axios.get(urlFinal);
        
        const data = response.data;
        
        // El Apps Script ya devuelve el JSON formateado (incluyendo link: null si no se encuentra)

        if (data.error && data.status === 404) {
             // Si Apps Script devuelve 404, indicamos que no hay datos
            console.log(`➡️ 404: Estudios de ${tipo} no encontrados para DNI ${dni}.`);
            return res.status(404).json(data);
        }

        if (data.error || data.status >= 400) {
            // Manejo de errores internos devueltos por Apps Script (ej: hoja no encontrada, 500)
            console.error(`🚨 Error devuelto por Apps Script: ${data.error}`);
            return res.status(data.status || 500).json({ error: data.error || "Error desconocido en Apps Script." });
        }
        
        console.log(`➡️ Éxito: Encontrado el link de estudio ${tipo} para DNI ${dni}.`);
        res.json(data);


    } catch (error) {
        console.error(`🚨 ERROR CRÍTICO en la llamada a Apps Script: ${error.message}`);
        
        // Verifica si el error es de red o URL mal formada
        if (error.response) {
            // El servidor respondió con un estado fuera de 2xx (ej: 400, 503)
            return res.status(error.response.status).json({
                error: `Error HTTP al llamar a Apps Script: ${error.response.status} - ${error.response.statusText}`,
                details: error.response.data
            });
        }
        
        // Error de red, URL mal formada, etc.
        return res.status(500).json({ 
            error: "Fallo de conexión. Verifica que el APPS_SCRIPT_URL sea correcto y esté activo.",
            details: error.message
        });
    }
});

// Inicio del servidor
app.listen(PORT, () => {
    console.log("-----------------------------------------------");
    console.log(`🎉 Microservicio de Estudios iniciado en el puerto: ${PORT}`);
    console.log(`🌐 Endpoint de prueba: http://localhost:${PORT}/api/buscar-estudios?dni=TU_DNI&tipo=laboratorio`);
    console.log("-----------------------------------------------");
});