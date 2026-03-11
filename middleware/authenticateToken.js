const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const pool = require('../db/pool');

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

      // Guardar IP y verificar ban por IP
      const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim();
      if (clientIp) {
        pool.query('UPDATE users SET last_ip = ? WHERE id = ? AND (last_ip IS NULL OR last_ip != ?)',
          [clientIp, user.id, clientIp]);
        const [[banned]] = await pool.promise().query(
          'SELECT id FROM banned_ips WHERE ip = ? LIMIT 1', [clientIp]
        );
        if (banned) {
          return res.status(403).json({ error: 'Acceso bloqueado.', code: 'IP_BANNED' });
        }
      }
    } catch {}

    req.user = user;
    Sentry.setUser({ id: user.id });
    next();
  });
}

module.exports = authenticateToken;