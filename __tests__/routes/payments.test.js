const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');

const mockCreate = jest.fn();
const mockRetrieve = jest.fn();
const mockConstructEvent = jest.fn();

jest.mock('stripe', () => {
  return jest.fn(() => ({
    paymentIntents: { create: mockCreate, retrieve: mockRetrieve },
    webhooks: { constructEvent: mockConstructEvent },
  }));
});

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'individual' };
  next();
});

const mockPromiseQuery = jest.fn();
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const router = require('../../routes/payments');
const app = express();
// payments router has its own express.json()/express.raw() per route
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('POST /stripe/webhook', () => {
  it('should return 400 on invalid signature', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await request(app)
      .post('/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'invalid')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(400);
  });

  it('should handle payment_intent.succeeded', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123' } },
    });
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, property_id: 10 }]]) // select promotion
      .mockResolvedValueOnce([{}]) // update promotion
      .mockResolvedValueOnce([{}]); // update property

    const res = await request(app)
      .post('/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('should handle payment_intent.succeeded with no promotion found', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_999' } },
    });
    mockPromiseQuery.mockResolvedValueOnce([[]]); // no promotion

    const res = await request(app)
      .post('/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(200);
  });

  it('should handle payment_intent.payment_failed', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_fail' } },
    });
    mockPromiseQuery.mockResolvedValueOnce([{}]);

    const res = await request(app)
      .post('/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(200);
  });

  it('should return 500 on handler error', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123' } },
    });
    mockPromiseQuery.mockRejectedValueOnce(new Error('db fail'));

    const res = await request(app)
      .post('/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(500);
  });
});

describe('POST /payments/promote/create-intent', () => {
  it('should return 400 if missing propertyId', async () => {
    const res = await request(app).post('/payments/promote/create-intent').send({});
    expect(res.status).toBe(400);
  });

  it('should return 404 if property not found', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[]]) // property not found
      .mockResolvedValueOnce([[{ promoted_until: null }]]); // promoted check
    const res = await request(app).post('/payments/promote/create-intent').send({ propertyId: 99 });
    expect(res.status).toBe(404);
  });

  it('should return 403 if not owner', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 999 }]]) // different owner
      .mockResolvedValueOnce([[{ promoted_until: null }]]);
    const res = await request(app).post('/payments/promote/create-intent').send({ propertyId: 1 });
    expect(res.status).toBe(403);
  });

  it('should return 409 if already promoted', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 1 }]])
      .mockResolvedValueOnce([[{ promoted_until: future }]]);
    const res = await request(app).post('/payments/promote/create-intent').send({ propertyId: 1 });
    expect(res.status).toBe(409);
  });

  it('should create payment intent successfully', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 1 }]])
      .mockResolvedValueOnce([[{ promoted_until: null }]])
      .mockResolvedValueOnce([{ insertId: 5 }]) // insert promotion
      .mockResolvedValueOnce([{}]); // update promotion with PI id

    mockCreate.mockResolvedValue({ id: 'pi_test', client_secret: 'secret_test' });

    const res = await request(app).post('/payments/promote/create-intent').send({ propertyId: 1 });
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe('secret_test');
  });

  it('should return 500 on general error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/payments/promote/create-intent').send({ propertyId: 1 });
    expect(res.status).toBe(500);
  });

  it('should return 400 on Stripe error', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 1 }]])
      .mockResolvedValueOnce([[{ promoted_until: null }]])
      .mockResolvedValueOnce([{ insertId: 5 }]);

    const stripeErr = new Error('bad request');
    stripeErr.type = 'StripeInvalidRequestError';
    mockCreate.mockRejectedValue(stripeErr);

    const res = await request(app).post('/payments/promote/create-intent').send({ propertyId: 1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /payments/promote/confirm', () => {
  it('should return 400 if missing paymentIntentId', async () => {
    const res = await request(app).post('/payments/promote/confirm').send({});
    expect(res.status).toBe(400);
  });

  it('should return 400 if payment not succeeded', async () => {
    mockRetrieve.mockResolvedValue({ status: 'requires_payment_method' });
    const res = await request(app).post('/payments/promote/confirm').send({ paymentIntentId: 'pi_1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('payment_not_succeeded');
  });

  it('should return 404 if promotion not found', async () => {
    mockRetrieve.mockResolvedValue({ status: 'succeeded' });
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/payments/promote/confirm').send({ paymentIntentId: 'pi_1' });
    expect(res.status).toBe(404);
  });

  it('should return 403 if not owner of promotion', async () => {
    mockRetrieve.mockResolvedValue({ status: 'succeeded' });
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, property_id: 10, user_id: 999, status: 'pending' }]]);
    const res = await request(app).post('/payments/promote/confirm').send({ paymentIntentId: 'pi_1' });
    expect(res.status).toBe(403);
  });

  it('should return already:true if already paid', async () => {
    mockRetrieve.mockResolvedValue({ status: 'succeeded' });
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, property_id: 10, user_id: 1, status: 'paid' }]]);
    const res = await request(app).post('/payments/promote/confirm').send({ paymentIntentId: 'pi_1' });
    expect(res.status).toBe(200);
    expect(res.body.already).toBe(true);
  });

  it('should confirm payment successfully', async () => {
    mockRetrieve.mockResolvedValue({ status: 'succeeded' });
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, property_id: 10, user_id: 1, status: 'pending' }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);
    const res = await request(app).post('/payments/promote/confirm').send({ paymentIntentId: 'pi_1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 500 on error', async () => {
    mockRetrieve.mockRejectedValue(new Error('fail'));
    const res = await request(app).post('/payments/promote/confirm').send({ paymentIntentId: 'pi_1' });
    expect(res.status).toBe(500);
  });
});
