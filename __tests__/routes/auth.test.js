const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../db/redis', () => ({
  call: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  exists: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../middleware/authenticateToken');
jest.mock('bcrypt');
jest.mock('jsonwebtoken');
jest.mock('google-auth-library');
jest.mock('../../utils/helpers', () => ({
  gen6: jest.fn(() => '123456'),
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
  sendResetPasswordEmail: jest.fn().mockResolvedValue(true),
  buildResetWebUrl: jest.fn(() => 'https://example.com/reset?token=abc'),
  issueToken: jest.fn(async (res, u) => res.json({ token: 'mock-token', user: u })),
  generateRefreshToken: jest.fn().mockResolvedValue({ rawToken: 'refresh-token-raw' }),
  consumeRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn().mockResolvedValue(),
  ACCESS_TOKEN_TTL: '15m',
  forgotPasswordIpLimiter: (req, res, next) => next(),
  forgotPasswordEmailCooldown: (req, res, next) => next(),
  createEmailCooldown: () => (req, res, next) => next(),
  GOOGLE_CLIENT_IDS: ['test-client-id'],
}));
jest.mock('express-rate-limit', () => jest.fn(() => (req, res, next) => next()));
jest.mock('rate-limit-redis', () => ({ default: jest.fn() }));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helpers = require('../../utils/helpers');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'regular' };
  next();
});

const mockQuery = jest.fn();
const mockPromiseQuery = jest.fn();
const mockRelease = jest.fn();
pool.query = mockQuery;
pool.promise = jest.fn(() => ({
  query: mockPromiseQuery,
  getConnection: jest.fn().mockResolvedValue({
    query: mockPromiseQuery,
    beginTransaction: jest.fn().mockResolvedValue(),
    commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(),
    release: mockRelease,
  }),
}));

const router = require('../../routes/auth');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => {
  mockQuery.mockReset();
  mockPromiseQuery.mockReset();
  mockRelease.mockReset();
  pool.query = mockQuery;
  pool.promise = jest.fn(() => ({
    query: mockPromiseQuery,
    getConnection: jest.fn().mockResolvedValue({
      query: mockPromiseQuery,
      beginTransaction: jest.fn().mockResolvedValue(),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: mockRelease,
    }),
  }));
  authenticateToken.mockImplementation((req, res, next) => {
    req.user = { id: 1, email: 'test@test.com', agent_type: 'regular' };
    next();
  });
});

describe('POST /users/register', () => {
  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/users/register').send({});
    expect(res.status).toBe(400);
  });

  it('should register user successfully', async () => {
    bcrypt.hash.mockResolvedValue('hashed-pw');
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 5 })) // insert user
      .mockImplementationOnce((sql, params, cb) => cb(null, {})); // update verif code

    const res = await request(app).post('/users/register').send({
      name: 'John', last_name: 'Doe', email: 'john@test.com', password: 'pass1234',
    });
    expect(res.status).toBe(201);
    expect(res.body.need_verification).toBe(true);
  });

  it('should return 400 on duplicate email', async () => {
    bcrypt.hash.mockResolvedValue('hashed-pw');
    const err = new Error('dup');
    err.code = 'ER_DUP_ENTRY';
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(err));

    const res = await request(app).post('/users/register').send({
      name: 'John', last_name: 'Doe', email: 'existing@test.com', password: 'pass1234',
    });
    expect(res.status).toBe(400);
  });

  it('should return 500 on verification code update error', async () => {
    bcrypt.hash.mockResolvedValue('hashed-pw');
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 5 }))
      .mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));

    const res = await request(app).post('/users/register').send({
      name: 'John', last_name: 'Doe', email: 'john@test.com', password: 'pass1234',
    });
    expect(res.status).toBe(500);
  });

  it('should return 500 on mail send error', async () => {
    bcrypt.hash.mockResolvedValue('hashed-pw');
    helpers.sendVerificationEmail.mockRejectedValueOnce(new Error('mail fail'));
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 5 }))
      .mockImplementationOnce((sql, params, cb) => cb(null, {}));

    const res = await request(app).post('/users/register').send({
      name: 'John', last_name: 'Doe', email: 'john@test.com', password: 'pass1234',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /users/verify-email', () => {
  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/users/verify-email').send({});
    expect(res.status).toBe(400);
  });

  it('should verify email and return token', async () => {
    const future = new Date(Date.now() + 600000).toISOString();
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{
        id: 1, email_verif_code: '123456', email_verif_expires: future,
        name: 'John', last_name: 'Doe', phone: null, work_start: null, work_end: null,
        agent_type: 'regular', brokerage_name: null, cities: null,
        agent_verification_status: null, agent_rejection_reason: null, profile_photo: null,
      }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, {}));

    jwt.sign.mockReturnValue('jwt-token');

    const res = await request(app).post('/users/verify-email').send({ email: 'john@test.com', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('should return 400 on invalid code', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{
      id: 1, email_verif_code: '999999', email_verif_expires: new Date(Date.now() + 600000).toISOString(),
    }]));
    const res = await request(app).post('/users/verify-email').send({ email: 'john@test.com', code: '000000' });
    expect(res.status).toBe(400);
  });

  it('should return 400 on expired code', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{
      id: 1, email_verif_code: '123456', email_verif_expires: '2020-01-01',
    }]));
    const res = await request(app).post('/users/verify-email').send({ email: 'john@test.com', code: '123456' });
    expect(res.status).toBe(400);
  });

  it('should return 404 if user not found', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    const res = await request(app).post('/users/verify-email').send({ email: 'nope@test.com', code: '123456' });
    expect(res.status).toBe(404);
  });
});

