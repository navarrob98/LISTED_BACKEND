const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const cloudinary = require('../cldnry');
const { sendPushToUser } = require('../utils/helpers');
const {
  getCached, setCache, waitForNominatimSlot,
  TTL_24H, TTL_7D,
  autocompleteKey, geocodeKey, reverseGeocodeKey, detailsKey,
} = require('../utils/geoCache');

// POST /api/buying-power
router.post('/api/buying-power', authenticateToken, (req, res) => {
  const {
    user_id,
    annual_income,
    down_payment,
    monthly_debt,
    monthly_target,
    annual_interest_rate, // DECIMAL(6,4) guardado como decimal (ej. 0.10 para 10%)
    loan_years,
    suggested_price       // DECIMAL(22,2)
  } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id es requerido' });
  }
  if (Number(user_id) !== req.user.id) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  if (suggested_price === undefined || suggested_price === null) {
    return res.status(400).json({ error: 'suggested_price es requerido' });
  }

  const sql = `
    INSERT INTO buying_power
      (user_id, annual_income, down_payment, monthly_debt, monthly_target, annual_interest_rate, loan_years, suggested_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      annual_income       = VALUES(annual_income),
      down_payment        = VALUES(down_payment),
      monthly_debt        = VALUES(monthly_debt),
      monthly_target      = VALUES(monthly_target),
      annual_interest_rate= VALUES(annual_interest_rate),
      loan_years          = VALUES(loan_years),
      suggested_price     = VALUES(suggested_price),
      updated_at          = CURRENT_TIMESTAMP
  `;

  const params = [
    user_id,
    annual_income ?? null,
    down_payment ?? null,
    monthly_debt ?? null,
    monthly_target ?? null,
    annual_interest_rate ?? null,
    loan_years ?? null,
    suggested_price ?? null,
  ];

  pool.query(sql, params, (err) => {
    if (err) {
      console.error('Error guardando buying power:', err);
      return res.status(500).json({ error: 'Error guardando datos' });
    }
    res.json({ ok: true, message: 'Buying power guardado o actualizado' });
  });
});

// GET /api/buying-power/:user_id
router.get('/api/buying-power/:user_id', authenticateToken, (req, res) => {
  const { user_id } = req.params;
  if (Number(user_id) !== req.user.id) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const sql = `
    SELECT *
    FROM buying_power
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `;

  pool.query(sql, [user_id], (err, rows) => {
    if (err) {
      console.error('Error consultando buying power:', err);
      return res.status(500).json({ error: 'Error consultando datos' });
    }
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  });
});

// POST /api/push/register
router.post('/api/push/register', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { expoPushToken, platform, deviceId } = req.body || {};

  if (!expoPushToken || !deviceId) {
    return res.status(400).json({ ok: false, error: 'expoPushToken y deviceId son requeridos' });
  }

  try {
    // 1) Desactiva todos los devices del usuario (garantiza "solo el actual")
    await pool.promise().query(
      `UPDATE user_push_tokens SET is_active=0, updated_at=NOW() WHERE user_id=?`,
      [userId]
    );

    // 2) UPSERT por device_id (mismo teléfono no crea filas nuevas)
    await pool.promise().query(
      `
      INSERT INTO user_push_tokens (user_id, device_id, expo_push_token, platform, is_active, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, NOW(), NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        expo_push_token = VALUES(expo_push_token),
        platform = VALUES(platform),
        is_active = 1,
        last_seen_at = NOW(),
        updated_at = NOW()
      `,
      [userId, deviceId, expoPushToken, platform || null]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[push/register] error', e);
    return res.status(500).json({ ok: false });
  }
});

// POST /api/push/logout
router.post('/api/push/logout', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false });

  await pool.promise().query(
    `UPDATE user_push_tokens SET is_active=0, updated_at=NOW() WHERE user_id=? AND device_id=?`,
    [userId, deviceId]
  );

  res.json({ ok: true });
});

