const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../db/redis', () => ({
  exists: jest.fn(),
  set: jest.fn(),
}));
jest.mock('../../middleware/authenticateToken');
jest.mock('../../cldnry', () => ({
  utils: { api_sign_request: jest.fn(() => 'mock-signature') },
  uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) },
}));
jest.mock('../../utils/helpers', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../utils/geoCache', () => ({
  getCached: jest.fn().mockResolvedValue(null),
  setCache: jest.fn().mockResolvedValue(),
  waitForNominatimSlot: jest.fn().mockResolvedValue(),
  TTL_24H: 86400,
  TTL_7D: 604800,
  autocompleteKey: jest.fn(() => 'ac:key'),
  geocodeKey: jest.fn(() => 'gc:key'),
  reverseGeocodeKey: jest.fn(() => 'rg:key'),
  detailsKey: jest.fn(() => 'dt:key'),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'regular' };
  next();
});

const mockQuery = jest.fn();
const mockPromiseQuery = jest.fn();
pool.query = mockQuery;
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const router = require('../../routes/misc');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('POST /api/buying-power', () => {
  it('should save buying power', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, {}));
    const res = await request(app).post('/api/buying-power').send({
      user_id: 1, suggested_price: 1000000,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 if missing user_id', async () => {
    const res = await request(app).post('/api/buying-power').send({});
    expect(res.status).toBe(400);
  });

  it('should return 403 if not own user', async () => {
    const res = await request(app).post('/api/buying-power').send({ user_id: 999, suggested_price: 100 });
    expect(res.status).toBe(403);
  });

  it('should return 400 if missing suggested_price', async () => {
    const res = await request(app).post('/api/buying-power').send({ user_id: 1 });
    expect(res.status).toBe(400);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/api/buying-power').send({ user_id: 1, suggested_price: 100 });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/buying-power/:user_id', () => {
  it('should return buying power', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ user_id: 1, suggested_price: 100 }]));
    const res = await request(app).get('/api/buying-power/1');
    expect(res.status).toBe(200);
  });

  it('should return 403 if not own user', async () => {
    const res = await request(app).get('/api/buying-power/999');
    expect(res.status).toBe(403);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/api/buying-power/1');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/push/register', () => {
  it('should register push token', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);
    const res = await request(app).post('/api/push/register').send({
      expoPushToken: 'ExponentPushToken[xxx]', deviceId: 'device1',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/api/push/register').send({});
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/push/register').send({
      expoPushToken: 'token', deviceId: 'dev1',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/push/logout', () => {
  it('should deactivate push token', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    const res = await request(app).post('/api/push/logout').send({ deviceId: 'dev1' });
    expect(res.status).toBe(200);
  });

  it('should return 400 if no deviceId', async () => {
    const res = await request(app).post('/api/push/logout').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tenant-profile', () => {
  it('should save tenant profile', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, {}));
    const res = await request(app).post('/api/tenant-profile').send({
      preferred_move_date: '2025-06-01', family_size: 4,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 500 on error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/api/tenant-profile').send({});
    expect(res.status).toBe(500);
  });
});

describe('GET /api/tenant-profile/:user_id', () => {
  it('should return profile', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ user_id: 1 }]));
    const res = await request(app).get('/api/tenant-profile/1');
    expect(res.status).toBe(200);
  });

  it('should return 403 if not own user', async () => {
    const res = await request(app).get('/api/tenant-profile/999');
    expect(res.status).toBe(403);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/api/tenant-profile/1');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/tenant-profile/:id', () => {
  it('should update profile', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).put('/api/tenant-profile/1').send({ family_size: 5 });
    expect(res.status).toBe(200);
  });

  it('should return 400 if no fields', async () => {
    const res = await request(app).put('/api/tenant-profile/1').send({});
    expect(res.status).toBe(400);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 0 }));
    const res = await request(app).put('/api/tenant-profile/1').send({ family_size: 5 });
    expect(res.status).toBe(404);
  });
});

