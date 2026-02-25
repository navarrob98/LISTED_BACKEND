const { waitForNominatimSlot, getCached, setCache, TTL_7D } = require('./geoCache');

function cityKey(lat, lng) {
  const lat5 = Number(lat).toFixed(5);
  const lng5 = Number(lng).toFixed(5);
  return `geo:city:${lat5}:${lng5}`;
}

async function extractCityFromCoords(lat, lng) {
  if (lat == null || lng == null) return null;

  const key = cityKey(lat, lng);
  const cached = await getCached(key);
  if (cached !== null) return cached;

  await waitForNominatimSlot();

  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Listed-App/1.0' },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const addr = data.address || {};
  let city = addr.city || addr.town || addr.municipality || addr.county || null;

  // "Municipio de Tijuana" → "Tijuana", "Municipio de Playas de Rosarito" → "Playas de Rosarito"
  if (city) city = city.replace(/^Municipio de\s+/i, '');

  if (city) await setCache(key, city, TTL_7D);
  return city;
}

module.exports = { extractCityFromCoords };
