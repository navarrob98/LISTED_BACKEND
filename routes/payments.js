const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authenticateToken = require('../middleware/authenticateToken');

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// POST /stripe/webhook
// CRITICAL: raw body for Stripe signature verification
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[stripe/webhook] constructEvent error:', err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object; // Stripe.PaymentIntent
      const [rows] = await pool.promise().query(
        'SELECT id, property_id FROM promotions WHERE stripe_payment_intent=? LIMIT 1',
        [pi.id]
      );
      const promo = Array.isArray(rows) && rows[0];
      if (promo) {
        await pool.promise().query(
          'UPDATE promotions SET status="paid", expires_at=DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE id=?',
          [promo.id]
        );
        await pool.promise().query(
          'UPDATE properties SET promoted_until=DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE id=?',
          [promo.property_id]
        );
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object; // Stripe.PaymentIntent
      await pool.promise().query(
        'UPDATE promotions SET status="canceled" WHERE stripe_payment_intent=?',
        [pi.id]
      );
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('[stripe/webhook] handler error:', e);
    return res.status(500).send('Server error');
  }
});

// POST /payments/promote/create-intent
router.post('/payments/promote/create-intent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { propertyId } = req.body || {};
    if (!propertyId) return res.status(400).json({ error: 'Falta propertyId' });

    // 1) Valida que la propiedad sea del usuario
    const [rows] = await pool.promise().query(
      'SELECT id, created_by FROM properties WHERE id=? LIMIT 1',
      [propertyId]
    );
    // Verifica si ya está promocionada
    const [prow] = await pool.promise().query(
      'SELECT promoted_until FROM properties WHERE id=? LIMIT 1',
      [propertyId]
    );
    const promotedUntil = Array.isArray(prow) && prow[0]?.promoted_until;
    if (promotedUntil && new Date(promotedUntil).getTime() > Date.now()) {
      return res.status(409).json({ error: 'already_promoted', message: 'La propiedad ya está promocionada.' });
    }
    const prop = Array.isArray(rows) && rows[0];
    if (!prop) return res.status(404).json({ error: 'Propiedad no encontrada' });
    if (String(prop.created_by) !== String(userId)) {
      return res.status(403).json({ error: 'No autorizad@' });
    }

    // 2) Crea registro en promotions
    const amount = 10000; // 100 MXN en centavos
    const currency = 'mxn';
    const [ins] = await pool.promise().query(
      `INSERT INTO promotions (property_id, user_id, amount_cents, currency, status)
       VALUES (?,?,?,?, 'pending')`,
      [propertyId, userId, amount, currency]
    );
    const promoId = ins.insertId;

    // 3) Crea PaymentIntent
    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        propertyId: String(propertyId),
        promotionId: String(promoId),
        userId: String(userId),
      },
    });

    // 4) Guarda el id del PI
    await pool.promise().query(
      'UPDATE promotions SET stripe_payment_intent=? WHERE id=?',
      [intent.id, promoId]
    );

    return res.json({ clientSecret: intent.client_secret });
  } catch (e) {
    console.error('[create-intent] error', e);
    return res.status(500).json({ error: 'No se pudo crear el intento de pago' });
  }
});

module.exports = router;
