import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../api';

vi.mock('#/lib/settings-storage', () => ({
  loadSettings: vi.fn(() => ({})),
  selectTextProvider: vi.fn(() => ({
    apiKey: 'test-key',
    baseURL: 'https://example.test/v1',
    model: 'test-model',
  })),
}));

describe('resource recommendation API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('aborts a stalled recommendation and returns a retryable timeout error', async () => {
    let requestSignal;
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      requestSignal = options.signal;
      return new Promise((_, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      });
    }));

    const request = api.recommendResources('plan-1', 'topic-1');

    expect(requestSignal).toBeDefined();
    const rejection = expect(request).rejects.toThrow('资源推荐超时，请重试');
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSignal.aborted).toBe(true);
  });
});
