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
import { factCheckQuickScan, buildFactCheckSummary, factCheckDetail, autoFixUncertainClaims, applyFixesToContent, buildFactCheckReport } from './fact-checker.js';
import { AdaptivePromptInjector } from './adaptive-engine.js';
import { getUserProfile } from './user-profile.js';
import { buildDetailMessages, buildFollowUpMessages, buildDeterministicContext,
  STABLE_REVIEW_SYSTEM_PROMPT, STABLE_EXERCISE_GRADING_PROMPT,
  STABLE_WEAK_POINT_PROMPT, FEYNMAN_ANALYSIS_PROMPT,
  ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT, CORE_TOPIC_SYSTEM_PROMPT, QUICK_QUIZ_PROMPT } from './learn-prompts.js';
import { updateTopic, addHistory, getTopicHistory, buildLearningProfile, parseExercisesFromDetail,
  recordTeachingErrors, saveCoreAnalysis } from './learn-store.js';
import { generateExam, gradeExam, generateExamPractice,
  generateBlueprint, generateSingleQuestion, selfCorrectQuestion,
  generateExamStream, evaluateQuestionQuality } from './exam-engine.js';
import { startInteractiveDetail, continueInteractiveDetail, streamInteractiveStart,
  streamInteractiveContinue, revealEmbeddedErrors, examineTeachingErrors,
  decomposeTopic } from './interactive-teacher.js';
import OpenAI from 'openai';
import https from 'https';
import fs from 'fs';
import path from 'path';

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
export function resolveProvider(providerOrConfig, model) {
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

  // Preserve previous content: if regeneration fails, restore it so the
  // user doesn't lose a previously successful generation.
  const previousDetail = topic.detail;

  topic.detail = '';
  topic.done = false;
  topic.lastError = null;
  await updateTopic(plan.id, topicId, { detail: '', done: false, lastError: null });

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  // Auto-warm cache with the prefix we're about to use
  const warmMessages = buildDetailMessages(plan, topicId);
  provider.warmCache(warmMessages);

  try {
    // ── Adaptive personalization: inject user profile into context ──
    const profile = getUserProfile();
    const injector = new AdaptivePromptInjector(profile);
    const adaptiveContext = injector.buildAdaptiveContext();

    let messages = buildDetailMessages(plan, topicId, '请为我详细讲解「' + topic.title + '」。');

    // Inject adaptive guidance between context and question (cache-safe:
    // user profile changes infrequently, so prefix stays stable most of the time)
    if (adaptiveContext && injector.hasMeaningfulProfile) {
      // Append adaptive context to the deterministic context message (messages[1])
      messages[1] = {
        ...messages[1],
        content: messages[1].content + '\n' + adaptiveContext,
      };
    }

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

    // ── Post-generation fact-check (quick scan, fire-and-forget) ──
    factCheckQuickScan(provider, fullContent, topic.title, model).then(result => {
      if (result && result.flagged) {
        const summary = buildFactCheckSummary({
          overallScore: result.flagged ? 0.5 : 0.9,
          verdict: result.flagged ? 'caution' : 'trusted',
          summary: result.issues.map(i => i.problem).join('; '),
          findings: result.issues.map(i => ({ claim: i.claim, verdict: 'uncertain', confidence: 0.4, dimension: 'fact', location: '', explanation: i.problem, correction: '' })),
        });
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: true, issues: result.issues, summary, scannedAt: result.scanTime },
        }).catch(() => {});
      } else {
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: false, issues: [], summary: '✅ 快速扫描未发现明显问题', scannedAt: result?.scanTime || Date.now() },
        }).catch(() => {});
      }
    }).catch(() => {});

    return fullContent;
  } catch (err) {
    console.error('[generateDetail]', err);
    topic.lastError = err.message || '生成失败';
    // On failure, restore previous detail (if any) so user doesn't lose old content.
    // Prefer old complete content over partial new content from a failed stream.
    const detailToSave = previousDetail || topic.detail || null;
    await updateTopic(plan.id, topicId, {
      detail: detailToSave,
      done: false,
      lastError: topic.lastError,
    });
    throw err;
  }
}

