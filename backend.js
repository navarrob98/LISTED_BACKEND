require('dotenv').config({ path: 'temporary.env' });
const {
  deleteUserChatUploadsByFolder,
  deleteUserPropertyUploadsByFolder,
} = require('./cloud-folder-delete');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authenticateToken = require('./middleware/authenticateToken');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cloudinary = require('./cldnry');
const { Expo } = require('expo-server-sdk');
const expo = new Expo();
const requireAdmin = require('./middleware/requireAdmin');
const requireVerifiedAgentFactory = require('./middleware/requireVerifiedAgent');



const app = express();
const port = process.env.PORT || 3000;
const dbPassword = process.env.DB_KEY;

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[stripe/webhook] constructEvent error:', err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object; // Stripe.PaymentIntent
      const [rows] = await pool.promise().query(
        'SELECT id, property_id FROM promotions WHERE stripe_payment_intent=? LIMIT 1',
        [pi.id]
      );
      const promo = Array.isArray(rows) && rows[0];
      if (promo) {
        await pool.promise().query(
          'UPDATE promotions SET status="paid", expires_at=DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE id=?',
          [promo.id]
        );
        await pool.promise().query(
          'UPDATE properties SET promoted_until=DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE id=?',
          [promo.property_id]
        );
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object; // Stripe.PaymentIntent
      await pool.promise().query(
        'UPDATE promotions SET status="canceled" WHERE stripe_payment_intent=?',
        [pi.id]
      );
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('[stripe/webhook] handler error:', e);
    return res.status(500).send('Server error');
  }
});

// Middleware
const allowedOrigins = [
  'https://listed.com.mx',
  'https://www.listed.com.mx',
  'http://localhost:19006',
  'http://localhost:3000',
];

app.use(cors({
  origin: function(origin, cb) {
    // requests sin origin (Postman, server-to-server) deben pasar
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
}));

app.options(/.*/, cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
});

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

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.SMTP_USER,
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
  },
});

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
  const from = process.env.MAIL_FROM || 'LISTED <no-reply@listed.app>';
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
  await mailer.sendMail({
    from,
    to,
    subject: 'Tu código de verificación',
    text: `Tu código de verificación es: ${code}. Vence en ${minutes} minutos.`,
    html,
  });
}

async function sendResetPasswordEmail(to, resetUrl) {
  const from = process.env.MAIL_FROM || 'LISTED <no-reply@listed.app>';
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

  await mailer.sendMail({
    from,
    to,
    subject: 'Restablecer contraseña',
    text: `Restablece tu contraseña aquí: ${resetUrl} (expira en ${minutes} minutos).`,
    html,
  });
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

// const pool = mysql.createPool({
//   host: 'localhost',
//   user: 'root',
//   password: dbPassword,
//   database: 'listed_property_sell',
//   connectionLimit: 10
// });

const GOOGLE_CLIENT_IDS = [
  process.env.GMAIL_CLIENT_ID, // WEB_CLIENT_ID
];
const googleClient = new OAuth2Client();

// Test database connection
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL database!');
    connection.release();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
server.listen(port, '0.0.0.0', () => {
  console.log(`Backend server + Socket.io listening on port ${port}`);
});

// Property Endpoints
// Add property
app.post("/properties/add", authenticateToken, async (req, res) => {
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
    } = req.body || {};

    const created_by = req.user.id;

    // (Opcional pero recomendado) Verifica que el usuario exista
    // y de paso puedes usarlo después si quieres aplicar reglas por rol.
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
        review_status, is_published
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
    ];

    const [result] = await pool.promise().query(query, values);
    const propertyId = result.insertId;

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
    return res.status(500).json({
      error: "Failed to save property",
      details: err?.sqlMessage || String(err),
    });
  }
});


