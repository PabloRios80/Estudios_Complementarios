// Microservicio de estudios complementarios — ahora lee directo de Supabase
// en vez de proxyar a la Web App de Apps Script.
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

// El frontend usa 'ecomamaria' pero en la base el tipo_practica es 'eco_mamaria'.
// Cualquier otro alias futuro se agrega acá.
const ALIAS_TIPO = {
    ecomamaria: 'eco_mamaria',
};

function extraerLink(linkPdfCrudo) {
    if (!linkPdfCrudo) return null;
    // A veces viene como string plano ("https://..."), a veces como texto
    // que en realidad es un array JSON con un único link adentro.
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
    const [y, m, d] = fechaISO.split('-');
    return `${d}/${m}/${y}`;
}

app.get('/api/buscar-estudios', async (req, res) => {
    const dni = req.query.dni;
    const tipoOriginal = req.query.tipo;

    if (!dni || !tipoOriginal) {
        return res.status(400).json({ error: "Parámetros 'dni' y 'tipo' son requeridos." });
    }

    const tipo = ALIAS_TIPO[tipoOriginal] || tipoOriginal;
    console.log(`Buscando estudio TIPO: ${tipo} para DNI: ${dni} en Supabase...`);

    try {
        // Enfermería no tiene PDF: es una ficha estructurada (peso, presión,
        // agudeza visual, vacunas, etc.) que el frontend muestra en un modal.
        if (tipo === 'enfermeria') {
            const { data, error } = await supabase
                .from('enfermeria_consultas')
                .select('nombre, apellido, dni, presion_arterial, agudeza_visual, peso_kg, altura_cm, circunferencia_cintura_cm, vacunas, nombre_enfermera, fecha_cierre_enf, created_at')
                .eq('dni', String(dni).trim())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error) throw error;
            if (!data) {
                return res.status(404).json({ error: `No hay ficha de enfermería para DNI ${dni}.` });
            }

            const fecha = data.fecha_cierre_enf || formatFecha(data.created_at ? data.created_at.split('T')[0] : null);
            const datos = {
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
            };
            return res.json({ datos, fechaResultado: fecha });
        }

        // Odontología vive en su propia tabla (fuente de verdad separada)
        if (tipo === 'odontologia') {
            const { data, error } = await supabase
                .from('odontologia_consultas')
                .select('enlace_pdf, fecha')
                .eq('dni', String(dni).trim())
                .order('fecha', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error) throw error;
            if (!data || !data.enlace_pdf) {
                return res.status(404).json({ error: `No se encontraron estudios de odontología para DNI ${dni}.` });
            }
            return res.json({ link: data.enlace_pdf, fechaResultado: formatFecha(data.fecha) });
        }

        // Todo lo demás sale de practicas_historicas
        const { data, error } = await supabase
            .from('practicas_historicas')
            .select('link_pdf, fecha')
            .eq('dni', String(dni).trim())
            .eq('tipo_practica', tipo)
            .order('fecha', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        const link = data ? extraerLink(data.link_pdf) : null;

        if (!link) {
            console.log(`➡️ 404: Estudios de ${tipo} no encontrados para DNI ${dni}.`);
            return res.status(404).json({ error: `No se encontraron estudios de ${tipo} para DNI ${dni}.` });
        }

        console.log(`➡️ Éxito: Encontrado el link de estudio ${tipo} para DNI ${dni}.`);
        res.json({ link, fechaResultado: formatFecha(data.fecha) });

    } catch (error) {
        console.error(`🚨 ERROR consultando Supabase: ${error.message}`);
        return res.status(500).json({
            error: "Fallo al consultar la base de datos.",
            details: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log("-----------------------------------------------");
    console.log(`🎉 Microservicio de Estudios (Supabase) iniciado en el puerto: ${PORT}`);
    console.log(`🌐 Endpoint de prueba: http://localhost:${PORT}/api/buscar-estudios?dni=TU_DNI&tipo=laboratorio`);
    console.log("-----------------------------------------------");
});