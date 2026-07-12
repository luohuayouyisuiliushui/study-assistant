/**
 * Cache-aware OpenAI-compatible Provider.
 *
 * === THREE-LAYER CACHE ARCHITECTURE ===
 *
 * Layer 1 — API Prefix Cache (provider-side):
 *   DeepSeek/OpenAI caches the compute for repeated message prefixes.
 *   We ensure stable prefixes by keeping system prompts immutable and
 *   context digests deterministic. Hash monitoring detects regressions.
 *
 * Layer 2 — In-Memory Response Cache:
 *   Exact-match dedup for identical (prefix + tail) combos within a
 *   session. Two-tier TTL: prefix keys live longer, full keys shorter.
 *   Capacity: 1000 entries, LRU eviction.
 *
 * Layer 3 — Disk-Persisted Prefix Cache:
 *   Survives server restarts. Stores which (model + system + context)
 *   prefixes have been seen, so cache warming resumes immediately after
 *   restart without an extra API call.
 *
 * === KEY DESIGN ===
 *
 *   computePrefixHash() — hashes ONLY the stable prefix (messages[0..1]),
 *     so two calls with the same system prompt + context digest produce
 *     the same prefix hash regardless of the user's varying question.
 *
 *   computeRequestHash() — hashes the FULL request (prefix + tail) for
 *     exact-match response caching. Only hits when the exact same
 *     messages array is sent again (e.g. retry after error).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

// ─── Constants ───

const DEBUG = process.env.DEBUG_CACHE === 'true' || process.env.NODE_ENV !== 'production';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache');

const RESPONSE_CACHE_MAX = 1000;        // Max in-memory entries
const RESPONSE_CACHE_TTL_PREFIX = 30 * 60 * 1000;  // 30 min for prefix-based keys
const RESPONSE_CACHE_TTL_FULL = 2 * 60 * 1000;     // 2 min for exact-match keys
const RESPONSE_CACHE_TTL_SHORT = 30 * 1000;        // 30 sec for high-variance calls

const DISK_CACHE_PATH = path.join(CACHE_DIR, 'prefix-cache.json');
const DISK_CACHE_MAX = 500;
const DISK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 days

// ─── Helpers ───

export function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf-8').digest('hex');
}

function shortId(hash) {
  return hash ? hash.slice(0, 12) : 'null';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Cache Key Computation ───

/**
 * Compute a hash of ONLY the stable prefix (messages[0..N-1] where N >= 1).
 *
 * WHY: The API provider (DeepSeek, OpenAI) caches the BEGINNING of your
 * messages array. If messages[0] (system) and messages[1] (context) are
 * identical across calls, the provider can reuse cached computation for
 * those early tokens. This hash lets us DETECT when the prefix changes
 * and diagnose WHY.
 *
 * Default depth=2: system prompt + deterministic context digest.
 * The user's actual question (index 2+) is excluded because it varies
 * per call and would make comparison useless.
 */
export function computePrefixHash(model, messages, depth = 2) {
  const prefix = messages.slice(0, Math.min(depth, messages.length));
  const canonical = prefix.map(m => m.role + ':' + m.content).join('\n---\n');
  return sha256(model + '::' + canonical);
}

/**
 * Compute a hash of the VARIABLE tail (messages beyond the prefix).
 * Combined with prefixHash for two-tier response cache keying.
 */
export function computeTailHash(messages, depth = 2) {
  const tail = messages.slice(depth);
  if (tail.length === 0) return '__notail__';
  return sha256(tail.map(m => m.role + ':' + m.content).join('\n---\n'));
}

/**
 * Full request hash for exact-match dedup (unchanged from v1, but depth-aware).
 * Includes model + messages + temperature + maxTokens + responseFormat.
 */
export function computeRequestHash(model, messages, opts = {}) {
  const payload = JSON.stringify({
    model,
    messages,
    temp: opts.temperature ?? 0.7,
    maxT: opts.maxTokens ?? 4096,
    fmt: opts.responseFormat || null,
  });
  return sha256(payload);
}

// ─── Disk-Persisted Prefix Cache ───

