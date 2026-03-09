const requireAdmin = require('../../middleware/requireAdmin');

function mockReqRes(user) {
  const req = { user };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  return { req, res, next };
}

describe('requireAdmin middleware', () => {
  test('calls next when user is admin', () => {
    const { req, res, next } = mockReqRes({ agent_type: 'admin' });
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 403 when agent_type is not admin', () => {
    const { req, res, next } = mockReqRes({ agent_type: 'regular' });
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('admin requerido') }));
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 when agent_type is individual', () => {
    const { req, res, next } = mockReqRes({ agent_type: 'individual' });
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 403 when user has no agent_type', () => {
    const { req, res, next } = mockReqRes({});
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 403 when req.user is undefined', () => {
    const { req, res, next } = mockReqRes(undefined);
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
