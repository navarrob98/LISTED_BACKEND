const pool = require('../db/pool');
const { sendPushToUser } = require('../utils/helpers');

function q(sql, params) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function matchAndNotify(propertyId) {
  // 1. Get city of the approved property
  const [property] = await q(
    'SELECT id, city, address FROM properties WHERE id = ? AND is_published = 1',
    [propertyId]
  );
  if (!property || !property.city) return;

  const { city } = property;

  // 2. Users who viewed >=3 properties in this city in last 30 days,
  //    excluding muted cities and globally disabled
  const users = await q(
    `SELECT pv.user_id
     FROM property_views pv
     JOIN properties p ON p.id = pv.property_id
     JOIN users u ON u.id = pv.user_id
     WHERE p.city = ?
       AND pv.viewed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       AND u.city_alerts_enabled = 1
       AND pv.user_id NOT IN (
         SELECT user_id FROM city_alert_mutes WHERE city = ?
       )
     GROUP BY pv.user_id
     HAVING COUNT(DISTINCT pv.property_id) >= 3`,
    [city, city]
  );

  // 3. Notify each user (dedup via saved_search_notifications)
  for (const { user_id } of users) {
    try {
      const existing = await q(
        'SELECT id FROM saved_search_notifications WHERE user_id = ? AND property_id = ?',
        [user_id, propertyId]
      );
      if (existing.length > 0) continue;

      await q(
        'INSERT INTO saved_search_notifications (user_id, property_id) VALUES (?, ?)',
        [user_id, propertyId]
      );

      sendPushToUser({
        userId: user_id,
        title: `Nueva propiedad en ${city}`,
        body: property.address || `Se publicó una propiedad en ${city}`,
        data: { type: 'smart_alert', propertyId: String(propertyId) },
      });
    } catch (err) {
      console.error(`[smart-alerts] Error notifying user ${user_id}:`, err);
    }
  }
}

module.exports = { matchAndNotify };
