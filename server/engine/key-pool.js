/**
 * Key pool: supports multiple API keys for a single channel, enabling
 * higher throughput (round-robin) and fault tolerance (failover on error).
 *
 * A key string may contain several keys separated by commas, whitespace,
 * newlines, or semicolons. The pool hands out keys round-robin per call and
 * temporarily suspends keys that return auth/rate-limit errors.
 *
 * This is what lets the app run "low-cost + high-quality" AI output:
 * a cheap key pool for high-frequency tasks and a strong key pool for
 * high-value tasks, with automatic rotation and failover.
 */

const COOLDOWN_MS = 60_000; // 1 min suspension after an error

class KeyPool {
  constructor(raw) {
    this.keys = KeyPool.parse(raw);
    this.index = 0;
    this.cooldownUntil = new Map(); // key -> timestamp
  }

  static parse(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(k => k.trim()).filter(Boolean);
    return String(raw)
      .split(/[,\s;]+/)
      .map(k => k.trim())
      .filter(Boolean);
  }

  get size() {
    return this.keys.length;
  }

  /**
   * Return the next usable key (round-robin, skipping cooled-down keys).
   * Falls back to any key if all are cooling down. Returns '' if empty.
   */
  next() {
    const n = this.keys.length;
    if (n === 0) return '';
    const now = Date.now();

    for (let i = 0; i < n; i++) {
      const key = this.keys[this.index];
      this.index = (this.index + 1) % n;
      const until = this.cooldownUntil.get(key) || 0;
      if (until <= now) return key;
    }
    // All cooling down — return the one that cools down soonest
    let best = this.keys[0];
    let bestUntil = Infinity;
    for (const k of this.keys) {
      const u = this.cooldownUntil.get(k) || 0;
      if (u < bestUntil) { bestUntil = u; best = k; }
    }
    return best;
  }

  /** Mark a key as failed (auth/rate-limit) so it's skipped for a while. */
  markFailed(key) {
    if (!key) return;
    this.cooldownUntil.set(key, Date.now() + COOLDOWN_MS);
  }

  /** Clear any cooldown for a key (e.g. on a successful call). */
  markOk(key) {
    this.cooldownUntil.delete(key);
  }
}

// Module-level pool cache keyed by the raw string, so rotation state persists
// across calls within a process.
const _poolCache = new Map();

export function getKeyPool(raw) {
  const key = typeof raw === 'string' ? raw : '';
  if (!_poolCache.has(key)) {
    _poolCache.set(key, new KeyPool(raw));
  }
  return _poolCache.get(key);
}

export { KeyPool };
