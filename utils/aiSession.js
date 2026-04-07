/**
 * Shared AI session helpers.
 * Used by sockets/index.js (to check session state before auto-reply)
 * and routes/appointments.js (to end session when client confirms appointment).
 */

async function isAiSessionEnded(pool, agentId, clientId, propertyId) {
  const [[row]] = await pool.promise().query(
    `SELECT id FROM chat_messages
     WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
       AND (property_id <=> ?) AND message_type = 'ai_session_end' LIMIT 1`,
    [agentId, clientId, clientId, agentId, propertyId ?? null]
  );
  return !!row;
}

async function endAiSession(pool, io, { agentId, clientId, propertyId, reason }) {
  const [[agentRow]] = await pool.promise().query(
    'SELECT name FROM users WHERE id = ? LIMIT 1', [agentId]
  );
  const agentName = agentRow?.name || 'el agente';

  const message = reason === 'appointment'
    ? `Tu cita ha sido confirmada. A partir de ahora ${agentName} te dará seguimiento personalmente.`
    : reason === 'agent_takeover'
    ? `${agentName} ha tomado el control de la conversación. A partir de ahora te atenderá directamente.`
    : `No puedo responder esto con la certeza que mereces. ${agentName} entrará en contacto contigo para resolver tus dudas.`;

  const [result] = await pool.promise().query(
    `INSERT INTO chat_messages (sender_id, receiver_id, property_id, message, message_type)
     VALUES (?, ?, ?, ?, 'ai_session_end')`,
    [agentId, clientId, propertyId ?? null, message]
  );

  const msgObj = {
    id: result.insertId,
    property_id: propertyId ?? null,
    sender_id: agentId,
    receiver_id: clientId,
    message,
    message_type: 'ai_session_end',
    created_at: new Date().toISOString(),
  };

  io.to('user_' + agentId).emit('receive_message', msgObj);
  io.to('user_' + clientId).emit('receive_message', msgObj);
}

module.exports = { isAiSessionEnded, endAiSession };
