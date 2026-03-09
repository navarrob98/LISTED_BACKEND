const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');
jest.mock('../../utils/helpers', () => ({
  signedDeliveryUrlFromSecure: jest.fn(() => 'signed-url'),
  buildDeliveryUrlFromSecure: jest.fn(() => 'delivery-url'),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'regular' };
  next();
});

const mockQuery = jest.fn();
const mockPromiseQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnection = { query: mockPromiseQuery, release: mockRelease };
const mockGetConnection = jest.fn().mockResolvedValue(mockConnection);
pool.query = mockQuery;
pool.promise = jest.fn(() => ({
  query: mockPromiseQuery,
  getConnection: mockGetConnection,
}));

const router = require('../../routes/chat');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => {
  jest.clearAllMocks();
  pool.promise.mockReturnValue({
    query: mockPromiseQuery,
    getConnection: mockGetConnection,
  });
  mockGetConnection.mockResolvedValue(mockConnection);
});

describe('GET /api/chat/file-url/:message_id', () => {
  it('should return signed file URL for sender', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      cb(null, [{ id: 1, sender_id: 1, receiver_id: 2, file_url: 'file.pdf', file_name: 'doc.pdf' }]);
    });
    const res = await request(app).get('/api/chat/file-url/1');
    expect(res.status).toBe(200);
    expect(res.body.signed_file_url).toBe('delivery-url');
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/api/chat/file-url/999');
    expect(res.status).toBe(404);
  });

  it('should return 404 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('db'), null));
    const res = await request(app).get('/api/chat/file-url/1');
    expect(res.status).toBe(404);
  });

  it('should return 403 if user is not participant', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      cb(null, [{ id: 1, sender_id: 5, receiver_id: 6, file_url: 'file.pdf', file_name: 'doc.pdf' }]);
    });
    const res = await request(app).get('/api/chat/file-url/1');
    expect(res.status).toBe(403);
  });

  it('should return null if no file_url', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      cb(null, [{ id: 1, sender_id: 1, receiver_id: 2, file_url: null, file_name: null }]);
    });
    const res = await request(app).get('/api/chat/file-url/1');
    expect(res.body.signed_file_url).toBeNull();
  });
});

