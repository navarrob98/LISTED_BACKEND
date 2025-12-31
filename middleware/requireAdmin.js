module.exports = function requireAdmin(req, res, next) {
    // En tu sistema, usamos agent_type='admin'
    const agentType = req.user?.agent_type;
  
    if (agentType === 'admin') return next();
    return res.status(403).json({ error: 'No autorizado (admin requerido).' });
  };
  