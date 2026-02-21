const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const { signedDeliveryUrlFromSecure, buildDeliveryUrlFromSecure } = require('../utils/helpers');

// GET /api/chat/file-url/:message_id
router.get('/api/chat/file-url/:message_id', authenticateToken, (req, res) => {
  const { message_id } = req.params;
  const me = req.user.id;
  const sql = `
    SELECT id, sender_id, receiver_id, file_url, file_name
    FROM chat_messages
    WHERE id = ?
    LIMIT 1
  `;
  pool.query(sql, [message_id], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ error: 'No encontrado' });
    const m = rows[0];
    if (String(m.sender_id) !== String(me) && String(m.receiver_id) !== String(me)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const signed = m.file_url ? buildDeliveryUrlFromSecure(m.file_url, m.file_name) : null;
    res.json({ signed_file_url: signed });
  });
});

// GET /api/chat/messages
router.get('/api/chat/messages', authenticateToken, (req, res) => {
  const { user_id, property_id } = req.query;
  const me = req.user.id;
  console.log('[chat/messages] req', { me, user_id, property_id });
  if (!user_id) return res.status(400).json({ error: 'Faltan campos' });

  let query = `
  SELECT
    cm.*,
    CASE WHEN cm.message_type = 'property_card' THEN p.id END as cp_id,
    CASE WHEN cm.message_type = 'property_card' THEN p.address END as cp_address,
    CASE WHEN cm.message_type = 'property_card' THEN p.type END as cp_type,
    CASE WHEN cm.message_type = 'property_card' THEN p.price END as cp_price,
    CASE WHEN cm.message_type = 'property_card' THEN p.monthly_pay END as cp_monthly_pay,
    CASE WHEN cm.message_type = 'property_card' THEN p.estate_type END as cp_estate_type,
    CASE WHEN cm.message_type = 'property_card'
      THEN (SELECT image_url FROM property_images WHERE property_id = p.id ORDER BY id ASC LIMIT 1)
    END as cp_first_image
  FROM chat_messages cm
  LEFT JOIN properties p ON cm.shared_property_id = p.id AND cm.message_type = 'property_card'
  WHERE cm.is_deleted = 0
    AND ((cm.sender_id = ? AND cm.receiver_id = ?) OR (cm.sender_id = ? AND cm.receiver_id = ?))
  `;
  const params = [me, user_id, user_id, me];
  if (property_id) {
    query += ' AND cm.property_id = ?';
    params.push(property_id);
  }
  query += ' ORDER BY cm.created_at ASC';

  // Marca los mensajes recibidos como leídos
  const markAsRead = `
    UPDATE chat_messages
    SET is_read = 1
    WHERE receiver_id = ? AND sender_id = ? AND (property_id = ? OR ? IS NULL)
  `;

  console.log('[chat/messages] params', params);
  pool.query(query, params, (err, results) => {
    if (err) {
      console.error('[chat/messages] DB ERROR', { code: err.code, sqlMessage: err.sqlMessage });
      return res.status(500).json({ error: 'No se pudo obtener los mensajes' });
    }
    console.log('[chat/messages] rows returned:', results.length);

    const ttl = Number(process.env.CLD_DEFAULT_URL_TTL_SECONDS || 300);
    const mapped = results.map(row => {
      const msg = { ...row };

      if (row.message_type === 'property_card' && row.cp_id) {
        msg.card_property = {
          id: row.cp_id,
          address: row.cp_address,
          type: row.cp_type,
          price: row.cp_price,
          monthly_pay: row.cp_monthly_pay,
          estate_type: row.cp_estate_type,
          first_image: row.cp_first_image,
        };
      } else if (row.message_type === 'property_card') {
        msg.card_property = null;
      }

      delete msg.cp_id;
      delete msg.cp_address;
      delete msg.cp_type;
      delete msg.cp_price;
      delete msg.cp_monthly_pay;
      delete msg.cp_estate_type;
      delete msg.cp_first_image;

      if (msg.file_url) {
        msg.signed_file_url = signedDeliveryUrlFromSecure(msg.file_url, ttl, msg.file_name);
      }
      return msg;
    });

    pool.query(markAsRead, [me, user_id, property_id || null, property_id || null], () => {
      res.json(mapped);
    });
  });
});

// GET /api/chat/mute-status
router.get('/api/chat/mute-status', authenticateToken, (req, res) => {
  const me = req.user?.id || req.userId;
  const otherUserId = Number(req.query.other_user_id);
  const propertyIdRaw = req.query.property_id;

  if (!me || !otherUserId) return res.status(400).json({ error: 'Faltan campos' });

  const propertyId = propertyIdRaw === undefined || propertyIdRaw === '' ? null : Number(propertyIdRaw);

  const q = `
    SELECT is_muted, muted_until
    FROM chat_mutes
    WHERE user_id = ?
      AND other_user_id = ?
      AND ((property_id IS NULL AND ? IS NULL) OR property_id = ?)
    LIMIT 1
  `;

  pool.query(q, [me, otherUserId, propertyId, propertyId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!rows?.length) return res.json({ is_muted: false, muted_until: null });

    const r = rows[0];

    // Si tiene vencimiento y ya pasó, consideramos no muted (opcional)
    if (r.muted_until && new Date(r.muted_until).getTime() <= Date.now()) {
      return res.json({ is_muted: false, muted_until: r.muted_until });
    }

    res.json({ is_muted: !!r.is_muted, muted_until: r.muted_until ?? null });
  });
});

