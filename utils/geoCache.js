const redis = require('../db/redis');

// ── JSON cache helpers ───────────────────────────────────

async function getCached(key) {
  const raw = await redis.get(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setCache(key, data, ttlSeconds) {
  await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
}

// ── Nominatim distributed rate limiter (1 req/sec) ──────

const NOMINATIM_LOCK_KEY = 'geo:nominatim:last';

async function waitForNominatimSlot() {
  // Spin until at least 1 second has passed since last Nominatim request
  for (;;) {
    const now = Date.now();
    // SET NX with 1-second expiry acts as a distributed lock
    const acquired = await redis.set(NOMINATIM_LOCK_KEY, now, 'PX', 1100, 'NX');
    if (acquired) return; // slot acquired

    // Key exists → wait for remaining TTL
    const ttl = await redis.pttl(NOMINATIM_LOCK_KEY);
    const wait = ttl > 0 ? ttl : 100;
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ── Key builders ─────────────────────────────────────────

const TTL_24H = 86400;
const TTL_7D  = 604800;

function autocompleteKey(country, input) {
  return `geo:ac:${country.toLowerCase()}:${input.trim().toLowerCase()}`;
}

function geocodeKey(country, address) {
  return `geo:gc:${country.toLowerCase()}:${address.trim().toLowerCase()}`;
}

function reverseGeocodeKey(lat, lng) {
  const lat5 = Number(lat).toFixed(5);
  const lng5 = Number(lng).toFixed(5);
  return `geo:rg:${lat5}:${lng5}`;
}

function detailsKey(placeId) {
  return `geo:det:${placeId}`;
}

module.exports = {
  getCached,
  setCache,
  waitForNominatimSlot,
  TTL_24H,
  TTL_7D,
  autocompleteKey,
  geocodeKey,
  reverseGeocodeKey,
  detailsKey,
};
