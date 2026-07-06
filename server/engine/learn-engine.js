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
import { buildDetailMessages, buildFollowUpMessages, buildDeterministicContext,
  STABLE_REVIEW_SYSTEM_PROMPT, STABLE_EXERCISE_GRADING_PROMPT,
  STABLE_WEAK_POINT_PROMPT, STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT, STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT, STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT,
  ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT } from './learn-prompts.js';
import { updateTopic, addHistory, getTopicHistory, buildLearningProfile, parseExercisesFromDetail } from './learn-store.js';
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

// ═══════════════════════════════════════════════════════
//  INTERACTIVE MODE: stepwise section-by-section + realtime
// ═══════════════════════════════════════════════════════

/**
 * Explicit teaching phases for stepwise mode (state machine steps).
 * Used by both engine code and injected into AI context for structured state awareness.
 */
const STEPWISE_PHASES = [
  { id: 'core_concept', name: '核心概念讲解' },
  { id: 'why_important', name: '为什么重要' },
  { id: 'deep_dive', name: '详细原理' },
  { id: 'code_example', name: '代码/示例' },
  { id: 'common_pitfalls', name: '常见坑/注意事项' },
  { id: 'practice', name: '练习题' },
];

/**
 * Build a state machine snapshot for an interactive session.
 */
function _buildStateMachineSnapshot(session) {
  if (!session?.stateMachine) return '';
  const sm = session.stateMachine;
  const current = sm.steps[sm.currentStep] || sm.steps[0];
  const completed = sm.steps.filter(s => s.status === 'completed').length;
  let result = `【教学进度】已完成 ${completed}/${sm.totalSteps} 步\n`;
  result += `当前阶段：${current.name}（第 ${sm.currentStep + 1}/${sm.totalSteps} 步）\n`;
  if (current.retryCount > 0) {
    result += `⚠️ 当前步骤已重新讲解 ${current.retryCount} 次\n`;
  }
  result += '步骤列表：\n';
  sm.steps.forEach((s, i) => {
    const marker = s.status === 'completed' ? '✅' : s.status === 'active' ? '▶️' : s.status === 'skipped' ? '⏭️' : '⏳';
    result += `  ${marker} ${i + 1}. ${s.name}`;
    if (s.retryCount > 0 && s.status !== 'completed') {
      result += ` (已重试${s.retryCount}次)`;
    }
    result += '\n';
  });
  result += `会话状态：${session.status === 'waiting_user' ? '等待你的回应' : session.status === 'ai_thinking' ? 'AI 正在思考' : session.status === 'completed' ? '已完成' : '进行中'}`;
  return result;
}

/**
 * Initialize state machine for a new stepwise interactive session.
 */
function _initStateMachine(mode) {
  if (mode !== 'stepwise') return null;
  return {
    totalSteps: STEPWISE_PHASES.length,
    currentStep: 0,
    steps: STEPWISE_PHASES.map((p, i) => ({
      ...p,
      status: i === 0 ? 'active' : 'pending',
      retryCount: 0,
    })),
  };
}

/**
 * Advance the state machine one step forward.
 * Returns true if there are more steps, false if completed.
 */
function _advanceStateMachine(session) {
  const sm = session.stateMachine;
  if (!sm) return false;
  // Mark current as completed
  if (sm.steps[sm.currentStep]) {
    sm.steps[sm.currentStep].status = 'completed';
  }
  // Advance to next
  const nextIndex = sm.currentStep + 1;
  if (nextIndex < sm.totalSteps) {
    sm.currentStep = nextIndex;
    sm.steps[nextIndex].status = 'active';
    return true;
  }
  return false; // No more steps
}

/**
 * Skip the current step (mark as skipped) and advance to the next.
 */
function _skipStep(session) {
  const sm = session.stateMachine;
  if (!sm) return false;
  if (sm.steps[sm.currentStep]) {
    sm.steps[sm.currentStep].status = 'skipped';
  }
  const nextIndex = sm.currentStep + 1;
  if (nextIndex < sm.totalSteps) {
    sm.currentStep = nextIndex;
    sm.steps[nextIndex].status = 'active';
    return true;
  }
  return false;
}

/**
 * Get the interactive system prompt by mode.
 */
function _getInteractivePrompt(mode) {
  if (mode === 'realtime') return STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT;
  if (mode === 'challenge') return STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT;
  if (mode === 'scaffold') return STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT;
  return STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT;
}

