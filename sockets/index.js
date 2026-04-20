const Sentry = require('@sentry/node');
const { generateAutoReply } = require('../utils/aiChatAutoReply');
const redis = require('../db/redis');

// Helper: valida que el agente tenga horario real (no 00:00-00:00 o vacío)
function hasValidWorkSchedule(ws, we) {
  if (!ws || !we) return false;
  const parse = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  return parse(we) > parse(ws);
}

// ── Find the nearest available slot for an agent (next 7 days from fromDate) ─────
async function findNextAvailableSlot(pool, agentId, clientId, fromDate) {
  const [[agent]] = await pool.promise().query(
    'SELECT work_start, work_end FROM users WHERE id = ? LIMIT 1',
    [agentId]
  );
  if (!agent || !hasValidWorkSchedule(agent.work_start, agent.work_end)) return null;

  const [wsH] = agent.work_start.split(':').map(Number);
  const [weH, weM] = agent.work_end.split(':').map(Number);
  const workEndMin = weH * 60 + (weM || 0);
  const base = fromDate ? new Date(fromDate + 'T00:00:00') : new Date();

  for (let dayOffset = fromDate ? 0 : 1; dayOffset <= 7; dayOffset++) {
    const d = new Date(base);
    d.setDate(d.getDate() + dayOffset);
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });

    const [booked] = await pool.promise().query(
      `SELECT appointment_time FROM appointments WHERE agent_id = ? AND appointment_date = ? AND status IN ('pending','confirmed')`,
      [agentId, dateStr]
    );
    const bookedSet = new Set(booked.map(r => r.appointment_time));

    if (clientId) {
      const [clientBooked] = await pool.promise().query(
        `SELECT appointment_time FROM appointments WHERE (requester_id = ? OR agent_id = ?) AND appointment_date = ? AND status IN ('pending','confirmed')`,
        [clientId, clientId, dateStr]
      );
      clientBooked.forEach(r => bookedSet.add(r.appointment_time));
    }

    for (let h = wsH; h * 60 < workEndMin; h++) {
      const t = `${String(h).padStart(2, '0')}:00:00`;
      if (!bookedSet.has(t)) return { date: dateStr, time: t };
    }
  }
  return null;
}

// ── Resolve a date+time against agent work hours — adjust if outside or taken ────
async function resolveSlot(pool, agentId, clientId, date, time) {
  const [[agent]] = await pool.promise().query(
    'SELECT work_start, work_end FROM users WHERE id = ? LIMIT 1',
    [agentId]
  );
  // Si el agente NO tiene horario válido, retornamos null — no intentamos
  // agendar a ciegas. El caller decidirá notificar al agente en lugar.
  if (!agent || !hasValidWorkSchedule(agent.work_start, agent.work_end)) return null;

  const [wsH] = agent.work_start.split(':').map(Number);
  const [weH, weM] = agent.work_end.split(':').map(Number);
  const workEndMin = weH * 60 + (weM || 0);
  const reqH = parseInt(time.split(':')[0], 10);
  const reqMin = reqH * 60;

  // If within hours and not taken, use it
  if (reqMin >= wsH * 60 && reqMin < workEndMin) {
    const [taken] = await pool.promise().query(
      `SELECT id FROM appointments WHERE agent_id = ? AND appointment_date = ? AND appointment_time = ? AND status IN ('pending','confirmed') LIMIT 1`,
      [agentId, date, time]
    );
    if (!taken.length) return { date, time };
  }

  // Otherwise find first free slot on that date within work hours
  const [booked] = await pool.promise().query(
    `SELECT appointment_time FROM appointments WHERE agent_id = ? AND appointment_date = ? AND status IN ('pending','confirmed')`,
    [agentId, date]
  );
  const bookedSet = new Set(booked.map(r => r.appointment_time));
  if (clientId) {
    const [clientBooked] = await pool.promise().query(
      `SELECT appointment_time FROM appointments WHERE (requester_id = ? OR agent_id = ?) AND appointment_date = ? AND status IN ('pending','confirmed')`,
      [clientId, clientId, date]
    );
    clientBooked.forEach(r => bookedSet.add(r.appointment_time));
  }
  for (let h = wsH; h * 60 < workEndMin; h++) {
    const t = `${String(h).padStart(2, '0')}:00:00`;
    if (!bookedSet.has(t)) return { date, time: t };
  }

  // No slots on that date — find next available from that day onwards
  return findNextAvailableSlot(pool, agentId, clientId, date);
}

