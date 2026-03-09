const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');
jest.mock('bcrypt');
jest.mock('../../utils/helpers', () => ({
  gen6: jest.fn(() => '123456'),
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const bcrypt = require('bcrypt');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'individual' };
  next();
});

const mockQuery = jest.fn();
const mockPromiseQuery = jest.fn();
const mockConnQuery = jest.fn();
const mockRelease = jest.fn();
const mockBeginTransaction = jest.fn((cb) => cb(null));
const mockCommit = jest.fn((cb) => cb(null));
const mockRollback = jest.fn((cb) => cb(null));

pool.query = mockQuery;
pool.getConnection = jest.fn((cb) => cb(null, {
  query: mockConnQuery,
  release: mockRelease,
  beginTransaction: mockBeginTransaction,
  commit: mockCommit,
  rollback: mockRollback,
}));
pool.promise = jest.fn(() => ({
  query: mockPromiseQuery,
  getConnection: jest.fn().mockResolvedValue({
    query: mockPromiseQuery,
    beginTransaction: jest.fn().mockResolvedValue(),
    commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(),
    release: jest.fn(),
  }),
}));

const router = require('../../routes/agents');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => {
  mockQuery.mockReset();
  mockPromiseQuery.mockReset();
  mockConnQuery.mockReset();
  mockRelease.mockReset();
  mockBeginTransaction.mockReset().mockImplementation((cb) => cb(null));
  mockCommit.mockReset().mockImplementation((cb) => cb(null));
  mockRollback.mockReset().mockImplementation((cb) => cb(null));
  pool.query = mockQuery;
  pool.getConnection = jest.fn((cb) => cb(null, {
    query: mockConnQuery,
    release: mockRelease,
    beginTransaction: mockBeginTransaction,
    commit: mockCommit,
    rollback: mockRollback,
  }));
  pool.promise = jest.fn(() => ({
    query: mockPromiseQuery,
    getConnection: jest.fn().mockResolvedValue({
      query: mockPromiseQuery,
      beginTransaction: jest.fn().mockResolvedValue(),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: jest.fn(),
    }),
  }));
  authenticateToken.mockImplementation((req, res, next) => {
    req.user = { id: 1, email: 'test@test.com', agent_type: 'individual' };
    next();
  });
});

describe('POST /agents/register', () => {
  it('should return 400 if missing required fields', async () => {
    const res = await request(app).post('/agents/register').send({ name: 'Test' });
    expect(res.status).toBe(400);
  });

  it('should return 400 on invalid time format', async () => {
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: 'bad', work_end: '18:00',
    });
    expect(res.status).toBe(400);
  });

  it('should register agent successfully', async () => {
    bcrypt.hash.mockResolvedValue('hashed');
    mockConnQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 5 })) // insert user
      .mockImplementationOnce((sql, params, cb) => cb(null, {})); // insert credential

    const res = await request(app).post('/agents/register').send({
      name: 'Agent', last_name: 'Smith', email: 'agent@test.com', password: 'pass1234',
      work_start: '09:00', work_end: '18:00', agent_type: 'individual',
      cities: ['CDMX', 'GDL'],
      credential: { type: 'ampi_ccie', credential_id: 'CCIE-123' },
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 on duplicate email', async () => {
    bcrypt.hash.mockResolvedValue('hashed');
    const err = new Error('dup');
    err.code = 'ER_DUP_ENTRY';
    mockConnQuery.mockImplementationOnce((sql, params, cb) => cb(err));

    const res = await request(app).post('/agents/register').send({
      name: 'Agent', last_name: 'S', email: 'dup@test.com', password: 'pass1234',
      work_start: '09:00', work_end: '18:00',
    });
    expect(res.status).toBe(400);
  });

  it('should validate credential types', async () => {
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: '09:00', work_end: '18:00', agent_type: 'individual',
      credential: { type: 'invalid_type', credential_id: '123' },
    });
    expect(res.status).toBe(400);
  });

  it('should validate state_registry state format', async () => {
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: '09:00', work_end: '18:00', agent_type: 'individual',
      credential: { type: 'state_registry', credential_id: '123', state: 'INVALID' },
    });
    expect(res.status).toBe(400);
  });

  it('should require issuer for other_verifiable', async () => {
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: '09:00', work_end: '18:00', agent_type: 'individual',
      credential: { type: 'other_verifiable', credential_id: '123' },
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /agents/:id/work-schedule', () => {
  it('should update work schedule', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).put('/agents/1/work-schedule').send({ work_start: '09:00', work_end: '18:00' });
    expect(res.status).toBe(200);
  });

  it('should return 400 if missing fields', async () => {
    const res = await request(app).put('/agents/1/work-schedule').send({});
    expect(res.status).toBe(400);
  });

  it('should return 400 on invalid format', async () => {
    const res = await request(app).put('/agents/1/work-schedule').send({ work_start: 'bad', work_end: '18:00' });
    expect(res.status).toBe(400);
  });

  it('should return 403 if not own id', async () => {
    const res = await request(app).put('/agents/999/work-schedule').send({ work_start: '09:00', work_end: '18:00' });
    expect(res.status).toBe(403);
  });

  it('should return 404 if no rows updated', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 0 }));
    const res = await request(app).put('/agents/1/work-schedule').send({ work_start: '09:00', work_end: '18:00' });
    expect(res.status).toBe(404);
  });
});

