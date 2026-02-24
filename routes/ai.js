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
const { aiGenerate, aiGenerateMessages } = require('../utils/ai');

// ── Per-user rate limiters ──────────────────────────────────────────────────────
function userKeyGenerator(req) {
  return `ai:ul:${req.user?.id || req.ip}`;
}

const descriptionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:ai:desc:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit', message: 'Demasiados intentos. Intenta en unos minutos.' }),
});

const smartRepliesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:ai:replies:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit' }),
});

const assistantLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyGenerator: userKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:ai:assist:' }),
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'rate_limit', message: 'Has enviado muchos mensajes. Espera unos minutos.' }),
});

// ── Helper: promisified pool.query ──────────────────────────────────────────────
function q(sql, params) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
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

    const systemPrompt = `Eres un copywriter inmobiliario mexicano profesional. Genera una descripción atractiva para un listado de propiedad en un marketplace. La descripción debe:
- Estar en español mexicano natural
- Tener máximo 450 caracteres
- No usar emojis
- Ser persuasiva pero honesta
- Destacar las mejores características
- Usar un tono profesional y cálido
Responde ÚNICAMENTE con la descripción, sin comillas ni explicaciones adicionales.`;

    const userPrompt = `Genera una descripción para esta propiedad:\n${details}`;

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

    const { messages, property } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'Se requieren mensajes del chat.' });
    }

    // Take last 6 messages
    const recentMessages = messages.slice(-6);
    const chatContext = recentMessages.map(m =>
      `${m.isOwn ? 'Agente' : 'Cliente'}: ${m.text}`
    ).join('\n');

    let propertyContext = '';
    if (property) {
      const parts = [
        property.address ? `Ubicación: ${property.address}` : null,
        property.type ? `Tipo: ${property.type}` : null,
        property.price ? `Precio: $${Number(property.price).toLocaleString('es-MX')}` : null,
        property.monthly_pay ? `Renta: $${Number(property.monthly_pay).toLocaleString('es-MX')}/mes` : null,
      ].filter(Boolean);
      if (parts.length) propertyContext = `\nPropiedad en discusión:\n${parts.join('\n')}`;
    }

    const systemPrompt = `Eres un asistente para agentes inmobiliarios en México. Genera exactamente 3 respuestas sugeridas para que el agente responda al último mensaje del cliente. Las respuestas deben:
- Ser variadas: una formal, una amigable, una directa
- Tener entre 20 y 150 caracteres cada una
- Estar en español mexicano natural
- Ser profesionales y útiles
- No usar emojis
Responde ÚNICAMENTE con las 3 respuestas separadas por |||, sin numeración ni explicaciones.`;

    const userPrompt = `Conversación reciente:\n${chatContext}${propertyContext}\n\nGenera 3 respuestas sugeridas para el agente:`;

    const result = await aiGenerate(systemPrompt, userPrompt, {
      cacheTTL: 600,
      cachePrefix: 'replies',
    });

    // Parse the 3 replies
    const replies = result.split('|||').map(r => r.trim()).filter(r => r.length > 0).slice(0, 3);

    if (replies.length === 0) {
      return res.status(500).json({ ok: false, error: 'No se pudieron generar respuestas.' });
    }

    return res.json({ ok: true, replies });
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
router.post('/api/ai/assistant', authenticateToken, assistantLimiter, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { message, propertyIds } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'Se requiere un mensaje.' });
    }

    // Ensure ai_conversations table exists (graceful)
    try {
      await q(`CREATE TABLE IF NOT EXISTS ai_conversations (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        role ENUM('user', 'assistant') NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_created (user_id, created_at)
      )`, []);
    } catch { /* table likely exists */ }

    // Save user message
    await q('INSERT INTO ai_conversations (user_id, role, message) VALUES (?, ?, ?)',
      [userId, 'user', message.trim()]);

    // Fetch recent history (last 8 turns)
    const history = await q(
      'SELECT role, message FROM ai_conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 8',
      [userId]
    );
    history.reverse();

    // Enrich with property data if IDs provided
    let propertyContext = '';
    if (propertyIds && Array.isArray(propertyIds) && propertyIds.length > 0) {
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

    // Fetch user buying power if available
    let buyingPowerContext = '';
    try {
      const [bp] = await q(
        'SELECT suggested FROM buying_power WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      if (bp?.suggested) {
        buyingPowerContext = `\n\nCapacidad de compra estimada del usuario: $${Number(bp.suggested).toLocaleString('es-MX')}`;
      }
    } catch { /* table may not exist */ }

    const systemPrompt = `Eres un experto en bienes raíces en México que asesora a compradores y renteros. Tu conocimiento incluye:
- Procesos de compraventa y renta de inmuebles en México
- Créditos hipotecarios (bancarios, Infonavit, Fovissste, cofinavit)
- Costos de escrituración, avalúo, comisiones
- Requisitos legales y documentación
- Zonas y mercado inmobiliario mexicano
- Consejos prácticos para compradores primerizos

Reglas:
- Responde en español mexicano natural y profesional
- Máximo 300 palabras por respuesta
- No uses emojis
- Sé útil, claro y conciso
- Si el usuario pregunta algo fuera del tema inmobiliario, redirige amablemente
- Cuando sea relevante, sugiere usar herramientas de la app como la calculadora Infonavit o el perfil de capacidad de compra
- No inventes datos específicos de precios de zonas; si no estás seguro, indica que los precios varían${propertyContext}${buyingPowerContext}`;

    // Build messages array for multi-turn
    const aiMessages = history.map(h => ({
      role: h.role,
      content: h.message,
    }));

    const reply = await aiGenerateMessages(systemPrompt, aiMessages, {
      cacheTTL: 0, // No cache for conversational context
      cachePrefix: 'assistant',
    });

    // Save assistant reply
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

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error('[ai:assistant]', err.message);
    if (err.message === 'AI_DISABLED') {
      return res.status(503).json({ ok: false, error: 'ai_disabled', message: 'El asistente no está disponible temporalmente.' });
    }
    return res.status(500).json({ ok: false, error: 'ai_error', message: 'Error al procesar tu mensaje.' });
  }
});

// ── Get assistant history ───────────────────────────────────────────────────────
router.get('/api/ai/assistant/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
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
