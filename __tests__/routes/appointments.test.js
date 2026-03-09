const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');
jest.mock('../../utils/helpers', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(true),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'individual' };
  next();
});

const mockPromiseQuery = jest.fn();
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const router = require('../../routes/appointments');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => {
  mockPromiseQuery.mockReset();
  pool.promise.mockImplementation(() => ({ query: mockPromiseQuery }));
});

describe('POST /api/calendar-sync', () => {
  it('should sync calendar blocks', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ agent_type: 'individual' }]]) // user check
      .mockResolvedValueOnce([[{ device_event_id: 'ev1' }]]) // existing
      .mockResolvedValueOnce([{}]) // delete removed
      .mockResolvedValueOnce([{}]); // insert new

    const res = await request(app).post('/api/calendar-sync').send({
      blocks_by_date: { '2025-01-01': [{ start: '09:00', end: '10:00', is_all_day: false, device_event_id: 'ev2' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 403 for regular users', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ agent_type: 'regular' }]]);
    const res = await request(app).post('/api/calendar-sync').send({ blocks_by_date: {} });
    expect(res.status).toBe(403);
  });

  it('should return 400 if missing blocks_by_date', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ agent_type: 'individual' }]]);
    const res = await request(app).post('/api/calendar-sync').send({});
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/calendar-sync').send({ blocks_by_date: {} });
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/calendar-sync/toggle', () => {
  it('should enable sync', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    const res = await request(app).put('/api/calendar-sync/toggle').send({ enabled: true });
    expect(res.status).toBe(200);
  });

  it('should disable sync and clear blocks', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);
    const res = await request(app).put('/api/calendar-sync/toggle').send({ enabled: false });
    expect(res.status).toBe(200);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/calendar-sync/toggle').send({ enabled: true });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/calendar-blocks', () => {
  it('should return blocks', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, block_date: '2025-01-01' }]]);
    const res = await request(app).get('/api/calendar-blocks?from=2025-01-01&to=2025-01-31');
    expect(res.status).toBe(200);
    expect(res.body.blocks).toHaveLength(1);
  });

  it('should return 400 if missing params', async () => {
    const res = await request(app).get('/api/calendar-blocks');
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/calendar-blocks?from=2025-01-01&to=2025-01-31');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/calendar-blocks/:id/toggle-available', () => {
  it('should toggle availability', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ is_available: 1 }]]);
    const res = await request(app).put('/api/calendar-blocks/1/toggle-available');
    expect(res.status).toBe(200);
    expect(res.body.is_available).toBe(1);
  });

  it('should return 404 if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(app).put('/api/calendar-blocks/999/toggle-available');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/appointments', () => {
  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/api/appointments').send({});
    expect(res.status).toBe(400);
  });

  it('should return 404 if property not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).post('/api/appointments').send({
      property_id: 999, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(404);
  });

  it('should return 400 if own property', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]]);
    const res = await request(app).post('/api/appointments').send({
      property_id: 1, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(400);
  });

  it('should create appointment successfully', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 5, address: 'Test', type: 'venta', price: 100 }]]) // property
      .mockResolvedValueOnce([[]]) // no existing appointment
      .mockResolvedValueOnce([[]]) // no calendar blocks
      .mockResolvedValueOnce([{ insertId: 10 }]) // insert appointment
      .mockResolvedValueOnce([[{ name: 'John', last_name: 'Doe' }]]) // requester name
      .mockResolvedValueOnce([{}]); // chat message

    const res = await request(app).post('/api/appointments').send({
      property_id: 1, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it('should return 409 if appointment exists', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 5, address: 'Test' }]])
      .mockResolvedValueOnce([[{ id: 3 }]]); // existing appointment

    const res = await request(app).post('/api/appointments').send({
      property_id: 1, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(409);
  });

  it('should return 409 if calendar conflict', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, created_by: 5, address: 'Test' }]]) // property
      .mockResolvedValueOnce([[]]) // no existing appointment
      .mockResolvedValueOnce([[{ block_start: '09:00', block_end: '11:00', is_all_day: false }]]); // calendar block conflict

    const res = await request(app).post('/api/appointments').send({
      property_id: 1, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(409);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/appointments').send({
      property_id: 1, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/appointments/quick-invite', () => {
  it('should return 400 if missing fields', async () => {
    const res = await request(app).post('/api/appointments/quick-invite').send({});
    expect(res.status).toBe(400);
  });

  it('should return 403 for non-agents', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'regular', name: 'A', last_name: 'B' }]]);
    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(403);
  });

  it('should return 404 if property not found', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[]]); // property not found
    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 999, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(404);
  });

  it('should return 403 if property not owned by agent', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 999, address: 'Test' }]]); // different owner
    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(403);
  });

  it('should return 409 if confirmed appointment exists', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]])
      .mockResolvedValueOnce([[{ id: 99 }]]); // confirmed exists
    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(409);
  });

  it('should create quick invite successfully', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]]) // property
      .mockResolvedValueOnce([[]]) // no confirmed exist
      .mockResolvedValueOnce([[]]) // no old pending
      .mockResolvedValueOnce([[{ work_start: '09:00', work_end: '18:00' }]]) // schedule
      .mockResolvedValueOnce([[]]) // slot not taken
      .mockResolvedValueOnce([[]]) // no calendar blocks
      .mockResolvedValueOnce([{ insertId: 10 }]) // insert appointment
      .mockResolvedValueOnce([{}]); // chat message

    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it('should cancel old pending appointments', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]])
      .mockResolvedValueOnce([[]]) // no confirmed
      .mockResolvedValueOnce([[{ id: 50 }, { id: 51 }]]) // old pending to cancel
      .mockResolvedValueOnce([{}]) // cancel old pending
      .mockResolvedValueOnce([[{ work_start: '09:00', work_end: '18:00' }]])
      .mockResolvedValueOnce([[]]) // slot not taken
      .mockResolvedValueOnce([[]]) // no calendar blocks
      .mockResolvedValueOnce([{ insertId: 10 }])
      .mockResolvedValueOnce([{}]); // chat message

    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(201);
    expect(res.body.cancelledIds).toEqual([50, 51]);
  });

  it('should return 409 OUT_OF_HOURS if time outside work schedule', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]])
      .mockResolvedValueOnce([[]]) // no confirmed
      .mockResolvedValueOnce([[]]) // no old pending
      .mockResolvedValueOnce([[{ work_start: '09:00', work_end: '18:00' }]]) // schedule
      .mockResolvedValueOnce([[]]); // booked slots for suggestion

    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '06:00:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OUT_OF_HOURS');
  });

  it('should return 409 SLOT_TAKEN if slot busy', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]])
      .mockResolvedValueOnce([[]]) // no confirmed
      .mockResolvedValueOnce([[]]) // no old pending
      .mockResolvedValueOnce([[{ work_start: '09:00', work_end: '18:00' }]]) // schedule
      .mockResolvedValueOnce([[{ id: 99 }]]) // slot taken
      .mockResolvedValueOnce([[{ appointment_time: '10:00:00' }]]); // booked for suggestion

    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SLOT_TAKEN');
  });

  it('should return 409 CALENDAR_BLOCKED if calendar conflict', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]])
      .mockResolvedValueOnce([[]]) // no confirmed
      .mockResolvedValueOnce([[]]) // no old pending
      .mockResolvedValueOnce([[{ work_start: '09:00', work_end: '18:00' }]]) // schedule
      .mockResolvedValueOnce([[]]) // slot not taken
      .mockResolvedValueOnce([[{ block_start: '09:00', block_end: '11:00', is_all_day: false }]]); // calendar blocks

    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CALENDAR_BLOCKED');
  });

  it('should skip chat message with skip_chat_message flag', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Agent', last_name: 'Smith' }]])
      .mockResolvedValueOnce([[{ id: 1, created_by: 1, address: 'Test' }]])
      .mockResolvedValueOnce([[]]) // no confirmed
      .mockResolvedValueOnce([[]]) // no old pending
      .mockResolvedValueOnce([[{ work_start: '09:00', work_end: '18:00' }]])
      .mockResolvedValueOnce([[]]) // slot not taken
      .mockResolvedValueOnce([[]]) // no cal blocks
      .mockResolvedValueOnce([{ insertId: 10 }]); // insert only, no chat

    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
      skip_chat_message: true,
    });
    expect(res.status).toBe(201);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).post('/api/appointments/quick-invite').send({
      property_id: 1, client_id: 2, appointment_date: '2030-01-01', appointment_time: '10:00:00',
    });
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/appointments/:id/client-accept', () => {
  it('should accept appointment', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{
        id: 1, agent_id: 5, requester_id: 1, status: 'pending',
        property_id: 10, appointment_date: '2030-01-01', appointment_time: '10:00:00',
      }]])
      .mockResolvedValueOnce([{}]) // update status
      .mockResolvedValueOnce([[{ name: 'Client', last_name: 'Test' }]]); // client name for push

    const res = await request(app).put('/api/appointments/1/client-accept');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 404 if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/api/appointments/999/client-accept');
    expect(res.status).toBe(404);
  });

  it('should return 403 if not requester', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, requester_id: 999, status: 'pending' }]]);
    const res = await request(app).put('/api/appointments/1/client-accept');
    expect(res.status).toBe(403);
  });

  it('should return 400 if not pending', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, requester_id: 1, status: 'confirmed' }]]);
    const res = await request(app).put('/api/appointments/1/client-accept');
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/appointments/1/client-accept');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/appointments', () => {
  it('should return appointments for both roles (default)', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]);
    const res = await request(app).get('/api/appointments');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('should filter by requester role', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1 }]]);
    const res = await request(app).get('/api/appointments?role=requester');
    expect(res.status).toBe(200);
  });

  it('should filter by agent role', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 2 }]]);
    const res = await request(app).get('/api/appointments?role=agent');
    expect(res.status).toBe(200);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/appointments');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/appointments/:id', () => {
  it('should return appointment by id', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{
      id: 5, property_address: 'Test St', requester_name: 'John',
    }]]);
    const res = await request(app).get('/api/appointments/5');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
  });

  it('should return 404 if not found or not authorized', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/appointments/999');
    expect(res.status).toBe(404);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/appointments/1');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/appointments/:id/confirm', () => {
  it('should confirm appointment', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'pending', property_id: 10 }]])
      .mockResolvedValueOnce([{}]); // update
    const res = await request(app).put('/api/appointments/1/confirm');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 404 if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/api/appointments/999/confirm');
    expect(res.status).toBe(404);
  });

  it('should return 403 if not the agent', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 999, requester_id: 5, status: 'pending' }]]);
    const res = await request(app).put('/api/appointments/1/confirm');
    expect(res.status).toBe(403);
  });

  it('should return 400 if not pending', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'confirmed' }]]);
    const res = await request(app).put('/api/appointments/1/confirm');
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/appointments/1/confirm');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/appointments/:id/cancel', () => {
  it('should cancel appointment by agent', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'pending', property_id: 10 }]])
      .mockResolvedValueOnce([{}]); // update
    const res = await request(app).put('/api/appointments/1/cancel').send({ cancellation_reason: 'scheduling conflict' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should cancel appointment by requester', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 5, requester_id: 1, status: 'confirmed', property_id: 10 }]])
      .mockResolvedValueOnce([{}]); // update
    const res = await request(app).put('/api/appointments/1/cancel').send({});
    expect(res.status).toBe(200);
  });

  it('should return 404 if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/api/appointments/999/cancel').send({});
    expect(res.status).toBe(404);
  });

  it('should return 403 if not part of appointment', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 99, requester_id: 88, status: 'pending' }]]);
    const res = await request(app).put('/api/appointments/1/cancel').send({});
    expect(res.status).toBe(403);
  });

  it('should return 400 if already cancelled', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'cancelled' }]]);
    const res = await request(app).put('/api/appointments/1/cancel').send({});
    expect(res.status).toBe(400);
  });

  it('should return 400 if already completed', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'completed' }]]);
    const res = await request(app).put('/api/appointments/1/cancel').send({});
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/appointments/1/cancel').send({});
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/appointments/:id/complete', () => {
  it('should complete appointment', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'confirmed' }]])
      .mockResolvedValueOnce([{}]);
    const res = await request(app).put('/api/appointments/1/complete');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 404 if not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/api/appointments/999/complete');
    expect(res.status).toBe(404);
  });

  it('should return 403 if not the agent', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 999, requester_id: 5, status: 'confirmed' }]]);
    const res = await request(app).put('/api/appointments/1/complete');
    expect(res.status).toBe(403);
  });

  it('should return 400 if not confirmed', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'pending' }]]);
    const res = await request(app).put('/api/appointments/1/complete');
    expect(res.status).toBe(400);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/appointments/1/complete');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/appointments/next-available/:id1', () => {
  it('should find next available slot', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 5, work_start: '09:00', work_end: '18:00', agent_type: 'individual' }]]) // users
      .mockResolvedValueOnce([[]]) // agent booked day 1
      .mockResolvedValueOnce([[]]); // cal blocks day 1

    const res = await request(app).get('/api/appointments/next-available/5');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.date).toBeDefined();
    expect(res.body.time).toBeDefined();
  });

  it('should return found:false if no agent found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/appointments/next-available/999');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it('should return found:false if no agent row has schedule', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 5, agent_type: 'regular', work_start: null, work_end: null }]]);
    const res = await request(app).get('/api/appointments/next-available/5');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it('should include client_id exclusion', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([
        [{ id: 5, work_start: '09:00', work_end: '18:00', agent_type: 'individual' },
         { id: 2, agent_type: 'regular', work_start: null, work_end: null }],
      ])
      .mockResolvedValueOnce([[]]) // agent booked
      .mockResolvedValueOnce([[]]) // client booked
      .mockResolvedValueOnce([[]]); // cal blocks

    const res = await request(app).get('/api/appointments/next-available/5?client_id=2');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/appointments/next-available/5');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/appointments/available-slots/:agentId', () => {
  it('should return 400 if missing date', async () => {
    const res = await request(app).get('/api/appointments/available-slots/5');
    expect(res.status).toBe(400);
  });

  it('should return available slots', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 5, work_start: '09:00', work_end: '12:00', agent_type: 'individual' }]])
      .mockResolvedValueOnce([[]]) // agent booked
      .mockResolvedValueOnce([[]]); // cal blocks

    const res = await request(app).get('/api/appointments/available-slots/5?date=2030-01-01');
    expect(res.status).toBe(200);
    expect(res.body.available_slots).toBeDefined();
    expect(res.body.available_slots.length).toBeGreaterThan(0);
  });

  it('should return empty if no agent found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/appointments/available-slots/5?date=2030-01-01');
    expect(res.status).toBe(200);
    expect(res.body.available_slots).toEqual([]);
  });

  it('should return empty if no agent has schedule', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 5, agent_type: 'regular', work_start: null, work_end: null }]]);
    const res = await request(app).get('/api/appointments/available-slots/5?date=2030-01-01');
    expect(res.status).toBe(200);
    expect(res.body.available_slots).toEqual([]);
  });

  it('should include client booking exclusion with client_id', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([
        [{ id: 5, work_start: '09:00', work_end: '12:00', agent_type: 'individual' },
         { id: 2, agent_type: 'regular', work_start: null, work_end: null }],
      ])
      .mockResolvedValueOnce([[]]) // agent booked
      .mockResolvedValueOnce([[]]) // client booked
      .mockResolvedValueOnce([[]]); // cal blocks

    const res = await request(app).get('/api/appointments/available-slots/5?date=2030-01-01&client_id=2');
    expect(res.status).toBe(200);
    expect(res.body.available_slots.length).toBeGreaterThan(0);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/appointments/available-slots/5?date=2030-01-01');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/appointments/first-available-day/:agentId', () => {
  it('should find first available day', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 5, work_start: '09:00', work_end: '12:00', agent_type: 'individual' }]])
      .mockResolvedValueOnce([[]]) // agent appts in range
      .mockResolvedValueOnce([[]]); // cal blocks in range

    const res = await request(app).get('/api/appointments/first-available-day/5');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.date).toBeDefined();
    expect(res.body.slots).toBeDefined();
  });

  it('should return found:false if no agent has schedule', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 5, agent_type: 'regular', work_start: null, work_end: null }]]);
    const res = await request(app).get('/api/appointments/first-available-day/5');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it('should include client appointments when client_id specified', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([
        [{ id: 5, work_start: '09:00', work_end: '12:00', agent_type: 'individual' },
         { id: 2, agent_type: 'regular', work_start: null, work_end: null }],
      ])
      .mockResolvedValueOnce([[]]) // agent appts
      .mockResolvedValueOnce([[]]) // client appts
      .mockResolvedValueOnce([[]]); // cal blocks

    const res = await request(app).get('/api/appointments/first-available-day/5?client_id=2');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/api/appointments/first-available-day/5');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/appointments/:id/reschedule', () => {
  it('should return 400 if missing date or time', async () => {
    const res = await request(app).put('/api/appointments/1/reschedule').send({});
    expect(res.status).toBe(400);
  });

  it('should reschedule appointment successfully', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, property_id: 10, status: 'pending' }]]) // appointment
      .mockResolvedValueOnce([[]]) // no conflict at new time
      .mockResolvedValueOnce([[]]) // no calendar blocks
      .mockResolvedValueOnce([{}]); // update

    const res = await request(app).put('/api/appointments/1/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should reset confirmed status to pending', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, property_id: 10, status: 'confirmed' }]])
      .mockResolvedValueOnce([[]]) // no conflict
      .mockResolvedValueOnce([[]]) // no cal blocks
      .mockResolvedValueOnce([{}]); // update

    const res = await request(app).put('/api/appointments/1/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.new_status).toBe('pending');
  });

  it('should return 404 if appointment not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/api/appointments/999/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(404);
  });

  it('should return 403 if not part of appointment', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 99, requester_id: 88, property_id: 10, status: 'pending' }]]);
    const res = await request(app).put('/api/appointments/1/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(403);
  });

  it('should return 400 if cancelled or completed', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, status: 'cancelled' }]]);
    const res = await request(app).put('/api/appointments/1/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(400);
  });

  it('should return 409 if new time conflicts with existing appointment', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, property_id: 10, status: 'pending' }]])
      .mockResolvedValueOnce([[{ id: 99 }]]); // conflict

    const res = await request(app).put('/api/appointments/1/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(409);
  });

  it('should return 409 if calendar conflict', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_id: 1, requester_id: 5, property_id: 10, status: 'pending' }]])
      .mockResolvedValueOnce([[]]) // no appointment conflict
      .mockResolvedValueOnce([[{ block_start: '13:00', block_end: '15:00', is_all_day: false }]]); // calendar conflict

    const res = await request(app).put('/api/appointments/1/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(409);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/api/appointments/1/reschedule').send({
      appointment_date: '2030-02-01', appointment_time: '14:00:00',
    });
    expect(res.status).toBe(500);
  });
});
