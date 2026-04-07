const Redis = require('ioredis');

// ── Shared retry strategy ────────────────────────────────────────────────────
function retryStrategy(times) {
  if (times > 30) return null; // stop reconnecting after ~2.5 min of attempts
  return Math.min(times * 200, 5000);
}

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const tlsOpts = (process.env.REDIS_TLS === 'true' || redisUrl.startsWith('rediss://'))
  ? { tls: { rejectUnauthorized: false } }
  : {};

// ── Main caching client — fail fast (no queue) ───────────────────────────────
// Used for AI response caching, session tokens, etc.
// Commands fail immediately when Redis is down so try/catch handlers take over.
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  retryStrategy,
  ...tlsOpts,
});

redis.on('connect', () => console.log('[redis] connected'));
redis.on('error', (err) => console.error('[redis] error', err.message));

// ── Infra client — queuing (for rate limiters + socket.io adapter) ───────────
// Used by rate-limit-redis and @socket.io/redis-adapter.  These components load
// Lua scripts and subscribe to channels in their constructors at startup, before
// Redis is available.  With enableOfflineQueue: true, commands are buffered until
// the connection is established rather than failing immediately.
const redisInfra = new Redis(redisUrl, {
  retryStrategy,
  ...tlsOpts,
});

redisInfra.on('error', (err) => console.error('[redis-infra] error', err.message));

module.exports = redis;
module.exports.infra = redisInfra;
