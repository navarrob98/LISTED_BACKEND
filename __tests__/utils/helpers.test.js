const mockRedis = require('../../__mocks__/redisMock').createRedisMock();
const mockPoolData = require('../../__mocks__/dbMock').createPoolMock();

jest.mock('../../db/redis', () => mockRedis);
jest.mock('../../db/pool', () => mockPoolData.pool);

jest.mock('../../cldnry', () => ({
  url: jest.fn(() => 'https://cloudinary.com/mock-url'),
}));

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn() },
  })),
}));

jest.mock('expo-server-sdk', () => {
  const mockInstance = {
    chunkPushNotifications: jest.fn((msgs) => [msgs]),
    sendPushNotificationsAsync: jest.fn().mockResolvedValue([]),
  };
  const MockExpo = jest.fn().mockImplementation(() => mockInstance);
  MockExpo.isExpoPushToken = jest.fn((t) => typeof t === 'string' && t.startsWith('ExponentPushToken['));
  return { Expo: MockExpo };
});

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock-jwt-token'),
}));

jest.mock('express-rate-limit', () => jest.fn(() => jest.fn()));
jest.mock('rate-limit-redis', () => ({ default: jest.fn() }));

const helpers = require('../../utils/helpers');
const cloudinary = require('../../cldnry');
const jwt = require('jsonwebtoken');

