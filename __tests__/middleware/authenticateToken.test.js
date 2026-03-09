jest.mock('jsonwebtoken');
jest.mock('@sentry/node', () => ({ setUser: jest.fn(), init: jest.fn() }));

const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const authenticateToken = require('../../middleware/authenticateToken');

function mockReqRes(authHeader) {
  const req = { headers: { authorization: authHeader } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  return { req, res, next };
}

describe('authenticateToken middleware', () => {
  afterEach(() => jest.clearAllMocks());

  test('returns 401 when no authorization header', () => {
    const { req, res, next } = mockReqRes(undefined);
    authenticateToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Token no proporcionado') }));
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when authorization header has no token', () => {
    const { req, res, next } = mockReqRes('Bearer ');
    // split(' ')[1] => '' which is falsy
    authenticateToken(req, res, next);
    // The token will be empty string which is falsy
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 with TOKEN_EXPIRED code on expired token', () => {
    jwt.verify.mockImplementation((token, secret, opts, cb) => {
      cb({ name: 'TokenExpiredError' }, null);
    });
    const { req, res, next } = mockReqRes('Bearer expired-token');
    authenticateToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 with TOKEN_INVALID code on invalid token', () => {
    jwt.verify.mockImplementation((token, secret, opts, cb) => {
      cb({ name: 'JsonWebTokenError' }, null);
    });
    const { req, res, next } = mockReqRes('Bearer bad-token');
    authenticateToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_INVALID' }));
  });

  test('calls next and sets req.user + Sentry.setUser on valid token', () => {
    const user = { id: 42, email: 'test@test.com' };
    jwt.verify.mockImplementation((token, secret, opts, cb) => {
      cb(null, user);
    });
    const { req, res, next } = mockReqRes('Bearer valid-token');
    authenticateToken(req, res, next);
    expect(req.user).toEqual(user);
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: 42 });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('uses JWT_SECRET from process.env', () => {
    process.env.JWT_SECRET = 'test-secret';
    jwt.verify.mockImplementation((token, secret, opts, cb) => {
      expect(secret).toBe('test-secret');
      expect(opts).toEqual({ algorithms: ['HS256'] });
      cb(null, { id: 1 });
    });
    const { req, res, next } = mockReqRes('Bearer some-token');
    authenticateToken(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