// ── Create appointment and emit appointment_card from backend (AI flow) ──────────
async function createAiAppointment({ pool, io, sendPushToUser, agentId, clientId, propertyId, date, time }) {
  // Skip if already in the past
  const dt = new Date(`${date}T${time}`);
  if (dt < new Date()) return;

  // Skip if a confirmed appointment already exists for this triplet
  const [[confirmed]] = await pool.promise().query(
    `SELECT id FROM appointments WHERE property_id = ? AND requester_id = ? AND agent_id = ? AND status = 'confirmed' LIMIT 1`,
    [propertyId, clientId, agentId]
  );
  if (confirmed) return;

  // Adjust date/time to agent work hours if needed
  const resolved = await resolveSlot(pool, agentId, clientId, date, time);
  if (!resolved) return;
  date = resolved.date;
  time = resolved.time;

  // Cancel existing pending appointments for same property+agent+client
  const [oldPending] = await pool.promise().query(
    `SELECT id FROM appointments WHERE property_id = ? AND requester_id = ? AND agent_id = ? AND status = 'pending'`,
    [propertyId, clientId, agentId]
  );
  if (oldPending.length) {
    await pool.promise().query(
      `UPDATE appointments SET status = 'cancelled', cancellation_reason = 'Reemplazada por propuesta de IA', updated_at = NOW() WHERE id IN (?)`,
      [oldPending.map(r => r.id)]
    );
  }

  // Create appointment (requester = client, agent = agent).
  // initiated_by = agent: la IA actúa EN NOMBRE del agente proponiendo la cita,
  // así que el cliente es quien debe aceptar (/client-accept).
  const [apptResult] = await pool.promise().query(
    `INSERT INTO appointments (property_id, requester_id, agent_id, initiated_by, appointment_date, appointment_time, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [propertyId, clientId, agentId, agentId, date, time, 'Propuesta por asistente IA']
  );
  const appointmentId = apptResult.insertId;

  // Insert appointment_card chat message (from agent to client)
  const [chatResult] = await pool.promise().query(
    `INSERT INTO chat_messages (sender_id, receiver_id, property_id, message, message_type, shared_property_id)
     VALUES (?, ?, ?, '', 'appointment_card', ?)`,
    [agentId, clientId, propertyId, appointmentId]
  );

  // Fetch appointment details for the card
  const [[appt]] = await pool.promise().query(
    `SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.requester_id, a.agent_id,
            p.address AS property_address
     FROM appointments a
     JOIN properties p ON p.id = a.property_id
     WHERE a.id = ?`,
    [appointmentId]
  );

  const cardMsg = {
    id: chatResult.insertId,
    property_id: propertyId,
    sender_id: agentId,
    receiver_id: clientId,
    message: '',
    file_url: null,
    file_name: null,
    message_type: 'appointment_card',
    shared_property_id: appointmentId,
    created_at: new Date().toISOString(),
    card_appointment: appt ? {
      id: appt.id,
      appointment_date: appt.appointment_date,
      appointment_time: appt.appointment_time,
      status: appt.status,
      property_address: appt.property_address,
      requester_id: appt.requester_id,
      agent_id: appt.agent_id,
    } : null,
  };

  io.to('user_' + agentId).emit('receive_message', cardMsg);
  io.to('user_' + clientId).emit('receive_message', cardMsg);

  // Push notification to client
  try {
    const [[agentUser]] = await pool.promise().query(
      'SELECT name, last_name FROM users WHERE id = ? LIMIT 1',
      [agentId]
    );
    const agentName = agentUser ? `${agentUser.name} ${agentUser.last_name}`.trim() : 'El agente';
    const dateObj = new Date(`${date}T12:00:00`);
    const formattedDate = dateObj.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    const formattedTime = time.slice(0, 5);

    await sendPushToUser({
      userId: clientId,
      title: 'Propuesta de cita',
      body: `${agentName} te propone una visita el ${formattedDate} a las ${formattedTime}`,
      data: {
        type: 'appointment',
        appointmentId: String(appointmentId),
        propertyId: String(propertyId),
      },
    });
  } catch {}
}

const { isAiSessionEnded, endAiSession } = require('../utils/aiSession');

// Inserta mensaje de texto AI en chat (helper local)
async function insertAiTextMessageInline(pool, io, { agentId, clientId, propertyId, message }) {
  try {
    const [result] = await pool.promise().query(
      `INSERT INTO chat_messages (sender_id, receiver_id, property_id, message, message_type)
       VALUES (?, ?, ?, ?, 'text')`,
      [agentId, clientId, propertyId ?? null, message]
    );
    const msgObj = {
      id: result.insertId,
      property_id: propertyId ?? null,
      sender_id: agentId,
      receiver_id: clientId,
      message,
      message_type: 'text',
      created_at: new Date().toISOString(),
      ai_generated: true,
    };
    io.to('user_' + agentId).emit('receive_message', msgObj);
    io.to('user_' + clientId).emit('receive_message', msgObj);
  } catch (e) {
    console.error('[insertAiTextMessageInline] error', e?.message);
  }
}

module.exports = function initSockets(io, pool, helpers) {
  const {
    sendPushToUser,
    buildDeliveryUrlFromSecure,
    isMutedForReceiver,
    getPendingNotificationsForUser,
    markNotificationsDelivered,
  } = helpers;

  console.log('[sockets] initSockets called');
  io.on('connection', async (socket) => {
    // userId is set by JWT middleware in backend.js
    const uid = socket.data.userId;
    console.log('[socket] client connected:', socket.id, 'userId:', uid);
    socket.join('user_' + uid);

    // ── Drenar notificaciones pendientes al reconectar ───────────────────
    // Si el user estuvo offline/sin red y se encolaron notifs, entregarlas
    // ahora via socket (instantáneo, no depende del push). Marca delivered_at
    // después de emitir.
    if (uid && typeof getPendingNotificationsForUser === 'function') {
      try {
        const pending = await getPendingNotificationsForUser(uid);
        if (pending.length > 0) {
          console.log('[socket] delivering', pending.length, 'pending notifications to user', uid);
          for (const n of pending) {
            socket.emit('pending_notification', {
              id: n.id,
              title: n.title,
              body: n.body,
              data: n.data,
              created_at: n.created_at,
            });
          }
          await markNotificationsDelivered(pending.map((n) => n.id));
        }
      } catch (e) {
        console.error('[socket] drain pending error:', e?.message);
      }
    }

    socket.on('disconnect', (reason) => {
      console.log('[socket] client disconnected:', socket.id, reason);
    });

    socket.on('error', (err) => {
      Sentry.captureException(err, { tags: { socket_event: 'error' } });
    });

    // Enviar mensaje (texto, archivo, property_card o appointment_card)
    socket.on('send_message', (data) => {
      // Always use authenticated userId from JWT — ignore client-sent sender_id
      const sender_id = socket.data.userId;
      const { receiver_id, property_id, message, file_url, file_name, message_type, shared_property_id } = data || {};
      const validTypes = ['property_card', 'appointment_card'];
      const msgType = validTypes.includes(message_type) ? message_type : 'text';
      console.log('[send_message] incoming', {
        socketId: socket.id,
        sender_id,
        receiver_id,
        property_id,
        hasMessage: !!message,
        hasFile: !!file_url,
        message_type: msgType,
        shared_property_id: shared_property_id || null,
      });

      if (!sender_id || !receiver_id) return;
      if ((msgType === 'property_card' || msgType === 'appointment_card') && !shared_property_id) return;
      if (msgType === 'text' && !message && !file_url) return;

      const messageSafe = typeof message === 'string' ? message.trim() : '';
      const fileUrlSafe = file_url || null;
      const fileNameSafe = file_name || null;

      const sql = `
        INSERT INTO chat_messages (property_id, sender_id, receiver_id, message, file_url, file_name, message_type, shared_property_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const vals = [
        property_id || null,
        sender_id,
        receiver_id,
        messageSafe,
        fileUrlSafe,
        fileNameSafe,
        msgType,
        (msgType === 'property_card' || msgType === 'appointment_card') ? shared_property_id : null,
      ];

      pool.query(sql, vals, async (err, result) => {
        if (err) {
          Sentry.captureException(err, { tags: { socket_event: 'send_message' } });
          console.error('[send_message] INSERT ERROR', { code: err.code });
          return;
        }

        const msgObj = {
          id: result.insertId,
          property_id,
          sender_id,
          receiver_id,
          message: messageSafe,
          file_url: fileUrlSafe,
          file_name: fileNameSafe,
          message_type: msgType,
          shared_property_id: (msgType === 'property_card' || msgType === 'appointment_card') ? shared_property_id : null,
          created_at: new Date().toISOString(),
        };

        // Si es appointment_card, obtener datos de la cita
        if (msgType === 'appointment_card') {
          try {
            const [apptRows] = await pool.promise().query(
              `SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.requester_id, a.agent_id,
                      p.address as property_address
               FROM appointments a
               JOIN properties p ON p.id = a.property_id
               WHERE a.id = ?`,
              [shared_property_id]
            );
            msgObj.card_appointment = apptRows.length ? {
              id: apptRows[0].id,
              appointment_date: apptRows[0].appointment_date,
              appointment_time: apptRows[0].appointment_time,
              status: apptRows[0].status,
              property_address: apptRows[0].property_address,
              requester_id: apptRows[0].requester_id,
              agent_id: apptRows[0].agent_id,
            } : null;
          } catch (apptErr) {
            console.error('[send_message] appointment query error', apptErr);
            msgObj.card_appointment = null;
          }
        }

        // Si es property_card, obtener datos de la propiedad compartida
        if (msgType === 'property_card') {
          try {
            const [propRows] = await pool.promise().query(
              `SELECT id, address, type, price, monthly_pay, estate_type,
                (SELECT image_url FROM property_images WHERE property_id = ? ORDER BY id ASC LIMIT 1) as first_image
              FROM properties WHERE id = ? AND is_published = 1`,
              [shared_property_id, shared_property_id]
            );
            msgObj.card_property = propRows.length ? {
              id: propRows[0].id,
              address: propRows[0].address,
              type: propRows[0].type,
              price: propRows[0].price,
              monthly_pay: propRows[0].monthly_pay,
              estate_type: propRows[0].estate_type,
              first_image: propRows[0].first_image,
            } : null;
          } catch (propErr) {
            console.error('[send_message] property query error', propErr);
            msgObj.card_property = null;
          }
        }

        // Limpia hidden_chats del receptor para este hilo
        pool.query(
          `DELETE FROM hidden_chats
           WHERE user_id = ? AND chat_with_user_id = ? AND (property_id <=> ?)`,
          [receiver_id, sender_id, property_id ?? null],
          (e2) => {
            if (e2) console.error('[send_message] hidden_chats error', e2);
          }
        );

        // Si hay adjunto, agrega URL firmada para entrega inmediata (si aplica)
        if (msgObj.file_url) {
          msgObj.signed_file_url = buildDeliveryUrlFromSecure(msgObj.file_url, msgObj.file_name);
        }

        // Socket realtime — sender is already in room 'user_<id>', no extra emit needed
        io.to('user_' + sender_id).emit('receive_message', msgObj);
        io.to('user_' + receiver_id).emit('receive_message', msgObj);

        // Fetch receiver type once — used for both push decision and AI auto-reply
        let receiverRow = null;
        try {
          const [[row]] = await pool.promise().query(
            'SELECT agent_type, ai_chat_enabled FROM users WHERE id = ? LIMIT 1',
            [receiver_id]
          );
          receiverRow = row || null;
        } catch {}
        const receiverIsAgent = receiverRow && ['individual', 'brokerage', 'seller'].includes(receiverRow.agent_type);

        // PUSH: solo a clientes (regular). Los agentes reciben notificaciones únicamente
        // cuando la IA los notifica explícitamente ([NOTIFICAR_AGENTE] o cita cerrada).
        if (!receiverIsAgent) {
          try {
            const pid = property_id ?? null;
            const muted = await isMutedForReceiver(receiver_id, sender_id, pid);
            if (!muted) {
              await sendPushToUser({
                userId: receiver_id,
                title: 'Nuevo mensaje',
                body: messageSafe
                  ? (messageSafe.length > 110 ? messageSafe.slice(0, 110) + '\u2026' : messageSafe)
                  : (fileUrlSafe ? 'Te enviaron un archivo' : 'Nuevo mensaje'),
                data: {
                  type: 'chat',
                  chatParams: {
                    otherUserId: String(sender_id),
                    propertyId: pid != null ? String(pid) : undefined,
                  }
                }
              });
            }
          } catch (e) {
            console.error('[push] error', e);
          }
        }

        // ── AI auto-reply ────────────────────────────────────────────────────────
        // Only trigger if: sender is a regular user, message is text, property_id exists
        if (msgType !== 'text' || !property_id) return;
        try {
          const isAgent = receiverIsAgent;
          const aiOn = receiverRow && receiverRow.ai_chat_enabled === 1;
          if (!isAgent || !aiOn) return;

          const [[senderRow]] = await pool.promise().query(
            'SELECT agent_type FROM users WHERE id = ? LIMIT 1',
            [sender_id]
          );
          if (!senderRow || senderRow.agent_type !== 'regular') return;

          // Desactivar IA en chats prospect: si el regular ES el dueño de la
          // propiedad, está ofreciéndola al agente (flujo find-agent). El agente
          // debe responder personalmente porque está evaluando tomar el listado.
          const [[propOwner]] = await pool.promise().query(
            'SELECT created_by, review_status FROM properties WHERE id = ? LIMIT 1',
            [property_id]
          );
          if (propOwner && String(propOwner.created_by) === String(sender_id)) return;

          // Skip AI if session was already ended for this triplet
          const sessionEnded = await isAiSessionEnded(pool, receiver_id, sender_id, property_id);
          if (sessionEnded) return;

          // Check if a [NOTIFICAR_AGENTE] confirmation is pending for this triplet
          const pendingKey = `ai:pn:${receiver_id}:${sender_id}:${property_id ?? 'null'}`;
          let isPendingNotify = false;
          try {
            isPendingNotify = !!(await redis.get(pendingKey));
          } catch {}

          // Simulate typing delay (1.5–2.5s)
          const delay = 1500 + Math.floor(Math.random() * 1000);
          await new Promise(r => setTimeout(r, delay));

          const { reply, suggestAppointment, modifyAppointment, extractedDate, extractedTime, pendingNotify, confirmNotify } =
            await generateAutoReply({ agentId: receiver_id, clientId: sender_id, propertyId: property_id, isPendingNotify });

          if (!reply) return;

          // Insert AI response as agent's message
          const [aiResult] = await pool.promise().query(
            `INSERT INTO chat_messages (property_id, sender_id, receiver_id, message, message_type)
             VALUES (?, ?, ?, ?, 'text')`,
            [property_id, receiver_id, sender_id, reply]
          );

          const aiMsg = {
            id: aiResult.insertId,
            property_id,
            sender_id: receiver_id,
            receiver_id: sender_id,
            message: reply,
            file_url: null,
            file_name: null,
            message_type: 'text',
            shared_property_id: null,
            created_at: new Date().toISOString(),
            ai_generated: true,
          };

          io.to('user_' + receiver_id).emit('receive_message', aiMsg);
          io.to('user_' + sender_id).emit('receive_message', aiMsg);

          // ── AI appointment creation — handled entirely in backend ────────────
          // The client cannot call quick-invite (agent-only), so we create the
          // appointment here and emit the appointment_card directly.
          if (suggestAppointment || modifyAppointment) {
            try {
              // Verificar que el agente tenga horario configurado ANTES de intentar.
              // Si no, notificar al agente y no crear cita fantasma (era bug: AI
              // decía "ya te agendé" pero nunca se creaba porque resolveSlot retornaba null).
              const [[agentCheck]] = await pool.promise().query(
                'SELECT work_start, work_end FROM users WHERE id = ? LIMIT 1',
                [receiver_id]
              );
              const hasSchedule = agentCheck && hasValidWorkSchedule(agentCheck.work_start, agentCheck.work_end);

              if (!hasSchedule) {
                // Notificar al agente: cliente pidió visita pero no tiene horario
                sendPushToUser({
                  userId: receiver_id,
                  title: 'Cliente pidió una visita',
                  body: 'Configura tu horario de atención para agendar citas automáticamente.',
                  data: {
                    type: 'chat',
                    chatParams: {
                      otherUserId: String(sender_id),
                      propertyId: property_id != null ? String(property_id) : undefined,
                    },
                  },
                });
                // Insertar mensaje AI honesto (en vez de "ya te agendé")
                await insertAiTextMessageInline(pool, io, {
                  agentId: receiver_id,
                  clientId: sender_id,
                  propertyId: property_id,
                  message: `Déjame confirmar la disponibilidad con el agente y te aviso en cuanto tenga un horario para usted. Mientras, si tiene otra pregunta sobre la propiedad estoy para ayudarle.`,
                });
              } else {
                let apptDate = extractedDate;
                let apptTime = extractedTime;

                if (!apptDate || !apptTime) {
                  const slot = await findNextAvailableSlot(pool, receiver_id, sender_id);
                  if (slot) {
                    apptDate = slot.date;
                    apptTime = slot.time;
                  }
                }

                if (apptDate && apptTime) {
                  await createAiAppointment({
                    pool, io, sendPushToUser,
                    agentId: receiver_id,
                    clientId: sender_id,
                    propertyId: property_id,
                    date: apptDate,
                    time: apptTime,
                  });
                  // Session ends when client *confirms* the appointment, not here
                }
              }
            } catch (apptErr) {
              console.error('[ai-auto-reply] appointment creation error', apptErr?.message);
            }
          }

          // [NOTIFICAR_AGENTE] — notifica al agente INMEDIATAMENTE sin esperar
          // confirmación del cliente. Si la IA dice "voy a notificar", hay que
          // hacerlo de verdad — sino queda una promesa rota si el cliente no
          // responde o cambia de tema.
          //
          // Mantenemos `pendingNotify` como guard de dedup para no spammear al
          // agente con varias notificaciones en la misma sesión: si ya hay una
          // notificación activa (Redis key), no volvemos a enviar.
          if (pendingNotify || (isPendingNotify && confirmNotify)) {
            try {
              const alreadyNotified = isPendingNotify; // ya había pending key antes → ya notificamos
              if (!alreadyNotified) {
                await endAiSession(pool, io, {
                  agentId: receiver_id,
                  clientId: sender_id,
                  propertyId: property_id,
                  reason: 'uncertain',
                });

                await sendPushToUser({
                  userId: receiver_id,
                  title: 'Revisión requerida',
                  body: 'Un cliente preguntó algo que tu asistente de IA no pudo responder sobre la propiedad.',
                  data: {
                    type: 'chat',
                    chatParams: {
                      otherUserId: String(sender_id),
                      propertyId: property_id != null ? String(property_id) : undefined,
                    },
                  },
                });

                // Marca pending key con TTL 24h para dedup en siguientes mensajes de la misma sesión
                try { await redis.set(pendingKey, '1', 'EX', 86400); } catch {}
              } else if (confirmNotify) {
                // Cliente confirmó pero ya habíamos notificado → solo limpia la key
                try { await redis.del(pendingKey); } catch {}
              }
            } catch (notifyErr) {
              console.error('[ai-auto-reply] notify agent error', notifyErr?.message);
            }
          } else if (isPendingNotify && !confirmNotify) {
            // Cliente respondió a un pending sin confirmar — limpia la key para
            // permitir nuevas notificaciones si aparece otra duda.
            try { await redis.del(pendingKey); } catch {}
          }
        } catch (aiErr) {
          console.error('[ai-auto-reply] error', aiErr?.message);
        }
    });
  });

    // Eliminar mensaje — use authenticated userId from JWT
    socket.on('delete_message', ({ message_id }) => {
      const user_id = socket.data.userId;
      if (!message_id || !user_id) return;

      const q = `
        SELECT sender_id, receiver_id, property_id
        FROM chat_messages
        WHERE id = ?
        LIMIT 1
      `;

      pool.query(q, [message_id], (err, rows) => {
        if (err || !rows.length) return;
        const msg = rows[0];

        // Solo participantes pueden borrar
        if (
          String(msg.sender_id) !== String(user_id) &&
          String(msg.receiver_id) !== String(user_id)
        ) {
          return;
        }

        pool.query(
          'UPDATE chat_messages SET is_deleted = 1 WHERE id = ?',
          [message_id],
          (updErr) => {
            if (updErr) return;
            io.to('user_' + msg.sender_id).emit('message_deleted', { message_id });
            io.to('user_' + msg.receiver_id).emit('message_deleted', { message_id });
          }
        );
      });
    });
  });
};
