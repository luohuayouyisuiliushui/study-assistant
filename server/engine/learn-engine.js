/**
 * Core engine: generates detailed knowledge-point content using AI.
 *
 * === CACHE-OPTIMIZED ARCHITECTURE ===
 *
 * Instead of building a fresh system prompt per call (which changes the
 * entire prefix and guarantees a cache miss), we use:
 *
 * 1. STABLE system prompts — perfectly fixed persona strings
 * 2. DETERMINISTIC context digest — same state → same output
 * 3. Cache-aware Provider — tracks hit/miss, retry, diagnostics
 *
 * This means generateDetail() for the SAME topic on the SAME plan
 * will produce IDENTICAL first-2-messages = HIGH cache hit rate.
 */

import { Provider } from './provider.js';
import { CacheMonitor } from './cache-diagnostics.js';
import { buildDetailMessages, buildFollowUpMessages } from './learn-prompts.js';
import { updateTopic, addHistory, getTopicHistory, buildLearningProfile } from './learn-store.js';

/**
 * Global cache monitor for this process.
 * Exposed so routes can report diagnostics to users.
 */
export const engineCacheMonitor = new CacheMonitor();

/**
 * Get or create a Provider. Uses composite key to ensure different
 * API keys, base URLs, or models get separate provider instances.
 */
const _providerCache = new Map();

/**
 * Resolve a Provider from either a Provider instance or config-like object.
 * When a Provider is passed directly, returns it as-is.
 * When an OpenAI-like object (with apiKey, baseURL) is passed, creates/returns cached Provider.
 */
function _resolveProvider(providerOrConfig, model) {
  // Already a Provider instance — use directly
  if (providerOrConfig instanceof Provider) {
    return providerOrConfig;
  }
  // Legacy: OpenAI-like object with apiKey/baseURL
  const key = (providerOrConfig.apiKey || '') + '::' + (providerOrConfig.baseURL || '') + '::' + (model || '');
  if (!_providerCache.has(key)) {
    const provider = new Provider({
      apiKey: providerOrConfig.apiKey,
      baseURL: providerOrConfig.baseURL,
      model,
      debugCache: process.env.DEBUG_CACHE === 'true',
    });
    _providerCache.set(key, provider);
  }
  return _providerCache.get(key);
}

/**
 * Create a Provider from individual config values.
 * Shared between engine and routes layer for consistency.
 */
export function createProviderFromConfig(apiKey, baseURL, model) {
  const key = (apiKey || '') + '::' + (baseURL || '') + '::' + (model || '');
  if (!_providerCache.has(key)) {
    const provider = new Provider({
      apiKey,
      baseURL,
      model,
      debugCache: process.env.DEBUG_CACHE === 'true',
    });
    _providerCache.set(key, provider);
  }
  return _providerCache.get(key);
}

// ─── Public API ───

/**
 * Generate detailed explanation for a knowledge point.
 *
 * CACHE BEHAVIOR:
 * - First 2 messages (system + context) are IDENTICAL for same topic + plan
 * - Only the user question at the end varies per-session
 * - Provider tracks cache hit/miss tokens automatically
 */
export async function generateDetail(providerOrConfig, plan, topicId, model = 'gpt-4o-mini') {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  topic.detail = '';
  topic.done = false;
  topic.lastError = null;
  await updateTopic(plan.id, topicId, { detail: '', done: false, lastError: null });

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  // Auto-warm cache with the prefix we're about to use
  const warmMessages = buildDetailMessages(plan, topicId);
  provider.warmCache(warmMessages);

  try {
    const messages = buildDetailMessages(plan, topicId, '请为我详细讲解「' + topic.title + '」。');

    engineCacheMonitor.recordShape(messages, 'generateDetail:' + topicId.slice(0, 8));

    let chunkCount = 0;
    const fullContent = await provider.stream(messages, {
      maxTokens: 8192,
      onChunk: (delta) => {
        topic.detail += delta;
        chunkCount++;
        if (chunkCount % 20 === 0) {
          updateTopic(plan.id, topicId, { detail: topic.detail });
        }
      },
      onUsage: (usage) => {
        engineCacheMonitor.recordUsage(usage, 'generateDetail:' + topicId.slice(0, 8));
      },
    });

    if (!fullContent) throw new Error('AI 返回内容为空');

    topic.done = true;
    await updateTopic(plan.id, topicId, { detail: fullContent, done: true, lastError: null });
    await addHistory(plan.id, topicId, 'ai', fullContent);

    return fullContent;
  } catch (err) {
    console.error('[generateDetail]', err);
    topic.lastError = err.message || '生成失败';
    topic.done = true;
    await updateTopic(plan.id, topicId, {
      detail: topic.detail || null,
      done: true,
      lastError: topic.lastError,
    });
    throw err;
  }
}

