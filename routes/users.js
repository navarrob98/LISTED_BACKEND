const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');
const bcrypt = require('bcrypt');
const cloudinary = require('../cldnry');
const {
  deleteUserChatUploadsByFolder,
  deleteUserPropertyUploadsByFolder,
} = require('../cloud-folder-delete');
const { q } = require('../utils/helpers');

// GET /users/:id
router.get('/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  pool.query(
    'SELECT id, name, last_name, email, profile_photo FROM users WHERE id = ? LIMIT 1',
    [id],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error buscando usuario' });
      if (!results.length) return res.status(404).json({ error: 'No encontrado' });
      res.json(results[0]);
    }
  );
});

// PUT /users/:id
router.put('/users/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

  const { phone, email, password, work_start, work_end, name, last_name } = req.body || {};

  // Bloquear cambio de email
  if (email !== undefined) {
    return res.status(400).json({ error: 'El correo no se puede cambiar.' });
  }

  // Traer usuario actual (para detectar cambios)
  let current;
  try {
    const [rows] = await pool.promise().query(
      `SELECT id, agent_type, name, last_name
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    if (!rows?.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    current = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Error consultando usuario' });
  }

  const updates = [];
  const values = [];

  // Helpers para comparar limpio
  const clean = (v) => (v === undefined || v === null) ? undefined : String(v).trim();
  const currName = clean(current.name) || '';
  const currLast = clean(current.last_name) || '';

  const newName = clean(name);
  const newLast = clean(last_name);

  const nameChanged = (newName !== undefined) && (newName !== currName);
  const lastChanged = (newLast !== undefined) && (newLast !== currLast);

  if (phone !== undefined) { updates.push('phone = ?'); values.push(phone || null); }

  if (password !== undefined) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Contraseña muy corta' });
    const hashedPassword = bcrypt.hashSync(String(password), 10);
    updates.push('password = ?');
    values.push(hashedPassword);
  }

  if (work_start !== undefined) { updates.push('work_start = ?'); values.push(work_start || null); }
  if (work_end !== undefined)   { updates.push('work_end = ?'); values.push(work_end || null); }

  if (newName !== undefined) { updates.push('name = ?'); values.push(newName); }
  if (newLast !== undefined) { updates.push('last_name = ?'); values.push(newLast); }

  const isVerifiableAgent = ['brokerage', 'individual'].includes(current.agent_type);

  if (isVerifiableAgent && (nameChanged || lastChanged)) {
    updates.push(`agent_verification_status = 'pending'`);
    updates.push(`agent_rejection_reason = NULL`);
    updates.push(`agent_verified_at = NULL`);
    updates.push(`agent_verified_by = NULL`);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(id);

  try {
    await pool.promise().query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const [rows2] = await pool.promise().query(
      `SELECT id, name, last_name, email, phone, work_start, work_end,
              agent_verification_status, agent_rejection_reason, profile_photo
       FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    return res.json(rows2?.[0] || { ok: true });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: 'No se pudo actualizar' });
  }
});

// GET /users/:id/profile-photo
router.get('/users/:id/profile-photo', async (req, res) => {
  try {
    const userId = req.params.id;

    const [rows] = await pool.promise().query(
      'SELECT profile_photo FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    if (!rows || !rows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ profile_photo: rows[0].profile_photo || null });
  } catch (e) {
    console.error('[GET /users/:id/profile-photo] error', e);
    res.status(500).json({ error: 'Error al obtener foto de perfil' });
  }
});

// POST /users/me/profile-photo/sign-upload
router.post('/users/me/profile-photo/sign-upload', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { file_name } = req.body || {};

    if (!file_name) {
      return res.status(400).json({ error: 'Falta file_name' });
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const baseFolder = process.env.CLD_BASE_FOLDER || 'listed';
    const envFolder = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const folder = `${baseFolder}/${envFolder}/image/u_${userId}`;

    const upload_preset = process.env.CLD_PRESET_PUBLIC;
    if (!upload_preset) {
      return res.status(500).json({ error: 'Falta configurar CLD_PRESET_PUBLIC' });
    }

    const toSign = {
      timestamp,
      upload_preset,
      folder,
      use_filename: 'true',
      unique_filename: 'false',
    };

    const signature = cloudinary.utils.api_sign_request(toSign, process.env.CLOUDINARY_API_SECRET);

    return res.json({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      upload_preset,
      folder,
      use_filename: true,
      unique_filename: false,
      resource_type: 'image',
    });
  } catch (e) {
    console.error('[POST /users/me/profile-photo/sign-upload] error', e);
    res.status(500).json({ error: 'Error al obtener firma para upload' });
  }
});

