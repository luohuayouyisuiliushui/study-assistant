import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isUnsupportedParameterError,
  formatConnectionError,
  Provider,
  DiskPrefixCache,
  sha256,
  computePrefixHash,
  computeTailHash,
  computeRequestHash,
  extractUsage,
  assessPrefixStability,
  encodeForRelay,
} from '../engine/provider.js';

// ═══════════════════════════════════════════════════════════
// isUnsupportedParameterError — detects relay-unsupported params
// ═══════════════════════════════════════════════════════════

describe('isUnsupportedParameterError', () => {
  it('should detect "param" is not supported error', () => {
    const err = new Error('response_format is not supported by this model');
    assert.strictEqual(isUnsupportedParameterError(err, 'response_format'), true);
  });

  it('should detect unsupported parameter error', () => {
    const err = new Error('unsupported parameter: stream_options');
    assert.strictEqual(isUnsupportedParameterError(err, 'stream_options'), true);
  });

  it('should detect unknown parameter error', () => {
    const err = new Error('unknown parameter "response_format"');
    assert.strictEqual(isUnsupportedParameterError(err, 'response_format'), true);
  });

  it('should detect invalid parameter error', () => {
    const err = new Error('invalid parameter: temperature');
    assert.strictEqual(isUnsupportedParameterError(err, 'temperature'), true);
  });

  it('should detect single-quoted param name', () => {
    const err = new Error("'response_format' is not a valid parameter");
    assert.strictEqual(isUnsupportedParameterError(err, 'response_format'), true);
  });

  it('should detect double-quoted param name', () => {
    const err = new Error('"stream_options" is not supported');
    assert.strictEqual(isUnsupportedParameterError(err, 'stream_options'), true);
  });

  it('should detect generic "not supported" message', () => {
    const err = new Error('This API does not support response_format');
    assert.strictEqual(isUnsupportedParameterError(err, 'response_format'), true);
  });

  it('should return false for unrelated errors', () => {
    const err = new Error('rate limit exceeded');
    assert.strictEqual(isUnsupportedParameterError(err, 'response_format'), false);
  });

  it('should return false for null/undefined error', () => {
    assert.strictEqual(isUnsupportedParameterError(null, 'response_format'), false);
    assert.strictEqual(isUnsupportedParameterError(undefined, 'stream_options'), false);
  });

  it('should be case-insensitive', () => {
    const err = new Error('RESPONSE_FORMAT Is Not Supported');
    assert.strictEqual(isUnsupportedParameterError(err, 'response_format'), true);
  });
});

// ═══════════════════════════════════════════════════════════
// formatConnectionError — user-friendly Chinese error messages
// ═══════════════════════════════════════════════════════════

