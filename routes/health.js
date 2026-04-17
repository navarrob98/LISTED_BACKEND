/**
 * Health check endpoints para Railway / orquestadores.
 *
 * - GET /health — liveness (proceso está vivo, responde HTTP)
 * - GET /ready  — readiness (MySQL + Redis responden → listo para tráfico)
 *
 * Railway usa estos para detectar pods zombies. Un 503 en /ready dispara restart.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const redis = require('../db/redis');

router.get('/health', (_req, res) => {
  // Liveness: si este handler corre, el event loop no está bloqueado.
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

router.get('/ready', async (_req, res) => {
  const checks = { mysql: false, redis: false };
  const timeoutMs = 2000;

  const withTimeout = (p, label) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
  ]);

  // MySQL: SELECT 1
  try {
    await withTimeout(pool.promise().query('SELECT 1'), 'mysql');
    checks.mysql = true;
  } catch (e) {
    console.error('[ready] mysql failed:', e.message);
  }

  // Redis: PING
  try {
    await withTimeout(redis.ping(), 'redis');
    checks.redis = true;
  } catch (e) {
    console.error('[ready] redis failed:', e.message);
  }

  const ok = checks.mysql && checks.redis;
  res.status(ok ? 200 : 503).json({ ok, checks });
});

module.exports = router;
