const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const helpers = require('../utils/helpers');
const {
  gen6,
  sendVerificationEmail,
  sendResetPasswordEmail,
  buildResetWebUrl,
  issueToken,
  forgotPasswordIpLimiter,
  forgotPasswordEmailCooldown,
  createEmailCooldown,
  GOOGLE_CLIENT_IDS,
} = helpers;

const googleClient = new OAuth2Client();

// POST /users/register
router.post('/users/register', async (req, res) => {
  const { name, last_name, email, password } = req.body;
  if (!name || !last_name || !email || !password) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    // IMPORTANTE: incluye columnas que tu tabla exige o que son NOT NULL
    const sql = `
      INSERT INTO users
        (name, last_name, email, password, agent_type, email_verified, work_start, work_end)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `;
    pool.query(
      sql,
      [name, last_name, email, hashedPassword, 'regular', null, null],
      async (err, result) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'El correo ya está registrado.' });
          }
          console.error('[users/register] insert error', err);
          return res.status(500).json({ error: 'Error al registrar el usuario.' });
        }

        const userId = result.insertId;
        const code = gen6();
        const expires = new Date(Date.now() + (Number(process.env.VERIFICATION_MINUTES || 15) * 60 * 1000));

        pool.query(
          'UPDATE users SET email_verif_code = ?, email_verif_expires = ? WHERE id = ?',
          [code, expires, userId],
          async (uErr) => {
            if (uErr) {
              console.error('[users/register] set code error', uErr);
              return res.status(500).json({ error: 'Error preparando verificación.' });
            }

            try {
              await sendVerificationEmail(email, code);
            } catch (mailErr) {
              console.error('[users/register] mail error', mailErr);
              return res.status(500).json({ error: 'No se pudo enviar el correo de verificación.' });
            }

            // No iniciamos sesión todavía. Exige verificación.
            return res.status(201).json({
              message: 'Usuario registrado. Se envió un código de verificación a tu correo.',
              need_verification: true,
              email,
              user_id: userId,
            });
          }
        );
      }
    );
  } catch (error) {
    console.error('[users/register] fatal', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// POST /users/verify-email
router.post('/users/verify-email', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Faltan email o código.' });

  const sql = `
    SELECT id, email_verif_code, email_verif_expires, name, last_name, phone,
     work_start, work_end, agent_type, brokerage_name, cities,
     agent_verification_status, agent_rejection_reason, profile_photo
    FROM users WHERE email = ? LIMIT 1
  `;
  pool.query(sql, [email], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error de servidor' });
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const u = rows[0];
    if (!u.email_verif_code || !u.email_verif_expires) {
      return res.status(400).json({ error: 'No hay verificación pendiente.' });
    }
    const now = new Date();
    const exp = new Date(u.email_verif_expires);

    if (String(code) !== String(u.email_verif_code)) {
      return res.status(400).json({ error: 'Código inválido.' });
    }
    if (now > exp) {
      return res.status(400).json({ error: 'El código ha expirado.' });
    }

    pool.query(
      'UPDATE users SET email_verified = 1, email_verif_code = NULL, email_verif_expires = NULL WHERE id = ?',
      [u.id],
      (uErr) => {
        if (uErr) return res.status(500).json({ error: 'No se pudo verificar.' });

        // Listo: da token y user (login inmediato)
        const token = jwt.sign(
          { id: u.id, email: u.email, agent_type: u.agent_type },
          process.env.JWT_SECRET,
          { expiresIn: '3h' }
        );
        let citiesArr = null;
        try { citiesArr = u.cities ? JSON.parse(u.cities) : null; } catch {}

        return res.json({
          token,
          user: {
            id: u.id,
            name: u.name,
            last_name: u.last_name,
            email,
            phone: u.phone,
            work_start: u.work_start,
            work_end: u.work_end,
            agent_type: u.agent_type,
            is_agent: u.agent_type !== 'seller',
            brokerage_name: u.brokerage_name || null,
            cities: citiesArr,
            agent_verification_status: u.agent_verification_status ?? null,
            agent_rejection_reason: u.agent_rejection_reason ?? null,
            profile_photo: u.profile_photo ?? null,
          }
        });
      }
    );
  });
});

const resendCodeIpLimiter = require('express-rate-limit')({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: true }),
});

const resendCodeEmailCooldown = createEmailCooldown({ windowMs: 30_000 });

// POST /users/resend-code
router.post('/users/resend-code', resendCodeIpLimiter, resendCodeEmailCooldown, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta email' });

  pool.query('SELECT id, email_verified FROM users WHERE email = ? LIMIT 1', [email], async (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error de servidor' });
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (rows[0].email_verified) return res.status(400).json({ error: 'El email ya está verificado.' });

    const code = gen6();
    const expires = new Date(Date.now() + (Number(process.env.VERIFICATION_MINUTES || 15) * 60 * 1000));

    pool.query(
      'UPDATE users SET email_verif_code = ?, email_verif_expires = ? WHERE id = ?',
      [code, expires, rows[0].id],
      async (uErr) => {
        if (uErr) return res.status(500).json({ error: 'No se pudo generar nuevo código.' });
        try {
          await sendVerificationEmail(email, code);
          res.json({ ok: true, message: 'Código reenviado.' });
        } catch (mailErr) {
          console.error('[resend-code] mail error', mailErr);
          res.status(500).json({ error: 'No se pudo enviar el correo.' });
        }
      }
    );
  });
});