describe('helpers.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── extFromFilename ─────────────────────────
  describe('extFromFilename', () => {
    test('extracts extension from filename', () => {
      expect(helpers.extFromFilename('photo.jpg')).toBe('jpg');
    });

    test('extracts extension case-insensitive', () => {
      expect(helpers.extFromFilename('file.PDF')).toBe('pdf');
    });

    test('returns undefined for no extension', () => {
      expect(helpers.extFromFilename('noext')).toBeUndefined();
    });

    test('returns undefined for null/empty', () => {
      expect(helpers.extFromFilename(null)).toBeUndefined();
      expect(helpers.extFromFilename('')).toBeUndefined();
      expect(helpers.extFromFilename(undefined)).toBeUndefined();
    });

    test('gets last extension from multi-dot filename', () => {
      expect(helpers.extFromFilename('archive.tar.gz')).toBe('gz');
    });
  });

  // ── parseCloudinary ─────────────────────────
  describe('parseCloudinary', () => {
    const validUrl = 'https://res.cloudinary.com/mycloud/raw/upload/v1234567/folder/file.pdf';

    test('parses valid cloudinary upload URL', () => {
      const result = helpers.parseCloudinary(validUrl);
      expect(result).toMatchObject({
        cloud: 'mycloud',
        resource_type: 'raw',
        type: 'upload',
        public_id: 'folder/file',
        format: 'pdf',
      });
    });

    test('parses authenticated URL', () => {
      const url = 'https://res.cloudinary.com/mycloud/image/authenticated/v123/pic.jpg';
      const result = helpers.parseCloudinary(url);
      expect(result.type).toBe('authenticated');
      expect(result.resource_type).toBe('image');
    });

    test('returns null for invalid URL', () => {
      expect(helpers.parseCloudinary('https://example.com/file.pdf')).toBeNull();
      expect(helpers.parseCloudinary(null)).toBeNull();
      expect(helpers.parseCloudinary('')).toBeNull();
    });

    test('parses URL without version', () => {
      const url = 'https://res.cloudinary.com/mycloud/video/upload/folder/vid.mp4';
      const result = helpers.parseCloudinary(url);
      expect(result.resource_type).toBe('video');
      expect(result.version).toBeUndefined();
    });

    test('parses signed URL', () => {
      const url = 'https://res.cloudinary.com/mycloud/raw/authenticated/s--abcd1234--/v123/doc.docx';
      const result = helpers.parseCloudinary(url);
      expect(result).not.toBeNull();
      expect(result.type).toBe('authenticated');
    });
  });

  // ── buildDeliveryUrlFromSecure ──────────────
  describe('buildDeliveryUrlFromSecure', () => {
    test('returns null for invalid URL', () => {
      expect(helpers.buildDeliveryUrlFromSecure('bad-url')).toBeNull();
    });

    test('builds URL for upload type (no signing)', () => {
      const url = 'https://res.cloudinary.com/mycloud/raw/upload/v123/file.pdf';
      helpers.buildDeliveryUrlFromSecure(url, 'file.pdf');
      expect(cloudinary.url).toHaveBeenCalledWith('file', expect.objectContaining({ sign_url: false }));
    });

    test('builds signed URL for authenticated type', () => {
      const url = 'https://res.cloudinary.com/mycloud/raw/authenticated/v123/file.pdf';
      helpers.buildDeliveryUrlFromSecure(url, 'file.pdf');
      expect(cloudinary.url).toHaveBeenCalledWith('file', expect.objectContaining({
        sign_url: true,
        attachment: 'file.pdf',
      }));
    });

    test('builds signed URL for private type', () => {
      const url = 'https://res.cloudinary.com/mycloud/raw/private/v123/doc.pdf';
      helpers.buildDeliveryUrlFromSecure(url, 'doc.pdf');
      expect(cloudinary.url).toHaveBeenCalledWith('doc', expect.objectContaining({
        sign_url: true,
      }));
    });
  });

  // ── signedDeliveryUrlFromSecure ─────────────
  describe('signedDeliveryUrlFromSecure', () => {
    test('returns null for invalid URL', () => {
      expect(helpers.signedDeliveryUrlFromSecure('bad')).toBeNull();
    });

    test('generates signed URL', () => {
      const url = 'https://res.cloudinary.com/mycloud/raw/upload/v123/file.pdf';
      helpers.signedDeliveryUrlFromSecure(url, 300, 'file.pdf');
      expect(cloudinary.url).toHaveBeenCalledWith('file', expect.objectContaining({
        type: 'authenticated',
        sign_url: true,
        secure: true,
      }));
    });

    test('uses filename extension when URL has no format', () => {
      const url = 'https://res.cloudinary.com/mycloud/raw/upload/v123/noext';
      helpers.signedDeliveryUrlFromSecure(url, 300, 'document.pptx');
      expect(cloudinary.url).toHaveBeenCalledWith('noext', expect.objectContaining({
        format: 'pptx',
      }));
    });
  });

  // ── gen6 ────────────────────────────────────
  describe('gen6', () => {
    test('returns a 6-digit string', () => {
      const code = helpers.gen6();
      expect(code).toMatch(/^\d{6}$/);
    });

    test('returns different values (probabilistic)', () => {
      const codes = new Set(Array.from({ length: 10 }, () => helpers.gen6()));
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  // ── sendVerificationEmail ───────────────────
  describe('sendVerificationEmail', () => {
    test('sends email via resend and returns true', async () => {
      helpers.resend.emails.send.mockResolvedValue({ id: '123' });
      const result = await helpers.sendVerificationEmail('user@test.com', '123456');
      expect(result).toBe(true);
      expect(helpers.resend.emails.send).toHaveBeenCalledWith(expect.objectContaining({
        to: ['user@test.com'],
        subject: expect.stringContaining('verificaci'),
      }));
    });

    test('throws when resend returns error', async () => {
      helpers.resend.emails.send.mockResolvedValue({ error: { message: 'fail' } });
      await expect(helpers.sendVerificationEmail('u@t.com', '000000')).rejects.toThrow('fail');
    });

    test('throws when resend throws exception', async () => {
      helpers.resend.emails.send.mockRejectedValue(new Error('network'));
      await expect(helpers.sendVerificationEmail('u@t.com', '000000')).rejects.toThrow('network');
    });
  });

  // ── sendResetPasswordEmail ──────────────────
  describe('sendResetPasswordEmail', () => {
    test('sends reset email and returns true', async () => {
      helpers.resend.emails.send.mockResolvedValue({ id: '456' });
      const result = await helpers.sendResetPasswordEmail('u@t.com', 'https://reset.url');
      expect(result).toBe(true);
    });

    test('throws when resend returns error', async () => {
      helpers.resend.emails.send.mockResolvedValue({ error: { message: 'bad' } });
      await expect(helpers.sendResetPasswordEmail('u@t.com', 'url')).rejects.toThrow('bad');
    });

    test('throws on exception', async () => {
      helpers.resend.emails.send.mockRejectedValue(new Error('timeout'));
      await expect(helpers.sendResetPasswordEmail('u@t.com', 'url')).rejects.toThrow('timeout');
    });
  });

  // ── getPublicWebBaseUrl ─────────────────────
  describe('getPublicWebBaseUrl', () => {
    test('returns env value without trailing slash', () => {
      process.env.PUBLIC_WEB_BASE_URL = 'https://listed.com.mx///';
      expect(helpers.getPublicWebBaseUrl()).toBe('https://listed.com.mx');
    });

    test('returns empty string when not set', () => {
      delete process.env.PUBLIC_WEB_BASE_URL;
      expect(helpers.getPublicWebBaseUrl()).toBe('');
    });
  });

  // ── buildResetWebUrl ────────────────────────
  describe('buildResetWebUrl', () => {
    test('builds URL with encoded token', () => {
      process.env.PUBLIC_WEB_BASE_URL = 'https://listed.com.mx';
      const url = helpers.buildResetWebUrl('abc=123');
      expect(url).toBe('https://listed.com.mx/reset-password/?token=abc%3D123');
    });

    test('returns null when no base URL', () => {
      delete process.env.PUBLIC_WEB_BASE_URL;
      expect(helpers.buildResetWebUrl('token')).toBeNull();
    });
  });

  // ── isExpoToken ─────────────────────────────
  describe('isExpoToken', () => {
    test('returns true for valid expo token', () => {
      expect(helpers.isExpoToken('ExponentPushToken[abc123]')).toBe(true);
    });

    test('returns false for non-string', () => {
      expect(helpers.isExpoToken(123)).toBe(false);
      expect(helpers.isExpoToken(null)).toBe(false);
    });
  });

  // ── q (promisified query) ───────────────────
  describe('q', () => {
    test('resolves with rows on success', async () => {
      const mockCxn = { query: jest.fn((sql, params, cb) => cb(null, [{ id: 1 }])) };
      const rows = await helpers.q(mockCxn, 'SELECT 1', [], 'test');
      expect(rows).toEqual([{ id: 1 }]);
    });

    test('rejects with annotated error on failure', async () => {
      const mockCxn = { query: jest.fn((sql, params, cb) => cb(new Error('db fail'), null)) };
      try {
        await helpers.q(mockCxn, 'SELECT 1', [], 'step1');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err._step).toBe('step1');
        expect(err._sql).toBe('SELECT 1');
      }
    });
  });

  // ── isMutedForReceiver ──────────────────────
  describe('isMutedForReceiver', () => {
    test('resolves false when no mute rows', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) => cb(null, []));
      expect(await helpers.isMutedForReceiver(1, 2, 3)).toBe(false);
    });

    test('resolves true when muted with no expiry', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) =>
        cb(null, [{ is_muted: 1, muted_until: null }])
      );
      expect(await helpers.isMutedForReceiver(1, 2, 3)).toBe(true);
    });

    test('resolves false when muted but expired', async () => {
      const past = new Date(Date.now() - 10000).toISOString();
      mockPoolData.pool.query.mockImplementation((sql, params, cb) =>
        cb(null, [{ is_muted: 1, muted_until: past }])
      );
      expect(await helpers.isMutedForReceiver(1, 2, 3)).toBe(false);
    });

    test('resolves true when muted and not yet expired', async () => {
      const future = new Date(Date.now() + 100000).toISOString();
      mockPoolData.pool.query.mockImplementation((sql, params, cb) =>
        cb(null, [{ is_muted: 1, muted_until: future }])
      );
      expect(await helpers.isMutedForReceiver(1, 2, 3)).toBe(true);
    });

    test('resolves false when is_muted is 0', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) =>
        cb(null, [{ is_muted: 0, muted_until: null }])
      );
      expect(await helpers.isMutedForReceiver(1, 2, 3)).toBe(false);
    });

    test('rejects on db error', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) => cb(new Error('fail')));
      await expect(helpers.isMutedForReceiver(1, 2, 3)).rejects.toThrow('fail');
    });
  });

  // ── getActivePushTokens ─────────────────────
  describe('getActivePushTokens', () => {
    test('returns array of tokens', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) =>
        cb(null, [{ expo_push_token: 'tok1' }, { expo_push_token: 'tok2' }])
      );
      const tokens = await helpers.getActivePushTokens(1);
      expect(tokens).toEqual(['tok1', 'tok2']);
    });

    test('rejects on error', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) => cb(new Error('fail')));
      await expect(helpers.getActivePushTokens(1)).rejects.toThrow('fail');
    });
  });

  // ── sendPushToUser ──────────────────────────
  describe('sendPushToUser', () => {
    test('resolves false on db error', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) => cb(new Error('fail')));
      const result = await helpers.sendPushToUser({ userId: 1, title: 't', body: 'b' });
      expect(result).toBe(false);
    });

    test('resolves true when no tokens found', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) => cb(null, []));
      const result = await helpers.sendPushToUser({ userId: 1, title: 't', body: 'b' });
      expect(result).toBe(true);
    });

    test('resolves true when tokens are not valid expo tokens', async () => {
      mockPoolData.pool.query.mockImplementation((sql, params, cb) =>
        cb(null, [{ id: 1, expo_push_token: 'invalid-token' }])
      );
      const result = await helpers.sendPushToUser({ userId: 1, title: 't', body: 'b' });
      expect(result).toBe(true);
    });

    test('sends push and resolves true with valid tokens (no invalid)', async () => {
      const token = 'ExponentPushToken[abc123]';
      // First query: get tokens
      mockPoolData.pool.query.mockImplementationOnce((sql, params, cb) =>
        cb(null, [{ id: 10, expo_push_token: token }])
      );
      helpers.expo.chunkPushNotifications.mockReturnValue([
        [{ to: token }],
      ]);
      helpers.expo.sendPushNotificationsAsync.mockResolvedValue([
        { status: 'ok', id: 'receipt-1' },
      ]);
      const result = await helpers.sendPushToUser({ userId: 1, title: 't', body: 'b', data: { x: 1 } });
      expect(result).toBe(true);
    });

    test('deactivates DeviceNotRegistered tokens', async () => {
      const token = 'ExponentPushToken[abc123]';
      let callCount = 0;
      mockPoolData.pool.query.mockImplementation((sql, params, cb) => {
        callCount++;
        if (callCount === 1) {
          // First call: get tokens
          return cb(null, [{ id: 10, expo_push_token: token }]);
        }
        // Second call: deactivate tokens
        return cb(null, { affectedRows: 1 });
      });
      helpers.expo.chunkPushNotifications.mockReturnValue([
        [{ to: token }],
      ]);
      helpers.expo.sendPushNotificationsAsync.mockResolvedValue([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ]);
      const result = await helpers.sendPushToUser({ userId: 1, title: 't', body: 'b' });
      expect(result).toBe(true);
      // Second query should be the deactivation
      expect(mockPoolData.pool.query).toHaveBeenCalledTimes(2);
    });

    test('resolves false when expo.sendPushNotificationsAsync throws', async () => {
      const token = 'ExponentPushToken[abc123]';
      mockPoolData.pool.query.mockImplementationOnce((sql, params, cb) =>
        cb(null, [{ id: 10, expo_push_token: token }])
      );
      helpers.expo.chunkPushNotifications.mockReturnValue([
        [{ to: token }],
      ]);
      helpers.expo.sendPushNotificationsAsync.mockRejectedValue(new Error('expo fail'));
      const result = await helpers.sendPushToUser({ userId: 1, title: 't', body: 'b' });
      expect(result).toBe(false);
    });

    test('handles deactivation db error gracefully', async () => {
      const token = 'ExponentPushToken[abc123]';
      let callCount = 0;
      mockPoolData.pool.query.mockImplementation((sql, params, cb) => {
        callCount++;
        if (callCount === 1) return cb(null, [{ id: 10, expo_push_token: token }]);
        return cb(new Error('deactivate fail'));
      });
      helpers.expo.chunkPushNotifications.mockReturnValue([[{ to: token }]]);
      helpers.expo.sendPushNotificationsAsync.mockResolvedValue([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ]);
      const result = await helpers.sendPushToUser({ userId: 1, title: 't', body: 'b' });
      expect(result).toBe(true);
    });
  });

  // ── issueToken ──────────────────────────────
  describe('issueToken', () => {
    test('returns token, refreshToken and user data', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const res = { json: jest.fn() };
      const u = {
        id: 1, name: 'Juan', last_name: 'P', email: 'j@t.com', phone: '555',
        work_start: '09:00', work_end: '18:00', agent_type: 'individual',
        agent_verification_status: 'verified', brokerage_name: null,
        cities: '["Tijuana"]', profile_photo: 'url',
      };
      await helpers.issueToken(res, u);
      expect(jwt.sign).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        token: 'mock-jwt-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({ id: 1, is_agent: true, cities: ['Tijuana'] }),
      }));
    });

    test('handles invalid cities JSON gracefully', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const res = { json: jest.fn() };
      const u = {
        id: 1, name: 'A', last_name: 'B', email: 'a@b.com', phone: '1',
        agent_type: 'regular', cities: '{invalid json',
      };
      await helpers.issueToken(res, u);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        user: expect.objectContaining({ cities: null }),
      }));
    });
  });

  // ── generateRefreshToken ────────────────────
  describe('generateRefreshToken', () => {
    test('returns rawToken and family', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const result = await helpers.generateRefreshToken({ userId: 1, email: 'a@b.com', agentType: 'regular' });
      expect(result.rawToken).toHaveLength(64);
      expect(result.family).toBeTruthy();
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^rt:/),
        expect.any(String),
        'EX',
        expect.any(Number)
      );
    });

    test('uses provided family', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const result = await helpers.generateRefreshToken({ userId: 1, email: 'a@b.com', agentType: 'regular', family: 'my-family' });
      expect(result.family).toBe('my-family');
    });
  });

  // ── consumeRefreshToken ─────────────────────
  describe('consumeRefreshToken', () => {
    test('returns error when token not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await helpers.consumeRefreshToken('unknown-token');
      expect(result).toEqual({ error: 'invalid' });
    });

    test('returns error when family revoked', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ userId: 1, family: 'fam1', email: 'a@b.com', createdAt: Date.now() }));
      mockRedis.exists.mockResolvedValue(1);
      const result = await helpers.consumeRefreshToken('some-token');
      expect(result).toEqual({ error: 'family_revoked' });
    });

    test('returns data on valid token', async () => {
      const data = { userId: 1, family: 'fam1', email: 'a@b.com', createdAt: Date.now() };
      mockRedis.get.mockResolvedValue(JSON.stringify(data));
      mockRedis.exists.mockResolvedValue(0);
      mockRedis.del.mockResolvedValue(1);
      const result = await helpers.consumeRefreshToken('valid-token');
      expect(result.data).toMatchObject({ userId: 1, family: 'fam1' });
    });

    test('returns replay_detected when del returns 0', async () => {
      const data = { userId: 1, family: 'fam1', email: 'a@b.com', createdAt: Date.now() };
      mockRedis.get.mockResolvedValue(JSON.stringify(data));
      mockRedis.exists.mockResolvedValue(0);
      mockRedis.del.mockResolvedValue(0);
      const result = await helpers.consumeRefreshToken('replayed-token');
      expect(result).toEqual({ error: 'replay_detected' });
      expect(mockRedis.set).toHaveBeenCalledWith(
        'rt:family:fam1',
        'revoked',
        'EX',
        expect.any(Number)
      );
    });
  });

  // ── revokeRefreshToken ──────────────────────
  describe('revokeRefreshToken', () => {
    test('deletes token from redis', async () => {
      await helpers.revokeRefreshToken('some-token');
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringMatching(/^rt:/));
    });
  });

  // ── createEmailCooldown ─────────────────────
  describe('createEmailCooldown', () => {
    test('calls next when no email', async () => {
      const mw = helpers.createEmailCooldown();
      const req = { body: {} };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      await mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('calls next when email has no @', async () => {
      const mw = helpers.createEmailCooldown();
      const req = { body: { email: 'noemail' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      await mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('returns 429 when cooldown active', async () => {
      mockRedis.exists.mockResolvedValue(1);
      const mw = helpers.createEmailCooldown();
      const req = { body: { email: 'a@b.com' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      await mw(req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
    });

    test('sets cooldown and calls next when no cooldown active', async () => {
      mockRedis.exists.mockResolvedValue(0);
      const mw = helpers.createEmailCooldown({ windowMs: 5000 });
      const req = { body: { email: 'a@b.com' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      await mw(req, res, next);
      expect(mockRedis.set).toHaveBeenCalledWith('rl:emailcd:a@b.com', '1', 'PX', 5000);
      expect(next).toHaveBeenCalled();
    });

    test('returns 503 on redis error', async () => {
      mockRedis.exists.mockRejectedValue(new Error('redis down'));
      const mw = helpers.createEmailCooldown();
      const req = { body: { email: 'a@b.com' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      await mw(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
