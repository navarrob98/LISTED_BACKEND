const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');

// POST /properties/add
router.post('/properties/add', authenticateToken, async (req, res) => {
  try {
    const {
      type,
      address,
      price,
      price_original,
      monthly_pay,
      bedrooms,
      bathrooms,
      half_bathrooms,
      land,
      construction,
      description,
      sell_rent,
      date_build,
      estate_type,
      parking_spaces,
      stories,
      private_pool,
      new_construction,
      water_serv,
      electricity_serv,
      sewer_serv,
      garbage_collection_serv,
      solar,
      ac,
      laundry_room,
      lat,
      lng,
      images,
      gated_community,
      condo_horizontal,
      surveillance_24_7,
      controlled_access,
      cctv,
      alarm,
      clubhouse,
      gym,
      common_pool,
      playground,
      park_garden,
      sports_court,
      event_room,
      bbq_area,
      maintenance_fee,
      service_room,
      roof_garden,
      private_garden,
      storage_room,
      study_office,
      fitted_kitchen,
      closets,
      cistern,
      water_heater,
      furnished,
      pets_allowed,
    } = req.body || {};

    const created_by = req.user.id;

    const [uRows] = await pool
      .promise()
      .query(
        `SELECT id, agent_type, agent_verification_status
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [created_by]
      );

    if (!uRows || !uRows.length) {
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    // Nueva regla:
    // - Todos pueden agregar propiedades (incluye agentes de cualquier tipo).
    // - Todas las propiedades pasan por revisión de propiedad.
    const finalReviewStatus = "pending";
    const finalIsPublished = 0;

    const query = `
      INSERT INTO properties (
        type, address, price, price_original, monthly_pay,
        bedrooms, bathrooms, half_bathrooms,
        land, construction, description,
        sell_rent, date_build, estate_type,
        parking_spaces, stories,
        private_pool, new_construction,
        water_serv, electricity_serv,
        sewer_serv, garbage_collection_serv,
        solar, ac, laundry_room,
        lat, lng, created_by,
        review_status, is_published,
        gated_community, condo_horizontal,
        surveillance_24_7, controlled_access, cctv, alarm,
        clubhouse, gym, common_pool, playground, park_garden, sports_court, event_room, bbq_area,
        maintenance_fee,
        service_room, roof_garden, private_garden, storage_room, study_office, fitted_kitchen, closets, cistern, water_heater,
        furnished, pets_allowed
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?
      )
    `;

    const values = [
      type ?? null,
      address ?? null,
      price ?? null,
      // price_original: si no viene, toma price (si existe)
      price_original ?? price ?? null,
      monthly_pay ?? null,

      bedrooms ?? null,
      bathrooms ?? null,
      half_bathrooms ?? null,

      land ?? null,
      construction ?? null,
      description ?? null,

      sell_rent ?? null,
      date_build ?? null,
      estate_type ?? null,

      parking_spaces ?? null,
      stories ?? null,

      private_pool ? 1 : 0,
      new_construction ? 1 : 0,

      water_serv ? 1 : 0,
      electricity_serv ? 1 : 0,

      sewer_serv ? 1 : 0,
      garbage_collection_serv ? 1 : 0,

      solar ? 1 : 0,
      ac ? 1 : 0,
      laundry_room ? 1 : 0,

      lat ?? null,
      lng ?? null,

      created_by,

      finalReviewStatus,
      finalIsPublished,

      gated_community ? 1 : 0,
      condo_horizontal ? 1 : 0,

      surveillance_24_7 ? 1 : 0,
      controlled_access ? 1 : 0,
      cctv ? 1 : 0,
      alarm ? 1 : 0,

      clubhouse ? 1 : 0,
      gym ? 1 : 0,
      common_pool ? 1 : 0,
      playground ? 1 : 0,
      park_garden ? 1 : 0,
      sports_court ? 1 : 0,
      event_room ? 1 : 0,
      bbq_area ? 1 : 0,

      maintenance_fee ?? null,

      service_room ? 1 : 0,
      roof_garden ? 1 : 0,
      private_garden ? 1 : 0,
      storage_room ? 1 : 0,
      study_office ? 1 : 0,
      fitted_kitchen ? 1 : 0,
      closets ? 1 : 0,
      cistern ? 1 : 0,
      water_heater ? 1 : 0,

      // Extras
      furnished ? 1 : 0,
      pets_allowed ? 1 : 0,
    ];

    const [result] = await pool.promise().query(query, values);
    const propertyId = result.insertId;

    // Fire-and-forget: extract city from coords
    if (lat && lng) {
      const { extractCityFromCoords } = require('../utils/extractCity');
      extractCityFromCoords(lat, lng)
        .then(city => {
          if (city) pool.promise().query('UPDATE properties SET city = ? WHERE id = ?', [city, propertyId]);
        })
        .catch(err => console.error('[extractCity] Error:', err));
    }

    // Inserta imágenes si vienen
    const imgs = Array.isArray(images) ? images.map((x) => String(x || "").trim()).filter(Boolean) : [];
    if (imgs.length) {
      const imageValues = imgs.map((url) => [propertyId, url]);
      await pool
        .promise()
        .query("INSERT INTO property_images (property_id, image_url) VALUES ?", [imageValues]);
    }

    return res.status(201).json({
      message: "Propiedad creada y enviada a revisión",
      propertyId,
      review_status: finalReviewStatus,
      is_published: finalIsPublished,
    });
  } catch (err) {
    console.error("Error saving property:", err);
    return res.status(500).json({ error: 'No se pudo guardar la propiedad' });
  }
});

// PUT /properties/:id
router.put('/properties/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const incoming = req.body || {};

  if (!id || Object.keys(incoming).length === 0) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  // 1) Imágenes (arrays opcionales)
  const imagesAdd    = Array.isArray(incoming.images_add) ? incoming.images_add.filter(Boolean) : [];
  const imagesRemove = Array.isArray(incoming.images_remove_urls) ? incoming.images_remove_urls.filter(Boolean) : [];

  // 2) Campos permitidos en 'properties'
  const colTypes = {
    address: 'string',
    price: 'number',
    monthly_pay: 'number',
    bedrooms: 'int',
    bathrooms: 'number',
    land: 'number',
    construction: 'number',
    description: 'string',
    type: 'string',
    half_bathrooms: 'int',
    sell_rent: 'string',
    date_build: 'int',
    estate_type: 'string',
    parking_spaces: 'int',
    stories: 'int',
    private_pool: 'bool',
    new_construction: 'bool',
    water_serv: 'bool',
    electricity_serv: 'bool',
    sewer_serv: 'bool',
    garbage_collection_serv: 'bool',
    solar: 'bool',
    ac: 'bool',
    laundry_room: 'bool',
    lat: 'float',
    lng: 'float',
    gated_community: 'bool',
    condo_horizontal: 'bool',
    surveillance_24_7: 'bool',
    controlled_access: 'bool',
    cctv: 'bool',
    alarm: 'bool',
    clubhouse: 'bool',
    gym: 'bool',
    common_pool: 'bool',
    playground: 'bool',
    park_garden: 'bool',
    sports_court: 'bool',
    event_room: 'bool',
    bbq_area: 'bool',
    maintenance_fee: 'number',
    service_room: 'bool',
    roof_garden: 'bool',
    private_garden: 'bool',
    storage_room: 'bool',
    study_office: 'bool',
    fitted_kitchen: 'bool',
    closets: 'bool',
    cistern: 'bool',
    water_heater: 'bool',
    furnished: 'bool',
    pets_allowed: 'bool',
  };

  const setFragments = [];
  const values = [];

  const castValue = (val, type) => {
    // Normaliza null-ish
    if (val === '' || val === undefined || val === null) return null;
    if (typeof val === 'string' && val.trim().toLowerCase() === 'null') return null;

    if (type === 'string') return String(val).trim();
    if (type === 'int')    { const n = parseInt(val, 10);    return Number.isFinite(n) ? n : null; }
    if (type === 'float' || type === 'number') { const n = parseFloat(val); return Number.isFinite(n) ? n : null; }
    if (type === 'bool') {
      if (val === true || val === 'true' || val === 1 || val === '1') return 1;
      if (val === false || val === 'false' || val === 0 || val === '0') return 0;
      return val ? 1 : 0;
    }
    return val;
  };

  // Crea SET dinámico para todo lo que NO sea precio
  for (const key of Object.keys(incoming)) {
    if (!(key in colTypes)) continue;
    if (key === 'price') continue; // el precio lo manejamos aparte
    const casted = castValue(incoming[key], colTypes[key]);
    setFragments.push(`${key} = ?`);
    values.push(casted);
  }

  // Verifica dueño
  const checkOwnerSql = `SELECT id FROM properties WHERE id = ? AND (created_by = ? OR managed_by = ?)`;
  pool.query(checkOwnerSql, [id, req.user.id, req.user.id], (chkErr, chkRows) => {
    if (chkErr)   return res.status(500).json({ error: 'Error de permisos' });
    if (!chkRows || chkRows.length === 0) return res.status(403).json({ error: 'No autorizado' });

    // Helpers imágenes
    const doRemovals = (cb) => {
      if (!imagesRemove.length) return cb();
      const placeholders = imagesRemove.map(() => '?').join(',');
      const delSql = `
        DELETE FROM property_images
        WHERE property_id = ? AND image_url IN (${placeholders})
      `;
      pool.query(delSql, [id, ...imagesRemove], (delErr) => cb(delErr));
    };

    const doAdds = (cb) => {
      if (!imagesAdd.length) return cb();
      const vals = imagesAdd.map(url => [id, url]);
      const insSql = `INSERT INTO property_images (property_id, image_url) VALUES ?`;
      pool.query(insSql, [vals], (insErr) => cb(insErr));
    };

    // Ejecuta: borrar → agregar → update properties
    doRemovals((remErr) => {
      if (remErr) return res.status(500).json({ error: 'No se pudieron eliminar imágenes' });

      doAdds((addErr) => {
        if (addErr) return res.status(500).json({ error: 'No se pudieron agregar imágenes' });

        // Si no hay SET (solo imágenes)
        const isPriceUpdate = Object.prototype.hasOwnProperty.call(incoming, 'price');
        if (!isPriceUpdate && setFragments.length === 0) {
          return res.json({ message: 'Actualizada (imágenes)', updatedFields: [] });
        }

        let sql, params;

        if (isPriceUpdate) {
          // Nuevo precio ya casteado
          const newPrice = castValue(incoming.price, 'number');

          const priceBlock = `
            price_prev = price,
            price_original = COALESCE(price_original, price),
            price = ?
          `;

          sql = `
            UPDATE properties
            SET ${setFragments.join(', ')}${setFragments.length ? ',' : ''} ${priceBlock}
            WHERE id = ? AND (created_by = ? OR managed_by = ?)
          `;
          params = [...values, newPrice, id, req.user.id, req.user.id];
        } else {
          // Update normal sin precio
          sql = `
            UPDATE properties
            SET ${setFragments.join(', ')}
            WHERE id = ? AND (created_by = ? OR managed_by = ?)
          `;
          params = [...values, id, req.user.id, req.user.id];
        }

        pool.query(sql, params, (err, result) => {
          if (err) {
            console.error('[PUT /properties/:id] SQL ERROR', { code: err.code, sqlMessage: err.sqlMessage });
            return res.status(500).json({ error: 'No se pudo actualizar' });
          }
          if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Propiedad no encontrada o no autorizada' });
          }

          const updatedFields = [
            ...setFragments.map(f => f.split('=')[0].trim()),
            ...(isPriceUpdate ? ['price_prev', 'price_original', 'price'] : []),
          ];

          res.json({ message: 'Actualizada', updatedFields });
        });
      });
    });
  });
});

// GET /properties
router.get('/properties', (req, res) => {
  const { minLat, maxLat, minLng, maxLng } = req.query;
  if (
    minLat === undefined || maxLat === undefined ||
    minLng === undefined || maxLng === undefined
  ) {
    return res.status(400).json({ error: 'Faltan parámetros de región' });
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 30;
  const offset = (page - 1) * limit;

  const whereParams = [Number(minLat), Number(maxLat), Number(minLng), Number(maxLng)];

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM properties p
    WHERE p.lat BETWEEN ? AND ?
      AND p.lng BETWEEN ? AND ?
      AND p.is_published = 1
  `;

  const query = `
    SELECT
      p.*,
      (SELECT image_url
        FROM property_images pi
        WHERE pi.property_id = p.id
        ORDER BY pi.id ASC
        LIMIT 1) AS images,
      CASE
        WHEN p.price_original IS NULL OR p.price_original <= 0 OR p.price >= p.price_original THEN 0
        ELSE ROUND(((p.price_original - p.price) / p.price_original) * 100, 1)
      END AS discount_percent
    FROM properties p
    WHERE p.lat BETWEEN ? AND ?
      AND p.lng BETWEEN ? AND ?
      AND p.is_published = 1
    ORDER BY
      (p.promoted_until IS NOT NULL AND p.promoted_until > NOW()) DESC,
      p.id DESC
    LIMIT ? OFFSET ?
  `;

  pool.query(countQuery, whereParams, (countErr, countRows) => {
    if (countErr) {
      console.error('Error counting properties:', countErr);
      return res.status(500).json({ error: 'No se pudieron obtener las propiedades' });
    }

    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    pool.query(
      query,
      [...whereParams, limit, offset],
      (err, results) => {
        if (err) {
          console.error('Error fetching properties:', err);
          return res.status(500).json({ error: 'No se pudieron obtener las propiedades' });
        }
        res.json({
          data: results,
          page,
          totalPages,
          total,
          hasMore: page < totalPages,
        });
      }
    );
  });
});

// GET /properties/:id/chat — property info for chat context (includes unpublished/prospect)
router.get('/properties/:id/chat', authenticateToken, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const sql = `
    SELECT
      p.*,
      u.name AS owner_name,
      u.last_name AS owner_last_name
    FROM properties p
    JOIN users u ON p.created_by = u.id
    WHERE p.id = ?
      AND (
        p.created_by = ?
        OR p.managed_by = ?
        OR EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.property_id = p.id AND (cm.sender_id = ? OR cm.receiver_id = ?))
      )
    LIMIT 1
  `;

  pool.query(sql, [id, userId, userId, userId, userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error al buscar la propiedad' });
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' });

    const property = rows[0];
    pool.query(
      `SELECT image_url FROM property_images WHERE property_id = ? ORDER BY id ASC`,
      [id],
      (imgErr, imgRows = []) => {
        if (imgErr) return res.json({ ...property, images: [] });
        res.json({ ...property, images: imgRows.map(r => r.image_url) });
      }
    );
  });
});

// GET /properties/:id
router.get('/properties/:id', (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT
      p.*,
      u.name AS owner_name,
      u.last_name AS owner_last_name,
      CASE
        WHEN p.price_original IS NULL OR p.price_original <= 0 OR p.price >= p.price_original THEN 0
        ELSE ROUND(((p.price_original - p.price) / p.price_original) * 100, 1)
      END AS discount_percent
    FROM properties p
    JOIN users u ON p.created_by = u.id
    WHERE p.id = ?
    AND p.is_published = 1
    LIMIT 1
  `;

  pool.query(sql, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error al buscar la propiedad' });
    if (!rows.length) return res.status(404).json({ error: 'No encontrada' });

    const property = rows[0];
    pool.query(
      `SELECT image_url FROM property_images WHERE property_id = ? ORDER BY id ASC`,
      [id],
      (imgErr, imgRows = []) => {
        if (imgErr) {
          console.error('Error fetching images:', imgErr);
          return res.json({ ...property, images: [] });
        }
        res.json({ ...property, images: imgRows.map(r => r.image_url) });
      }
    );
  });
});

// GET /my-properties
router.get('/my-properties', authenticateToken, (req, res) => {
  const userId = req.user.id;

  const query = `
    SELECT
      p.*,
      (SELECT image_url
         FROM property_images
        WHERE property_id = p.id
        ORDER BY id ASC
        LIMIT 1) AS images,
      CASE
        WHEN p.price_original IS NULL OR p.price_original <= 0 OR p.price >= p.price_original THEN 0
        ELSE ROUND(((p.price_original - p.price) / p.price_original) * 100, 1)
      END AS discount_percent
    FROM properties p
    WHERE (p.created_by = ? OR p.managed_by = ?)
    ORDER BY
      (p.promoted_until IS NOT NULL AND p.promoted_until > NOW()) DESC,
      p.id DESC
  `;

  pool.query(query, [userId, userId], (err, results) => {
    if (err) {
      console.error('Error getting user properties:', err);
      return res.status(500).json({ error: 'Error al obtener tus propiedades.' });
    }
    res.json(results);
  });
});

// GET /my-properties/:id
router.get('/my-properties/:id', authenticateToken, (req, res) => {
  const propertyId = Number(req.params.id);
  const userId = req.user.id;

  const sql = `
    SELECT
      p.*,
      COALESCE(img.images, JSON_ARRAY()) AS images,
      u.name AS owner_name, u.last_name AS owner_last_name,
      CASE
        WHEN p.price_original IS NULL OR p.price_original <= 0 OR p.price >= p.price_original THEN 0
        ELSE ROUND(((p.price_original - p.price) / p.price_original) * 100, 1)
      END AS discount_percent
    FROM properties p
    LEFT JOIN (
      SELECT
        property_id,
        CAST(
          CONCAT(
            '[',
            GROUP_CONCAT(JSON_QUOTE(image_url) ORDER BY id ASC SEPARATOR ','),
            ']'
          ) AS JSON
        ) AS images
      FROM property_images
      GROUP BY property_id
    ) img ON img.property_id = p.id
    JOIN users u ON u.id = p.created_by
    WHERE p.id = ?
      AND (
        p.created_by = ?
        OR (p.review_status = 'prospect' AND EXISTS (
          SELECT 1 FROM owner_agent_contacts c WHERE c.user_id = p.created_by AND c.agent_id = ?
        ))
      )
    LIMIT 1
  `;

  pool.query(sql, [propertyId, userId, userId], (err, rows) => {
    if (err) {
      console.error('[GET /my-properties/:id] error', err);
      return res.status(500).json({ error: 'Error consultando propiedad' });
    }
    if (!rows.length) return res.status(404).json({ error: 'No se encontró la propiedad (owner)' });
    res.json(rows[0]);
  });
});

// DELETE /properties/:id
router.delete('/properties/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const query = 'DELETE FROM properties WHERE id = ? AND created_by = ?';

  pool.query(query, [id, userId], (err, result) => {
    if (err) {
      console.error('Error deleting property:', err);
      return res.status(500).json({ error: 'No se pudo eliminar la propiedad' });
    }
    if (result.affectedRows === 0) {
      return res.status(403).json({ error: 'No autorizado o propiedad no encontrada' });
    }
    res.json({ message: 'Propiedad eliminada correctamente' });
  });
});

// POST /properties/:id/resubmit
router.post('/properties/:id/resubmit', authenticateToken, async (req, res) => {
  try {
    const propertyId = Number(req.params.id);
    const userId = req.user.id;

    // Verificar que la propiedad existe y pertenece al usuario
    const [rows] = await pool.promise().query(
      `SELECT id, created_by, review_status, is_published
       FROM properties
       WHERE id = ?
       LIMIT 1`,
      [propertyId]
    );

    if (!rows?.length) {
      return res.status(404).json({ error: 'Propiedad no encontrada' });
    }

    const property = rows[0];

    // Verificar que es el dueño
    if (String(property.created_by) !== String(userId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Solo se puede reenviar si está rechazada
    if (property.review_status !== 'rejected') {
      return res.status(400).json({
        error: 'Solo puedes reenviar publicaciones rechazadas',
        current_status: property.review_status
      });
    }

    // Actualizar el estado a 'pending' y limpiar notas de rechazo
    await pool.promise().query(
      `UPDATE properties
       SET review_status = 'pending',
           is_published = 0,
           review_notes = NULL,
           reviewed_at = NULL,
           reviewed_by = NULL
       WHERE id = ?`,
      [propertyId]
    );

    return res.json({
      ok: true,
      message: 'Publicación reenviada para revisión',
      review_status: 'pending'
    });

  } catch (e) {
    console.error('[POST /properties/:id/resubmit] error', e);
    return res.status(500).json({ error: 'Error al reenviar la publicación' });
  }
});

module.exports = router;
