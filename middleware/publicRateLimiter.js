/**
 * Rate limiters compartidos para endpoints públicos (sin auth).
 *
 * Usa Redis para ser multi-instancia seguro. Los valores son generosos para no
 * afectar UX legítima pero sí cortar scanners/scrapers automatizados.
 *
 * Nota: detrás de Cloudflare/Railway proxy, `trust proxy` debe estar set en app.js
 * (ya lo está) para que `req.ip` sea el client real, no el proxy.
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const redis = require('../db/redis');

function makeLimiter(prefix, windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => redis.infra.call(...args),
      prefix: `rl:${prefix}:`,
    }),
    handler: (_req, res) => res.status(429).json({
      error: message || 'Demasiadas peticiones. Intenta en unos minutos.',
    }),
  });
}

// Geo APIs (geocode/autocomplete/reverse/details): usuario real teclea, no
// debería pasar de ~10 req/min. 60/min permite búsquedas activas + debounce.
// Un scanner que pide 1000/min queda bloqueado.
const geoLimiter = makeLimiter('geo', 60 * 1000, 60, 'Demasiadas búsquedas. Intenta en un minuto.');

// Property search/list público: scroll rápido puede quemar 10-20 req/min.
// 120/min cubre browsing intenso.
const publicSearchLimiter = makeLimiter('psearch', 60 * 1000, 120);

// Property detail público: usuarios abren 1-2/min típicamente, pero share/social
// pueden causar picos. 300/min es holgado.
const publicDetailLimiter = makeLimiter('pdetail', 60 * 1000, 300);

// Registro de agente: operación cara (bcrypt + email). Limitamos fuerte para
// prevenir spam de cuentas. Alineado con /users/register en auth.js (5/30min).
const agentRegisterLimiter = makeLimiter('agentreg', 30 * 60 * 1000, 5, 'Demasiados registros. Intente más tarde.');

module.exports = {
  geoLimiter,
  publicSearchLimiter,
  publicDetailLimiter,
  agentRegisterLimiter,
};