// PUT /users/me/profile-photo
router.put('/users/me/profile-photo', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { profile_photo } = req.body;

    if (!profile_photo || typeof profile_photo !== 'string') {
      return res.status(400).json({ error: 'URL de foto inválida' });
    }

    // Validar que sea una URL de Cloudinary válida
    if (!profile_photo.includes('cloudinary.com')) {
      return res.status(400).json({ error: 'Solo se permiten URLs de Cloudinary' });
    }

    // Validar que la imagen esté en la carpeta correcta del usuario
    const expectedFolder = `listed/${process.env.NODE_ENV === 'production' ? 'prod' : 'dev'}/image/u_${userId}`;
    if (!profile_photo.includes(expectedFolder)) {
      console.warn('[PUT /users/me/profile-photo] imagen en ruta sospechosa', {
        userId,
        profile_photo,
        expectedFolder
      });
      // Nota: Permitimos por flexibilidad, pero lo registramos
    }

    await pool.promise().query(
      'UPDATE users SET profile_photo = ?, updated_at = NOW() WHERE id = ?',
      [profile_photo, userId]
    );

    res.json({ ok: true, profile_photo });
  } catch (e) {
    console.error('[PUT /users/me/profile-photo] error', e);
    res.status(500).json({ error: 'Error al actualizar foto de perfil' });
  }
});

// DELETE /users/me/profile-photo
router.delete('/users/me/profile-photo', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Obtener la URL actual de la foto
    const [rows] = await pool.promise().query(
      'SELECT profile_photo FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    if (!rows || !rows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const currentPhoto = rows[0].profile_photo;

    // 2. Eliminar de Cloudinary si existe
    if (currentPhoto && currentPhoto.includes('cloudinary.com')) {
      try {
        // Extraer public_id de la URL
        const urlParts = currentPhoto.split('/');
        const uploadIndex = urlParts.indexOf('upload');
        if (uploadIndex !== -1 && uploadIndex + 2 < urlParts.length) {
          // Obtener todo después de /upload/v{timestamp}/
          const pathAfterVersion = urlParts.slice(uploadIndex + 2).join('/');
          // Quitar la extensión del archivo
          const publicId = pathAfterVersion.replace(/\.[^/.]+$/, '');

          const cloudinary = require('cloudinary').v2;
          cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET,
          });

          await cloudinary.uploader.destroy(publicId);
          console.log('[DELETE profile-photo] Imagen eliminada de Cloudinary:', publicId);
        }
      } catch (cloudinaryError) {
        console.error('[DELETE profile-photo] Error eliminando de Cloudinary:', cloudinaryError);
        // Continuar aunque falle la eliminación de Cloudinary
      }
    }

    // 3. Eliminar de la base de datos
    await pool.promise().query(
      'UPDATE users SET profile_photo = NULL WHERE id = ?',
      [userId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /users/me/profile-photo] error', e);
    res.status(500).json({ error: 'Error al eliminar foto de perfil' });
  }
});