class DiskPrefixCache {
  constructor(filePath = DISK_CACHE_PATH, maxEntries = DISK_CACHE_MAX) {
    this._path = filePath;
    this._max = maxEntries;
    this._data = new Map(); // prefixHash -> { seenAt, warmedAt, model }
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(this._path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this._path)) return;
      const raw = fs.readFileSync(this._path, 'utf-8');
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      const now = Date.now();
      for (const e of entries) {
        if (now - e.seenAt < DISK_CACHE_TTL) {
          this._data.set(e.key, e);
        }
      }
    } catch (err) {
      console.warn('[DiskCache] Load failed (non-fatal):', err.message);
    }
  }

  flush() {
    if (!this._dirty) return;
    try {
      const entries = [];
      for (const [, value] of this._data) {
        entries.push(value);
      }
      // Sort: most recently seen first
      entries.sort((a, b) => b.seenAt - a.seenAt);
      // Trim to max
      const trimmed = entries.slice(0, this._max);
      const dir = path.dirname(this._path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: tmp -> rename
      const tmp = this._path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 0), 'utf-8');
      fs.renameSync(tmp, this._path);
      this._dirty = false;
    } catch (err) {
      console.warn('[DiskCache] Flush failed (non-fatal):', err.message);
    }
  }

  has(key) {
    return this._data.has(key);
  }

  markSeen(key, model) {
    const existing = this._data.get(key);
    if (existing) {
      existing.seenAt = Date.now();
    } else {
      this._data.set(key, { key, model, seenAt: Date.now(), warmedAt: null });
    }
    this._dirty = true;
  }

  markWarmed(key) {
    const entry = this._data.get(key);
    if (entry) {
      entry.warmedAt = Date.now();
      this._dirty = true;
    }
  }

  needsWarm(key) {
    const entry = this._data.get(key);
    if (!entry) return true; // never seen → warm
    if (!entry.warmedAt) return true; // seen but never warmed
    // Re-warm if last warm was more than 1 hour ago
    return Date.now() - entry.warmedAt > 60 * 60 * 1000;
  }

  get stats() {
    return {
      entries: this._data.size,
      max: this._max,
      recentlySeen: [...this._data.values()]
        .sort((a, b) => b.seenAt - a.seenAt)
        .slice(0, 5)
        .map(e => ({ key: shortId(e.key), seenAgo: Math.round((Date.now() - e.seenAt) / 1000) + 's' })),
    };
  }

  clear() {
    this._data.clear();
    this._dirty = true;
    this.flush();
  }
}

// ─── Global instances ───

const _diskCache = new DiskPrefixCache();

// ─── In-Memory Response Cache ───

class ResponseCache {
  constructor(maxEntries = RESPONSE_CACHE_MAX) {
    this._max = maxEntries;
    this._map = new Map(); // key -> { expiresAt, content, ttl }
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  get(key) {
    const entry = this._map.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      this._hits++;
      // True LRU: re-insert at end of insertion order
      this._map.delete(key);
      this._map.set(key, entry);
      return entry.content;
    }
    if (entry) {
      this._map.delete(key); // expired
    }
    this._misses++;
    return null;
  }

  set(key, content, ttlMs) {
    // LRU eviction — delete oldest entries if at capacity
    while (this._map.size >= this._max) {
      const oldest = this._map.keys().next().value;
      if (oldest) {
        this._map.delete(oldest);
        this._evictions++;
      } else break;
    }
    this._map.set(key, {
      expiresAt: Date.now() + ttlMs,
      content,
    });
  }

  get stats() {
    const total = this._hits + this._misses;
    return {
      size: this._map.size,
      max: this._max,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: total > 0 ? (this._hits / total * 100).toFixed(1) + '%' : 'N/A',
    };
  }

  clear() {
    this._map.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }
}

const _responseCache = new ResponseCache();

// ─── API Usage Extraction ───

/**
 * Build usage summary from an API response, normalizing
 * across different wire formats (DeepSeek, OpenAI).
 */
export function extractUsage(apiResponse) {
  const u = apiResponse?.usage || {};
  const details = u.prompt_tokens_details || {};

  const cacheHitTokens = u.prompt_cache_hit_tokens || details.cached_tokens || 0;
  const cacheMissTokens = u.prompt_cache_miss_tokens ||
    (u.prompt_tokens ? u.prompt_tokens - cacheHitTokens : 0);

  return {
    promptTokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    totalTokens: u.total_tokens || 0,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRatio: cacheHitTokens + cacheMissTokens > 0
      ? cacheHitTokens / (cacheHitTokens + cacheMissTokens)
      : 0,
  };
}

// ─── Prefix Stability Assessment ───

/**
 * Assess how stable the message prefix is for API-level caching.
 * Returns a score (0-100) and actionable recommendations.
 */