describe('POST /users/verify-email (no pending verification)', () => {
  it('should return 400 if no pending verification', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{
      id: 1, email_verif_code: null, email_verif_expires: null,
    }]));
    const res = await request(app).post('/users/verify-email').send({ email: 'john@test.com', code: '123456' });
    expect(res.status).toBe(400);
  });

  it('should return 500 on db error', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('db fail')));
    const res = await request(app).post('/users/verify-email').send({ email: 'john@test.com', code: '123456' });
    expect(res.status).toBe(500);
  });

  it('should return 500 on update error', async () => {
    const future = new Date(Date.now() + 600000).toISOString();
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{
        id: 1, email_verif_code: '123456', email_verif_expires: future,
        name: 'John', last_name: 'Doe', agent_type: 'regular',
      }]))
      .mockImplementationOnce((sql, params, cb) => cb(new Error('update fail')));
    const res = await request(app).post('/users/verify-email').send({ email: 'john@test.com', code: '123456' });
    expect(res.status).toBe(500);
  });
});

describe('POST /users/resend-code', () => {
  it('should return 400 if missing email', async () => {
    const res = await request(app).post('/users/resend-code').send({});
    expect(res.status).toBe(400);
  });

  it('should return 404 if user not found', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    const res = await request(app).post('/users/resend-code').send({ email: 'nope@test.com' });
    expect(res.status).toBe(404);
  });

  it('should return 400 if already verified', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, email_verified: 1 }]));
    const res = await request(app).post('/users/resend-code').send({ email: 'john@test.com' });
    expect(res.status).toBe(400);
  });

  it('should resend code successfully', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, email_verified: 0 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, {})); // update code
    const res = await request(app).post('/users/resend-code').send({ email: 'john@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 500 on db error for select', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/users/resend-code').send({ email: 'john@test.com' });
    expect(res.status).toBe(500);
  });

  it('should return 500 on code update error', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, email_verified: 0 }]))
      .mockImplementationOnce((sql, params, cb) => cb(new Error('update fail')));
    const res = await request(app).post('/users/resend-code').send({ email: 'john@test.com' });
    expect(res.status).toBe(500);
  });

  it('should return 500 on mail send error', async () => {
    helpers.sendVerificationEmail.mockRejectedValueOnce(new Error('mail fail'));
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, email_verified: 0 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, {}));
    const res = await request(app).post('/users/resend-code').send({ email: 'john@test.com' });
    expect(res.status).toBe(500);
  });
});

describe('POST /users/login', () => {
  it('should login successfully', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{
      id: 1, name: 'John', last_name: 'Doe', email: 'john@test.com', password: 'hashed',
      phone: null, work_start: null, work_end: null, agent_type: 'regular',
      brokerage_name: null, cities: null, email_verified: 1,
      agent_verification_status: null, agent_rejection_reason: null, profile_photo: null,
    }]));
    bcrypt.compare.mockResolvedValue(true);
    jwt.sign.mockReturnValue('jwt-token');

    const res = await request(app).post('/users/login').send({ email: 'john@test.com', password: 'pass1234' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('jwt-token');
  });

  it('should return 400 if user not found', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    const res = await request(app).post('/users/login').send({ email: 'nope@test.com', password: 'pass' });
    expect(res.status).toBe(400);
  });

  it('should return 400 on wrong password', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{
      id: 1, password: 'hashed', email_verified: 1, agent_type: 'regular',
    }]));
    bcrypt.compare.mockResolvedValue(false);
    const res = await request(app).post('/users/login').send({ email: 'john@test.com', password: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('should return 403 if email not verified', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{
      id: 1, password: 'hashed', email_verified: 0, email: 'john@test.com', agent_type: 'regular',
    }]));
    const res = await request(app).post('/users/login').send({ email: 'john@test.com', password: 'pass' });
    expect(res.status).toBe(403);
    expect(res.body.need_verification).toBe(true);
  });
});