describe('formatConnectionError', () => {
  it('should return 401 error message', () => {
    const err = { status: 401, message: 'Unauthorized' };
    const result = formatConnectionError(err, 'https://api.openai.com/v1', 'gpt-4o');
    assert.ok(result.includes('401'));
    assert.ok(result.includes('API Key'));
  });

  it('should return 403 error message with model name', () => {
    const err = { status: 403, message: 'Forbidden' };
    const result = formatConnectionError(err, 'https://api.openai.com/v1', 'gpt-4o');
    assert.ok(result.includes('403'));
    assert.ok(result.includes('gpt-4o'));
  });

  it('should return 404 error message suggesting /v1 suffix', () => {
    const err = { status: 404, message: 'Not Found' };
    const result = formatConnectionError(err, 'https://api.openai.com', 'gpt-4o');
    assert.ok(result.includes('404'));
    assert.ok(result.includes('/v1'));
  });

  it('should return 404 error message for /v1 URLs', () => {
    const err = { status: 404, message: 'Not Found' };
    const result = formatConnectionError(err, 'https://api.openai.com/v1', 'gpt-4o');
    assert.ok(result.includes('404'));
    assert.ok(result.includes('模型名称'));
  });

  it('should return 429 rate limit message', () => {
    const err = { status: 429, message: 'Too Many Requests' };
    const result = formatConnectionError(err, '', '');
    assert.ok(result.includes('429'));
  });

  it('should return 500 server error message', () => {
    const err = { status: 500, message: 'Internal Server Error' };
    const result = formatConnectionError(err, '', '');
    assert.ok(result.includes('500'));
    assert.ok(result.includes('中转站'));
  });

  it('should detect ECONNREFUSED', () => {
    const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' };
    const result = formatConnectionError(err, 'https://bad.url/v1', 'gpt-4o');
    assert.ok(result.includes('无法连接'));
  });

  it('should detect ENOTFOUND', () => {
    const err = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' };
    const result = formatConnectionError(err, 'https://nonexistent.example.com/v1', 'gpt-4o');
    assert.ok(result.includes('域名解析失败'));
  });

  it('should detect ECONNRESET', () => {
    const err = { code: 'ECONNRESET', message: 'read ECONNRESET' };
    const result = formatConnectionError(err, 'https://api.openai.com/v1', 'gpt-4o');
    assert.ok(result.includes('连接被重置'));
  });

  it('should detect timeout errors', () => {
    const err = { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' };
    const result = formatConnectionError(err, 'https://slow.api/v1', 'gpt-4o');
    assert.ok(result.includes('超时'));
  });

  it('should detect "incorrect api key" message', () => {
    const err = { message: 'Incorrect API key provided' };
    const result = formatConnectionError(err, '', '');
    assert.ok(result.includes('不正确'));
  });

  it('should detect insufficient quota', () => {
    const err = { message: 'insufficient_quota' };
    const result = formatConnectionError(err, '', '');
    assert.ok(result.includes('额度不足'));
  });

  it('should detect model not found', () => {
    const err = { message: 'model not found: deepseek-v4-pro' };
    const result = formatConnectionError(err, '', 'deepseek-v4-pro');
    assert.ok(result.includes('不存在'));
    assert.ok(result.includes('deepseek-v4-pro'));
  });

  it('should detect balance related errors', () => {
    const err = { message: 'current quota exceeded' };
    const result = formatConnectionError(err, '', '');
    assert.ok(result.includes('额度不足'));
  });

  it('should detect auth errors', () => {
    const err = { message: 'Authentication failed' };
    const result = formatConnectionError(err, '', '');
    assert.ok(result.includes('认证失败'));
  });

  it('should fallback to raw error message', () => {
    const err = { message: 'Some unknown error occurred' };
    const result = formatConnectionError(err, '', '');
    assert.strictEqual(result, 'Some unknown error occurred');
  });

  it('should handle empty/null error', () => {
    const err = {};
    const result = formatConnectionError(err, '', '');
    // Empty message, should return undefined message or similar
    assert.ok(typeof result === 'string');
  });
});

// ═══════════════════════════════════════════════════════════
// Provider.testConnection — minimal API connection test
// ═══════════════════════════════════════════════════════════

describe('Provider.testConnection', () => {
  it('should return ok=true when client responds', async () => {
    const mockClient = {
      chat: {
        completions: {
          async create(opts) {
            assert.strictEqual(opts.max_tokens, 1);
            assert.strictEqual(opts.temperature, 0);
            assert.ok(Array.isArray(opts.messages));
            return { model: 'mock-model-v2', choices: [] };
          },
        },
      },
    };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.testConnection();
    assert.deepStrictEqual(result, { ok: true, model: 'mock-model-v2' });
  });

  it('should return ok=true with default model when resp.model is absent', async () => {
    const mockClient = {
      chat: {
        completions: {
          async create() {
            return { choices: [] };
          },
        },
      },
    };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'fallback-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.testConnection();
    assert.deepStrictEqual(result, { ok: true, model: 'fallback-model' });
  });

  it('should return ok=false with formatted error on failure', async () => {
    const apiError = Object.assign(new Error('Incorrect API key'), { status: 401 });
    const mockClient = {
      chat: {
        completions: {
          async create() { throw apiError; },
        },
      },
    };
    const provider = new Provider({ apiKey: 'bad-key', baseURL: 'https://test.api/v1', model: 'gpt-4o' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.testConnection();
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('API Key'));
  });

  it('should handle network errors gracefully', async () => {
    const netError = new Error('connect ECONNREFUSED 1.2.3.4:443');
    netError.code = 'ECONNREFUSED';
    const mockClient = {
      chat: {
        completions: {
          async create() { throw netError; },
        },
      },
    };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://bad.url/v1', model: 'gpt-4o' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.testConnection();
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('无法连接'));
  });
});

// ═══════════════════════════════════════════════════════
//  Hash function tests (gap coverage)
// ═══════════════════════════════════════════════════════

describe('sha256', () => {
  it('should produce consistent 64-char hex hash', () => {
    const hash1 = sha256('hello');
    const hash2 = sha256('hello');
    const hash3 = sha256('world');
    assert.strictEqual(hash1, hash2);
    assert.notStrictEqual(hash1, hash3);
    assert.strictEqual(hash1.length, 64);
    assert.ok(/^[a-f0-9]+$/.test(hash1));
  });

  it('should handle empty string and unicode', () => {
    assert.strictEqual(sha256('').length, 64);
    assert.strictEqual(sha256('你好世界').length, 64);
  });
});

describe('computePrefixHash', () => {
  it('should produce stable hash for same messages', () => {
    const messages = [{ role: 'system', content: 'test' }];
    assert.strictEqual(computePrefixHash('gpt-4o', messages), computePrefixHash('gpt-4o', messages));
  });

  it('should differ for different models', () => {
    const messages = [{ role: 'system', content: 'test' }];
    assert.notStrictEqual(computePrefixHash('gpt-4o', messages), computePrefixHash('gpt-3.5', messages));
  });

  it('should handle empty messages', () => {
    assert.strictEqual(computePrefixHash('gpt-4o', []).length, 64);
  });
});

describe('computeTailHash', () => {
  it('should differ when last message changes', () => {
    const base = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'fixed' },
      { role: 'user', content: 'A' },
    ];
    const changed = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'fixed' },
      { role: 'user', content: 'B' },
    ];
    assert.notStrictEqual(computeTailHash(base), computeTailHash(changed));
  });

  it('should return __notail__ when no tail exists', () => {
    const msgs = [{ role: 'user', content: 'only' }];
    assert.strictEqual(computeTailHash(msgs), '__notail__');
  });
});