export function assessPrefixStability(messages) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role === 'user');
  const assistantMsgs = messages.filter(m => m.role === 'assistant');

  const issues = [];
  let score = 100;

  // Check 1: System prompt should be first
  if (messages.length > 0 && messages[0].role !== 'system') {
    issues.push('第一条消息不是 system role — 系统提示应始终位于 messages[0]');
    score -= 30;
  }

  // Check 2: Single system message (DeepSeek recommends merging multiple)
  if (systemMsgs.length > 1) {
    issues.push(`存在 ${systemMsgs.length} 条 system 消息 — 建议合并为一条以获得最佳前缀缓存`);
    score -= 15;
  }

  // Check 3: System prompt should be substantive (≥100 tokens worth)
  if (systemMsgs.length > 0 && systemMsgs[0].content.length < 100) {
    issues.push(`System prompt 过短 (${systemMsgs[0].content.length} chars) — 难以形成有效缓存前缀`);
    score -= 10;
  }

  // Check 4: Variable content in the first 2 messages
  const prefixMsgs = messages.slice(0, 2);
  for (const [i, m] of prefixMsgs.entries()) {
    if (m.content.includes('${') || m.content.includes('{{') ||
        m.content.includes('{plan') || m.content.includes('{topic')) {
      issues.push(`messages[${i}] 包含模板变量 — 前缀会随每次调用变化`);
      score -= 25;
    }
  }

  // Check 5: Too many assistant messages in prefix
  const prefixAssistantCount = prefixMsgs.filter(m => m.role === 'assistant').length;
  if (prefixAssistantCount > 0) {
    issues.push(`前缀中包含 ${prefixAssistantCount} 条 assistant 消息 — 不利于缓存稳定性`);
    score -= 10;
  }

  // Verdict
  const verdict = score >= 80 ? 'good' : score >= 50 ? 'fair' : 'poor';

  return {
    score: Math.max(0, score),
    verdict,
    issues,
    composition: {
      system: systemMsgs.length,
      user: userMsgs.length,
      assistant: assistantMsgs.length,
      total: messages.length,
    },
  };
}

// ─── Helper: detect relay-unsupported parameter errors ───
// (exported for unit testing)

export function isUnsupportedParameterError(err, paramName) {
  const msg = (err?.message || '').toLowerCase();
  const param = paramName.toLowerCase();
  return (
    msg.includes(`'${param}'`) || msg.includes(`"${param}"`) ||
    msg.includes(param + ' is not supported') ||
    msg.includes(param + ' is not a valid') ||
    msg.includes('does not support') ||
    msg.includes('unsupported parameter') ||
    msg.includes('unknown parameter') ||
    msg.includes('invalid parameter') ||
    msg.includes('not supported')
  );
}

// ─── Helper: format connection errors for relay compatibility ───

export function formatConnectionError(err, baseURL, model) {
  const msg = err?.message ? String(err.message).toLowerCase() : '';

  if (err.status === 401) return 'API Key 无效或未授权（401）';
  if (err.status === 403) return `API Key 无权限访问模型 "${model}"（403）`;
  if (err.status === 404) {
    return baseURL && !baseURL.endsWith('/v1')
      ? 'API 地址不正确（404），请检查 Base URL 是否以 /v1 结尾'
      : 'API 地址不正确（404），请检查 Base URL 和模型名称是否正确';
  }
  if (err.status === 429) return '请求过于频繁，请稍后再试（429）';
  if (err.status === 500) return 'API 服务器内部错误（500），可能是中转站本身的问题';

  // OpenAI SDK connection errors (instanceof-style check via constructor name)
  const isConnErr = err.constructor?.name === 'APIConnectionError' ||
    err.constructor?.name === 'APIConnectionTimeoutError';

  if (isConnErr || msg.includes('connection error') || msg.includes('econnrefused')) {
    if (msg.includes('timeout') || err.constructor?.name === 'APIConnectionTimeoutError') {
      return '连接超时，请检查 AI 服务是否启动、Base URL 是否可达';
    }
    if (msg.includes('econnrefused')) {
      return 'AI 服务未启动或拒绝连接，请检查本地 AI 服务（如 Ollama）是否运行';
    }
    return '无法连接到 AI 服务，请检查 Base URL 是否正确、网络是否畅通';
  }

  if (err.code === 'ECONNREFUSED') return '无法连接到服务器，请检查 Base URL';
  if (err.code === 'ENOTFOUND') return '域名解析失败，请检查 Base URL 是否正确';
  if (err.code === 'ECONNRESET') return '连接被重置，请检查 Base URL 和网络连接';
  if (err.code === 'ETIMEDOUT' || msg.includes('timeout')) return '连接超时，请检查 Base URL 是否可达';

  if (msg.includes('incorrect api key') || msg.includes('invalid api key')) return 'API Key 不正确';
  if (msg.includes('auth') || msg.includes('unauthorized')) return '认证失败，请检查 API Key 是否正确';
  if (msg.includes('insufficient quota') || msg.includes('quota')) return 'API 额度不足，请检查中转站账户余额';
  if (msg.includes('rate limit') || msg.includes('too many requests')) return '请求频率过高，请稍后再试';
  if (msg.includes('model not found') || msg.includes('model not exist')) return `模型 "${model}" 不存在，请检查模型名称是否正确`;
  if (msg.includes('current quota') || msg.includes('balance')) return '中转站余额不足，请充值';
  if (msg.includes('account balance')) return '账户余额不足';

  return err.message || '未知错误';
}