// POST /users/login
router.post('/users/login', (req, res) => {
  const { email, password } = req.body;
  const sql = `
    SELECT id, name, last_name, email, password, phone,
          work_start, work_end, agent_type, brokerage_name, cities, email_verified,
          agent_verification_status, agent_rejection_reason, profile_photo
    FROM users
    WHERE email = ?
    LIMIT 1
  `;
  pool.query(sql, [email], async (err, rows) => {
    if (err) {
      console.error('[login] error', err);
      return res.status(500).json({ error: 'Error de servidor' });
    }
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }
    const u = rows[0];
    const ok = await bcrypt.compare(password, u.password);
    if (!u.email_verified) {
      return res.status(403).json({
        error: 'Debes verificar tu correo antes de iniciar sesión.',
        need_verification: true,
        email: u.email,
      });
    }
    if (!ok) return res.status(400).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign(
      { id: u.id, email: u.email, agent_type: u.agent_type },
      process.env.JWT_SECRET,
      { expiresIn: '3h' }
    );

    let citiesArr = null;
    try { citiesArr = u.cities ? JSON.parse(u.cities) : null; } catch {}

    return res.json({
      token,
      user: {
        id: u.id,
        name: u.name,
        last_name: u.last_name,
        email: u.email,
        phone: u.phone,
        work_start: u.work_start,
        work_end: u.work_end,
        agent_type: u.agent_type,
        agent_verification_status: u.agent_verification_status,
        is_agent: u.agent_type,
        brokerage_name: u.brokerage_name || null,
        cities: citiesArr,
        agent_rejection_reason: u.agent_rejection_reason ?? null,
        profile_photo: u.profile_photo ?? null,
      }
    });
  });
});

// POST /auth/google
router.post('/auth/google', async (req, res) => {
  try {
    const { id_token } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'Falta id_token' });

    if (!GOOGLE_CLIENT_IDS.length) {
      console.error('[auth/google] No Google client IDs configured. Set GMAIL_CLIENT_ID and/or GOOGLE_IOS_CLIENT_ID env vars.');
      return res.status(500).json({ error: 'Google Sign-In no está configurado en el servidor' });
    }

    // Verificar token
    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken: id_token,
        audience: GOOGLE_CLIENT_IDS,
      });
    } catch (verifyErr) {
      console.error('[auth/google] verifyIdToken failed:', verifyErr.message);
      return res.status(401).json({ error: 'Token de Google inválido', detail: verifyErr.message });
    }
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error: 'Token inválido: payload vacío' });

    const {
      sub: googleId,
      email,
      email_verified,
      given_name,
      family_name,
      name,
      picture,
    } = payload;

    if (!email || email_verified === false) {
      return res.status(400).json({ error: 'Email no verificado en Google' });
    }

    // Buscar usuario por email
    const selSql = `
      SELECT id, name, last_name, email, phone, work_start, work_end,
            agent_type, brokerage_name, cities, agent_verification_status, agent_rejection_reason
      FROM users
      WHERE email = ?
      LIMIT 1
    `;
    pool.query(selSql, [email], async (err, rows) => {
      if (err) {
        console.error('[auth/google] select error', err);
        return res.status(500).json({ error: 'Error de servidor' });
      }

      let userRow;
      if (rows && rows.length) {
        userRow = rows[0];
      } else {
        // Crear usuario nuevo (password aleatoria encriptada)
        const randomPass = crypto.randomBytes(18).toString('hex');
        const hashed = await bcrypt.hash(randomPass, 10);

        const insSql = `
        INSERT INTO users (name, last_name, email, password, agent_type, email_verified, work_start, work_end)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `;
        const vals = [given_name || name || '', family_name || '', email, hashed, 'regular', null, null];
        pool.query(insSql, vals, (insErr, result) => {
          if (insErr) {
            console.error('[auth/google] insert error', insErr);
            return res.status(500).json({ error: 'No se pudo crear el usuario' });
          }
          userRow = {
            id: result.insertId,
            name: given_name || name || '',
            last_name: family_name || '',
            email,
            phone: null,
            work_start: null,
            work_end: null,
            agent_type: 'regular',
            agent_verification_status: 'not_required',
            brokerage_name: null,
            cities: null,
          };
          // devolver token
          issueToken(res, userRow);
        });
        return; // importante cortar aquí: devolvemos en el callback
      }

      // Usuario ya existía → devolver token
      issueToken(res, userRow);
    });
  } catch (e) {
    console.error('[auth/google] error', e);
    return res.status(500).json({ error: 'Error de servidor' });
  }
});

