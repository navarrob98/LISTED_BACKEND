require('dotenv').config({ path: 'temporary.env' });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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

// ── CORS ──────────────────────────────────────────────
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
const io = new Server(server, { cors: { origin: '*' } });

// ── Socket.io Redis adapter (multi-worker pub/sub) ──
const pubClient = redis.duplicate();
const subClient = redis.duplicate();
io.adapter(createAdapter(pubClient, subClient));

// ── Socket.io JWT authentication middleware ──
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('auth_required'));
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('invalid_token'));
    socket.data.userId = String(decoded.id);
    socket.data.user = decoded;
    next();
  });
});

initSockets(io, pool, helpers);

// ── Global error handler ──────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Graceful shutdown ────────────────────────────────────
function gracefulShutdown() {
  server.close(() => {
    io.close(() => {
      redis.quit().then(() => {
        pool.end(() => process.exit(0));
      });
    });
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ── Start ─────────────────────────────────────────────
server.listen(port, '0.0.0.0', () => {
  console.log(`Backend server + Socket.io listening on port ${port}`);
});
