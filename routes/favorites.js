const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');

// POST /api/favorites
router.post('/api/favorites', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { property_id } = req.body || {};

    if (!property_id) {
      return res.status(400).json({ error: 'property_id es requerido' });
    }

    await pool.promise().query(
      'INSERT INTO property_favorites (user_id, property_id) VALUES (?, ?)',
      [userId, property_id]
    );

    return res.status(201).json({ message: 'Agregado a favoritos', property_id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya está en favoritos' });
    }
    console.error('Error adding favorite:', err);
    return res.status(500).json({ error: 'Error al agregar favorito' });
  }
});

// DELETE /api/favorites/:propertyId
router.delete('/api/favorites/:propertyId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const propertyId = Number(req.params.propertyId);

    const [result] = await pool.promise().query(
      'DELETE FROM property_favorites WHERE user_id = ? AND property_id = ?',
      [userId, propertyId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'No encontrado en favoritos' });
    }

    return res.status(200).json({ message: 'Eliminado de favoritos' });
  } catch (err) {
    console.error('Error removing favorite:', err);
    return res.status(500).json({ error: 'Error al eliminar favorito' });
  }
});

// GET /api/favorites
router.get('/api/favorites', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.promise().query(
      `SELECT
        p.id,
        p.type,
        p.address,
        p.price,
        p.monthly_pay,
        p.bedrooms,
        p.bathrooms,
        p.land,
        p.construction,
        p.estate_type,
        p.lat,
        p.lng,
        pf.created_at AS created_at_fav,
        (SELECT image_url
          FROM property_images pi
          WHERE pi.property_id = p.id
          ORDER BY pi.id ASC
          LIMIT 1) AS first_image
      FROM property_favorites pf
      JOIN properties p ON p.id = pf.property_id
      WHERE pf.user_id = ?
        AND p.is_published = 1
      ORDER BY pf.created_at DESC`,
      [userId]
    );

    const favorites = rows.map(row => ({
      id: row.id,
      type: row.type,
      address: row.address,
      price: row.price,
      monthly_pay: row.monthly_pay,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      land: row.land,
      construction: row.construction,
      images: row.first_image ? [row.first_image] : [],
      estate_type: row.estate_type,
      lat: row.lat,
      lng: row.lng,
      created_at_fav: row.created_at_fav,
    }));

    return res.status(200).json({ favorites });
  } catch (err) {
    console.error('Error fetching favorites:', err);
    return res.status(500).json({ error: 'Error al obtener favoritos' });
  }
});

// GET /api/favorites/status/:propertyId
router.get('/api/favorites/status/:propertyId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const propertyId = Number(req.params.propertyId);

    const [rows] = await pool.promise().query(
      'SELECT id FROM property_favorites WHERE user_id = ? AND property_id = ? LIMIT 1',
      [userId, propertyId]
    );

    return res.status(200).json({ is_favorite: rows.length > 0 });
  } catch (err) {
    console.error('Error checking favorite status:', err);
    return res.status(500).json({ error: 'Error al verificar favorito' });
  }
});

module.exports = router;