describe('POST /users/login (additional)', () => {
  it('should return 500 on db error', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/users/login').send({ email: 'john@test.com', password: 'pass' });
    expect(res.status).toBe(500);
  });
});

describe('POST /auth/google', () => {
  const { OAuth2Client } = require('google-auth-library');

  it('should return 400 if no id_token', async () => {
    const res = await request(app).post('/auth/google').send({});
    expect(res.status).toBe(400);
  });

  it('should return 401 if token verification fails', async () => {
    OAuth2Client.prototype.verifyIdToken = jest.fn().mockRejectedValue(new Error('invalid'));
    const res = await request(app).post('/auth/google').send({ id_token: 'bad-token' });
    expect(res.status).toBe(401);
  });

  it('should login existing user with google', async () => {
    OAuth2Client.prototype.verifyIdToken = jest.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-123', email: 'john@test.com', email_verified: true,
        given_name: 'John', family_name: 'Doe', name: 'John Doe',
      }),
    });
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, [{
      id: 1, name: 'John', last_name: 'Doe', email: 'john@test.com',
      phone: null, work_start: null, work_end: null, agent_type: 'regular',
      brokerage_name: null, cities: null, agent_verification_status: null,
      agent_rejection_reason: null,
    }]));

    const res = await request(app).post('/auth/google').send({ id_token: 'valid-token' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('should create new user with google', async () => {
    OAuth2Client.prototype.verifyIdToken = jest.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-456', email: 'new@test.com', email_verified: true,
        given_name: 'New', family_name: 'User',
      }),
    });
    bcrypt.hash.mockResolvedValue('hashed-random');
    // First query: select (no existing user)
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, []));
    // Second query: insert new user
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(null, { insertId: 10 }));

    const res = await request(app).post('/auth/google').send({ id_token: 'new-token' });
    expect(res.status).toBe(200);
  });

  it('should return 400 if email not verified', async () => {
    OAuth2Client.prototype.verifyIdToken = jest.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-789', email: 'bad@test.com', email_verified: false,
      }),
    });
    const res = await request(app).post('/auth/google').send({ id_token: 'unverified-token' });
    expect(res.status).toBe(400);
  });

  it('should return 401 if payload is empty', async () => {
    OAuth2Client.prototype.verifyIdToken = jest.fn().mockResolvedValue({
      getPayload: () => null,
    });
    const res = await request(app).post('/auth/google').send({ id_token: 'empty-payload-token' });
    expect(res.status).toBe(401);
  });

  it('should return 500 on select error', async () => {
    OAuth2Client.prototype.verifyIdToken = jest.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-123', email: 'john@test.com', email_verified: true,
      }),
    });
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('db fail')));
    const res = await request(app).post('/auth/google').send({ id_token: 'valid-token' });
    expect(res.status).toBe(500);
  });

  it('should return 500 on insert error for new user', async () => {
    OAuth2Client.prototype.verifyIdToken = jest.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-456', email: 'newuser@test.com', email_verified: true,
        given_name: 'New', family_name: 'User',
      }),
    });
    bcrypt.hash.mockResolvedValue('hashed');
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [])) // no user
      .mockImplementationOnce((sql, params, cb) => cb(new Error('insert fail'))); // insert fails
    const res = await request(app).post('/auth/google').send({ id_token: 'new-token' });
    expect(res.status).toBe(500);
  });
});

