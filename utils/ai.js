/**
 * AI utility — dual-provider wrapper (Gemini primary, Groq fallback).
 * Zero npm dependencies added — uses Node 18+ native fetch.
 */

const crypto = require('crypto');
const redis  = require('../db/redis');

// ── Config ──────────────────────────────────────────────────────────────────────
const GEMINI_URL   = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_KEY   = () => process.env.GEMINI_API_KEY;
const GROQ_KEY     = () => process.env.GROQ_API_KEY;
const AI_ENABLED   = () => process.env.AI_ENABLED !== 'false';

const TIMEOUT_MS   = 15_000;
const MAX_RETRIES  = 2;

// ── Rate-limit constants (Gemini free tier) ─────────────────────────────────────
const GEMINI_RPM        = 14;   // leave 1 headroom from 15
const GEMINI_RPD        = 1400; // leave 100 headroom from 1500
const RL_MINUTE_KEY     = 'ai:rl:gemini:min';
const RL_DAY_KEY        = 'ai:rl:gemini:day';

// ── Helpers ─────────────────────────────────────────────────────────────────────
function cacheKey(prefix, input) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `ai:cache:${prefix}:${hash}`;
}

async function getCache(key) {
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function setCache(key, data, ttlSeconds) {
  try {
    await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  } catch { /* cache miss is not critical */ }
}

// ── Sliding-window rate limiter (per-minute + daily) ────────────────────────────
async function checkGeminiRateLimit() {
  try {
    const now = Date.now();

    // Per-minute: sorted set with timestamps, expire entries older than 60s
    const minKey = RL_MINUTE_KEY;
    await redis.zremrangebyscore(minKey, 0, now - 60_000);
    const minuteCount = await redis.zcard(minKey);
    if (minuteCount >= GEMINI_RPM) return false;

    // Per-day: simple counter with TTL
    const dayKey = RL_DAY_KEY;
    const dayCount = parseInt(await redis.get(dayKey) || '0', 10);
    if (dayCount >= GEMINI_RPD) return false;

    return true;
  } catch {
    return true; // on Redis error, allow the request
  }
}

async function recordGeminiRequest() {
  try {
    const now = Date.now();
    await redis.zadd(RL_MINUTE_KEY, now, `${now}:${Math.random()}`);
    await redis.expire(RL_MINUTE_KEY, 120);

    const dayKey = RL_DAY_KEY;
    const exists = await redis.exists(dayKey);
    await redis.incr(dayKey);
    if (!exists) {
      // Expire at end of current UTC day
      const nowDate = new Date();
      const endOfDay = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1));
      const ttl = Math.ceil((endOfDay.getTime() - nowDate.getTime()) / 1000);
      await redis.expire(dayKey, ttl);
    }
  } catch { /* non-critical */ }
}

// ── Fetch with timeout ──────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Gemini call ─────────────────────────────────────────────────────────────────
async function callGemini(systemPrompt, userPrompt) {
  const key = GEMINI_KEY();
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const withinLimit = await checkGeminiRateLimit();
  if (!withinLimit) throw new Error('GEMINI_RATE_LIMITED');

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };

  const res = await fetchWithTimeout(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const status = res.status;
    if (status === 429) throw new Error('GEMINI_RATE_LIMITED');
    throw new Error(`Gemini HTTP ${status}`);
  }

  await recordGeminiRequest();

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text.trim();
}

// ── Groq call (OpenAI-compatible) ───────────────────────────────────────────────
async function callGroq(systemPrompt, userPrompt) {
  const key = GROQ_KEY();
  if (!key) throw new Error('GROQ_API_KEY not configured');

  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 1024,
  };

  const res = await fetchWithTimeout(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty response');
  return text.trim();
}

// ── Groq call with messages array (for assistant with history) ──────────────────
async function callGroqMessages(systemPrompt, messages) {
  const key = GROQ_KEY();
  if (!key) throw new Error('GROQ_API_KEY not configured');

  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    temperature: 0.7,
    max_tokens: 1024,
  };

  const res = await fetchWithTimeout(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty response');
  return text.trim();
}

// ── Gemini call with messages array (for assistant with history) ─────────────────
async function callGeminiMessages(systemPrompt, messages) {
  const key = GEMINI_KEY();
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const withinLimit = await checkGeminiRateLimit();
  if (!withinLimit) throw new Error('GEMINI_RATE_LIMITED');

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };

  const res = await fetchWithTimeout(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error('GEMINI_RATE_LIMITED');
    throw new Error(`Gemini HTTP ${res.status}`);
  }

  await recordGeminiRequest();

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text.trim();
}

// ── Main dual-provider call (simple prompt) ─────────────────────────────────────
async function aiGenerate(systemPrompt, userPrompt, { cacheTTL = 0, cachePrefix = 'gen' } = {}) {
  if (!AI_ENABLED()) throw new Error('AI_DISABLED');

  // Check cache
  if (cacheTTL > 0) {
    const key = cacheKey(cachePrefix, { systemPrompt, userPrompt });
    const cached = await getCache(key);
    if (cached) return cached;
  }

  let lastError;

  // Attempt with retry
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Try Gemini
    try {
      const result = await callGemini(systemPrompt, userPrompt);
      if (cacheTTL > 0) {
        const key = cacheKey(cachePrefix, { systemPrompt, userPrompt });
        await setCache(key, result, cacheTTL);
      }
      return result;
    } catch (err) {
      lastError = err;
      // On rate limit or server error, fall through to Groq
    }

    // Try Groq as fallback
    try {
      const result = await callGroq(systemPrompt, userPrompt);
      if (cacheTTL > 0) {
        const key = cacheKey(cachePrefix, { systemPrompt, userPrompt });
        await setCache(key, result, cacheTTL);
      }
      return result;
    } catch (err) {
      lastError = err;
    }

    // Exponential backoff before retry
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }

  throw lastError || new Error('AI generation failed');
}

// ── Main dual-provider call (messages array for assistant) ──────────────────────
async function aiGenerateMessages(systemPrompt, messages, { cacheTTL = 0, cachePrefix = 'gen' } = {}) {
  if (!AI_ENABLED()) throw new Error('AI_DISABLED');

  if (cacheTTL > 0) {
    const key = cacheKey(cachePrefix, { systemPrompt, messages });
    const cached = await getCache(key);
    if (cached) return cached;
  }

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callGeminiMessages(systemPrompt, messages);
      if (cacheTTL > 0) {
        const key = cacheKey(cachePrefix, { systemPrompt, messages });
        await setCache(key, result, cacheTTL);
      }
      return result;
    } catch (err) {
      lastError = err;
    }

    try {
      const result = await callGroqMessages(systemPrompt, messages);
      if (cacheTTL > 0) {
        const key = cacheKey(cachePrefix, { systemPrompt, messages });
        await setCache(key, result, cacheTTL);
      }
      return result;
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }

  throw lastError || new Error('AI generation failed');
}

module.exports = { aiGenerate, aiGenerateMessages, cacheKey, getCache, setCache };
