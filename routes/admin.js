const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const requireAdmin = require('../middleware/requireAdmin');

// GET /admin/agents/pending
router.get('/admin/agents/pending', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT
      u.id AS id,
      u.name AS name,
      u.last_name AS lastName,
      u.email AS email,
      u.phone AS phone,
      u.agent_type AS agentType,
      u.agent_verification_status AS agentVerificationStatus,
      u.created_at AS createdAt,

      ac.type AS credentialType,
      ac.state AS credentialState,
      ac.credential_id AS credentialId,
      ac.issuer AS issuer,
      ac.verification_url AS verificationUrl,
      ac.certificate_url AS certificateUrl

    FROM users u
    JOIN agent_credentials ac
      ON ac.id = (
        SELECT id
        FROM agent_credentials
        WHERE user_id = u.id
        ORDER BY id DESC
        LIMIT 1
      )
    WHERE u.agent_type IN ('brokerage','individual','seller')
      AND u.agent_verification_status = 'pending'
      AND ac.credential_id IS NOT NULL
      AND ac.credential_id <> ''
    ORDER BY u.id DESC
    LIMIT 500
  `;

  pool.query(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Error consultando agentes' });
    res.json(rows);
  });
});

// POST /admin/agents/:id/approve
router.post('/admin/agents/:id/approve', authenticateToken, requireAdmin, (req, res) => {
  const agentId = Number(req.params.id);
  const adminId = req.user.id;

  pool.query(
    `
    UPDATE users
    SET agent_verification_status = 'verified',
        agent_verified_at = NOW(),
        agent_verified_by = ?,
        agent_rejection_reason = NULL
    WHERE id = ?
      AND agent_type NOT IN ('regular', 'admin')
    `,
    [adminId, agentId],
    (err, r) => {
      if (err) {
        console.error('[admin/agents/approve] SQL error', {
          code: err.code,
          sqlMessage: err.sqlMessage,
          sql: err.sql,
        });
        return res.status(500).json({ error: 'Error aprobando agente' });
      }
      if (!r.affectedRows) return res.status(404).json({ error: 'Agente no encontrado' });
      res.json({ ok: true });
    }
  );
});

// POST /admin/agents/:id/reject
router.post('/admin/agents/:id/reject', authenticateToken, requireAdmin, (req, res) => {
  const agentId = Number(req.params.id);
  const adminId = req.user.id;
  const { reason } = req.body || {};

  pool.query(
    `
    UPDATE users
    SET agent_verification_status='rejected',
        agent_verified_at = NULL,
        agent_verified_by = NULL,
        agent_rejection_reason = ?
    WHERE id=?
      AND agent_type NOT IN ('regular', 'admin')
    `,
    [reason || null, agentId],
    (err, r) => {
      if (err) return res.status(500).json({ error: 'Error rechazando agente' });
      if (!r.affectedRows) return res.status(404).json({ error: 'Agente no encontrado' });
      res.json({ ok: true });
    }
  );
});

// GET /admin/properties/pending
router.get('/admin/properties/pending', authenticateToken, requireAdmin, (req, res) => {
  const sql = `
    SELECT
      p.*,
      u.name AS owner_name,
      u.last_name AS owner_last_name,
      u.email AS owner_email,
      -- images como JSON (o string JSON si tu MySQL no soporta CAST AS JSON)
      COALESCE(img.images, '[]') AS images
    FROM properties p
    JOIN users u ON u.id = p.created_by
    LEFT JOIN (
      SELECT
        property_id,
        CONCAT(
          '[',
          GROUP_CONCAT(JSON_QUOTE(image_url) ORDER BY id ASC SEPARATOR ','),
          ']'
        ) AS images
      FROM property_images
      WHERE image_url IS NOT NULL AND image_url <> ''
      GROUP BY property_id
    ) img ON img.property_id = p.id
    WHERE p.review_status = 'pending'
      AND p.is_published = 0
    ORDER BY p.id DESC
    LIMIT 500
  `;

  pool.query(sql, [], (err, rows) => {
    if (err) {
      console.error('[admin/properties/pending] error', err);
      return res.status(500).json({ error: 'Error consultando propiedades' });
    }
    res.json(rows);
  });
});

// POST /admin/properties/:id/approve
router.post('/admin/properties/:id/approve', authenticateToken, requireAdmin, (req, res) => {
  const propertyId = Number(req.params.id);
  const adminId = req.user.id;
  const { notes } = req.body || {};

  pool.query(
    `UPDATE properties
     SET review_status='approved',
         is_published=1,
         reviewed_at=NOW(),
         reviewed_by=?,
         review_notes=?
     WHERE id=? AND review_status='pending'`,
    [adminId, notes || null, propertyId],
    (err, r) => {
      if (err) return res.status(500).json({ error: 'Error aprobando propiedad' });
      if (!r.affectedRows) return res.status(404).json({ error: 'Propiedad no encontrada o no está pending' });
      res.json({ ok: true });
    }
  );
});

// POST /admin/properties/:id/reject
router.post('/admin/properties/:id/reject', authenticateToken, requireAdmin, (req, res) => {
  const propertyId = Number(req.params.id);
  const adminId = req.user.id;
  const { notes } = req.body || {};

  pool.query(
    `UPDATE properties
     SET review_status='rejected',
         is_published=0,
         reviewed_at=NOW(),
         reviewed_by=?,
         review_notes=?
     WHERE id=? AND review_status='pending'`,
    [adminId, notes || null, propertyId],
    (err, r) => {
      if (err) return res.status(500).json({ error: 'Error rechazando propiedad' });
      if (!r.affectedRows) return res.status(404).json({ error: 'Propiedad no encontrada o no está pending' });
      res.json({ ok: true });
    }
  );
});

// GET /admin/reports
router.get('/admin/reports', authenticateToken, async (req, res) => {
  try {
    // Verificar que sea admin
    if (req.user.agent_type !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { status } = req.query;

    let whereClause = '';
    let params = [];

    if (status && ['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
      whereClause = 'WHERE r.status = ?';
      params = [status];
    }

    const sql = `
      SELECT
        r.*,

        reporter.name AS reporter_name,
        reporter.last_name AS reporter_last_name,
        reporter.email AS reporter_email,
        reporter.phone AS reporter_phone,
        reporter.agent_type AS reporter_type,
        reporter.created_at AS reporter_created_at,

        p.id AS property_id,
        p.address AS property_address,
        p.type AS property_type,
        p.estate_type AS property_estate_type,
        p.price AS property_price,
        p.monthly_pay AS property_monthly_pay,
        p.bedrooms AS property_bedrooms,
        p.bathrooms AS property_bathrooms,
        p.land AS property_land,
        p.construction AS property_construction,
        p.description AS property_description,
        p.created_at AS property_created_at,
        p.is_published AS property_is_published,
        p.created_by AS property_owner_id,

        owner.name AS property_owner_name,
        owner.last_name AS property_owner_last_name,
        owner.email AS property_owner_email,
        owner.phone AS property_owner_phone,
        owner.agent_type AS property_owner_type,

        agent.id AS agent_id,
        agent.name AS agent_name,
        agent.last_name AS agent_last_name,
        agent.email AS agent_email,
        agent.phone AS agent_phone,
        agent.agent_type AS agent_type,
        agent.agent_verification_status AS agent_verification_status,
        agent.work_start AS agent_work_start,
        agent.work_end AS agent_work_end,
        agent.created_at AS agent_created_at,

        (SELECT COUNT(*) FROM chat_messages
         WHERE (sender_id = r.reporter_id AND receiver_id = r.reported_agent_id)
            OR (sender_id = r.reported_agent_id AND receiver_id = r.reporter_id)
        ) AS chat_messages_count

      FROM reports r
      LEFT JOIN users reporter ON reporter.id = r.reporter_id
      LEFT JOIN properties p ON p.id = r.reported_property_id
      LEFT JOIN users owner ON owner.id = p.created_by
      LEFT JOIN users agent ON agent.id = r.reported_agent_id
      ${whereClause}
      ORDER BY r.created_at DESC
    `;

    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('[GET /admin/reports] error', e);
    res.status(500).json({ error: 'Error al obtener reportes' });
  }
});

// GET /admin/reports/:id/chat-export
router.get('/admin/reports/:id/chat-export', authenticateToken, async (req, res) => {
  try {
    // Verificar que sea admin
    if (req.user.agent_type !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const reportId = req.params.id;

    // Obtener el reporte
    const [reportRows] = await pool.promise().query(
      `SELECT r.*,
              reporter.name AS reporter_name,
              reporter.last_name AS reporter_last_name,
              agent.name AS agent_name,
              agent.last_name AS agent_last_name
       FROM reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       LEFT JOIN users agent ON agent.id = r.reported_agent_id
       WHERE r.id = ? LIMIT 1`,
      [reportId]
    );

    if (!reportRows.length) {
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }

    const report = reportRows[0];

    if (report.report_type !== 'agent') {
      return res.status(400).json({ error: 'Solo se pueden exportar chats de reportes de agentes' });
    }

    // Obtener todos los mensajes entre el reportador y el agente reportado
    const [messages] = await pool.promise().query(
      `SELECT
        cm.*,
        sender.name AS sender_name,
        sender.last_name AS sender_last_name,
        receiver.name AS receiver_name,
        receiver.last_name AS receiver_last_name,
        p.address AS property_address
       FROM chat_messages cm
       LEFT JOIN users sender ON sender.id = cm.sender_id
       LEFT JOIN users receiver ON receiver.id = cm.receiver_id
       LEFT JOIN properties p ON p.id = cm.property_id
       WHERE (cm.sender_id = ? AND cm.receiver_id = ?)
          OR (cm.sender_id = ? AND cm.receiver_id = ?)
       ORDER BY cm.created_at ASC`,
      [report.reporter_id, report.reported_agent_id, report.reported_agent_id, report.reporter_id]
    );

    // Generar el contenido del archivo TXT
    let txtContent = '';
    txtContent += '='.repeat(80) + '\n';
    txtContent += 'EXPORTACIÓN DE CHAT - REPORTE #' + reportId + '\n';
    txtContent += '='.repeat(80) + '\n\n';

    txtContent += 'INFORMACIÓN DEL REPORTE:\n';
    txtContent += '-'.repeat(80) + '\n';
    txtContent += `Fecha del reporte: ${new Date(report.created_at).toLocaleString('es-MX')}\n`;
    txtContent += `Estado: ${report.status}\n`;
    txtContent += `Motivo: ${report.reason}\n`;
    txtContent += `Descripción: ${report.description}\n\n`;

    txtContent += 'PARTICIPANTES:\n';
    txtContent += '-'.repeat(80) + '\n';
    txtContent += `Reportador: ${report.reporter_name} ${report.reporter_last_name} (ID: ${report.reporter_id})\n`;
    txtContent += `Reportado: ${report.agent_name} ${report.agent_last_name} (ID: ${report.reported_agent_id})\n\n`;

    txtContent += 'MENSAJES (' + messages.length + ' total):\n';
    txtContent += '='.repeat(80) + '\n\n';

    if (messages.length === 0) {
      txtContent += 'No hay mensajes entre estos usuarios.\n';
    } else {
      for (const msg of messages) {
        const senderName = `${msg.sender_name} ${msg.sender_last_name}`;
        const timestamp = new Date(msg.created_at).toLocaleString('es-MX');
        const property = msg.property_address ? ` [Propiedad: ${msg.property_address}]` : '';

        txtContent += `[${timestamp}]${property}\n`;
        txtContent += `${senderName}: ${msg.message || '[Archivo adjunto]'}\n`;

        if (msg.file_url) {
          txtContent += `   \u{1F4CE} Archivo: ${msg.file_name || 'archivo'}\n`;
          txtContent += `   URL: ${msg.file_url}\n`;
        }

        txtContent += '\n';
      }
    }

    txtContent += '\n' + '='.repeat(80) + '\n';
    txtContent += 'FIN DEL CHAT\n';
    txtContent += '='.repeat(80) + '\n';

    // Enviar como descarga
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat_reporte_${reportId}_${Date.now()}.txt"`);
    res.send(txtContent);
  } catch (e) {
    console.error('[GET /admin/reports/:id/chat-export] error', e);
    res.status(500).json({ error: 'Error al exportar chat' });
  }
});

// PUT /admin/reports/:id/status
router.put('/admin/reports/:id/status', authenticateToken, async (req, res) => {
  try {
    // Verificar que sea admin
    if (req.user.agent_type !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const reportId = req.params.id;
    const { status, admin_notes } = req.body;

    if (!['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    await pool.promise().query(
      'UPDATE reports SET status = ?, admin_notes = ?, updated_at = NOW() WHERE id = ?',
      [status, admin_notes || null, reportId]
    );

    res.json({ ok: true, message: 'Reporte actualizado' });
  } catch (e) {
    console.error('[PUT /admin/reports/:id/status] error', e);
    res.status(500).json({ error: 'Error al actualizar reporte' });
  }
});

// DELETE /admin/reports/:id
router.delete('/admin/reports/:id', authenticateToken, async (req, res) => {
  try {
    // Verificar que sea admin
    if (req.user.agent_type !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const reportId = req.params.id;

    await pool.promise().query('DELETE FROM reports WHERE id = ?', [reportId]);

    res.json({ ok: true, message: 'Reporte eliminado' });
  } catch (e) {
    console.error('[DELETE /admin/reports/:id] error', e);
    res.status(500).json({ error: 'Error al eliminar reporte' });
  }
});

module.exports = router;
