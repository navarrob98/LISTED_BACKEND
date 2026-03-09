const requireVerifiedAgentFactory = require('../../middleware/requireVerifiedAgent');

function mockReqRes(user) {
  const req = { user };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  return { req, res, next };
}

describe('requireVerifiedAgent middleware', () => {
  let mockPool, middleware;

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    middleware = requireVerifiedAgentFactory(mockPool);
  });

  test('returns 401 when no userId', () => {
    const { req, res, next } = mockReqRes(undefined);
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'No autorizado' });
  });

  test('returns 500 on db error', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(new Error('db fail'), null);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 401 when user not found', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(null, []);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Usuario no encontrado' });
  });

  test('calls next for regular user (non-agent)', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(null, [{ agent_type: 'regular', agent_verification_status: null }]);
    expect(next).toHaveBeenCalled();
  });

  test('calls next for agent_type null (non-agent)', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(null, [{ agent_type: null, agent_verification_status: null }]);
    expect(next).toHaveBeenCalled();
  });

  test('returns 403 for unverified agent (individual)', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(null, [{ agent_type: 'individual', agent_verification_status: 'pending' }]);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'agent_not_verified' }));
  });

  test('returns 403 for unverified brokerage agent', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(null, [{ agent_type: 'brokerage', agent_verification_status: 'submitted' }]);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      agent_verification_status: 'submitted',
    }));
  });

  test('calls next for verified agent', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(null, [{ agent_type: 'individual', agent_verification_status: 'verified' }]);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('calls next for verified seller', () => {
    const { req, res, next } = mockReqRes({ id: 1 });
    middleware(req, res, next);
    const cb = mockPool.query.mock.calls[0][2];
    cb(null, [{ agent_type: 'seller', agent_verification_status: 'verified' }]);
    expect(next).toHaveBeenCalled();
  });
});
