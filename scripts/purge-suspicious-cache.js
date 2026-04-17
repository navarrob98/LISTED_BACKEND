#!/usr/bin/env node
/**
 * Borra keys de cache envenenadas por intentos de ataque.
 *
 * Escanea geo:gc:*, geo:ac:*, geo:rg:* y detecta payloads sospechosos
 * (URLs, paths del filesystem, endpoints IMDS). NO toca refresh tokens ni
 * rate limits.
 *
 * Uso:
 *   railway run node scripts/purge-suspicious-cache.js          → dry run (solo lista)
 *   railway run node scripts/purge-suspicious-cache.js --apply  → borra
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', 'temporary.env') });
const Redis = require('ioredis');

const apply = process.argv.includes('--apply');
const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const tlsOpts = url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {};

const redis = new Redis(url, { ...tlsOpts });

const PATTERNS = ['geo:gc:*', 'geo:ac:*', 'geo:rg:*'];

function isSuspiciousKey(key) {
  // Extrae la "cola" después del prefijo: geo:gc:mx:<ADDRESS>
  const parts = key.split(':');
  const payload = parts.slice(3).join(':');
  if (!payload) return false;
  if (payload.length > 200) return true;
  if (/[<>"'`;|$(){}[\]\\]/.test(payload)) return true;
  if (/^\s*(file|http|https|ftp|gopher|dict|data):/i.test(payload)) return true;
  if (/\.\.[/\\]/.test(payload)) return true;
  if (/%2e%2e/i.test(payload)) return true;
  if (/\/(etc|root|proc|sys|var|home)\//i.test(payload)) return true;
  if (/\b(169\.254|100\.100|metadata\.google|169-254)/i.test(payload)) return true;
  if (/\b(aws|iam|security-credentials|computeMetadata|service-account)\b/i.test(payload)) return true;
  return false;
}

async function main() {
  console.log(`[purge] connected. mode: ${apply ? 'APPLY (will delete)' : 'DRY RUN'}`);
  let scanned = 0;
  let matched = 0;
  let deleted = 0;

  for (const pattern of PATTERNS) {
    const stream = redis.scanStream({ match: pattern, count: 500 });
    await new Promise((resolve, reject) => {
      stream.on('data', async (keys) => {
        if (!keys.length) return;
        scanned += keys.length;
        const bad = keys.filter(isSuspiciousKey);
        matched += bad.length;
        for (const k of bad) {
          console.log(`  ⚠  ${k.slice(0, 150)}${k.length > 150 ? '...' : ''}`);
        }
        if (apply && bad.length) {
          stream.pause();
          try {
            await redis.del(...bad);
            deleted += bad.length;
          } catch (e) {
            console.error('[purge] del failed:', e.message);
          }
          stream.resume();
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }

  console.log(`[purge] scanned=${scanned} suspicious=${matched} deleted=${deleted}`);
  if (!apply && matched > 0) console.log('[purge] re-run with --apply to delete.');
  await redis.quit();
}

main().catch((e) => {
  console.error('[purge] fatal:', e);
  process.exit(1);
});
