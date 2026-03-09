const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../db/redis', () => ({
  call: jest.fn(),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  exists: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../middleware/authenticateToken');
jest.mock('jsonwebtoken');
jest.mock('../../utils/ai', () => ({
  aiGenerate: jest.fn(),
  aiGenerateMessages: jest.fn(),
}));
jest.mock('express-rate-limit', () => jest.fn(() => (req, res, next) => next()));
jest.mock('rate-limit-redis', () => ({ default: jest.fn() }));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const jwt = require('jsonwebtoken');
const { aiGenerate, aiGenerateMessages } = require('../../utils/ai');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'individual' };
  next();
});

const mockQuery = jest.fn();
pool.query = mockQuery;
pool.promise = jest.fn(() => ({ query: jest.fn().mockResolvedValue([[]]) }));

const router = require('../../routes/ai');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('POST /api/ai/property-description', () => {
  it('should return 400 if missing type or estate_type', async () => {
    const res = await request(app).post('/api/ai/property-description').send({});
    expect(res.status).toBe(400);
  });

  it('should generate description', async () => {
    aiGenerate.mockResolvedValue('Beautiful property in Mexico City.');
    const res = await request(app).post('/api/ai/property-description').send({
      type: 'venta', estate_type: 'casa', price: 2000000, bedrooms: 3,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.description).toBeDefined();
  });

  it('should trim long descriptions', async () => {
    const longText = 'A'.repeat(800) + '. End.';
    aiGenerate.mockResolvedValue(longText);
    const res = await request(app).post('/api/ai/property-description').send({
      type: 'venta', estate_type: 'casa',
    });
    expect(res.body.description.length).toBeLessThanOrEqual(701);
  });

  it('should return 503 if AI disabled', async () => {
    aiGenerate.mockRejectedValue(new Error('AI_DISABLED'));
    const res = await request(app).post('/api/ai/property-description').send({
      type: 'venta', estate_type: 'casa',
    });
    expect(res.status).toBe(503);
  });

  it('should return 500 on AI error', async () => {
    aiGenerate.mockRejectedValue(new Error('something'));
    const res = await request(app).post('/api/ai/property-description').send({
      type: 'venta', estate_type: 'casa',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/ai/smart-replies', () => {
  it('should return 400 if no messages', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    const res = await request(app).post('/api/ai/smart-replies').send({});
    expect(res.status).toBe(400);
  });

  it('should return 403 for regular users', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'regular' }]));
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Hello', isOwn: false }],
    });
    expect(res.status).toBe(403);
  });

  it('should generate smart replies', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockResolvedValue('Reply 1|||Reply 2|||Reply 3');
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Hello', isOwn: false }],
      agentName: 'Agent',
    });
    expect(res.status).toBe(200);
    expect(res.body.replies).toHaveLength(3);
  });

  it('should detect CITA tags', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    const messages = [
      { text: 'Hola', isOwn: false },
      { text: 'Respuesta', isOwn: true },
      { text: 'Me interesa', isOwn: false },
      { text: 'Claro', isOwn: true },
      { text: 'Quiero visitarla', isOwn: false },
    ];
    aiGenerate.mockResolvedValue('[CITA:2030-01-15:10:00] Reply 1|||Reply 2|||Reply 3');
    const res = await request(app).post('/api/ai/smart-replies').send({ messages });
    expect(res.status).toBe(200);
    expect(res.body.suggestAppointment).toBe(true);
    expect(res.body.extractedDate).toBe('2030-01-15');
  });

  it('should detect [CITA] without date/time', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    const messages = [
      { text: 'Hola', isOwn: false },
      { text: 'Info', isOwn: true },
      { text: 'Me interesa', isOwn: false },
      { text: 'Claro', isOwn: true },
      { text: 'Quiero ir a verla', isOwn: false },
    ];
    aiGenerate.mockResolvedValue('[CITA] Reply 1|||Reply 2|||Reply 3');
    const res = await request(app).post('/api/ai/smart-replies').send({ messages });
    expect(res.status).toBe(200);
    expect(res.body.suggestAppointment).toBe(true);
    expect(res.body.extractedDate).toBeUndefined();
  });

  it('should detect MODIFICAR_CITA tag', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    const messages = [
      { text: 'Hola', isOwn: false },
      { text: 'Ok', isOwn: true },
      { text: 'Cambio', isOwn: false },
      { text: 'Claro', isOwn: true },
      { text: 'Quiero cambiar a otra hora', isOwn: false },
    ];
    aiGenerate.mockResolvedValue('[MODIFICAR_CITA:2030-02-01:14:00] Reply|||R2|||R3');
    const res = await request(app).post('/api/ai/smart-replies').send({ messages });
    expect(res.status).toBe(200);
    expect(res.body.modifyAppointment).toBe(true);
    expect(res.body.extractedDate).toBe('2030-02-01');
  });

  it('should detect [MODIFICAR_CITA] without date', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockResolvedValue('[MODIFICAR_CITA] Reply|||R2|||R3');
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Cambiar cita', isOwn: false }],
    });
    expect(res.status).toBe(200);
    expect(res.body.modifyAppointment).toBe(true);
  });

  it('should handle conversation stages with property and client context', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes('agent_type')) return cb(null, [{ agent_type: 'individual' }]);
      if (sql.includes('appointments')) return cb(null, [{ id: 1, appointment_date: '2030-01-01', appointment_time: '10:00:00', status: 'confirmed' }]);
      if (sql.includes('buying_power')) return cb(null, []);
      if (sql.includes('infonavit')) return cb(null, []);
      if (sql.includes('tenant_profiles')) return cb(null, []);
      if (sql.includes('user_qualifying')) return cb(null, []);
      return cb(null, []);
    });
    const redis = require('../../db/redis');
    redis.get.mockResolvedValue(null);

    aiGenerate.mockResolvedValue('R1|||R2|||R3');

    const messages = [
      { text: 'Hola', isOwn: false },
      { text: 'Hola!', isOwn: true },
      { text: 'Info?', isOwn: false },
      { text: 'Claro', isOwn: true },
      { text: 'Gracias', isOwn: false },
      { text: 'De nada', isOwn: true },
      { text: 'Me gusta', isOwn: false },
    ];
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages,
      propertyId: 1,
      clientId: 2,
      property: { address: 'Test St', type: 'venta', price: 1000000 },
      agentName: 'Agent',
      clientName: 'Client',
      isFirstReply: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.replies.length).toBeGreaterThan(0);
  });

  it('should handle appointment_card and property_card message types', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockResolvedValue('R1|||R2|||R3');
    const messages = [
      { text: '', isOwn: true, type: 'appointment_card', appointment: { status: 'pending', date: '2030-01-01', time: '10:00:00' } },
      { text: '', isOwn: false, type: 'property_card' },
      { text: '', isOwn: false, hasFile: true, fileName: 'doc.pdf' },
    ];
    const res = await request(app).post('/api/ai/smart-replies').send({ messages });
    expect(res.status).toBe(200);
  });

  it('should return 503 if AI disabled', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockRejectedValue(new Error('AI_DISABLED'));
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Hello', isOwn: false }],
    });
    expect(res.status).toBe(503);
  });

  it('should return 500 on AI error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockRejectedValue(new Error('something'));
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Hello', isOwn: false }],
    });
    expect(res.status).toBe(500);
  });

  it('should fallback to numbered format parsing', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockResolvedValue('1. Reply one\n2. Reply two\n3. Reply three');
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Hello', isOwn: false }],
    });
    expect(res.status).toBe(200);
    expect(res.body.replies.length).toBeGreaterThanOrEqual(2);
  });
});