describe('computeRequestHash', () => {
  it('should differ for different models or options', () => {
    const msg = [{ role: 'user', content: 'hi' }];
    assert.notStrictEqual(computeRequestHash('m1', msg, { temperature: 0.7 }), computeRequestHash('m2', msg, { temperature: 0.7 }));
    assert.notStrictEqual(computeRequestHash('m', msg, { temperature: 0.7 }), computeRequestHash('m', msg, { temperature: 0.3 }));
  });
});

describe('extractUsage', () => {
  it('should extract usage from standard API response', () => {
    const u = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    assert.strictEqual(u.promptTokens, 10);
    assert.strictEqual(u.completionTokens, 20);
    assert.strictEqual(u.totalTokens, 30);
  });

  it('should return zeros when usage absent', () => {
    const u = extractUsage({});
    assert.strictEqual(u.promptTokens, 0);
  });
});

describe('assessPrefixStability', () => {
  it('should return score between 0 and 100', () => {
    const r = assessPrefixStability([{ role: 'system', content: '这是一个足够长的系统提示词，用于测试稳定性评分功能。它应该超过100个字符以确保不会被判定为过短的提示词。' }, { role: 'user', content: '变化' }]);
    assert.ok(typeof r.score === 'number');
    assert.ok(r.score >= 0);
    assert.ok(typeof r.verdict === 'string');
    assert.ok(Array.isArray(r.issues));
  });

  it('should return a valid score for empty messages', () => {
    const r = assessPrefixStability([]);
    assert.ok(r.score === undefined || r.score >= 0);
  });
});

// ═══════════════════════════════════════════════════════════
// encodeForRelay — WAF-safe encoding for relay compatibility
// ═══════════════════════════════════════════════════════════

