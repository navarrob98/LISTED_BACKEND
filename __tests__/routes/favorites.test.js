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

const router = require('../../routes/favorites');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('POST /api/favorites', () => {
  it('should add a favorite', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{ insertId: 1 }]);
    const res = await request(app).post('/api/favorites').send({ property_id: 10 });
    expect(res.status).toBe(201);
    expect(res.body.property_id).toBe(10);
  });

  it('should return 400 if property_id missing', async () => {
    const res = await request(app).post('/api/favorites').send({});
    expect(res.status).toBe(400);
  });

  it('should return 409 on duplicate', async () => {
    const err = new Error('dup');
    err.code = 'ER_DUP_ENTRY';
    mockPromiseQuery.mockRejectedValueOnce(err);
    const res = await request(app).post('/api/favorites').send({ property_id: 10 });
    expect(res.status).toBe(409);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/favorites').send({ property_id: 10 });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/favorites/:propertyId', () => {
  it('should remove a favorite', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app).delete('/api/favorites/10');
    expect(res.status).toBe(200);
  });

  it('should return 404 if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(app).delete('/api/favorites/10');
    expect(res.status).toBe(404);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).delete('/api/favorites/10');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/favorites', () => {
  it('should return favorites list', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[
      { id: 1, type: 'venta', address: 'addr', price: 100, monthly_pay: null, bedrooms: 2, bathrooms: 1, land: 100, construction: 80, first_image: 'img.jpg', estate_type: 'casa', lat: 20, lng: -100, created_at_fav: '2024-01-01' },
    ]]);
    const res = await request(app).get('/api/favorites');
    expect(res.status).toBe(200);
    expect(res.body.favorites).toHaveLength(1);
    expect(res.body.favorites[0].images).toEqual(['img.jpg']);
  });

  it('should handle row with no image', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[
      { id: 1, type: 'venta', address: 'addr', price: 100, monthly_pay: null, bedrooms: 2, bathrooms: 1, land: 100, construction: 80, first_image: null, estate_type: 'casa', lat: 20, lng: -100, created_at_fav: '2024-01-01' },
    ]]);
    const res = await request(app).get('/api/favorites');
    expect(res.body.favorites[0].images).toEqual([]);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/favorites');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/favorites/status/:propertyId', () => {
  it('should return true if favorite', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1 }]]);
    const res = await request(app).get('/api/favorites/status/10');
    expect(res.status).toBe(200);
    expect(res.body.is_favorite).toBe(true);
  });

  it('should return false if not favorite', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/favorites/status/10');
    expect(res.body.is_favorite).toBe(false);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/favorites/status/10');
    expect(res.status).toBe(500);
  });
});
