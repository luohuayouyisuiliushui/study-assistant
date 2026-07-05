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
import { buildDetailMessages, buildFollowUpMessages,
  STABLE_REVIEW_SYSTEM_PROMPT, STABLE_EXERCISE_GRADING_PROMPT,
  STABLE_WEAK_POINT_PROMPT, ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT } from './learn-prompts.js';
import { updateTopic, addHistory, getTopicHistory, buildLearningProfile, parseExercisesFromDetail } from './learn-store.js';

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

// ═══════════════════════════════════════════════════════
//  EXERCISE & REVIEW FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Generate a concise review for an already-learned knowledge point.
 * Focuses on weak points and provides targeted practice.
 */
export async function generateReview(providerOrConfig, plan, topicId, model = 'gpt-4o-mini') {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');
  if (!topic.detail) throw new Error('该知识点还没有讲解内容，无法生成复习');

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  // Build review context
  const weakPointsList = (topic.weakPoints && topic.weakPoints.length > 0)
    ? topic.weakPoints.join('、')
    : '无明确薄弱点（进行全面回顾）';

  // Collect recent Q&A for this topic (last 5 pairs)
  const history = getTopicHistory(plan, topicId);
  const pairs = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
      pairs.push({ q: history[i].content, a: history[i + 1].content });
      i++;
    }
  }
  const recentQa = pairs.slice(-5).map(p => `用户问: ${p.q}\n助手答: ${p.a.slice(0, 200)}`).join('\n\n');

  const context = [
    '=== 复习上下文 ===',
    '知识点: ' + topic.title,
    '薄弱点: ' + weakPointsList,
    '',
    '=== 原讲解内容 ===',
    topic.detail.slice(0, 8000), // trim to fit context window
    '',
    '=== 近期追问记录 ===',
    recentQa || '无追问记录',
  ].join('\n');

  const messages = [
    { role: 'system', content: STABLE_REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: context },
  ];

  const result = await provider.complete(messages, { maxTokens: 4096, temperature: 0.5 });
  const reviewContent = result.content || '';

  // Save review to topic
  await updateTopic(plan.id, topicId, {
    reviewGenerated: reviewContent,
    reviewUpdatedAt: Date.now(),
  });
  topic.reviewGenerated = reviewContent;
  topic.reviewUpdatedAt = Date.now();

  return reviewContent;
}

/**
 * Grade user's exercise answers using AI.
 * @param {object} providerOrConfig - Provider or config
 * @param {object} plan - Plan object
 * @param {string} topicId - Topic ID
 * @param {Array} userAnswers - [{ exerciseIndex, userAnswer }, ...]
 * @returns {Array} Graded results
 */
export async function gradeExercises(providerOrConfig, plan, topicId, userAnswers) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const provider = _resolveProvider(providerOrConfig);

  // Get exercises from topic or parse from detail
  let exercises = topic.exercises || [];
  if (exercises.length === 0 && topic.detail) {
    exercises = parseExercisesFromDetail(topic.detail);
  }
  // Merge any existing persisted user answers back (defensive: handles edge case
  // where topic.exercises was empty but user had prior partial submissions)
  if (topic.exercises && topic.exercises.length > 0) {
    for (const existing of topic.exercises) {
      if (existing.userAnswer !== null || existing.correct !== null) {
        const match = exercises.find(e => e.id === existing.id);
        if (match) {
          if (existing.userAnswer !== null) match.userAnswer = existing.userAnswer;
          if (existing.correct !== null) match.correct = existing.correct;
        }
      }
    }
  }

  // Prepare grading context
  const exerciseContext = {
    topicTitle: topic.title,
    exercises: exercises.map((ex, i) => ({
      index: i,
      type: ex.type,
      question: ex.question,
      options: ex.options,
      correctAnswer: ex.answer,
      userAnswer: (userAnswers.find(a => a.exerciseIndex === i) || {}).userAnswer || '',
    })),
  };

  const messages = [
    { role: 'system', content: STABLE_EXERCISE_GRADING_PROMPT },
    { role: 'user', content: JSON.stringify(exerciseContext, null, 2) },
  ];

  const result = await provider.complete(messages, {
    maxTokens: 4096,
    temperature: 0.3,
    responseFormat: { type: 'json_object' },
  });

  let gradingResults;
  try {
    gradingResults = JSON.parse(result.content || '{}');
  } catch {
    throw new Error('AI 评分结果格式错误');
  }

  // Update topic exercises with user answers and grading
  if (gradingResults.results && Array.isArray(gradingResults.results)) {
    for (const grade of gradingResults.results) {
      const idx = grade.exerciseIndex;
      if (idx >= 0 && idx < exercises.length) {
        exercises[idx].userAnswer = grade.userAnswer || exercises[idx].userAnswer;
        exercises[idx].correct = grade.correct;
      }
    }
    await updateTopic(plan.id, topicId, { exercises });
    topic.exercises = exercises;
  }

  return gradingResults.results || [];
}

/**
 * Analyze weak points across all done topics.
 * Uses exercise errors + Q&A history to identify specific weak sub-concepts.
 */
export async function analyzeWeakPoints(providerOrConfig, plan, model = 'gpt-4o-mini') {
  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  const doneTopics = plan.topics.filter(t => t.done && t.detail);
  const results = [];

  for (const topic of doneTopics) {
    // Skip if no exercises and no Q&A
    const hasExercises = (topic.exercises && topic.exercises.length > 0);
    const history = getTopicHistory(plan, topic.id);
    const hasQA = history.some(h => h.role === 'user');
    if (!hasExercises && !hasQA) continue;

    // Build analysis context
    const exerciseData = (topic.exercises || []).map(e => ({
      question: e.question,
      type: e.type,
      conceptTag: e.conceptTag,
      userAnswer: e.userAnswer,
      correct: e.correct,
      correctAnswer: e.answer,
    }));

    const qaData = history
      .filter(h => h.role === 'user')
      .slice(-10)
      .map(h => h.content.slice(0, 300));

    const context = {
      topicTitle: topic.title,
      detailExcerpt: topic.detail.slice(0, 3000),
      exercises: exerciseData,
      recentQuestions: qaData,
    };

    const messages = [
      { role: 'system', content: STABLE_WEAK_POINT_PROMPT },
      { role: 'user', content: JSON.stringify(context, null, 2) },
    ];

    try {
      const result = await provider.complete(messages, {
        maxTokens: 2048,
        temperature: 0.3,
        responseFormat: { type: 'json_object' },
      });

      const analysis = JSON.parse(result.content || '{}');
      const weakPointNames = (analysis.weakPoints || [])
        .filter(wp => wp.concept)
        .map(wp => wp.concept);

      if (weakPointNames.length > 0) {
        await updateTopic(plan.id, topic.id, { weakPoints: weakPointNames });
        topic.weakPoints = weakPointNames;
        results.push({ topicTitle: topic.title, weakPoints: weakPointNames });
      }
    } catch (err) {
      console.warn(`[analyzeWeakPoints] Failed for ${topic.title}: ${err.message}`);
    }
  }

  return results;
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
  generateReview,
  gradeExercises,
  analyzeWeakPoints,
  getEngineCacheDiagnostics,
  createProviderFromConfig,
};
