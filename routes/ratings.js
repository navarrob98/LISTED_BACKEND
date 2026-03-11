const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const { sendPushToUser } = require('../utils/helpers');

const qp = (sql, params) => pool.promise().query(sql, params);

// Helper: recalcular y cachear avg_rating en users
async function refreshAgentRating(agentId) {
  const [[row]] = await qp(
    'SELECT AVG(score) AS avg, COUNT(*) AS cnt FROM agent_ratings WHERE agent_id = ?',
    [agentId]
  );
  const avg = row.avg ? Math.round(row.avg * 10) / 10 : null;
  const cnt = row.cnt || 0;
  await qp('UPDATE users SET avg_rating = ?, rating_count = ? WHERE id = ?', [avg, cnt, agentId]);
  return { avg, cnt };
}

// ────────────────────────────────────────────────
// POST /api/ratings
// Enviar calificación a un agente
// ────────────────────────────────────────────────
router.post('/api/ratings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { agent_id, property_id, appointment_id, type, score, comment } = req.body;

    if (!agent_id || !type || !score) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    if (!['appointment', 'transaction'].includes(type)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }
    const numScore = parseInt(score, 10);
    if (isNaN(numScore) || numScore < 1 || numScore > 5) {
      return res.status(400).json({ error: 'Score debe ser 1-5' });
    }
    if (String(userId) === String(agent_id)) {
      return res.status(400).json({ error: 'No puedes calificarte a ti mismo' });
    }

    // Verificar que el agente existe y es agente
    const [[agent]] = await qp(
      'SELECT id, agent_type FROM users WHERE id = ?', [agent_id]
    );
    if (!agent || !/^(individual|brokerage|seller)$/i.test(agent.agent_type || '')) {
      return res.status(404).json({ error: 'Agente no encontrado' });
    }

    // Validar según tipo
    if (type === 'appointment' && appointment_id) {
      const [[appt]] = await qp(
        'SELECT id, requester_id, agent_id, status FROM appointments WHERE id = ?',
        [appointment_id]
      );
      if (!appt || String(appt.requester_id) !== String(userId) || String(appt.agent_id) !== String(agent_id)) {
        return res.status(403).json({ error: 'Cita no válida' });
      }
      if (appt.status !== 'completed') {
        return res.status(400).json({ error: 'La cita debe estar completada' });
      }
    }

    // Insertar (IGNORE para no duplicar)
    const [result] = await qp(
      `INSERT IGNORE INTO agent_ratings (agent_id, user_id, property_id, appointment_id, type, score, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [agent_id, userId, property_id || null, appointment_id || null, type, numScore, (comment || '').trim().substring(0, 500) || null]
    );

    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'Ya calificaste a este agente por esta propiedad' });
    }

    const { avg, cnt } = await refreshAgentRating(agent_id);

    res.json({ ok: true, avg_rating: avg, rating_count: cnt });
  } catch (err) {
    console.error('[ratings/create]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// GET /api/ratings/agent/:agentId
// Rating público de un agente
// ────────────────────────────────────────────────
router.get('/api/ratings/agent/:agentId', authenticateToken, async (req, res) => {
  try {
    const agentId = req.params.agentId;
    const [[stats]] = await qp(
      'SELECT AVG(score) AS avg, COUNT(*) AS cnt FROM agent_ratings WHERE agent_id = ?',
      [agentId]
    );
    const avg = stats.avg ? Math.round(stats.avg * 10) / 10 : null;

    // Últimos reviews
    const [reviews] = await qp(
      `SELECT r.score, r.comment, r.type, r.created_at,
              u.name, u.last_name
       FROM agent_ratings r
       JOIN users u ON u.id = r.user_id
       WHERE r.agent_id = ?
       ORDER BY r.created_at DESC
       LIMIT 10`,
      [agentId]
    );

    res.json({
      avg_rating: avg,
      rating_count: stats.cnt || 0,
      reviews,
    });
  } catch (err) {
    console.error('[ratings/agent]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// GET /api/ratings/pending
// Ratings pendientes del usuario (citas completadas sin calificar)
// ────────────────────────────────────────────────
router.get('/api/ratings/pending', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // Citas completadas sin calificar
    const [appointmentRows] = await qp(
      `SELECT a.id AS appointment_id, a.agent_id, a.property_id,
              'appointment' AS pending_type,
              u.name AS agent_name, u.last_name AS agent_last_name, u.profile_photo AS agent_photo,
              p.address AS property_address
       FROM appointments a
       JOIN users u ON u.id = a.agent_id
       LEFT JOIN properties p ON p.id = a.property_id
       WHERE a.requester_id = ? AND a.status = 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM agent_ratings ar
           WHERE ar.user_id = ? AND ar.agent_id = a.agent_id
             AND ar.appointment_id = a.id AND ar.type = 'appointment'
         )
       ORDER BY a.appointment_date DESC`,
      [userId, userId]
    );

    // Tratos cerrados donde el usuario fue seleccionado, sin calificar aún
    const [dealRows] = await qp(
      `SELECT NULL AS appointment_id,
              COALESCE(p.managed_by, p.created_by) AS agent_id,
              p.id AS property_id,
              'transaction' AS pending_type,
              u.name AS agent_name, u.last_name AS agent_last_name, u.profile_photo AS agent_photo,
              p.address AS property_address
       FROM properties p
       JOIN users u ON u.id = COALESCE(p.managed_by, p.created_by)
       WHERE p.closed_by_client_id = ? AND p.closed_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_ratings ar
           WHERE ar.user_id = ? AND ar.agent_id = COALESCE(p.managed_by, p.created_by)
             AND ar.property_id = p.id AND ar.type = 'transaction'
         )
       ORDER BY p.closed_at DESC`,
      [userId, userId]
    );

    res.json([...appointmentRows, ...dealRows]);
  } catch (err) {
    console.error('[ratings/pending]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// GET /api/ratings/property/:propertyId/clients
// Clientes que chatearon por una propiedad (para seleccionar comprador al cerrar)
// ────────────────────────────────────────────────
router.get('/api/ratings/property/:propertyId/clients', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;
    const propertyId = req.params.propertyId;

    // Verificar que la propiedad pertenece al agente
    const [[prop]] = await qp(
      'SELECT id, created_by, managed_by FROM properties WHERE id = ?',
      [propertyId]
    );
    if (!prop || (String(prop.created_by) !== String(agentId) && String(prop.managed_by) !== String(agentId))) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Usuarios que enviaron mensajes sobre esta propiedad (excluyendo al agente y los que ya calificaron)
    const [clients] = await qp(
      `SELECT DISTINCT u.id, u.name, u.last_name, u.profile_photo
       FROM chat_messages cm
       JOIN users u ON u.id = cm.sender_id
       WHERE cm.property_id = ? AND cm.sender_id != ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_ratings ar
           WHERE ar.user_id = u.id AND ar.agent_id = ? AND ar.property_id = ?
         )
       ORDER BY u.name`,
      [propertyId, agentId, agentId, propertyId]
    );

    res.json(clients);
  } catch (err) {
    console.error('[ratings/clients]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ────────────────────────────────────────────────
// POST /api/ratings/close-deal
// Agente cierra trato: selecciona comprador y dispara rating
// ────────────────────────────────────────────────
router.post('/api/ratings/close-deal', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;
    const { property_id, client_id } = req.body;

    if (!property_id || !client_id) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    // Verificar propiedad
    const [[prop]] = await qp(
      'SELECT id, created_by, managed_by, listing_status FROM properties WHERE id = ?',
      [property_id]
    );
    if (!prop || (String(prop.created_by) !== String(agentId) && String(prop.managed_by) !== String(agentId))) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Verificar que el cliente no haya calificado ya por esta propiedad
    const [[existing]] = await qp(
      'SELECT id FROM agent_ratings WHERE user_id = ? AND agent_id = ? AND property_id = ?',
      [client_id, agentId, property_id]
    );
    if (existing) {
      return res.status(409).json({ error: 'Este cliente ya calificó por esta propiedad' });
    }

    // Guardar el cierre
    await qp(
      `UPDATE properties SET closed_by_client_id = ?, closed_at = NOW() WHERE id = ?`,
      [client_id, property_id]
    );

    // Enviar push al cliente para que califique
    sendPushToUser({
      userId: client_id,
      title: '¡Trato cerrado!',
      body: 'Califica tu experiencia con tu agente.',
      data: { type: 'rate_agent', agent_id: String(agentId), property_id: String(property_id) },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[ratings/close-deal]', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