describe('POST /cloudinary/sign-upload', () => {
  beforeEach(() => {
    process.env.CLD_PRESET_PUBLIC = 'test_preset';
    process.env.CLD_PRESET_PRIVATE = 'test_preset_private';
    process.env.CLOUDINARY_API_SECRET = 'secret';
    process.env.CLOUDINARY_CLOUD_NAME = 'test_cloud';
    process.env.CLOUDINARY_API_KEY = 'key123';
  });

  it('should return signed upload params', async () => {
    const res = await request(app).post('/cloudinary/sign-upload').send({ kind: 'public' });
    expect(res.status).toBe(200);
    expect(res.body.signature).toBe('mock-signature');
    expect(res.body.cloud_name).toBe('test_cloud');
  });

  it('should handle private kind', async () => {
    const res = await request(app).post('/cloudinary/sign-upload').send({ kind: 'private' });
    expect(res.status).toBe(200);
  });
});

describe('POST /cloudinary/delete', () => {
  beforeEach(() => {
    process.env.CLD_BASE_FOLDER = 'listed';
  });

  it('should return 400 if no public_id', async () => {
    const res = await request(app).post('/cloudinary/delete').send({});
    expect(res.status).toBe(400);
  });

  it('should return 403 if public_id doesnt belong to user', async () => {
    const res = await request(app).post('/cloudinary/delete').send({
      public_id: 'listed/dev/raw/u_999/file.pdf',
    });
    expect(res.status).toBe(403);
  });

  it('should delete file from cloudinary', async () => {
    const res = await request(app).post('/cloudinary/delete').send({
      public_id: 'listed/dev/raw/u_1/file.pdf',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/reports', () => {
  it('should create report', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 10 }]]) // property exists
      .mockResolvedValueOnce([{ insertId: 1 }]); // insert report

    const res = await request(app).post('/api/reports').send({
      report_type: 'property', reported_property_id: 10,
      reason: 'spam', description: 'Fake listing',
    });
    expect(res.status).toBe(201);
  });

  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/api/reports').send({});
    expect(res.status).toBe(400);
  });

  it('should return 400 if self-report', async () => {
    const res = await request(app).post('/api/reports').send({
      report_type: 'agent', reported_agent_id: 1,
      reason: 'spam', description: 'test',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/infonavit/:userId', () => {
  it('should return infonavit data', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ user_id: 1, edad: 30 }]]);
    const res = await request(app).get('/api/infonavit/1');
    expect(res.status).toBe(200);
  });

  it('should return 403 if not own user', async () => {
    const res = await request(app).get('/api/infonavit/999');
    expect(res.status).toBe(403);
  });

  it('should return null if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/infonavit/1');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe('POST /api/infonavit', () => {
  it('should save infonavit data', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    const res = await request(app).post('/api/infonavit').send({
      user_id: 1, edad: 30, salario_mensual: 20000,
    });
    expect(res.status).toBe(200);
  });

  it('should return 403 if not own user', async () => {
    const res = await request(app).post('/api/infonavit').send({ user_id: 999, edad: 30, salario_mensual: 20000 });
    expect(res.status).toBe(403);
  });

  it('should return 400 if missing required fields', async () => {
    const res = await request(app).post('/api/infonavit').send({ user_id: 1 });
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/infonavit').send({
      user_id: 1, edad: 30, salario_mensual: 20000,
    });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/infonavit/:userId (500 error)', () => {
  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/infonavit/1');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/places/autocomplete', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    delete global.fetch;
  });

  it('should return 400 if no input', async () => {
    const res = await request(app).get('/api/places/autocomplete');
    expect(res.status).toBe(400);
  });

  it('should return cached result if available', async () => {
    const { getCached } = require('../../utils/geoCache');
    getCached.mockResolvedValueOnce({ predictions: [{ place_id: 'cached', description: 'Cached' }] });
    const res = await request(app).get('/api/places/autocomplete?input=cdmx');
    expect(res.status).toBe(200);
    expect(res.body.predictions[0].place_id).toBe('cached');
  });

  it('should fetch from photon and return predictions', async () => {
    global.fetch.mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue({
        features: [
          { properties: { country: 'Mexico', osm_type: 'node', osm_id: 123, name: 'Place', street: null, city: 'CDMX', state: 'CDMX' } },
          { properties: { country: 'USA', osm_type: 'node', osm_id: 456, name: 'US Place' } },
        ],
      }),
    });
    const res = await request(app).get('/api/places/autocomplete?input=cdmx');
    expect(res.status).toBe(200);
    expect(res.body.predictions.length).toBe(1); // only Mexico result
  });

  it('should return 500 on fetch error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('network'));
    const res = await request(app).get('/api/places/autocomplete?input=cdmx');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/places/details', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    delete global.fetch;
  });

  it('should return 400 if no place_id', async () => {
    const res = await request(app).get('/api/places/details');
    expect(res.status).toBe(400);
  });

  it('should return 400 if invalid place_id format', async () => {
    const res = await request(app).get('/api/places/details?place_id=invalid');
    expect(res.status).toBe(400);
  });

  it('should return cached result', async () => {
    const { getCached } = require('../../utils/geoCache');
    getCached.mockResolvedValueOnce({ result: { geometry: { location: { lat: 19, lng: -99 } } } });
    const res = await request(app).get('/api/places/details?place_id=osm:N12345');
    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });

  it('should lookup from nominatim', async () => {
    global.fetch.mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue([{ lat: '19.43', lon: '-99.13', display_name: 'Mexico City' }]),
    });
    const res = await request(app).get('/api/places/details?place_id=osm:N12345');
    expect(res.status).toBe(200);
    expect(res.body.result.formatted_address).toBe('Mexico City');
  });

  it('should return null result if nominatim returns empty', async () => {
    global.fetch.mockResolvedValueOnce({ json: jest.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/places/details?place_id=osm:N12345');
    expect(res.status).toBe(200);
    expect(res.body.result).toBeNull();
  });

  it('should return 500 on error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('network'));
    const res = await request(app).get('/api/places/details?place_id=osm:N12345');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/places/geocode', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    delete global.fetch;
  });

  it('should return 400 if no address', async () => {
    const res = await request(app).get('/api/places/geocode');
    expect(res.status).toBe(400);
  });

  it('should return cached result', async () => {
    const { getCached } = require('../../utils/geoCache');
    getCached.mockResolvedValueOnce({ status: 'OK', result: { geometry: { location: { lat: 19, lng: -99 } } } });
    const res = await request(app).get('/api/places/geocode?address=CDMX');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });

  it('should geocode address from nominatim', async () => {
    global.fetch.mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue([{ lat: '19.43', lon: '-99.13', display_name: 'Mexico City' }]),
    });
    const res = await request(app).get('/api/places/geocode?address=CDMX');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });

  it('should return ZERO_RESULTS if not found', async () => {
    global.fetch.mockResolvedValueOnce({ json: jest.fn().mockResolvedValue([]) });
    const res = await request(app).get('/api/places/geocode?address=nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ZERO_RESULTS');
  });

  it('should return 500 on error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('network'));
    const res = await request(app).get('/api/places/geocode?address=CDMX');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/places/reverse-geocode', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    delete global.fetch;
  });

  it('should return 400 if missing lat or lng', async () => {
    const res = await request(app).get('/api/places/reverse-geocode?lat=19');
    expect(res.status).toBe(400);
  });

  it('should return cached result', async () => {
    const { getCached } = require('../../utils/geoCache');
    getCached.mockResolvedValueOnce({ status: 'OK', result: { formatted_address: 'Cached Addr' } });
    const res = await request(app).get('/api/places/reverse-geocode?lat=19&lng=-99');
    expect(res.status).toBe(200);
    expect(res.body.result.formatted_address).toBe('Cached Addr');
  });

  it('should reverse geocode from nominatim', async () => {
    global.fetch.mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue({ display_name: 'Mexico City Center' }),
    });
    const res = await request(app).get('/api/places/reverse-geocode?lat=19.43&lng=-99.13');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });

  it('should return ZERO_RESULTS if nominatim returns error', async () => {
    global.fetch.mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue({ error: 'Unable to geocode' }),
    });
    const res = await request(app).get('/api/places/reverse-geocode?lat=0&lng=0');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ZERO_RESULTS');
  });

  it('should return 500 on error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('network'));
    const res = await request(app).get('/api/places/reverse-geocode?lat=19&lng=-99');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/reports (additional branches)', () => {
  it('should return 400 if property report without property_id', async () => {
    const res = await request(app).post('/api/reports').send({
      report_type: 'property', reason: 'spam', description: 'test',
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 if agent report without agent_id', async () => {
    const res = await request(app).post('/api/reports').send({
      report_type: 'agent', reason: 'spam', description: 'test',
    });
    expect(res.status).toBe(400);
  });

  it('should return 404 if property not found for report', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]); // property not found
    const res = await request(app).post('/api/reports').send({
      report_type: 'property', reported_property_id: 999, reason: 'spam', description: 'Fake',
    });
    expect(res.status).toBe(404);
  });

  it('should create agent report successfully', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 5 }]]) // agent exists
      .mockResolvedValueOnce([{ insertId: 1 }]); // insert
    const res = await request(app).post('/api/reports').send({
      report_type: 'agent', reported_agent_id: 5, reason: 'spam', description: 'Bad agent',
    });
    expect(res.status).toBe(201);
  });

  it('should return 404 if agent not found for report', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]); // agent not found
    const res = await request(app).post('/api/reports').send({
      report_type: 'agent', reported_agent_id: 999, reason: 'fraud', description: 'Scam',
    });
    expect(res.status).toBe(404);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/reports').send({
      report_type: 'property', reported_property_id: 10, reason: 'spam', description: 'test',
    });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/buying-power/:user_id (500 error)', () => {
  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/api/buying-power/1');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/tenant-profile/:user_id (500 error)', () => {
  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/api/tenant-profile/1');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/tenant-profile/:id (500 error)', () => {
  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).put('/api/tenant-profile/1').send({ family_size: 3 });
    expect(res.status).toBe(500);
  });
});

