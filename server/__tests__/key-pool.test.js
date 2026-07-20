import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool, getKeyPool } from '../engine/key-pool.js';

describe('KeyPool', () => {
  it('parses comma/space/newline separated keys', () => {
    const p = new KeyPool('a, b\nc  d;e');
    assert.equal(p.size, 5);
    assert.deepEqual(p.keys, ['a', 'b', 'c', 'd', 'e']);
  });

  it('returns empty string when no keys', () => {
    assert.equal(new KeyPool('').next(), '');
    assert.equal(new KeyPool(null).next(), '');
  });

  it('round-robins through all keys', () => {
    const p = new KeyPool('a, b, c');
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push(p.next());
    assert.deepEqual(seen, ['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('skips a key that was marked failed (cooldown)', () => {
    const p = new KeyPool('a, b, c');
    p.markFailed('b');
    const seq = [p.next(), p.next(), p.next()];
    assert.ok(!seq.includes('b'), 'failed key should be skipped while cooling down');
    assert.ok(seq.includes('a') && seq.includes('c'));
  });

  it('falls back to a cooled-down key if all are cooling', () => {
    const p = new KeyPool('a, b');
    p.markFailed('a');
    p.markFailed('b');
    // Both cooling — should still return something rather than hang
    assert.ok(['a', 'b'].includes(p.next()));
  });

  it('getKeyPool caches by raw string and keeps rotation state', () => {
    const p1 = getKeyPool('x, y');
    const p2 = getKeyPool('x, y');
    assert.equal(p1, p2); // same instance (rotation persists)
    const p3 = getKeyPool('x , y'); // different raw string -> different pool
    assert.notEqual(p1, p3);
  });
});
