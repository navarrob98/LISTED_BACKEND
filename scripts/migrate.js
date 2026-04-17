#!/usr/bin/env node
/**
 * Runner simple de migraciones SQL.
 *
 * Uso:
 *   node scripts/migrate.js                     → corre todas las migraciones en migrations/
 *   node scripts/migrate.js 001_stripe_events   → corre solo esa migración
 *
 * Usa las mismas credenciales que el backend (temporary.env o env de Railway).
 * Corre contra la DB configurada en MYSQLHOST/MYSQLUSER/MYSQLPASSWORD/MYSQLDATABASE.
 *
 * Registra migraciones ejecutadas en la tabla `schema_migrations` para idempotencia:
 * re-correrlo no duplica trabajo.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.resolve(__dirname, '..', 'temporary.env') });

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function main() {
  const target = process.argv[2]; // opcional: nombre específico (sin .sql)

  // Soporta 3 formas de conectar:
  // 1. MYSQL_MIGRATION_URL (recomendado local): URL pública de Railway
  //    ej. mysql://user:pass@host.proxy.rlwy.net:54321/railway
  // 2. MYSQL_URL: alias (Railway a veces expone esto)
  // 3. MYSQLHOST/MYSQLUSER/... (cuando corres DENTRO de Railway o DB local)
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
  } else {
    if (!process.env.MYSQLHOST) {
      console.error('[migrate] No hay credenciales. Define MYSQL_MIGRATION_URL o MYSQLHOST+MYSQLUSER+...');
      console.error('         Obtén MYSQL_MIGRATION_URL de Railway dashboard:');
      console.error('         MySQL service → Variables → Copy MYSQL_PUBLIC_URL');
      process.exit(1);
    }
    connConfig = {
      host: process.env.MYSQLHOST,
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      port: Number(process.env.MYSQLPORT) || 3306,
    };
  }

  const conn = await mysql.createConnection({
    ...connConfig,
    multipleStatements: true,
    ssl: process.env.MYSQL_SSL === 'false' ? undefined : { rejectUnauthorized: false },
  });

  console.log(`[migrate] connected to ${connConfig.host}/${connConfig.database}`);

  // Tabla de tracking — se auto-crea si no existe
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`[migrate] migrations dir not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[migrate] no migrations found');
    await conn.end();
    return;
  }

  const filtered = target
    ? files.filter((f) => f.replace(/\.sql$/, '') === target || f === target)
    : files;

  if (filtered.length === 0) {
    console.error(`[migrate] target "${target}" not found`);
    process.exit(1);
  }

  let applied = 0;
  for (const file of filtered) {
    const name = file.replace(/\.sql$/, '');
    const [rows] = await conn.query('SELECT 1 FROM schema_migrations WHERE name = ? LIMIT 1', [name]);
    if (Array.isArray(rows) && rows.length > 0) {
      console.log(`[migrate]  ⏭  ${name} — already applied, skipping`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate]  →  applying ${name}...`);
    try {
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [name]);
      console.log(`[migrate]  ✓  ${name} applied`);
      applied++;
    } catch (e) {
      console.error(`[migrate]  ✗  ${name} FAILED:`, e.message);
      await conn.end();
      process.exit(1);
    }
  }

  console.log(`[migrate] done. ${applied} migration(s) applied.`);
  await conn.end();
}

main().catch((e) => {
  console.error('[migrate] fatal:', e);
  process.exit(1);
});