/**
 * Build a compact transcript string from the interactive session.
 */
function _buildInteractiveTranscript(session, maxLength = 6000) {
  if (!session?.transcript || session.transcript.length === 0) return '';
  const lines = session.transcript.map((entry) => {
    const roleMap = { user: '用户', ai: '导师', system: '系统' };
    const role = roleMap[entry.role] || '其他';
    const content = entry.content.length > 1500 ? entry.content.slice(0, 1500) + '...' : entry.content;
    return `${role}：${content}`;
  });
  let transcript = lines.join('\n\n---\n\n');
  if (transcript.length > maxLength) {
    transcript = '...（前面的对话摘要略）...\n' + transcript.slice(-maxLength);
  }
  return transcript;
}

/**
 * Start an interactive explanation session.
 * Generates the FIRST section/chunk of content.
 */
export async function startInteractiveDetail(providerOrConfig, plan, topicId, mode = 'stepwise', model) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'challenge' ? '考验模式' : mode === 'scaffold' ? '脚手架引导' : '半实时分段讲解';

  const context = buildDeterministicContext(plan, topicId);
  const stateMachine = _initStateMachine(mode);
  const stateSnapshot = stateMachine ? _buildStateMachineSnapshot({ stateMachine }) : '';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: context },
    { role: 'user', content: `请开始${promptName}模式。先讲解核心概念，作为第一部分的讲解内容。知识点：「${topic.title}」\n\n注意：只输出第一部分内容，不要一次性讲完所有内容。这部分讲完后给出下一步选项，等待我的反馈。\n\n${stateSnapshot}` },
  ];

  const fullContent = await provider.stream(messages, { maxTokens: 2048 });
  if (!fullContent) throw new Error('AI 返回内容为空');

  const session = {
    mode,
    status: 'waiting_user',
    finished: false,
    transcript: [{ role: 'ai', content: fullContent }],
    stateMachine,
  };

  topic.interactiveSession = session;
  await updateTopic(plan.id, topicId, { interactiveSession: session });

  return { content: fullContent, session };
}

/**
 * Continue an interactive explanation session based on user feedback.
 */
export async function continueInteractiveDetail(providerOrConfig, plan, topicId, mode, feedback, model) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  // Initialize or re-open session if it doesn't exist or was finished
  if (!topic.interactiveSession) {
    throw new Error('当前没有互动讲解会话，请先点击「分段讲解」或「实时互动」开始');
  }
  const session = topic.interactiveSession;
  if (session.finished) {
    session.finished = false; // re-open for continued questions
  }

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'challenge' ? '考验模式' : mode === 'scaffold' ? '脚手架引导' : '半实时分段讲解';

  session.transcript.push({ role: 'user', content: feedback });
  session.status = 'ai_thinking';

  const context = buildDeterministicContext(plan, topicId);
  const transcriptText = _buildInteractiveTranscript(session);

  // State machine logic for stepwise mode
  if (mode === 'stepwise') {
    const currentStep = session.stateMachine?.steps[session.stateMachine?.currentStep];
    if (/^跳过/.test(feedback.trim())) {
      _skipStep(session);
    } else if (/^继续/.test(feedback.trim())) {
      _advanceStateMachine(session);
    } else if (currentStep && currentStep.status === 'active') {
      // User asked for re-explanation or other feedback on current step
      currentStep.retryCount = (currentStep.retryCount || 0) + 1;
    }
  }

  const stateSnapshot = _buildStateMachineSnapshot(session);

  const continuationInstruction = (
    `我们正在进行「${topic.title}」的${promptName}模式。\n\n` +
    `${stateSnapshot}\n\n` +
    `### 到目前为止的对话记录\n` +
    `${transcriptText}\n\n` +
    `### 用户的最新反馈\n` +
    `用户说：${feedback}\n\n` +
    `请根据对话记录和用户的最新反馈，继续你的教学。` +
    `如果是分段讲解模式，按计划讲下一部分或根据反馈调整。` +
    `如果是实时讲解模式，根据用户的反应灵活继续。` +
    `注意：每次只输出当前步骤的内容，在末尾给出下一步选项。`
  );

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: context },
    { role: 'user', content: continuationInstruction },
  ];

  const fullContent = await provider.stream(messages, { maxTokens: 2048 });
  if (!fullContent) throw new Error('AI 返回内容为空');

  session.transcript.push({ role: 'ai', content: fullContent });

  session.status = 'waiting_user';

  // Detect session end via explicit marker (set in system prompt)
  if (/\[SESSION_END\]/.test(fullContent)) {
    session.finished = true;
    session.status = 'completed';
  }

  topic.interactiveSession = session;
  await updateTopic(plan.id, topicId, { interactiveSession: session });

  return { content: fullContent, session, finished: session.finished, status: session.status };
}