describe('GET /agents/me/credentials/latest', () => {
  it('should return latest credential', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, type: 'ampi_ccie', credential_id: '123' }]]);
    const res = await request(app).get('/agents/me/credentials/latest');
    expect(res.status).toBe(200);
    expect(res.body.credential).toBeTruthy();
  });

  it('should return null if no credential', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/agents/me/credentials/latest');
    expect(res.body.credential).toBeNull();
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/agents/me/credentials/latest');
    expect(res.status).toBe(500);
  });
});

describe('PUT /agents/me/credentials', () => {
  it('should return 404 if user not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'ampi_ccie', credential_id: 'ABC123',
    });
    expect(res.status).toBe(404);
  });

  it('should return 403 if not verifiable agent', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'regular', agent_verification_status: 'not_required' }]]);
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'ampi_ccie', credential_id: 'ABC123',
    });
    expect(res.status).toBe(403);
  });

  it('should return 400 for invalid credential type', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'pending' }]]);
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'invalid', credential_id: 'ABC123',
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 if missing credential_id', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'pending' }]]);
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'ampi_ccie',
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for state_registry with invalid state', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'pending' }]]);
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'state_registry', credential_id: 'ABC', state: 'INVALID',
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for other_verifiable without issuer', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'pending' }]]);
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'other_verifiable', credential_id: 'ABC',
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for other_verifiable without verification_url', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'pending' }]]);
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'other_verifiable', credential_id: 'ABC', issuer: 'ISSUER',
    });
    expect(res.status).toBe(400);
  });

  it('should update existing credential (changed data)', async () => {
    // user query
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'verified' }]]);
    // existing credential
    mockPromiseQuery.mockResolvedValueOnce([[{
      id: 10, type: 'ampi_ccie', state: null, credential_id: 'OLD-ID',
      issuer: null, verification_url: null, certificate_url: null,
    }]]);

    // Setup getConnection mock for the transaction
    const mockCxn = {
      query: jest.fn().mockResolvedValue([{}]),
      beginTransaction: jest.fn().mockResolvedValue(),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: jest.fn(),
    };
    pool.promise.mockReturnValue({
      query: mockPromiseQuery,
      getConnection: jest.fn().mockResolvedValue(mockCxn),
    });
    // Re-run the mocks for the actual query execution
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'verified' }]])
      .mockResolvedValueOnce([[{
        id: 10, type: 'ampi_ccie', state: null, credential_id: 'OLD-ID',
        issuer: null, verification_url: null, certificate_url: null,
      }]]);

    const res = await request(app).put('/agents/me/credentials').send({
      type: 'ampi_ccie', credential_id: 'NEW-ID',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should insert new credential when none exists', async () => {
    const mockCxn = {
      query: jest.fn().mockResolvedValue([{}]),
      beginTransaction: jest.fn().mockResolvedValue(),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: jest.fn(),
    };
    pool.promise.mockReturnValue({
      query: mockPromiseQuery,
      getConnection: jest.fn().mockResolvedValue(mockCxn),
    });
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'not_required' }]])
      .mockResolvedValueOnce([[]]); // no existing credential

    const res = await request(app).put('/agents/me/credentials').send({
      type: 'ampi_ccie', credential_id: 'NEW-CRED',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.changed).toBe(true);
  });

  it('should return 500 on transaction error', async () => {
    const mockCxn = {
      query: jest.fn().mockRejectedValue(new Error('tx fail')),
      beginTransaction: jest.fn().mockResolvedValue(),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: jest.fn(),
    };
    pool.promise.mockReturnValue({
      query: mockPromiseQuery,
      getConnection: jest.fn().mockResolvedValue(mockCxn),
    });
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', agent_verification_status: 'verified' }]])
      .mockResolvedValueOnce([[{ id: 10, type: 'ampi_ccie', credential_id: 'OLD' }]]);

    const res = await request(app).put('/agents/me/credentials').send({
      type: 'ampi_ccie', credential_id: 'NEW',
    });
    expect(res.status).toBe(500);
  });

  it('should return 500 on general error', async () => {
    const failQuery = jest.fn().mockRejectedValue(new Error('fail'));
    pool.promise.mockReturnValue({ query: failQuery });
    const res = await request(app).put('/agents/me/credentials').send({
      type: 'ampi_ccie', credential_id: 'ABC',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /agents/update-credential-certificate (additional)', () => {
  it('should return 404 if user not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/agents/update-credential-certificate').send({
      certificate_url: 'https://res.cloudinary.com/test/listed/dev/raw/u_1/cert.pdf',
    });
    expect(res.status).toBe(404);
  });

  it('should return 404 if no credential found', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual' }]])
      .mockResolvedValueOnce([[]]); // no credential
    const res = await request(app).post('/agents/update-credential-certificate').send({
      certificate_url: 'https://res.cloudinary.com/test/listed/dev/raw/u_1/cert.pdf',
    });
    expect(res.status).toBe(404);
  });

  it('should return 500 on error', async () => {
    const failQuery = jest.fn().mockRejectedValue(new Error('fail'));
    pool.promise.mockReturnValue({ query: failQuery });
    const res = await request(app).post('/agents/update-credential-certificate').send({
      certificate_url: 'https://res.cloudinary.com/test/listed/dev/raw/u_1/cert.pdf',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /agents/register (additional)', () => {
  it('should require verification_url for other_verifiable', async () => {
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: '09:00', work_end: '18:00', agent_type: 'individual',
      credential: { type: 'other_verifiable', credential_id: '123', issuer: 'ISSUER' },
    });
    expect(res.status).toBe(400);
  });

  it('should require credential_id', async () => {
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: '09:00', work_end: '18:00', agent_type: 'individual',
      credential: { type: 'ampi_ccie' },
    });
    expect(res.status).toBe(400);
  });

  it('should return 500 on getConnection error', async () => {
    bcrypt.hash.mockResolvedValue('hashed');
    pool.getConnection.mockImplementationOnce((cb) => cb(new Error('conn fail')));
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: '09:00', work_end: '18:00',
    });
    expect(res.status).toBe(500);
  });

  it('should return 500 on general insert error', async () => {
    bcrypt.hash.mockResolvedValue('hashed');
    mockConnQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('insert fail')));
    const res = await request(app).post('/agents/register').send({
      name: 'A', last_name: 'B', email: 'a@b.com', password: 'pass',
      work_start: '09:00', work_end: '18:00',
    });
    expect(res.status).toBe(500);
  });

  it('should register seller type without credential', async () => {
    bcrypt.hash.mockResolvedValue('hashed');
    mockConnQuery.mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 5 }));
    const res = await request(app).post('/agents/register').send({
      name: 'Seller', last_name: 'Owner', email: 'seller@test.com', password: 'pass',
      work_start: '09:00', work_end: '18:00', agent_type: 'seller',
    });
    expect(res.status).toBe(201);
  });
});