describe('encodeForRelay', () => {
  it('should replace angle brackets with fullwidth homoglyphs', () => {
    assert.strictEqual(encodeForRelay('<div>'), '＜div＞');
  });

  it('should replace single and double quotes with fullwidth homoglyphs', () => {
    assert.strictEqual(encodeForRelay("don't say \"hi\""), 'don＇t say ＂hi＂');
  });

  it('should leave non-triggering characters untouched', () => {
    assert.strictEqual(encodeForRelay('plain text 123 中文'), 'plain text 123 中文');
  });

  it('should handle empty string', () => {
    assert.strictEqual(encodeForRelay(''), '');
  });

  it('should handle strings with no trigger characters', () => {
    assert.strictEqual(encodeForRelay('hello world'), 'hello world');
  });

  it('should replace all occurrences in a code block', () => {
    const code = "if (a < b && b > c) { console.log('hit'); }";
    const expected = "if (a ＜ b && b ＞ c) { console.log(＇hit＇); }";
    assert.strictEqual(encodeForRelay(code), expected);
  });

  it('should be idempotent (no double-replacement of fullwidth chars)', () => {
    // Fullwidth chars ＜＞＇＂ are not in the trigger set, so encoding again
    // should not change the result.
    const once = encodeForRelay('<a href="x">');
    const twice = encodeForRelay(once);
    assert.strictEqual(once, twice);
  });
});

// ═══════════════════════════════════════════════════════════
// H-3: AbortSignal forwarding — cancelled requests must not consume tokens
// ═══════════════════════════════════════════════════════════

