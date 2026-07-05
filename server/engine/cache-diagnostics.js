/**
 * CacheDiagnostics — Detects WHAT causes cache prefix changes and
 * monitors overall cache health.
 *
 * === DESIGN ===
 *
 * Three levels of diagnostics:
 * 1. Per-call prefix tracking — detect which message slot changed
 * 2. Cumulative metrics — hit/miss ratio, prefix stability rate
 * 3. Message structure analysis — assess cache-friendliness of prompt design
 *
 * Integrates with the new provider.js multi-level cache system:
 * - computePrefixHash() for stable prefix detection
 * - assessPrefixStability() for prompt quality scoring
 */

import { computePrefixHash, assessPrefixStability } from './provider.js';

/**
 * Tracks cache shape and usage across multiple calls for one engine.
 */
export class CacheMonitor {
  constructor() {
    this._shapes = [];
    this._usages = [];
    this._prefixChanges = [];
    this._responseCacheHits = 0;
    this._responseCacheMisses = 0;
  }

  /**
   * Record the cache shape of a call before it's made.
   * Returns the prefix hash for reference.
   *
   * @param {Array} messages - The full messages array
   * @param {string} [label=''] - Call site label for diagnostics
   * @param {string} [model=''] - Model name for prefix hash
   */
  recordShape(messages, label = '', model = '') {
    const prefixHash = computePrefixHash(model, messages);
    const prev = this._shapes[this._shapes.length - 1];
    const prefixChanged = prev && prev.prefixHash !== prefixHash;

    this._shapes.push({
      label,
      prefixHash,
      timestamp: Date.now(),
      messageCount: messages.length,
    });

    if (prefixChanged) {
      const reasons = this._detectChange(prev.messages, messages);
      this._prefixChanges.push({
        label,
        reasons,
        fromHash: prev.prefixHash,
        toHash: prefixHash,
        timestamp: Date.now(),
      });

      // Run stability assessment on the new shape
      const stability = assessPrefixStability(messages);
      this._lastStability = stability;
    }

    // Store a snapshot of message roles + content length for change detection
    this._shapes[this._shapes.length - 1].messages = messages.slice(0, 5).map(m => ({
      role: m.role,
      contentLength: m.content?.length || 0,
      contentPrefix: (m.content || '').slice(0, 80),
    }));

    return prefixHash;
  }

  /**
   * Record usage after a call completes.
   */
  recordUsage(usage, label = '') {
    this._usages.push({
      label,
      cacheHit: usage.cacheHitTokens || 0,
      cacheMiss: usage.cacheMissTokens || 0,
      total: usage.totalTokens || 0,
      promptTokens: usage.promptTokens || 0,
      completionTokens: usage.completionTokens || 0,
    });
  }

  /**
   * Record a response-cache event.
   */
  recordResponseCache(label = '', hit = true) {
    if (hit) this._responseCacheHits++;
    else this._responseCacheMisses++;
  }

  /**
   * Get a comprehensive diagnostic report.
   */
  summary() {
    const totalHits = this._usages.reduce((s, u) => s + u.cacheHit, 0);
    const totalMisses = this._usages.reduce((s, u) => s + u.cacheMiss, 0);
    const totalTokens = totalHits + totalMisses;
    const prefixChanges = this._prefixChanges;
    const totalCalls = this._usages.length;

    // Calculate prefix stability rate
    const totalRecorded = this._shapes.length;
    const changes = prefixChanges.length;
    const stabilityRate = totalRecorded > 1
      ? ((1 - changes / (totalRecorded - 1)) * 100).toFixed(1) + '%'
      : 'N/A';

    // Response cache stats
    const respTotal = this._responseCacheHits + this._responseCacheMisses;
    const respHitRate = respTotal > 0
      ? (this._responseCacheHits / respTotal * 100).toFixed(1) + '%'
      : 'N/A';

    return {
      summary: {
        totalCalls,
        totalCacheHitTokens: totalHits,
        totalCacheMissTokens: totalMisses,
        overallApiCacheHitRatio: totalTokens > 0
          ? (totalHits / totalTokens * 100).toFixed(1) + '%'
          : 'N/A',
        prefixStabilityRate: stabilityRate,
        responseCacheHitRate: respHitRate,
        responseCacheHits: this._responseCacheHits,
        responseCacheMisses: this._responseCacheMisses,
      },
      prefixChanges: {
        count: changes,
        details: prefixChanges.slice(-10).map(p => ({
          label: p.label,
          reasons: p.reasons,
          timeAgo: Math.round((Date.now() - p.timestamp) / 1000) + 's',
        })),
      },
      recentCalls: this._usages.slice(-10).map(u => ({
        call: u.label,
        apiCacheRatio: (u.cacheHit + u.cacheMiss) > 0
          ? (u.cacheHit / (u.cacheHit + u.cacheMiss) * 100).toFixed(1) + '%'
          : 'N/A',
        tokens: u.cacheHit + 'H / ' + u.cacheMiss + 'M',
      })),
      lastStability: this._lastStability || null,
    };
  }

  /**
   * Detect what changed between two message snapshots.
   */
  _detectChange(prevMessages, curMessages) {
    const reasons = [];
    const depth = Math.min(curMessages.length, prevMessages?.length || 0, 5);

    for (let i = 0; i < depth; i++) {
      const prev = prevMessages?.[i];
      const cur = curMessages[i];

      if (!prev || !cur) {
        reasons.push(`msg[${i}]: message count changed`);
        continue;
      }

      if (prev.role !== cur.role) {
        reasons.push(`msg[${i}]: role changed (${prev.role} → ${cur.role})`);
        continue;
      }

      if (prev.contentPrefix !== cur.contentPrefix) {
        reasons.push(`msg[${i}](${cur.role}): content changed`);
      }
    }

    // Check for new messages beyond previous depth
    if (curMessages.length > (prevMessages?.length || 0)) {
      const newCount = curMessages.length - (prevMessages?.length || 0);
      reasons.push(`+${newCount} message(s) appended`);
    }

    return reasons.length > 0 ? reasons : ['unknown'];
  }

  /**
   * Reset all accumulated diagnostics.
   */
  reset() {
    this._shapes = [];
    this._usages = [];
    this._prefixChanges = [];
    this._responseCacheHits = 0;
    this._responseCacheMisses = 0;
    this._lastStability = null;
  }
}

export default { CacheMonitor };
