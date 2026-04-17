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

  // Pin HS256. Sin este whitelist, un atacante puede firmar un JWT con RS256
  // usando JWT_SECRET como si fuera una clave pública y hacer algorithm confusion.
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
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
  store: new RedisStore({ sendCommand: (...args) => redis.infra.call(...args), prefix: 'rl:ai:desc:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit', message: 'Demasiados intentos. Intenta en unos minutos.' }),
});

const smartRepliesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, ip: false },
  store: new RedisStore({ sendCommand: (...args) => redis.infra.call(...args), prefix: 'rl:ai:replies:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit' }),
});

const assistantLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyGenerator: (req) => `ai:ul:${req.user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: new RedisStore({ sendCommand: (...args) => redis.infra.call(...args), prefix: 'rl:ai:assist:' }),
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
- Entre 400 y 650 caracteres. Ni menos, ni más. SIEMPRE termina la última oración completa — NUNCA cortes una frase a la mitad.
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

    // Enforce max length — cortar en la última oración completa antes del límite
    let trimmed = description;
    if (trimmed.length > 700) {
      trimmed = trimmed.substring(0, 700);
      const lastPeriod = Math.max(trimmed.lastIndexOf('.'), trimmed.lastIndexOf('!'), trimmed.lastIndexOf('?'));
      if (lastPeriod > 400) {
        trimmed = trimmed.substring(0, lastPeriod + 1);
      }
    }

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

    // Take last 20 messages for full conversation context
    const recentMessages = messages.slice(-20);
    const chatContext = recentMessages.map(m => {
      const speaker = m.isOwn ? (agentName || 'Agente') : (clientName || 'Cliente');
      if (m.type === 'appointment_card' && m.appointment) {
        const apptStatus = m.appointment.status === 'confirmed' ? 'CONFIRMADA' : m.appointment.status === 'cancelled' ? 'CANCELADA' : 'PENDIENTE';
        return `${speaker}: [Propuesta de visita - ${apptStatus}${m.appointment.date ? ` ${m.appointment.date}` : ''}${m.appointment.time ? ` ${String(m.appointment.time).slice(0,5)}` : ''}]${m.text ? ' ' + m.text : ''}`;
      }
      if (m.type === 'property_card') {
        return `${speaker}: [Compartió una propiedad]${m.text ? ' ' + m.text : ''}`;
      }
      if (m.hasFile) {
        return `${speaker}: [Envió archivo${m.fileName ? ': ' + m.fileName : ''}]${m.text ? ' ' + m.text : ''}`;
      }
      return `${speaker}: ${m.text}`;
    }).join('\n');

    // Determine conversation stage
    const totalMessages = recentMessages.length;
    const agentMessages = recentMessages.filter(m => m.isOwn).length;
    const clientMessages = totalMessages - agentMessages;
    const hasAppointment = recentMessages.some(m => m.type === 'appointment_card');
    const hasConfirmedAppt = recentMessages.some(m => m.type === 'appointment_card' && m.appointment?.status === 'confirmed');
    const hasPendingAppt = recentMessages.some(m => m.type === 'appointment_card' && m.appointment?.status === 'pending');

    // Conversation stage is determined AFTER appointment query (below) using real DB data
    let conversationStage = 'inicio';
    if (agentMessages >= 1) conversationStage = 'seguimiento';
    if (agentMessages >= 3 && clientMessages >= 3) conversationStage = 'negociacion';

    const stageHints = {
      inicio: 'La conversacion apenas comienza. Saluda profesionalmente y ofrece informacion sobre la propiedad.',
      seguimiento: 'Ya hubo intercambio inicial. NO vuelvas a saludar ni a presentarte. Continua la conversacion de forma natural, responde lo que el cliente pregunta o necesita.',
      negociacion: 'La conversacion esta avanzada. NO saludes ni te presentes. Enfocate en resolver dudas especificas, destacar beneficios relevantes y avanzar hacia el cierre (visita o decision).',
      cita_pendiente: 'Ya hay una propuesta de visita PENDIENTE. NO propongas otra cita. Enfocate en confirmar detalles, resolver dudas restantes o preparar al cliente para la visita.',
      cita_confirmada: 'Ya hay una cita CONFIRMADA. NO propongas mas citas. Enfocate en preparar al cliente para la visita, dar indicaciones de ubicacion, o resolver dudas finales antes de la visita.',
    };

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

    // Check real appointment state for this property+client
    let appointmentNote = '';
    if (propertyId && clientId) {
      const appointments = await q(
        `SELECT id, appointment_date, appointment_time, status FROM appointments
         WHERE property_id = ? AND requester_id = ? AND agent_id = ?
           AND status IN ('pending', 'confirmed')
         ORDER BY id DESC LIMIT 3`,
        [propertyId, clientId, userId]
      );
      if (appointments.length > 0) {
        const confirmed = appointments.find(a => a.status === 'confirmed');
        const pending = appointments.find(a => a.status === 'pending');
        if (confirmed) {
          appointmentNote = `\nESTADO DE CITAS PARA ESTA PROPIEDAD: Ya existe una cita CONFIRMADA (${confirmed.appointment_date} a las ${String(confirmed.appointment_time).slice(0,5)}). NO uses [CITA], [MODIFICAR_CITA] ni propongas cambios de horario. Enfocate en preparar la visita.`;
        } else if (pending) {
          appointmentNote = `\nESTADO DE CITAS PARA ESTA PROPIEDAD: Hay una propuesta de visita PENDIENTE de confirmar (${pending.appointment_date} a las ${String(pending.appointment_time).slice(0,5)}). NO propongas nueva cita. Puedes mencionar que la propuesta ya fue enviada y esta pendiente de confirmacion.`;
        }
      } else {
        appointmentNote = '\nESTADO DE CITAS PARA ESTA PROPIEDAD: No hay citas agendadas. Si el cliente pide explicitamente visitar o ver la propiedad en persona, puedes usar [CITA].';
      }
      // Override conversation stage with real DB appointment state
      if (appointments.find(a => a.status === 'confirmed')) conversationStage = 'cita_confirmada';
      else if (appointments.find(a => a.status === 'pending')) conversationStage = 'cita_pendiente';
    }

    // Build today's date for the AI — use Mexico City timezone (toISOString gives UTC which
    // is one day ahead of local Mexican time in the evenings, causing off-by-one date errors)
    const todayISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
    const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const todayDayName = dayNames[new Date(todayISO + 'T12:00:00').getDay()];

    const systemPrompt = `Eres un agente inmobiliario mexicano profesional y astuto escribiendo por WhatsApp.${agentNameStr ? ' Te llamas ' + agentNameStr + '.' : ''}${clientNameStr ? ' Le escribes a ' + clientNameStr + '.' : ''}
