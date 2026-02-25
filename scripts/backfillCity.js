/**
 * Backfill city column for existing properties with lat/lng.
 * Run once: node scripts/backfillCity.js
 * Rate-limited by waitForNominatimSlot (~1 req/sec).
 */
const pool = require('../db/pool');
const { extractCityFromCoords } = require('../utils/extractCity');

function q(sql, params) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function main() {
  const rows = await q(
    'SELECT id, lat, lng FROM properties WHERE city IS NULL AND lat IS NOT NULL AND lng IS NOT NULL'
  );
  console.log(`[backfill] ${rows.length} properties to process`);

  let updated = 0;
  for (const row of rows) {
    try {
      const city = await extractCityFromCoords(row.lat, row.lng);
      if (city) {
        await q('UPDATE properties SET city = ? WHERE id = ?', [city, row.id]);
        updated++;
        console.log(`  #${row.id} → ${city}`);
      } else {
        console.log(`  #${row.id} → (no city found)`);
      }
    } catch (err) {
      console.error(`  #${row.id} ERROR:`, err.message);
    }
  }

  console.log(`[backfill] Done. Updated ${updated}/${rows.length}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
