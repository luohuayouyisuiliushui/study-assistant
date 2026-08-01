import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LISTEN_HOST,
  createApiAuthorization,
  getListenHost,
  isAllowedBrowserOrigin,
  isLoopbackAddress,
} from '../security.js';

function invoke(middleware, { address, token } = {}) {
  let nextCalled = false;
  let response;
  middleware(
    {
      socket: { remoteAddress: address },
      get: name => name === 'x-study-assistant-token' ? token : undefined,
      headers: {},
    },
    { status: code => ({ json: body => { response = { code, body }; } }) },
    () => { nextCalled = true; },
  );
  return { nextCalled, response };
}

describe('server network boundary', () => {
  it('binds to loopback unless explicitly overridden', () => {
    assert.equal(getListenHost({}), DEFAULT_LISTEN_HOST);
    assert.equal(getListenHost({ STUDY_ASSISTANT_HOST: '0.0.0.0' }), '0.0.0.0');
  });

  it('recognizes IPv4, IPv6, and IPv4-mapped loopback addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.20'), false);
  });

  it('allows any local HTTP development port and rejects remote origins', () => {
    assert.equal(isAllowedBrowserOrigin('http://localhost:5270'), true);
    assert.equal(isAllowedBrowserOrigin('http://127.0.0.1:5173'), true);
    assert.equal(isAllowedBrowserOrigin(undefined), true);
    assert.equal(isAllowedBrowserOrigin('https://example.com'), false);
    assert.equal(isAllowedBrowserOrigin('not a URL'), false);
  });

  it('allows loopback and rejects remote API requests without a token', () => {
    const middleware = createApiAuthorization({ token: 'shared-secret' });
    assert.equal(invoke(middleware, { address: '127.0.0.1' }).nextCalled, true);
    const rejected = invoke(middleware, { address: '192.168.1.20' });
    assert.deepEqual(rejected.response, {
      code: 403,
      body: { error: '远程 API 访问需要有效的 x-study-assistant-token' },
    });
  });

  it('allows remote API requests only with the configured token', () => {
    const middleware = createApiAuthorization({ token: 'shared-secret' });
    assert.equal(invoke(middleware, { address: '192.168.1.20', token: 'wrong' }).nextCalled, false);
    assert.equal(invoke(middleware, { address: '192.168.1.20', token: 'shared-secret' }).nextCalled, true);
  });
});
