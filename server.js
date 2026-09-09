// Microservicio de estudios complementarios — lee de Supabase.
// Estrategia: primero busca en practicas_autorizadas (fuente nueva,
// ligada a facturación SIOS — si está ahí, es el dato "oficial" que
// también ve el PV y factura el prestador). Si no está ahí, cae a
// practicas_historicas (datos migrados de Sheets, incluye ATEM viejo).
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const PORT = process.env.PORT || 4000;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

// --- Mapeo tipo (frontend) -> codigo_prestacion en practicas_autorizadas ---
const CODIGO_A_TIPO = {
    '65007': 'mamografia',
    '185087': 'ecomamaria',
    '185086': 'ecografia',
    '205011': 'vcc',
    '285011': 'espirometria',
    '155012': 'papanicolau',
    '345099': 'densitometria',
};
const CODIGOS_LABORATORIO_EXTRA = ['B040103']; // "Práctica bioquímica"

// --- Alias para el fallback en practicas_historicas (nombres viejos) ---
const ALIAS_HISTORICO = { ecomamaria: 'eco_mamaria' };

// Tipos que no tienen PDF: son fichas estructuradas en tablas propias.
const TIPOS_FICHA = ['enfermeria'];

function extraerLink(linkPdfCrudo) {
    if (!linkPdfCrudo) return null;
    if (typeof linkPdfCrudo === 'string' && linkPdfCrudo.startsWith('http')) {
        return linkPdfCrudo;
    }
    try {
        const parsed = JSON.parse(linkPdfCrudo);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
    } catch (e) {
        // no era JSON, seguimos
    }
    return null;
}

function formatFecha(fechaISO) {
    if (!fechaISO) return null;
    const soloFecha = fechaISO.split('T')[0]; // por si viene con hora (timestamptz)
    const [y, m, d] = soloFecha.split('-');
    if (!y || !m || !d) return null;
    return `${d}/${m}/${y}`;
}

// Busca en practicas_autorizadas (fuente nueva, ligada a facturación).
async function buscarEnAutorizadas(dniStr, tipo) {
    let query = supabase
        .from('practicas_autorizadas')
        .select('enlace_pdf, fecha_carga')
        .eq('dni', dniStr)
        .eq('estado', 'REALIZADA')
        .not('enlace_pdf', 'is', null);

    if (tipo === 'laboratorio') {
        const filtroExtra = CODIGOS_LABORATORIO_EXTRA.map(c => `codigo_prestacion.eq.${c}`).join(',');
        query = query.or(`codigo_prestacion.like.679%,${filtroExtra}`);
    } else {
        const codigo = Object.keys(CODIGO_A_TIPO).find(c => CODIGO_A_TIPO[c] === tipo);
        if (!codigo) return null; // este tipo todavía no tiene código mapeado acá
        query = query.eq('codigo_prestacion', codigo);
    }

    const { data, error } = await query.order('fecha_carga', { ascending: false }).limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return null;

    const link = extraerLink(data[0].enlace_pdf);
    if (!link) return null;
    return { link, fechaResultado: formatFecha(data[0].fecha_carga) };
}