/**
 * Generate detail content with SSE streaming events.
 * Accepts a writeEvent callback for real-time chunk delivery.
 * Events: chunk ({ content }), done ({ topicId, detail }), error ({ message })
 * Still persists to store (same as generateDetail), but also streams via SSE.
 */
export async function generateDetailStream(providerOrConfig, plan, topicId, writeEvent, model = 'gpt-4o-mini') {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const previousDetail = topic.detail;

  topic.detail = '';
  topic.done = false;
  topic.lastError = null;
  await updateTopic(plan.id, topicId, { detail: '', done: false, lastError: null });

  const provider = resolveProvider(providerOrConfig, model);

  const warmMessages = buildDetailMessages(plan, topicId);
  provider.warmCache(warmMessages);

  try {
    const profile = getUserProfile();
    const injector = new AdaptivePromptInjector(profile);
    const adaptiveContext = injector.buildAdaptiveContext();

    let messages = buildDetailMessages(plan, topicId, '请为我详细讲解「' + topic.title + '」。');

    if (adaptiveContext && injector.hasMeaningfulProfile) {
      messages[1] = {
        ...messages[1],
        content: messages[1].content + '\n' + adaptiveContext,
      };
    }

    engineCacheMonitor.recordShape(messages, 'generateDetail:' + topicId.slice(0, 8));

    let chunkCount = 0;
    const fullContent = await provider.stream(messages, {
      maxTokens: 8192,
      onChunk: (delta) => {
        topic.detail += delta;
        chunkCount++;
        if (writeEvent) writeEvent({ type: 'chunk', content: delta });
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

    if (writeEvent) writeEvent({ type: 'done', topicId, detail: fullContent });

    factCheckQuickScan(provider, fullContent, topic.title, model).then(result => {
      if (result && result.flagged) {
        const summary = buildFactCheckSummary({
          overallScore: result.flagged ? 0.5 : 0.9,
          verdict: result.flagged ? 'caution' : 'trusted',
          summary: result.issues.map(i => i.problem).join('; '),
          findings: result.issues.map(i => ({ claim: i.claim, verdict: 'uncertain', confidence: 0.4, dimension: 'fact', location: '', explanation: i.problem, correction: '' })),
        });
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: true, issues: result.issues, summary, scannedAt: result.scanTime },
        }).catch(() => {});
      } else {
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: false, issues: [], summary: '✅ 快速扫描未发现明显问题', scannedAt: result?.scanTime || Date.now() },
        }).catch(() => {});
      }
    }).catch(() => {});

    return fullContent;
  } catch (err) {
    console.error('[generateDetailStream]', err);
    topic.lastError = err.message || '生成失败';
    const detailToSave = previousDetail || topic.detail || null;
    await updateTopic(plan.id, topicId, {
      detail: detailToSave,
      done: false,
      lastError: topic.lastError,
    });
    if (writeEvent) writeEvent({ type: 'error', data: err.message });
    throw err;
  }
}

