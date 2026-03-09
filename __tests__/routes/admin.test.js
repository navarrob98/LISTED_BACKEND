const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');
jest.mock('../../middleware/requireAdmin');
jest.mock('../../services/smartAlerts', () => ({
  matchAndNotify: jest.fn().mockResolvedValue(),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const requireAdmin = require('../../middleware/requireAdmin');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'admin@test.com', agent_type: 'admin' };
  next();
});
requireAdmin.mockImplementation((req, res, next) => next());

const mockQuery = jest.fn();
const mockPromiseQuery = jest.fn();
pool.query = mockQuery;
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const router = require('../../routes/admin');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('GET /admin/agents/pending', () => {
  it('should return pending agents', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 1, name: 'Agent' }]));
    const res = await request(app).get('/admin/agents/pending');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/admin/agents/pending');
    expect(res.status).toBe(500);
  });
});

describe('POST /admin/agents/:id/approve', () => {
  it('should approve agent', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).post('/admin/agents/5/approve');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 404 if agent not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 0 }));
    const res = await request(app).post('/admin/agents/999/approve');
    expect(res.status).toBe(404);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/admin/agents/5/approve');
    expect(res.status).toBe(500);
  });
});

describe('POST /admin/agents/:id/reject', () => {
  it('should reject agent', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).post('/admin/agents/5/reject').send({ reason: 'Invalid docs' });
    expect(res.status).toBe(200);
  });

  it('should return 404 if agent not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 0 }));
    const res = await request(app).post('/admin/agents/999/reject');
    expect(res.status).toBe(404);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/admin/agents/5/reject');
    expect(res.status).toBe(500);
  });
});

describe('GET /admin/properties/pending', () => {
  it('should return pending properties', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));
    const res = await request(app).get('/admin/properties/pending');
    expect(res.status).toBe(200);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/admin/properties/pending');
    expect(res.status).toBe(500);
  });
});

describe('POST /admin/properties/:id/approve', () => {
  it('should approve property', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).post('/admin/properties/5/approve');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 0 }));
    const res = await request(app).post('/admin/properties/999/approve');
    expect(res.status).toBe(404);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/admin/properties/5/approve');
    expect(res.status).toBe(500);
  });
});

describe('POST /admin/properties/:id/reject', () => {
  it('should reject property', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).post('/admin/properties/5/reject').send({ notes: 'bad images' });
    expect(res.status).toBe(200);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 0 }));
    const res = await request(app).post('/admin/properties/999/reject');
    expect(res.status).toBe(404);
  });
});

describe('GET /admin/reports', () => {
  it('should return reports for admin', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1 }]]);
    const res = await request(app).get('/admin/reports');
    expect(res.status).toBe(200);
  });

  it('should return 403 for non-admin', async () => {
    authenticateToken.mockImplementationOnce((req, res, next) => {
      req.user = { id: 1, agent_type: 'regular' };
      next();
    });
    const res = await request(app).get('/admin/reports');
    expect(res.status).toBe(403);
  });

  it('should filter by status', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, status: 'pending' }]]);
    const res = await request(app).get('/admin/reports?status=pending');
    expect(res.status).toBe(200);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/admin/reports');
    expect(res.status).toBe(500);
  });
});

describe('GET /admin/reports/:id/chat-export', () => {
  it('should return 403 for non-admin', async () => {
    authenticateToken.mockImplementationOnce((req, res, next) => {
      req.user = { id: 1, agent_type: 'regular' };
      next();
    });
    const res = await request(app).get('/admin/reports/1/chat-export');
    expect(res.status).toBe(403);
  });

  it('should return 404 if report not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/admin/reports/999/chat-export');
    expect(res.status).toBe(404);
  });

  it('should return 400 if not agent report', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{
      id: 1, report_type: 'property', reporter_id: 1, reported_agent_id: 2,
      reporter_name: 'A', reporter_last_name: 'B', agent_name: 'C', agent_last_name: 'D',
      created_at: '2024-01-01', status: 'pending', reason: 'test', description: 'test'
    }]]);
    const res = await request(app).get('/admin/reports/1/chat-export');
    expect(res.status).toBe(400);
  });

  it('should export chat as text', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{
        id: 1, report_type: 'agent', reporter_id: 1, reported_agent_id: 2,
        reporter_name: 'A', reporter_last_name: 'B', agent_name: 'C', agent_last_name: 'D',
        created_at: '2024-01-01', status: 'pending', reason: 'spam', description: 'test desc'
      }]])
      .mockResolvedValueOnce([[{
        sender_name: 'A', sender_last_name: 'B', receiver_name: 'C', receiver_last_name: 'D',
        message: 'hello', created_at: '2024-01-01', file_url: null, file_name: null, property_address: null
      }]]);
    const res = await request(app).get('/admin/reports/1/chat-export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});

describe('PUT /admin/reports/:id/status', () => {
  it('should update report status', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    const res = await request(app).put('/admin/reports/1/status').send({ status: 'reviewed' });
    expect(res.status).toBe(200);
  });

  it('should return 400 for invalid status', async () => {
    const res = await request(app).put('/admin/reports/1/status').send({ status: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('should return 403 for non-admin', async () => {
    authenticateToken.mockImplementationOnce((req, res, next) => {
      req.user = { id: 1, agent_type: 'regular' };
      next();
    });
    const res = await request(app).put('/admin/reports/1/status').send({ status: 'reviewed' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /admin/reports/:id', () => {
  it('should delete report', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    const res = await request(app).delete('/admin/reports/1');
    expect(res.status).toBe(200);
  });

  it('should return 403 for non-admin', async () => {
    authenticateToken.mockImplementationOnce((req, res, next) => {
      req.user = { id: 1, agent_type: 'regular' };
      next();
    });
    const res = await request(app).delete('/admin/reports/1');
    expect(res.status).toBe(403);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).delete('/admin/reports/1');
    expect(res.status).toBe(500);
  });
});
