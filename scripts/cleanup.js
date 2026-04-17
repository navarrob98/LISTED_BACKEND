#!/usr/bin/env node
/**
 * Cron job de mantenimiento diario.
 *
 * Tareas:
 *   1. Limpiar eventos Stripe > 60 días (ya no se necesitan para idempotencia)
 *   2. Limpiar refresh tokens revocados/expirados > 30 días
 *   3. Log de cuántos registros se limpiaron
 *
 * Configurado como servicio cron separado en Railway con:
 *   Start Command: node scripts/cleanup.js
 *   Cron Schedule: 0 0 * * *  (diario a medianoche UTC)
 *
 * Este proceso termina (process.exit) cuando acaba — Railway lo re-arranca según schedule.
 */

const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.resolve(__dirname, '..', 'temporary.env') });

async function main() {
  const startedAt = Date.now();

  // Misma lógica de conexión que migrate.js (soporta URL o vars individuales).
  const mysqlUrl = process.env.MYSQL_MIGRATION_URL || process.env.MYSQL_URL;
  let connConfig;
  if (mysqlUrl) {
    const u = new URL(mysqlUrl);
    connConfig = {
      host: u.hostname,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      port: Number(u.port) || 3306,
    };
  } else if (process.env.MYSQLHOST) {
    connConfig = {
      host: process.env.MYSQLHOST,
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      port: Number(process.env.MYSQLPORT) || 3306,
    };
  } else {
    console.error('[cleanup] No MySQL credentials found');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    ...connConfig,
    ssl: process.env.MYSQL_SSL === 'false' ? undefined : { rejectUnauthorized: false },
  });

  console.log(`[cleanup] connected to ${connConfig.host}/${connConfig.database}`);

  const results = {};

  // 1. stripe_events > 60 días
  try {
    const [r] = await conn.query(
      'DELETE FROM stripe_events WHERE processed_at < DATE_SUB(NOW(), INTERVAL 60 DAY)'
    );
    results.stripe_events = r.affectedRows;
    console.log(`[cleanup]  ✓  stripe_events: ${r.affectedRows} rows deleted`);
  } catch (e) {
    console.error('[cleanup]  ✗  stripe_events failed:', e.message);
  }

  // 2. refresh_tokens revocados o expirados > 30 días (si existe la tabla)
  try {
    const [r] = await conn.query(
      `DELETE FROM refresh_tokens
       WHERE (revoked_at IS NOT NULL OR expires_at < NOW())
         AND COALESCE(revoked_at, expires_at) < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    results.refresh_tokens = r.affectedRows;
    console.log(`[cleanup]  ✓  refresh_tokens: ${r.affectedRows} rows deleted`);
  } catch (e) {
    // Si la tabla no existe, skip silently
    if (!/doesn't exist|Unknown/i.test(e.message)) {
      console.error('[cleanup]  ✗  refresh_tokens failed:', e.message);
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[cleanup] done in ${durationMs}ms —`, JSON.stringify(results));

  await conn.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('[cleanup] fatal:', e);
  process.exit(1);
});