// Fallback: busca en practicas_historicas (datos migrados, incluye ATEM viejo).
async function buscarEnHistoricas(dniStr, tipo) {
    const tipoHistorico = ALIAS_HISTORICO[tipo] || tipo;
    const { data, error } = await supabase
        .from('practicas_historicas')
        .select('link_pdf, fecha')
        .eq('dni', dniStr)
        .eq('tipo_practica', tipoHistorico)
        .order('fecha', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    const link = extraerLink(data.link_pdf);
    if (!link) return null;
    return { link, fechaResultado: formatFecha(data.fecha) };
}

async function buscarEnfermeria(dniStr) {
    const { data, error } = await supabase
        .from('enfermeria_consultas')
        .select('nombre, apellido, dni, presion_arterial, agudeza_visual, peso_kg, altura_cm, circunferencia_cintura_cm, vacunas, nombre_enfermera, fecha_cierre_enf, created_at')
        .eq('dni', dniStr)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const fecha = data.fecha_cierre_enf || formatFecha(data.created_at);
    return {
        datos: {
            nombre: data.nombre,
            apellido: data.apellido,
            dni: data.dni,
            presion: data.presion_arterial,
            agudeza: data.agudeza_visual,
            peso: data.peso_kg,
            altura: data.altura_cm,
            cintura: data.circunferencia_cintura_cm,
            vacunas: data.vacunas,
            enfermera: data.nombre_enfermera,
            fecha,
        },
        fechaResultado: fecha,
    };
}

async function buscarOdontologia(dniStr) {
    const { data, error } = await supabase
        .from('odontologia_consultas')
        .select('enlace_pdf, fecha')
        .eq('dni', dniStr)
        .order('fecha', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    if (!data || !data.enlace_pdf) return null;
    return { link: data.enlace_pdf, fechaResultado: formatFecha(data.fecha) };
}

// Punto único de búsqueda para un tipo de estudio: intenta autorizadas
// primero, y si no hay nada, cae a historicas.
async function buscarEstudioPorTipo(dniStr, tipoOriginal) {
    const tipo = tipoOriginal;

    if (TIPOS_FICHA.includes(tipo)) return buscarEnfermeria(dniStr);
    if (tipo === 'odontologia') return buscarOdontologia(dniStr);

    const enAutorizadas = await buscarEnAutorizadas(dniStr, tipo);
    if (enAutorizadas) return enAutorizadas;

    return buscarEnHistoricas(dniStr, tipo);
}

// --- Endpoint original: un tipo por pedido (se mantiene por compatibilidad) ---
app.get('/api/buscar-estudios', async (req, res) => {
    const dni = req.query.dni;
    const tipo = req.query.tipo;

    if (!dni || !tipo) {
        return res.status(400).json({ error: "Parámetros 'dni' y 'tipo' son requeridos." });
    }

    const dniStr = String(dni).trim();
    console.log(`Buscando estudio TIPO: ${tipo} para DNI: ${dniStr}...`);

    try {
        const resultado = await buscarEstudioPorTipo(dniStr, tipo);
        if (!resultado) {
            console.log(`➡️ 404: ${tipo} no encontrado para DNI ${dniStr}.`);
            return res.status(404).json({ error: `No se encontraron estudios de ${tipo} para DNI ${dniStr}.` });
        }
        res.json(resultado);
    } catch (error) {
        console.error(`🚨 ERROR: ${error.message}`);
        res.status(500).json({ error: 'Fallo al consultar la base de datos.', details: error.message });
    }
});

// --- Endpoint consolidado: todos los tipos en un solo pedido ---
const TODOS_LOS_TIPOS = ['laboratorio', 'mamografia', 'ecografia', 'ecomamaria',
    'espirometria', 'enfermeria', 'densitometria', 'vcc', 'oftalmologia',
    'odontologia', 'biopsia', 'papanicolau'];

app.get('/api/buscar-estudios-completo', async (req, res) => {
    const dni = req.query.dni;
    if (!dni) return res.status(400).json({ error: "Parámetro 'dni' es requerido." });

    const dniStr = String(dni).trim();
    console.log(`Buscando TODOS los estudios para DNI: ${dniStr} (pedido único)`);

    try {
        const resultado = {};
        await Promise.all(TODOS_LOS_TIPOS.map(async (tipo) => {
            try {
                const encontrado = await buscarEstudioPorTipo(dniStr, tipo);
                if (encontrado) resultado[tipo] = encontrado;
            } catch (e) {
                console.error(`Error buscando ${tipo}:`, e.message);
            }
        }));

        console.log(`➡️ Encontrados ${Object.keys(resultado).length} tipos de estudio para DNI ${dniStr}.`);
        res.json(resultado);
    } catch (error) {
        console.error(`🚨 ERROR en buscar-estudios-completo: ${error.message}`);
        res.status(500).json({ error: 'Fallo al consultar la base de datos.', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log("-----------------------------------------------");
    console.log(`🎉 Microservicio de Estudios iniciado en el puerto: ${PORT}`);
    console.log(`🌐 Prueba: http://localhost:${PORT}/api/buscar-estudios?dni=TU_DNI&tipo=laboratorio`);
    console.log("-----------------------------------------------");
});