Hoy es ${todayDayName} ${todayISO}.

ETAPA DE LA CONVERSACION: ${conversationStage.toUpperCase()}
${stageHints[conversationStage]}

TU ROL: Eres un VENDEDOR. Tu objetivo es cerrar la venta o renta. Usa la información de la propiedad a tu favor para responder con datos concretos que generen interés y confianza. Si el cliente pregunta sobre características, responde con lo que tiene la propiedad y destaca lo positivo. Si no tiene algo que preguntan, se honesto pero redirige a lo que SI tiene.

CONTEXTO CRITICO: Lee TODA la conversacion antes de responder. Tus sugerencias deben ser la CONTINUACION LOGICA de lo que se esta hablando. Si el cliente hizo una pregunta, RESPONDELA. Si ya se hablo de algo, no lo repitas. Si ya se saludo, NO vuelvas a saludar.

Genera 3 opciones de mensaje que el agente podría enviar. Reglas:
- Tono profesional pero cercano. Habla de USTED al cliente, nunca de tu. Ejemplo: "con gusto le comparto", "si gusta podemos agendar"
- Amable, educado y atento, un agente que inspira confianza
- NO uses frases demasiado informales como "que onda", "va que va", "orale", "neta", "que rollo"
- Frases naturales y educadas: "con mucho gusto", "claro que si", "quedo a sus ordenes", "estoy para servirle"
- Cuando el cliente pregunte sobre la propiedad, USA LOS DATOS que tienes para responder con informacion real y concreta. No inventes datos que no tengas
- Se astuto como vendedor: destaca ventajas, amenidades, ubicación, seguridad o lo que sea relevante para lo que pregunta el cliente
- Si el cliente pregunta algo que no esta en los datos, responde con honestidad y sugiere algo que SI tiene la propiedad como valor agregado
- Cada opción con un enfoque distinto: una informativa con datos, una que destaque un beneficio y proponga accion, una corta y directa
- NUNCA repitas saludos o presentaciones si ya se hicieron en la conversacion
- Las respuestas deben responder DIRECTAMENTE al ultimo mensaje del cliente en el contexto de toda la conversacion
- NO uses emojis
- Entre 20 y 200 caracteres cada una
- Español mexicano natural, profesional${firstReplyHint}