// Edit property by id (con manejo de imágenes por URL)
app.put('/properties/:id', authenticateToken, (req, res) => {
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
  const checkOwnerSql = `SELECT id FROM properties WHERE id = ? AND created_by = ?`;
  pool.query(checkOwnerSql, [id, req.user.id], (chkErr, chkRows) => {
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

          // Orden crítico (MySQL evalúa SET de izq → der):
          // 1) price_prev = price                 (captura el ANTERIOR)
          // 2) price_original = COALESCE(price_original, price)  (si venía NULL, fija el BASE al ANTERIOR)
          // 3) price = ?                          (aplica el NUEVO)
          const priceBlock = `
            price_prev = price,
            price_original = COALESCE(price_original, price),
            price = ?
          `;

          sql = `
            UPDATE properties
            SET ${setFragments.join(', ')}${setFragments.length ? ',' : ''} ${priceBlock}
            WHERE id = ? AND created_by = ?
          `;
          params = [...values, newPrice, id, req.user.id];
        } else {
          // Update normal sin precio
          sql = `
            UPDATE properties
            SET ${setFragments.join(', ')}
            WHERE id = ? AND created_by = ?
          `;
          params = [...values, id, req.user.id];
        }

        pool.query(sql, params, (err, result) => {
          if (err) {
            console.error('[PUT /properties/:id] SQL ERROR', { sql, params, code: err.code, sqlMessage: err.sqlMessage });
            return res.status(500).json({ error: 'No se pudo actualizar', details: err.sqlMessage || String(err) });
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

// Get properties in a specific region
app.get('/properties', (req, res) => {
  const { minLat, maxLat, minLng, maxLng } = req.query;
  if (
    minLat === undefined || maxLat === undefined ||
    minLng === undefined || maxLng === undefined
  ) {
    return res.status(400).json({ error: 'Faltan parámetros de región' });
  }

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
  `;

  pool.query(
    query,
    [Number(minLat), Number(maxLat), Number(minLng), Number(maxLng)],
    (err, results) => {
      if (err) {
        console.error('Error fetching properties:', err);
        return res.status(500).json({ error: 'Failed to fetch properties' });
      }
      console.log(results);
      res.json(results);
    }
  );
});

// Get property by id
app.get('/properties/:id', (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT 
      p.*,
      u.name AS owner_name,
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

app.get('/my-properties', authenticateToken, (req, res) => {
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
    WHERE p.created_by = ?
    ORDER BY
      (p.promoted_until IS NOT NULL AND p.promoted_until > NOW()) DESC,
      p.id DESC
  `;

  pool.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Error getting user properties:', err);
      return res.status(500).json({ error: 'Error al obtener tus propiedades.' });
    }
    res.json(results);
  });
});

// Visualizar aunque no este aprobada la propiedad.
app.get('/my-properties/:id', authenticateToken, (req, res) => {
  const propertyId = Number(req.params.id);
  const userId = req.user.id;

  const sql = `
    SELECT
      p.*,
      COALESCE(img.images, JSON_ARRAY()) AS images,
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
    WHERE p.id = ?
      AND p.created_by = ?
    LIMIT 1
  `;

  pool.query(sql, [propertyId, userId], (err, rows) => {
    if (err) {
      console.error('[GET /my-properties/:id] error', err);
      return res.status(500).json({ error: 'Error consultando propiedad' });
    }
    if (!rows.length) return res.status(404).json({ error: 'No se encontró la propiedad (owner)' });
    res.json(rows[0]);
  });
});


// Delete property
app.delete('/properties/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM properties WHERE id = ?';
  
    pool.query(query, [id], (err, result) => {
      if (err) {
        console.error('Error deleting property:', err);
        res.status(500).json({ error: 'Failed to delete property' });
        return;
      }
      console.log('Property deleted successfully')
      res.json({ message: 'Property deleted successfully' });
    });
  });

  // User Endpoints
  app.post('/users/register', async (req, res) => {
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

  app.post('/users/verify-email', (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Faltan email o código.' });
  
    const sql = `
      SELECT id, email_verif_code, email_verif_expires, name, last_name, phone, license,
             work_start, work_end, agent_type, brokerage_name, cities
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
              license: u.license,
              work_start: u.work_start,
              work_end: u.work_end,
              agent_type: u.agent_type,
              is_agent: u.agent_type !== 'seller',
              brokerage_name: u.brokerage_name || null,
              cities: citiesArr,
            }
          });
        }
      );
    });
  });

  app.post('/users/resend-code', (req, res) => {
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

// Register new agent
app.post('/agents/register', async (req, res) => {
  const {
    name,
    last_name,
    email,
    password,
    phone,
    license,
    work_start,
    work_end,
    agent_type,         // 'brokerage' | 'individual' | 'seller'
    brokerage_name,     // opcional si agent_type === 'brokerage'
    cities              // array de strings
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

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const minutes = Number(process.env.VERIFICATION_MINUTES || 15);
    const code = gen6();                                // 6 dígitos
    const expires = new Date(Date.now() + minutes * 60 * 1000);

    const sql = `
      INSERT INTO users
        (name, last_name, email, password, phone, license, work_start, work_end,
        agent_type, brokerage_name, cities,
        email_verified, email_verif_code, email_verif_expires,
        agent_verification_status)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `;
    
    const hasLicense = !!(license && String(license).trim());
    const normalizedLicense = hasLicense ? String(license).trim() : null;

    const isAgent = ['brokerage','individual','seller'].includes(finalAgentType);

    const agentVerificationStatus = (isAgent && hasLicense) ? 'pending' : 'not_required';
    
    const params = [
      name,
      last_name,
      email,
      hashedPassword,
      phone || null,
      normalizedLicense,
      work_start,
      work_end,
      finalAgentType,
      finalAgentType === 'brokerage' ? (brokerage_name || null) : null,
      citiesArr.length ? JSON.stringify(citiesArr) : null,
      code,
      expires,
      agentVerificationStatus
    ];

    pool.query(sql, params, async (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ error: 'El email ya existe' });
        }
        console.error('[agents/register] insert error', err);
        return res.status(500).json({ error: 'Error al registrar el usuario.' });
      }

      // enviar código
      try {
        await sendVerificationEmail(email, code);
      } catch (mailErr) {
        console.error('[agents/register] mail error', mailErr);
        // Si quieres, puedes responder 201 y permitir reenviar el código luego:
        // return res.status(201).json({ ok: true, need_verification: true, email, user_id: result.insertId, mail_sent: false });
      }

      // igual que /users/register: NO token, exige verificación
      return res.status(201).json({
        ok: true,
        need_verification: true,
        email,
        user_id: result.insertId
      });
    });
  } catch (error) {
    console.error('[agents/register] fatal', error);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Actualizar horario laboral del agente (requiere token)
app.put('/agents/:id/work-schedule', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { work_start, work_end } = req.body;

  if (!work_start || !work_end) {
    return res.status(400).json({ error: 'Debes enviar ambos campos: work_start y work_end.' });
  }

  const regex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!regex.test(work_start) || !regex.test(work_end)) {
    return res.status(400).json({ error: 'Horario laboral en formato inválido. Usa HH:mm.' });
  }

  if (parseInt(id) !== req.user.id) {
    return res.status(403).json({ error: 'No autorizado.' });
  }

  pool.query(
    'UPDATE users SET work_start = ?, work_end = ? WHERE id = ? AND type = "agente"',
    [work_start, work_end, id],
    (err, result) => {
      if (err) return res.status(500).json({ error: 'Error actualizando horario.' });
      if (result.affectedRows === 0) return res.status(404).json({ error: 'No se actualizó (id no encontrado o no es agente).' });
      res.json({ message: 'Horario actualizado correctamente.' });
    }
  );
});

// Obtener horario laboral de un agente
app.get('/agents/:id', (req, res) => {
  const { id } = req.params;
  pool.query(
    `SELECT id, name, last_name, phone, license, work_start, work_end
     FROM users
     WHERE id = ? AND (agent_type = "brokerage" OR agent_type = "individual")
     LIMIT 1`,
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error al consultar el horario.' });
      if (!results.length) return res.status(404).json({ error: 'Agente no encontrado.' });
      res.json(results[0]);
    }
  );
});
  
// User log in
app.post('/users/login', (req, res) => {
  const { email, password } = req.body;
  const sql = `
    SELECT id, name, last_name, email, password, phone, license,
          work_start, work_end, agent_type, brokerage_name, cities, email_verified,
          agent_verification_status
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
    try { citiesArr = u.cities ? JSON.parse(u.cities) : null; } catch {
    }
    return res.json({
      token,
      user: {
        id: u.id,
        name: u.name,
        last_name: u.last_name,
        email: u.email,
        phone: u.phone,
        license: u.license,
        work_start: u.work_start,
        work_end: u.work_end,
        agent_type: u.agent_type,
        agent_verification_status: u.agent_verification_status,
        is_agent: u.agent_type,
        brokerage_name: u.brokerage_name || null,
        cities: citiesArr
      }
    });
  });
});

app.post('/auth/google', async (req, res) => {
  try {
    const { id_token } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'Falta id_token' });

    // Verificar token
    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_IDS,
    });
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error: 'Token inválido' });

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
      SELECT id, name, last_name, email, phone, license, work_start, work_end,
            agent_type, brokerage_name, cities, agent_verification_status
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
            license: null,
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

