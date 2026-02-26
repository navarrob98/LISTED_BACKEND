const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const { sendPushToUser } = require('../utils/helpers');

// ── Helper ──
const q = (sql, params) =>
  new Promise((resolve, reject) =>
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );

// ────────────────────────────────────────────────
// GET /api/find-agent/city?lat=X&lng=Y
// Extraer ciudad de coordenadas (Nominatim + cache)
// ────────────────────────────────────────────────
router.get('/api/find-agent/city', authenticateToken, async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'Faltan lat/lng' });
    const { extractCityFromCoords } = require('../utils/extractCity');
    const city = await extractCityFromCoords(Number(lat), Number(lng));
    res.json({ city: city || null });
  } catch (err) {
    console.error('[find-agent/city]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// POST /api/find-agent/estimate
// Valuación automática por comparables con scoring
// ────────────────────────────────────────────────

// Score de similitud entre propiedad del usuario y un comparable (0-100)
function similarityScore(input, comp) {
  let score = 0;
  let maxScore = 0;

  // Construcción (peso 25) — qué tan cerca en m²
  if (input.construction_area && comp.construction) {
    maxScore += 25;
    const ratio = Math.min(input.construction_area, comp.construction) / Math.max(input.construction_area, comp.construction);
    score += ratio * 25;
  }

  // Terreno (peso 15)
  if (input.land_area && comp.land) {
    maxScore += 15;
    const ratio = Math.min(input.land_area, comp.land) / Math.max(input.land_area, comp.land);
    score += ratio * 15;
  }

  // Recámaras (peso 15) — exacto = 100%, ±1 = 60%, ±2+ = 20%
  if (input.bedrooms != null && comp.bedrooms != null) {
    maxScore += 15;
    const diff = Math.abs(input.bedrooms - comp.bedrooms);
    if (diff === 0) score += 15;
    else if (diff === 1) score += 9;
    else score += 3;
  }

  // Baños (peso 10)
  if (input.bathrooms != null && comp.bathrooms != null) {
    maxScore += 10;
    const diff = Math.abs(input.bathrooms - comp.bathrooms);
    if (diff === 0) score += 10;
    else if (diff === 1) score += 6;
    else score += 2;
  }

  // Estacionamientos (peso 5)
  if (input.parking_spaces != null && comp.parking_spaces != null) {
    maxScore += 5;
    const diff = Math.abs(input.parking_spaces - comp.parking_spaces);
    if (diff === 0) score += 5;
    else if (diff === 1) score += 3;
    else score += 1;
  }

  // Amenidades booleanas (peso 30 total, repartido)
  const boolFields = [
    'private_pool', 'gated_community', 'gym', 'common_pool', 'clubhouse',
    'bbq_area', 'roof_garden', 'private_garden', 'fitted_kitchen',
    'furnished', 'service_room', 'storage_room', 'study_office',
    'cctv', 'alarm', 'surveillance_24_7', 'controlled_access',
  ];
  const activeInputAmenities = boolFields.filter(f => input[f]);
  if (activeInputAmenities.length > 0) {
    const perAmenity = 30 / activeInputAmenities.length;
    maxScore += 30;
    for (const f of activeInputAmenities) {
      if (comp[f]) score += perAmenity;
    }
  }

  return maxScore > 0 ? (score / maxScore) * 100 : 50;
}

router.post('/api/find-agent/estimate', authenticateToken, async (req, res) => {
  try {
    const input = req.body;
    const { city, estate_type, construction_area } = input;

    if (!city || !estate_type || !construction_area) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const conArea = Number(construction_area);

    // Traer comparables amplios: misma ciudad y tipo, con precio válido
    const rows = await q(
      `SELECT price, construction, land, bedrooms, bathrooms, parking_spaces,
              private_pool, gated_community, gym, common_pool, clubhouse,
              bbq_area, roof_garden, private_garden, fitted_kitchen,
              furnished, service_room, storage_room, study_office,
              cctv, alarm, surveillance_24_7, controlled_access
       FROM properties
       WHERE city = ? AND estate_type = ? AND is_published = 1
         AND price IS NOT NULL AND price > 0
         AND construction IS NOT NULL AND construction > 0`,
      [city, estate_type]
    );

    if (rows.length < 3) {
      return res.json({ insufficient: true, comparables_count: rows.length });
    }

    // Calcular score de similitud para cada comparable
    const inputData = {
      construction_area: conArea,
      land_area: Number(input.land_area) || 0,
      bedrooms: Number(input.bedrooms) || 0,
      bathrooms: Number(input.bathrooms) || 0,
      parking_spaces: Number(input.parking_spaces) || 0,
      private_pool: input.private_pool,
      gated_community: input.gated_community,
      gym: input.gym,
      common_pool: input.common_pool,
      clubhouse: input.clubhouse,
      bbq_area: input.bbq_area,
      roof_garden: input.roof_garden,
      private_garden: input.private_garden,
      fitted_kitchen: input.fitted_kitchen,
      furnished: input.furnished,
      service_room: input.service_room,
      storage_room: input.storage_room,
      study_office: input.study_office,
      cctv: input.cctv,
      alarm: input.alarm,
      surveillance_24_7: input.surveillance_24_7,
      controlled_access: input.controlled_access,
    };

    const scored = rows.map(r => ({
      ...r,
      pm2: r.price / r.construction,
      score: similarityScore(inputData, r),
    }));

    // Ordenar por score descendente, tomar top 60% o mínimo 3
    scored.sort((a, b) => b.score - a.score);
    const topCount = Math.max(3, Math.ceil(scored.length * 0.6));
    const top = scored.slice(0, topCount);

    // Promedio ponderado por score: propiedades más similares pesan más
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of top) {
      weightedSum += r.pm2 * r.score;
      weightTotal += r.score;
    }
    let avgPM2 = weightTotal > 0 ? weightedSum / weightTotal : top.reduce((s, r) => s + r.pm2, 0) / top.length;

    // Ajustes por antigüedad
    const age = Number(input.age_years) || 0;
    if (age > 20) avgPM2 *= 0.90;
    else if (age > 10) avgPM2 *= 0.95;

    // Ajustes por condición
    const cond = input.condition;
    if (cond === 'excelente') avgPM2 *= 1.05;
    else if (cond === 'reparaciones') avgPM2 *= 0.90;
    else if (cond === 'obra_negra') avgPM2 *= 0.80;

    const min = Math.round(avgPM2 * conArea * 0.85);
    const max = Math.round(avgPM2 * conArea * 1.15);

    res.json({
      min,
      max,
      avg_price_per_m2: Math.round(avgPM2),
      comparables_count: rows.length,
      top_matches: top.length,
    });
  } catch (err) {
    console.error('[find-agent/estimate]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// POST /api/find-agent/request
// Guardar solicitud completa del propietario
// ────────────────────────────────────────────────
router.post('/api/find-agent/request', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const b = req.body;

    // Calcular doc_percentage (5 obligatorios = 20% cada uno)
    const docs = b.docs || {};
    const mandatory = ['escrituras', 'predial', 'libertad_gravamen', 'ine', 'comprobante_domicilio'];
    let docCount = 0;
    for (const d of mandatory) {
      if (docs[d]) docCount++;
    }
    const docPercentage = docCount * 20;

    const result = await q(
      `INSERT INTO owner_agent_requests (
        user_id, operation_type, estate_type, address, city, lat, lng,
        land_area, construction_area, bedrooms, bathrooms, parking_spaces,
        age_years, property_condition, estimated_min, estimated_max, desired_price,
        doc_escrituras, doc_predial, doc_libertad_gravamen, doc_ine,
        doc_comprobante_domicilio, doc_planos, doc_reglamento_condo,
        doc_no_adeudo, doc_acta_matrimonio, doc_percentage,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
      [
        userId, b.operation_type, b.estate_type, b.address, b.city, b.lat, b.lng,
        b.land_area, b.construction_area, b.bedrooms, b.bathrooms, b.parking_spaces,
        b.age_years, b.property_condition, b.estimated_min, b.estimated_max, b.desired_price,
        docs.escrituras ? 1 : 0, docs.predial ? 1 : 0, docs.libertad_gravamen ? 1 : 0,
        docs.ine ? 1 : 0, docs.comprobante_domicilio ? 1 : 0, docs.planos ? 1 : 0,
        docs.reglamento_condo ? 1 : 0, docs.no_adeudo ? 1 : 0, docs.acta_matrimonio ? 1 : 0,
        docPercentage,
      ]
    );

    res.json({ ok: true, requestId: result.insertId });
  } catch (err) {
    console.error('[find-agent/request]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// GET /api/find-agent/agents?city=X&estate_type=Y
// Listar agentes verificados en la zona
// ────────────────────────────────────────────────
router.get('/api/find-agent/agents', authenticateToken, async (req, res) => {
  try {
    const { city, estate_type } = req.query;
    if (!city) return res.status(400).json({ error: 'Falta city' });

    const rows = await q(
      `SELECT u.id, u.name, u.last_name, u.profile_photo, u.agent_type,
        (SELECT COUNT(*) FROM properties WHERE created_by = u.id AND is_published = 1 AND city = ?) AS active_listings,
        (SELECT type FROM agent_credentials WHERE user_id = u.id LIMIT 1) AS credential_type
       FROM users u
       WHERE u.agent_type IN ('brokerage', 'individual')
         AND u.agent_verification_status = 'verified'
         AND u.id IN (SELECT DISTINCT created_by FROM properties WHERE city = ? AND is_published = 1)
       ORDER BY active_listings DESC`,
      [city, city]
    );

    res.json(rows);
  } catch (err) {
    console.error('[find-agent/agents]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// POST /api/find-agent/contact
// Contactar agente (crea propiedad prospecto + chat + registra contacto)
// ────────────────────────────────────────────────
router.post('/api/find-agent/contact', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestId, agentId, images } = req.body;

    if (!requestId || !agentId) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    // Validar que el request pertenece al usuario
    const [request] = await q(
      'SELECT * FROM owner_agent_requests WHERE id = ? AND user_id = ?',
      [requestId, userId]
    );
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });

    // Verificar límite de contactos (count from contacts table)
    const [{ cnt }] = await q(
      'SELECT COUNT(*) AS cnt FROM owner_agent_contacts WHERE request_id = ?',
      [requestId]
    );
    if (cnt >= 3) {
      return res.status(403).json({ error: 'Máximo 3 agentes por solicitud' });
    }

    // Insertar contacto (IGNORE para idempotencia si ya existe)
    const contactResult = await q(
      'INSERT IGNORE INTO owner_agent_contacts (request_id, user_id, agent_id) VALUES (?, ?, ?)',
      [requestId, userId, agentId]
    );

    // Dedup: si no insertó, el contacto ya existía
    if (contactResult.affectedRows === 0) {
      return res.json({ ok: false, already_contacted: true });
    }

    // Crear propiedad prospecto
    const propResult = await q(
      `INSERT INTO properties (
        estate_type, address, city, lat, lng, land, construction,
        bedrooms, bathrooms, parking_spaces, price, type,
        created_by, review_status, is_published
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prospect', 0)`,
      [
        request.estate_type, request.address, request.city,
        request.lat, request.lng,
        request.land_area, request.construction_area,
        request.bedrooms, request.bathrooms, request.parking_spaces,
        request.desired_price, request.operation_type,
        userId,
      ]
    );
    const propertyId = propResult.insertId;

    // Insertar imágenes si vienen
    if (images && images.length > 0) {
      const imgValues = images.map((url) => [propertyId, url]);
      await q(
        'INSERT INTO property_images (property_id, image_url) VALUES ?',
        [imgValues]
      );
    }

    // Construir mensaje automático
    const opLabel = request.operation_type === 'venta' ? 'vender' : 'rentar';
    const estMin = request.estimated_min ? Number(request.estimated_min).toLocaleString('es-MX') : '?';
    const estMax = request.estimated_max ? Number(request.estimated_max).toLocaleString('es-MX') : '?';
    const message = `Hola, tengo una ${request.estate_type} en ${request.city} de ${request.construction_area || '?'}m², ${request.bedrooms || '?'} rec, ${request.bathrooms || '?'} baños. Valuación estimada: $${estMin} - $${estMax}. Documentación: ${request.doc_percentage}% lista. Me interesa que me ayudes a ${opLabel}.`;

    // Crear chat_message con property_id
    await q(
      `INSERT INTO chat_messages (sender_id, receiver_id, message, message_type, property_id)
       VALUES (?, ?, ?, 'text', ?)`,
      [userId, agentId, message, propertyId]
    );

    // Push notification al agente
    sendPushToUser({
      userId: agentId,
      title: 'Nuevo cliente interesado',
      body: message.substring(0, 120),
      data: { type: 'chat' },
    });

    res.json({ ok: true, propertyId });
  } catch (err) {
    console.error('[find-agent/contact]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// GET /api/find-agent/prospects
// Propiedades prospecto del usuario (propietario o agente)
// ────────────────────────────────────────────────
router.get('/api/find-agent/prospects', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Determinar tipo de usuario
    const [user] = await q('SELECT agent_type FROM users WHERE id = ?', [userId]);
    const isAgent = user && /^(individual|brokerage|seller)$/i.test(user.agent_type || '');

    let rows;
    if (isAgent) {
      // Agente: propiedades donde fue contactado (excluye rechazadas)
      rows = await q(
        `SELECT p.id, p.address, p.city, p.estate_type, p.price, p.construction,
                p.bedrooms, p.bathrooms, p.type, p.created_at,
                (SELECT image_url FROM property_images WHERE property_id = p.id ORDER BY id ASC LIMIT 1) AS cover,
                u.name AS owner_name, u.last_name AS owner_last_name,
                IFNULL(c.status, 'pending') AS prospect_status
         FROM properties p
         JOIN owner_agent_contacts c ON c.user_id = p.created_by
         JOIN users u ON u.id = p.created_by
         WHERE p.review_status = 'prospect'
           AND c.agent_id = ?
           AND IFNULL(c.status, 'pending') != 'rejected'
           AND (p.managed_by IS NULL OR p.managed_by = ?)
           AND EXISTS (
             SELECT 1 FROM chat_messages cm
             WHERE cm.property_id = p.id
               AND cm.sender_id = p.created_by
               AND cm.receiver_id = ?
           )
         ORDER BY p.created_at DESC`,
        [userId, userId, userId]
      );
    } else {
      // Propietario: propiedades prospecto agrupadas por request_id
      const propRows = await q(
        `SELECT p.id, p.address, p.city, p.estate_type, p.price, p.construction,
                p.bedrooms, p.bathrooms, p.type, p.created_at,
                (SELECT image_url FROM property_images WHERE property_id = p.id ORDER BY id ASC LIMIT 1) AS cover,
                (SELECT cm.receiver_id FROM chat_messages cm
                 WHERE cm.property_id = p.id AND cm.sender_id = ? LIMIT 1) AS _agent_id
         FROM properties p
         WHERE p.review_status = 'prospect' AND p.created_by = ?
         ORDER BY p.created_at DESC`,
        [userId, userId]
      );

      // Datos de contactos por request con info del agente
      const contacts = await q(
        `SELECT oac.request_id, oac.agent_id, u.name, u.last_name, u.profile_photo,
          (SELECT COUNT(*) FROM owner_agent_contacts WHERE request_id = oac.request_id) AS contacts_count,
          (SELECT GROUP_CONCAT(oc.agent_id) FROM owner_agent_contacts oc WHERE oc.request_id = oac.request_id) AS contacted_agent_ids
        FROM owner_agent_contacts oac
        JOIN users u ON u.id = oac.agent_id
        WHERE oac.user_id = ?`,
        [userId]
      );

      // Agrupar propRows por request_id usando Map
      const groupMap = new Map();
      for (const row of propRows) {
        const c = contacts.find(ct => ct.agent_id === row._agent_id);
        if (!c) continue;
        const rid = c.request_id;
        if (!groupMap.has(rid)) {
          groupMap.set(rid, {
            request_id: rid,
            address: row.address,
            city: row.city,
            estate_type: row.estate_type,
            price: row.price,
            construction: row.construction,
            bedrooms: row.bedrooms,
            bathrooms: row.bathrooms,
            type: row.type,
            cover: row.cover,
            created_at: row.created_at,
            contacts_count: c.contacts_count,
            contacted_agent_ids: c.contacted_agent_ids,
            agents: [],
          });
        }
        const agentContact = contacts.find(ct => ct.agent_id === row._agent_id && ct.request_id === rid);
        if (agentContact) {
          groupMap.get(rid).agents.push({
            id: agentContact.agent_id,
            name: agentContact.name,
            last_name: agentContact.last_name,
            profile_photo: agentContact.profile_photo,
            property_id: row.id,
          });
        }
      }
      rows = Array.from(groupMap.values());
    }

    res.json(rows);
  } catch (err) {
    console.error('[find-agent/prospects]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// POST /api/find-agent/prospects/:propertyId/respond
// Agente acepta o rechaza propiedad prospecto
// ────────────────────────────────────────────────
router.post('/api/find-agent/prospects/:propertyId/respond', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;
    const propertyId = req.params.propertyId;
    const { action } = req.body; // 'accept' | 'reject'

    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Acción inválida' });
    }

    // Verificar que la propiedad prospecto existe
    const [property] = await q(
      'SELECT id, created_by FROM properties WHERE id = ? AND review_status = ?',
      [propertyId, 'prospect']
    );
    if (!property) return res.status(404).json({ error: 'Propiedad no encontrada' });

    // Verificar que el agente fue contactado por el dueño
    const [contact] = await q(
      'SELECT id FROM owner_agent_contacts WHERE user_id = ? AND agent_id = ?',
      [property.created_by, agentId]
    );
    if (!contact) return res.status(403).json({ error: 'No autorizado' });

    if (action === 'accept') {
      // Atomic update: solo acepta si no hay managed_by (race condition safe)
      const upd = await q(
        'UPDATE properties SET managed_by = ? WHERE id = ? AND managed_by IS NULL',
        [agentId, propertyId]
      );
      if (upd.affectedRows === 0) {
        return res.status(409).json({ error: 'Esta propiedad ya fue aceptada por otro agente' });
      }

      await q('UPDATE owner_agent_contacts SET status = ? WHERE id = ?', ['accepted', contact.id]);

      // Rechazar automáticamente a los demás agentes contactados para esta propiedad
      await q(
        `UPDATE owner_agent_contacts SET status = 'rejected'
         WHERE user_id = ? AND agent_id != ? AND status != 'accepted'
           AND request_id = (SELECT request_id FROM owner_agent_contacts WHERE id = ?)`,
        [property.created_by, agentId, contact.id]
      );

      // Notificar al propietario
      sendPushToUser({
        userId: property.created_by,
        title: 'Agente aceptó tu propiedad',
        body: 'Un agente ha aceptado gestionar tu propiedad.',
        data: { type: 'prospect_accepted' },
      });

      res.json({ ok: true, action: 'accepted' });
    } else {
      await q('UPDATE owner_agent_contacts SET status = ? WHERE id = ?', ['rejected', contact.id]);
      res.json({ ok: true, action: 'rejected' });
    }
  } catch (err) {
    console.error('[find-agent/respond]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// GET /api/find-agent/seller-context/:propertyId
// Contexto del vendedor para el agente en un chat prospect
// ────────────────────────────────────────────────
router.get('/api/find-agent/seller-context/:propertyId', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;
    const propertyId = req.params.propertyId;

    // Buscar la propiedad prospect y su request asociado
    const [prop] = await q(
      'SELECT id, created_by FROM properties WHERE id = ? AND review_status = ?',
      [propertyId, 'prospect']
    );
    if (!prop) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Buscar el request original del owner
    const [contact] = await q(
      'SELECT request_id FROM owner_agent_contacts WHERE user_id = ? AND agent_id = ?',
      [prop.created_by, agentId]
    );
    if (!contact) return res.status(403).json({ ok: false, error: 'No autorizado' });

    const [request] = await q(
      'SELECT * FROM owner_agent_requests WHERE id = ?',
      [contact.request_id]
    );
    if (!request) return res.status(404).json({ ok: false, error: 'Request no encontrado' });

    // Info del owner
    const [owner] = await q(
      'SELECT name, last_name, email, phone FROM users WHERE id = ?',
      [prop.created_by]
    );

    res.json({
      ok: true,
      owner: owner ? { name: owner.name, last_name: owner.last_name, email: owner.email, phone: owner.phone } : null,
      property: {
        operation_type: request.operation_type,
        estate_type: request.estate_type,
        address: request.address,
        city: request.city,
        land_area: request.land_area,
        construction_area: request.construction_area,
        bedrooms: request.bedrooms,
        bathrooms: request.bathrooms,
        parking_spaces: request.parking_spaces,
        age_years: request.age_years,
        property_condition: request.property_condition,
        desired_price: request.desired_price,
        estimated_min: request.estimated_min,
        estimated_max: request.estimated_max,
      },
      docs: {
        escrituras: !!request.doc_escrituras,
        predial: !!request.doc_predial,
        libertad_gravamen: !!request.doc_libertad_gravamen,
        ine: !!request.doc_ine,
        comprobante_domicilio: !!request.doc_comprobante_domicilio,
        planos: !!request.doc_planos,
        reglamento_condo: !!request.doc_reglamento_condo,
        no_adeudo: !!request.doc_no_adeudo,
        acta_matrimonio: !!request.doc_acta_matrimonio,
        percentage: request.doc_percentage,
      },
    });
  } catch (err) {
    console.error('[find-agent/seller-context]', err);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

module.exports = router;
