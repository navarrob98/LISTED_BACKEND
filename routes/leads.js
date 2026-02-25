const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const redis = require('../db/redis');
const authenticateToken = require('../middleware/authenticateToken');

const AGENT_TYPES = ['individual', 'brokerage', 'seller'];

// POST /api/property-views
router.post('/api/property-views', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { property_id } = req.body || {};

    if (!property_id) {
      return res.status(400).json({ error: 'property_id es requerido' });
    }

    const key = `pv:${userId}:${property_id}`;
    const exists = await redis.exists(key);

    if (exists) {
      return res.status(200).json({ ok: true, throttled: true });
    }

    await pool.promise().query(
      'INSERT INTO property_views (property_id, user_id) VALUES (?, ?)',
      [property_id, userId]
    );

    await redis.set(key, '1', 'EX', 3600);

    return res.status(201).json({ ok: true, throttled: false });
  } catch (err) {
    console.error('Error logging property view:', err);
    return res.status(500).json({ error: 'Error al registrar vista' });
  }
});

// GET /api/leads
router.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    const agentId = req.user.id;

    // Verify user is agent type
    const [userRows] = await pool.promise().query(
      'SELECT agent_type FROM users WHERE id = ?',
      [agentId]
    );

    if (!userRows.length || !AGENT_TYPES.includes(userRows[0].agent_type)) {
      return res.status(403).json({ error: 'Solo agentes pueden ver leads' });
    }

    // Find distinct prospects who sent messages to this agent
    const [rows] = await pool.promise().query(
      `SELECT
        u.id AS prospect_id,
        u.name,
        u.last_name,
        u.profile_photo,
        MAX(cm.created_at) AS last_message_at,
        SUBSTRING_INDEX(GROUP_CONCAT(cm.property_id ORDER BY cm.created_at DESC), ',', 1) AS latest_property_id,
        GROUP_CONCAT(DISTINCT cm.property_id) AS property_ids,
        uqp.intent,
        uqp.purchase_timeline,
        uqp.has_pre_approval,
        uqp.pre_approval_amount,
        uqp.credit_score_range,
        uqp.bureau_status,
        bp_sub.suggested_price AS buying_power
      FROM chat_messages cm
      JOIN users u ON u.id = cm.sender_id
      LEFT JOIN user_qualifying_profile uqp ON uqp.user_id = cm.sender_id
      LEFT JOIN (
        SELECT user_id, suggested_price
        FROM buying_power
        ORDER BY created_at DESC
      ) bp_sub ON bp_sub.user_id = cm.sender_id
      WHERE cm.receiver_id = ?
        AND cm.is_deleted = 0
      GROUP BY u.id, u.name, u.last_name, u.profile_photo,
               uqp.intent, uqp.purchase_timeline, uqp.has_pre_approval,
               uqp.pre_approval_amount, uqp.credit_score_range,
               uqp.bureau_status, bp_sub.suggested_price`,
      [agentId]
    );

    // Get property addresses for all property IDs across all leads
    const allPropIds = [...new Set(
      rows.flatMap(r => (r.property_ids || '').split(',').filter(Boolean).map(Number))
    )];
    let propertyMap = {};
    if (allPropIds.length) {
      const [props] = await pool.promise().query(
        `SELECT p.id, p.address, p.type, p.price, p.monthly_pay,
                (SELECT pi.image_url FROM property_images pi WHERE pi.property_id = p.id ORDER BY pi.id ASC LIMIT 1) AS cover
         FROM properties p WHERE p.id IN (?)`,
        [allPropIds]
      );
      for (const p of props) {
        propertyMap[String(p.id)] = p;
      }
    }

    // Score and tier each lead
    const leads = rows.map(r => {
      let score = 0;

      // has qualifying profile row
      if (r.intent !== null || r.purchase_timeline !== null || r.has_pre_approval !== null) {
        score += 20;
      }
      if (r.has_pre_approval === 1) score += 25;
      if (r.credit_score_range === 'excellent' || r.credit_score_range === 'good') score += 15;
      if (r.purchase_timeline === '0-3 months' || r.purchase_timeline === '0-3 meses') score += 20;
      if (r.buying_power && Number(r.buying_power) > 0) score += 10;
      if (r.bureau_status === 'clean') score += 10;

      if (score > 100) score = 100;

      let tier;
      if (score >= 70) tier = 'Hot';
      else if (score >= 40) tier = 'Warm';
      else tier = 'Cold';

      // Build properties array for this lead
      const propIdList = (r.property_ids || '').split(',').filter(Boolean).map(Number);
      const properties = propIdList
        .map(pid => {
          const p = propertyMap[String(pid)];
          return p ? { id: pid, address: p.address, type: p.type, price: p.price, monthly_pay: p.monthly_pay, cover: p.cover } : null;
        })
        .filter(Boolean);

      const latestProp = propertyMap[String(r.latest_property_id)];

      return {
        prospect_id: r.prospect_id,
        name: r.name,
        last_name: r.last_name,
        profile_photo: r.profile_photo,
        last_message_at: r.last_message_at,
        latest_property_id: r.latest_property_id ? Number(r.latest_property_id) : null,
        property_address: latestProp?.address || null,
        properties,
        intent: r.intent,
        timeline: r.purchase_timeline || null,
        has_pre_approval: r.has_pre_approval,
        pre_approval_amount: r.pre_approval_amount,
        credit_score_range: r.credit_score_range,
        buying_power: r.buying_power ? Number(r.buying_power) : null,
        score,
        tier,
      };
    });

    // Sort
    const sort = req.query.sort || 'score';
    if (sort === 'score') {
      leads.sort((a, b) => b.score - a.score);
    } else if (sort === 'date') {
      leads.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    } else if (sort === 'name') {
      leads.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    return res.status(200).json({ leads });
  } catch (err) {
    console.error('Error fetching leads:', err);
    return res.status(500).json({ error: 'Error al obtener leads' });
  }
});