DETECCION DE CITAS — REGLA CRITICA: Por defecto NO uses [CITA]. Solo usalo en casos MUY claros.

NUNCA uses tags de cita si el cliente:
- Solo saluda ("hola", "buenas tardes", "como esta")
- Pide informacion general ("me puede dar mas info", "cuanto cuesta", "tiene fotos")
- Hace preguntas sobre la propiedad ("cuantos cuartos tiene", "incluye estacionamiento", "tiene alberca", "que amenidades tiene")
- Dice algo ambiguo o conversacional ("me interesa", "se ve bien", "me gusta", "esta disponible?", "quiero info")
- Apenas inicia la conversacion (primeros 4 mensajes del cliente)
- Pregunta sobre ubicacion, precio, metraje, o cualquier caracteristica
- Dice "quiero saber mas", "cuenteme mas", "que incluye"
- NUNCA propongas cita por tu cuenta. Solo responde a la SOLICITUD EXPLICITA del cliente.

USA [CITA] UNICAMENTE cuando el cliente usa palabras como VISITAR, IR A VER, CONOCER EN PERSONA, AGENDAR VISITA, RECORRER, PASAR A VERLA:
1. El cliente EXPLICITAMENTE dice que quiere VISITAR, IR, CONOCER EN PERSONA o VER FISICAMENTE la propiedad usando esas palabras exactas
2. El AGENTE previamente ofrecio o pregunto si quiere agendar/visitar Y el cliente CONFIRMO con "si" o afirmacion clara

SI TIENES DUDA, NO USES [CITA]. Es mejor NO proponer una cita que proponerla cuando no se pidio.

Ejemplos que NO son cita: "me interesa", "quiero info", "se ve bien", "me gusta", "esta disponible?", "hola", "buenas", "que amenidades tiene", "tiene estacionamiento", "cuanto cuesta", "me puede dar mas info"
Ejemplos que SI son cita:
- Directos: "quiero ir a verla", "puedo visitarla?", "cuando puedo pasar a conocerla?", "me gustaria agendar una visita"
- Confirmaciones a oferta del agente: "si claro" (SOLO si el agente pregunto sobre visitar), "si cuando podemos vernos?", "cuando nos vemos?", "si me gustaria ir"

Tags disponibles:
1. Si el cliente quiere visitar Y menciona fecha y hora concretas: [CITA:YYYY-MM-DD:HH:MM]
   Ejemplos: "quiero ir el jueves a las 3" -> [CITA:${todayISO}:15:00] (resuelve "jueves" a la fecha real mas cercana)
   "mañana a las 10 de la mañana" -> [CITA:YYYY-MM-DD:10:00]
2. Si el cliente quiere visitar pero NO dice fecha u hora exacta: [CITA]
3. Si el cliente quiere CAMBIAR una cita ya propuesta a nueva fecha/hora: [MODIFICAR_CITA:YYYY-MM-DD:HH:MM]
   Si quiere cambiar pero no dice fecha/hora exacta: [MODIFICAR_CITA]