describe('Provider AbortSignal forwarding (H-3)', () => {
  function makeMockProvider(createImpl) {
    const mockClient = {
      chat: { completions: { create: createImpl } },
    };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;
    return provider;
  }

  it('complete() forwards opts.signal to the underlying SDK client', async () => {
    const ac = new AbortController();
    let receivedSignal = null;
    const provider = makeMockProvider(async (opts) => {
      receivedSignal = opts.signal || null;
      return {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });

    await provider.complete([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    assert.strictEqual(receivedSignal, ac.signal, 'complete() must forward signal to client.chat.completions.create');
  });

  it('complete() rethrows when the SDK observes an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    let createCalled = false;
    const provider = makeMockProvider(async () => {
      return { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: {} };
    });

    // The SDK would normally throw an AbortError when signal is aborted; we
    // simulate that by having create throw when signal.aborted is true.
    const originalCreate = provider._client.chat.completions.create;
    provider._client.chat.completions.create = async (opts) => {
      createCalled = true;
      if (opts.signal?.aborted) {
        const err = new Error('Request aborted');
        err.name = 'AbortError';
        throw err;
      }
      return originalCreate(opts);
    };

    // Use a unique message to avoid the module-level response cache from
    // earlier tests in this file.
    await assert.rejects(
      () => provider.complete([{ role: 'user', content: 'aborted-' + Date.now() }], { signal: ac.signal }),
      (err) => err.message.includes('aborted') || err.name === 'AbortError',
    );
    // The SDK receives the signal and rejects before producing a response.
    assert.ok(createCalled, 'create() must be called so the signal is forwarded to the SDK');
  });

  it('stream() forwards opts.signal to the underlying SDK client', async () => {
    const ac = new AbortController();
    let receivedSignal = null;
    const provider = makeMockProvider(async (opts) => {
      receivedSignal = opts.signal || null;
      // Return an empty async iterable to let stream() finish cleanly.
      return (async function* () { /* no chunks */ })();
    });

    await provider.stream([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    assert.strictEqual(receivedSignal, ac.signal, 'stream() must forward signal to client.chat.completions.create');
  });

  it('stream() throws "Stream aborted by client" when signal aborts mid-stream', async () => {
    const ac = new AbortController();
    const chunks = [];
    const provider = makeMockProvider(async () => {
      // Yield one chunk, then abort the signal, then yield another.
      return (async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
        ac.abort();
        yield { choices: [{ delta: { content: 'after-abort' } }] };
      })();
    });

    await assert.rejects(
      () => provider.stream([{ role: 'user', content: 'hi' }], {
        signal: ac.signal,
        onChunk: chunk => chunks.push(chunk),
      }),
      /Stream aborted by client/,
    );
    assert.deepStrictEqual(chunks, ['partial'], 'no chunks should be delivered after abort');
  });

  it('streamWithTools() forwards opts.signal to the underlying SDK client', async () => {
    const ac = new AbortController();
    let receivedSignal = null;
    const provider = makeMockProvider(async (opts) => {
      receivedSignal = opts.signal || null;
      return (async function* () { /* no chunks */ })();
    });

    await provider.streamWithTools([{ role: 'user', content: 'tools' }], {
      signal: ac.signal,
      tools: [],
    });
    assert.strictEqual(receivedSignal, ac.signal, 'streamWithTools() must forward signal to the SDK');
  });
});

// ═══════════════════════════════════════════════════════════
// M-1: DiskPrefixCache.flush — EPERM fallback to copy + unlink
// ═══════════════════════════════════════════════════════════

describe('DiskPrefixCache.flush EPERM fallback (M-1)', () => {
  it('falls back to copy + unlink when renameSync throws EPERM, and resets _dirty', () => {
    // Use a unique temp file for this test.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskcache-eperm-'));
    const cachePath = path.join(tmpDir, 'cache.json');
    try {
      const cache = new DiskPrefixCache(cachePath, 100);
      // Mark an entry so _dirty becomes true.
      cache.markSeen('prefix-key-1', 'mock-model');
      assert.strictEqual(cache._dirty, true, 'markSeen should set _dirty=true');

      // Monkey-patch fs.renameSync to simulate Windows EPERM.
      const realRenameSync = fs.renameSync;
      const realCopyFileSync = fs.copyFileSync;
      const realUnlinkSync = fs.unlinkSync;
      let renameAttempted = false;
      let copyAttempted = false;
      let unlinkAttempted = false;
      fs.renameSync = function () {
        renameAttempted = true;
        const err = new Error('operation not permitted, rename');
        err.code = 'EPERM';
        throw err;
      };
      fs.copyFileSync = function (...args) {
        copyAttempted = true;
        return realCopyFileSync.apply(fs, args);
      };
      fs.unlinkSync = function (...args) {
        unlinkAttempted = true;
        return realUnlinkSync.apply(fs, args);
      };

      try {
        cache.flush();
      } finally {
        // Restore fs methods.
        fs.renameSync = realRenameSync;
        fs.copyFileSync = realCopyFileSync;
        fs.unlinkSync = realUnlinkSync;
      }

      // Verify the EPERM path was taken.
      assert.ok(renameAttempted, 'renameSync must be attempted first');
      assert.ok(copyAttempted, 'copyFileSync fallback must be triggered when rename throws EPERM');
      assert.ok(unlinkAttempted, 'unlinkSync must clean up the tmp file after copy fallback');

      // Verify _dirty was reset despite rename failure.
      assert.strictEqual(cache._dirty, false, '_dirty must be reset after successful copy fallback');

      // Verify the cache file was actually written (copy succeeded).
      assert.ok(fs.existsSync(cachePath), 'cache file must exist at the target path after copy fallback');
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const entries = JSON.parse(raw);
      assert.ok(Array.isArray(entries), 'written cache file must contain a JSON array');
      assert.strictEqual(entries.length, 1, 'exactly one entry should be persisted');
      assert.strictEqual(entries[0].key, 'prefix-key-1', 'the persisted key must match what was marked');
    } finally {
      // Clean up temp dir.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('does not throw when both rename and copy fallback fail (best-effort cleanup)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskcache-both-fail-'));
    const cachePath = path.join(tmpDir, 'cache.json');
    try {
      const cache = new DiskPrefixCache(cachePath, 100);
      cache.markSeen('prefix-key-2', 'mock-model');

      const realRenameSync = fs.renameSync;
      const realCopyFileSync = fs.copyFileSync;
      fs.renameSync = function () {
        const err = new Error('operation not permitted, rename');
        err.code = 'EPERM';
        throw err;
      };
      fs.copyFileSync = function () {
        throw new Error('copy failed (simulated)');
      };

      let threw = false;
      try {
        cache.flush();
      } catch {
        threw = true;
      } finally {
        fs.renameSync = realRenameSync;
        fs.copyFileSync = realCopyFileSync;
      }
      assert.strictEqual(threw, false, 'flush must not throw even when both rename and copy fail (best-effort)');
      // _dirty remains true because neither write succeeded.
      assert.strictEqual(cache._dirty, true, '_dirty must remain true when no write path succeeded');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
