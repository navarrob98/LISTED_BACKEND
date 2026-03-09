const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');
jest.mock('../../utils/helpers', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../utils/extractCity', () => ({
  extractCityFromCoords: jest.fn().mockResolvedValue('CDMX'),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'regular' };
  next();
});

const mockQuery = jest.fn();
pool.query = mockQuery;

const router = require('../../routes/findAgent');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('GET /api/find-agent/city', () => {
  it('should return city from coords', async () => {
    const res = await request(app).get('/api/find-agent/city?lat=20&lng=-100');
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('CDMX');
  });

  it('should return 400 if missing lat/lng', async () => {
    const res = await request(app).get('/api/find-agent/city');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/find-agent/estimate', () => {
  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/api/find-agent/estimate').send({});
    expect(res.status).toBe(400);
  });

  it('should return insufficient if < 3 comparables', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ price: 1000000, construction: 100 }]));
    const res = await request(app).post('/api/find-agent/estimate').send({
      city: 'CDMX', estate_type: 'casa', construction_area: 150,
    });
    expect(res.status).toBe(200);
    expect(res.body.insufficient).toBe(true);
  });

  it('should return estimate with enough comparables', async () => {
    const comps = [
      { price: 1000000, construction: 100, land: 200, bedrooms: 3, bathrooms: 2, parking_spaces: 2 },
      { price: 1200000, construction: 120, land: 200, bedrooms: 3, bathrooms: 2, parking_spaces: 2 },
      { price: 900000, construction: 90, land: 180, bedrooms: 3, bathrooms: 2, parking_spaces: 1 },
    ];
    mockQuery.mockImplementation((sql, params, cb) => cb(null, comps));
    const res = await request(app).post('/api/find-agent/estimate').send({
      city: 'CDMX', estate_type: 'casa', construction_area: 100, bedrooms: 3, bathrooms: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.min).toBeDefined();
    expect(res.body.max).toBeDefined();
  });

  it('should apply age discount', async () => {
    const comps = [
      { price: 1000000, construction: 100, land: 200, bedrooms: 3, bathrooms: 2, parking_spaces: 2 },
      { price: 1000000, construction: 100, land: 200, bedrooms: 3, bathrooms: 2, parking_spaces: 2 },
      { price: 1000000, construction: 100, land: 200, bedrooms: 3, bathrooms: 2, parking_spaces: 2 },
    ];
    mockQuery.mockImplementation((sql, params, cb) => cb(null, comps));
    const res = await request(app).post('/api/find-agent/estimate').send({
      city: 'CDMX', estate_type: 'casa', construction_area: 100, age_years: 25,
    });
    expect(res.status).toBe(200);
  });

  it('should return 500 on error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/api/find-agent/estimate').send({
      city: 'CDMX', estate_type: 'casa', construction_area: 100,
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/find-agent/request', () => {
  it('should create request', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [])) // no existing
      .mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 5 })); // insert

    const res = await request(app).post('/api/find-agent/request').send({
      address: 'Test 123', operation_type: 'venta', estate_type: 'casa',
      city: 'CDMX', construction_area: 100,
      docs: { escrituras: true, predial: true, libertad_gravamen: false, ine: true, comprobante_domicilio: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return existing if duplicate', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 3 }]));
    const res = await request(app).post('/api/find-agent/request').send({ address: 'Test 123' });
    expect(res.body.existing).toBe(true);
  });

  it('should return 500 on error', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/api/find-agent/request').send({ address: 'Test' });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/find-agent/agents', () => {
  it('should return agents for city', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 5, name: 'Agent' }]));
    const res = await request(app).get('/api/find-agent/agents?city=CDMX');
    expect(res.status).toBe(200);
  });

  it('should return 400 if missing city', async () => {
    const res = await request(app).get('/api/find-agent/agents');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/find-agent/contact', () => {
  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/api/find-agent/contact').send({});
    expect(res.status).toBe(400);
  });

  it('should contact agent successfully', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ // request
        id: 1, user_id: 1, address: 'Test', estate_type: 'casa', city: 'CDMX',
        construction_area: 100, bedrooms: 3, bathrooms: 2, operation_type: 'venta',
        estimated_min: 900000, estimated_max: 1100000, doc_percentage: 80,
        lat: 20, lng: -100, land_area: 200, parking_spaces: 2, desired_price: 1000000,
      }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ cnt: 0 }])) // contact count
      .mockImplementationOnce((sql, params, cb) => cb(null, { affectedRows: 1 })) // insert contact
      .mockImplementationOnce((sql, params, cb) => cb(null, [])) // no existing property
      .mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 10 })) // create property
      .mockImplementationOnce((sql, params, cb) => cb(null, {})); // chat message

    const res = await request(app).post('/api/find-agent/contact').send({ requestId: 1, agentId: 5 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 403 if too many contacts', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, user_id: 1 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ cnt: 3 }]));
    const res = await request(app).post('/api/find-agent/contact').send({ requestId: 1, agentId: 5 });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/find-agent/prospects', () => {
  it('should return prospects for regular user', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ agent_type: 'regular' }])) // user type
      .mockImplementationOnce((sql, params, cb) => cb(null, [])) // contacts
      .mockImplementationOnce((sql, params, cb) => cb(null, [])); // prospect props

    const res = await request(app).get('/api/find-agent/prospects');
    expect(res.status).toBe(200);
  });

  it('should return prospects for agent', async () => {
    authenticateToken.mockImplementationOnce((req, res, next) => {
      req.user = { id: 5, email: 'agent@test.com', agent_type: 'individual' };
      next();
    });
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, address: 'Test' }]));

    const res = await request(app).get('/api/find-agent/prospects');
    expect(res.status).toBe(200);
  });

  it('should return 500 on error', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/api/find-agent/prospects');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/find-agent/prospects/:propertyId/respond', () => {
  it('should return 400 for invalid action', async () => {
    const res = await request(app).post('/api/find-agent/prospects/1/respond').send({ action: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('should accept prospect', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, created_by: 2 }])) // property
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 5, request_id: 10 }])) // contact
      .mockImplementationOnce((sql, params, cb) => cb(null, { affectedRows: 1 })) // update managed_by
      .mockImplementationOnce((sql, params, cb) => cb(null, {})) // update review_status
      .mockImplementationOnce((sql, params, cb) => cb(null, {})) // update contact status
      .mockImplementationOnce((sql, params, cb) => cb(null, {})) // reject others
      .mockImplementationOnce((sql, params, cb) => cb(null, {})); // update request

    const res = await request(app).post('/api/find-agent/prospects/1/respond').send({ action: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('accepted');
  });

  it('should reject prospect', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, created_by: 2 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 5, request_id: 10 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, {})) // update contact
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ pending: 0 }])) // check pending
      .mockImplementationOnce((sql, params, cb) => cb(null, {})); // update request

    const res = await request(app).post('/api/find-agent/prospects/1/respond').send({ action: 'reject' });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('rejected');
  });
});

