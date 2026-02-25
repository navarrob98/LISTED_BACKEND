const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');

// GET /api/city-alerts — Cities the user has browsed (last 30 days, min 3 views) + global toggle
router.get('/api/city-alerts', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [[user]] = await pool.promise().query(
      'SELECT city_alerts_enabled FROM users WHERE id = ?',
      [userId]
    );
    const globalEnabled = user ? user.city_alerts_enabled !== 0 : true;

    const [rows] = await pool.promise().query(
      `SELECT
         p.city,
         COUNT(DISTINCT pv.property_id) AS viewed_count,
         MAX(pv.viewed_at) AS last_viewed,
         IF(cam.id IS NULL, 1, 0) AS is_active
       FROM property_views pv
       JOIN properties p ON p.id = pv.property_id
       LEFT JOIN city_alert_mutes cam
         ON cam.user_id = ? AND cam.city = p.city
       WHERE pv.user_id = ?
         AND p.city IS NOT NULL
         AND pv.viewed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY p.city, cam.id
       HAVING COUNT(DISTINCT pv.property_id) >= 3
       ORDER BY last_viewed DESC`,
      [userId, userId]
    );

    return res.status(200).json({ globalEnabled, cities: rows });
  } catch (err) {
    console.error('Error listing city alerts:', err);
    return res.status(500).json({ error: 'Error al obtener alertas' });
  }
});

// PUT /api/city-alerts/global-toggle — Enable/disable all city alerts
router.put('/api/city-alerts/global-toggle', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await pool.promise().query(
      'UPDATE users SET city_alerts_enabled = IF(city_alerts_enabled = 1, 0, 1) WHERE id = ?',
      [userId]
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error toggling global city alerts:', err);
    return res.status(500).json({ error: 'Error al cambiar estado de alertas' });
  }
});

// PUT /api/city-alerts/:city/toggle — Toggle mute for a city
router.put('/api/city-alerts/:city/toggle', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const city = decodeURIComponent(req.params.city);

    // Check if mute exists
    const [existing] = await pool.promise().query(
      'SELECT id FROM city_alert_mutes WHERE user_id = ? AND city = ?',
      [userId, city]
    );

    if (existing.length > 0) {
      // Remove mute (activate alerts)
      await pool.promise().query(
        'DELETE FROM city_alert_mutes WHERE user_id = ? AND city = ?',
        [userId, city]
      );
    } else {
      // Add mute (silence alerts)
      await pool.promise().query(
        'INSERT INTO city_alert_mutes (user_id, city) VALUES (?, ?)',
        [userId, city]
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error toggling city alert:', err);
    return res.status(500).json({ error: 'Error al cambiar estado de alerta' });
  }
});

module.exports = router;
