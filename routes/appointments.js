const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const { sendPushToUser } = require('../utils/helpers');

// POST /api/appointments
router.post('/api/appointments', authenticateToken, async (req, res) => {
  try {
    const requesterId = req.user.id;
    const { property_id, appointment_date, appointment_time, notes } = req.body;

    if (!property_id || !appointment_date || !appointment_time) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    // Validar que la propiedad existe y obtener el agente
    const [propRows] = await pool.promise().query(
      'SELECT id, created_by, address, type, price FROM properties WHERE id = ? AND is_published = 1',
      [property_id]
    );

    if (!propRows.length) {
      return res.status(404).json({ error: 'Propiedad no encontrada' });
    }

    const property = propRows[0];
    const agentId = property.created_by;

    // Validar que no sea el propio agente solicitando
    if (String(agentId) === String(requesterId)) {
      return res.status(400).json({ error: 'No puedes agendar cita en tu propia propiedad' });
    }

    // Validar que la fecha no sea en el pasado
    const appointmentDateTime = new Date(`${appointment_date} ${appointment_time}`);
    if (appointmentDateTime < new Date()) {
      return res.status(400).json({ error: 'No puedes agendar citas en el pasado' });
    }

    // Verificar si ya existe una cita activa para este usuario/propiedad en el mismo horario
    const [existing] = await pool.promise().query(
      `SELECT id FROM appointments
       WHERE property_id = ?
         AND requester_id = ?
         AND appointment_date = ?
         AND appointment_time = ?
         AND status IN ('pending', 'confirmed')
       LIMIT 1`,
      [property_id, requesterId, appointment_date, appointment_time]
    );

    if (existing.length) {
      return res.status(409).json({ error: 'Ya tienes una cita agendada para este horario' });
    }

    // Crear la cita
    const [result] = await pool.promise().query(
      `INSERT INTO appointments (property_id, requester_id, agent_id, appointment_date, appointment_time, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [property_id, requesterId, agentId, appointment_date, appointment_time, notes || null]
    );

    // Enviar notificación push al agente
    try {
      const [requesterRows] = await pool.promise().query(
        'SELECT name, last_name FROM users WHERE id = ? LIMIT 1',
        [requesterId]
      );
      const requesterName = requesterRows[0] ? `${requesterRows[0].name} ${requesterRows[0].last_name}` : 'Un usuario';

      await sendPushToUser({
        userId: agentId,
        title: 'Nueva solicitud de cita',
        body: `${requesterName} quiere agendar una cita para ver "${property.address}"`,
        data: {
          type: 'appointment',
          appointmentId: String(result.insertId),
          propertyId: String(property_id)
        }
      });
    } catch (pushErr) {
      console.error('[appointments] push error', pushErr);
    }

    res.status(201).json({
      ok: true,
      appointmentId: result.insertId,
      message: 'Cita solicitada correctamente'
    });
  } catch (e) {
    console.error('[POST /api/appointments] error', e);
    res.status(500).json({ error: 'Error al crear la cita' });
  }
});

// GET /api/appointments
router.get('/api/appointments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { role } = req.query; // 'requester' | 'agent' | undefined (ambos)

    let whereClause = '';
    let params = [];

    if (role === 'requester') {
      whereClause = 'WHERE a.requester_id = ?';
      params = [userId];
    } else if (role === 'agent') {
      whereClause = 'WHERE a.agent_id = ?';
      params = [userId];
    } else {
      whereClause = 'WHERE (a.requester_id = ? OR a.agent_id = ?)';
      params = [userId, userId];
    }

    const sql = `
      SELECT
        a.*,
        p.address AS property_address,
        p.type AS property_type,
        p.price AS property_price,
        p.monthly_pay AS property_monthly_pay,
        req.name AS requester_name,
        req.last_name AS requester_last_name,
        req.email AS requester_email,
        req.phone AS requester_phone,
        ag.name AS agent_name,
        ag.last_name AS agent_last_name,
        ag.email AS agent_email,
        ag.phone AS agent_phone
      FROM appointments a
      JOIN properties p ON p.id = a.property_id
      JOIN users req ON req.id = a.requester_id
      JOIN users ag ON ag.id = a.agent_id
      ${whereClause}
      ORDER BY a.appointment_date DESC, a.appointment_time DESC
    `;

    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('[GET /api/appointments] error', e);
    res.status(500).json({ error: 'Error al obtener citas' });
  }
});

// GET /api/appointments/:id
router.get('/api/appointments/:id', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const userId = req.user.id;

    const sql = `
      SELECT
        a.*,
        p.address AS property_address,
        p.type AS property_type,
        p.price AS property_price,
        p.monthly_pay AS property_monthly_pay,
        req.name AS requester_name,
        req.last_name AS requester_last_name,
        req.email AS requester_email,
        req.phone AS requester_phone,
        ag.name AS agent_name,
        ag.last_name AS agent_last_name,
        ag.email AS agent_email,
        ag.phone AS agent_phone
      FROM appointments a
      JOIN properties p ON p.id = a.property_id
      JOIN users req ON req.id = a.requester_id
      JOIN users ag ON ag.id = a.agent_id
      WHERE a.id = ?
        AND (a.requester_id = ? OR a.agent_id = ?)
      LIMIT 1
    `;

    const [rows] = await pool.promise().query(sql, [appointmentId, userId, userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /api/appointments/:id] error', e);
    res.status(500).json({ error: 'Error al obtener la cita' });
  }
});

// PUT /api/appointments/:id/confirm
router.put('/api/appointments/:id/confirm', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const userId = req.user.id;

    const [rows] = await pool.promise().query(
      'SELECT id, agent_id, requester_id, status, property_id FROM appointments WHERE id = ? LIMIT 1',
      [appointmentId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    const appointment = rows[0];

    if (String(appointment.agent_id) !== String(userId)) {
      return res.status(403).json({ error: 'Solo el agente puede confirmar la cita' });
    }

    if (appointment.status !== 'pending') {
      return res.status(400).json({ error: 'Solo se pueden confirmar citas pendientes' });
    }

    await pool.promise().query(
      'UPDATE appointments SET status = "confirmed", updated_at = NOW() WHERE id = ?',
      [appointmentId]
    );

    // Notificar al solicitante
    try {
      await sendPushToUser({
        userId: appointment.requester_id,
        title: 'Cita confirmada!',
        body: 'Tu cita ha sido confirmada por el agente',
        data: {
          type: 'appointment',
          appointmentId: String(appointmentId),
          propertyId: String(appointment.property_id)
        }
      });
    } catch (pushErr) {
      console.error('[appointments/confirm] push error', pushErr);
    }

    res.json({ ok: true, message: 'Cita confirmada' });
  } catch (e) {
    console.error('[PUT /api/appointments/:id/confirm] error', e);
    res.status(500).json({ error: 'Error al confirmar la cita' });
  }
});

// PUT /api/appointments/:id/cancel
router.put('/api/appointments/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const userId = req.user.id;
    const { cancellation_reason } = req.body;

    const [rows] = await pool.promise().query(
      'SELECT id, agent_id, requester_id, status, property_id FROM appointments WHERE id = ? LIMIT 1',
      [appointmentId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    const appointment = rows[0];

    // Verificar que el usuario sea parte de la cita
    if (String(appointment.agent_id) !== String(userId) && String(appointment.requester_id) !== String(userId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (appointment.status === 'cancelled' || appointment.status === 'completed') {
      return res.status(400).json({ error: 'No se puede cancelar esta cita' });
    }

    await pool.promise().query(
      'UPDATE appointments SET status = "cancelled", cancellation_reason = ?, updated_at = NOW() WHERE id = ?',
      [cancellation_reason || null, appointmentId]
    );

    // Notificar a la otra parte
    const notifyUserId = String(userId) === String(appointment.agent_id)
      ? appointment.requester_id
      : appointment.agent_id;

    try {
      await sendPushToUser({
        userId: notifyUserId,
        title: 'Cita cancelada',
        body: cancellation_reason || 'Se ha cancelado una de tus citas',
        data: {
          type: 'appointment',
          appointmentId: String(appointmentId),
          propertyId: String(appointment.property_id)
        }
      });
    } catch (pushErr) {
      console.error('[appointments/cancel] push error', pushErr);
    }

    res.json({ ok: true, message: 'Cita cancelada' });
  } catch (e) {
    console.error('[PUT /api/appointments/:id/cancel] error', e);
    res.status(500).json({ error: 'Error al cancelar la cita' });
  }
});

// PUT /api/appointments/:id/complete
router.put('/api/appointments/:id/complete', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const userId = req.user.id;

    const [rows] = await pool.promise().query(
      'SELECT id, agent_id, requester_id, status FROM appointments WHERE id = ? LIMIT 1',
      [appointmentId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    const appointment = rows[0];

    // Solo el agente puede marcar como completada
    if (String(appointment.agent_id) !== String(userId)) {
      return res.status(403).json({ error: 'Solo el agente puede completar la cita' });
    }

    if (appointment.status !== 'confirmed') {
      return res.status(400).json({ error: 'Solo se pueden completar citas confirmadas' });
    }

    await pool.promise().query(
      'UPDATE appointments SET status = "completed", updated_at = NOW() WHERE id = ?',
      [appointmentId]
    );

    res.json({ ok: true, message: 'Cita marcada como completada' });
  } catch (e) {
    console.error('[PUT /api/appointments/:id/complete] error', e);
    res.status(500).json({ error: 'Error al completar la cita' });
  }
});

// GET /api/appointments/available-slots/:agentId
router.get('/api/appointments/available-slots/:agentId', authenticateToken, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Falta el parámetro date (YYYY-MM-DD)' });
    }

    // Obtener horario laboral del agente
    const [agentRows] = await pool.promise().query(
      'SELECT work_start, work_end FROM users WHERE id = ? LIMIT 1',
      [agentId]
    );

    if (!agentRows.length || !agentRows[0].work_start || !agentRows[0].work_end) {
      return res.json({ available_slots: [] });
    }

    const { work_start, work_end } = agentRows[0];

    // Obtener citas ya agendadas para ese día
    const [bookedSlots] = await pool.promise().query(
      `SELECT appointment_time
       FROM appointments
       WHERE agent_id = ?
         AND appointment_date = ?
         AND status IN ('pending', 'confirmed')`,
      [agentId, date]
    );

    const bookedTimes = bookedSlots.map(row => row.appointment_time);

    // Generar slots de 1 hora
    const slots = [];
    const [startHour, startMin] = work_start.split(':').map(Number);
    const [endHour, endMin] = work_end.split(':').map(Number);

    let currentHour = startHour;
    const endTime = endHour * 60 + endMin;

    while ((currentHour * 60) < endTime) {
      const timeStr = `${String(currentHour).padStart(2, '0')}:00:00`;
      const isBooked = bookedTimes.some(t => t.startsWith(`${String(currentHour).padStart(2, '0')}:`));

      slots.push({
        time: timeStr,
        available: !isBooked
      });

      currentHour++;
    }

    res.json({ available_slots: slots, work_start, work_end });
  } catch (e) {
    console.error('[GET /api/appointments/available-slots] error', e);
    res.status(500).json({ error: 'Error al obtener horarios disponibles' });
  }
});

// PUT /api/appointments/:id/reschedule
router.put('/api/appointments/:id/reschedule', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const userId = req.user.id;
    const { appointment_date, appointment_time, notes } = req.body;

    if (!appointment_date || !appointment_time) {
      return res.status(400).json({ error: 'Faltan fecha u hora' });
    }

    // Validar que la fecha no sea en el pasado
    const appointmentDateTime = new Date(`${appointment_date} ${appointment_time}`);
    if (appointmentDateTime < new Date()) {
      return res.status(400).json({ error: 'No puedes reprogramar para el pasado' });
    }

    const [rows] = await pool.promise().query(
      'SELECT id, agent_id, requester_id, property_id, status FROM appointments WHERE id = ? LIMIT 1',
      [appointmentId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    const appointment = rows[0];

    // Verificar que el usuario sea parte de la cita
    if (String(appointment.agent_id) !== String(userId) && String(appointment.requester_id) !== String(userId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // No se pueden reprogramar citas canceladas o completadas
    if (appointment.status === 'cancelled' || appointment.status === 'completed') {
      return res.status(400).json({ error: 'No se puede reprogramar esta cita' });
    }

    // Verificar que el nuevo horario esté disponible
    const [existing] = await pool.promise().query(
      `SELECT id FROM appointments
       WHERE agent_id = ?
         AND appointment_date = ?
         AND appointment_time = ?
         AND status IN ('pending', 'confirmed')
         AND id != ?
       LIMIT 1`,
      [appointment.agent_id, appointment_date, appointment_time, appointmentId]
    );

    if (existing.length) {
      return res.status(409).json({ error: 'Ese horario ya está ocupado' });
    }

    // Actualizar la cita y resetear a pending si estaba confirmada
    const newStatus = appointment.status === 'confirmed' ? 'pending' : appointment.status;

    await pool.promise().query(
      `UPDATE appointments
       SET appointment_date = ?,
           appointment_time = ?,
           notes = ?,
           status = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [appointment_date, appointment_time, notes || null, newStatus, appointmentId]
    );

    // Notificar a la otra parte
    const notifyUserId = String(userId) === String(appointment.agent_id)
      ? appointment.requester_id
      : appointment.agent_id;

    try {
      await sendPushToUser({
        userId: notifyUserId,
        title: 'Cita reprogramada',
        body: `Una cita ha sido reprogramada para ${appointment_date} a las ${appointment_time.slice(0, 5)}`,
        data: {
          type: 'appointment',
          appointmentId: String(appointmentId),
          propertyId: String(appointment.property_id)
        }
      });
    } catch (pushErr) {
      console.error('[appointments/reschedule] push error', pushErr);
    }

    res.json({ ok: true, message: 'Cita reprogramada', new_status: newStatus });
  } catch (e) {
    console.error('[PUT /api/appointments/:id/reschedule] error', e);
    res.status(500).json({ error: 'Error al reprogramar la cita' });
  }
});

module.exports = router;