describe('POST /api/ai/assistant', () => {
  it('should return 400 if no message', async () => {
    const res = await request(app).post('/api/ai/assistant').send({});
    expect(res.status).toBe(400);
  });

  it('should generate assistant reply', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    aiGenerateMessages.mockResolvedValue('The average price in CDMX is...');
    const res = await request(app).post('/api/ai/assistant').send({ message: 'What is the avg price in CDMX?' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reply).toBeDefined();
  });

  it('should return 503 if AI disabled', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    aiGenerateMessages.mockRejectedValue(new Error('AI_DISABLED'));
    const res = await request(app).post('/api/ai/assistant').send({ message: 'hello' });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/ai/assistant (with history and property context)', () => {
  it('should use conversation history for logged-in user', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes('INSERT INTO ai_conversations')) return cb(null, {});
      if (sql.includes('SELECT role, message FROM ai_conversations')) {
        return cb(null, [{ role: 'user', message: 'previous' }, { role: 'assistant', message: 'reply' }]);
      }
      if (sql.includes('buying_power')) return cb(null, []);
      return cb(null, []);
    });
    aiGenerateMessages.mockResolvedValue('Based on your history...');
    const res = await request(app).post('/api/ai/assistant').send({ message: 'What about?' });
    expect(res.status).toBe(200);
  });

  it('should enrich with property context', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes('INSERT INTO ai_conversations')) return cb(null, {});
      if (sql.includes('SELECT role, message')) return cb(null, []);
      if (sql.includes('SELECT id, type, estate_type')) {
        return cb(null, [{ id: 1, type: 'venta', estate_type: 'casa', price: 2000000, address: 'Test' }]);
      }
      if (sql.includes('buying_power')) return cb(null, [{ suggested: 3000000 }]);
      return cb(null, []);
    });
    aiGenerateMessages.mockResolvedValue('Property info...');
    const res = await request(app).post('/api/ai/assistant').send({
      message: 'Tell me about property', propertyIds: [1, 2],
    });
    expect(res.status).toBe(200);
  });

  it('should return 500 on general error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('db fail')));
    aiGenerateMessages.mockRejectedValue(new Error('fail'));
    const res = await request(app).post('/api/ai/assistant').send({ message: 'hello' });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/ai/user-context/:userId', () => {
  it('should return 400 for invalid userId', async () => {
    const res = await request(app).get('/api/ai/user-context/abc');
    expect(res.status).toBe(400);
  });

  it('should return user context', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/api/ai/user-context/5');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/ai/qualifying-profile', () => {
  it('should save qualifying profile', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, {}));
    const res = await request(app).post('/api/ai/qualifying-profile').send({
      intent: 'buy', purchase_timeline: '0-3 months',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/ai/assistant/history', () => {
  it('should return history', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ role: 'user', message: 'hi' }]));
    const res = await request(app).get('/api/ai/assistant/history');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/ai/assistant/cleanup', () => {
  it('should cleanup old messages', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ cnt: 20 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, {}));
    const res = await request(app).post('/api/ai/assistant/cleanup');
    expect(res.status).toBe(200);
  });

  it('should skip cleanup if under limit', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ cnt: 5 }]));
    const res = await request(app).post('/api/ai/assistant/cleanup');
    expect(res.status).toBe(200);
  });

  it('should return 200 on cleanup error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/api/ai/assistant/cleanup');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/ai/assistant (logged-in user)', () => {
  function setLoggedIn() {
    jwt.verify.mockImplementation((token, secret, cb) => {
      cb(null, { id: 1, email: 'test@test.com' });
    });
  }

  it('should insert and fetch conversation history', async () => {
    setLoggedIn();
    mockQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes('INSERT INTO ai_conversations')) return cb(null, {});
      if (sql.includes('SELECT role, message FROM ai_conversations')) {
        return cb(null, [{ role: 'user', message: 'prev' }, { role: 'assistant', message: 'ans' }]);
      }
      if (sql.includes('buying_power')) return cb(null, []);
      return cb(null, []);
    });
    aiGenerateMessages.mockResolvedValue('Logged-in reply');
    const res = await request(app)
      .post('/api/ai/assistant')
      .set('Authorization', 'Bearer valid-token')
      .send({ message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Logged-in reply');
  });

  it('should enrich with property context and buying power', async () => {
    setLoggedIn();
    mockQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes('INSERT INTO ai_conversations')) return cb(null, {});
      if (sql.includes('SELECT role, message')) return cb(null, []);
      if (sql.includes('SELECT id, type, estate_type')) {
        return cb(null, [{ id: 1, type: 'venta', estate_type: 'casa', price: 2000000, address: 'Polanco', monthly_pay: null }]);
      }
      if (sql.includes('buying_power')) return cb(null, [{ suggested: 3000000 }]);
      return cb(null, []);
    });
    aiGenerateMessages.mockResolvedValue('Property info...');
    const res = await request(app)
      .post('/api/ai/assistant')
      .set('Authorization', 'Bearer valid-token')
      .send({ message: 'Tell me about this property', propertyIds: [1] });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/ai/assistant/history (logged-in)', () => {
  it('should return history for logged-in user', async () => {
    jwt.verify.mockImplementation((token, secret, cb) => {
      cb(null, { id: 1 });
    });
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ role: 'user', message: 'hi', created_at: '2025-01-01' }]));
    const res = await request(app)
      .get('/api/ai/assistant/history')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  it('should return empty on error', async () => {
    jwt.verify.mockImplementation((token, secret, cb) => {
      cb(null, { id: 1 });
    });
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app)
      .get('/api/ai/assistant/history')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});

