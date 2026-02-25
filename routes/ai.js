/**
 * AI routes — property descriptions, smart replies, buyer assistant.
 */

const express            = require('express');
const router             = express.Router();
const rateLimit          = require('express-rate-limit');
const RedisStore         = require('rate-limit-redis').default;
const redis              = require('../db/redis');
const pool               = require('../db/pool');
const authenticateToken  = require('../middleware/authenticateToken');
const jwt                = require('jsonwebtoken');
const { aiGenerate, aiGenerateMessages } = require('../utils/ai');

// ── Optional auth: sets req.user if token is valid, continues otherwise ─────────
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
}

// ── Per-user rate limiters ──────────────────────────────────────────────────────
// All AI endpoints require authenticateToken, so req.user.id is always available.
function userKeyGenerator(req) {
  return `ai:ul:${req.user?.id ?? 'anon'}`;
}

const descriptionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, ip: false },
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:ai:desc:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit', message: 'Demasiados intentos. Intenta en unos minutos.' }),
});

const smartRepliesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, ip: false },
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:ai:replies:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit' }),
});

const assistantLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => `ai:ul:${req.user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:ai:assist:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit', message: 'Has enviado muchos mensajes. Espera unos minutos.' }),
});

// ── Helper: promisified pool.query ──────────────────────────────────────────────
function q(sql, params) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// ── Cached user context (Redis, 5-min TTL) ─────────────────────────────────────
async function getUserContextCached(userId, ttlSeconds = 300) {
  const cacheKey = `user:context:${userId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* cache miss is fine */ }

  const [buyingPower, infonavit, tenantProfile, qualifying] = await Promise.all([
    q('SELECT * FROM buying_power WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]).catch(() => []),
    q('SELECT * FROM infonavit_calculations WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]).catch(() => []),
    q('SELECT * FROM tenant_profiles WHERE user_id = ? LIMIT 1', [userId]).catch(() => []),
    q('SELECT * FROM user_qualifying_profile WHERE user_id = ? LIMIT 1', [userId]).catch(() => []),
  ]);

  const result = {
    buying_power: buyingPower[0] || null,
    infonavit: infonavit[0] || null,
    tenant_profile: tenantProfile[0] || null,
    qualifying: qualifying[0] || null,
  };

  try { await redis.set(cacheKey, JSON.stringify(result), 'EX', ttlSeconds); } catch { /* non-critical */ }
  return result;
}

// ── Estate type labels ──────────────────────────────────────────────────────────
const ESTATE_LABELS = {
  casa: 'Casa', departamento: 'Departamento', terreno: 'Terreno',
  condominio: 'Condominio', estudio: 'Estudio',
};

const AMENITY_LABELS = {
  private_pool: 'alberca privada', new_construction: 'nueva construcción',
  water_serv: 'agua', electricity_serv: 'electricidad', sewer_serv: 'drenaje',
  solar: 'paneles solares', ac: 'aire acondicionado', laundry_room: 'cuarto de lavado',
  gated_community: 'fraccionamiento cerrado', clubhouse: 'casa club', gym: 'gimnasio',
  common_pool: 'alberca común', playground: 'área de juegos', park_garden: 'jardines',
  sports_court: 'cancha deportiva', event_room: 'salón de eventos', bbq_area: 'área de asadores',
  surveillance_24_7: 'vigilancia 24/7', controlled_access: 'acceso controlado', cctv: 'CCTV',
  alarm: 'alarma', service_room: 'cuarto de servicio', roof_garden: 'roof garden',
  private_garden: 'jardín privado', storage_room: 'bodega', study_office: 'estudio/oficina',
  fitted_kitchen: 'cocina integral', closets: 'closets', cistern: 'cisterna',
  water_heater: 'calentador', furnished: 'amueblado', pets_allowed: 'acepta mascotas',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 1: Generate property description
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/api/ai/property-description', authenticateToken, descriptionLimiter, async (req, res) => {
  try {
    const { type, estate_type, price, monthly_pay, bedrooms, bathrooms, half_bathrooms,
            land, construction, parking_spaces, stories, address, amenities } = req.body;

    if (!type || !estate_type) {
      return res.status(400).json({ ok: false, error: 'Tipo de propiedad y tipo de inmueble son requeridos.' });
    }

    const tipoLabel = type === 'venta' ? 'Venta' : type === 'renta' ? 'Renta' : type;
    const estateLabel = ESTATE_LABELS[estate_type] || estate_type;

    // Build amenities list
    const amenityList = [];
    if (amenities && typeof amenities === 'object') {
      for (const [key, val] of Object.entries(amenities)) {
        if (val && AMENITY_LABELS[key]) amenityList.push(AMENITY_LABELS[key]);
      }
    }

    const priceStr = type === 'renta'
      ? (monthly_pay ? `$${Number(monthly_pay).toLocaleString('es-MX')}/mes` : 'precio no especificado')
      : (price ? `$${Number(price).toLocaleString('es-MX')}` : 'precio no especificado');

    const details = [
      `Tipo: ${estateLabel} en ${tipoLabel}`,
      `Precio: ${priceStr}`,
      bedrooms ? `Recámaras: ${bedrooms}` : null,
      bathrooms ? `Baños: ${bathrooms}` : null,
      half_bathrooms ? `Medios baños: ${half_bathrooms}` : null,
      land ? `Terreno: ${land} m²` : null,
      construction ? `Construcción: ${construction} m²` : null,
      parking_spaces ? `Estacionamiento: ${parking_spaces}` : null,
      stories ? `Pisos: ${stories}` : null,
      address ? `Ubicación: ${address}` : null,
      amenityList.length ? `Amenidades: ${amenityList.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    // Detect tier for tone adaptation
    const numPrice = Number(price) || 0;
    const numRent = Number(monthly_pay) || 0;
    const tier = (type === 'venta' && numPrice >= 5000000) || (type === 'renta' && numRent >= 25000)
      ? 'luxury'
      : (type === 'venta' && numPrice > 0 && numPrice < 1500000) || (type === 'renta' && numRent > 0 && numRent < 8000)
        ? 'affordable'
        : 'standard';

    const toneHint = tier === 'luxury'
      ? 'Tono aspiracional y exclusivo: transmite prestigio, estilo de vida premium'
      : tier === 'affordable'
        ? 'Tono práctico y accesible: enfatiza valor, oportunidad, buena inversión'
        : 'Tono profesional y cálido: equilibra confianza con calidez';

    // Detect security features to highlight
    const securityFeatures = ['surveillance_24_7', 'controlled_access', 'cctv', 'alarm', 'gated_community']
      .filter(k => amenities && amenities[k]);
    const securityHint = securityFeatures.length > 0
      ? '\n- Esta propiedad tiene seguridad — DESTÁCALO, es factor decisivo en México'
      : '';

    // Completeness check
    const totalFields = ['type', 'estate_type', 'price', 'monthly_pay', 'bedrooms', 'bathrooms', 'half_bathrooms', 'land', 'construction', 'parking_spaces', 'stories', 'address'].length;
    const filledFields = [type, estate_type, price, monthly_pay, bedrooms, bathrooms, half_bathrooms, land, construction, parking_spaces, stories, address].filter(Boolean).length;
    const completeness = filledFields / totalFields;
    const completenessNote = completeness < 0.6
      ? '\n\n(Tip: completa más detalles de la propiedad para obtener una descripción más precisa y persuasiva)'
      : '';

    const systemPrompt = `Eres el vendedor inmobiliario #1 de México. Tu trabajo NO es listar datos — es VENDER un estilo de vida.

REGLAS ABSOLUTAS:
- Entre 350 y 500 caracteres. Ni menos, ni más.
- Español mexicano natural, sin emojis, sin hashtags.
- PROHIBIDO repetir los datos como lista ("3 recámaras, 2 baños, 150m²"). Eso ya lo ve el comprador en la ficha técnica.
- En vez de listar, TRANSFORMA los datos en beneficios y sensaciones:
  * NO: "Casa de 3 recámaras con alberca" → SÍ: "Imagina llegar cada tarde a refrescarte en tu propia alberca mientras los niños juegan en su propio espacio"
  * NO: "200m² de construcción" → SÍ: "Espacios amplios donde cada rincón respira comodidad"
  * NO: "Fraccionamiento con vigilancia 24/7" → SÍ: "Tu familia duerme tranquila con seguridad las 24 horas"
- Abre con un gancho emocional irresistible — la primera frase decide si siguen leyendo o no
- Si hay ubicación, véndela como zona de vida, no como dato ("en el corazón de...", "a minutos de todo lo que necesitas")${securityHint}
- Cierra con urgencia sutil que empuje a actuar ("Agenda tu visita antes de que alguien más la aparte", "Esta oportunidad no espera")
- ${toneHint}
- Nunca inventes información que no fue proporcionada — si faltan datos, enfócate en lo que SÍ tienes y hazlo brillar
- Responde ÚNICAMENTE con la descripción, sin comillas, sin títulos, sin explicaciones.`;

    const userPrompt = `Genera una descripción para esta propiedad:\n${details}${completenessNote}`;

    const description = await aiGenerate(systemPrompt, userPrompt, {
      cacheTTL: 3600,
      cachePrefix: 'desc',
    });

    // Enforce max length
    const trimmed = description.length > 500 ? description.substring(0, 497) + '...' : description;

    return res.json({ ok: true, description: trimmed });
  } catch (err) {
    console.error('[ai:description]', err.message);
    if (err.message === 'AI_DISABLED') {
      return res.status(503).json({ ok: false, error: 'ai_disabled', message: 'IA no disponible temporalmente.' });
    }
    return res.status(500).json({ ok: false, error: 'ai_error', message: 'No se pudo generar la descripción.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 2: Smart replies for agents
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/api/ai/smart-replies', authenticateToken, smartRepliesLimiter, async (req, res) => {
  try {
    // Verify user is an agent
    const userId = req.user?.id;
    const [userRows] = await q('SELECT agent_type FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!userRows || userRows.agent_type === 'regular' || !userRows.agent_type) {
      return res.status(403).json({ ok: false, error: 'Solo agentes pueden usar respuestas rápidas.' });
    }

    const { messages, property, agentName, clientName, isFirstReply, propertyId, clientId } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'Se requieren mensajes del chat.' });
    }

    // Take last 6 messages
    const recentMessages = messages.slice(-6);
    const chatContext = recentMessages.map(m =>
      `${m.isOwn ? (agentName || 'Agente') : (clientName || 'Cliente')}: ${m.text}`
    ).join('\n');

    let propertyContext = '';
    if (property) {
      const p = property;
      const parts = [
        p.address ? `Ubicación: ${p.address}` : null,
        p.type === 'venta' ? 'Operación: Venta' : p.type === 'renta' ? 'Operación: Renta' : p.type === 'proximamente' ? 'Operación: Próximamente' : null,
        p.estate_type ? `Tipo: ${p.estate_type}` : null,
        p.price ? `Precio: $${Number(p.price).toLocaleString('es-MX')} MXN` : null,
        p.monthly_pay ? `Renta mensual: $${Number(p.monthly_pay).toLocaleString('es-MX')} MXN/mes` : null,
        p.maintenance_fee ? `Mantenimiento: $${Number(p.maintenance_fee).toLocaleString('es-MX')} MXN/mes` : null,
        // Espacios
        p.bedrooms ? `Recámaras: ${p.bedrooms}` : null,
        p.bathrooms ? `Baños: ${p.bathrooms}` : null,
        p.half_bathrooms ? `Medios baños: ${p.half_bathrooms}` : null,
        p.land ? `Terreno: ${p.land} m²` : null,
        p.construction ? `Construcción: ${p.construction} m²` : null,
        p.parking_spaces ? `Estacionamiento: ${p.parking_spaces} lugares` : null,
        p.stories ? `Niveles: ${p.stories}` : null,
        // Características de la casa
        p.fitted_kitchen ? 'Cocina integral' : null,
        p.closets ? 'Closets' : null,
        p.service_room ? 'Cuarto de servicio' : null,
        p.laundry_room ? 'Cuarto de lavado' : null,
        p.study_office ? 'Estudio/Oficina' : null,
        p.roof_garden ? 'Roof garden/Terraza' : null,
        p.private_garden ? 'Jardín privado' : null,
        p.private_pool ? 'Alberca privada' : null,
        p.storage_room ? 'Bodega' : null,
        p.cistern ? 'Cisterna' : null,
        p.water_heater ? 'Calentador/Boiler' : null,
        p.furnished ? 'Amueblado' : null,
        p.ac ? 'Aire acondicionado' : null,
        p.solar ? 'Paneles solares' : null,
        // Amenidades del desarrollo
        p.gated_community ? 'Fraccionamiento cerrado/Privada' : null,
        p.clubhouse ? 'Casa club' : null,
        p.gym ? 'Gimnasio' : null,
        p.common_pool ? 'Alberca común' : null,
        p.playground ? 'Área de juegos infantiles' : null,
        p.park_garden ? 'Parque/Jardines comunes' : null,
        p.sports_court ? 'Cancha deportiva' : null,
        p.event_room ? 'Salón de eventos' : null,
        p.bbq_area ? 'Área de asadores' : null,
        // Seguridad
        p.surveillance_24_7 ? 'Vigilancia 24/7' : null,
        p.controlled_access ? 'Acceso controlado' : null,
        p.cctv ? 'Circuito cerrado (CCTV)' : null,
        p.alarm ? 'Alarma' : null,
        // Servicios
        p.water_serv ? 'Agua' : null,
        p.electricity_serv ? 'Electricidad' : null,
        p.sewer_serv ? 'Drenaje' : null,
        // Extras
        p.new_construction ? 'Nueva construcción' : null,
        p.pets_allowed ? 'Acepta mascotas' : null,
        p.date_build ? `Año de construcción: ${p.date_build}` : null,
        p.description ? `Descripción: ${p.description.slice(0, 300)}` : null,
      ].filter(Boolean);
      if (parts.length) propertyContext = `\nPropiedad en discusión:\n${parts.join('\n')}`;
    }

    const agentNameStr = agentName || '';
    const clientNameStr = clientName || '';
    const firstReplyHint = isFirstReply
      ? `\nEs la primera vez que el agente responde. Incluye un saludo educado como "Buenas tardes${clientNameStr ? ' ' + clientNameStr : ''}, soy ${agentNameStr || 'su agente'}, con mucho gusto le atiendo" o similar. Profesional pero calido.`
      : '';

    // ── Fetch client financial context for informed suggestions (cached) ──
    let clientContextNote = '';
    if (clientId) {
      try {
    
        const ctx = await getUserContextCached(clientId, 600); // 10-min TTL for enrichment
        const { buying_power: bp, infonavit: info, tenant_profile: tp, qualifying: qp } = ctx;
        const parts = [];
        if (qp) {
          if (qp.intent) parts.push(`Intención: ${qp.intent === 'buy' ? 'comprar' : qp.intent === 'rent' ? 'rentar' : 'invertir'}`);
          if (qp.purchase_timeline) parts.push(`Timeline: ${qp.purchase_timeline} meses`);
          if (qp.has_pre_approval) parts.push(`Pre-aprobación: ${qp.pre_approval_bank || 'Sí'}${qp.pre_approval_amount ? ' $' + Number(qp.pre_approval_amount).toLocaleString('es-MX') : ''}`);
          if (qp.credit_score_range && qp.credit_score_range !== 'unknown') parts.push(`Score crediticio: ${qp.credit_score_range}`);
          if (qp.bureau_status && qp.bureau_status !== 'unknown') parts.push(`Buró: ${qp.bureau_status === 'clean' ? 'limpio' : qp.bureau_status === 'minor_issues' ? 'algunos detalles' : 'temas importantes'}`);
        }
        if (bp?.suggested) parts.push(`Capacidad de compra: $${Number(bp.suggested).toLocaleString('es-MX')}`);
        if (bp?.monthly_income) parts.push(`Ingreso mensual: $${Number(bp.monthly_income).toLocaleString('es-MX')}`);
        if (info?.credit_amount) parts.push(`Crédito Infonavit: $${Number(info.credit_amount).toLocaleString('es-MX')}`);
        if (tp?.estimated_monthly_income) parts.push(`Ingreso (perfil renta): $${Number(tp.estimated_monthly_income).toLocaleString('es-MX')}`);
        if (parts.length > 0) {
          clientContextNote = `\n\nDATOS FINANCIEROS DEL PROSPECTO (úsalos para dar respuestas informadas, pero NO los compartas directamente con el cliente):\n${parts.join('\n')}`;
        }
      } catch { /* non-critical */ }
    }

    // Check if there is already a confirmed appointment for this chat
    let confirmedAppointmentNote = '';
    if (propertyId && clientId) {
      const [confirmed] = await q(
        `SELECT id, appointment_date, appointment_time FROM appointments
         WHERE property_id = ? AND requester_id = ? AND agent_id = ? AND status = 'confirmed'
         ORDER BY id DESC LIMIT 1`,
        [propertyId, clientId, userId]
      );
      if (confirmed) {
        confirmedAppointmentNote = `\nIMPORTANTE: Ya existe una cita CONFIRMADA para esta propiedad (${confirmed.appointment_date} a las ${String(confirmed.appointment_time).slice(0,5)}). NO uses [CITA], [MODIFICAR_CITA] ni propongas cambios de horario. La cita confirmada no se puede modificar ni cancelar por IA.`;
      }
    }

    // Build today's date for the AI to resolve relative dates ("jueves", "mañana", etc.)
    const todayISO = new Date().toISOString().split('T')[0];
    const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const todayDayName = dayNames[new Date().getDay()];

    const systemPrompt = `Eres un agente inmobiliario mexicano profesional y astuto escribiendo por WhatsApp.${agentNameStr ? ' Te llamas ' + agentNameStr + '.' : ''}${clientNameStr ? ' Le escribes a ' + clientNameStr + '.' : ''}
Hoy es ${todayDayName} ${todayISO}.

TU ROL: Eres un VENDEDOR. Tu objetivo es cerrar la venta o renta. Usa la información de la propiedad a tu favor para responder con datos concretos que generen interés y confianza. Si el cliente pregunta sobre características, responde con lo que tiene la propiedad y destaca lo positivo. Si no tiene algo que preguntan, se honesto pero redirige a lo que SI tiene.

Genera 3 opciones de mensaje que el agente podría enviar. Reglas:
- Tono profesional pero cercano. Habla de USTED al cliente, nunca de tu. Ejemplo: "con gusto le comparto", "si gusta podemos agendar"
- Amable, educado y atento, un agente que inspira confianza
- NO uses frases demasiado informales como "que onda", "va que va", "orale", "neta", "que rollo"
- Frases naturales y educadas: "con mucho gusto", "claro que si", "quedo a sus ordenes", "estoy para servirle"
- Cuando el cliente pregunte sobre la propiedad, USA LOS DATOS que tienes para responder con informacion real y concreta. No inventes datos que no tengas
- Se astuto como vendedor: destaca ventajas, amenidades, ubicación, seguridad o lo que sea relevante para lo que pregunta el cliente
- Si el cliente pregunta algo que no esta en los datos, responde con honestidad y sugiere algo que SI tiene la propiedad como valor agregado
- Cada opción con un enfoque distinto: una informativa con datos, una que destaque un beneficio y proponga accion, una corta y directa
- NO uses emojis
- Entre 20 y 200 caracteres cada una
- Español mexicano natural, profesional${firstReplyHint}

DETECCION DE CITAS — SE MUY CONSERVADOR. Solo activa tags de cita cuando la intencion es CLARA E INEQUIVOCA.

NUNCA uses tags de cita si el cliente:
- Solo saluda ("hola", "buenas tardes", "como esta")
- Pide informacion general ("me puede dar mas info", "cuanto cuesta", "tiene fotos")
- Hace preguntas sobre la propiedad ("cuantos cuartos tiene", "incluye estacionamiento")
- Dice algo ambiguo o conversacional
- Apenas inicia la conversacion (primer o segundo mensaje)

SOLO usa tags de cita cuando el cliente EXPLICITAMENTE dice que quiere VISITAR, IR, CONOCER EN PERSONA o VER FISICAMENTE la propiedad. Debe ser una intencion clara de agendar una visita presencial, no solo interes general.

Ejemplos que NO son cita: "me interesa", "quiero info", "se ve bien", "me gusta", "esta disponible?"
Ejemplos que SI son cita: "quiero ir a verla", "puedo visitarla?", "cuando puedo pasar a conocerla?", "me gustaria agendar una visita"

Tags disponibles:
1. Si el cliente quiere visitar Y menciona fecha y hora concretas: [CITA:YYYY-MM-DD:HH:MM]
   Ejemplos: "quiero ir el jueves a las 3" -> [CITA:${todayISO}:15:00] (resuelve "jueves" a la fecha real mas cercana)
   "mañana a las 10 de la mañana" -> [CITA:YYYY-MM-DD:10:00]
2. Si el cliente quiere visitar pero NO dice fecha u hora exacta: [CITA]
3. Si el cliente quiere CAMBIAR una cita ya propuesta a nueva fecha/hora: [MODIFICAR_CITA:YYYY-MM-DD:HH:MM]
   Si quiere cambiar pero no dice fecha/hora exacta: [MODIFICAR_CITA]
4. NO puedes confirmar ni cancelar citas, solo crear propuestas y modificaciones.
5. Solo puede haber UNA cita pendiente por propiedad.
6. En caso de duda, NO agregues ningun tag. Es mejor no proponer cita que proponerla cuando no se pidio.${confirmedAppointmentNote}${clientContextNote}

Responde SOLO con las 3 opciones separadas por ||| sin números ni explicaciones.`;

    const userPrompt = `Chat:\n${chatContext}${propertyContext}`;

    const result = await aiGenerate(systemPrompt, userPrompt, {
      cacheTTL: 120,
      cachePrefix: 'replies',
    });

    // ── Parse appointment intent tags ──
    let suggestAppointment = false;
    let modifyAppointment = false;
    let extractedDate = null;
    let extractedTime = null;

    // [CITA:YYYY-MM-DD:HH:MM] — full date+time extracted
    const citaFullMatch = result.match(/\[CITA:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
    if (citaFullMatch) {
      suggestAppointment = true;
      extractedDate = citaFullMatch[1];
      extractedTime = citaFullMatch[2] + ':00';
    } else if (result.includes('[CITA]')) {
      suggestAppointment = true;
    }

    // [MODIFICAR_CITA:YYYY-MM-DD:HH:MM] or [MODIFICAR_CITA]
    const modFullMatch = result.match(/\[MODIFICAR_CITA:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
    if (modFullMatch) {
      modifyAppointment = true;
      extractedDate = modFullMatch[1];
      extractedTime = modFullMatch[2] + ':00';
    } else if (result.includes('[MODIFICAR_CITA]')) {
      modifyAppointment = true;
    }

    // Clean all tags from the text
    const cleanResult = result
      .replace(/\[CITA:\d{4}-\d{2}-\d{2}:\d{2}:\d{2}\]/g, '')
      .replace(/\[CITA\]/g, '')
      .replace(/\[MODIFICAR_CITA:\d{4}-\d{2}-\d{2}:\d{2}:\d{2}\]/g, '')
      .replace(/\[MODIFICAR_CITA\]/g, '')
      .trim();

    // Parse the 3 replies — try multiple separators the model might use
    let replies = cleanResult.split('|||').map(r => r.trim()).filter(r => r.length > 0);
    if (replies.length < 2) {
      // Try numbered format: "1. ... 2. ... 3. ..."
      replies = cleanResult.split(/\d+[\.\)\-]\s+/).map(r => r.trim()).filter(r => r.length > 0);
    }
    if (replies.length < 2) {
      // Try newline separated
      replies = cleanResult.split('\n').map(r => r.replace(/^[\d\.\)\-\*\s]+/, '').trim()).filter(r => r.length > 0);
    }
    replies = replies.slice(0, 3);

    if (replies.length === 0) {
      return res.status(500).json({ ok: false, error: 'No se pudieron generar respuestas.' });
    }

    const response = { ok: true, replies, suggestAppointment, modifyAppointment };
    if (extractedDate) response.extractedDate = extractedDate;
    if (extractedTime) response.extractedTime = extractedTime;
    return res.json(response);
  } catch (err) {
    console.error('[ai:smart-replies]', err.message);
    if (err.message === 'AI_DISABLED') {
      return res.status(503).json({ ok: false, error: 'ai_disabled' });
    }
    return res.status(500).json({ ok: false, error: 'ai_error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 3: Buyer assistant
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/api/ai/assistant', optionalAuth, assistantLimiter, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const { message, propertyIds } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Se requiere un mensaje.' });
    }

    // ── Conversation history (only for logged-in users) ──
    let history = [];
    if (userId) {

      await q('INSERT INTO ai_conversations (user_id, role, message) VALUES (?, ?, ?)',
        [userId, 'user', message.trim()]);

      history = await q(
        'SELECT role, message FROM ai_conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 8',
        [userId]
      );
      history.reverse();
    }

    // ── Property enrichment (only for logged-in users with IDs) ──
    let propertyContext = '';
    if (userId && propertyIds && Array.isArray(propertyIds) && propertyIds.length > 0) {
      const ids = propertyIds.slice(0, 5).map(Number).filter(n => n > 0);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const props = await q(
          `SELECT id, type, estate_type, price, monthly_pay, address, bedrooms, bathrooms, land, construction
           FROM properties WHERE id IN (${placeholders}) LIMIT 5`,
          ids
        );
        if (props.length > 0) {
          propertyContext = '\n\nPropiedades que el usuario ha visto recientemente:\n' +
            props.map(p => {
              const priceStr = p.price ? `$${Number(p.price).toLocaleString('es-MX')}` :
                               p.monthly_pay ? `$${Number(p.monthly_pay).toLocaleString('es-MX')}/mes` : 'precio no disponible';
              return `- ${ESTATE_LABELS[p.estate_type] || p.estate_type} en ${p.address || 'ubicación no especificada'}, ${priceStr}`;
            }).join('\n');
        }
      }
    }

    let buyingPowerContext = '';
    if (userId) {
      try {
        const [bp] = await q(
          'SELECT suggested FROM buying_power WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
          [userId]
        );
        if (bp?.suggested) {
          buyingPowerContext = `\n\nCapacidad de compra estimada del usuario: $${Number(bp.suggested).toLocaleString('es-MX')}`;
        }
      } catch { /* table may not exist */ }
    }

    const systemPrompt = `Eres un asistente virtual de LISTED, un marketplace inmobiliario en México. SOLO puedes responder preguntas relacionadas con bienes raíces e inmuebles.

Temas PERMITIDOS:
- Compraventa y renta de propiedades en México
- Créditos hipotecarios (bancarios, Infonavit, Fovissste, cofinavit)
- Costos de escrituración, avalúo, comisiones, impuestos de propiedad
- Requisitos legales, documentación, contratos de compraventa y arrendamiento
- Mercado inmobiliario mexicano, zonas, plusvalía
- Consejos para compradores, vendedores y renteros
- Procesos de mudanza relacionados con compra/renta
- Mantenimiento básico del hogar en contexto de compra/renta
- Uso de herramientas de la app LISTED (calculadora Infonavit, capacidad de compra, favoritos, citas)

Si el usuario pregunta CUALQUIER cosa que NO esté relacionada con bienes raíces, inmuebles o los temas de arriba, responde EXACTAMENTE: "Solo puedo ayudarte con temas relacionados a bienes raíces. ¿Tienes alguna duda sobre compra, renta, créditos hipotecarios o propiedades?"
No hagas excepciones. No respondas preguntas de cultura general, matemáticas, animales, deportes, tecnología, cocina ni ningún otro tema.

Reglas de formato:
- Responde en español mexicano natural y profesional
- Máximo 150 palabras por respuesta. Sé BREVE y directo — ve al grano sin rodeos ni introducciones largas
- No repitas la pregunta del usuario ni uses frases de relleno como "Claro, con gusto te explico", "Es una excelente pregunta", etc. Ve directo a la respuesta
- Usa bullets o listas cortas cuando aplique, en vez de párrafos largos
- No uses emojis
- No inventes datos específicos de precios de zonas; si no estás seguro, indica que los precios varían
- Cuando sea relevante, sugiere usar herramientas de la app como la calculadora Infonavit o el perfil de capacidad de compra${propertyContext}${buyingPowerContext}`;

    // ── Build messages array ──
    let aiMessages;
    if (history.length > 0) {
      // Logged-in user with history
      aiMessages = history.map(h => ({ role: h.role, content: h.message }));
    } else {
      // Anonymous user: single-turn
      aiMessages = [{ role: 'user', content: message.trim() }];
    }

    const reply = await aiGenerateMessages(systemPrompt, aiMessages, {
      cacheTTL: 0,
      cachePrefix: 'assistant',
    });

    // Save assistant reply (only for logged-in users)
    if (userId) {
      await q('INSERT INTO ai_conversations (user_id, role, message) VALUES (?, ?, ?)',
        [userId, 'assistant', reply]);

      // Auto-clean: keep only last 50 messages per user
      try {
        const countResult = await q('SELECT COUNT(*) as cnt FROM ai_conversations WHERE user_id = ?', [userId]);
        if (countResult[0]?.cnt > 50) {
          await q(
            `DELETE FROM ai_conversations WHERE user_id = ? AND id NOT IN (
              SELECT id FROM (SELECT id FROM ai_conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50) AS recent
            )`,
            [userId, userId]
          );
        }
      } catch { /* non-critical cleanup */ }
    }

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error('[ai:assistant]', err.message, err.stack);
    if (err.message === 'AI_DISABLED') {
      return res.status(503).json({ ok: false, error: 'ai_disabled', message: 'El asistente no está disponible temporalmente.' });
    }
    return res.status(500).json({ ok: false, error: 'ai_error', message: 'Error al procesar tu mensaje.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 4: User qualifying profile + context for agents
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/ai/user-context/:userId — fetch financial context for a prospect
router.get('/api/ai/user-context/:userId', authenticateToken, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ ok: false, error: 'userId inválido' });
    }



    const context = await getUserContextCached(targetUserId);
    return res.json({ ok: true, ...context });
  } catch (err) {
    console.error('[ai:user-context]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener contexto del usuario' });
  }
});

// POST /api/ai/qualifying-profile — user saves their qualifying answers
router.post('/api/ai/qualifying-profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'No autenticado' });



    const {
      intent,
      purchase_timeline,
      has_pre_approval,
      pre_approval_bank,
      pre_approval_amount,
      credit_score_range,
      bureau_status,
    } = req.body;

    await q(`INSERT INTO user_qualifying_profile
      (user_id, intent, purchase_timeline, has_pre_approval, pre_approval_bank, pre_approval_amount, credit_score_range, bureau_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        intent = VALUES(intent),
        purchase_timeline = VALUES(purchase_timeline),
        has_pre_approval = VALUES(has_pre_approval),
        pre_approval_bank = VALUES(pre_approval_bank),
        pre_approval_amount = VALUES(pre_approval_amount),
        credit_score_range = VALUES(credit_score_range),
        bureau_status = VALUES(bureau_status)`,
      [
        userId,
        intent || null,
        purchase_timeline || null,
        has_pre_approval ? 1 : 0,
        pre_approval_bank || null,
        pre_approval_amount || null,
        credit_score_range || null,
        bureau_status || null,
      ]
    );

    // Invalidate cached context so next GET returns fresh data
    try { await redis.del(`user:context:${userId}`); } catch { /* non-critical */ }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[ai:qualifying-profile]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al guardar perfil' });
  }
});

// ── Get assistant history ───────────────────────────────────────────────────────
router.get('/api/ai/assistant/history', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.json({ ok: true, messages: [] });

    const rows = await q(
      'SELECT role, message, created_at FROM ai_conversations WHERE user_id = ? ORDER BY created_at ASC LIMIT 50',
      [userId]
    );
    return res.json({ ok: true, messages: rows });
  } catch (err) {
    console.error('[ai:history]', err.message);
    return res.json({ ok: true, messages: [] });
  }
});

module.exports = router;
