const mockRedis = require('../../__mocks__/redisMock').createRedisMock();
jest.mock('../../db/redis', () => mockRedis);

global.fetch = jest.fn();

const { aiGenerate, aiGenerateMessages, cacheKey, getCache, setCache } = require('../../utils/ai');

describe('ai.js', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AI_ENABLED = 'true';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    // Reset rate limit counters
    mockRedis.zcard.mockResolvedValue(0);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.exists.mockResolvedValue(0);
  });

  afterAll(() => {
    process.env = origEnv;
  });

  // ── cacheKey ────────────────────────────────
  describe('cacheKey', () => {
    test('produces deterministic key', () => {
      const k1 = cacheKey('gen', { a: 1 });
      const k2 = cacheKey('gen', { a: 1 });
      expect(k1).toBe(k2);
      expect(k1).toMatch(/^ai:cache:gen:/);
    });

    test('different input produces different key', () => {
      expect(cacheKey('gen', { a: 1 })).not.toBe(cacheKey('gen', { a: 2 }));
    });

    test('different prefix produces different key', () => {
      expect(cacheKey('foo', { a: 1 })).not.toBe(cacheKey('bar', { a: 1 }));
    });
  });

  // ── getCache ────────────────────────────────
  describe('getCache', () => {
    test('returns null when no data', async () => {
      mockRedis.get.mockResolvedValue(null);
      expect(await getCache('k')).toBeNull();
    });

    test('returns parsed data', async () => {
      mockRedis.get.mockResolvedValue('"hello"');
      expect(await getCache('k')).toBe('hello');
    });

    test('returns null on redis error', async () => {
      mockRedis.get.mockRejectedValue(new Error('fail'));
      expect(await getCache('k')).toBeNull();
    });
  });

  // ── setCache ────────────────────────────────
  describe('setCache', () => {
    test('stores JSON with TTL', async () => {
      await setCache('k', { x: 1 }, 60);
      expect(mockRedis.set).toHaveBeenCalledWith('k', '{"x":1}', 'EX', 60);
    });

    test('does not throw on redis error', async () => {
      mockRedis.set.mockRejectedValue(new Error('fail'));
      await expect(setCache('k', 'v', 60)).resolves.not.toThrow();
    });
  });

  // ── aiGenerate ──────────────────────────────
  describe('aiGenerate', () => {
    function mockGeminiOk(text = 'result') {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text }] } }],
        }),
      });
    }

    function mockGroqOk(text = 'groq-result') {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: text } }],
        }),
      });
    }

    test('throws AI_DISABLED when AI_ENABLED is false', async () => {
      process.env.AI_ENABLED = 'false';
      await expect(aiGenerate('sys', 'user')).rejects.toThrow('AI_DISABLED');
    });

    test('returns Gemini result on success', async () => {
      mockGeminiOk('hello');
      const result = await aiGenerate('sys', 'user');
      expect(result).toBe('hello');
    });

    test('falls back to Groq when Gemini fails', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('err') }); // Gemini fail
      mockGroqOk('groq-answer');

      const result = await aiGenerate('sys', 'user');
      expect(result).toBe('groq-answer');
    });

    test('uses cache when cacheTTL > 0', async () => {
      mockRedis.get.mockResolvedValue('"cached-val"');
      const result = await aiGenerate('sys', 'user', { cacheTTL: 300 });
      expect(result).toBe('cached-val');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('stores result in cache when cacheTTL > 0', async () => {
      mockGeminiOk('fresh');
      await aiGenerate('sys', 'user', { cacheTTL: 300, cachePrefix: 'test' });
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('ai:cache:test:'),
        '"fresh"',
        'EX',
        300
      );
    });

    test('throws when both providers fail after retries', async () => {
      for (let i = 0; i < 6; i++) {
        global.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('err') });
      }
      await expect(aiGenerate('sys', 'user')).rejects.toThrow();
    }, 30000);

    test('falls back to Groq on Gemini rate limit', async () => {
      mockRedis.zcard.mockResolvedValue(15); // exceed GEMINI_RPM
      mockGroqOk('from-groq');
      const result = await aiGenerate('sys', 'user');
      expect(result).toBe('from-groq');
    });

    test('throws when GEMINI_API_KEY not set and Groq also fails', async () => {
      delete process.env.GEMINI_API_KEY;
      global.fetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') });
      await expect(aiGenerate('sys', 'user')).rejects.toThrow();
    }, 30000);
  });

  // ── aiGenerateMessages ──────────────────────
  describe('aiGenerateMessages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    function mockGeminiMsgOk(text = 'msg-result') {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text }] } }],
        }),
      });
    }

    function mockGroqMsgOk(text = 'groq-msg-result') {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: text } }],
        }),
      });
    }

    test('throws AI_DISABLED when disabled', async () => {
      process.env.AI_ENABLED = 'false';
      await expect(aiGenerateMessages('sys', messages)).rejects.toThrow('AI_DISABLED');
    });

    test('returns Gemini result on success', async () => {
      mockGeminiMsgOk('answer');
      const result = await aiGenerateMessages('sys', messages);
      expect(result).toBe('answer');
    });

    test('falls back to Groq on Gemini failure', async () => {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('') });
      mockGroqMsgOk('groq-answer');
      const result = await aiGenerateMessages('sys', messages);
      expect(result).toBe('groq-answer');
    });

    test('uses cache when cacheTTL > 0', async () => {
      mockRedis.get.mockResolvedValue('"cached-msg"');
      const result = await aiGenerateMessages('sys', messages, { cacheTTL: 60 });
      expect(result).toBe('cached-msg');
    });

    test('throws when both fail after retries', async () => {
      for (let i = 0; i < 6; i++) {
        global.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('') });
      }
      await expect(aiGenerateMessages('sys', messages)).rejects.toThrow();
    }, 30000);
  });
});