// Helper para emitir token con forma homogénea a tu /users/login
function issueToken(res, u) {
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
      license: u.license,
      work_start: u.work_start,
      work_end: u.work_end,
      agent_type: u.agent_type,
      agent_verification_status: u.agent_verification_status ?? null,
      is_agent: u.agent_type !== 'regular',
      brokerage_name: u.brokerage_name || null,
      cities: citiesArr
    }
  });
}

// Get user name (and optionally more data) by id
app.get('/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  pool.query(
    'SELECT id, name, email FROM users WHERE id = ? LIMIT 1',
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error buscando usuario' });
      if (!results.length) return res.status(404).json({ error: 'No encontrado' });
      res.json(results[0]);
    }
  );
});



app.put('/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { phone, email, password, work_start, work_end, name, last_name } = req.body;
  let updates = [];
  let values = [];

  if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
  if (email !== undefined) { updates.push('email = ?'); values.push(email); }
  if (password !== undefined) {
    const hashedPassword = bcrypt.hashSync(password, 10);
    updates.push('password = ?');
    values.push(hashedPassword);
  }
  if (work_start !== undefined) { updates.push('work_start = ?'); values.push(work_start); }
  if (work_end !== undefined) { updates.push('work_end = ?'); values.push(work_end); }
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (last_name !== undefined) { updates.push('last_name = ?'); values.push(last_name); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(id);

  pool.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    values,
    (err, results) => {
      if (err) {
        console.log(err);
        return res.status(500).json({ error: 'No se pudo actualizar' });}
      pool.query(
        'SELECT id, name, last_name, email, phone, work_start, work_end FROM users WHERE id = ?', 
        [id], 
        (err2, rows) => {
          if (err2 || !rows[0]) return res.json({ message: 'Actualizado' });
          res.json(rows[0]);
        }
      );
    }
  );
});

  //  Auth endpoint
// Endpoint para validar token
app.get('/auth/validate', authenticateToken, (req, res) => {
  const { id, email, agent_type } = req.user;
  const query = 'SELECT name, last_name, email, phone, agent_type FROM users WHERE id = ? LIMIT 1';
  pool.query(query, [id], (err, results) => {
    if (err || results.length === 0) {
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
    });
    console.log('auth: ', user);
  });
});

app.post('/auth/forgot-password', async (req, res) => {
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

    // 1) genera token y hash
    const token = crypto.randomBytes(32).toString('hex'); // token real (solo para email)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // 2) expira en X minutos
    const minutes = Number(process.env.RESET_PASSWORD_MINUTES || 60);

    // 3) opcional: invalida resets anteriores no usados de ese user
    await pool.promise().query(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [user.id]
    );

    // 4) inserta reset
    await pool.promise().query(
      `
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
      `,
      [user.id, tokenHash, minutes]
    );

    // 5) email con deep link
    const resetUrl = buildResetWebUrl(token);
    if (resetUrl) {
      await sendResetPasswordEmail(user.email, resetUrl);
    }
    
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[auth/forgot-password] error', e);
    // Por seguridad, también responde ok
    return res.status(200).json({ ok: true });
  }
});

