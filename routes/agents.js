const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const bcrypt = require('bcrypt');
const { gen6, sendVerificationEmail } = require('../utils/helpers');

// POST /agents/register
router.post('/agents/register', async (req, res) => {
  const {
    name,
    last_name,
    email,
    password,
    phone,
    work_start,
    work_end,
    agent_type,         // 'brokerage' | 'individual' | 'seller'
    brokerage_name,     // opcional si agent_type === 'brokerage'
    cities,             // array de strings

    // NUEVO:
    credential          // { type, state, credential_id, issuer, verification_url } | null
  } = req.body;

  if (!name || !last_name || !email || !password || !work_start || !work_end) {
    return res.status(400).json({ error: 'Faltan datos obligatorios (incluyendo horario laboral).' });
  }

  // valida HH:mm
  const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!hhmm.test(work_start) || !hhmm.test(work_end)) {
    return res.status(400).json({ error: 'Horario laboral en formato inválido. Usa HH:mm.' });
  }

  const ALLOWED_TYPES = new Set(['brokerage', 'individual', 'seller', 'regular']);
  const finalAgentType = ALLOWED_TYPES.has(agent_type) ? agent_type : 'individual';

  // normaliza ciudades
  let citiesArr = Array.isArray(cities) ? cities : [];
  citiesArr = [...new Set((citiesArr || [])
    .map(c => (typeof c === 'string' ? c.trim() : ''))
    .filter(Boolean))]
    .slice(0, 30)
    .map(c => c.slice(0, 120));

  // ===== Validación / normalización de credential =====
  const isVerifiableAgent = ['brokerage', 'individual'].includes(finalAgentType);
  const allowedCredTypes = new Set(['state_registry', 'ampi_ccie', 'other_verifiable']);

  let normalizedCredential = null;

  if (credential && typeof credential === 'object') {
    const type = String(credential.type || '').trim();
    const state = credential.state != null ? String(credential.state).trim() : null;
    const credential_id = String(credential.credential_id || '').trim();
    const issuer = credential.issuer != null ? String(credential.issuer).trim() : null;
    const verification_url = credential.verification_url != null ? String(credential.verification_url).trim() : null;

    if (!allowedCredTypes.has(type)) {
      return res.status(400).json({ error: 'Tipo de credencial inválido.' });
    }
    if (!credential_id) {
      return res.status(400).json({ error: 'Falta el folio/matrícula/código de la credencial.' });
    }

    // Reglas por tipo
    if (type === 'state_registry') {
      if (!state || !/^MX-[A-Z]{3}$/.test(state)) {
        return res.status(400).json({ error: 'Estado inválido para registro estatal (usa formato MX-XXX).' });
      }
    }

    if (type === 'other_verifiable') {
      if (!issuer) {
        return res.status(400).json({ error: 'Falta el emisor para "Otro registro verificable".' });
      }
      if (!verification_url) {
        return res.status(400).json({ error: 'Falta el enlace público de verificación.' });
      }
    }

    normalizedCredential = {
      type,
      state: type === 'state_registry' ? state : null,
      credential_id: credential_id.slice(0, 120),
      issuer: issuer ? issuer.slice(0, 120) : null,
      verification_url: verification_url ? verification_url.slice(0, 512) : null,
    };
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const minutes = Number(process.env.VERIFICATION_MINUTES || 15);
    const code = gen6();                                // 6 dígitos
    const expires = new Date(Date.now() + minutes * 60 * 1000);

    // Verificación: solo aplica si es agente verificable y mandó credencial
    const agentVerificationStatus =
      (isVerifiableAgent && normalizedCredential) ? 'pending' : 'not_required';

    // Usamos conexión para transacción
    pool.getConnection(async (connErr, conn) => {
      if (connErr) {
        console.error('[agents/register] getConnection error', connErr);
        return res.status(500).json({ error: 'Error interno del servidor.' });
      }

      const rollbackAndRelease = (status, payload) => {
        conn.rollback(() => {
          conn.release();
          res.status(status).json(payload);
        });
      };

      try {
        await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));

        const sqlUser = `
          INSERT INTO users
            (name, last_name, email, password, phone,
             work_start, work_end,
             agent_type, brokerage_name, cities,
             email_verified, email_verif_code, email_verif_expires,
             agent_verification_status)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `;

        const paramsUser = [
          name,
          last_name,
          email,
          hashedPassword,
          phone || null,
          work_start,
          work_end,
          finalAgentType,
          finalAgentType === 'brokerage' ? (brokerage_name || null) : null,
          citiesArr.length ? JSON.stringify(citiesArr) : null,
          code,
          expires,
          agentVerificationStatus
        ];

        const userResult = await new Promise((resolve, reject) => {
          conn.query(sqlUser, paramsUser, (err, result) => err ? reject(err) : resolve(result));
        });

        const userId = userResult.insertId;

        // Insert credencial si aplica (solo brokerage/individual)
        if (isVerifiableAgent && normalizedCredential) {
          const sqlCred = `
            INSERT INTO agent_credentials
              (user_id, type, state, credential_id, issuer, verification_url)
            VALUES
              (?, ?, ?, ?, ?, ?)
          `;
          const paramsCred = [
            userId,
            normalizedCredential.type,
            normalizedCredential.state,
            normalizedCredential.credential_id,
            normalizedCredential.issuer,
            normalizedCredential.verification_url
          ];

          await new Promise((resolve, reject) => {
            conn.query(sqlCred, paramsCred, (err, result) => err ? reject(err) : resolve(result));
          });
        }

        await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
        conn.release();

        // Enviar código (fuera de la transacción)
        try {
          await sendVerificationEmail(email, code);
        } catch (mailErr) {
          console.error('[agents/register] mail error', mailErr);
        }

        return res.status(201).json({
          ok: true,
          need_verification: true,
          email,
          user_id: userId
        });

      } catch (err) {
        console.error('[agents/register] tx error', err);

        // Duplicado email
        if (err && err.code === 'ER_DUP_ENTRY') {
          return rollbackAndRelease(400, { error: 'El email ya existe' });
        }

        return rollbackAndRelease(500, { error: 'Error al registrar el usuario.' });
      }
    });

  } catch (error) {
    console.error('[agents/register] fatal', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// PUT /agents/:id/work-schedule
router.put('/agents/:id/work-schedule', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { work_start, work_end } = req.body;

  if (!work_start || !work_end) {
    return res.status(400).json({ error: 'Debes enviar ambos campos: work_start y work_end.' });
  }

  const regex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!regex.test(work_start) || !regex.test(work_end)) {
    return res.status(400).json({ error: 'Horario laboral en formato inválido. Usa HH:mm.' });
  }

  if (Number(id) !== req.user.id) {
    return res.status(403).json({ error: 'No autorizado.' });
  }

  pool.query(
    `UPDATE users
     SET work_start = ?, work_end = ?
     WHERE id = ?
       AND agent_type IN ('brokerage','individual','seller','regular')`,
    [work_start, work_end, Number(id)],
    (err, result) => {
      if (err) return res.status(500).json({ error: 'Error actualizando horario.' });
      if (!result.affectedRows) return res.status(404).json({ error: 'No se actualizó.' });
      res.json({ ok: true });
    }
  );
});

