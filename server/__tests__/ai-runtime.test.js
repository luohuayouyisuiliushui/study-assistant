import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAIInvocationFromRequest } from '../engine/ai-runtime.js';


function request({ headers = {}, body = {} } = {}) {
  return { headers, body };
}

test('AI invocation resolves header then body then environment configuration', () => {
  const environment = {
    OPENAI_API_KEY: 'env-key',
    OPENAI_BASE_URL: 'https://env.invalid/v1',
    OPENAI_MODEL: 'env-model',
  };
  const bodyInvocation = createAIInvocationFromRequest(
    request({
      body: {
        apiKey: 'body-key',
        baseURL: 'https://body.invalid/v1',
        model: 'body-model',
      },
    }),
    { environment },
  );
  assert.equal(bodyInvocation.provider._apiKey, 'body-key');
  assert.equal(bodyInvocation.provider._baseURL, 'https://body.invalid/v1');
  assert.equal(bodyInvocation.model, 'body-model');

  const headerInvocation = createAIInvocationFromRequest(
    request({
      headers: {
        'x-api-key': 'header-key',
        'x-api-base': 'https://header.invalid/v1',
        'x-api-model': 'header-model',
      },
      body: {
        apiKey: 'body-key',
        baseURL: 'https://body.invalid/v1',
        model: 'body-model',
      },
    }),
    { environment },
  );
  assert.equal(headerInvocation.provider._apiKey, 'header-key');
  assert.equal(headerInvocation.provider._baseURL, 'https://header.invalid/v1');
  assert.equal(headerInvocation.model, 'header-model');

  const environmentInvocation = createAIInvocationFromRequest(request(), { environment });
  assert.equal(environmentInvocation.provider._apiKey, 'env-key');
  assert.equal(environmentInvocation.provider._baseURL, 'https://env.invalid/v1');
  assert.equal(environmentInvocation.model, 'env-model');
});

test('AI invocation rotates key pools and reuses providers by resolved config', () => {
  const req = request({ headers: { 'x-api-key': 'runtime-pool-a,runtime-pool-b' } });

  const first = createAIInvocationFromRequest(req);
  const second = createAIInvocationFromRequest(req);
  const third = createAIInvocationFromRequest(req);

  assert.equal(first.provider._apiKey, 'runtime-pool-a');
  assert.equal(second.provider._apiKey, 'runtime-pool-b');
  assert.strictEqual(third.provider, first.provider);
});

test('AI invocation runs direct operations with its provider and model', async () => {
  const invocation = createAIInvocationFromRequest(
    request({ headers: { 'x-api-key': 'direct-key', 'x-api-model': 'direct-model' } }),
  );

  const result = await invocation.run('analysis', async (provider, model) => ({
    provider,
    model,
  }));

  assert.equal(invocation.dispatched, false);
  assert.strictEqual(result.provider, invocation.provider);
  assert.equal(result.model, 'direct-model');
});

test('AI invocation acquires only the adapter selected by run()', async () => {
  const calls = { provider: 0, dispatcher: 0 };
  const provider = { source: 'provider' };
  const dispatcher = {
    async dispatch(_kind, operation) {
      return { result: await operation({ source: 'dispatcher-provider' }, 'dispatch-model') };
    },
  };
  const options = {
    providerFactory: () => {
      calls.provider += 1;
      return provider;
    },
    dispatcherFactory: () => {
      calls.dispatcher += 1;
      return dispatcher;
    },
  };

  const direct = createAIInvocationFromRequest(request(), options);
  assert.deepEqual(calls, { provider: 0, dispatcher: 0 });
  await direct.run('analysis', async selected => selected);
  assert.deepEqual(calls, { provider: 1, dispatcher: 0 });

  const dispatched = createAIInvocationFromRequest(
    request({ headers: { 'x-use-agent-dispatch': 'true' } }),
    options,
  );
  assert.deepEqual(calls, { provider: 1, dispatcher: 0 });
  await dispatched.run('analysis', async selected => selected);
  assert.deepEqual(calls, { provider: 1, dispatcher: 1 });
});

test('AI invocation delegates opted-in operations and unwraps dispatcher results', async () => {
  const calls = [];
  const selectedProvider = { source: 'dispatcher' };
  const dispatcher = {
    usageStats: { agents: {} },
    async dispatch(kind, operation) {
      calls.push(kind);
      return {
        result: await operation(selectedProvider, 'selected-model'),
        agentType: kind,
      };
    },
  };
  const invocation = createAIInvocationFromRequest(
    request({ headers: {
      'x-api-key': 'dispatcher-test-key',
      'x-use-agent-dispatch': 'true',
    } }),
    { dispatcherFactory: () => dispatcher },
  );

  const result = await invocation.run(
    'examGenerate',
    async (provider, model) => ({ provider, model }),
  );

  assert.equal(invocation.dispatched, true);
  assert.strictEqual(invocation.dispatcher, dispatcher);
  assert.deepEqual(calls, ['examGenerate']);
  assert.strictEqual(result.provider, selectedProvider);
  assert.equal(result.model, 'selected-model');
});
