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
    const isRent = input.operation_type === 'renta';

    // Para venta: comparar con propiedades en venta (price)
    // Para renta: comparar con propiedades en renta (monthly_pay)
    const priceCol = isRent ? 'monthly_pay' : 'price';
    const typeFilter = isRent ? 'renta' : 'venta';

    const rows = await q(
      `SELECT ${priceCol} AS comp_price, construction, land, bedrooms, bathrooms, parking_spaces,
              private_pool, gated_community, gym, common_pool, clubhouse,
              bbq_area, roof_garden, private_garden, fitted_kitchen,
              furnished, service_room, storage_room, study_office,
              cctv, alarm, surveillance_24_7, controlled_access
       FROM properties
       WHERE city = ? AND estate_type = ? AND type = ? AND is_published = 1
         AND ${priceCol} IS NOT NULL AND ${priceCol} > 0
         AND construction IS NOT NULL AND construction > 0`,
      [city, estate_type, typeFilter]
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
      pm2: r.comp_price / r.construction,
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

    // Ajustes por antigüedad (solo para venta — en renta el valor no baja tanto por edad)
    if (!isRent) {
      const age = Number(input.age_years) || 0;
      if (age > 20) avgPM2 *= 0.90;
      else if (age > 10) avgPM2 *= 0.95;
    }

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
      operation_type: isRent ? 'renta' : 'venta',
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

    // Prevenir requests duplicados para la misma dirección
    const [existing] = await q(
      `SELECT id FROM owner_agent_requests
       WHERE user_id = ? AND address = ? AND status = 'submitted'
       LIMIT 1`,
      [userId, b.address]
    );
    if (existing) {
      return res.json({ ok: true, requestId: existing.id, existing: true });
    }

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
        u.avg_rating, u.rating_count,
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

    // Máximo 3 agentes activos (no rechazados) por solicitud. Si los 3
    // anteriores rechazaron, el usuario puede volver a ofrecer a 3 nuevos.
    const [{ active_cnt }] = await q(
      `SELECT COUNT(*) AS active_cnt FROM owner_agent_contacts
       WHERE request_id = ? AND IFNULL(status, 'pending') != 'rejected'`,
      [requestId]
    );
    if (active_cnt >= 3) {
      return res.status(403).json({
        error: 'Ya tienes 3 agentes activos. Espera a que respondan o sean rechazados antes de ofrecer a nuevos agentes.',
      });
    }

    // Upsert: si el agente había rechazado antes, permitir re-contactarlo
    // reiniciando status='pending' y created_at (para el timeout de 3 días).
    // Si el contacto existe con status activo (pending/accepted), no duplicar.
    const [existingContact] = await q(
      `SELECT id, status FROM owner_agent_contacts
       WHERE request_id = ? AND agent_id = ? LIMIT 1`,
      [requestId, agentId]
    );

    if (existingContact) {
      if (existingContact.status === 'rejected') {
        await q(
          `UPDATE owner_agent_contacts SET status = 'pending', created_at = NOW()
           WHERE id = ?`,
          [existingContact.id]
        );
      } else {
        return res.json({ ok: false, already_contacted: true });
      }
    } else {
      await q(
        'INSERT INTO owner_agent_contacts (request_id, user_id, agent_id) VALUES (?, ?, ?)',
        [requestId, userId, agentId]
      );
    }

    // Si el request estaba en estado 'rejected' (todos los 3 anteriores
    // rechazaron), reabrirlo ahora que hay un nuevo contacto activo.
    if (request.status === 'rejected') {
      await q(
        `UPDATE owner_agent_requests SET status = 'submitted' WHERE id = ?`,
        [requestId]
      );
    }

    // Preferir property_id ya vinculado al request (columna directa).
    // Fallback: buscar por address match (legacy).
    let propertyId;
    if (request.property_id) {
      const [stillExists] = await q(
        'SELECT id FROM properties WHERE id = ? LIMIT 1',
        [request.property_id]
      );
      if (stillExists) propertyId = stillExists.id;
    }

    if (!propertyId) {
      const [existingProp] = await q(
        `SELECT id FROM properties WHERE created_by = ? AND review_status = 'prospect'
         AND address = ? AND estate_type = ? AND city = ? LIMIT 1`,
        [userId, request.address, request.estate_type, request.city]
      );
      if (existingProp) propertyId = existingProp.id;
    }

    if (!propertyId) {
      // Crear propiedad prospecto solo la primera vez
      const isRentProspect = request.operation_type === 'renta';
      const propResult = await q(
        `INSERT INTO properties (
          estate_type, address, city, lat, lng, land, construction,
          bedrooms, bathrooms, parking_spaces, price, monthly_pay, type,
          created_by, review_status, is_published
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prospect', 0)`,
        [
          request.estate_type, request.address, request.city,
          request.lat, request.lng,
          request.land_area, request.construction_area,
          request.bedrooms, request.bathrooms, request.parking_spaces,
          isRentProspect ? null : request.desired_price,
          isRentProspect ? request.desired_price : null,
          request.operation_type,
          userId,
        ]
      );
      propertyId = propResult.insertId;

      // Insertar imágenes solo al crear la propiedad
      if (images && images.length > 0) {
        const imgValues = images.map((url) => [propertyId, url]);
        await q(
          'INSERT INTO property_images (property_id, image_url) VALUES ?',
          [imgValues]
        );
      }
    }

    // Vincula property_id al request para evitar matching frágil después
    if (propertyId && request.property_id !== propertyId) {
      await q(
        'UPDATE owner_agent_requests SET property_id = ? WHERE id = ?',
        [propertyId, requestId]
      );
    }

    // Construir mensaje automático
    const isRent = request.operation_type === 'renta';
    const opLabel = isRent ? 'rentar' : 'vender';
    const estMin = request.estimated_min ? Number(request.estimated_min).toLocaleString('es-MX') : '?';
    const estMax = request.estimated_max ? Number(request.estimated_max).toLocaleString('es-MX') : '?';
    const valLabel = isRent ? 'Renta estimada' : 'Valuación estimada';
    const suffix = isRent ? '/mes' : '';
    const message = `Hola, tengo una ${request.estate_type} en ${request.city} de ${request.construction_area || '?'}m², ${request.bedrooms || '?'} rec, ${request.bathrooms || '?'} baños. ${valLabel}: $${estMin} - $${estMax}${suffix}. Documentación: ${request.doc_percentage}% lista. Me interesa que me ayudes a ${opLabel}.`;

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
      // Propietario: obtener contactos con info de agente y request. Derivamos
      // property_id desde chat_messages (vínculo confiable creado por el
      // endpoint /contact al generar el mensaje intro). Matching por address
      // no es confiable porque Nominatim devuelve strings largos y el property
      // puede haberse editado.
      // property_id viene directo de owner_agent_requests.property_id.
      // INNER JOIN con properties: si la propiedad fue borrada, el request
      // queda huérfano y NO se muestra (evita cards con ver/editar rotos).
      const contacts = await q(
        `SELECT oac.request_id, oac.agent_id, oac.status AS contact_status,
                u.name, u.last_name, u.profile_photo, u.phone,
                r.address, r.city, r.estate_type, r.desired_price AS price,
                r.construction_area AS construction, r.bedrooms, r.bathrooms,
                r.operation_type AS type, r.created_at, r.property_id
         FROM owner_agent_contacts oac
         JOIN users u ON u.id = oac.agent_id
         JOIN owner_agent_requests r ON r.id = oac.request_id
         JOIN properties p ON p.id = r.property_id
         WHERE oac.user_id = ?
         ORDER BY r.created_at DESC`,
        [userId]
      );

      // Covers de las propiedades referenciadas
      const propertyIds = [...new Set(contacts.map(c => c.property_id).filter(Boolean))];
      const coverMap = new Map();
      if (propertyIds.length > 0) {
        const placeholders = propertyIds.map(() => '?').join(',');
        const coverRows = await q(
          `SELECT property_id, image_url FROM (
             SELECT property_id, image_url,
                    ROW_NUMBER() OVER (PARTITION BY property_id ORDER BY id ASC) AS rn
             FROM property_images
             WHERE property_id IN (${placeholders})
           ) t WHERE rn = 1`,
          propertyIds
        );
        for (const row of coverRows) coverMap.set(row.property_id, row.image_url);
      }

      // Agrupar por request_id
      const groupMap = new Map();
      for (const c of contacts) {
        const rid = c.request_id;
        if (!groupMap.has(rid)) {
          groupMap.set(rid, {
            property_id: c.property_id || null,
            request_id: rid,
            address: c.address,
            city: c.city,
            estate_type: c.estate_type,
            price: c.price,
            construction: c.construction,
            bedrooms: c.bedrooms,
            bathrooms: c.bathrooms,
            type: c.type,
            cover: c.property_id ? (coverMap.get(c.property_id) || null) : null,
            created_at: c.created_at,
            contacts_count: 0,
            active_count: 0,
            rejected_count: 0,
            can_reoffer: false,
            contacted_agent_ids: '',
            agents: [],
          });
        }
        const group = groupMap.get(rid);
        // Si aún no tenemos property_id en el group y este contact sí, llenar
        if (!group.property_id && c.property_id) {
          group.property_id = c.property_id;
          group.cover = coverMap.get(c.property_id) || null;
        }
        group.contacts_count++;
        const status = c.contact_status || 'pending';
        if (status === 'rejected') group.rejected_count++;
        else group.active_count++;
        group.contacted_agent_ids += (group.contacted_agent_ids ? ',' : '') + c.agent_id;
        group.agents.push({
          id: c.agent_id,
          name: c.name,
          last_name: c.last_name,
          profile_photo: c.profile_photo,
          phone: c.phone,
          contact_status: status,
          property_id: group.property_id,
        });
      }
      // Puede re-ofrecer si hay al menos 1 contacto y TODOS están rechazados
      // (0 activos). El backend /contact aplicará el mismo check al insertar.
      for (const group of groupMap.values()) {
        group.can_reoffer = group.contacts_count > 0 && group.active_count === 0;
      }
      rows = Array.from(groupMap.values());

      console.log('[prospects/owner] DEBUG groups:', JSON.stringify(rows.map(r => ({
        request_id: r.request_id, property_id: r.property_id, address: r.address,
        contacts: r.contacts_count, active: r.active_count, rejected: r.rejected_count,
      }))));
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
      'SELECT id, created_by, address, estate_type, city FROM properties WHERE id = ? AND review_status = ?',
      [propertyId, 'prospect']
    );
    if (!property) return res.status(404).json({ error: 'Propiedad no encontrada' });

    // Verificar que el agente fue contactado por el dueño (vinculado a esta propiedad)
    const [contact] = await q(
      `SELECT oac.id, oac.request_id FROM owner_agent_contacts oac
       JOIN owner_agent_requests r ON r.id = oac.request_id
       WHERE oac.user_id = ? AND oac.agent_id = ?
         AND r.address = ? AND r.estate_type = ? AND r.city = ?
       ORDER BY oac.id DESC LIMIT 1`,
      [property.created_by, agentId, property.address, property.estate_type, property.city]
    );
    if (!contact) return res.status(403).json({ error: 'No autorizado' });

    if (action === 'accept') {
      // Atomic update: solo acepta si no hay managed_by (race condition safe).
      // Esta es la ÚNICA operación que puede devolver error al cliente.
      let upd;
      try {
        upd = await q(
          'UPDATE properties SET managed_by = ? WHERE id = ? AND managed_by IS NULL',
          [agentId, propertyId]
        );
      } catch (e) {
        console.error('[find-agent/respond] managed_by update failed:', e);
        return res.status(500).json({ error: 'Error interno' });
      }
      if (upd.affectedRows === 0) {
        return res.status(409).json({ error: 'Esta propiedad ya fue aceptada por otro agente' });
      }

      // A partir de aquí la propiedad YA fue traspasada. Cualquier side effect
      // que falle se loggea pero no debe devolver error al cliente.

      // Publicar directamente al ser aceptada por un agente
      try {
        await q(
          'UPDATE properties SET review_status = ?, is_published = 1 WHERE id = ?',
          ['approved', propertyId]
        );
      } catch (e) {
        console.error('[find-agent/respond] publish update failed:', e?.message || e);
      }

      // Marcar este contacto como aceptado
      try {
        await q('UPDATE owner_agent_contacts SET status = ? WHERE id = ?', ['accepted', contact.id]);
      } catch (e) {
        console.error('[find-agent/respond] contact accept update failed:', e?.message || e);
      }

      // Rechazar automáticamente a los demás agentes contactados para esta propiedad
      try {
        await q(
          `UPDATE owner_agent_contacts SET status = 'rejected'
           WHERE request_id = ? AND id != ? AND status != 'accepted'`,
          [contact.request_id, contact.id]
        );
      } catch (e) {
        console.error('[find-agent/respond] reject-others update failed:', e?.message || e);
      }

      // Actualizar request a accepted
      try {
        await q(
          'UPDATE owner_agent_requests SET status = ? WHERE id = ?',
          ['accepted', contact.request_id]
        );
      } catch (e) {
        console.error('[find-agent/respond] request accept update failed:', e?.message || e);
      }

      // Notificar al propietario — fire-and-forget
      try {
        await Promise.resolve(sendPushToUser({
          userId: property.created_by,
          title: 'Agente aceptó tu propiedad',
          body: 'Un agente ha aceptado gestionar tu propiedad.',
          data: { type: 'prospect_accepted' },
        })).catch((e) => console.error('[find-agent/respond] push failed:', e?.message || e));
      } catch (pushErr) {
        console.error('[find-agent/respond] push sync error:', pushErr?.message || pushErr);
      }

      return res.json({ ok: true, action: 'accepted' });
    } else {
      // Reject: también blindado para no devolver error al cliente si los side
      // effects fallan después del UPDATE principal.
      try {
        await q('UPDATE owner_agent_contacts SET status = ? WHERE id = ?', ['rejected', contact.id]);
      } catch (e) {
        console.error('[find-agent/respond] contact reject update failed:', e);
        return res.status(500).json({ error: 'Error interno' });
      }

      try {
        const [{ pending }] = await q(
          `SELECT COUNT(*) AS pending FROM owner_agent_contacts
           WHERE request_id = ? AND status != 'rejected'`,
          [contact.request_id]
        );
        if (pending === 0) {
          await q('UPDATE owner_agent_requests SET status = ? WHERE id = ?', ['rejected', contact.request_id]);
        }
      } catch (e) {
        console.error('[find-agent/respond] request reject update failed:', e?.message || e);
      }

      return res.json({ ok: true, action: 'rejected' });
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
      'SELECT id, created_by, address, estate_type, city FROM properties WHERE id = ? AND review_status = ?',
      [propertyId, 'prospect']
    );
    if (!prop) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Buscar el contacto que corresponde a esta propiedad específica
    // Vincular por address+estate_type+city del request que coincida con la propiedad
    const [contact] = await q(
      `SELECT oac.request_id FROM owner_agent_contacts oac
       JOIN owner_agent_requests r ON r.id = oac.request_id
       WHERE oac.user_id = ? AND oac.agent_id = ?
         AND r.address = ? AND r.estate_type = ? AND r.city = ?
       ORDER BY oac.id DESC LIMIT 1`,
      [prop.created_by, agentId, prop.address, prop.estate_type, prop.city]
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
