const pool = require('../db/pool');
const redis = require('../db/redis');
const cloudinary = require('../cldnry');
const { Resend } = require('resend');
const { Expo } = require('expo-server-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 180);
const REFRESH_TOKEN_TTL_SECS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

const expo = new Expo();
const resend = new Resend(process.env.RESEND_API_KEY);

const GOOGLE_CLIENT_IDS = [
  process.env.GMAIL_CLIENT_ID,
  process.env.GOOGLE_IOS_CLIENT_ID,
].filter(Boolean);

function extFromFilename(name) {
  const m = /(?:\.)([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : undefined;
}

function signedDeliveryUrlFromSecure(
  secureUrl,
  ttlSeconds = Number(process.env.CLD_DEFAULT_URL_TTL_SECONDS || 300),
  filename
) {
  const meta = parseCloudinary(secureUrl);
  if (!meta) return null;

  const resource_type = meta.resource_type || 'raw';
  const public_id = meta.public_id;
  const expires_at = Math.floor(Date.now() / 1000) + ttlSeconds;

  // Determina el formato: primero el que venía en la URL de upload; si no, desde file_name
  let format = meta.format || extFromFilename(filename);

  return cloudinary.url(public_id, {
    resource_type,
    type: 'authenticated',  // indispensable para access_mode=authenticated
    format,                 // ← CLAVE: fuerza .pptx, .pdf, etc.
    sign_url: true,
    secure: true,
    expires_at,
    attachment: filename || true, // descarga con nombre correcto
  });
}

// Extrae resource_type, type y public_id desde un secure_url de Cloudinary
function parseCloudinary(secureUrl) {
  const re = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/(upload|authenticated|private)\/(?:(?:s--[A-Za-z0-9_-]{8,}--\/)?)(?:v(\d+)\/)?(.+?)(?:\.([a-z0-9]+))?(?:[#?].*)?$/i;
  const m = (secureUrl || '').match(re);
  if (!m) return null;
  const [, cloud, resource_type, type, version, public_id, format] = m;
  return { cloud, resource_type, type, version: version ? Number(version) : undefined, public_id, format };
}

function buildDeliveryUrlFromSecure(secureUrl, filename, ttlSeconds = 300) {
  const meta = parseCloudinary(secureUrl);
  if (!meta) return null;

  const format = meta.format || extFromFilename(filename);
  const baseOpts = {
    resource_type: meta.resource_type || 'raw',
    type: meta.type,
    version: meta.version,
    format,
    secure: true,
  };

  // Públicos (upload): devuelve tal cual (o añade .ext si falta)
  if (meta.type === 'upload') {
    const url = cloudinary.url(meta.public_id, { ...baseOpts, sign_url: false });
    return url;
  }

  // private / authenticated → URL firmada
  return cloudinary.url(meta.public_id, {
    ...baseOpts,
    sign_url: true,
    attachment: filename || true,
  });
}

function gen6() {
  // Código 6 dígitos
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(to, code) {
  const from = process.env.MAIL_FROM || 'LISTED <support@listed.com.mx>';
  const minutes = Number(process.env.VERIFICATION_MINUTES || 15);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px;">
      <h2>Verifica tu correo</h2>
      <p>Tu código de verificación es:</p>
      <div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; margin: 12px 0;">${code}</div>
      <p>Este código vence en ${minutes} minutos.</p>
      <p>Si no has solicitado esta verificación, ignora este mensaje.</p>
    </div>
  `;

  try {
    const resp = await resend.emails.send({
      from,
      to: [to],
      subject: 'Tu código de verificación',
      html,
      text: `Tu código de verificación es: ${code}. Vence en ${minutes} minutos.`,
    });

    if (resp?.error) {
      console.error('[mail/resend] verification error', resp.error);
      throw new Error(resp.error.message || 'Resend error');
    }

    return true;
  } catch (e) {
    console.error('[mail/resend] verification exception', e);
    throw e;
  }
}

async function sendResetPasswordEmail(to, resetUrl) {
  const from = process.env.MAIL_FROM || 'LISTED <support@listed.com.mx>';
  const minutes = Number(process.env.RESET_PASSWORD_MINUTES || 60);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; line-height: 1.35;">
      <h2>Restablecer contraseña</h2>
      <p>Recibimos una solicitud para restablecer tu contraseña.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;background:#0b0b0b;color:#fff;text-decoration:none;border-radius:10px;">
          Cambiar contraseña
        </a>
      </p>
      <p>Este enlace expira en ${minutes} minutos.</p>
      <p>Si tú no solicitaste este cambio, puedes ignorar este correo.</p>
    </div>
  `;

  try {
    const resp = await resend.emails.send({
      from,
      to: [to],
      subject: 'Restablecer contraseña',
      html,
      text: `Restablece tu contraseña aquí: ${resetUrl} (expira en ${minutes} minutos).`,
    });

    if (resp?.error) {
      console.error('[mail/resend] reset error', resp.error);
      throw new Error(resp.error.message || 'Resend error');
    }

    return true;
  } catch (e) {
    console.error('[mail/resend] reset exception', e);
    throw e;
  }
}

function getPublicWebBaseUrl() {
  return String(process.env.PUBLIC_WEB_BASE_URL || '').replace(/\/+$/, '');
}

function buildResetWebUrl(token) {
  const base = getPublicWebBaseUrl();
  if (!base) return null;
  return `${base}/reset-password/?token=${encodeURIComponent(token)}`;
}

function isExpoToken(t) {
  return typeof t === 'string' && Expo.isExpoPushToken(t);
}

async function sendPushToUser({ userId, title, body, data }) {
  return new Promise((resolve) => {
    console.log('[push] sendPushToUser', {
      userId,
      title,
      bodyPreview: String(body || '').slice(0, 60),
    });

    pool.query(
      `
      SELECT id, expo_push_token
      FROM user_push_tokens
      WHERE user_id = ?
        AND is_active = 1
      `,
      [userId],
      async (err, rows) => {
        if (err) {
          console.error('[push] db error', err);
          return resolve(false);
        }

        console.log('[push] tokens_for_user', userId, rows);

        const tokenRows = Array.isArray(rows) ? rows : [];
        const tokens = tokenRows
          .map((r) => ({ id: r.id, token: r.expo_push_token }))
          .filter((x) => isExpoToken(x.token));

        if (!tokens.length) {
          console.log('[push] no active expo tokens for user', userId);
          return resolve(true);
        }

        const messages = tokens.map((t) => ({
          to: t.token,
          sound: 'default',
          title,
          body,
          data: data || {},
          channelId: 'chat',
          priority: 'high',
        }));

        try {
          const chunks = expo.chunkPushNotifications(messages);

          // guardamos relación token -> ticket para poder desactivar si hace falta
          const ticketMap = []; // [{ tokenId, token, ticket }]

          for (const chunk of chunks) {
            const tickets = await expo.sendPushNotificationsAsync(chunk);

            for (let i = 0; i < tickets.length; i++) {
              const ticket = tickets[i];
              const to = chunk[i]?.to;

              const match = tokens.find((x) => x.token === to);
              if (match) ticketMap.push({ tokenId: match.id, token: match.token, ticket });
            }
          }

          console.log('[push] tickets', ticketMap.map((x) => x.ticket));

          // Desactivar tokens inválidos (DeviceNotRegistered)
          const invalidTokenIds = ticketMap
            .filter((x) => x.ticket?.status === 'error' && x.ticket?.details?.error === 'DeviceNotRegistered')
            .map((x) => x.tokenId);

          if (!invalidTokenIds.length) return resolve(true);

          pool.query(
            `UPDATE user_push_tokens SET is_active=0, updated_at=NOW() WHERE id IN (?)`,
            [invalidTokenIds],
            (e2) => {
              if (e2) console.error('[push] deactivate invalid tokens error', e2);
              else console.log('[push] deactivated token ids', invalidTokenIds);
              return resolve(true);
            }
          );
        } catch (e) {
          console.error('[push] send error', e);
          return resolve(false);
        }
      }
    );
  });
}

function q(cxn, sql, params, step) {
  return new Promise((resolve, reject) => {
    cxn.query(sql, params, (err, rows) => {
      if (err) {
        // Anota el paso y el SQL para depurar
        err._step = step;
        err._sql = sql;
        return reject(err);
      }
      resolve(rows);
    });
  });
}

function isMutedForReceiver(receiverId, senderId, propertyId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT is_muted, muted_until
      FROM chat_mutes
      WHERE user_id = ?
        AND other_user_id = ?
        AND ((property_id IS NULL AND ? IS NULL) OR property_id = ?)
      LIMIT 1
    `;
    pool.query(sql, [receiverId, senderId, propertyId, propertyId], (err, rows) => {
      if (err) return reject(err);
      if (!rows?.length) return resolve(false);

      const r = rows[0];
      if (!r.is_muted) return resolve(false);

      if (r.muted_until && new Date(r.muted_until).getTime() <= Date.now()) {
        return resolve(false);
      }
      resolve(true);
    });
  });
}

function getActivePushTokens(userId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT expo_push_token
      FROM user_push_tokens
      WHERE user_id = ?
        AND is_active = 1
        AND expo_push_token IS NOT NULL
        AND expo_push_token <> ''
    `;
    pool.query(sql, [userId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map(r => r.expo_push_token));
    });
  });
}

// --------------- Refresh-token helpers ---------------

async function generateRefreshToken({ userId, email, agentType, family }) {
  const familyId = family || crypto.randomUUID();
  const raw = crypto.randomBytes(32).toString('hex');          // 64-char hex
  const hash = crypto.createHash('sha256').update(raw).digest('hex');

  const payload = JSON.stringify({
    userId,
    email,
    agentType,
    family: familyId,
    createdAt: Date.now(),
  });

  await redis.set(`rt:${hash}`, payload, 'EX', REFRESH_TOKEN_TTL_SECS);
  return { rawToken: raw, family: familyId };
}

async function consumeRefreshToken(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const stored = await redis.get(`rt:${hash}`);
  if (!stored) {
    // Token desconocido — puede ser replay: intentamos detectar la familia
    // (no podemos saber la familia sin el payload, así que simplemente rechazamos)
    return { error: 'invalid' };
  }

  const data = JSON.parse(stored);

  // ¿Familia revocada?
  const revoked = await redis.exists(`rt:family:${data.family}`);
  if (revoked) {
    return { error: 'family_revoked' };
  }

  // Eliminar token actual (rotación: single-use)
  const deleted = await redis.del(`rt:${hash}`);
  if (deleted === 0) {
    // Race-condition: ya fue consumido por otro request → posible replay
    await redis.set(`rt:family:${data.family}`, 'revoked', 'EX', REFRESH_TOKEN_TTL_SECS);
    return { error: 'replay_detected' };
  }

  return { data };
}

async function revokeRefreshToken(rawToken) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await redis.del(`rt:${hash}`);
}

// Helper para emitir token con forma homogénea a tu /users/login
async function issueToken(res, u) {
  const token = jwt.sign(
    { id: u.id, email: u.email, agent_type: u.agent_type },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );

  const { rawToken: refreshToken } = await generateRefreshToken({
    userId: u.id,
    email: u.email,
    agentType: u.agent_type,
  });

  let citiesArr = null;
  try { citiesArr = u.cities ? JSON.parse(u.cities) : null; } catch {}

  return res.json({
    token,
    refreshToken,
    user: {
      id: u.id,
      name: u.name,
      last_name: u.last_name,
      email: u.email,
      phone: u.phone,
      work_start: u.work_start,
      work_end: u.work_end,
      agent_type: u.agent_type,
      agent_verification_status: u.agent_verification_status ?? null,
      is_agent: u.agent_type !== 'regular',
      brokerage_name: u.brokerage_name || null,
      cities: citiesArr,
      profile_photo: u.profile_photo ?? null,
    }
  });
}

const forgotPasswordIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 5,                   // 5 requests por IP en la ventana
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:forgotpw:' }),
  handler: (req, res) => res.status(429).json({ ok: true }),
});