// GET /auth/validate
router.get('/auth/validate', authenticateToken, (req, res) => {
  const { id } = req.user;

  const query = `
    SELECT
      name,
      last_name,
      email,
      phone,
      agent_type,
      work_start,
      work_end,
      agent_verification_status,
      agent_rejection_reason,
      profile_photo
    FROM users
    WHERE id = ?
    LIMIT 1
  `;

  pool.query(query, [id], (err, results) => {
    if (err || !results?.length) {
      return res.status(401).json({ error: 'Usuario no encontrado.' });
    }
    const user = results[0];

    res.json({
      valid: true,
      id,
      name: user.name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
      user_type: user.agent_type,
      work_start: user.work_start,
      work_end: user.work_end,
      agent_verification_status: user.agent_verification_status ?? null,
      agent_rejection_reason: user.agent_rejection_reason ?? null,
      profile_photo: user.profile_photo ?? null,
    });
  });
});

// POST /auth/forgot-password
router.post(
  '/auth/forgot-password',
  forgotPasswordIpLimiter,
  forgotPasswordEmailCooldown,
  async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      // Respuesta siempre "ok" para no filtrar si existe o no el usuario
      if (!email) return res.status(200).json({ ok: true });

      const [rows] = await pool.promise().query(
        'SELECT id, email FROM users WHERE LOWER(email) = ? LIMIT 1',
        [email]
      );

      if (!rows || !rows.length) {
        return res.status(200).json({ ok: true });
      }

      const user = rows[0];

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const minutes = Number(process.env.RESET_PASSWORD_MINUTES || 60);

      await pool.promise().query(
        'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
        [user.id]
      );

      await pool.promise().query(
        `
        INSERT INTO password_resets (user_id, token_hash, expires_at)
        VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
        `,
        [user.id, tokenHash, minutes]
      );

      const resetUrl = buildResetWebUrl(token);
      if (resetUrl) {
        await sendResetPasswordEmail(user.email, resetUrl);
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[auth/forgot-password] error', e);
      return res.status(200).json({ ok: true });
    }
  }
);

// POST /auth/reset-password
router.post('/auth/reset-password', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.password || '');

    if (!token || newPassword.length < 8) {
      return res.status(400).json({ error: 'Token y password (mínimo 8 caracteres) son requeridos.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [rows] = await pool.promise().query(
      `
      SELECT id, user_id, used_at,
             (expires_at <= NOW()) AS is_expired
      FROM password_resets
      WHERE token_hash = ?
      LIMIT 1
      `,
      [tokenHash]
    );

    if (!rows?.length) return res.status(400).json({ error: 'Token inválido.' });

    const pr = rows[0];
    if (pr.used_at) return res.status(400).json({ error: 'Este enlace ya fue usado.' });
    if (Number(pr.is_expired) === 1) {
      return res.status(400).json({ error: 'Este enlace ya expiró. Solicita uno nuevo.' });
    }

    // Hash password
    const hashed = await bcrypt.hash(newPassword, 10);

    // Transacción: marcar usado + cambiar password
    const cxn = await pool.promise().getConnection();
    try {
      await cxn.beginTransaction();

      const [u] = await cxn.query(
        'UPDATE users SET password = ? WHERE id = ?',
        [hashed, pr.user_id]
      );

      if (!u.affectedRows) {
        await cxn.rollback();
        cxn.release();
        return res.status(404).json({ error: 'Usuario no encontrado.' });
      }

      await cxn.query(
        'UPDATE password_resets SET used_at = NOW() WHERE id = ?',
        [pr.id]
      );

      await cxn.commit();
      cxn.release();

      return res.json({ ok: true });
    } catch (txErr) {
      await cxn.rollback();
      cxn.release();
      console.error('[auth/reset-password] tx error', txErr);
      return res.status(500).json({ error: 'No se pudo restablecer la contraseña.' });
    }
  } catch (e) {
    console.error('[auth/reset-password] error', e);
    return res.status(500).json({ error: 'Error de servidor.' });
  }
});

// POST /auth/reset-password/validate
router.post('/auth/reset-password/validate', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ valid: false });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Traemos 1 fila y dejamos que SQL decida si expiró
    const [rows] = await pool.promise().query(
      `
      SELECT
        used_at,
        (expires_at <= NOW()) AS is_expired
      FROM password_resets
      WHERE token_hash = ?
      LIMIT 1
      `,
      [tokenHash]
    );

    if (!rows?.length) return res.json({ valid: false });

    const r = rows[0];
    if (r.used_at) return res.json({ valid: false, reason: 'used' });
    if (Number(r.is_expired) === 1) return res.json({ valid: false, reason: 'expired' });

    return res.json({ valid: true });
  } catch (e) {
    console.error('[reset-password/validate] error', e);
    res.json({ valid: false });
  }
});

module.exports = router;