// PUT /api/chat/mute
router.put('/api/chat/mute', authenticateToken, (req, res) => {
  const me = req.user?.id || req.userId;
  const { other_user_id, property_id, is_muted, muted_until } = req.body;

  if (!me || !other_user_id || typeof is_muted !== 'boolean') {
    return res.status(400).json({ error: 'Faltan campos' });
  }

  const otherUserId = Number(other_user_id);
  const propertyId = property_id == null ? null : Number(property_id);

  const q = `
    INSERT INTO chat_mutes (user_id, other_user_id, property_id, is_muted, muted_until)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      is_muted = VALUES(is_muted),
      muted_until = VALUES(muted_until),
      updated_at = NOW()
  `;

  pool.query(
    q,
    [me, otherUserId, propertyId, is_muted ? 1 : 0, muted_until ?? null],
    (err) => {
      if (err) return res.status(500).json({ error: 'No se pudo actualizar' });
      res.json({ ok: true });
    }
  );
});

// GET /api/chat/my-chats
router.get('/api/chat/my-chats', authenticateToken, (req, res) => {
  const userId = req.user.id;
  console.log('[my-chats] req userId:', userId);

  const sql = `
    SELECT
      t.chat_with_user_id,
      u.name AS chat_with_user_name,
      u.last_name AS chat_with_user_last_name,
      t.property_id,
      p.address AS property_address,
      p.price        AS property_price,
      p.monthly_pay  AS property_monthly_pay,
      p.type         AS property_type,
      cm.created_at  AS last_message_at,
      cm.message     AS last_message,
      (
        SELECT COUNT(*)
        FROM chat_messages m
        WHERE m.sender_id = t.chat_with_user_id
          AND m.receiver_id = ?
          AND (m.property_id <=> t.property_id)
          AND m.is_read = 0
          AND m.is_deleted = 0
      ) AS unread_count,
      CASE
        WHEN cmute.is_muted = 1
          AND (cmute.muted_until IS NULL OR cmute.muted_until > NOW())
        THEN 1
        ELSE 0
      END AS is_muted
    FROM (
      SELECT
        IF(sender_id = ?, receiver_id, sender_id) AS chat_with_user_id,
        property_id,
        MAX(id) AS last_msg_id
      FROM chat_messages
      WHERE (sender_id = ? OR receiver_id = ?)
        AND is_deleted = 0
      GROUP BY chat_with_user_id, property_id
    ) t
    JOIN chat_messages cm ON cm.id = t.last_msg_id
    JOIN users u          ON u.id = t.chat_with_user_id
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN chat_mutes cmute
      ON cmute.user_id = ?
     AND cmute.other_user_id = t.chat_with_user_id
     AND (cmute.property_id <=> t.property_id)
    LEFT JOIN hidden_chats h
      ON h.user_id = ?
     AND h.chat_with_user_id = t.chat_with_user_id
     AND (h.property_id <=> t.property_id)
    WHERE h.user_id IS NULL
    ORDER BY cm.created_at DESC
  `;

  // 6 placeholders -> 6 params (en el orden exacto del SQL)
  const params = [
    userId, // unread_count: m.receiver_id = ?
    userId, // IF(sender_id = ?, ...)
    userId, // WHERE sender_id = ?
    userId, // WHERE receiver_id = ?
    userId, // cmute.user_id = ?
    userId, // h.user_id = ?
  ];

  pool.query(sql, params, (err, rows) => {
    if (!err) console.log('[my-chats] rows returned:', rows.length);
    if (err) {
      console.error('[my-chats] SQL ERROR', {
        code: err.code,
        sqlMessage: err.sqlMessage,
        sql: err.sql,
      });
      return res.status(500).json({ error: 'No se pudieron obtener los chats' });
    }
    res.json(rows);
  });
});

// POST /api/chat/hide-chat
router.post('/api/chat/hide-chat', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { chat_with_user_id, property_id } = req.body;
  if (!chat_with_user_id) return res.status(400).json({ error: 'Faltan campos' });

  const sql = `
    INSERT INTO hidden_chats (user_id, chat_with_user_id, property_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE hidden_at = CURRENT_TIMESTAMP
  `;
  const params = [userId, chat_with_user_id, property_id ?? null];

  pool.query(sql, params, (err, result) => {
    if (err) {
      console.error('[hide-chat] INSERT error:', err, { params });
      return res.status(500).json({ error: 'No se pudo ocultar' });
    }
    console.log('[hide-chat] ok', { params, insertId: result.insertId });
    res.json({ ok: true });
  });
});

// PUT /api/chat/mark-read
router.put('/api/chat/mark-read', authenticateToken, (req, res) => {
  const { user_id, chat_with_user_id, property_id } = req.body;

  if (user_id == null || chat_with_user_id == null) {
    return res.status(400).json({ error: 'Faltan campos' });
  }

  // Normaliza property_id: null si viene undefined/''; número si viene string numérica
  const pid =
    property_id === undefined || property_id === null || property_id === ''
      ? null
      : Number(property_id);

  const query = `
    UPDATE chat_messages
    SET is_read = 1
    WHERE receiver_id = ?
      AND sender_id = ?
      AND (property_id <=> ?)
  `;

  const params = [user_id, chat_with_user_id, pid];

  pool.query(query, params, (err, result) => {
    if (err) {
      console.error('[mark-read] error', err);
      return res.status(500).json({ error: 'No se pudo marcar como leído' });
    }
    res.json({ ok: true, affectedRows: result?.affectedRows ?? 0 });
  });
});

module.exports = router;
