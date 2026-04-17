require('dotenv').config({ path: 'temporary.env' });
const Sentry = require('./utils/sentry');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');

const pool = require('./db/pool');
const redis = require('./db/redis');
const helpers = require('./utils/helpers');
const registerRoutes = require('./routes');
const initSockets = require('./sockets');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3001;

// ── Security headers ─────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────
// Lista de orígenes allow-listed. Orígenes nuevos se agregan vía env var
// CORS_EXTRA_ORIGINS (CSV) sin necesidad de cambiar código — útil para:
//   - dominios de Railway auto-generados (https://*.up.railway.app)
//   - subdominios internos (admin.listed.com.mx)
//   - staging URLs temporales
const defaultOrigins = [
  'https://listed.com.mx',
  'https://www.listed.com.mx',
  'https://app.listed.com.mx',
  'https://admin.listed.com.mx',
];

const devOrigins = [
  'http://localhost:19006',
  'http://localhost:3000',
  'http://localhost:3001',
];

const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  ...defaultOrigins,
  ...(process.env.NODE_ENV === 'production' ? [] : devOrigins),
  ...extraOrigins,
];

// Permite cualquier subdominio *.up.railway.app (útil para previews / deploys temporales).
// Si no quieres esto en prod, comenta el regex.
const railwayRegex = /^https:\/\/[\w-]+\.up\.railway\.app$/;

app.use(cors({
  origin: function(origin, cb) {
    // requests sin origin (Postman, server-to-server, same-origin) deben pasar
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (railwayRegex.test(origin)) return cb(null, true);
    console.warn('[cors] blocked origin:', origin);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
}));

app.options(/.*/, cors());

// ── Routes (express.json() applied inside registerRoutes, after Stripe webhook) ──
registerRoutes(app);

// ── DB check ──────────────────────────────────────────
pool.getConnection((err, connection) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    return;
  }
  console.log('Connected to MySQL database!');
  connection.release();
});

// ── HTTP + Socket.io ──────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ['GET', 'POST'] } });

// ── Socket.io Redis adapter (multi-worker pub/sub) ──
// Use the infra client (enableOfflineQueue: true) so psubscribe/subscribe
// issued by the adapter constructor queue up until Redis connects.
const pubClient = redis.infra.duplicate();
const subClient = redis.infra.duplicate();
io.adapter(createAdapter(pubClient, subClient));

// ── Socket.io JWT authentication middleware ──
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('auth_required'));
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, decoded) => {
    if (err) return next(new Error('invalid_token'));
    socket.data.userId = String(decoded.id);
    socket.data.user = decoded;
    next();
  });
});

initSockets(io, pool, helpers);
require('./routes/appointments').setIo(io);
require('./routes/chat').setIo(io);

// ── Global error handler ──────────────────────────────
app.use((err, req, res, next) => {
  Sentry.captureException(err);
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Graceful shutdown ────────────────────────────────────
function gracefulShutdown() {
  Sentry.close(2000).finally(() => {
    server.close(() => {
      io.close(() => {
        redis.quit().then(() => {
          pool.end(() => process.exit(0));
        });
      });
    });
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  console.error('Uncaught Exception:', err);
  gracefulShutdown();
});

// ── Start ─────────────────────────────────────────────
server.listen(port, '0.0.0.0', () => {
  console.log(`Backend server + Socket.io listening on port ${port}`);
});
