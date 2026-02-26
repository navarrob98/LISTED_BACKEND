const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const { sendPushToUser } = require('../utils/helpers');

// Helper: convert "HH:MM:SS" → minutes since midnight
function timeToMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

// Helper: check if a slot overlaps with any calendar block
function slotOverlapsCalBlocks(slotStartMin, slotEndMin, calBlocks) {
  return calBlocks.some(b => {
    if (b.is_all_day) return true;
    const bStart = timeToMin(b.block_start);
    const bEnd = timeToMin(b.block_end);
    return bStart < slotEndMin && bEnd > slotStartMin;
  });
}

// Helper: check if a specific time conflicts with calendar blocks
async function hasCalendarConflict(agentId, date, time) {
  const [blocks] = await pool.promise().query(
    'SELECT block_start, block_end, is_all_day FROM agent_calendar_blocks WHERE agent_id = ? AND block_date = ?',
    [agentId, date]
  );
  if (!blocks.length) return false;
  const slotStart = timeToMin(time);
  const slotEnd = slotStart + 60;
  return slotOverlapsCalBlocks(slotStart, slotEnd, blocks);
}

// POST /api/calendar-sync — batch sync device calendar blocks (30 days)
router.post('/api/calendar-sync', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;

    // Verify user is an agent
    const [userRows] = await pool.promise().query(
      'SELECT agent_type FROM users WHERE id = ? LIMIT 1',
      [agentId]
    );
    if (!userRows.length || !userRows[0].agent_type || userRows[0].agent_type === 'regular') {
      return res.status(403).json({ error: 'Solo agentes pueden sincronizar calendario' });
    }

    const { blocks_by_date } = req.body;
    if (!blocks_by_date || typeof blocks_by_date !== 'object') {
      return res.status(400).json({ error: 'blocks_by_date es requerido' });
    }

    // Delete ALL blocks for this agent in the next 30 days (clean stale data)
    await pool.promise().query(
      'DELETE FROM agent_calendar_blocks WHERE agent_id = ? AND block_date >= CURDATE() AND block_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)',
      [agentId]
    );

    // Insert new blocks
    for (const [date, blocks] of Object.entries(blocks_by_date)) {
      if (Array.isArray(blocks) && blocks.length) {
        const values = blocks.map(b => [
          agentId, date, b.start, b.end, b.is_all_day ? 1 : 0, b.device_event_id || null
        ]);
        await pool.promise().query(
          'INSERT INTO agent_calendar_blocks (agent_id, block_date, block_start, block_end, is_all_day, device_event_id) VALUES ?',
          [values]
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/calendar-sync] error', e);
    res.status(500).json({ error: 'Error al sincronizar calendario' });
  }
});