describe('GET /api/chat/messages', () => {
  it('should return 400 if user_id missing', async () => {
    const res = await request(app).get('/api/chat/messages');
    expect(res.status).toBe(400);
  });

  it('should return paginated messages', async () => {
    const mockRows = [
      { id: 1, message: 'hi', message_type: 'text', file_url: null, cp_id: null, ca_id: null },
    ];
    mockPromiseQuery
      .mockResolvedValueOnce([mockRows])
      .mockResolvedValueOnce([[{ total: 1 }]]);
    // fire-and-forget mark read
    mockQuery.mockImplementation((sql, params, cb) => { if (cb) cb(null); });

    const res = await request(app).get('/api/chat/messages?user_id=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('should handle property_card messages', async () => {
    const mockRows = [
      { id: 1, message_type: 'property_card', cp_id: 10, cp_address: 'addr', cp_type: 'venta', cp_price: 100, cp_monthly_pay: null, cp_estate_type: 'casa', cp_first_image: 'img.jpg', ca_id: null, file_url: null },
    ];
    mockPromiseQuery
      .mockResolvedValueOnce([mockRows])
      .mockResolvedValueOnce([[{ total: 1 }]]);
    mockQuery.mockImplementation((sql, params, cb) => { if (cb) cb(null); });

    const res = await request(app).get('/api/chat/messages?user_id=2');
    expect(res.body.data[0].card_property).toBeTruthy();
    expect(res.body.data[0].card_property.id).toBe(10);
  });

  it('should handle appointment_card messages', async () => {
    const mockRows = [
      { id: 1, message_type: 'appointment_card', cp_id: null, ca_id: 5, ca_date: '2024-01-01', ca_time: '10:00', ca_status: 'pending', ca_property_address: 'addr', ca_requester_id: 1, ca_agent_id: 2, file_url: null },
    ];
    mockPromiseQuery
      .mockResolvedValueOnce([mockRows])
      .mockResolvedValueOnce([[{ total: 1 }]]);
    mockQuery.mockImplementation((sql, params, cb) => { if (cb) cb(null); });

    const res = await request(app).get('/api/chat/messages?user_id=2');
    expect(res.body.data[0].card_appointment).toBeTruthy();
  });

  it('should handle file_url in messages', async () => {
    const mockRows = [
      { id: 1, message_type: 'text', file_url: 'some-url', file_name: 'doc.pdf', cp_id: null, ca_id: null },
    ];
    mockPromiseQuery
      .mockResolvedValueOnce([mockRows])
      .mockResolvedValueOnce([[{ total: 1 }]]);
    mockQuery.mockImplementation((sql, params, cb) => { if (cb) cb(null); });

    const res = await request(app).get('/api/chat/messages?user_id=2');
    expect(res.body.data[0].signed_file_url).toBe('signed-url');
  });

  it('should return 500 on DB error', async () => {
    mockGetConnection.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/chat/messages?user_id=2');
    expect(res.status).toBe(500);
  });

  it('should handle property_id filter', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 0 }]]);
    mockQuery.mockImplementation((sql, params, cb) => { if (cb) cb(null); });

    const res = await request(app).get('/api/chat/messages?user_id=2&property_id=5');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/chat/mute-status', () => {
  it('should return mute status', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      cb(null, [{ is_muted: 1, muted_until: null }]);
    });
    const res = await request(app).get('/api/chat/mute-status?other_user_id=2');
    expect(res.status).toBe(200);
    expect(res.body.is_muted).toBe(true);
  });

  it('should return 400 if missing params', async () => {
    const res = await request(app).get('/api/chat/mute-status');
    expect(res.status).toBe(400);
  });

  it('should return false if no rows', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/api/chat/mute-status?other_user_id=2');
    expect(res.body.is_muted).toBe(false);
  });

  it('should return false if muted_until has passed', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      cb(null, [{ is_muted: 1, muted_until: '2020-01-01' }]);
    });
    const res = await request(app).get('/api/chat/mute-status?other_user_id=2');
    expect(res.body.is_muted).toBe(false);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/api/chat/mute-status?other_user_id=2');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/chat/mute', () => {
  it('should update mute status', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null));
    const res = await request(app).put('/api/chat/mute').send({ other_user_id: 2, is_muted: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 if missing fields', async () => {
    const res = await request(app).put('/api/chat/mute').send({});
    expect(res.status).toBe(400);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).put('/api/chat/mute').send({ other_user_id: 2, is_muted: true });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/chat/my-chats', () => {
  it('should return paginated chats', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ chat_with_user_id: 2, last_message_at: '2024-01-01' }]])
      .mockResolvedValueOnce([[{ total: 1 }]]);

    const res = await request(app).get('/api/chat/my-chats');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('should return 500 on DB error', async () => {
    mockGetConnection.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/chat/my-chats');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/chat/hide-chat', () => {
  it('should hide a chat', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { insertId: 1 }));
    const res = await request(app).post('/api/chat/hide-chat').send({ chat_with_user_id: 2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/api/chat/hide-chat').send({});
    expect(res.status).toBe(400);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/api/chat/hide-chat').send({ chat_with_user_id: 2 });
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/chat/mark-read', () => {
  it('should mark messages as read', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 3 }));
    const res = await request(app).put('/api/chat/mark-read').send({ chat_with_user_id: 2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 if missing chat_with_user_id', async () => {
    const res = await request(app).put('/api/chat/mark-read').send({});
    expect(res.status).toBe(400);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).put('/api/chat/mark-read').send({ chat_with_user_id: 2 });
    expect(res.status).toBe(500);
  });

  it('should handle property_id normalization', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, { affectedRows: 1 }));
    const res = await request(app).put('/api/chat/mark-read').send({ chat_with_user_id: 2, property_id: '' });
    expect(res.status).toBe(200);
  });
});
