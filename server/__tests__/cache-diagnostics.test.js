import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CacheMonitor } from '../engine/cache-diagnostics.js';

describe('CacheMonitor', () => {
  it('should start with empty state', () => {
    const m = new CacheMonitor();
    const s = m.summary();
    assert.strictEqual(s.summary.totalCalls, 0);
    assert.strictEqual(s.prefixChanges.count, 0);
    assert.strictEqual(s.summary.responseCacheHitRate, 'N/A');
  });

  it('should record shapes and detect prefix changes', () => {
    const m = new CacheMonitor();
    // Use 3+ messages so msg[0..1] = stable prefix, msg[2+] = variable tail
    const msg1 = [
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Context for X.' },
      { role: 'user', content: 'What is X?' },
    ];
    m.recordShape(msg1, 'call1', 'gpt-4o');
    const s1 = m.summary();
    assert.strictEqual(s1.prefixChanges.count, 0);

    // Same prefix (msg[0..1]), different tail (msg[2])
    const msg2 = [
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Context for X.' },
      { role: 'user', content: 'Tell me about Y.' },
    ];
    m.recordShape(msg2, 'call2', 'gpt-4o');
    const s2 = m.summary();
    assert.strictEqual(s2.prefixChanges.count, 0);

    // Different prefix (msg[0] changed)
    const msg3 = [
      { role: 'system', content: 'You are a DIFFERENT helper.' },
      { role: 'user', content: 'Context for X.' },
      { role: 'user', content: 'What is Z?' },
    ];
    m.recordShape(msg3, 'call3', 'gpt-4o');
    const s3 = m.summary();
    assert.strictEqual(s3.prefixChanges.count, 1);
  });

  it('should record usage and compute cache hit ratio', () => {
    const m = new CacheMonitor();
    m.recordUsage({ cacheHitTokens: 100, cacheMissTokens: 0, totalTokens: 100, promptTokens: 50, completionTokens: 50 }, 'hit1');
    m.recordUsage({ cacheHitTokens: 0, cacheMissTokens: 200, totalTokens: 200, promptTokens: 100, completionTokens: 100 }, 'miss1');
    const s = m.summary();
    assert.strictEqual(s.summary.totalCalls, 2);
    assert.strictEqual(s.summary.totalCacheHitTokens, 100);
    assert.strictEqual(s.summary.totalCacheMissTokens, 200);
    assert.ok(s.summary.overallApiCacheHitRatio.includes('33.3'));
  });

  it('should record response cache events', () => {
    const m = new CacheMonitor();
    m.recordResponseCache('call1', true);
    m.recordResponseCache('call2', true);
    m.recordResponseCache('call3', false);
    const s = m.summary();
    assert.strictEqual(s.summary.responseCacheHits, 2);
    assert.strictEqual(s.summary.responseCacheMisses, 1);
    assert.ok(s.summary.responseCacheHitRate.includes('66.7'));
  });

  it('should detect message count changes', () => {
    const m = new CacheMonitor();
    const msg1 = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User message' },
    ];
    m.recordShape(msg1, 'call1', 'gpt-4o');

    const msg2 = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User message' },
      { role: 'user', content: 'Follow-up' },
    ];
    m.recordShape(msg2, 'call2', 'gpt-4o');
    const s = m.summary();
    assert.strictEqual(s.prefixChanges.count, 0); // prefix still same (first 2 messages unchanged)
  });

  it('should reset state', () => {
    const m = new CacheMonitor();
    m.recordUsage({ cacheHitTokens: 50, cacheMissTokens: 0, totalTokens: 50, promptTokens: 25, completionTokens: 25 }, 'call');
    m.recordResponseCache('call', true);
    m.reset();
    const s = m.summary();
    assert.strictEqual(s.summary.totalCalls, 0);
    assert.strictEqual(s.summary.responseCacheHits, 0);
  });
});
