import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isUnsupportedParameterError,
  formatConnectionError,
  Provider,
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

// ═══════════════════════════════════════════════════════════
// Provider.streamWithTools — streaming with tool calling
// ═══════════════════════════════════════════════════════════

function createChunkStream(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

describe('Provider.streamWithTools', () => {
  it('should stream content without tool calls', async () => {
    const stream = createChunkStream([
      { choices: [{ delta: { content: 'Hello' }, index: 0 }] },
      { choices: [{ delta: { content: ' World' }, index: 0 }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]);
    const mockClient = { chat: { completions: { async create() { return stream; } } } };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const chunks = [];
    const result = await provider.streamWithTools([{ role: 'user', content: 'hi' }], {
      maxTokens: 100, onChunk: (d) => chunks.push(d),
    });
    assert.strictEqual(result.content, 'Hello World');
    assert.strictEqual(result.tool_calls, null);
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0], 'Hello');
    assert.strictEqual(chunks[1], ' World');
  });

  it('should accumulate tool call from deltas across chunks', async () => {
    const stream = createChunkStream([
      { choices: [{ delta: { content: '核心概念是...' }, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc123', function: { name: 'ask_user_to_continue', arguments: '' } }] }, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"sum' } }] }, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mary":"第一部分"}' } }] }, index: 0 }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } },
    ]);
    const mockClient = { chat: { completions: { async create() { return stream; } } } };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    let toolCallsResult = null;
    const result = await provider.streamWithTools([{ role: 'user', content: 'test' }], {
      maxTokens: 100,
      tools: [{ type: 'function', function: { name: 'ask_user_to_continue' } }],
      onToolCall: (tcs) => { toolCallsResult = tcs; },
    });
    assert.strictEqual(result.content, '核心概念是...');
    assert.ok(result.tool_calls);
    assert.strictEqual(result.tool_calls.length, 1);
    assert.strictEqual(result.tool_calls[0].id, 'call_abc123');
    assert.strictEqual(result.tool_calls[0].function.name, 'ask_user_to_continue');
    assert.strictEqual(result.tool_calls[0].function.arguments, '{"summary":"第一部分"}');
    assert.deepStrictEqual(toolCallsResult, result.tool_calls);
  });

  it('should handle tool call without preceding content', async () => {
    const stream = createChunkStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_empty', function: { name: 'ask_user_to_continue', arguments: '{}' } }] }, index: 0 }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]);
    const mockClient = { chat: { completions: { async create() { return stream; } } } };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.streamWithTools([{ role: 'user', content: 'test' }], {
      tools: [{ type: 'function', function: { name: 'ask_user_to_continue' } }],
    });
    assert.strictEqual(result.content, '');
    assert.ok(result.tool_calls);
    assert.strictEqual(result.tool_calls[0].function.arguments, '{}');
  });

  it('should handle finish_reason=stop without tool calls', async () => {
    const stream = createChunkStream([
      { choices: [{ delta: { content: 'done' }, index: 0 }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] },
    ]);
    const mockClient = { chat: { completions: { async create() { return stream; } } } };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.streamWithTools([{ role: 'user', content: 'test' }], {
      tools: [{ type: 'function', function: { name: 'x' } }],
    });
    assert.strictEqual(result.content, 'done');
    assert.strictEqual(result.tool_calls, null);
  });

  it('should handle empty stream gracefully', async () => {
    const stream = createChunkStream([]);
    const mockClient = { chat: { completions: { async create() { return stream; } } } };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.streamWithTools([{ role: 'user', content: 'test' }]);
    assert.strictEqual(result.content, '');
    assert.strictEqual(result.tool_calls, null);
  });

  it('should retry on stream_options failure (relay fallback)', async () => {
    let callCount = 0;
    const mockClient = {
      chat: { completions: { async create(opts) {
        callCount++;
        if (callCount === 1) {
          const err = new Error("'stream_options' is not supported");
          err.status = 400;
          throw err;
        }
        return createChunkStream([
          { choices: [{ delta: { content: 'fallback ok' }, index: 0 }] },
          { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] },
        ]);
      } } },
    };
    const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
    provider._client = mockClient;
    provider._autoWarm = false;

    const result = await provider.streamWithTools([{ role: 'user', content: 'test' }]);
    assert.strictEqual(result.content, 'fallback ok');
    assert.strictEqual(callCount, 2);
  });
});