describe('GET /api/ai/user-context/:userId (cached)', () => {
  it('should return cached context from redis', async () => {
    const redis = require('../../db/redis');
    redis.get.mockResolvedValue(JSON.stringify({
      buying_power: { suggested: 2000000 },
      infonavit: null,
      tenant_profile: null,
      qualifying: null,
    }));
    const res = await request(app).get('/api/ai/user-context/5');
    expect(res.status).toBe(200);
    expect(res.body.buying_power.suggested).toBe(2000000);
  });
});

describe('POST /api/ai/qualifying-profile (error)', () => {
  it('should return 500 on db error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).post('/api/ai/qualifying-profile').send({
      intent: 'buy', purchase_timeline: '0-3 months',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/ai/smart-replies (qualifying + appointment enrichment)', () => {
  it('should enrich with qualifying profile data', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes('agent_type')) return cb(null, [{ agent_type: 'individual' }]);
      if (sql.includes('appointments')) return cb(null, []);
      if (sql.includes('buying_power')) return cb(null, [{ suggested: 2000000, monthly_income: 50000 }]);
      if (sql.includes('infonavit')) return cb(null, [{ credit_amount: 800000 }]);
      if (sql.includes('tenant_profiles')) return cb(null, [{ estimated_monthly_income: 30000 }]);
      if (sql.includes('user_qualifying')) return cb(null, [{
        intent: 'buy', purchase_timeline: '0-3', has_pre_approval: true,
        pre_approval_bank: 'BBVA', pre_approval_amount: 2500000,
        credit_score_range: 'good', bureau_status: 'clean',
      }]);
      return cb(null, []);
    });
    const redis = require('../../db/redis');
    redis.get.mockResolvedValue(null);
    aiGenerate.mockResolvedValue('R1|||R2|||R3');
    const messages = [
      { text: 'Hola', isOwn: false }, { text: 'Hi', isOwn: true },
      { text: 'Info', isOwn: false }, { text: 'Ok', isOwn: true },
      { text: 'Me interesa mucho', isOwn: false },
    ];
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages, propertyId: 1, clientId: 2,
      property: { address: 'Col Roma', type: 'venta', price: 1500000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.replies.length).toBeGreaterThan(0);
  });

  it('should handle pending appointment state', async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes('agent_type')) return cb(null, [{ agent_type: 'individual' }]);
      if (sql.includes('appointments')) return cb(null, [{ id: 2, appointment_date: '2030-02-01', appointment_time: '14:00:00', status: 'pending' }]);
      if (sql.includes('buying_power')) return cb(null, []);
      if (sql.includes('infonavit')) return cb(null, []);
      if (sql.includes('tenant_profiles')) return cb(null, []);
      if (sql.includes('user_qualifying')) return cb(null, []);
      return cb(null, []);
    });
    const redis = require('../../db/redis');
    redis.get.mockResolvedValue(null);
    aiGenerate.mockResolvedValue('R1|||R2|||R3');
    const messages = [
      { text: 'Hola', isOwn: false }, { text: 'Hi', isOwn: true },
      { text: 'Info', isOwn: false }, { text: 'Ok', isOwn: true },
      { text: 'Cambio de hora', isOwn: false },
    ];
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages, propertyId: 1, clientId: 2,
      property: { address: 'Col Roma', type: 'renta', monthly_pay: 15000 },
    });
    expect(res.status).toBe(200);
  });

  it('should return 500 if AI returns empty result', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockResolvedValue('');
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Hello', isOwn: false }],
    });
    expect(res.status).toBe(500);
  });

  it('should fallback to newline-separated parsing', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ agent_type: 'individual' }]));
    aiGenerate.mockResolvedValue('Reply one\nReply two\nReply three');
    const res = await request(app).post('/api/ai/smart-replies').send({
      messages: [{ text: 'Hello', isOwn: false }],
    });
    expect(res.status).toBe(200);
    expect(res.body.replies.length).toBeGreaterThanOrEqual(2);
  });
});
