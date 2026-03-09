const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'regular' };
  next();
});

const mockPromiseQuery = jest.fn();
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const router = require('../../routes/savedSearches');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('GET /api/city-alerts', () => {
  it('should return city alerts with global toggle', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ city_alerts_enabled: 1 }]])
      .mockResolvedValueOnce([[{ city: 'CDMX', viewed_count: 5, last_viewed: '2024-01-01', is_active: 1 }]]);
    const res = await request(app).get('/api/city-alerts');
    expect(res.status).toBe(200);
    expect(res.body.globalEnabled).toBe(true);
    expect(res.body.cities).toHaveLength(1);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/city-alerts');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/city-alerts/global-toggle', () => {
  it('should toggle global alerts', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    const res = await request(app).put('/api/city-alerts/global-toggle');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/city-alerts/global-toggle');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/city-alerts/:city/toggle', () => {
  it('should remove mute if exists (activate alerts)', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1 }]]) // existing mute
      .mockResolvedValueOnce([{}]); // delete
    const res = await request(app).put('/api/city-alerts/CDMX/toggle');
    expect(res.status).toBe(200);
  });

  it('should add mute if not exists (silence alerts)', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[]]) // no existing mute
      .mockResolvedValueOnce([{}]); // insert
    const res = await request(app).put('/api/city-alerts/CDMX/toggle');
    expect(res.status).toBe(200);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/city-alerts/CDMX/toggle');
    expect(res.status).toBe(500);
  });
});
