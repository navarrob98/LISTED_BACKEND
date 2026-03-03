const Redis = require('ioredis');

const redisOpts = {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
};

// Enable TLS for production Redis (e.g. rediss:// URLs or explicit flag)
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
if (process.env.REDIS_TLS === 'true' || redisUrl.startsWith('rediss://')) {
  redisOpts.tls = { rejectUnauthorized: false };
}

const redis = new Redis(redisUrl, redisOpts);

redis.on('connect', () => console.log('[redis] connected'));
redis.on('error', (err) => console.error('[redis] error', err.message));

module.exports = redis;