// 2) Cooldown por email (30s) backed by Redis
function createEmailCooldown({ windowMs = 30_000 } = {}) {
  return async function emailCooldown(req, res, next) {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return next();

    const key = `rl:emailcd:${email}`;
    try {
      const exists = await redis.exists(key);
      if (exists) return res.status(429).json({ ok: true });
      await redis.set(key, '1', 'PX', windowMs);
    } catch (err) {
      console.error('[emailCooldown] redis error, allowing request', err.message);
    }
    return next();
  };
}

const forgotPasswordEmailCooldown = createEmailCooldown({ windowMs: 30_000 });

module.exports = {
  extFromFilename,
  signedDeliveryUrlFromSecure,
  parseCloudinary,
  buildDeliveryUrlFromSecure,
  gen6,
  sendVerificationEmail,
  sendResetPasswordEmail,
  getPublicWebBaseUrl,
  buildResetWebUrl,
  isExpoToken,
  sendPushToUser,
  q,
  isMutedForReceiver,
  getActivePushTokens,
  issueToken,
  generateRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  ACCESS_TOKEN_TTL,
  forgotPasswordIpLimiter,
  createEmailCooldown,
  forgotPasswordEmailCooldown,
  GOOGLE_CLIENT_IDS,
  expo,
  resend,
};
