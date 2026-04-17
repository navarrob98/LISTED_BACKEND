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

// Stale-while-revalidate: guarda `data` + `staleAfter` timestamp.
// Si el cliente llama durante la ventana fresca, devuelve data directo.
// Si está fresco-pero-vencido, devuelve data igual y marca para refresco en background.
async function setCacheSWR(key, data, freshSeconds, staleSeconds) {
  const payload = {
    data,
    staleAfter: Date.now() + freshSeconds * 1000,
  };
  // TTL total = fresh + stale (después se expira por completo)
  await redis.set(key, JSON.stringify(payload), 'EX', freshSeconds + staleSeconds);
}

async function getCachedSWR(key) {
  const raw = await redis.get(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    // Envelope check: entries escritas por el viejo setCache() no tienen
    // `staleAfter` — tratamos como miss para que se rehidrate con envelope válido.
    if (!parsed || typeof parsed.staleAfter !== 'number' || parsed.data === undefined) {
      return null;
    }
    return { data: parsed.data, isStale: Date.now() > parsed.staleAfter };
  } catch {
    return null;
  }
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
const TTL_1Y  = 365 * 86400; // 1 año — para ciudades que nunca cambian de coordenadas

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

function cityKey(normalizedName) {
  return `geo:city:mx:${normalizedName}`;
}

module.exports = {
  getCached,
  setCache,
  getCachedSWR,
  setCacheSWR,
  waitForNominatimSlot,
  TTL_24H,
  TTL_7D,
  TTL_1Y,
  autocompleteKey,
  geocodeKey,
  reverseGeocodeKey,
  detailsKey,
  cityKey,
};