export async function answerFollowUp(providerOrConfig, plan, topicId, question, model = 'gpt-4o-mini') {
  if (!question || !question.trim()) throw new Error('问题不能为空');
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  await addHistory(plan.id, topicId, 'user', question);

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

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

  const result = await provider.complete(messages, { maxTokens: 6144, temperature: 0.7 });

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

/**
 * Analyze a plan's topics to identify the core ~20% using the Pareto principle.
 * Uses AI to determine which topics are most important.
 * Results are cached on the plan for reuse.
 */
export async function analyzeCoreTopics(provider, plan, model = 'gpt-4o-mini', { force = false } = {}) {
  if (!force && plan.coreAnalysis && plan.coreAnalysis.analyzedAt) {
    return {
      coreTopics: plan.coreAnalysis.coreTopics || [],
      summary: plan.coreAnalysis.summary || '',
      corePrinciple: plan.coreAnalysis.corePrinciple || '',
      analyzedAt: plan.coreAnalysis.analyzedAt,
    };
  }

  // Short-circuit for empty plans — no need to call AI
  if (!plan.topics || plan.topics.length < 2) {
    const emptyResult = { coreTopics: [], summary: plan.topics.length === 0 ? '暂无知识点，请先添加' : '知识点太少，至少需要 2 个才能分析核心 20%', corePrinciple: '', analyzedAt: Date.now() };
    try { await saveCoreAnalysis(plan.id, emptyResult); } catch {}
    return emptyResult;
  }

  const context = {
    planName: plan.name,
    phases: (plan.phases || []).map(p => ({ name: p.name })),
    topics: plan.topics.map(t => ({
      id: t.id, title: t.title, phaseId: t.phaseId,
      parentId: t.parentId, done: t.done, hasDetail: !!t.detail,
    })),
  };

  const messages = [
    { role: 'system', content: CORE_TOPIC_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(context, null, 2) },
  ];

  try {
    const result = await provider.complete(messages, {
      maxTokens: 8192,
      temperature: 0.3,
      responseFormat: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(result.content || '{}');
    } catch (parseErr) {
      // Try to recover truncated JSON by extracting the coreTopics array
      const content = result.content || '';
      console.warn('[analyzeCoreTopics] JSON parse failed, content length:', content.length, 'finishReason:', result.finishReason);
      console.warn('[analyzeCoreTopics] Content preview:', content.substring(0, 200));
      const match = content.match(/"coreTopics"\s*:\s*\[([\s\S]*)/);
      if (match) {
        try {
          parsed = { coreTopics: JSON.parse('[' + match[1].replace(/,\s*$/, '') + ']') };
        } catch {
          parsed = {};
        }
      } else {
        parsed = {};
      }
      // Also try to extract summary from the truncated content
      if (!parsed.summary) {
        const summaryMatch = content.match(/"summary"\s*:\s*"([^"]*)/);
        if (summaryMatch) parsed.summary = summaryMatch[1];
      }
    }
    const aiTopics = (parsed.coreTopics || []).filter(t => t.title);

    const coreTopics = aiTopics.map(aiTopic => {
      // Exact match first, then trimmed/normalized fallback
      let matched = plan.topics.find(t => t.title === aiTopic.title);
      if (!matched) {
        const normalized = aiTopic.title.trim().replace(/[，。、；：]/g, '').replace(/\s+/g, ' ');
        matched = plan.topics.find(t => t.title.trim().replace(/[，。、；：]/g, '').replace(/\s+/g, ' ') === normalized);
      }
      if (!matched) {
        console.warn('[analyzeCoreTopics] No match for AI-suggested topic: "' + aiTopic.title + '"');
      }
      return {
        topicId: matched ? matched.id : '',
        title: aiTopic.title,
        reasons: aiTopic.reasons || [],
        importance: aiTopic.importance || 'medium',
        coverage: aiTopic.coverage || '',
      };
    });

    const analysis = {
      coreTopics,
      summary: parsed.summary || '分析完成',
      corePrinciple: parsed.corePrinciple || '',
      analyzedAt: Date.now(),
    };

    // Only cache results with actual core topics — empty results may be transient AI failures
    if (coreTopics.length > 0) {
      try {
        await saveCoreAnalysis(plan.id, analysis);
        plan.coreAnalysis = analysis;
      } catch (storeErr) {
        console.warn('[analyzeCoreTopics] Failed to persist:', storeErr.message);
      }
    }

    return analysis;
  } catch (err) {
    console.warn('[analyzeCoreTopics] AI analysis failed:', err.message || err);
    console.warn('[analyzeCoreTopics] Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    return { coreTopics: [], summary: '核心分析暂不可用（' + (err.message || '未知错误') + '）', corePrinciple: '', analyzedAt: Date.now() };
  }
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

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  // Build review context
  const weakPointsList = (topic.weakPoints && topic.weakPoints.length > 0)
    ? topic.weakPoints.join('、')
    : '无明确薄弱点（进行全面回顾）';

  // Collect exam errors for this topic
  let examErrorsText = '';
  if (plan.examPapers) {
    const examErrors = [];
    for (const exam of plan.examPapers) {
      if (!exam.results || !exam.questions) continue;
      for (const result of exam.results) {
        if (result.correct === false) {
          const q = exam.questions[result.exerciseIndex];
          if (q && q.topicId === topicId) {
            examErrors.push(`【${exam.title}】${q.question}（你的答案：${result.userAnswer}，正确答案：${result.correctAnswer}）`);
          }
        }
      }
    }
    if (examErrors.length > 0) {
      examErrorsText = '\n\n=== 试卷错题 ===\n' + examErrors.join('\n');
    }
  }


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
    examErrorsText,
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

  const provider = resolveProvider(providerOrConfig);

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
  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  const doneTopics = plan.topics.filter(t => t.done && t.detail);
  const results = [];

  // Collect exam errors per topic
  const examErrorsByTopic = {};
  if (plan.examPapers) {
    for (const exam of plan.examPapers) {
      if (!exam.results || !exam.questions) continue;
      for (const result of exam.results) {
        if (result.correct === false) {
          const q = exam.questions[result.exerciseIndex];
          if (q?.topicId) {
            if (!examErrorsByTopic[q.topicId]) examErrorsByTopic[q.topicId] = [];
            examErrorsByTopic[q.topicId].push({
              question: q.question,
              type: q.type,
              userAnswer: result.userAnswer,
              correctAnswer: result.correctAnswer,
              examTitle: exam.title,
              conceptTag: q.conceptTag,
            });
          }
        }
      }
    }
  }

  for (const topic of doneTopics) {
    const hasExercises = (topic.exercises && topic.exercises.length > 0);
    const history = getTopicHistory(plan, topic.id);
    const hasQA = history.some(h => h.role === 'user');
    const hasExamErrors = examErrorsByTopic[topic.id] && examErrorsByTopic[topic.id].length > 0;
    const unrecognizedTeachingErrors = (topic.teachingErrors || []).filter(e => e && e.recognized === false);
    const hasTeachingErrors = unrecognizedTeachingErrors.length > 0;
    if (!hasExercises && !hasQA && !hasExamErrors && !hasTeachingErrors) continue;

    // Build analysis context
    const exerciseData = (topic.exercises || []).map(e => ({
      question: e.question,
      type: e.type,
      conceptTag: e.conceptTag,
      userAnswer: e.userAnswer,
      correct: e.correct,
      correctAnswer: e.answer,
    }));

    const examData = examErrorsByTopic[topic.id] || [];

    const qaData = history
      .filter(h => h.role === 'user')
      .slice(-10)
      .map(h => h.content.slice(0, 300));

    const context = {
      topicTitle: topic.title,
      detailExcerpt: topic.detail.slice(0, 3000),
      exercises: exerciseData,
      examErrors: examData,
      recentQuestions: qaData,
      unrecognizedTeachingErrors: unrecognizedTeachingErrors.map(e => ({ description: e.description, misconception: e.misconception, errorType: e.errorType, bloomLevel: e.bloomLevel })),
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
 * Build a rich, detailed image generation prompt based on the topic title.
 * Uses keyword analysis to determine illustration type and composition.
 */
function buildImagePrompt(title) {
  const lower = (title || '').toLowerCase();

  let illType = 'conceptual diagram';
  let style = 'Modern flat vector illustration, clean minimalist design, soft color palette with pastel blues and greens';
  let composition = 'Center a clear visual representation with supporting elements around it';
  let details = 'Well-structured layout, visually appealing, suitable for academic study notes';

  if (/流程|步骤|过程|workflow|pipeline|flow|build|deploy/.test(lower)) {
    illType = 'process flow diagram';
    composition = 'Left-to-right connected steps with directional arrows, each step as a distinct labeled box';
    details = 'Clear flow direction, sequential numbering, organized pipeline layout';
  } else if (/架构|结构|体系|分层|stack|architecture|layer|hierarchy/.test(lower)) {
    illType = 'architecture diagram';
    composition = 'Layered blocks stacked vertically with connecting lines, each layer distinctly colored and labeled';
    details = 'Clean hierarchical structure, well-organized layers';
  } else if (/对比|区别|vs|versus|比较|comparison|diff/.test(lower)) {
    illType = 'comparison diagram';
    composition = 'Side-by-side layout with two columns, contrasting colors, key attributes listed';
    details = 'Symmetrical balanced layout, clear visual comparison';
  } else if (/网络|连接|通信|protocol|network|connect|link/.test(lower)) {
    illType = 'network diagram';
    composition = 'Interconnected nodes or devices with labeled connection paths, distinct node types';
    details = 'Clean network topology, organized node layout';
  } else if (/编译|部署|构建|交叉|toolchain|compile|cross/.test(lower)) {
    illType = 'development workflow';
    composition = 'Host machine on left, target device on right, transformation arrows between showing compile-link-deploy flow';
    details = 'Clear host-to-target pipeline, developer workstation visualization';
  } else if (/硬件|设备|芯片|电路|board|hardware|chip|embedded/.test(lower)) {
    illType = 'hardware diagram';
    composition = 'Isometric hardware device view with labeled components and annotations around it';
    details = 'Technical hardware representation, clean annotated parts diagram';
  } else if (/编程|代码|语法|函数|class|function|code|variable/.test(lower)) {
    illType = 'code visualization';
    composition = 'Code blocks as colored tokens, flow of execution indicated by arrows, syntax elements visually distinct';
    details = 'Clean code representation with syntax highlighting colors';
  } else if (/调试|排查|错误|debug|error|bug|fix/.test(lower)) {
    illType = 'debug process diagram';
    composition = 'Diagnostic workflow with inspection points, tools, and resolution paths';
    details = 'Clear problem-solving visual flow';
  } else if (/概念|原理|理论|基础|theory|concept|principle/.test(lower)) {
    illType = 'concept mind map';
    composition = 'Central concept with radiating color-coded sub-concepts connected by lines, organized radially';
    details = 'Clean mind map layout, hierarchical concept organization';
  }

  return [
    `Professional educational ${illType} about "${title}".`,
    `${style}.`,
    `${composition}.`,
    `${details}.`,
    'High quality, sharp details, flat vector art style, clean lines.',
    'Light cream or white background, no text errors or typos.',
    'Suitable for printing and digital display, 4K detail level.',
    'No photorealistic humans, no 3D rendering, no dark backgrounds.',
  ].join(' ');
}

/**
 * Generate an illustration for a knowledge point using SiliconFlow API.
 * Calls the text-to-image model, downloads the result, and saves it to server/data/images/.
 * @param {object} topic - The topic object (must have id and title)
 * @param {string} imageApiKey - SiliconFlow API key
 * @param {string} [model] - Image generation model (default: FLUX.1-dev)
 * @returns {Promise<string|null>} The local URL path to the saved image, or null on failure
 */
export async function generateTopicImage(topic, imageApiKey, model) {
  if (!topic?.id || !topic?.title || !imageApiKey) return null;

  const imageModel = model || 'black-forest-labs/FLUX.1-dev';

  // Build a structured prompt based on the topic title
  const prompt = buildImagePrompt(topic.title);

  const imageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'images');
  fs.mkdirSync(imageDir, { recursive: true });

  try {
    const client = new OpenAI({
      apiKey: imageApiKey,
      baseURL: 'https://api.siliconflow.cn/v1',
      maxRetries: 2,
      timeout: 60_000,
    });

    const response = await client.images.generate({
      model: imageModel,
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'url',
    });

    const imageUrl = response.data?.[0]?.url;
    if (!imageUrl) {
      console.warn('[generateTopicImage] No image URL returned');
      return null;
    }

    // Download the image from the temporary URL
    const safeName = topic.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
    const localPath = path.join(imageDir, safeName);

    await new Promise((resolve, reject) => {
      https.get(imageUrl, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }
        const fileStream = fs.createWriteStream(localPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
        fileStream.on('error', reject);
      }).on('error', reject);
    });

    const relativePath = '/images/' + safeName;
    console.log('[generateTopicImage] Saved:', relativePath);
    return relativePath;
  } catch (err) {
    console.warn('[generateTopicImage] Failed:', err.message);
    return null;
  }
}

/**
 * Generate a detail + illustration for a topic (combines text and image generation).
 */
export async function generateDetailWithImage(providerOrConfig, plan, topicId, imageApiKey, model = 'gpt-4o-mini', imageModel) {
  // First generate the text detail
  const content = await generateDetail(providerOrConfig, plan, topicId, model);

  // Then generate an illustration (fire-and-forget on the image, don't block)
  const topic = plan.topics.find(t => t.id === topicId);
  if (topic && imageApiKey) {
    generateTopicImage(topic, imageApiKey, imageModel).then(imageUrl => {
      if (imageUrl && topic) {
        updateTopic(plan.id, topicId, { imageUrl });
      }
    });
  }

  return content;
}

// ═══════════════════════════════════════════════════════

/**
 * JSON Schema validation for LLM outputs.
 * Returns null if valid, or an error message string if invalid.
 */

/** Validate blueprint output */
function validateBlueprintOutput(data) {
  if (!data || typeof data !== 'object') return '输出不是有效对象';
  if (!data.title || typeof data.title !== 'string') return '缺少 title 字段';
  if (!Array.isArray(data.orders) || data.orders.length === 0) return 'orders 必须是数组且不为空';
  for (let i = 0; i < data.orders.length; i++) {
    const o = data.orders[i];
    if (typeof o.index !== 'number') return `orders[${i}].index 必须是数字`;
    if (!o.topicTitle || typeof o.topicTitle !== 'string') return `orders[${i}].topicTitle 必须是字符串`;
    if (!['choice', 'open'].includes(o.type)) return `orders[${i}].type 必须是 choice 或 open，得到 "${o.type}"`;
    if (!['easy', 'medium', 'hard'].includes(o.difficulty)) return `orders[${i}].difficulty 必须是 easy/medium/hard，得到 "${o.difficulty}"`;
  }
  return null;
}

/** Validate single question output */
function validateQuestionOutput(data) {
  if (!data || typeof data !== 'object') return '输出不是有效对象';
  if (!data.question || typeof data.question !== 'string') return 'question 字段缺失或非字符串';
  if (!Array.isArray(data.options)) return 'options 必须是数组';
  if (!data.answer || typeof data.answer !== 'string') return 'answer 字段缺失或非字符串';
  if (!data.explanation || typeof data.explanation !== 'string') return 'explanation 字段缺失或非字符串';
  if (!data.conceptTag || typeof data.conceptTag !== 'string') return 'conceptTag 字段缺失或非字符串';
  // Choice questions should have 4 options
  if (data.options.length > 0) {
    for (let i = 0; i < data.options.length; i++) {
      if (!data.options[i] || typeof data.options[i] !== 'string') return `options[${i}] 不是有效字符串`;
    }
  }
  return null;
}

/** Validate self-correction output */
function validateSelfCorrectOutput(data) {
  if (!data || typeof data !== 'object') return '输出不是有效对象';
  if (!data.studentAnswer || typeof data.studentAnswer !== 'string') return 'studentAnswer 字段缺失或非字符串';
  // reasoning is optional
  return null;
}
// ═══════════════════════════════════════════════════════
//  SILICONFLOW TTS (Text-to-Speech)
// ═══════════════════════════════════════════════════════

/**
 * Text-to-speech: synthesize speech using SiliconFlow CosyVoice2.
 * @param {string} apiKey - SiliconFlow API key
 * @param {string} text - Text to synthesize
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function textToSpeech(apiKey, text) {
  if (!apiKey) throw new Error('请先配置 API Key');
  if (!text || !text.trim()) throw new Error('请输入要合成的文本');

  const response = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: text.slice(0, 2000),
      voice: 'default',
      response_format: 'mp3',
      speed: 1.0,
    }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`TTS 请求失败 (${response.status}): ${errBody.slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export function getEngineCacheDiagnostics() {
  return engineCacheMonitor.summary();
}

/**
 * Generate a lightweight quick quiz (2-3 questions) from random topics in a plan.
 * Uses fewer tokens than a full exam paper.
 * @param {object} provider - Provider instance
 * @param {object} plan - Plan object
 * @param {string} model - Model name
 * @returns {Promise<{questions: Array, topicCount: number}>}
 */
export async function generateQuickQuiz(provider, plan, model = 'gpt-4o-mini') {
  const doneTopics = plan.topics.filter(t => t.done && t.detail);
  const available = doneTopics.length > 0 ? doneTopics : plan.topics;

  if (available.length === 0) {
    return { questions: [], topicCount: 0, message: '暂无知识点' };
  }

  // Build a compact context with topic titles + detail excerpts
  const context = {
    planName: plan.name,
    topics: available.slice(0, 15).map(t => ({
      title: t.title,
      detailExcerpt: (t.detail || '').slice(0, 500),
    })),
  };

  const messages = [
    { role: 'system', content: QUICK_QUIZ_PROMPT },
    { role: 'user', content: JSON.stringify(context, null, 2) },
  ];

  try {
    const result = await provider.complete(messages, {
      maxTokens: 2048,
      temperature: 0.7,
      responseFormat: { type: 'json_object' },
    });

    const parsed = JSON.parse(result.content || '{}');
    return {
      questions: parsed.questions || [],
      topicCount: available.length,
    };
  } catch (err) {
    console.warn('[generateQuickQuiz] AI failed:', err.message);
    return { questions: [], topicCount: available.length, error: err.message };
  }
}

/**
 * Analyze a Feynman interactive session transcript and extract insights.
 */
export async function analyzeFeynmanSession(provider, transcript, topicTitle) {
  const transcriptText = transcript
    .map(msg => {
      const role = msg.role === 'ai' ? '【AI学生】' : '【用户老师】';
      return role + '\n' + msg.content;
    })
    .join('\n\n---\n\n');

  const messages = [
    { role: 'system', content: FEYNMAN_ANALYSIS_PROMPT },
    { role: 'user', content: '知识点：' + topicTitle + '\n\n对话记录：\n' + transcriptText },
  ];

  try {
    const result = await provider.complete(messages, {
      maxTokens: 2048,
      temperature: 0.3,
      responseFormat: { type: 'json_object' },
    });
    const parsed = JSON.parse(result.content || '{}');
    return {
      lingeringQuestions: parsed.lingeringQuestions || [],
      teachingQuality: parsed.teachingQuality || 'unknown',
      strengths: parsed.strengths || [],
      gaps: parsed.gaps || [],
      sparklingExplanations: parsed.sparklingExplanations || [],
      summary: parsed.summary || '',
    };
  } catch (err) {
    console.warn('[analyzeFeynmanSession] AI failed:', err.message);
    return { lingeringQuestions: [], teachingQuality: 'unknown', strengths: [], gaps: [], sparklingExplanations: [], summary: '' };
  }
}

export default {
  generateDetail,
  generateDetailWithImage,
  generateTopicImage,
  answerFollowUp,
  answerAnalysisFollowUp,
  analyzeLearning,
  generateReview,
  gradeExercises,
  analyzeWeakPoints,
  generateExam,
  gradeExam,
  generateExamPractice,
  generateBlueprint,
  generateSingleQuestion,
  selfCorrectQuestion,
  generateExamStream,
  evaluateQuestionQuality,
  startInteractiveDetail,
  continueInteractiveDetail,
  revealEmbeddedErrors,
  examineTeachingErrors,
  decomposeTopic,
  generateQuickQuiz,
  analyzeFeynmanSession,
  textToSpeech,
  getEngineCacheDiagnostics,
  createProviderFromConfig,
  // Fact-check engine (re-exported from fact-checker.js)
  factCheckDetail,
  factCheckQuickScan,
  autoFixUncertainClaims,
  applyFixesToContent,
  buildFactCheckReport,
  buildFactCheckSummary,
};

export {
  applyFixesToContent,
  autoFixUncertainClaims,
  buildFactCheckReport,
  buildFactCheckSummary,
  factCheckDetail,
  factCheckQuickScan,
};

export {
  generateExam, gradeExam, generateExamPractice, generateExamStream,
  generateBlueprint, generateSingleQuestion, selfCorrectQuestion,
  evaluateQuestionQuality,
} from './exam-engine.js';

export {
  startInteractiveDetail, continueInteractiveDetail, streamInteractiveStart,
  streamInteractiveContinue, revealEmbeddedErrors, examineTeachingErrors,
  decomposeTopic,
} from './interactive-teacher.js';
