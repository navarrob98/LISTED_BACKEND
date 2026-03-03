const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  // El token debe enviarse en el header Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // obtener solo el token

  if (!token) return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });

  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expirado.', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Token inválido.', code: 'TOKEN_INVALID' });
    }
    req.user = user;
    next();
  });
}

module.exports = authenticateToken;