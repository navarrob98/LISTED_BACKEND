const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const pool = require('../db/pool');
const redis = require('../db/redis');

// TTL del dedup de last_ip: dentro de esta ventana no toca MySQL si la IP no cambió.
const LAST_IP_DEDUP_TTL = 3600; // 1 hora

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });

  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, async (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expirado.', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Token inválido.', code: 'TOKEN_INVALID' });
    }

    // Verificar ban por usuario
    try {
      const [[row]] = await pool.promise().query(
        'SELECT is_banned FROM users WHERE id = ? LIMIT 1', [user.id]
      );
      if (row && row.is_banned) {
        return res.status(403).json({ error: 'Tu cuenta ha sido suspendida.', code: 'ACCOUNT_BANNED' });
      }

      // Verificar ban por IP (sincrono — afecta respuesta)
      const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim();
      if (clientIp) {
        const [[banned]] = await pool.promise().query(
          'SELECT id FROM banned_ips WHERE ip = ? LIMIT 1', [clientIp]
        );
        if (banned) {
          return res.status(403).json({ error: 'Acceso bloqueado.', code: 'IP_BANNED' });
        }

        // Actualizar last_ip — fire-and-forget + dedup Redis.
        // Si en la última hora ya registramos esta misma IP para este user, skipeamos MySQL.
        setImmediate(async () => {
          try {
            const dedupKey = `user:lastip:${user.id}`;
            const cachedIp = await redis.get(dedupKey).catch(() => null);
            if (cachedIp === clientIp) return; // no cambió, evitar UPDATE
            pool.query(
              'UPDATE users SET last_ip = ? WHERE id = ? AND (last_ip IS NULL OR last_ip != ?)',
              [clientIp, user.id, clientIp]
            );
            redis.set(dedupKey, clientIp, 'EX', LAST_IP_DEDUP_TTL).catch(() => {});
          } catch {}
        });
      }
    } catch {}

    req.user = user;
    Sentry.setUser({ id: user.id });
    next();
  });
}

module.exports = authenticateToken;