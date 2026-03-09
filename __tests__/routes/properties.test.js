const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');
jest.mock('../../utils/extractCity', () => ({
  extractCityFromCoords: jest.fn().mockResolvedValue('CDMX'),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'individual' };
  next();
});

const mockQuery = jest.fn();
const mockPromiseQuery = jest.fn();
pool.query = mockQuery;
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const router = require('../../routes/properties');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('POST /properties/add', () => {
  it('should create a property', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'verified' }]])
      .mockResolvedValueOnce([{ insertId: 10 }]);

    const res = await request(app).post('/properties/add').send({
      type: 'venta', address: 'Test 123', price: 1000000, estate_type: 'casa',
      bedrooms: 3, bathrooms: 2, land: 200, construction: 150, lat: 20, lng: -100,
    });
    expect(res.status).toBe(201);
    expect(res.body.propertyId).toBe(10);
  });

  it('should return 401 if user not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/properties/add').send({ type: 'venta' });
    expect(res.status).toBe(401);
  });

  it('should insert images if provided', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'regular' }]])
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([{}]); // images insert

    const res = await request(app).post('/properties/add').send({
      type: 'venta', address: 'Test', price: 100, estate_type: 'casa',
      images: ['img1.jpg', 'img2.jpg'],
    });
    expect(res.status).toBe(201);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/properties/add').send({ type: 'venta' });
    expect(res.status).toBe(500);
  });
});

describe('GET /properties', () => {
  it('should return 400 if missing region params', async () => {
    const res = await request(app).get('/properties');
    expect(res.status).toBe(400);
  });

  it('should return paginated properties', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ total: 1 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1 }]));

    const res = await request(app).get('/properties?minLat=20&maxLat=21&minLng=-101&maxLng=-100');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('should return 500 on count error', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/properties?minLat=20&maxLat=21&minLng=-101&maxLng=-100');
    expect(res.status).toBe(500);
  });

  it('should return 500 on data error', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ total: 1 }]))
      .mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/properties?minLat=20&maxLat=21&minLng=-101&maxLng=-100');
    expect(res.status).toBe(500);
  });
});

describe('GET /properties/:id', () => {
  it('should return property with images', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, address: 'Test' }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ image_url: 'img.jpg' }]));

    const res = await request(app).get('/properties/1');
    expect(res.status).toBe(200);
    expect(res.body.images).toEqual(['img.jpg']);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/properties/999');
    expect(res.status).toBe(404);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/properties/1');
    expect(res.status).toBe(500);
  });

  it('should return empty images on image fetch error', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1 }]))
      .mockImplementationOnce((sql, params, cb) => cb(new Error('img fail')));

    const res = await request(app).get('/properties/1');
    expect(res.body.images).toEqual([]);
  });
});

describe('GET /properties/:id/chat', () => {
  it('should return property for chat context', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, owner_name: 'John' }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ image_url: 'img.jpg' }]));

    const res = await request(app).get('/properties/1/chat');
    expect(res.status).toBe(200);
    expect(res.body.images).toEqual(['img.jpg']);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/properties/999/chat');
    expect(res.status).toBe(404);
  });
});

describe('GET /my-properties', () => {
  it('should return user properties', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));
    const res = await request(app).get('/my-properties');
    expect(res.status).toBe(200);
  });

  it('should return 500 on error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/my-properties');
    expect(res.status).toBe(500);
  });
});

describe('GET /my-properties/:id', () => {
  it('should return specific property', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));
    const res = await request(app).get('/my-properties/1');
    expect(res.status).toBe(200);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/my-properties/999');
    expect(res.status).toBe(404);
  });
});

describe('PUT /properties/:id', () => {
  it('should return 400 if no params', async () => {
    const res = await request(app).put('/properties/1').send({});
    expect(res.status).toBe(400);
  });

  it('should return 403 if not owner', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    const res = await request(app).put('/properties/1').send({ address: 'New Addr' });
    expect(res.status).toBe(403);
  });

  it('should update property fields', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1 }])) // owner check
      .mockImplementationOnce((sql, params, cb) => cb(null, { affectedRows: 1 })); // update

    const res = await request(app).put('/properties/1').send({ address: 'New Address' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Actualizada');
  });

  it('should handle price update with history', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, { affectedRows: 1 }));

    const res = await request(app).put('/properties/1').send({ price: 500000 });
    expect(res.status).toBe(200);
    expect(res.body.updatedFields).toContain('price');
  });

  it('should handle images_add and images_remove_urls', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1 }])) // owner check
      .mockImplementationOnce((sql, params, cb) => cb(null, {})) // delete images
      .mockImplementationOnce((sql, params, cb) => cb(null, {})); // add images

    const res = await request(app).put('/properties/1').send({
      images_remove_urls: ['old.jpg'],
      images_add: ['new.jpg'],
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Actualizada (imágenes)');
  });
});

describe('DELETE /properties/:id', () => {
  it('should delete property', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).delete('/properties/1');
    expect(res.status).toBe(200);
  });

  it('should return 403 if not owner', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 0 }));
    const res = await request(app).delete('/properties/1');
    expect(res.status).toBe(403);
  });

  it('should return 500 on error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).delete('/properties/1');
    expect(res.status).toBe(500);
  });
});

describe('POST /properties/:id/resubmit', () => {
  it('should resubmit rejected property', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, managed_by: null, review_status: 'rejected', is_published: 0 }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app).post('/properties/1/resubmit');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 404 if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/properties/999/resubmit');
    expect(res.status).toBe(404);
  });

  it('should return 403 if not owner', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, created_by: 999, managed_by: null, review_status: 'rejected' }]]);
    const res = await request(app).post('/properties/1/resubmit');
    expect(res.status).toBe(403);
  });

  it('should return 400 if not rejected', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, created_by: 1, managed_by: null, review_status: 'approved' }]]);
    const res = await request(app).post('/properties/1/resubmit');
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/properties/1/resubmit');
    expect(res.status).toBe(500);
  });
});