describe('PUT /agents/:id/work-schedule (500 error)', () => {
  it('should return 500 on db error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).put('/agents/1/work-schedule').send({ work_start: '09:00', work_end: '18:00' });
    expect(res.status).toBe(500);
  });
});

describe('POST /agents/me/resubmit-verification (additional)', () => {
  it('should return 404 if user not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/agents/me/resubmit-verification');
    expect(res.status).toBe(404);
  });

  it('should return 500 on error', async () => {
    const failQuery = jest.fn().mockRejectedValue(new Error('fail'));
    pool.promise.mockReturnValue({ query: failQuery });
    const res = await request(app).post('/agents/me/resubmit-verification');
    expect(res.status).toBe(500);
  });
});

describe('GET /agents/:id', () => {
  it('should return agent info', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 5, name: 'Agent' }]));
    const res = await request(app).get('/agents/5');
    expect(res.status).toBe(200);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/agents/999');
    expect(res.status).toBe(404);
  });

  it('should return 500 on error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/agents/5');
    expect(res.status).toBe(500);
  });
});

describe('POST /agents/me/resubmit-verification', () => {
  it('should resubmit verification', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ agent_type: 'individual', agent_verification_status: 'rejected' }]])
      .mockResolvedValueOnce([[{ credential_id: 'ABC123' }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app).post('/agents/me/resubmit-verification');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 if not rejected', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ agent_type: 'individual', agent_verification_status: 'verified' }]]);
    const res = await request(app).post('/agents/me/resubmit-verification');
    expect(res.status).toBe(400);
  });

  it('should return 403 if not verifiable agent', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ agent_type: 'regular', agent_verification_status: 'rejected' }]]);
    const res = await request(app).post('/agents/me/resubmit-verification');
    expect(res.status).toBe(403);
  });

  it('should return 400 if no credential', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ agent_type: 'individual', agent_verification_status: 'rejected' }]])
      .mockResolvedValueOnce([[]]);
    const res = await request(app).post('/agents/me/resubmit-verification');
    expect(res.status).toBe(400);
  });
});

describe('POST /agents/update-credential-certificate', () => {
  it('should update certificate', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual' }]])
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockResolvedValueOnce([{}]);

    const res = await request(app).post('/agents/update-credential-certificate').send({
      certificate_url: 'https://res.cloudinary.com/test/raw/upload/listed/dev/raw/u_1/cert.pdf',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 if no certificate_url', async () => {
    const res = await request(app).post('/agents/update-credential-certificate').send({});
    expect(res.status).toBe(400);
  });

  it('should return 400 if not cloudinary URL', async () => {
    const res = await request(app).post('/agents/update-credential-certificate').send({
      certificate_url: 'https://example.com/cert.pdf',
    });
    expect(res.status).toBe(400);
  });

  it('should return 403 if not verifiable agent', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'regular' }]]);
    const res = await request(app).post('/agents/update-credential-certificate').send({
      certificate_url: 'https://res.cloudinary.com/test/cert.pdf',
    });
    expect(res.status).toBe(403);
  });
});