describe('GET /api/find-agent/seller-context/:propertyId', () => {
  it('should return seller context', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, created_by: 2 }])) // property
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ request_id: 10 }])) // contact
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ // request
        operation_type: 'venta', estate_type: 'casa', address: 'Test', city: 'CDMX',
        land_area: 200, construction_area: 100, bedrooms: 3, bathrooms: 2, parking_spaces: 2,
        age_years: 5, property_condition: 'bueno', desired_price: 1000000,
        estimated_min: 900000, estimated_max: 1100000,
        doc_escrituras: 1, doc_predial: 1, doc_libertad_gravamen: 0, doc_ine: 1,
        doc_comprobante_domicilio: 1, doc_planos: 0, doc_reglamento_condo: 0,
        doc_no_adeudo: 0, doc_acta_matrimonio: 0, doc_percentage: 80,
      }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ name: 'Owner', last_name: 'Test', email: 'o@t.com', phone: '5555' }]));

    const res = await request(app).get('/api/find-agent/seller-context/1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.owner).toBeTruthy();
    expect(res.body.docs).toBeTruthy();
  });

  it('should return 404 if property not found', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/api/find-agent/seller-context/999');
    expect(res.status).toBe(404);
  });

  it('should return 403 if not authorized', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, created_by: 2 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [])); // no contact
    const res = await request(app).get('/api/find-agent/seller-context/1');
    expect(res.status).toBe(403);
  });
});