describe('GET /auth/validate', () => {
  it('should return user data', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{
      name: 'John', last_name: 'Doe', email: 'john@test.com', phone: null,
      agent_type: 'regular', work_start: null, work_end: null,
      agent_verification_status: null, agent_rejection_reason: null, profile_photo: null,
      calendar_sync_enabled: 1,
    }]));
    const res = await request(app).get('/auth/validate');
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('should return 401 if user not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/auth/validate');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/forgot-password', () => {
  it('should return ok even if user not found (security)', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/auth/forgot-password').send({ email: 'nope@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should send reset email if user found', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, email: 'john@test.com' }]]) // user found
      .mockResolvedValueOnce([{}]) // invalidate old resets
      .mockResolvedValueOnce([{}]); // insert new reset

    const res = await request(app).post('/auth/forgot-password').send({ email: 'john@test.com' });
    expect(res.status).toBe(200);
    expect(helpers.sendResetPasswordEmail).toHaveBeenCalled();
  });

  it('should return ok on empty email', async () => {
    const res = await request(app).post('/auth/forgot-password').send({ email: '' });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/reset-password', () => {
  it('should return 400 if token or password missing/short', async () => {
    const res = await request(app).post('/auth/reset-password').send({ token: '', password: '12' });
    expect(res.status).toBe(400);
  });

  it('should return 400 if token not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/auth/reset-password').send({ token: 'abc', password: '12345678' });
    expect(res.status).toBe(400);
  });

  it('should return 400 if token already used', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, user_id: 1, used_at: '2024-01-01', is_expired: 0 }]]);
    const res = await request(app).post('/auth/reset-password').send({ token: 'abc', password: '12345678' });
    expect(res.status).toBe(400);
  });

  it('should return 400 if token expired', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, user_id: 1, used_at: null, is_expired: 1 }]]);
    const res = await request(app).post('/auth/reset-password').send({ token: 'abc', password: '12345678' });
    expect(res.status).toBe(400);
  });

  it('should reset password successfully', async () => {
    bcrypt.hash.mockResolvedValue('new-hashed');
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, user_id: 1, used_at: null, is_expired: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update user pw
      .mockResolvedValueOnce([{}]); // mark reset as used

    const res = await request(app).post('/auth/reset-password').send({ token: 'abc', password: '12345678' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 404 if user not found during reset', async () => {
    bcrypt.hash.mockResolvedValue('new-hashed');
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, user_id: 999, used_at: null, is_expired: 0 }]]);

    // Need to re-setup pool.promise to include getConnection for the transaction
    const mockCxn = {
      query: jest.fn()
        .mockResolvedValueOnce([{ affectedRows: 0 }]), // user not found
      beginTransaction: jest.fn().mockResolvedValue(),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: jest.fn(),
    };
    pool.promise.mockReturnValue({
      query: mockPromiseQuery,
      getConnection: jest.fn().mockResolvedValue(mockCxn),
    });
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, user_id: 999, used_at: null, is_expired: 0 }]]);

    const res = await request(app).post('/auth/reset-password').send({ token: 'abc', password: '12345678' });
    expect(res.status).toBe(404);
  });

  it('should return 500 on general error', async () => {
    const failQuery = jest.fn().mockRejectedValue(new Error('fail'));
    pool.promise.mockReturnValue({ query: failQuery });
    const res = await request(app).post('/auth/reset-password').send({ token: 'abc', password: '12345678' });
    expect(res.status).toBe(500);
  });
});

describe('POST /auth/refresh', () => {
  it('should return 400 if no refreshToken', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
  });

  it('should return 401 on invalid refresh token', async () => {
    helpers.consumeRefreshToken.mockResolvedValue({ error: 'invalid' });
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'bad' });
    expect(res.status).toBe(401);
  });

  it('should refresh token successfully', async () => {
    helpers.consumeRefreshToken.mockResolvedValue({
      data: { userId: 1, email: 'john@test.com', agentType: 'regular', family: 'fam1' },
    });
    jwt.sign.mockReturnValue('new-jwt');

    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'valid-token' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('new-jwt');
    expect(res.body.refreshToken).toBeDefined();
  });

  it('should return 500 on consume error', async () => {
    helpers.consumeRefreshToken.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'token' });
    expect(res.status).toBe(500);
  });
});

describe('POST /auth/logout', () => {
  it('should logout successfully', async () => {
    const res = await request(app).post('/auth/logout').send({ refreshToken: 'some-token' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return ok even without refresh token', async () => {
    const res = await request(app).post('/auth/logout').send({});
    expect(res.status).toBe(200);
  });

  it('should return ok even on error', async () => {
    helpers.revokeRefreshToken.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/auth/logout').send({ refreshToken: 'token' });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/reset-password/validate', () => {
  it('should return valid:true for valid token', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ used_at: null, is_expired: 0 }]]);
    const res = await request(app).post('/auth/reset-password/validate').send({ token: 'abc' });
    expect(res.body.valid).toBe(true);
  });

  it('should return valid:false for used token', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ used_at: '2024-01-01', is_expired: 0 }]]);
    const res = await request(app).post('/auth/reset-password/validate').send({ token: 'abc' });
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe('used');
  });

  it('should return valid:false for expired token', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ used_at: null, is_expired: 1 }]]);
    const res = await request(app).post('/auth/reset-password/validate').send({ token: 'abc' });
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe('expired');
  });

  it('should return valid:false if token not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/auth/reset-password/validate').send({ token: 'nope' });
    expect(res.body.valid).toBe(false);
  });

  it('should return 400 if no token', async () => {
    const res = await request(app).post('/auth/reset-password/validate').send({});
    expect(res.status).toBe(400);
  });
});
