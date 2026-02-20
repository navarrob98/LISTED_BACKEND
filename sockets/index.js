module.exports = function initSockets(io, pool, helpers) {
  const { sendPushToUser, buildDeliveryUrlFromSecure, isMutedForReceiver } = helpers;

  io.on('connection', (socket) => {
    // El cliente llama: socket.emit('join', { userId })
    socket.on('join', ({ userId }) => {
      if (userId) socket.join('user_' + userId);
    });

    // Enviar mensaje (texto y/o archivo)
    socket.on('send_message', (data) => {
      const { sender_id, receiver_id, property_id, message, file_url, file_name } = data || {};
      console.log('[send_message] incoming', {
        socketId: socket.id,
        sender_id,
        receiver_id,
        property_id,
        hasMessage: !!message,
        hasFile: !!file_url,
      });
      if (!sender_id || !receiver_id || (!message && !file_url)) return;

      const messageSafe = typeof message === 'string' ? message.trim() : '';
      const fileUrlSafe = file_url || null;
      const fileNameSafe = file_name || null;

      const sql = `
        INSERT INTO chat_messages (property_id, sender_id, receiver_id, message, file_url, file_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      const vals = [
        property_id || null,
        sender_id,
        receiver_id,
        messageSafe,
        fileUrlSafe,
        fileNameSafe,
      ];

      pool.query(sql, vals, async (err, result) => {
        if (err) {
          console.error('[send_message] insert error', err);
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
          created_at: new Date().toISOString(),
        };

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

        // Socket realtime (lo tuyo)
        socket.emit('receive_message', msgObj);
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

    // Eliminar mensaje
    socket.on('delete_message', ({ message_id, user_id }) => {
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