// PUT /api/calendar-sync/toggle — enable/disable calendar sync
router.put('/api/calendar-sync/toggle', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;
    const { enabled } = req.body;

    await pool.promise().query(
      'UPDATE users SET calendar_sync_enabled = ? WHERE id = ?',
      [enabled ? 1 : 0, agentId]
    );

    // If disabling, clear all calendar blocks
    if (!enabled) {
      await pool.promise().query(
        'DELETE FROM agent_calendar_blocks WHERE agent_id = ?',
        [agentId]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[PUT /api/calendar-sync/toggle] error', e);
    res.status(500).json({ error: 'Error al cambiar estado de sincronización' });
  }
});

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

    // Verificar conflicto con calendario del agente
    if (await hasCalendarConflict(agentId, appointment_date, appointment_time)) {
      return res.status(409).json({ error: 'El agente tiene un compromiso en su calendario personal en ese horario' });
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

    // Insertar appointment_card en el chat para que aparezca en la conversación
    try {
      await pool.promise().query(
        `INSERT INTO chat_messages (sender_id, receiver_id, property_id, message, message_type, shared_property_id)
         VALUES (?, ?, ?, '', 'appointment_card', ?)`,
        [requesterId, agentId, property_id, result.insertId]
      );
    } catch (chatErr) {
      console.error('[appointments] chat message insert error', chatErr);
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

// POST /api/appointments/quick-invite  (agent creates appointment on behalf of client)
router.post('/api/appointments/quick-invite', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;
    const { property_id, client_id, appointment_date, appointment_time, notes } = req.body;

    if (!property_id || !client_id || !appointment_date || !appointment_time) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    // Verify user is an agent
    const [agentRows] = await pool.promise().query(
      'SELECT id, agent_type, name, last_name FROM users WHERE id = ? LIMIT 1',
      [agentId]
    );
    if (!agentRows.length || !agentRows[0].agent_type || agentRows[0].agent_type === 'regular') {
      return res.status(403).json({ error: 'Solo agentes pueden usar esta función' });
    }

    // Validate property exists and belongs to the agent
    const [propRows] = await pool.promise().query(
      'SELECT id, created_by, address FROM properties WHERE id = ? AND is_published = 1',
      [property_id]
    );
    if (!propRows.length) {
      return res.status(404).json({ error: 'Propiedad no encontrada' });
    }
    if (String(propRows[0].created_by) !== String(agentId)) {
      return res.status(403).json({ error: 'La propiedad no te pertenece' });
    }

    // Validate date/time is not in the past
    const appointmentDateTime = new Date(`${appointment_date} ${appointment_time}`);
    if (appointmentDateTime < new Date()) {
      return res.status(400).json({ error: 'No puedes agendar citas en el pasado' });
    }

    // Block if there is already a confirmed appointment for this user+property
    const [confirmedExist] = await pool.promise().query(
      `SELECT id FROM appointments
       WHERE property_id = ? AND requester_id = ? AND agent_id = ?
         AND status = 'confirmed'
       LIMIT 1`,
      [property_id, client_id, agentId]
    );
    if (confirmedExist.length) {
      return res.status(409).json({ error: 'Ya existe una cita confirmada para esta propiedad. No se puede crear otra.' });
    }

    // Cancel all previous pending appointments for same agent+client+property (before slot check so they don't block)
    const [oldPending] = await pool.promise().query(
      `SELECT id FROM appointments
       WHERE property_id = ? AND requester_id = ? AND agent_id = ?
       AND status = 'pending'`,
      [property_id, client_id, agentId]
    );
    const cancelledIds = oldPending.map(r => r.id);
    if (cancelledIds.length) {
      await pool.promise().query(
        `UPDATE appointments SET status = 'cancelled', cancellation_reason = 'Reemplazada por nueva propuesta', updated_at = NOW()
         WHERE id IN (?)`,
        [cancelledIds]
      );
    }

    // Check slot availability — suggest alternative if occupied or out of hours
    const [agentSchedule] = await pool.promise().query(
      'SELECT work_start, work_end FROM users WHERE id = ? LIMIT 1',
      [agentId]
    );
    if (agentSchedule.length && agentSchedule[0].work_start && agentSchedule[0].work_end) {
      const { work_start, work_end } = agentSchedule[0];
      const [wsH, wsM] = work_start.split(':').map(Number);
      const [weH, weM] = work_end.split(':').map(Number);
      const [reqH] = appointment_time.split(':').map(Number);
      const workStartMin = wsH * 60 + (wsM || 0);
      const workEndMin = weH * 60 + (weM || 0);
      const reqMin = reqH * 60;

      if (reqMin < workStartMin || reqMin >= workEndMin) {
        // Requested time is outside work hours — find nearest available slot
        const [booked] = await pool.promise().query(
          `SELECT appointment_time FROM appointments WHERE agent_id = ? AND appointment_date = ? AND status IN ('pending','confirmed')`,
          [agentId, appointment_date]
        );
        const bookedSet = new Set(booked.map(r => r.appointment_time));
        let suggested = null;
        for (let h = wsH; h * 60 < workEndMin; h++) {
          const t = `${String(h).padStart(2, '0')}:00:00`;
          if (!bookedSet.has(t)) { suggested = { date: appointment_date, time: t }; break; }
        }
        return res.status(409).json({ error: 'Horario fuera de horas laborales', code: 'OUT_OF_HOURS', suggested, cancelledIds });
      }

      // Check if the specific slot is already taken (by another client)
      const [slotTaken] = await pool.promise().query(
        `SELECT id FROM appointments WHERE agent_id = ? AND appointment_date = ? AND appointment_time = ? AND status IN ('pending','confirmed') LIMIT 1`,
        [agentId, appointment_date, appointment_time]
      );
      if (slotTaken.length) {
        const [booked] = await pool.promise().query(
          `SELECT appointment_time FROM appointments WHERE agent_id = ? AND appointment_date = ? AND status IN ('pending','confirmed')`,
          [agentId, appointment_date]
        );
        const bookedSet = new Set(booked.map(r => r.appointment_time));
        let suggested = null;
        for (let offset = 1; offset <= 12; offset++) {
          for (const dir of [1, -1]) {
            const h = reqH + offset * dir;
            if (h * 60 < workStartMin || h * 60 >= workEndMin) continue;
            const t = `${String(h).padStart(2, '0')}:00:00`;
            if (!bookedSet.has(t)) { suggested = { date: appointment_date, time: t }; break; }
          }
          if (suggested) break;
        }
        return res.status(409).json({ error: 'Ese horario ya está ocupado', code: 'SLOT_TAKEN', suggested, cancelledIds });
      }

      // Verificar conflicto con calendario del agente
      if (await hasCalendarConflict(agentId, appointment_date, appointment_time)) {
        return res.status(409).json({ error: 'Tienes un compromiso en tu calendario personal en ese horario', code: 'CALENDAR_BLOCKED', cancelledIds });
      }
    }

    // Create the appointment (requester = client, agent = authenticated agent)
    const [result] = await pool.promise().query(
      `INSERT INTO appointments (property_id, requester_id, agent_id, appointment_date, appointment_time, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [property_id, client_id, agentId, appointment_date, appointment_time, notes || null]
    );

    // Send push notification to the client
    try {
      const agentName = `${agentRows[0].name} ${agentRows[0].last_name}`.trim();
      const dateObj = new Date(`${appointment_date}T12:00:00`);
      const formattedDate = dateObj.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
      const formattedTime = appointment_time.slice(0, 5);

      await sendPushToUser({
        userId: client_id,
        title: 'Propuesta de cita',
        body: `El agente ${agentName} te propone una cita el ${formattedDate} a las ${formattedTime}`,
        data: {
          type: 'appointment',
          appointmentId: String(result.insertId),
          propertyId: String(property_id),
        },
      });
    } catch (pushErr) {
      console.error('[appointments/quick-invite] push error', pushErr);
    }

    // Insertar appointment_card en el chat (skip si el caller ya lo maneja via socket, ej. flujo IA)
    if (!req.body.skip_chat_message) {
      try {
        await pool.promise().query(
          `INSERT INTO chat_messages (sender_id, receiver_id, property_id, message, message_type, shared_property_id)
           VALUES (?, ?, ?, '', 'appointment_card', ?)`,
          [agentId, client_id, property_id, result.insertId]
        );
      } catch (chatErr) {
        console.error('[appointments/quick-invite] chat message insert error', chatErr);
      }
    }

    res.status(201).json({ ok: true, appointmentId: result.insertId, cancelledIds });
  } catch (e) {
    console.error('[POST /api/appointments/quick-invite] error', e);
    res.status(500).json({ error: 'Error al crear la cita' });
  }
});

// PUT /api/appointments/:id/client-accept  (client accepts a pending appointment)
router.put('/api/appointments/:id/client-accept', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const userId = req.user.id;

    const [rows] = await pool.promise().query(
      'SELECT id, agent_id, requester_id, status, property_id, appointment_date, appointment_time FROM appointments WHERE id = ? LIMIT 1',
      [appointmentId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    const appointment = rows[0];

    // Only the requester (client) can accept
    if (String(appointment.requester_id) !== String(userId)) {
      return res.status(403).json({ error: 'Solo el cliente puede aceptar la cita' });
    }

    if (appointment.status !== 'pending') {
      return res.status(400).json({ error: 'Solo se pueden aceptar citas pendientes' });
    }

    await pool.promise().query(
      'UPDATE appointments SET status = "confirmed", updated_at = NOW() WHERE id = ?',
      [appointmentId]
    );

    // Notify the agent
    try {
      const [clientRows] = await pool.promise().query(
        'SELECT name, last_name FROM users WHERE id = ? LIMIT 1',
        [userId]
      );
      const clientName = clientRows[0] ? `${clientRows[0].name} ${clientRows[0].last_name}`.trim() : 'El cliente';

      await sendPushToUser({
        userId: appointment.agent_id,
        title: 'Cita confirmada!',
        body: `${clientName} confirmo la cita`,
        data: {
          type: 'appointment',
          appointmentId: String(appointmentId),
          propertyId: String(appointment.property_id),
        },
      });
    } catch (pushErr) {
      console.error('[appointments/client-accept] push error', pushErr);
    }

    res.json({ ok: true, message: 'Cita confirmada' });
  } catch (e) {
    console.error('[PUT /api/appointments/:id/client-accept] error', e);
    res.status(500).json({ error: 'Error al aceptar la cita' });
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

// GET /api/appointments/next-available/:agentId — find the nearest open slot
// Query: ?client_id=N (optional) — also excludes client's booked appointments
// El backend determina quién es agente a partir de agent_type + work_start/work_end.
router.get('/api/appointments/next-available/:id1', authenticateToken, async (req, res) => {
  try {
    const id1 = req.params.id1;
    const id2 = req.query.client_id;

    // Obtener datos de ambos usuarios
    const userIds = id2 ? [id1, id2] : [id1];
    const [userRows] = await pool.promise().query(
      'SELECT id, work_start, work_end, agent_type FROM users WHERE id IN (?)',
      [userIds]
    );

    if (!userRows.length) return res.json({ found: false });

    // Determinar quién es el agente (tiene horario)
    const agentRow = userRows.find(u => u.agent_type && u.agent_type !== 'regular' && u.work_start && u.work_end);
    const clientRow = userRows.find(u => !u.agent_type || u.agent_type === 'regular' || !u.work_start);

    if (!agentRow) return res.json({ found: false });

    const agentId = agentRow.id;
    const clientId = clientRow ? clientRow.id : null;
    const { work_start, work_end } = agentRow;
    const [wsH] = work_start.split(':').map(Number);
    const [weH, weM] = work_end.split(':').map(Number);
    const workEndMin = weH * 60 + (weM || 0);

    const now = new Date();

    for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      const dateStr = d.toISOString().split('T')[0];

      // Citas del agente
      const [booked] = await pool.promise().query(
        `SELECT appointment_time FROM appointments WHERE agent_id = ? AND appointment_date = ? AND status IN ('pending','confirmed')`,
        [agentId, dateStr]
      );
      const agentBookedSet = new Set(booked.map(r => r.appointment_time));

      // Citas del cliente (regular — solo citas existentes, sin horario)
      const clientBookedSet = new Set();
      if (clientId) {
        const [clientBooked] = await pool.promise().query(
          `SELECT appointment_time FROM appointments WHERE (requester_id = ? OR agent_id = ?) AND appointment_date = ? AND status IN ('pending','confirmed')`,
          [clientId, clientId, dateStr]
        );
        clientBooked.forEach(r => clientBookedSet.add(r.appointment_time));
      }

      // Bloqueos de calendario del agente
      const [calBlocks] = await pool.promise().query(
        'SELECT block_start, block_end, is_all_day FROM agent_calendar_blocks WHERE agent_id = ? AND block_date = ?',
        [agentId, dateStr]
      );

      for (let h = wsH; h * 60 < workEndMin; h++) {
        const t = `${String(h).padStart(2, '0')}:00:00`;
        const isCalBlocked = slotOverlapsCalBlocks(h * 60, (h + 1) * 60, calBlocks);
        if (!agentBookedSet.has(t) && !clientBookedSet.has(t) && !isCalBlocked) {
          return res.json({ found: true, date: dateStr, time: t });
        }
      }
    }

    return res.json({ found: false });
  } catch (e) {
    console.error('[GET /api/appointments/next-available] error', e);
    res.status(500).json({ error: 'Error al buscar horario disponible' });
  }
});

// GET /api/appointments/available-slots
// Query: ?date=YYYY-MM-DD&user1=ID&user2=ID
//
// El backend determina quién es agente y quién es regular a partir de agent_type.
//   - Agente (individual/brokerage/seller): tiene work_start/work_end → genera rango de slots.
//     Se excluyen sus citas y bloqueos de calendario.
//   - Regular: NO tiene horario. Solo se consultan sus citas existentes
//     para no proponer un horario donde ya tenga cita con otro agente/propiedad.
//   - Un slot es "available" solo si NINGUNO de los dos tiene cita a esa hora.
//
// Fallback: también acepta /:agentId legacy (param) + client_id query.
// Lógica compartida para available-slots
async function handleAvailableSlots(req, res) {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Falta el parámetro date (YYYY-MM-DD)' });
    }

    // Resolver ambos user IDs (nuevo: user1/user2 — legacy: :agentId + client_id)
    let id1 = req.query.user1 || req.params.agentId;
    let id2 = req.query.user2 || req.query.client_id;

    console.log('[available-slots] id1=%s id2=%s params=%j query=%j', id1, id2, req.params, { user1: req.query.user1, user2: req.query.user2, client_id: req.query.client_id, date: req.query.date });

    if (!id1) {
      return res.status(400).json({ error: 'Falta al menos un usuario' });
    }

    // ── 1. Obtener datos de ambos usuarios ──
    const userIds = id2 ? [id1, id2] : [id1];
    const [userRows] = await pool.promise().query(
      'SELECT id, work_start, work_end, agent_type FROM users WHERE id IN (?)',
      [userIds]
    );

    console.log('[available-slots] userRows=%j', userRows.map(u => ({ id: u.id, agent_type: u.agent_type, work_start: u.work_start, work_end: u.work_end })));

    if (!userRows.length) {
      return res.json({ available_slots: [], error: 'Usuario no encontrado' });
    }

    // Determinar quién es el agente (tiene horario) y quién es el cliente (regular)
    const agentRow = userRows.find(u => u.agent_type && u.agent_type !== 'regular' && u.work_start && u.work_end);
    const clientRow = userRows.find(u => !u.agent_type || u.agent_type === 'regular' || !u.work_start);

    console.log('[available-slots] agentRow=%s clientRow=%s', agentRow?.id ?? 'NONE', clientRow?.id ?? 'NONE');

    if (!agentRow) {
      return res.json({ available_slots: [], error: 'Ninguno de los usuarios tiene horario laboral configurado' });
    }

    const agentId = agentRow.id;
    const clientId = clientRow ? clientRow.id : null;
    const { work_start, work_end } = agentRow;

    // ── 2. Citas del agente para ese día ──
    const [agentBooked] = await pool.promise().query(
      `SELECT appointment_time FROM appointments
       WHERE agent_id = ? AND appointment_date = ? AND status IN ('pending', 'confirmed')`,
      [agentId, date]
    );
    const agentBookedTimes = new Set(agentBooked.map(r => r.appointment_time));

    // ── 3. Citas del cliente para ese día (sin horario, solo citas existentes) ──
    const clientBookedTimes = new Set();
    if (clientId) {
      const [clientBooked] = await pool.promise().query(
        `SELECT appointment_time FROM appointments
         WHERE (requester_id = ? OR agent_id = ?)
           AND appointment_date = ? AND status IN ('pending', 'confirmed')`,
        [clientId, clientId, date]
      );
      clientBooked.forEach(r => clientBookedTimes.add(r.appointment_time));
    }

    // ── 4. Bloqueos de calendario del agente ──
    const [calBlocks] = await pool.promise().query(
      'SELECT block_start, block_end, is_all_day FROM agent_calendar_blocks WHERE agent_id = ? AND block_date = ?',
      [agentId, date]
    );

    // ── 5. Generar slots de 1 hora dentro del horario del agente ──
    const slots = [];
    const [startHour] = work_start.split(':').map(Number);
    const [endHour, endMin] = work_end.split(':').map(Number);
    const endTime = endHour * 60 + (endMin || 0);

    for (let h = startHour; h * 60 < endTime; h++) {
      const timeStr = `${String(h).padStart(2, '0')}:00:00`;
      const hourPrefix = `${String(h).padStart(2, '0')}:`;
      const isAgentBusy = [...agentBookedTimes].some(t => t.startsWith(hourPrefix));
      const isClientBusy = [...clientBookedTimes].some(t => t.startsWith(hourPrefix));
      const isCalBlocked = slotOverlapsCalBlocks(h * 60, (h + 1) * 60, calBlocks);

      slots.push({
        time: timeStr,
        available: !isAgentBusy && !isClientBusy && !isCalBlocked,
      });
    }

    res.json({ available_slots: slots, work_start, work_end });
  } catch (e) {
    console.error('[GET /api/appointments/available-slots] error', e);
    res.status(500).json({ error: 'Error al obtener horarios disponibles' });
  }
}

// Dos rutas: con y sin :agentId (legacy + nuevo)
router.get('/api/appointments/available-slots/:agentId', authenticateToken, handleAvailableSlots);
router.get('/api/appointments/available-slots', authenticateToken, handleAvailableSlots);

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

    // Verificar conflicto con calendario del agente
    if (await hasCalendarConflict(appointment.agent_id, appointment_date, appointment_time)) {
      return res.status(409).json({ error: 'El agente tiene un compromiso en su calendario personal en ese horario' });
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
