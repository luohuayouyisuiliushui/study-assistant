import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isUnsupportedParameterError,
  formatConnectionError,
  Provider,
  sha256,
  computePrefixHash,
  computeTailHash,
  computeRequestHash,
  extractUsage,
  assessPrefixStability,
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

describe('Provider.stream transient failures', () => {
  it('should retry an upstream HTTP/2 stream failure', async () => {
    let attempts = 0;
    let observedContent = '';
    const mockClient = {
      chat: {
        completions: {
          async create() {
            attempts++;
            if (attempts === 1) {
              return {
                async *[Symbol.asyncIterator]() {
                  yield { choices: [{ delta: { content: '半截讲解' } }] };
                  throw new Error('Upstream HTTP/2 stream failed');
                },
              };
            }
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: '讲解成功' } }] };
              },
            };
          },
        },
      },
    };
    const provider = new Provider({
      apiKey: 'test-key',
      baseURL: 'https://test.api/v1',
      model: 'test-model',
    });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.stream(
      [{ role: 'user', content: '请生成讲解' }],
      {
        streamOptions: false,
        onChunk: (delta) => { observedContent += delta; },
        onReset: () => { observedContent = ''; },
      }
    );

    assert.strictEqual(result, '讲解成功');
    assert.strictEqual(observedContent, '讲解成功');
    assert.strictEqual(attempts, 2);
  });

  it('should continue when the model reaches its output token limit', async () => {
    const requests = [];
    let observedContent = '';
    const mockClient = {
      chat: {
        completions: {
          async create(request) {
            requests.push(request);
            const isContinuation = requests.length === 2;
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [{
                    delta: { content: isContinuation ? '并完成剩余内容。' : '第一部分讲解，' },
                    finish_reason: null,
                  }],
                };
                yield {
                  choices: [{
                    delta: {},
                    finish_reason: isContinuation ? 'stop' : 'length',
                  }],
                };
              },
            };
          },
        },
      },
    };
    const provider = new Provider({
      apiKey: 'test-key',
      baseURL: 'https://test.api/v1',
      model: 'test-model',
      fallbackModels: [],
    });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.stream(
      [{ role: 'user', content: '请生成完整讲解' }],
      {
        streamOptions: false,
        onChunk: (delta) => { observedContent += delta; },
      }
    );

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[1].messages.at(-2).role, 'assistant');
    assert.strictEqual(requests[1].messages.at(-2).content, '第一部分讲解，');
    assert.match(requests[1].messages.at(-1).content, /继续/);
    assert.strictEqual(result, '第一部分讲解，并完成剩余内容。');
    assert.strictEqual(observedContent, result);
  });

  it('should fail explicitly when continuation attempts also reach the token limit', async () => {
    let attempts = 0;
    const mockClient = {
      chat: {
        completions: {
          async create() {
            attempts++;
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [{ delta: { content: `第${attempts}段` }, finish_reason: null }],
                };
                yield {
                  choices: [{ delta: {}, finish_reason: 'length' }],
                };
              },
            };
          },
        },
      },
    };
    const provider = new Provider({
      apiKey: 'test-key',
      baseURL: 'https://test.api/v1',
      model: 'test-model',
      fallbackModels: [],
    });
    provider._client = mockClient;
    provider._autoWarm = false;

    await assert.rejects(
      provider.stream(
        [{ role: 'user', content: '请生成完整讲解' }],
        { streamOptions: false, maxContinuations: 2 }
      ),
      /自动续写后仍未完成/
    );

    assert.strictEqual(attempts, 3);
  });
});

describe('Provider.complete request options', () => {
  it('preserves the custom timeout when retrying without response_format', async () => {
    const requests = [];
    const mockClient = {
      chat: {
        completions: {
          async create(request, options) {
            requests.push({ request, options });
            if (requests.length === 1) {
              throw new Error('response_format is not supported by this model');
            }
            return {
              choices: [{ message: { content: '{}', role: 'assistant' }, finish_reason: 'stop' }],
              usage: {},
            };
          },
        },
      },
    };
    const provider = new Provider({
      apiKey: 'test-key',
      baseURL: 'https://test.api/v1',
      model: 'test-model',
      fallbackModels: [],
    });
    provider._client = mockClient;
    provider._autoWarm = false;

    await provider.complete(
      [{ role: 'user', content: '返回一个空 JSON 对象' }],
      { responseFormat: { type: 'json_object' }, timeoutMs: 120_000 }
    );

    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(requests[0].options, { timeout: 120_000 });
    assert.deepStrictEqual(requests[1].options, { timeout: 120_000 });
    assert.ok(requests[0].request.response_format);
    assert.ok(!requests[1].request.response_format);
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