/**
 * Answer a follow-up question about a knowledge point.
 *
 * CACHE BEHAVIOR:
 * - If user asks the same question again (retry), first 2 messages are identical
 * - If plan state hasn't changed, first 2 messages are identical
 */
export async function answerFollowUp(providerOrConfig, plan, topicId, question, model = 'gpt-4o-mini') {
  if (!question || !question.trim()) throw new Error('问题不能为空');
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  await addHistory(plan.id, topicId, 'user', question);

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  try {
    const messages = buildFollowUpMessages(plan, topicId, question);

    engineCacheMonitor.recordShape(messages, 'answerFollowUp:' + topicId.slice(0, 8));

    const result = await provider.complete(messages, {
      maxTokens: 4096,
    });

    engineCacheMonitor.recordUsage(result.usage, 'answerFollowUp:' + topicId.slice(0, 8));

    const answer = result.content || '（无法生成回复）';
    await addHistory(plan.id, topicId, 'ai', answer);
    return answer;
  } catch (err) {
    console.error('[answerFollowUp]', err);
    const errMsg = '回答失败: ' + err.message;
    await addHistory(plan.id, topicId, 'ai', errMsg);
    throw err;
  }
}

/**
 * Analyze learning progress and generate personalized insights using AI.
 * Combines structured learning profile + Q&A history for deep analysis.
 */
export async function analyzeLearning(provider, plan, model = 'gpt-4o-mini', analysisChat = []) {
  const profile = buildLearningProfile(plan);

  // Collect recent Q&A per topic (up to 3 most recent questions each)
  const topicQAs = [];
  for (const topic of plan.topics) {
    const history = (plan.history || []).filter(h => h.topicId === topic.id);
    const pairs = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
        pairs.push({ q: history[i].content.slice(0, 300), a: '...' });
        i++;
      }
    }
    if (pairs.length > 0) {
      topicQAs.push({
        topic: topic.title,
        done: topic.done,
        questionCount: pairs.length,
        recentQuestions: pairs.slice(-3).map(p => p.q),
      });
    }
  }

  const analysisData = JSON.stringify({ profile, topicQAs }, null, 2);
  const { ANALYSIS_SYSTEM_PROMPT } = await import('./learn-prompts.js');
  let userContent = '以下是我的学习数据，请进行分析：\n\n```json\n' + analysisData + '\n```';

  // Include previous analysis chat as subjective data context
  if (analysisChat && analysisChat.length > 0) {
    const chatLog = analysisChat
      .filter(m => m.role && m.content)
      .map(m => (m.role === 'user' ? '用户: ' : '助手: ') + m.content.slice(0, 500))
      .join('\n');
    userContent += '\n\n## 之前的分析追问记录（主观数据）\n\n' + chatLog;
    userContent += '\n\n（注：以上是用户对上一次分析报告的追问记录，属于主观数据，请按分析原则区分对待）';
  }

  const messages = [
    { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const result = await provider.complete(messages, { maxTokens: 4096, temperature: 0.7 });

  return {
    analysis: result.content,
    usage: result.usage,
    analyzedAt: Date.now(),
    topicCount: plan.topics.length,
    doneCount: plan.topics.filter(t => t.done).length,
    totalQuestions: plan.history.filter(h => h.role === 'user').length,
  };
}

/**
 * Answer a follow-up question about a learning analysis.
 */
export async function answerAnalysisFollowUp(provider, plan, analysis, question, model) {
  const { ANALYSIS_FOLLOWUP_PROMPT } = await import('./learn-prompts.js');
  const analysisData = JSON.stringify({
    profile: buildLearningProfile(plan),
    planName: plan.name,
    topicCount: plan.topics.length,
    doneCount: plan.topics.filter(t => t.done).length,
  }, null, 2);

  const messages = [
    { role: 'system', content: ANALYSIS_FOLLOWUP_PROMPT },
    { role: 'user', content: '## 学习分析报告\n\n' + analysis },
    { role: 'user', content: '## 学习数据\n\n```json\n' + analysisData + '\n```' },
    { role: 'user', content: '## 我的追问\n\n' + question },
  ];

  return provider.complete(messages, { maxTokens: 2048, temperature: 0.7, model });
}

/**
 * Get cache diagnostics for the engine.
 */
export function getEngineCacheDiagnostics() {
  return engineCacheMonitor.summary();
}

export default {
  generateDetail,
  answerFollowUp,
  answerAnalysisFollowUp,
  analyzeLearning,
  getEngineCacheDiagnostics,
  createProviderFromConfig,
};