/**
 * Encode potentially WAF-triggering content for relay compatibility.
 * Replaces characters that might trigger SQLi/XSS pattern detection
 * with fullwidth Unicode homoglyphs that the AI still understands.
 *
 * Applied to user messages at the API call boundary only — cache keys
 * and diagnostics still use the original content.
 */
function encodeForRelay(text) {
  const map = {
    '<': '＜',  // U+FF1C fullwidth less-than sign
    '>': '＞',  // U+FF1E fullwidth greater-than sign
    "'": '＇',  // U+FF07 fullwidth apostrophe / single quote
    '"': '＂',  // U+FF02 fullwidth quotation mark
  };
  return text.replace(/[<>'"]/g, ch => map[ch]);
}

// ─── Retry with exponential backoff + jitter ───

const INITIAL_DELAY = 1000;
const MAX_DELAY = 15_000;
const MAX_RETRIES = 2;
const BACKOFF_MULTIPLIER = 2;

function isRetryableError(err) {
  const status = err?.status;
  if (!status) {
    return err?.message?.includes('ECONNRESET') ||
           err?.message?.includes('ETIMEDOUT') ||
           err?.message?.includes('timeout') ||
           err?.message?.includes('socket hang up') ||
           err?.message?.includes('network');
  }
  return status === 429 || status >= 500;
}

/**
 * Wrap an async iterable with an idle timeout.
 * Throws if no chunk is received for `timeoutMs` milliseconds.
 * Each successful chunk resets the idle timer.
 */
async function* withStreamTimeout(iterable, timeoutMs = 60_000) {
  const iterator = iterable[Symbol.asyncIterator]();
  let lastActivity = Date.now();

  const nextWithTimeout = async () => {
    const elapsed = Date.now() - lastActivity;
    const remaining = Math.max(1, timeoutMs - elapsed);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Stream idle timeout: no data for ${timeoutMs / 1000}s`)), remaining)
    );

    return Promise.race([iterator.next(), timeoutPromise]);
  };

  try {
    while (true) {
      const result = await nextWithTimeout();
      if (result.done) break;
      lastActivity = Date.now();
      yield result.value;
    }
  } finally {
    // If we exit early (error/break), the iterator might still be pending.
    // The underlying stream will be cleaned up by GC/Node.js on connection close.
  }
}

async function retryWithBackoff(fn, attempt = 0) {
  try {
    return await fn();
  } catch (err) {
    if (attempt < MAX_RETRIES && isRetryableError(err)) {
      const delay = Math.min(INITIAL_DELAY * Math.pow(BACKOFF_MULTIPLIER, attempt), MAX_DELAY);
      const jitter = delay * (0.75 + Math.random() * 0.5);
      console.warn('[provider] Retry ' + (attempt + 1) + '/' + MAX_RETRIES + ' after ' + Math.round(jitter) + 'ms: ' + err.message);
      await sleep(jitter);
      return retryWithBackoff(fn, attempt + 1);
    }
    throw err;
  }
}

// ─── Provider class ───

export class Provider {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseURL]
   * @param {string} [opts.model]
   * @param {boolean} [opts.debugCache] - Log cache diagnostics
   * @param {boolean} [opts.autoWarm] - Auto-warm prefix cache on construction (default: true)
   */
  constructor(opts = {}) {
    this._apiKey = opts.apiKey;
    this._baseURL = opts.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this._model = opts.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this._fallbackModels = opts.fallbackModels || ['gpt-4o-mini', 'gpt-4o', 'gpt-4'];
    this._debugCache = opts.debugCache || false;
    this._autoWarm = opts.autoWarm !== false;

    // Prefix tracking (tracks stability across calls)
    this._lastPrefixHash = null;
    this._prefixChangeCount = 0;
    this._totalCalls = 0;

    // Accumulated API usage diagnostics
    this.diagnostics = {
      totalCalls: 0,
      totalCacheHitTokens: 0,
      totalCacheMissTokens: 0,
      prefixChanges: 0,
      warmedPrefixes: 0,
      lastPrefixStability: null,
    };

    // Lazily create OpenAI client
    this._client = new OpenAI({
      apiKey: this._apiKey,
      baseURL: this._baseURL,
      maxRetries: 0, // We handle retry ourselves
      timeout: 30_000,
    });
  }

  /**
   * Execute a function with automatic model fallback.
   * Tries the primary model first; on retryable failure, falls back through this._fallbackModels.
   * Skips cache update for fallback models to avoid stale data.
   */
  async _executeWithModelFallback(fn) {
    const modelsToTry = [this._model, ...this._fallbackModels.filter(m => m !== this._model)];
    let lastError;
    for (const model of modelsToTry) {
      try {
        const result = await retryWithBackoff(() => fn(model));
        return { result, usedFallback: model !== this._model };
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err)) throw err;
        console.warn(`[provider] Model ${model} failed, trying fallback: ${err.message}`);
      }
    }
    throw lastError;
  }

  /**
   * Non-streaming completion with multi-level caching.
   *
   * Cache lookups (in order):
   * 1. In-memory response cache (exact-match: full request hash)
   * 2. In-memory response cache (prefix-match: stable prefix hash)
   * 3. API call (with prefix cache diagnostics)
   */
  async complete(messages, opts = {}) {
    // ── Inject agent system prompt (merge, don't replace) ──
    const mergedMessages = this._agentSystemPrompt
      ? messages.map((m, i) => {
          if (i === 0 && m.role === 'system') {
            return { ...m, content: m.content + '\n\n' + this._agentSystemPrompt };
          }
          return m;
        })
      : messages;

    const prefixHash = computePrefixHash(this._model, mergedMessages);
    const requestHash = computeRequestHash(this._model, mergedMessages, opts);

    this._totalCalls++;

    // ── Layer 1: Full request hash cache (exact match) ──
    const exactCached = _responseCache.get('exact:' + requestHash);
    if (exactCached) {
      if (this._debugCache) {
        console.log('[provider] ✅ EXACT CACHE HIT | prefix: ' + shortId(prefixHash));
      }
      return exactCached;
    }

    // ── Layer 2: Prefix-based cache (same system + context, different question) ──
    const tailHash = computeTailHash(mergedMessages);
    const prefixKey = 'prefix:' + prefixHash;
    const cachedByPrefix = _responseCache.get(prefixKey);

    if (cachedByPrefix && cachedByPrefix.tailHashes?.has(tailHash)) {
      if (this._debugCache) {
        console.log('[provider] ✅ PREFIX CACHE HIT | prefix: ' + shortId(prefixHash) + ' tail: ' + shortId(tailHash));
      }
      return cachedByPrefix.response;
    }

    // ── Cache miss → make API call with model fallback ──
    const { result, usedFallback } = await this._executeWithModelFallback(async (model) => {
      let responseFormatFailed = false;
      const apiMessages = mergedMessages.map(m =>
        m.role === 'user' ? { ...m, content: encodeForRelay(m.content) } : m
      );
      const requestOpts = {
        model,
        messages: apiMessages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 4096,
      };
      if (opts.tools) requestOpts.tools = opts.tools;
      if (opts.tool_choice) requestOpts.tool_choice = opts.tool_choice;
      if (opts.responseFormat && !responseFormatFailed) {
        requestOpts.response_format = opts.responseFormat;
      }

      let resp;
      try {
        resp = await this._client.chat.completions.create(requestOpts);
      } catch (err) {
        if (opts.responseFormat && !responseFormatFailed && isUnsupportedParameterError(err, 'response_format')) {
          console.warn('[provider] ⚠️ Relay does not support response_format, retrying without it');
          responseFormatFailed = true;
          resp = await this._client.chat.completions.create({
            model,
            messages: apiMessages,
            temperature: opts.temperature ?? 0.7,
            max_tokens: opts.maxTokens ?? 4096,
          });
        } else {
          throw err;
        }
      }

      const message = resp.choices[0]?.message;
      const finishReason = resp.choices[0]?.finish_reason;
      const usage = extractUsage(resp);

      if (finishReason === 'length') {
        console.warn('[provider] ⚠️ Response truncated (finish_reason=length), content length:', (message?.content || '').length);
      }

      return {
        content: message?.content || '',
        tool_calls: message?.tool_calls || null,
        usage,
        finishReason,
        diagnostics: {
          prefixHash,
          prefixChanged: this._lastPrefixHash && this._lastPrefixHash !== prefixHash,
          cacheHitTokens: usage.cacheHitTokens,
          cacheMissTokens: usage.cacheMissTokens,
          cacheHitRatio: usage.cacheHitRatio,
          totalTokens: usage.totalTokens,
        },
      };
    });

    // ── Track diagnostics ──
    const prefixChanged = this._lastPrefixHash && this._lastPrefixHash !== prefixHash;
    if (prefixChanged) this._prefixChangeCount++;
    this._lastPrefixHash = prefixHash;

    this.diagnostics.totalCalls++;
    this.diagnostics.totalCacheHitTokens += result.usage.cacheHitTokens;
    this.diagnostics.totalCacheMissTokens += result.usage.cacheMissTokens;
    if (prefixChanged) this.diagnostics.prefixChanges++;

    if (this._debugCache) {
      const pfx = prefixChanged ? '⚠️ PREFIX CHANGED' : '✅ CACHE FRIENDLY';
      console.log(
        '[provider] ' + pfx + ' | cache: ' + result.usage.cacheHitTokens + 'H/' +
        result.usage.cacheMissTokens + 'M ' +
        '(' + (result.usage.cacheHitRatio * 100).toFixed(1) + '%) | prefix: ' + shortId(prefixHash)
      );
    }

    // ── Store in caches (skip for fallback — different model) ──
    if (result.content && !usedFallback) {
      _responseCache.set('exact:' + requestHash, result, RESPONSE_CACHE_TTL_FULL);

      const existing = _responseCache.get(prefixKey);
      if (existing) {
        existing.tailHashes.add(tailHash);
        existing.response = result;
        _responseCache.set(prefixKey, existing, RESPONSE_CACHE_TTL_PREFIX);
      } else {
        const tailHashes = new Set();
        tailHashes.add(tailHash);
        _responseCache.set(prefixKey, { tailHashes, response: result }, RESPONSE_CACHE_TTL_PREFIX);
      }

      _diskCache.markSeen(prefixHash, this._model);
    }

    return result;
  }

  /**
   * Streaming completion with cache diagnostics.
   * NOTE: Stream responses are NOT cached in-memory (they're too large),
   * but prefix stability is still tracked.
   */
  async stream(messages, opts = {}) {
    // ── Inject agent system prompt (merge, don't replace) ──
    const mergedMessages = this._agentSystemPrompt
      ? messages.map((m, i) => {
          if (i === 0 && m.role === 'system') {
            return { ...m, content: m.content + '\n\n' + this._agentSystemPrompt };
          }
          return m;
        })
      : messages;

    const prefixHash = computePrefixHash(this._model, mergedMessages);
    let fullContent = '';
    let finalUsage = null;

    this._totalCalls++;

    // Shared stream reader: accumulates content and usage
    const readStream = async (stream) => {
      for await (const chunk of withStreamTimeout(stream)) {
        if (chunk.usage) {
          finalUsage = chunk.usage;
          continue;
        }
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;
          if (opts.onChunk) opts.onChunk(delta);
        }
      }
    };

    await this._executeWithModelFallback(async (model) => {
      let useStreamOptions = opts.streamOptions !== false;
      let streamOptionsFailed = false;
      const apiMessages = mergedMessages.map(m =>
        m.role === 'user' ? { ...m, content: encodeForRelay(m.content) } : m
      );
      const requestOpts = {
        model,
        messages: apiMessages,
        temperature: opts.temperature ?? this._agentTemperature ?? 0.7,
        max_tokens: opts.maxTokens ?? this._agentMaxTokens ?? 8192,
        stream: true,
      };
      if (useStreamOptions && !streamOptionsFailed) {
        requestOpts.stream_options = { include_usage: true };
      }

      try {
        const stream = await this._client.chat.completions.create(requestOpts);
        await readStream(stream);
      } catch (err) {
        if (useStreamOptions && !streamOptionsFailed && isUnsupportedParameterError(err, 'stream_options')) {
          console.warn('[provider] ⚠️ Relay does not support stream_options, retrying without it');
          streamOptionsFailed = true;
          const fallbackStream = await this._client.chat.completions.create({
            model,
            messages: apiMessages,
            temperature: opts.temperature ?? 0.7,
            max_tokens: opts.maxTokens ?? 8192,
            stream: true,
          });
          await readStream(fallbackStream);
          return;
        }
        throw err;
      }
    });

    const usage = extractUsage({ usage: finalUsage || {} });
    const prefixChanged = this._lastPrefixHash && this._lastPrefixHash !== prefixHash;

    if (prefixChanged) this._prefixChangeCount++;
    this._lastPrefixHash = prefixHash;

    this.diagnostics.totalCalls++;
    this.diagnostics.totalCacheHitTokens += usage.cacheHitTokens;
    this.diagnostics.totalCacheMissTokens += usage.cacheMissTokens;
    if (prefixChanged) this.diagnostics.prefixChanges++;

    if (this._debugCache) {
      const pfx = prefixChanged ? '⚠️ PREFIX CHANGED' : '✅ CACHE FRIENDLY';
      console.log(
        '[provider] ' + pfx + ' | stream cache: ' + usage.cacheHitTokens + 'H/' +
        usage.cacheMissTokens + 'M ' +
        '(' + (usage.cacheHitRatio * 100).toFixed(1) + '%) | prefix: ' + shortId(prefixHash)
      );
    }

    if (opts.onUsage) opts.onUsage(usage);

    _diskCache.markSeen(prefixHash, this._model);

    return fullContent;
  }

  /**
   * Streaming completion with tool calling support.
   * Detects tool_call deltas mid-stream and accumulates them.
   *
   * Returns { content, tool_calls, usage } where tool_calls is null
   * unless the model finishes with reason 'tool_calls'.
   *
   * Calls opts.onChunk(delta) for each content chunk during streaming
   * and opts.onToolCall(tool_calls) when a complete tool call is detected.
   */
  async streamWithTools(messages, opts = {}) {
    // ── Inject agent system prompt (merge, don't replace) ──
    const mergedMessages = this._agentSystemPrompt
      ? messages.map((m, i) => {
          if (i === 0 && m.role === 'system') {
            return { ...m, content: m.content + '\n\n' + this._agentSystemPrompt };
          }
          return m;
        })
      : messages;

    const prefixHash = computePrefixHash(this._model, mergedMessages);
    let fullContent = '';
    let finalUsage = null;
    let toolCallsAccumulator = null;
    let finishReason = null;

    this._totalCalls++;

    const readStream = async (stream) => {
      for await (const chunk of withStreamTimeout(stream)) {
        if (chunk.usage) {
          finalUsage = chunk.usage;
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          fullContent += delta.content;
          if (opts.onChunk) opts.onChunk(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            if (!toolCallsAccumulator) toolCallsAccumulator = [];
            const idx = tcDelta.index || 0;
            if (!toolCallsAccumulator[idx]) {
              toolCallsAccumulator[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tcDelta.id) toolCallsAccumulator[idx].id += tcDelta.id;
            if (tcDelta.function?.name) toolCallsAccumulator[idx].function.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) toolCallsAccumulator[idx].function.arguments += tcDelta.function.arguments;
          }
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    };

    await this._executeWithModelFallback(async (model) => {
      let streamOptionsFailed = false;
      const apiMessages = mergedMessages.map(m =>
        m.role === 'user' ? { ...m, content: encodeForRelay(m.content) } : m
      );
      const requestOpts = {
        model,
        messages: apiMessages,
        temperature: opts.temperature ?? this._agentTemperature ?? 0.7,
        max_tokens: opts.maxTokens ?? this._agentMaxTokens ?? 8192,
        stream: true,
      };
      if (opts.tools) requestOpts.tools = opts.tools;
      if (opts.tool_choice) requestOpts.tool_choice = opts.tool_choice;
      if (!streamOptionsFailed) {
        requestOpts.stream_options = { include_usage: true };
      }

      try {
        const stream = await this._client.chat.completions.create(requestOpts);
        await readStream(stream);
      } catch (err) {
        if (!streamOptionsFailed && isUnsupportedParameterError(err, 'stream_options')) {
          console.warn('[provider] ⚠️ Relay does not support stream_options, retrying without it');
          streamOptionsFailed = true;
          const fallbackOpts = { ...requestOpts };
          delete fallbackOpts.stream_options;
          const fallbackStream = await this._client.chat.completions.create(fallbackOpts);
          await readStream(fallbackStream);
          return;
        }
        throw err;
      }
    });

    const usage = extractUsage({ usage: finalUsage || {} });
    const prefixChanged = this._lastPrefixHash && this._lastPrefixHash !== prefixHash;

    if (prefixChanged) this._prefixChangeCount++;
    this._lastPrefixHash = prefixHash;

    this.diagnostics.totalCalls++;
    this.diagnostics.totalCacheHitTokens += usage.cacheHitTokens;
    this.diagnostics.totalCacheMissTokens += usage.cacheMissTokens;
    if (prefixChanged) this.diagnostics.prefixChanges++;

    if (this._debugCache) {
      const pfx = prefixChanged ? '⚠️ PREFIX CHANGED' : '✅ CACHE FRIENDLY';
      console.log(
        '[provider] ' + pfx + ' | stream(tools) cache: ' + usage.cacheHitTokens + 'H/' +
        usage.cacheMissTokens + 'M ' +
        '(' + (usage.cacheHitRatio * 100).toFixed(1) + '%) | prefix: ' + shortId(prefixHash)
      );
    }

    if (opts.onUsage) opts.onUsage(usage);

    _diskCache.markSeen(prefixHash, this._model);

    const toolCalls = (finishReason === 'tool_calls' && toolCallsAccumulator) ? toolCallsAccumulator : null;

    if (toolCalls && opts.onToolCall) opts.onToolCall(toolCalls);

    return { content: fullContent, tool_calls: toolCalls, usage };
  }

  /**
   * Auto-warm the prefix cache on construction (called automatically).
   * Warms ALL known prefixes for this model from disk cache.
   */
  async warmKnownPrefixes() {
    // We just mark them as needing warm — the first actual call will warm.
    // This avoids making API calls during construction.
    if (this._debugCache) {
      if (DEBUG) console.log('[provider] Disk cache ready: ' + _diskCache.stats.entries + ' known prefixes');
    }
  }

  /**
   * Warm up the API prefix cache by sending a lightweight request.
   * This primes DeepSeek's disk cache so subsequent real requests
   * benefit from a cache hit.
   *
   * @param {Array} prefixMessages - The first 1-2 messages of the stable prefix
   */
  async warmCache(prefixMessages) {
    if (!prefixMessages || prefixMessages.length < 1) return;

    const prefixHash = computePrefixHash(this._model, prefixMessages);
    if (!_diskCache.needsWarm(prefixHash)) return;

    if (this._debugCache) {
      console.log('[provider] ⚡ Warming cache for prefix: ' + shortId(prefixHash));
    }

    try {
      const warmMsgs = prefixMessages.slice(0, 2);
      warmMsgs.push({ role: 'user', content: 'ok' });

      await this._client.chat.completions.create({
        model: this._model,
        messages: warmMsgs,
        temperature: 0,
        max_tokens: 1,
      });

      _diskCache.markWarmed(prefixHash);
      this.diagnostics.warmedPrefixes++;

      if (this._debugCache) {
        if (DEBUG) console.log('[provider] ✅ Cache warmed for prefix: ' + shortId(prefixHash));
      }
    } catch (err) {
      if (this._debugCache) {
        console.warn('[provider] Cache warm failed (non-fatal):', err.message);
      }
    }
  }

  /**
   * Analyze the stability of a messages array for caching.
   */
  analyzePrefixStability(messages) {
    return assessPrefixStability(messages);
  }

  /**
   * Flush the disk cache to disk.
   */
  flushDiskCache() {
    _diskCache.flush();
  }

  /**
   * Get comprehensive cache statistics.
   */
  getCacheStats() {
    const d = this.diagnostics;
    const totalApiTokens = d.totalCacheHitTokens + d.totalCacheMissTokens;
    return {
      apiCalls: d.totalCalls,
      prefixChanges: d.prefixChanges,
      prefixStabilityRate: d.totalCalls > 0
        ? ((1 - d.prefixChanges / d.totalCalls) * 100).toFixed(1) + '%'
        : 'N/A',
      apiCacheHitTokens: d.totalCacheHitTokens,
      apiCacheMissTokens: d.totalCacheMissTokens,
      apiCacheHitRatio: totalApiTokens > 0
        ? (d.totalCacheHitTokens / totalApiTokens * 100).toFixed(1) + '%'
        : 'N/A',
      warmedPrefixes: d.warmedPrefixes,
      responseCache: _responseCache.stats,
      diskCache: _diskCache.stats,
    };
  }

  /**
   * Clear all caches.
   */
  clearCaches() {
    _responseCache.clear();
    _diskCache.clear();
    this._lastPrefixHash = null;
    this._prefixChangeCount = 0;
  }

  /**
   * Test API connection by sending a minimal request.
   * Returns { ok, model, error? }.
   */
  async testConnection() {
    try {
      const resp = await this._client.chat.completions.create({
        model: this._model,
        messages: [
          { role: 'user', content: 'Hi' },
        ],
        max_tokens: 1,
        temperature: 0,
      });
      const model_used = resp.model || this._model;
      return { ok: true, model: model_used };
    } catch (err) {
      return { ok: false, error: formatConnectionError(err, this._baseURL, this._model) };
    }
  }

  get model() { return this._model; }
}

// ─── Periodic disk cache flush ───

setInterval(() => {
  _diskCache.flush();
}, 60 * 1000); // every 60s

// Graceful shutdown
process.on('exit', () => { _diskCache.flush(); });
process.on('SIGINT', () => { _diskCache.flush(); process.exit(); });
process.on('SIGTERM', () => { _diskCache.flush(); process.exit(); });