describe('POST /cloudinary/sign-upload (missing preset)', () => {
  it('should return 500 if preset not configured', async () => {
    delete process.env.CLD_PRESET_PUBLIC;
    delete process.env.CLD_PRESET_PRIVATE;
    const res = await request(app).post('/cloudinary/sign-upload').send({ kind: 'public' });
    expect(res.status).toBe(500);
  });
});

describe('POST /cloudinary/delete (additional branches)', () => {
  it('should handle not found result from cloudinary', async () => {
    const cloudinary = require('../../cldnry');
    cloudinary.uploader.destroy.mockResolvedValueOnce({ result: 'not found' });
    process.env.CLD_BASE_FOLDER = 'listed';
    const res = await request(app).post('/cloudinary/delete').send({
      public_id: 'listed/dev/raw/u_1/file.pdf',
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('not found');
  });

  it('should return 500 on unexpected cloudinary result', async () => {
    const cloudinary = require('../../cldnry');
    cloudinary.uploader.destroy.mockResolvedValueOnce({ result: 'error' });
    process.env.CLD_BASE_FOLDER = 'listed';
    const res = await request(app).post('/cloudinary/delete').send({
      public_id: 'listed/dev/raw/u_1/file.pdf',
    });
    expect(res.status).toBe(500);
  });

  it('should return 500 on cloudinary exception', async () => {
    const cloudinary = require('../../cldnry');
    cloudinary.uploader.destroy.mockRejectedValueOnce(new Error('cloud error'));
    process.env.CLD_BASE_FOLDER = 'listed';
    const res = await request(app).post('/cloudinary/delete').send({
      public_id: 'listed/dev/raw/u_1/file.pdf',
    });
    expect(res.status).toBe(500);
  });
});