// GET /agents/me/credentials/latest
router.get('/agents/me/credentials/latest', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.promise().query(
      `SELECT id, type, state, credential_id, issuer, verification_url, certificate_url, certificate_public_id, created_at, updated_at
       FROM agent_credentials
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    );
    res.json({ credential: rows?.[0] || null });
  } catch (e) {
    console.error('[agents/me/credentials/latest] error', e);
    res.status(500).json({ error: 'No se pudo cargar credencial' });
  }
});

// PUT /agents/me/credentials
router.put('/agents/me/credentials', authenticateToken, async (req, res) => {
  try {
    const uid = req.user.id;

    const {
      type,            // 'state_registry' | 'ampi_ccie' | 'other_verifiable'
      state,           // 'MX-BCN' etc (solo state_registry)
      credential_id,   // folio/matrícula
      issuer,          // opcional, requerido en other_verifiable
      verification_url // opcional, requerido en other_verifiable
    } = req.body || {};

    // 1) usuario y tipo
    const [uRows] = await pool.promise().query(
      `SELECT id, agent_type, agent_verification_status
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [uid]
    );
    if (!uRows?.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const u = uRows[0];
    const isVerifiableAgent = ['brokerage', 'individual'].includes(u.agent_type);
    if (!isVerifiableAgent) {
      return res.status(403).json({ error: 'Este usuario no puede registrar credenciales' });
    }

    // 2) validaciones (idénticas a registro)
    const allowedCredTypes = new Set(['state_registry', 'ampi_ccie', 'other_verifiable']);
    const t = String(type || '').trim();
    if (!allowedCredTypes.has(t)) return res.status(400).json({ error: 'Tipo de credencial inválido.' });

    const cid = String(credential_id || '').trim();
    if (!cid) return res.status(400).json({ error: 'Falta el folio/matrícula/código de la credencial.' });

    const st = state != null ? String(state).trim() : null;
    const iss = issuer != null ? String(issuer).trim() : null;
    const url = verification_url != null ? String(verification_url).trim() : null;

    if (t === 'state_registry') {
      if (!st || !/^MX-[A-Z]{3}$/.test(st)) {
        return res.status(400).json({ error: 'Estado inválido para registro estatal (usa formato MX-XXX).' });
      }
    }

    if (t === 'other_verifiable') {
      if (!iss) return res.status(400).json({ error: 'Falta el emisor para "Otro registro verificable".' });
      if (!url) return res.status(400).json({ error: 'Falta el enlace público de verificación.' });
    }

    // 3) comparar con la última credencial (para decidir resetear verificación)
    const [cRows] = await pool.promise().query(
      `SELECT id, type, state, credential_id, issuer, verification_url, certificate_url
       FROM agent_credentials
       WHERE user_id=?
       ORDER BY id DESC
       LIMIT 1`,
      [uid]
    );

    const prev = cRows?.[0] || null;

    const normalized = {
      type: t,
      state: t === 'state_registry' ? st : null,
      credential_id: cid.slice(0, 120),
      issuer: iss ? iss.slice(0, 120) : null,
      verification_url: url ? url.slice(0, 512) : null,
    };

    const changed =
      !prev ||
      String(prev.type || '') !== normalized.type ||
      String(prev.state || '') !== String(normalized.state || '') ||
      String(prev.credential_id || '') !== normalized.credential_id ||
      String(prev.issuer || '') !== String(normalized.issuer || '') ||
      String(prev.verification_url || '') !== String(normalized.verification_url || '');

    // 4) transacción: UPDATE si existe, INSERT si es nuevo + reset status si cambió
    const cxn = await pool.promise().getConnection();
    try {
      await cxn.beginTransaction();

      if (prev) {
        await cxn.query(
          `UPDATE agent_credentials
           SET type = ?,
               state = ?,
               credential_id = ?,
               issuer = ?,
               verification_url = ?,
               updated_at = NOW()
           WHERE id = ?`,
          [
            normalized.type,
            normalized.state,
            normalized.credential_id,
            normalized.issuer,
            normalized.verification_url,
            prev.id
          ]
        );
        console.log(`[PUT /agents/me/credentials] Credencial actualizada para usuario ${uid}`);
      } else {
        await cxn.query(
          `INSERT INTO agent_credentials (user_id, type, state, credential_id, issuer, verification_url)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uid,
            normalized.type,
            normalized.state,
            normalized.credential_id,
            normalized.issuer,
            normalized.verification_url,
          ]
        );
        console.log(`[PUT /agents/me/credentials] Nueva credencial creada para usuario ${uid}`);
      }

      if (changed) {
        await cxn.query(
          `UPDATE users
           SET agent_verification_status='pending',
               agent_rejection_reason=NULL,
               agent_verified_at=NULL,
               agent_verified_by=NULL
           WHERE id=?`,
          [uid]
        );
      }

      await cxn.commit();
      cxn.release();

      return res.json({ ok: true, credential: normalized, changed });
    } catch (e) {
      await cxn.rollback();
      cxn.release();
      console.error('[PUT /agents/me/credentials] tx error', e);
      return res.status(500).json({ error: 'No se pudo actualizar credencial' });
    }
  } catch (e) {
    console.error('[PUT /agents/me/credentials] error', e);
    return res.status(500).json({ error: 'Error de servidor' });
  }
});

// POST /agents/update-credential-certificate
router.post('/agents/update-credential-certificate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { certificate_url, certificate_public_id } = req.body;

    if (!certificate_url || typeof certificate_url !== 'string') {
      return res.status(400).json({ error: 'URL del certificado inválida' });
    }

    // Validar que sea una URL de Cloudinary válida
    if (!certificate_url.includes('cloudinary.com')) {
      return res.status(400).json({ error: 'Solo se permiten URLs de Cloudinary' });
    }

    // Validar que el archivo esté en la carpeta correcta del usuario
    const expectedFolder = `listed/${process.env.NODE_ENV === 'production' ? 'prod' : 'dev'}/raw/u_${userId}`;

    if (!certificate_url.includes(expectedFolder)) {
      console.warn('[POST /agents/update-credential-certificate] archivo en ruta sospechosa', {
        userId,
        certificate_url,
        expectedFolder
      });
    }

    // Verificar que el usuario tiene credenciales y es un agente verificable
    const [userRows] = await pool.promise().query(
      `SELECT id, agent_type FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!userRows || !userRows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userRows[0];
    const isVerifiableAgent = ['brokerage', 'individual'].includes(user.agent_type);

    if (!isVerifiableAgent) {
      return res.status(403).json({ error: 'Solo agentes verificables pueden subir certificados' });
    }

    // Buscar la credencial más reciente del usuario
    const [credRows] = await pool.promise().query(
      `SELECT id FROM agent_credentials
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    );

    if (!credRows || !credRows.length) {
      return res.status(404).json({ error: 'No se encontró credencial para este usuario' });
    }

    const credentialId = credRows[0].id;

    // Actualizar el certificate_url Y certificate_public_id en la credencial
    await pool.promise().query(
      `UPDATE agent_credentials
       SET certificate_url = ?,
           certificate_public_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [certificate_url, certificate_public_id || null, credentialId]
    );

    res.json({
      ok: true,
      certificate_url,
      certificate_public_id,
      message: 'Certificado actualizado correctamente'
    });
  } catch (e) {
    console.error('[POST /agents/update-credential-certificate] error', e);
    res.status(500).json({ error: 'Error al actualizar certificado' });
  }
});

// GET /agents/:id
router.get('/agents/:id', (req, res) => {
  const { id } = req.params;

  pool.query(
    `SELECT id, name, last_name, phone, work_start, work_end, agent_verification_status, profile_photo
     FROM users
     WHERE id = ?
       AND agent_type IN ('brokerage','individual')
     LIMIT 1`,
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error al consultar el agente.' });
      if (!results || !results.length) return res.status(404).json({ error: 'Agente no encontrado.' });
      return res.json(results[0]);
    }
  );
});

// POST /agents/me/resubmit-verification
router.post('/agents/me/resubmit-verification', authenticateToken, async (req, res) => {
  try {
    const uid = req.user.id;

    const [rows] = await pool.promise().query(
      `SELECT agent_type, agent_verification_status
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [uid]
    );

    if (!rows?.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const u = rows[0];
    const isAgent = ['brokerage', 'individual'].includes(u.agent_type);

    if (!isAgent) return res.status(403).json({ error: 'No aplica para este tipo de usuario' });

    if (u.agent_verification_status !== 'rejected') {
      return res.status(400).json({ error: 'No puedes reenviar en este estado' });
    }

    const [cRows] = await pool.promise().query(
      `SELECT credential_id
       FROM agent_credentials
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [uid]
    );

    const credId = cRows?.[0]?.credential_id ? String(cRows[0].credential_id).trim() : '';
    if (!credId) return res.status(400).json({ error: 'Falta credencial para verificación' });

    await pool.promise().query(
      `UPDATE users
       SET agent_verification_status = 'pending',
           agent_rejection_reason = NULL,
           agent_verified_at = NULL,
           agent_verified_by = NULL
       WHERE id = ?`,
      [uid]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[resubmit-verification] error', e);
    return res.status(500).json({ error: 'Error de servidor' });
  }
});

module.exports = router;