// ═══════════════════════════════════════════════════════
//  CHALLENGE: reveal embedded errors on completion
// ═══════════════════════════════════════════════════════

/**
 * Analyze generated detail content for intentionally subtle errors.
 * Called when user clicks \"学完了\" to reveal any missed errors.
 */
export async function revealEmbeddedErrors(providerOrConfig, plan, topicId, model) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');
  if (!topic.detail) return { errors: [], hasErrors: false };

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  const prompt =
    '你是一位学习内容审查专家。以下是一篇AI生成的讲解内容。请仔细检查其中是否有故意埋下的微妙错误。\n\n' +
    '注意：\n' +
    '- 有些错误是AI故意加入来考验学习者的（如边界条件偏差、概念近似但不精确、逻辑陷阱等）\n' +
    '- 有些内容是完全正确的\n' +
    '- 你的任务是识别出所有**可能是故意埋下的错误**\n\n' +
    '请以JSON格式返回：{"errors": [{"location": "错误所在章节", "description": "错误描述", "correction": "正确版本", "type": "边界条件|概念偏差|逻辑陷阱|代码错误"}], "hasErrors": true/false}\n\n' +
    '讲解内容：\n\n' + topic.detail.slice(0, 10000);

  const messages = [
    { role: 'system', content: '你是一位严格但友好的学习内容审查专家。只输出JSON。' },
    { role: 'user', content: prompt },
  ];

  try {
    const result = await provider.complete(messages, { maxTokens: 2048, temperature: 0.3, responseFormat: { type: 'json_object' } });
    const parsed = JSON.parse(result.content || '{}');
    return {
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      hasErrors: parsed.hasErrors === true && Array.isArray(parsed.errors) && parsed.errors.length > 0,
    };
  } catch (err) {
    console.warn('[revealEmbeddedErrors] Analysis failed:', err?.message);
    return { errors: [], hasErrors: false };
  }
}

// ═══════════════════════════════════════════════════════
//  SCAFFOLD: decompose a topic into sub-topics
// ═══════════════════════════════════════════════════════

/**
 * Decompose a knowledge point into 3-5 sub-topics using AI.
 * Returns an array of sub-topic titles for creating child topics.
 */
export async function decomposeTopic(providerOrConfig, plan, topicId, model) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const context = buildDeterministicContext(plan, topicId);

  const prompt =
    `请将知识点「${topic.title}」分解为 3-6 个递进的子知识点，从基础到深入排列。\n\n` +
    `要求：\\n` +
    `1. 子知识点应该是可独立学习的单元\\n` +
    `2. 从易到难排列，前1-2个是基础概念，中间是核心内容，最后1个是进阶内容\\n` +
    `3. 每个子知识点用一句话概括其核心内容\\n` +
    `4. 不要重复父知识点标题中的词语\\n\\n` +
    `以JSON格式返回：{\"subtopics\": [{\"title\": \"子知识点名称\", \"summary\": \"一句话概括\", \"order\": 1}]}\\n\\n` +
    `学习上下文：\\n${context}`;

  const messages = [
    { role: 'system', content: '你是一位课程设计专家，擅长将复杂知识分解为递进的学习单元。只输出JSON。' },
    { role: 'user', content: prompt },
  ];

  try {
    const result = await provider.complete(messages, { maxTokens: 2048, temperature: 0.4, responseFormat: { type: 'json_object' } });
    const parsed = JSON.parse(result.content || '{}');
    const subtopics = Array.isArray(parsed.subtopics) ? parsed.subtopics : [];
    return subtopics.map((s, i) => ({
      title: (typeof s === 'string' ? s : s.title || s.name || '') || '子知识点' + (i + 1),
      summary: s.summary || '',
      order: i + 1,
    })).filter(s => s.title);
  } catch {
    return [];
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
  startInteractiveDetail,
  continueInteractiveDetail,
  revealEmbeddedErrors,
  decomposeTopic,
  textToSpeech,
  getEngineCacheDiagnostics,
  createProviderFromConfig,
};

