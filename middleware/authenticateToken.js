const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  // El token debe enviarse en el header Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // obtener solo el token

  if (!token) return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado.' });
    // Puedes agregar la info del usuario decodificado a la request para usarla después
    req.user = user;
    next(); // continúa con la siguiente función en la ruta
  });
}

module.exports = authenticateToken;