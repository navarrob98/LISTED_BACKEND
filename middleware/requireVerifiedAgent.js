const mysql = require('mysql2');

// Este middleware necesita acceso al pool. Lo hacemos factory:
module.exports = function requireVerifiedAgentFactory(pool) {
  return function requireVerifiedAgent(req, res, next) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'No autorizado' });

    pool.query(
      `SELECT agent_type, agent_verification_status
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error verificando permisos' });
        if (!rows.length) return res.status(401).json({ error: 'Usuario no encontrado' });

        const u = rows[0];

        // Si no es agente, no aplica restricción de publicación por verificación
        // (puedes ajustar si también quieres bloquear a "regular" para publicar)
        const isAgent = u.agent_type && u.agent_type !== 'regular';

        if (!isAgent) return next();

        if (u.agent_verification_status !== 'verified') {
            return res.status(403).json({
              error: 'agent_not_verified',
              message: 'Tu agente no está verificado. Agrega tu licencia para solicitar verificación.',
              agent_verification_status: u.agent_verification_status,
            });
          }
          

        return next();
      }
    );
  };
};