app.post('/auth/reset-password', async (req, res) => {
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


app.post('/auth/reset-password/validate', async (req, res) => {
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


  // Buying Power endpoints

// POST: crear/actualizar buying power
app.post('/api/buying-power', authenticateToken, (req, res) => {
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

// GET: obtener último buying power del usuario (incluye suggested_price y annual_interest_rate)
app.get('/api/buying-power/:user_id', authenticateToken, (req, res) => {
  const { user_id } = req.params;

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

// Chat socket.io endpoints
io.on('connection', (socket) => {
  // El cliente llama: socket.emit('join', { userId })
  socket.on('join', ({ userId }) => {
    if (userId) socket.join('user_' + userId);
  });

  // Enviar mensaje (texto y/o archivo)
  socket.on('send_message', (data) => {
    const { sender_id, receiver_id, property_id, message, file_url, file_name } = data || {};
    console.log('[send_message] incoming', {
      socketId: socket.id,
      sender_id,
      receiver_id,
      property_id,
      hasMessage: !!message,
      hasFile: !!file_url,
    });
    if (!sender_id || !receiver_id || (!message && !file_url)) return;

    const messageSafe = typeof message === 'string' ? message.trim() : '';
    const fileUrlSafe = file_url || null;
    const fileNameSafe = file_name || null;

    const sql = `
      INSERT INTO chat_messages (property_id, sender_id, receiver_id, message, file_url, file_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const vals = [
      property_id || null,
      sender_id,
      receiver_id,
      messageSafe,
      fileUrlSafe,
      fileNameSafe,
    ];

    pool.query(sql, vals, async (err, result) => {
      if (err) {
        console.error('[send_message] insert error', err);
        return;
      }

      const msgObj = {
        id: result.insertId,
        property_id,
        sender_id,
        receiver_id,
        message: messageSafe,
        file_url: fileUrlSafe,
        file_name: fileNameSafe,
        created_at: new Date().toISOString(),
      };

      // Limpia hidden_chats del receptor para este hilo
      pool.query(
        `DELETE FROM hidden_chats
         WHERE user_id = ? AND chat_with_user_id = ? AND (property_id <=> ?)`,
        [receiver_id, sender_id, property_id ?? null],
        (e2) => {
          if (e2) console.error('[send_message] hidden_chats error', e2);
        }
      );

      // Si hay adjunto, agrega URL firmada para entrega inmediata (si aplica)
      if (msgObj.file_url) {
        msgObj.signed_file_url = buildDeliveryUrlFromSecure(msgObj.file_url, msgObj.file_name);
      }

      // Socket realtime (lo tuyo)
      socket.emit('receive_message', msgObj);
      io.to('user_' + sender_id).emit('receive_message', msgObj);
      io.to('user_' + receiver_id).emit('receive_message', msgObj);

      // PUSH: mandar al receptor (solo si NO está silenciado)
      try {
        const pid = property_id ?? null;
        const muted = await isMutedForReceiver(receiver_id, sender_id, pid);

        if (muted) {
          console.log('[push] skipped (muted chat)', {
            receiver_id,
            sender_id,
            property_id: pid
          });
        } else {
          await sendPushToUser({
            userId: receiver_id,
            title: 'Nuevo mensaje',
            body: messageSafe
              ? (messageSafe.length > 110 ? messageSafe.slice(0, 110) + '…' : messageSafe)
              : (fileUrlSafe ? 'Te enviaron un archivo' : 'Nuevo mensaje'),
            data: {
              type: 'chat',
              chatParams: {
                otherUserId: String(sender_id),
                propertyId: pid != null ? String(pid) : undefined,
              }
            }
          });
        }
      } catch (e) {
        console.error('[push] error', e);
      }
  });
});

  // Eliminar mensaje
  socket.on('delete_message', ({ message_id, user_id }) => {
    if (!message_id || !user_id) return;

    const q = `
      SELECT sender_id, receiver_id, property_id
      FROM chat_messages
      WHERE id = ?
      LIMIT 1
    `;

    pool.query(q, [message_id], (err, rows) => {
      if (err || !rows.length) return;
      const msg = rows[0];

      // Solo participantes pueden borrar
      if (
        String(msg.sender_id) !== String(user_id) &&
        String(msg.receiver_id) !== String(user_id)
      ) {
        return;
      }

      pool.query(
        'UPDATE chat_messages SET is_deleted = 1 WHERE id = ?',
        [message_id],
        (updErr) => {
          if (updErr) return;
          io.to('user_' + msg.sender_id).emit('message_deleted', { message_id });
          io.to('user_' + msg.receiver_id).emit('message_deleted', { message_id });
        }
      );
    });
  });
});

  app.get('/api/chat/file-url/:message_id', authenticateToken, (req, res) => {
    const { message_id } = req.params;
    const me = req.user.id;
    const sql = `
      SELECT id, sender_id, receiver_id, file_url, file_name
      FROM chat_messages
      WHERE id = ?
      LIMIT 1
    `;
    pool.query(sql, [message_id], (err, rows) => {
      if (err || !rows.length) return res.status(404).json({ error: 'No encontrado' });
      const m = rows[0];
      if (String(m.sender_id) !== String(me) && String(m.receiver_id) !== String(me)) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      const signed = m.file_url ? buildDeliveryUrlFromSecure(m.file_url, m.file_name) : null;
      res.json({ signed_file_url: signed });
    });
  });


// GET Cargar historial entre dos usuarios y por propiedad
app.get('/api/chat/messages', authenticateToken, (req, res) => {
  const { user_id, property_id } = req.query;
  const me = req.user.id;
  if (!user_id) return res.status(400).json({ error: 'Faltan campos' });

  let query = `
  SELECT *
  FROM chat_messages
  WHERE is_deleted = 0
    AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
  `;
  const params = [me, user_id, user_id, me];
  if (property_id) {
    query += ' AND property_id = ?';
    params.push(property_id);
  }
  query += ' ORDER BY created_at ASC';

  // Marca los mensajes recibidos como leídos
  const markAsRead = `
    UPDATE chat_messages
    SET is_read = 1
    WHERE receiver_id = ? AND sender_id = ? AND (property_id = ? OR ? IS NULL)
  `;

  pool.query(query, params, (err, results) => {
    if (err) return res.status(500).json({ error: 'No se pudo obtener los mensajes' });

    const ttl = Number(process.env.CLD_DEFAULT_URL_TTL_SECONDS || 300);
    const mapped = results.map(row => {
      if (row.file_url) {
        const signed = signedDeliveryUrlFromSecure(row.file_url, ttl, row.file_name);
        return { ...row, signed_file_url: signed };
      }
      return row;
    });

    pool.query(markAsRead, [me, user_id, property_id || null, property_id || null], () => {
      res.json(mapped);
    });
  });
});

function isMutedForReceiver(receiverId, senderId, propertyId) {
  return new Promise((resolve, reject) => {
    const q = `
      SELECT is_muted, muted_until
      FROM chat_mutes
      WHERE user_id = ?
        AND other_user_id = ?
        AND ((property_id IS NULL AND ? IS NULL) OR property_id = ?)
      LIMIT 1
    `;
    pool.query(q, [receiverId, senderId, propertyId, propertyId], (err, rows) => {
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
    const q = `
      SELECT expo_push_token
      FROM user_push_tokens
      WHERE user_id = ?
        AND is_active = 1
        AND expo_push_token IS NOT NULL
        AND expo_push_token <> ''
    `;
    pool.query(q, [userId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map(r => r.expo_push_token));
    });
  });
}


app.get('/api/chat/mute-status', authenticateToken, (req, res) => {
  const me = req.user?.id || req.userId; // ajusta a tu auth
  const otherUserId = Number(req.query.other_user_id);
  const propertyIdRaw = req.query.property_id;

  if (!me || !otherUserId) return res.status(400).json({ error: 'Faltan campos' });

  const propertyId = propertyIdRaw === undefined || propertyIdRaw === '' ? null : Number(propertyIdRaw);

  const q = `
    SELECT is_muted, muted_until
    FROM chat_mutes
    WHERE user_id = ?
      AND other_user_id = ?
      AND ((property_id IS NULL AND ? IS NULL) OR property_id = ?)
    LIMIT 1
  `;

  pool.query(q, [me, otherUserId, propertyId, propertyId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!rows?.length) return res.json({ is_muted: false, muted_until: null });

    const r = rows[0];

    // Si tiene vencimiento y ya pasó, consideramos no muted (opcional)
    if (r.muted_until && new Date(r.muted_until).getTime() <= Date.now()) {
      return res.json({ is_muted: false, muted_until: r.muted_until });
    }

    res.json({ is_muted: !!r.is_muted, muted_until: r.muted_until ?? null });
  });
});

app.put('/api/chat/mute', authenticateToken, (req, res) => {
  const me = req.user?.id || req.userId; // ajusta a tu auth
  const { other_user_id, property_id, is_muted, muted_until } = req.body;

  if (!me || !other_user_id || typeof is_muted !== 'boolean') {
    return res.status(400).json({ error: 'Faltan campos' });
  }

  const otherUserId = Number(other_user_id);
  const propertyId = property_id == null ? null : Number(property_id);

  const q = `
    INSERT INTO chat_mutes (user_id, other_user_id, property_id, is_muted, muted_until)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      is_muted = VALUES(is_muted),
      muted_until = VALUES(muted_until),
      updated_at = NOW()
  `;

  pool.query(
    q,
    [me, otherUserId, propertyId, is_muted ? 1 : 0, muted_until ?? null],
    (err) => {
      if (err) return res.status(500).json({ error: 'No se pudo actualizar' });
      res.json({ ok: true });
    }
  );
});

app.post('/api/push/register', authenticateToken, async (req, res) => {
  const userId = req.user.id; // o como lo tengas
  const { expoPushToken, platform, deviceId } = req.body || {};

  if (!expoPushToken || !deviceId) {
    return res.status(400).json({ ok: false, error: 'expoPushToken y deviceId son requeridos' });
  }

  try {
    // 1) Desactiva todos los devices del usuario (garantiza “solo el actual”)
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

app.post('/api/push/logout', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false });

  await pool.promise().query(
    `UPDATE user_push_tokens SET is_active=0, updated_at=NOW() WHERE user_id=? AND device_id=?`,
    [userId, deviceId]
  );

  res.json({ ok: true });
});

// GET Lista de conversaciones del usuario (resumen, no historial completo)
// GET Lista de conversaciones del usuario (resumen, no historial completo)
app.get('/api/chat/my-chats', authenticateToken, (req, res) => {
  const userId = req.user.id;

  const sql = `
    SELECT
      t.chat_with_user_id,
      u.name AS chat_with_user_name,
      u.last_name AS chat_with_user_last_name,
      t.property_id,
      p.address AS property_address,
      p.price        AS property_price,
      p.monthly_pay  AS property_monthly_pay,
      p.type         AS property_type,
      cm.created_at  AS last_message_at,
      cm.message     AS last_message,
      (
        SELECT COUNT(*)
        FROM chat_messages m
        WHERE m.sender_id = t.chat_with_user_id
          AND m.receiver_id = ?
          AND (m.property_id <=> t.property_id)
          AND m.is_read = 0
          AND m.is_deleted = 0
      ) AS unread_count,
      CASE
        WHEN cmute.is_muted = 1
          AND (cmute.muted_until IS NULL OR cmute.muted_until > NOW())
        THEN 1
        ELSE 0
      END AS is_muted
    FROM (
      SELECT
        IF(sender_id = ?, receiver_id, sender_id) AS chat_with_user_id,
        property_id,
        MAX(id) AS last_msg_id
      FROM chat_messages
      WHERE (sender_id = ? OR receiver_id = ?)
        AND is_deleted = 0
      GROUP BY chat_with_user_id, property_id
    ) t
    JOIN chat_messages cm ON cm.id = t.last_msg_id
    JOIN users u          ON u.id = t.chat_with_user_id
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN chat_mutes cmute
      ON cmute.user_id = ?
     AND cmute.other_user_id = t.chat_with_user_id
     AND (cmute.property_id <=> t.property_id)
    LEFT JOIN hidden_chats h
      ON h.user_id = ?
     AND h.chat_with_user_id = t.chat_with_user_id
     AND (h.property_id <=> t.property_id)
    WHERE h.user_id IS NULL
    ORDER BY cm.created_at DESC
  `;

  // 6 placeholders -> 6 params (en el orden exacto del SQL)
  const params = [
    userId, // unread_count: m.receiver_id = ?
    userId, // IF(sender_id = ?, ...)
    userId, // WHERE sender_id = ?
    userId, // WHERE receiver_id = ?
    userId, // cmute.user_id = ?
    userId, // h.user_id = ?
  ];

  pool.query(sql, params, (err, rows) => {
    if (err) {
      console.error('[my-chats] SQL ERROR', {
        code: err.code,
        sqlMessage: err.sqlMessage,
        sql: err.sql,
      });
      return res.status(500).json({ error: 'Error fetching chats', details: err.sqlMessage || String(err) });
    }
    res.json(rows);
  });
});


// Ocultar chat SOLO para el usuario actual
app.post('/api/chat/hide-chat', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { chat_with_user_id, property_id } = req.body;
  if (!chat_with_user_id) return res.status(400).json({ error: 'Faltan campos' });

  const sql = `
    INSERT INTO hidden_chats (user_id, chat_with_user_id, property_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE hidden_at = CURRENT_TIMESTAMP
  `;
  const params = [userId, chat_with_user_id, property_id ?? null];

  pool.query(sql, params, (err, result) => {
    if (err) {
      console.error('[hide-chat] INSERT error:', err, { params });
      return res.status(500).json({ error: 'No se pudo ocultar' });
    }
    console.log('[hide-chat] ok', { params, insertId: result.insertId });
    res.json({ ok: true });
  });
});


// PUT: Marcar mensajes como leídos
app.put('/api/chat/mark-read', authenticateToken, (req, res) => {
  const { user_id, chat_with_user_id, property_id } = req.body;

  if (user_id == null || chat_with_user_id == null) {
    return res.status(400).json({ error: 'Faltan campos' });
  }

  // Normaliza property_id: null si viene undefined/''; número si viene string numérica
  const pid =
    property_id === undefined || property_id === null || property_id === ''
      ? null
      : Number(property_id);

  const query = `
    UPDATE chat_messages
    SET is_read = 1
    WHERE receiver_id = ?
      AND sender_id = ?
      AND (property_id <=> ?)
  `;

  const params = [user_id, chat_with_user_id, pid];

  pool.query(query, params, (err, result) => {
    if (err) {
      console.error('[mark-read] error', err);
      return res.status(500).json({ error: 'No se pudo marcar como leído' });
    }
    res.json({ ok: true, affectedRows: result?.affectedRows ?? 0 });
  });
});

app.get('/users/:id/delete-preview', authenticateToken, (req, res) => {
  const uid = Number(req.params.id);
  if (uid !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

  const qProps = `
    SELECT id, address, price
    FROM properties
    WHERE created_by = ?
    ORDER BY id DESC
    LIMIT 200
  `;

  const qCounts = `
    SELECT
      (SELECT COUNT(*) FROM properties WHERE created_by = ?)                          AS properties,
      (SELECT COUNT(*) FROM property_images pi JOIN properties p ON p.id=pi.property_id WHERE p.created_by = ?) AS property_images,
      (SELECT COUNT(*) FROM chat_messages WHERE sender_id = ? OR receiver_id = ?)     AS chat_messages,
      (SELECT COUNT(*) FROM hidden_chats WHERE user_id = ? OR chat_with_user_id = ?)  AS hidden_chats,
      (SELECT COUNT(*) FROM tenant_profiles WHERE user_id = ?)                        AS tenant_profiles,
      (SELECT COUNT(*) FROM buying_power WHERE user_id = ?)                           AS buying_power
  `;

  pool.query(qProps, [uid], (e1, rowsProps=[]) => {
    if (e1) return res.status(500).json({ error: 'No se pudo obtener propiedades' });

    pool.query(qCounts, [uid, uid, uid, uid, uid, uid, uid, uid], (e2, rowsC=[]) => {
      if (e2) return res.status(500).json({ error: 'No se pudo obtener conteos' });
      const counts = rowsC[0] || {
        properties: 0, property_images: 0, chat_messages: 0,
        hidden_chats: 0, tenant_profiles: 0, buying_power: 0
      };
      res.json({ properties: rowsProps, counts });
    });
  });
});


// ========================================
// DELETE ACCOUNT (transaccional todo-o-nada)
// ========================================
app.post('/users/:id/delete-account', authenticateToken, async (req, res) => {
  const uid = Number(req.params.id);
  if (uid !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

  // Abre conexión + TX
  let cxn;
  try {
    cxn = await new Promise((resolve, reject) => pool.getConnection((e, c) => e ? reject(e) : resolve(c)));
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo abrir transacción', step: 'transaction', details: String(e) });
  }
  const began = await new Promise(ok => cxn.beginTransaction(err => ok(!err)));
  if (!began) {
    cxn.release();
    return res.status(500).json({ error: 'No se pudo iniciar transacción', step: 'transaction_begin' });
  }

  try {
    // 1) Prepara IDs de propiedades del usuario (evita DELETE ... JOIN)
    const props = await q(
      cxn,
      'SELECT id FROM properties WHERE created_by = ?',
      [uid],
      'select_properties'
    );
    const propIds = props.map(r => r.id);
    // 2) chat_messages
    await q(
      cxn,
      'DELETE FROM chat_messages WHERE sender_id = ? OR receiver_id = ?',
      [uid, uid],
      'delete_chat_messages'
    );
    // 3) hidden_chats
    await q(
      cxn,
      'DELETE FROM hidden_chats WHERE user_id = ? OR chat_with_user_id = ?',
      [uid, uid],
      'delete_hidden_chats'
    );
    // 4) tenant_profiles
    await q(
      cxn,
      'DELETE FROM tenant_profiles WHERE user_id = ?',
      [uid],
      'delete_tenant_profiles'
    );
    // 5) buying_power
    await q(
      cxn,
      'DELETE FROM buying_power WHERE user_id = ?',
      [uid],
      'delete_buying_power'
    );
    // 6) property_images (solo si hay props)
    if (propIds.length) {
      // Borra en lotes para no pasar el límite de placeholders
      const CHUNK = 500;
      for (let i = 0; i < propIds.length; i += CHUNK) {
        const slice = propIds.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        await q(
          cxn,
          `DELETE FROM property_images WHERE property_id IN (${placeholders})`,
          slice,
          'delete_property_images'
        );
      }
    }
    // 7) properties
    await q(
      cxn,
      'DELETE FROM properties WHERE created_by = ?',
      [uid],
      'delete_properties'
    );

    // 8A) Cloudinary – borra TODO lo del usuario en CHATS por carpeta u_<uid>
    try {
      await deleteUserChatUploadsByFolder(uid);
    } catch (e) {
      await new Promise(ok => cxn.rollback(() => ok(null)));
      cxn.release();
      return res.status(500).json({
        error: 'Falló borrar carpetas de chats en Cloudinary',
        step: 'cloudinary_chats_folders',
        details: String(e),
      });
    }

    // 8B) Cloudinary – borra TODO lo del usuario en PROPIEDADES por carpeta listed/<env>/image/u_<uid>
    try {
      await deleteUserPropertyUploadsByFolder(uid);
    } catch (e) {
      await new Promise(ok => cxn.rollback(() => ok(null)));
      cxn.release();
      return res.status(500).json({
        error: 'Falló borrar imágenes de propiedades en Cloudinary',
        step: 'cloud_properties_folders',
        details: String(e),
      });
    }

    // 9) users
    await q(
      cxn,
      'DELETE FROM users WHERE id = ?',
      [uid],
      'delete_user'
    );

    // 10) Commit
    const committed = await new Promise(ok => cxn.commit(err => ok(!err)));
    if (!committed) {
      await new Promise(ok => cxn.rollback(() => ok(null)));
      cxn.release();
      return res.status(500).json({ error: 'No se pudo confirmar transacción', step: 'commit' });
    }

    cxn.release();
    res.json({ ok: true });
  } catch (e) {
    // Rollback + devuelve paso y SQL exacto que falló
    await new Promise(ok => cxn.rollback(() => ok(null)));
    cxn.release();
    return res.status(500).json({
      error: 'Error durante eliminación',
      step: e?._step || 'sql',
      sql: e?._sql,
      details: e?.sqlMessage || e?.message || String(e),
      code: e?.code,
    });
  }
});

app.post('/cloudinary/sign-upload', authenticateToken, (req, res) => {
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

// Tenant profile Endpoints

// POST Crear o actualizar perfil de rentero
app.post('/api/tenant-profile', authenticateToken, (req, res) => {
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

app.get('/api/tenant-profile/:user_id', authenticateToken, (req, res) => {
  const { user_id } = req.params;
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

// PUT: Actualizar cualquier campo del perfil de rentero del usuario autenticado
app.put('/api/tenant-profile/:id', authenticateToken, (req, res) => {
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

app.get('/api/places/autocomplete', async (req, res) => {
  try {
    const input = req.query.input?.toString() || '';
    if (!input) return res.status(400).json({ error: 'input requerido' });

    const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
    url.searchParams.set('input', input);
    url.searchParams.set('types', 'address');
    url.searchParams.set('components', 'country:mx');
    url.searchParams.set('language', 'es');
    url.searchParams.set('key', process.env.MAPS_KEY);

    const r = await fetch(url);
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error('[places/autocomplete] error', e);
    res.status(500).json({ error: 'fail' });
  }
});

app.get('/api/places/details', async (req, res) => {
  try {
    const place_id = req.query.place_id?.toString();
    if (!place_id) return res.status(400).json({ error: 'place_id requerido' });

    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', place_id);
    url.searchParams.set('fields', 'geometry,formatted_address');
    url.searchParams.set('key', process.env.MAPS_KEY);

    const r = await fetch(url);
    const data = await r.json();
    res.json(data); // result.geometry.location { lat, lng }
  } catch (e) {
    console.error('[places/details]', e);
    res.status(500).json({ error: 'fail' });
  }
});

app.get('/api/places/geocode', async (req, res) => {
  try {
    const address = req.query.address?.toString() || '';
    const country = (req.query.country || 'MX').toString();
    if (!address) return res.status(400).json({ error: 'address requerido' });

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('types', 'address');
    url.searchParams.set('components', `country:${country}`);
    url.searchParams.set('key', process.env.MAPS_KEY);

    const r = await fetch(url);
    const data = await r.json();

    // respuesta compacta (pero mantén status para el front)
    if (data.status === 'OK' && data.results?.length) {
      const r0 = data.results[0];
      return res.json({
        status: 'OK',
        result: {
          formatted_address: r0.formatted_address,
          geometry: { location: r0.geometry.location }
        }
      });
    }
    res.json({ status: data.status, results: [] });
  } catch (e) {
    console.error('[places/geocode]', e);
    res.status(500).json({ error: 'fail' });
  }
});

app.get('/api/places/reverse-geocode', async (req, res) => {
  try {
    const lat = req.query.lat?.toString();
    const lng = req.query.lng?.toString();
    const lang = (req.query.lang || 'es').toString();
    if (!lat || !lng) return res.status(400).json({ error: 'lat y lng requeridos' });

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('language', lang);
    url.searchParams.set('key', process.env.GOOGLE_PLACES_SERVER_KEY);

    const r = await fetch(url);
    const data = await r.json();
    if (data.status === 'OK' && data.results?.length) {
      const r0 = data.results[0];
      return res.json({ status: 'OK', result: { formatted_address: r0.formatted_address } });
    }
    res.json({ status: data.status, results: [] });
  } catch (e) {
    console.error('[places/reverse-geocode]', e);
    res.status(500).json({ error: 'fail' });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Stripe

// POST /payments/promote/create-intent
// Crear PaymentIntent para promocionar (100 MXN por 7 días)
app.post('/payments/promote/create-intent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { propertyId } = req.body || {};
    if (!propertyId) return res.status(400).json({ error: 'Falta propertyId' });

    // 1) Valida que la propiedad sea del usuario
    const [rows] = await pool.promise().query(
      'SELECT id, created_by FROM properties WHERE id=? LIMIT 1',
      [propertyId]
    );
    // Verifica si ya está promocionada
    const [prow] = await pool.promise().query(
      'SELECT promoted_until FROM properties WHERE id=? LIMIT 1',
      [propertyId]
    );
    const promotedUntil = Array.isArray(prow) && prow[0]?.promoted_until;
    if (promotedUntil && new Date(promotedUntil).getTime() > Date.now()) {
      return res.status(409).json({ error: 'already_promoted', message: 'La propiedad ya está promocionada.' });
    }
    const prop = Array.isArray(rows) && rows[0];
    if (!prop) return res.status(404).json({ error: 'Propiedad no encontrada' });
    if (String(prop.created_by) !== String(userId)) {
      return res.status(403).json({ error: 'No autorizad@' });
    }

    // 2) Crea registro en promotions
    const amount = 10000; // 100 MXN en centavos
    const currency = 'mxn';
    const [ins] = await pool.promise().query(
      `INSERT INTO promotions (property_id, user_id, amount_cents, currency, status)
       VALUES (?,?,?,?, 'pending')`,
      [propertyId, userId, amount, currency]
    );
    const promoId = ins.insertId;

    // 3) Crea PaymentIntent
    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        propertyId: String(propertyId),
        promotionId: String(promoId),
        userId: String(userId),
      },
    });

    // 4) Guarda el id del PI
    await pool.promise().query(
      'UPDATE promotions SET stripe_payment_intent=? WHERE id=?',
      [intent.id, promoId]
    );

    return res.json({ clientSecret: intent.client_secret });
  } catch (e) {
    console.error('[create-intent] error', e);
    return res.status(500).json({ error: 'No se pudo crear el intento de pago' });
  }
});

// ===============================
// ADMIN REVIEW SYSTEM (Listed)
// agent_type='admin' requerido
// ===============================

app.get('/admin/agents/pending', authenticateToken, requireAdmin, (req, res) => {
  pool.query(
    `SELECT id, name, last_name, email, phone, license, agent_type,
            agent_verification_status, created_at
     FROM users
     WHERE agent_type IN ('brokerage','individual','seller')
     AND agent_verification_status='pending'
     AND license IS NOT NULL AND license <> ''
     ORDER BY id DESC
     LIMIT 500`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Error consultando agentes' });
      res.json(rows);
    }
  );
});

app.post('/admin/agents/:id/approve', authenticateToken, requireAdmin, (req, res) => {
  const agentId = Number(req.params.id);
  const adminId = req.user.id;

  pool.query(
    `UPDATE users
      SET agent_verification_status='verified',
          agent_verified_at=NOW(),
          agent_verified_by=?,
          agent_verification_notes=NULL
     WHERE id=? AND agent_type!='regular' AND agent_type!='admin'`,
    [adminId, agentId],
    (err, r) => {
      if (err) return res.status(500).json({ error: 'Error aprobando agente' });
      if (!r.affectedRows) return res.status(404).json({ error: 'Agente no encontrado' });
      res.json({ ok: true });
    }
  );
});

app.post('/admin/agents/:id/reject', authenticateToken, requireAdmin, (req, res) => {
  const agentId = Number(req.params.id);
  const adminId = req.user.id;
  const { reason } = req.body || {};

  pool.query(
    `UPDATE users
     SET agent_verification_status='rejected',
         agent_verified_at=NOW(),
         agent_verified_by=?,
         agent_rejection_reason=?
     WHERE id=? AND agent_type!='regular' AND agent_type!='admin'`,
    [adminId, reason || null, agentId],
    (err, r) => {
      if (err) return res.status(500).json({ error: 'Error rechazando agente' });
      if (!r.affectedRows) return res.status(404).json({ error: 'Agente no encontrado' });
      res.json({ ok: true });
    }
  );
});


app.get('/admin/properties/pending', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT
      p.*,
      u.name AS owner_name,
      u.last_name AS owner_last_name,
      u.email AS owner_email,
      -- images como JSON (o string JSON si tu MySQL no soporta CAST AS JSON)
      COALESCE(img.images, '[]') AS images
    FROM properties p
    JOIN users u ON u.id = p.created_by
    LEFT JOIN (
      SELECT
        property_id,
        CONCAT(
          '[',
          GROUP_CONCAT(JSON_QUOTE(image_url) ORDER BY id ASC SEPARATOR ','),
          ']'
        ) AS images
      FROM property_images
      WHERE image_url IS NOT NULL AND image_url <> ''
      GROUP BY property_id
    ) img ON img.property_id = p.id
    WHERE p.review_status = 'pending'
      AND p.is_published = 0
    ORDER BY p.id DESC
    LIMIT 500
  `;

  pool.query(sql, [], (err, rows) => {
    if (err) {
      console.error('[admin/properties/pending] error', err);
      return res.status(500).json({ error: 'Error consultando propiedades' });
    }
    res.json(rows);
  });
});

app.post('/admin/properties/:id/approve', authenticateToken, requireAdmin, (req, res) => {
  const propertyId = Number(req.params.id);
  const adminId = req.user.id;
  const { notes } = req.body || {};

  pool.query(
    `UPDATE properties
     SET review_status='approved',
         is_published=1,
         reviewed_at=NOW(),
         reviewed_by=?,
         review_notes=?
     WHERE id=? AND review_status='pending'`,
    [adminId, notes || null, propertyId],
    (err, r) => {
      if (err) return res.status(500).json({ error: 'Error aprobando propiedad' });
      if (!r.affectedRows) return res.status(404).json({ error: 'Propiedad no encontrada o no está pending' });
      res.json({ ok: true });
    }
  );
});

app.post('/admin/properties/:id/reject', authenticateToken, requireAdmin, (req, res) => {
  const propertyId = Number(req.params.id);
  const adminId = req.user.id;
  const { notes } = req.body || {};

  pool.query(
    `UPDATE properties
     SET review_status='rejected',
         is_published=0,
         reviewed_at=NOW(),
         reviewed_by=?,
         review_notes=?
     WHERE id=? AND review_status='pending'`,
    [adminId, notes || null, propertyId],
    (err, r) => {
      if (err) return res.status(500).json({ error: 'Error rechazando propiedad' });
      if (!r.affectedRows) return res.status(404).json({ error: 'Propiedad no encontrada o no está pending' });
      res.json({ ok: true });
    }
  );
});
