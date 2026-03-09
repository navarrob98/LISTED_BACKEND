const express = require('express');
const request = require('supertest');

jest.mock('../../db/pool');
jest.mock('../../middleware/authenticateToken');
jest.mock('../../cldnry', () => ({
  utils: { api_sign_request: jest.fn(() => 'mock-signature') },
}));
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) },
  },
}));
jest.mock('../../cloud-folder-delete', () => ({
  deleteUserChatUploadsByFolder: jest.fn().mockResolvedValue(),
  deleteUserPropertyUploadsByFolder: jest.fn().mockResolvedValue(),
}));
jest.mock('bcrypt', () => ({
  hashSync: jest.fn(() => 'hashed_password'),
}));
jest.mock('../../utils/helpers', () => ({
  q: jest.fn(),
}));

const pool = require('../../db/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const { q } = require('../../utils/helpers');
const { deleteUserChatUploadsByFolder, deleteUserPropertyUploadsByFolder } = require('../../cloud-folder-delete');

authenticateToken.mockImplementation((req, res, next) => {
  req.user = { id: 1, email: 'test@test.com', agent_type: 'regular' };
  next();
});

const mockQuery = jest.fn();
const mockPromiseQuery = jest.fn();
pool.query = mockQuery;
pool.promise = jest.fn(() => ({ query: mockPromiseQuery }));

const mockConnection = {
  beginTransaction: jest.fn((cb) => cb(null)),
  commit: jest.fn((cb) => cb(null)),
  rollback: jest.fn((cb) => cb(null)),
  release: jest.fn(),
  query: jest.fn(),
};
pool.getConnection = jest.fn((cb) => cb(null, mockConnection));

const router = require('../../routes/users');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

describe('GET /users/:id', () => {
  it('should return full profile for own user', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 1, name: 'Test', email: 'test@test.com' }]));
    const res = await request(app).get('/users/1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
  });

  it('should return limited profile for other user', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, [{ id: 5, name: 'Other' }]));
    const res = await request(app).get('/users/5');
    expect(res.status).toBe(200);
  });

  it('should return 404 if not found', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(null, []));
    const res = await request(app).get('/users/999');
    expect(res.status).toBe(404);
  });

  it('should return 500 on DB error', async () => {
    mockQuery.mockImplementation((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/users/1');
    expect(res.status).toBe(500);
  });
});

describe('PUT /users/:id', () => {
  it('should return 403 if not own user', async () => {
    const res = await request(app).put('/users/999').send({ phone: '555' });
    expect(res.status).toBe(403);
  });

  it('should return 400 if trying to change email', async () => {
    const res = await request(app).put('/users/1').send({ email: 'new@test.com' });
    expect(res.status).toBe(400);
  });

  it('should return 400 if password too short', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'regular', name: 'Test', last_name: 'User' }]]);
    const res = await request(app).put('/users/1').send({ password: 'short' });
    expect(res.status).toBe(400);
  });

  it('should return 400 if no fields to update', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ id: 1, agent_type: 'regular', name: 'Test', last_name: 'User' }]]);
    const res = await request(app).put('/users/1').send({});
    expect(res.status).toBe(400);
  });

  it('should update phone successfully', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'regular', name: 'Test', last_name: 'User' }]])
      .mockResolvedValueOnce([{}]) // update
      .mockResolvedValueOnce([[{ id: 1, name: 'Test', phone: '555' }]]); // select updated
    const res = await request(app).put('/users/1').send({ phone: '555' });
    expect(res.status).toBe(200);
  });

  it('should reset verification for agent name change', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'individual', name: 'Old', last_name: 'Name' }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ id: 1, name: 'New', agent_verification_status: 'pending' }]]);
    const res = await request(app).put('/users/1').send({ name: 'New' });
    expect(res.status).toBe(200);
  });

  it('should return 404 if user not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/users/1').send({ phone: '555' });
    expect(res.status).toBe(404);
  });

  it('should return 500 on DB error during fetch', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/users/1').send({ phone: '555' });
    expect(res.status).toBe(500);
  });

  it('should return 500 on DB error during update', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ id: 1, agent_type: 'regular', name: 'Test', last_name: 'User' }]])
      .mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/users/1').send({ phone: '555' });
    expect(res.status).toBe(500);
  });
});

describe('GET /users/:id/profile-photo', () => {
  it('should return profile photo', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ profile_photo: 'http://img.com/photo.jpg' }]]);
    const res = await request(app).get('/users/1/profile-photo');
    expect(res.status).toBe(200);
    expect(res.body.profile_photo).toBe('http://img.com/photo.jpg');
  });

  it('should return null if no photo', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[{ profile_photo: null }]]);
    const res = await request(app).get('/users/1/profile-photo');
    expect(res.status).toBe(200);
    expect(res.body.profile_photo).toBeNull();
  });

  it('should return 404 if user not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/users/999/profile-photo');
    expect(res.status).toBe(404);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).get('/users/1/profile-photo');
    expect(res.status).toBe(500);
  });
});

describe('POST /users/me/profile-photo/sign-upload', () => {
  beforeEach(() => {
    process.env.CLD_PRESET_PUBLIC = 'test_preset';
    process.env.CLOUDINARY_API_SECRET = 'secret';
    process.env.CLOUDINARY_CLOUD_NAME = 'test_cloud';
    process.env.CLOUDINARY_API_KEY = 'key123';
  });

  it('should return 400 if missing file_name', async () => {
    const res = await request(app).post('/users/me/profile-photo/sign-upload').send({});
    expect(res.status).toBe(400);
  });

  it('should return signed params', async () => {
    const res = await request(app).post('/users/me/profile-photo/sign-upload').send({ file_name: 'photo.jpg' });
    expect(res.status).toBe(200);
    expect(res.body.signature).toBe('mock-signature');
    expect(res.body.cloud_name).toBe('test_cloud');
  });

  it('should return 500 if preset missing', async () => {
    delete process.env.CLD_PRESET_PUBLIC;
    const res = await request(app).post('/users/me/profile-photo/sign-upload').send({ file_name: 'photo.jpg' });
    expect(res.status).toBe(500);
  });
});

