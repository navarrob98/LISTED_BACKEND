const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../db/redis', () => ({
  exists: jest.fn(),
  set: jest.fn(),
}));
jest.mock('../../middleware/authenticateToken');

const pool = require('../../db/pool');
const redis = require('../../db/redis');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'individual' };
  next();
});

const mockPromiseQuery = jest.fn();
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const router = require('../../routes/leads');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => {
  jest.clearAllMocks();
  mockPromiseQuery.mockReset();
  pool.promise.mockReturnValue({ query: mockPromiseQuery });
});

describe('POST /api/property-views', () => {
  it('should log a view', async () => {
    redis.exists.mockResolvedValue(0);
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    redis.set.mockResolvedValue('OK');

    const res = await request(app).post('/api/property-views').send({ property_id: 10 });
    expect(res.status).toBe(201);
    expect(res.body.throttled).toBe(false);
  });

  it('should throttle repeated views', async () => {
    redis.exists.mockResolvedValue(1);
    const res = await request(app).post('/api/property-views').send({ property_id: 10 });
    expect(res.status).toBe(200);
    expect(res.body.throttled).toBe(true);
  });

  it('should return 400 if missing property_id', async () => {
    const res = await request(app).post('/api/property-views').send({});
    expect(res.status).toBe(400);
  });

  it('should return 500 on DB error', async () => {
    redis.exists.mockResolvedValue(0);
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/property-views').send({ property_id: 10 });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/leads', () => {
  it('should return 403 for non-agents', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ agent_type: 'regular' }]]);
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(403);
  });

  it('should return leads for agents', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ agent_type: 'individual' }]]) // user check
      .mockResolvedValueOnce([[ // leads query
        {
          prospect_id: 2, name: 'Client', last_name: 'Test', profile_photo: null,
          last_message_at: '2024-01-01', latest_property_id: '10', property_ids: '10',
          intent: 'buy', purchase_timeline: '0-3 months', has_pre_approval: 1,
          pre_approval_amount: 1000000, credit_score_range: 'excellent',
          bureau_status: 'clean', buying_power: 2000000,
        }
      ]])
      .mockResolvedValueOnce([[ // properties
        { id: 10, address: 'Test', type: 'venta', price: 100, monthly_pay: null, cover: 'img.jpg' }
      ]]);

    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].tier).toBe('Hot');
  });

  it('should sort by date', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ agent_type: 'individual' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/leads?sort=date');
    expect(res.status).toBe(200);
  });

  it('should return 500 on error', async () => {
    const failQuery = jest.fn().mockRejectedValue(new Error('fail'));
    pool.promise.mockReturnValue({ query: failQuery });
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/leads/property-stats', () => {
  it('should return stats', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ property_id: 10, cnt: 5 }]])
      .mockResolvedValueOnce([[{ property_id: 10, cnt: 2 }]])
      .mockResolvedValueOnce([[{ property_id: 10, cnt: 3 }]]);

    const res = await request(app).get('/api/leads/property-stats?property_ids=10');
    expect(res.status).toBe(200);
    expect(res.body['10'].views).toBe(5);
  });

  it('should return 400 if missing property_ids', async () => {
    const res = await request(app).get('/api/leads/property-stats');
    expect(res.status).toBe(400);
  });

  it('should return 400 for invalid ids', async () => {
    const res = await request(app).get('/api/leads/property-stats?property_ids=abc');
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/leads/property-stats?property_ids=10');
    expect(res.status).toBe(500);
  });
});
