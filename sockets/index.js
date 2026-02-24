module.exports = function initSockets(io, pool, helpers) {
  const { sendPushToUser, buildDeliveryUrlFromSecure, isMutedForReceiver } = helpers;

  console.log('[sockets] initSockets called');
  io.on('connection', (socket) => {
    // userId is set by JWT middleware in backend.js
    const uid = socket.data.userId;
    console.log('[socket] client connected:', socket.id, 'userId:', uid);
    socket.join('user_' + uid);

    socket.on('disconnect', (reason) => {
      console.log('[socket] client disconnected:', socket.id, reason);
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
          console.error('[send_message] INSERT ERROR', { code: err.code, sqlMessage: err.sqlMessage });
          return;
        }
        console.log('[send_message] inserted id:', result.insertId);

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

        // PUSH: mandar al receptor (solo si NO está silenciado)
        try {
          const pid = property_id ?? null;
          const muted = await isMutedForReceiver(receiver_id, sender_id, pid);

          if (muted) {
            console.log('[push] skipped (muted chat)', {
              receiver_id,
              sender_id,
              property_id: pid
            });
          } else {
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