// POST /api/tenant-profile
router.post('/api/tenant-profile', authenticateToken, (req, res) => {
  const user_id = req.user.id;
  const {
    preferred_move_date,
    preferred_contract_duration,
    estimated_monthly_income,
    has_guarantor,
    guarantor_has_own_home,
    family_size,
    has_pets,
    pets_count
  } = req.body;

  const query = `
    INSERT INTO tenant_profiles (
      user_id, preferred_move_date, preferred_contract_duration,
      estimated_monthly_income, has_guarantor, guarantor_has_own_home,
      family_size, has_pets, pets_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      preferred_move_date = VALUES(preferred_move_date),
      preferred_contract_duration = VALUES(preferred_contract_duration),
      estimated_monthly_income = VALUES(estimated_monthly_income),
      has_guarantor = VALUES(has_guarantor),
      guarantor_has_own_home = VALUES(guarantor_has_own_home),
      family_size = VALUES(family_size),
      has_pets = VALUES(has_pets),
      pets_count = VALUES(pets_count),
      updated_at = CURRENT_TIMESTAMP
  `;

  pool.query(query, [
    user_id,
    preferred_move_date || null,
    preferred_contract_duration || null,
    estimated_monthly_income || null,
    has_guarantor ? 1 : 0,
    guarantor_has_own_home ? 1 : 0,
    family_size || null,
    has_pets ? 1 : 0,
    pets_count || null
  ], (err, result) => {
    if (err) {
      console.error('Error guardando tenant profile:', err);
      return res.status(500).json({ error: 'Error guardando perfil de rentero' });
    }
    res.json({ ok: true, message: 'Perfil guardado correctamente' });
  });
});