describe('PUT /users/me/profile-photo', () => {
  it('should return 400 if no profile_photo', async () => {
    const res = await request(app).put('/users/me/profile-photo').send({});
    expect(res.status).toBe(400);
  });

  it('should return 400 if not cloudinary URL', async () => {
    const res = await request(app).put('/users/me/profile-photo').send({ profile_photo: 'http://other.com/img.jpg' });
    expect(res.status).toBe(400);
  });

  it('should update profile photo', async () => {
    mockPromiseQuery.mockResolvedValueOnce([{}]);
    const res = await request(app).put('/users/me/profile-photo').send({
      profile_photo: 'https://res.cloudinary.com/test/image/upload/v1/listed/dev/image/u_1/photo.jpg',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 500 on DB error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).put('/users/me/profile-photo').send({
      profile_photo: 'https://res.cloudinary.com/test/photo.jpg',
    });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /users/me/profile-photo', () => {
  it('should delete profile photo with cloudinary cleanup', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ profile_photo: 'https://res.cloudinary.com/test/image/upload/v123/listed/dev/image/u_1/photo.jpg' }]])
      .mockResolvedValueOnce([{}]);
    const res = await request(app).delete('/users/me/profile-photo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should delete even if no photo exists', async () => {
    mockPromiseQuery
      .mockResolvedValueOnce([[{ profile_photo: null }]])
      .mockResolvedValueOnce([{}]);
    const res = await request(app).delete('/users/me/profile-photo');
    expect(res.status).toBe(200);
  });

  it('should return 404 if user not found', async () => {
    mockPromiseQuery.mockResolvedValueOnce([[]]);
    const res = await request(app).delete('/users/me/profile-photo');
    expect(res.status).toBe(404);
  });

  it('should return 500 on error', async () => {
    mockPromiseQuery.mockRejectedValueOnce(new Error('fail'));
    const res = await request(app).delete('/users/me/profile-photo');
    expect(res.status).toBe(500);
  });
});

describe('GET /users/:id/delete-preview', () => {
  it('should return 403 if not own user', async () => {
    const res = await request(app).get('/users/999/delete-preview');
    expect(res.status).toBe(403);
  });

  it('should return preview data', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ id: 1, address: 'Test', price: 100 }]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [{ properties: 1, property_images: 3, chat_messages: 10, hidden_chats: 0, tenant_profiles: 1, buying_power: 1 }]));
    const res = await request(app).get('/users/1/delete-preview');
    expect(res.status).toBe(200);
    expect(res.body.properties).toHaveLength(1);
    expect(res.body.counts).toBeDefined();
  });

  it('should return 500 on first query error', async () => {
    mockQuery.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/users/1/delete-preview');
    expect(res.status).toBe(500);
  });

  it('should return 500 on second query error', async () => {
    mockQuery
      .mockImplementationOnce((sql, params, cb) => cb(null, []))
      .mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
    const res = await request(app).get('/users/1/delete-preview');
    expect(res.status).toBe(500);
  });
});

describe('POST /users/:id/delete-account', () => {
  it('should return 403 if not own user', async () => {
    const res = await request(app).post('/users/999/delete-account');
    expect(res.status).toBe(403);
  });

  it('should delete account successfully', async () => {
    q.mockResolvedValue([]);
    const res = await request(app).post('/users/1/delete-account');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deleteUserChatUploadsByFolder).toHaveBeenCalledWith(1);
    expect(deleteUserPropertyUploadsByFolder).toHaveBeenCalledWith(1);
  });

  it('should return 500 if getConnection fails', async () => {
    pool.getConnection.mockImplementationOnce((cb) => cb(new Error('no connection')));
    const res = await request(app).post('/users/1/delete-account');
    expect(res.status).toBe(500);
  });

  it('should return 500 if beginTransaction fails', async () => {
    mockConnection.beginTransaction.mockImplementationOnce((cb) => cb(new Error('tx fail')));
    const res = await request(app).post('/users/1/delete-account');
    expect(res.status).toBe(500);
  });

  it('should return 500 if cloudinary chat delete fails', async () => {
    q.mockResolvedValue([]);
    deleteUserChatUploadsByFolder.mockRejectedValueOnce(new Error('cloud fail'));
    const res = await request(app).post('/users/1/delete-account');
    expect(res.status).toBe(500);
  });

  it('should return 500 if cloudinary property delete fails', async () => {
    q.mockResolvedValue([]);
    deleteUserChatUploadsByFolder.mockResolvedValueOnce();
    deleteUserPropertyUploadsByFolder.mockRejectedValueOnce(new Error('cloud fail'));
    const res = await request(app).post('/users/1/delete-account');
    expect(res.status).toBe(500);
  });

  it('should return 500 if commit fails', async () => {
    q.mockResolvedValue([]);
    mockConnection.commit.mockImplementationOnce((cb) => cb(new Error('commit fail')));
    const res = await request(app).post('/users/1/delete-account');
    expect(res.status).toBe(500);
  });

  it('should return 500 if q throws', async () => {
    q.mockRejectedValueOnce(new Error('query fail'));
    const res = await request(app).post('/users/1/delete-account');
    expect(res.status).toBe(500);
  });
});