4. NO puedes confirmar ni cancelar citas, solo crear propuestas y modificaciones.
5. Solo puede haber UNA cita pendiente por propiedad.
6. En caso de duda, NO agregues ningun tag. Es MUCHO mejor no proponer cita que proponerla cuando no se pidio. Un falso positivo es un error grave.
7. NUNCA inventes citas que no existen. Si no hay cita agendada, NO digas que ya hay una. Usa SOLO la informacion del ESTADO DE CITAS que se te proporciona.
8. Si en el historial del chat ves propuestas de visita CANCELADAS, IGNORALAS completamente. Una cita cancelada ya no existe. Solo considera las citas que aparecen en el ESTADO DE CITAS.${appointmentNote}${clientContextNote}

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

    // Hard guard: block appointment suggestions if conversation is too early
    const clientMsgCount = recentMessages.filter(m => !m.isOwn).length;
    const allowAppointmentTags = clientMsgCount >= 3;

    // [CITA:YYYY-MM-DD:HH:MM] — full date+time extracted
    const citaFullMatch = result.match(/\[CITA:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
    if (citaFullMatch && allowAppointmentTags) {
      suggestAppointment = true;
      extractedDate = citaFullMatch[1];
      const [eHour, eMin] = citaFullMatch[2].split(':').map(Number);
      const roundedHour = eMin > 0 ? eHour + 1 : eHour;
      extractedTime = `${String(roundedHour).padStart(2, '0')}:00:00`;
    } else if (result.includes('[CITA]') && allowAppointmentTags) {
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
// Feature 3: Buyer assistant (AndreI)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/api/ai/assistant', optionalAuth, assistantLimiter, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Se requiere un mensaje.' });
    }

    // ── Save user message + load history ──────────────────────────────────────
    if (userId) {
      await q('INSERT INTO ai_conversations (user_id, role, message) VALUES (?, ?, ?)',
        [userId, 'user', message.trim()]);
    }

    let history = [];
    if (userId) {
      const rows = await q(
        `SELECT role, message FROM ai_conversations
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 6`,
        [userId]
      );
      // Trim long messages (verbose AI replies re-sent as context waste tokens)
      history = rows.reverse().map(r => ({
        ...r,
        message: r.message.length > 400 ? r.message.slice(0, 397) + '…' : r.message,
      }));
    }

    // ── Full user context ─────────────────────────────────────────────────────
    let userProfileBlock = '';
    if (userId) {
      try {
        const ctx = await getUserContextCached(userId);
        const { buying_power: bp, infonavit: inf, tenant_profile: tp, qualifying: qp } = ctx;
        const lines = [];
        if (qp?.intent) {
          const intentLabel = qp.intent === 'buy' ? 'comprar' : qp.intent === 'rent' ? 'rentar' : 'invertir';
          lines.push(`Intención del usuario: ${intentLabel}`);
        }
        if (qp?.purchase_timeline) lines.push(`Timeline de compra: ${qp.purchase_timeline} meses`);
        if (bp?.suggested_price)   lines.push(`Capacidad de compra calculada: $${Number(bp.suggested_price).toLocaleString('es-MX')} MXN`);
        if (bp?.monthly_target)    lines.push(`Presupuesto de renta: $${Number(bp.monthly_target).toLocaleString('es-MX')} MXN/mes`);
        if (bp?.down_payment)      lines.push(`Enganche disponible: $${Number(bp.down_payment).toLocaleString('es-MX')} MXN`);
        if (bp?.monthly_income)    lines.push(`Ingreso mensual: $${Number(bp.monthly_income).toLocaleString('es-MX')} MXN`);
        if (inf?.credit_amount)    lines.push(`Crédito Infonavit disponible: $${Number(inf.credit_amount).toLocaleString('es-MX')} MXN`);
        if (tp?.estimated_monthly_income) lines.push(`Ingreso mensual (perfil renta): $${Number(tp.estimated_monthly_income).toLocaleString('es-MX')} MXN`);
        if (tp?.family_size)  lines.push(`Tamaño de familia: ${tp.family_size} persona(s)`);
        if (tp?.has_pets != null) lines.push(`Mascotas: ${tp.has_pets ? 'sí' : 'no'}`);
        if (qp?.has_pre_approval) lines.push(`Pre-aprobación hipotecaria: ${qp.pre_approval_bank || 'sí'}${qp.pre_approval_amount ? ` por $${Number(qp.pre_approval_amount).toLocaleString('es-MX')}` : ''}`);
        if (qp?.credit_score_range && qp.credit_score_range !== 'unknown') lines.push(`Historial crediticio: ${qp.credit_score_range}`);
        if (qp?.bureau_status && qp.bureau_status !== 'unknown') {
          const bl = qp.bureau_status === 'clean' ? 'limpio' : qp.bureau_status === 'minor_issues' ? 'algunos detalles menores' : 'temas importantes que resolver';
          lines.push(`Buró de crédito: ${bl}`);
        }
        if (lines.length > 0) {
          userProfileBlock = `\nPERFIL DEL USUARIO (úsalo para personalizar tus respuestas — no lo cites literalmente):\n${lines.join('\n')}\n`;
        }
      } catch { /* non-critical */ }
    }

    // ── Property search ───────────────────────────────────────────────────────
    let searchedProperties = [];
    let hasSearchIntent = false;
    let isProactiveSearch = false;
    let zoneRequested = null;
    let zoneRelaxed = false;

    if (userId) {
      try {
        const currentMsgLower = message.trim().toLowerCase();
        const PROPERTY_WORDS = /propiedades?|casas?|departamentos?|deptos?|inmuebles?|opciones?/i;

        // Explicit search: user is directly asking to see properties
        hasSearchIntent = (
          /\b(busco|buscando|buscar|muestrame|mu[eé]strame|muestra(me)?|recomienda(me)?|m[aá]ndame|dame|dime|ense[nñ]ame)\b/i.test(currentMsgLower) ||
          /\b(quiero|quisiera|necesito)\b.{0,50}\b(ver|comprar|rentar|encontrar|buscar|propiedades?|casas?|departamentos?|deptos?|opciones?|inmuebles?)\b/i.test(currentMsgLower) ||
          new RegExp(PROPERTY_WORDS.source + String.raw`\b.{0,30}\b(en|de|por|cerca)\b`, 'i').test(currentMsgLower) ||
          /\b(en venta|en renta)\b/i.test(currentMsgLower) ||
          /\b(m[aá]s opciones|otras opciones|algo (diferente|m[aá]s|mejor|m[aá]s barato|m[aá]s grande|m[aá]s chico))\b/i.test(currentMsgLower) ||
          /\b(hay|tienen|tienes)\b.{0,20}\b(casas?|departamentos?|deptos?|propiedades?|inmuebles?|opciones?)\b/i.test(currentMsgLower) ||
          /\ba ver\b.{0,40}\b(casas?|departamentos?|deptos?|propiedades?|opciones?|inmuebles?)\b/i.test(currentMsgLower)
        );

        const historyCtx = history.filter(h => h.role === 'user').slice(-3).map(h => h.message).join(' ').toLowerCase();

        const detectType = (text) => {
          if (/\b(rent[ao]r?|arrendar|en renta)\b/i.test(text)) return 'renta';
          if (/\b(comprar?|compra\b|adquirir|en venta)\b/i.test(text)) return 'venta';
          return null;
        };
        const ZONE_STOPWORDS = /^(el|la|los|las|un|una|esa|este|ese|que|venta|renta|algo|casa|depto|departamento|todo|opciones?|propiedades?)$/;
        const extractZone = (text) => {
          const m =
            text.match(/(?:en|zona|colonia|sector|por|cerca de)\s+([a-záéíóúüñ][a-záéíóúüñ ]{1,23}[a-záéíóúüñ])(?=\s*[,.\n?¿]|\s+\w|$)/i) ||
            text.match(/(?:en|zona|colonia|sector|por)\s+([a-záéíóúüñ]{3,20})(?=\s|,|\.|\?|$)/i);
          if (!m) return null;
          const z = m[1].trim();
          return (!ZONE_STOPWORDS.test(z) && z.length >= 3) ? z : null;
        };

        // Proactive search: user mentions a specific zone or property type in conversation
        // even without explicitly requesting listings — show relevant options organically
        if (!hasSearchIntent) {
          const proactiveZone = extractZone(currentMsgLower);
          const proactiveType = detectType(currentMsgLower) || detectType(historyCtx);
          if (proactiveZone || (proactiveType && history.length >= 3)) {
            isProactiveSearch = true;
          }
        }

        if (hasSearchIntent || isProactiveSearch) {
          const criteria = {};
          criteria.type = detectType(currentMsgLower) || detectType(historyCtx) || null;
          criteria.zone = extractZone(currentMsgLower) || extractZone(historyCtx) || null;
          zoneRequested = criteria.zone;

          const fullCtx = historyCtx + ' ' + currentMsgLower;
          if (/\bdepartamentos?\b/.test(currentMsgLower) || /\bdeptos?\b/.test(currentMsgLower)) criteria.estate_type = 'Departamento';
          else if (/\bcasas?\b/.test(currentMsgLower)) criteria.estate_type = 'Casa';
          else if (/\bdepartamentos?\b/.test(fullCtx) || /\bdeptos?\b/.test(fullCtx)) criteria.estate_type = 'Departamento';
          else if (/\bcasas?\b/.test(fullCtx)) criteria.estate_type = 'Casa';

          const bedMatch = (currentMsgLower + ' ' + historyCtx).match(/(\d+)\s*(rec[aá]maras?|cuartos?|habitaciones?)/);
          if (bedMatch) criteria.bedrooms = parseInt(bedMatch[1], 10);

          const runSearch = async (c) => {
            const conds = ['is_published = 1'];
            const prms = [];
            if (c.type)        { conds.push('type = ?');        prms.push(c.type); }
            if (c.zone)        { conds.push('address LIKE ?');  prms.push(`%${c.zone}%`); }
            if (c.estate_type) { conds.push('estate_type = ?'); prms.push(c.estate_type); }
            if (c.bedrooms)    { conds.push('bedrooms >= ?');   prms.push(c.bedrooms); }
            return q(
              `SELECT id, address, type, price, monthly_pay, bedrooms, estate_type,
                (SELECT image_url FROM property_images WHERE property_id = properties.id ORDER BY id ASC LIMIT 1) AS first_image
               FROM properties WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 5`,
              prms
            );
          };

          let props = await runSearch(criteria);
          if (!props.length && criteria.bedrooms)    props = await runSearch({ ...criteria, bedrooms: undefined });
          if (!props.length && criteria.estate_type) props = await runSearch({ ...criteria, bedrooms: undefined, estate_type: undefined });
          if (!props.length && criteria.type)        props = await runSearch({ zone: criteria.zone });
          if (!props.length)                         props = await runSearch({});

          // Track if results don't match the requested zone
          if (props.length > 0 && criteria.zone) {
            zoneRelaxed = !props.some(p => (p.address || '').toLowerCase().includes(criteria.zone.toLowerCase()));
          }

          searchedProperties = props;
        }
      } catch { /* non-critical */ }
    }

    // ── Build property context note for AI ────────────────────────────────────
    let propertyPromptNote = '';
    if (searchedProperties.length > 0) {
      const propList = searchedProperties.slice(0, 3).map(p => {
        const price = p.price ? `$${Number(p.price).toLocaleString('es-MX')}` :
                      p.monthly_pay ? `$${Number(p.monthly_pay).toLocaleString('es-MX')}/mes` : 'precio no disponible';
        return `• ${p.estate_type || 'Propiedad'} — ${p.address || 'sin dirección'} — ${price}${p.bedrooms ? ` — ${p.bedrooms} rec.` : ''}`;
      }).join('\n');

      const zoneNote = (zoneRelaxed && zoneRequested)
        ? ` (No se encontraron propiedades en "${zoneRequested}" — estas son de otras zonas. Díselo al usuario de forma natural.)`
        : '';

      if (hasSearchIntent) {
        propertyPromptNote = `\n\nPROPIEDADES A MOSTRAR${zoneNote} — se enviarán como tarjetas visuales, NO las listes en tu respuesta:\n${propList}\nRESPUESTA REQUERIDA: El usuario pidió ver propiedades. DEBES presentarlas. Di algo breve como "Te comparto estas opciones disponibles" o similar. NO hagas más preguntas de filtrado — el usuario ya quiere ver resultados.`;
      } else {
        // Proactive: mention naturally, don't force it
        propertyPromptNote = `\n\nPROPIEDADES DISPONIBLES (se enviarán como tarjetas si las mencionas)${zoneNote}:\n${propList}\nSi es relevante en tu respuesta, puedes mencionar brevemente que hay opciones disponibles. No lo fuerces si no encaja.`;
      }
    } else if (hasSearchIntent) {
      propertyPromptNote = '\n\nBÚSQUEDA: No hay propiedades publicadas disponibles en este momento. Comunícalo directamente.';
    }

    // ── System prompt ─────────────────────────────────────────────────────────
    const systemPrompt = `Eres AndreI, asesor inmobiliario virtual de LISTED, plataforma de bienes raíces en México.
${userProfileBlock}
QUIÉN ERES:
Experto en el mercado inmobiliario mexicano. Conoces créditos hipotecarios (Infonavit, Fovissste, bancarios, cofinavit), costos de compraventa, procesos legales, plusvalía y zonas. Tu rol es asesorar Y conectar al usuario con propiedades reales disponibles en LISTED.

CÓMO RESPONDER:
- Responde lo que preguntan. Informativo cuando preguntan, propiedades cuando las piden.
- Usa el perfil del usuario para personalizar tus respuestas. Si tiene capacidad de compra o crédito Infonavit, menciónalo cuando sea relevante.
- Cuando sea natural, aprovecha para mostrar que hay opciones reales disponibles. Eres un asesor que también tiene inventario — úsalo.
- Sé conversacional. Adapta tu nivel. Ve al grano sin frases de relleno.
- Bullets o listas cuando organices información, no en cada mensaje.
- Español mexicano natural. Sin emojis.

MOSTRAR PROPIEDADES — REGLA CRÍTICA:
Cuando el sistema te indica "PROPIEDADES A MOSTRAR" con la etiqueta "RESPUESTA REQUERIDA", DEBES presentar las propiedades en tu respuesta. No es opcional. Di algo como "Te comparto estas opciones disponibles en LISTED" y punto. No hagas más preguntas de filtrado, no pidas más información. El usuario ya pidió ver — muéstrale.

LÍMITES:
Solo bienes raíces e inmuebles en México. Para temas completamente ajenos, redirige: "Mi especialidad es bienes raíces. ¿Te ayudo con alguna duda sobre propiedades, créditos o inversión?"
${propertyPromptNote}`;

    // ── Call AI ───────────────────────────────────────────────────────────────
    const aiMessages = history.length > 0
      ? history.map(h => ({ role: h.role, content: h.message }))
      : [{ role: 'user', content: message.trim() }];

    // Cache generic informational questions (no user-specific data, no property search)
    // These are identical across users: "cómo funciona Infonavit", "documentos para rentar", etc.
    const isGenericQuestion = !hasSearchIntent && !isProactiveSearch && !userProfileBlock;
    const assistantCacheTTL = isGenericQuestion ? 7200 : 0; // 2h cache for generic info

    const reply = await aiGenerateMessages(systemPrompt, aiMessages, {
      cacheTTL: assistantCacheTTL,
      cachePrefix: 'asst',
    });

    if (userId) {
      await q('INSERT INTO ai_conversations (user_id, role, message) VALUES (?, ?, ?)',
        [userId, 'assistant', reply]);
    }

    return res.json({ ok: true, reply, properties: searchedProperties.slice(0, 3) });
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
router.get('/api/ai/assistant/history', optionalAuth, assistantLimiter, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.json({ ok: true, messages: [] });

    const rows = await q(
      `SELECT role, message, created_at FROM ai_conversations
       WHERE user_id = ? AND message NOT REGEXP 'ID [0-9]+:'
       ORDER BY created_at ASC LIMIT 15`,
      [userId]
    );
    return res.json({ ok: true, messages: rows });
  } catch (err) {
    console.error('[ai:history]', err.message);
    return res.json({ ok: true, messages: [] });
  }
});

// ── Cleanup: keep last 15 messages (called when user leaves chat) ────────────
router.post('/api/ai/assistant/cleanup', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const countResult = await q('SELECT COUNT(*) as cnt FROM ai_conversations WHERE user_id = ?', [userId]);
    if (countResult[0]?.cnt > 15) {
      await q(
        `DELETE FROM ai_conversations WHERE user_id = ? AND id NOT IN (
          SELECT id FROM (SELECT id FROM ai_conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 15) AS recent
        )`,
        [userId, userId]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[ai:cleanup]', err.message);
    return res.json({ ok: true });
  }
});

// ── Reset: delete ALL conversation history ────────────────────────────────────
router.post('/api/ai/assistant/reset', authenticateToken, async (req, res) => {
  try {
    await q('DELETE FROM ai_conversations WHERE user_id = ?', [req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[ai:reset]', err.message);
    return res.json({ ok: true });
  }
});

module.exports = router;