// GET /api/tenant-profile/:user_id
router.get('/api/tenant-profile/:user_id', authenticateToken, (req, res) => {
  const { user_id } = req.params;
  if (Number(user_id) !== req.user.id) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  pool.query(
    'SELECT * FROM tenant_profiles WHERE user_id = ? LIMIT 1',
    [user_id],
    (err, results) => {
      if (err) {
        console.error('Error consultando tenant profile:', err);
        return res.status(500).json({ error: 'Error consultando perfil' });
      }
      if (!results.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      console.log('results: ', results);
      res.json(results[0]);
    }
  );
});

// PUT /api/tenant-profile/:id
router.put('/api/tenant-profile/:id', authenticateToken, (req, res) => {
  const { id } = req.params;  // Este es el id del registro en tenant_profiles
  const user_id = req.user.id;
  const {
    preferred_move_date,
    preferred_contract_duration,
    estimated_monthly_income,
    has_guarantor,
    guarantor_has_own_home,
    family_size,
    has_pets,
    pets_count
  } = req.body;

  // Junta solo los campos enviados
  const updates = [];
  const values = [];

  if (preferred_move_date !== undefined) {
    updates.push('preferred_move_date = ?');
    values.push(preferred_move_date || null);
  }
  if (preferred_contract_duration !== undefined) {
    updates.push('preferred_contract_duration = ?');
    values.push(preferred_contract_duration || null);
  }
  if (estimated_monthly_income !== undefined) {
    updates.push('estimated_monthly_income = ?');
    values.push(estimated_monthly_income || null);
  }
  if (has_guarantor !== undefined) {
    updates.push('has_guarantor = ?');
    values.push(has_guarantor ? 1 : 0);
  }
  if (guarantor_has_own_home !== undefined) {
    updates.push('guarantor_has_own_home = ?');
    values.push(guarantor_has_own_home ? 1 : 0);
  }
  if (family_size !== undefined) {
    updates.push('family_size = ?');
    values.push(family_size || null);
  }
  if (has_pets !== undefined) {
    updates.push('has_pets = ?');
    values.push(has_pets ? 1 : 0);
  }
  if (pets_count !== undefined) {
    updates.push('pets_count = ?');
    values.push(pets_count || null);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No se enviaron campos para actualizar' });
  }

  values.push(id, user_id);

  // Verifica que el perfil pertenezca al usuario autenticado
  const query = `
    UPDATE tenant_profiles
    SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `;

  pool.query(query, values, (err, result) => {
    if (err) {
      console.error('Error actualizando tenant profile:', err);
      return res.status(500).json({ error: 'Error actualizando perfil de rentero' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Perfil de rentero no encontrado o no autorizado' });
    }
    res.json({ ok: true, message: 'Perfil actualizado correctamente' });
  });
});

const NOMINATIM_UA = 'listed-app/1.0 (support@listed.com.mx)';

// GET /api/places/autocomplete → Photon API
router.get('/api/places/autocomplete', async (req, res) => {
  try {
    const input = req.query.input?.toString().trim() || '';
    if (!input) return res.status(400).json({ error: 'input requerido' });

    const cacheKey = autocompleteKey('mx', input);
    const cached = await getCached(cacheKey);
    if (cached) return res.json(cached);

    const url = new URL('https://photon.komoot.io/api');
    url.searchParams.set('q', input);
    url.searchParams.set('limit', '10');
    url.searchParams.set('lang', 'default');
    url.searchParams.set('lat', '23.63');
    url.searchParams.set('lon', '-102.55');

    const r = await fetch(url);
    const data = await r.json();

    const predictions = (data.features || [])
      .filter((f) => {
        const c = (f.properties?.country || '').toLowerCase();
        return c.includes('mexico') || c.includes('méxico');
      })
      .slice(0, 5)
      .map((f) => {
        const p = f.properties;
        const typeChar = (p.osm_type || 'N')[0].toUpperCase();
        const placeId = `osm:${typeChar}${p.osm_id}`;
        const parts = [p.name, p.street, p.city, p.state].filter(Boolean);
        return { place_id: placeId, description: parts.join(', ') };
      });

    const result = { predictions };
    await setCache(cacheKey, result, TTL_24H);
    return res.json(result);
  } catch (e) {
    console.error('[places/autocomplete] error', e);
    res.status(500).json({ error: 'fail' });
  }
});

// GET /api/places/details → Nominatim /lookup
router.get('/api/places/details', async (req, res) => {
  try {
    const place_id = req.query.place_id?.toString();
    if (!place_id) return res.status(400).json({ error: 'place_id requerido' });

    const cacheKey = detailsKey(place_id);
    const cached = await getCached(cacheKey);
    if (cached) return res.json(cached);

    // Parse osm:N12345 → N12345
    const m = place_id.match(/^osm:([NWR])(\d+)$/i);
    if (!m) return res.status(400).json({ error: 'place_id inválido' });
    const osmIds = `${m[1].toUpperCase()}${m[2]}`;

    await waitForNominatimSlot();
    const url = new URL('https://nominatim.openstreetmap.org/lookup');
    url.searchParams.set('osm_ids', osmIds);
    url.searchParams.set('format', 'json');
    url.searchParams.set('accept-language', 'es');

    const r = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
    const data = await r.json();

    if (!data.length) return res.json({ result: null });

    const item = data[0];
    const result = {
      result: {
        geometry: { location: { lat: parseFloat(item.lat), lng: parseFloat(item.lon) } },
        formatted_address: item.display_name,
      },
    };

    await setCache(cacheKey, result, TTL_7D);
    res.json(result);
  } catch (e) {
    console.error('[places/details]', e);
    res.status(500).json({ error: 'fail' });
  }
});

// GET /api/places/geocode → Nominatim /search
router.get('/api/places/geocode', async (req, res) => {
  try {
    const address = req.query.address?.toString().trim() || '';
    const country = (req.query.country || 'MX').toString().toLowerCase();
    if (!address) return res.status(400).json({ error: 'address requerido' });

    const cacheKey = geocodeKey(country, address);
    const cached = await getCached(cacheKey);
    if (cached) return res.json(cached);

    await waitForNominatimSlot();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', address);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', country);

    const r = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
    const data = await r.json();

    if (!data.length) {
      const noResult = { status: 'ZERO_RESULTS', results: [] };
      await setCache(cacheKey, noResult, TTL_24H);
      return res.json(noResult);
    }

    const item = data[0];
    const result = {
      status: 'OK',
      result: {
        formatted_address: item.display_name,
        geometry: { location: { lat: parseFloat(item.lat), lng: parseFloat(item.lon) } },
      },
    };

    await setCache(cacheKey, result, TTL_7D);
    res.json(result);
  } catch (e) {
    console.error('[places/geocode]', e);
    res.status(500).json({ error: 'fail' });
  }
});

// GET /api/places/reverse-geocode → Nominatim /reverse
router.get('/api/places/reverse-geocode', async (req, res) => {
  try {
    const lat = req.query.lat?.toString();
    const lng = req.query.lng?.toString();
    if (!lat || !lng) return res.status(400).json({ error: 'lat y lng requeridos' });

    const cacheKey = reverseGeocodeKey(lat, lng);
    const cached = await getCached(cacheKey);
    if (cached) return res.json(cached);

    await waitForNominatimSlot();
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat', lat);
    url.searchParams.set('lon', lng);
    url.searchParams.set('format', 'json');
    url.searchParams.set('accept-language', 'es');

    const r = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
    const data = await r.json();

    if (data.error) {
      return res.json({ status: 'ZERO_RESULTS', results: [] });
    }

    const result = { status: 'OK', result: { formatted_address: data.display_name } };
    await setCache(cacheKey, result, TTL_7D);
    res.json(result);
  } catch (e) {
    console.error('[places/reverse-geocode]', e);
    res.status(500).json({ error: 'fail' });
  }
});

// POST /cloudinary/sign-upload
router.post('/cloudinary/sign-upload', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const {
    kind = 'public',
    resource_type = 'image',
    folder,
    tags = [],
    context = {},              // { file_name: '...' } u otras claves
    use_filename = true,       // importantísimo: el mismo valor se firmará
    unique_filename = true,    // idem
  } = req.body || {};

  const upload_preset =
    kind === 'public'
      ? process.env.CLD_PRESET_PUBLIC      // preset con access_mode=public
      : process.env.CLD_PRESET_PRIVATE;    // preset con access_mode=authenticated
  if (!upload_preset) {
    return res.status(500).json({ error: 'Falta configurar CLD_PRESET_PRIVATE' });
  }

  const baseFolder = process.env.CLD_BASE_FOLDER || 'listed';
  const envFolder = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  const rawFolder = folder || `${baseFolder}/${envFolder}/${resource_type}/u_${userId}`;
  const resolvedFolder = String(rawFolder);

  const ctxEntries = Object.entries(context || {}).map(([k, v]) => [String(k), String(v ?? '')]);
  ctxEntries.sort(([a], [b]) => a.localeCompare(b));
  const contextStr = ctxEntries.length ? ctxEntries.map(([k, v]) => `${k}=${v}`).join('|') : '';

  const tagsArr = (Array.isArray(tags) ? tags : []).map(String);
  const tagsStr = tagsArr.length ? tagsArr.join(',') : '';

  const timestamp = Math.floor(Date.now() / 1000);

  const toSign = {
    timestamp,
    upload_preset,
    folder: resolvedFolder,
    ...(tagsStr ? { tags: tagsStr } : {}),
    ...(contextStr ? { context: contextStr } : {}),
    use_filename: use_filename ? 'true' : 'false',
    unique_filename: unique_filename ? 'true' : 'false',
  };

  const signature = cloudinary.utils.api_sign_request(toSign, process.env.CLOUDINARY_API_SECRET);

  return res.json({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    resource_type,
    upload_preset,
    timestamp,
    signature,
    folder: resolvedFolder,
    signed_context: contextStr || undefined,
    signed_tags: tagsStr || undefined,
    use_filename: !!use_filename,
    unique_filename: !!unique_filename,
  });
});

// POST /cloudinary/delete
router.post('/cloudinary/delete', authenticateToken, async (req, res) => {
  try {
    const { public_id, resource_type = 'raw' } = req.body;

    if (!public_id) {
      return res.status(400).json({ error: 'public_id es requerido' });
    }

    const userId = req.user.id;
    const baseFolder = process.env.CLD_BASE_FOLDER || 'listed';
    const envFolder = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

    // Validar que el public_id pertenezca al usuario
    const expectedPrefix = `${baseFolder}/${envFolder}`;
    if (!public_id.startsWith(expectedPrefix) || !public_id.includes(`u_${userId}`)) {
      console.warn('[POST /cloudinary/delete] Permiso denegado', { userId, public_id });
      return res.status(403).json({ error: 'No tienes permiso para eliminar este archivo' });
    }

    console.log('[POST /cloudinary/delete] Eliminando archivo:', public_id);
    console.log('[POST /cloudinary/delete] Resource type:', resource_type);

    // Eliminar de Cloudinary (sin modificar el public_id)
    const result = await cloudinary.uploader.destroy(public_id, {
      resource_type: resource_type,
      invalidate: true,
    });

    console.log('[POST /cloudinary/delete] Resultado:', result);

    if (result.result === 'ok' || result.result === 'not found') {
      return res.json({
        ok: true,
        result: result.result,
        message: result.result === 'ok' ? 'Archivo eliminado correctamente' : 'Archivo no encontrado'
      });
    } else {
      return res.status(500).json({
        error: 'No se pudo eliminar el archivo',
        cloudinary_result: result
      });
    }

  } catch (e) {
    console.error('[POST /cloudinary/delete] error:', e);
    res.status(500).json({ error: 'Error al eliminar archivo de Cloudinary' });
  }
});

// POST /api/reports
router.post('/api/reports', authenticateToken, async (req, res) => {
  try {
    const reporterId = req.user.id;
    const { report_type, reported_property_id, reported_agent_id, reason, description } = req.body;

    if (!report_type || !reason || !description?.trim()) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    if (report_type === 'property' && !reported_property_id) {
      return res.status(400).json({ error: 'Debes especificar la propiedad a reportar' });
    }

    if (report_type === 'agent' && !reported_agent_id) {
      return res.status(400).json({ error: 'Debes especificar el agente a reportar' });
    }

    // Validar que no se reporte a sí mismo
    if (report_type === 'agent' && String(reported_agent_id) === String(reporterId)) {
      return res.status(400).json({ error: 'No puedes reportarte a ti mismo' });
    }

    // Validar que la propiedad existe
    if (report_type === 'property') {
      const [propRows] = await pool.promise().query(
        'SELECT id FROM properties WHERE id = ? LIMIT 1',
        [reported_property_id]
      );
      if (!propRows.length) {
        return res.status(404).json({ error: 'Propiedad no encontrada' });
      }
    }

    // Validar que el agente existe
    if (report_type === 'agent') {
      const [agentRows] = await pool.promise().query(
        'SELECT id FROM users WHERE id = ? LIMIT 1',
        [reported_agent_id]
      );
      if (!agentRows.length) {
        return res.status(404).json({ error: 'Agente no encontrado' });
      }
    }

    // Crear el reporte
    const [result] = await pool.promise().query(
      `INSERT INTO reports (reporter_id, report_type, reported_property_id, reported_agent_id, reason, description, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        reporterId,
        report_type,
        report_type === 'property' ? reported_property_id : null,
        report_type === 'agent' ? reported_agent_id : null,
        reason,
        description.trim()
      ]
    );

    res.status(201).json({
      ok: true,
      reportId: result.insertId,
      message: 'Reporte enviado correctamente. Será revisado por nuestro equipo.'
    });
  } catch (e) {
    console.error('[POST /api/reports] error', e);
    res.status(500).json({ error: 'Error al crear el reporte' });
  }
});

// GET /api/infonavit/:userId
router.get('/api/infonavit/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    // Verificar que el usuario solo acceda a sus datos
    if (req.user.id !== parseInt(userId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const [rows] = await pool.promise().query(
      'SELECT * FROM infonavit_calculations WHERE user_id = ?',
      [userId]
    );

    if (!rows || rows.length === 0) {
      return res.json(null);
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching infonavit data:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/infonavit
router.post('/api/infonavit', authenticateToken, async (req, res) => {
  try {
    const {
      user_id,
      edad,
      salario_mensual,
      bimestres_cotizados,
      saldo_subcuenta,
      tipo_contrato,
      plazo_anios,
      tipo_credito,
      puntos_estimados,
      monto_credito_estimado,
      tasa_interes,
      pago_mensual_estimado,
    } = req.body;

    // Verificar que el usuario solo guarde sus datos
    if (req.user.id !== parseInt(user_id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Validaciones básicas
    if (!edad || !salario_mensual) {
      return res.status(400).json({ error: 'Edad y salario son requeridos' });
    }

    // UPSERT - insertar o actualizar si ya existe
    const query = `
      INSERT INTO infonavit_calculations (
        user_id, edad, salario_mensual, bimestres_cotizados,
        saldo_subcuenta, tipo_contrato, plazo_anios, tipo_credito,
        puntos_estimados, monto_credito_estimado, tasa_interes, pago_mensual_estimado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        edad = VALUES(edad),
        salario_mensual = VALUES(salario_mensual),
        bimestres_cotizados = VALUES(bimestres_cotizados),
        saldo_subcuenta = VALUES(saldo_subcuenta),
        tipo_contrato = VALUES(tipo_contrato),
        plazo_anios = VALUES(plazo_anios),
        tipo_credito = VALUES(tipo_credito),
        puntos_estimados = VALUES(puntos_estimados),
        monto_credito_estimado = VALUES(monto_credito_estimado),
        tasa_interes = VALUES(tasa_interes),
        pago_mensual_estimado = VALUES(pago_mensual_estimado),
        updated_at = CURRENT_TIMESTAMP
    `;

    await pool.promise().query(query, [
      user_id,
      edad,
      salario_mensual,
      bimestres_cotizados || 4,
      saldo_subcuenta || 0,
      tipo_contrato || 'permanente',
      plazo_anios || 20,
      tipo_credito || 'individual',
      puntos_estimados,
      monto_credito_estimado,
      tasa_interes,
      pago_mensual_estimado,
    ]);

    res.json({ success: true, message: 'Datos guardados correctamente' });
  } catch (error) {
    console.error('Error saving infonavit data:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