// GET /api/leads/property-stats
router.get('/api/leads/property-stats', authenticateToken, async (req, res) => {
  try {
    const rawIds = req.query.property_ids;
    if (!rawIds) {
      return res.status(400).json({ error: 'property_ids es requerido' });
    }

    const propertyIds = rawIds.split(',').map(Number).filter(n => n > 0).slice(0, 20);
    if (!propertyIds.length) {
      return res.status(400).json({ error: 'property_ids inválidos' });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    const [views, favorites, contacts] = await Promise.all([
      pool.promise().query(
        `SELECT property_id, COUNT(*) AS cnt
         FROM property_views
         WHERE property_id IN (?) AND viewed_at >= ?
         GROUP BY property_id`,
        [propertyIds, thirtyDaysAgo]
      ),
      pool.promise().query(
        `SELECT property_id, COUNT(*) AS cnt
         FROM property_favorites
         WHERE property_id IN (?)
         GROUP BY property_id`,
        [propertyIds]
      ),
      pool.promise().query(
        `SELECT property_id, COUNT(DISTINCT sender_id) AS cnt
         FROM chat_messages
         WHERE property_id IN (?) AND is_deleted = 0
         GROUP BY property_id`,
        [propertyIds]
      ),
    ]);

    const viewsMap = {};
    for (const r of views[0]) viewsMap[r.property_id] = r.cnt;

    const favsMap = {};
    for (const r of favorites[0]) favsMap[r.property_id] = r.cnt;

    const contactsMap = {};
    for (const r of contacts[0]) contactsMap[r.property_id] = r.cnt;

    const stats = {};
    for (const id of propertyIds) {
      stats[id] = {
        views: viewsMap[id] || 0,
        favorites: favsMap[id] || 0,
        contacts: contactsMap[id] || 0,
      };
    }

    return res.status(200).json(stats);
  } catch (err) {
    console.error('Error fetching property stats:', err);
    return res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

module.exports = router;