// GET /users/:id/delete-preview
router.get('/users/:id/delete-preview', authenticateToken, (req, res) => {
  const uid = Number(req.params.id);
  if (uid !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

  const qProps = `
    SELECT id, address, price
    FROM properties
    WHERE created_by = ?
    ORDER BY id DESC
    LIMIT 200
  `;

  const qCounts = `
    SELECT
      (SELECT COUNT(*) FROM properties WHERE created_by = ?)                          AS properties,
      (SELECT COUNT(*) FROM property_images pi JOIN properties p ON p.id=pi.property_id WHERE p.created_by = ?) AS property_images,
      (SELECT COUNT(*) FROM chat_messages WHERE sender_id = ? OR receiver_id = ?)     AS chat_messages,
      (SELECT COUNT(*) FROM hidden_chats WHERE user_id = ? OR chat_with_user_id = ?)  AS hidden_chats,
      (SELECT COUNT(*) FROM tenant_profiles WHERE user_id = ?)                        AS tenant_profiles,
      (SELECT COUNT(*) FROM buying_power WHERE user_id = ?)                           AS buying_power
  `;

  pool.query(qProps, [uid], (e1, rowsProps=[]) => {
    if (e1) return res.status(500).json({ error: 'No se pudo obtener propiedades' });

    pool.query(qCounts, [uid, uid, uid, uid, uid, uid, uid, uid], (e2, rowsC=[]) => {
      if (e2) return res.status(500).json({ error: 'No se pudo obtener conteos' });
      const counts = rowsC[0] || {
        properties: 0, property_images: 0, chat_messages: 0,
        hidden_chats: 0, tenant_profiles: 0, buying_power: 0
      };
      res.json({ properties: rowsProps, counts });
    });
  });
});

// POST /users/:id/delete-account
router.post('/users/:id/delete-account', authenticateToken, async (req, res) => {
  const uid = Number(req.params.id);
  if (uid !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

  // Abre conexión + TX
  let cxn;
  try {
    cxn = await new Promise((resolve, reject) => pool.getConnection((e, c) => e ? reject(e) : resolve(c)));
  } catch (e) {
    console.error('[delete-account] getConnection error', e);
    return res.status(500).json({ error: 'No se pudo procesar la solicitud' });
  }
  const began = await new Promise(ok => cxn.beginTransaction(err => ok(!err)));
  if (!began) {
    cxn.release();
    return res.status(500).json({ error: 'No se pudo procesar la solicitud' });
  }

  try {
    // 1) Prepara IDs de propiedades del usuario (evita DELETE ... JOIN)
    const props = await q(
      cxn,
      'SELECT id FROM properties WHERE created_by = ?',
      [uid],
      'select_properties'
    );
    const propIds = props.map(r => r.id);
    // 2) chat_messages
    await q(
      cxn,
      'DELETE FROM chat_messages WHERE sender_id = ? OR receiver_id = ?',
      [uid, uid],
      'delete_chat_messages'
    );
    // 3) hidden_chats
    await q(
      cxn,
      'DELETE FROM hidden_chats WHERE user_id = ? OR chat_with_user_id = ?',
      [uid, uid],
      'delete_hidden_chats'
    );
    // 4) tenant_profiles
    await q(
      cxn,
      'DELETE FROM tenant_profiles WHERE user_id = ?',
      [uid],
      'delete_tenant_profiles'
    );
    // 5) buying_power
    await q(
      cxn,
      'DELETE FROM buying_power WHERE user_id = ?',
      [uid],
      'delete_buying_power'
    );
    // 6) property_images (solo si hay props)
    if (propIds.length) {
      // Borra en lotes para no pasar el límite de placeholders
      const CHUNK = 500;
      for (let i = 0; i < propIds.length; i += CHUNK) {
        const slice = propIds.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        await q(
          cxn,
          `DELETE FROM property_images WHERE property_id IN (${placeholders})`,
          slice,
          'delete_property_images'
        );
      }
    }
    // 7) properties
    await q(
      cxn,
      'DELETE FROM properties WHERE created_by = ?',
      [uid],
      'delete_properties'
    );

    // 8A) Cloudinary – borra TODO lo del usuario en CHATS por carpeta u_<uid>
    try {
      await deleteUserChatUploadsByFolder(uid);
    } catch (e) {
      console.error('[delete-account] cloudinary chats error', e);
      await new Promise(ok => cxn.rollback(() => ok(null)));
      cxn.release();
      return res.status(500).json({ error: 'No se pudo completar la eliminación de la cuenta' });
    }

    // 8B) Cloudinary – borra TODO lo del usuario en PROPIEDADES por carpeta listed/<env>/image/u_<uid>
    try {
      await deleteUserPropertyUploadsByFolder(uid);
    } catch (e) {
      console.error('[delete-account] cloudinary properties error', e);
      await new Promise(ok => cxn.rollback(() => ok(null)));
      cxn.release();
      return res.status(500).json({ error: 'No se pudo completar la eliminación de la cuenta' });
    }

    // 9) users
    await q(
      cxn,
      'DELETE FROM users WHERE id = ?',
      [uid],
      'delete_user'
    );

    // 10) Commit
    const committed = await new Promise(ok => cxn.commit(err => ok(!err)));
    if (!committed) {
      await new Promise(ok => cxn.rollback(() => ok(null)));
      cxn.release();
      return res.status(500).json({ error: 'No se pudo completar la eliminación de la cuenta' });
    }

    cxn.release();
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete-account] error', { step: e?._step, code: e?.code, sqlMessage: e?.sqlMessage, message: e?.message });
    await new Promise(ok => cxn.rollback(() => ok(null)));
    cxn.release();
    return res.status(500).json({ error: 'No se pudo completar la eliminación de la cuenta' });
  }
});

module.exports = router;
