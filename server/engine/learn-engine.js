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
  STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT, STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT, STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT, STABLE_INTERACTIVE_FEYNMAN_SYSTEM_PROMPT,
  ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT, QUICK_QUIZ_PROMPT } from './learn-prompts.js';
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
 * Tool definition for HITL pause mechanism.
 * AI calls this tool at each logical breakpoint to pause and wait for user feedback.
 */
const ASK_USER_TO_CONTINUE_TOOL = {
  type: 'function',
  function: {
    name: 'ask_user_to_continue',
    description: 'Call this when you finish a logical section of your explanation. Pause and wait for the user to respond before continuing to the next section.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what was just explained in this section (1-2 sentences)'
        }
      },
      required: ['summary']
    }
  }
};

/**
 * Initialize a lightweight dynamic state machine for stepwise mode.
 * No predefined phases — steps are counted dynamically as tool calls arrive.
 */
function _initDynamicStateMachine() {
  return {
    completedSteps: 0,
    currentStep: 0,
    totalSteps: 0,
  };
}

/**
 * Advance the dynamic state machine by one step.
 */
function _advanceDynamicStateMachine(sm) {
  if (!sm) return;
  sm.completedSteps = (sm.completedSteps || 0) + 1;
  sm.currentStep = sm.completedSteps;
  sm.totalSteps = Math.max(sm.totalSteps, sm.completedSteps + 1);
}

/**
 * Build a state machine snapshot for the AI context.
 */
function _buildStateMachineSnapshot(session) {
  if (!session?.stateMachine) return '';
  const sm = session.stateMachine;
  return `【教学进度】已完成 ${sm.completedSteps} 部分，即将进入第 ${sm.completedSteps + 1} 部分`;
}

/**
 * Get the interactive system prompt by mode.
 */
function _getInteractivePrompt(mode) {
  if (mode === 'realtime') return STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT;
  if (mode === 'challenge') return STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT;
  if (mode === 'scaffold') return STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT;
  if (mode === 'feynman') return STABLE_INTERACTIVE_FEYNMAN_SYSTEM_PROMPT;
  return STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT;
}

/**
 * Build a compact transcript string from the interactive session.
 * Used only for non-stepwise modes (realtime, challenge, scaffold).
 */
function _buildInteractiveTranscript(session, maxLength = 6000) {
  if (!session?.transcript || session.transcript.length === 0) return '';
  const lines = session.transcript.map((entry) => {
    const roleMap = { user: '用户', ai: '导师', system: '系统', tool: '用户反馈' };
    const role = roleMap[entry.role] || '其他';
    const content = entry.content && entry.content.length > 1500 ? entry.content.slice(0, 1500) + '...' : (entry.content || '');
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
 * Stepwise mode uses provider.complete() with tool calling for HITL pauses.
 * Other modes use provider.stream() with text-based transcripts.
 */
export async function startInteractiveDetail(providerOrConfig, plan, topicId, mode = 'stepwise', model) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'challenge' ? '考验模式' : mode === 'scaffold' ? '脚手架引导' : mode === 'feynman' ? '费曼学习法' : '半实时分段讲解';

  const context = buildDeterministicContext(plan, topicId);
  const stateMachine = mode === 'stepwise' ? _initDynamicStateMachine() : null;

  if (mode === 'stepwise') {
    // ── Stepwise mode: use provider.complete() with tool calling ──
    const stateSnapshot = _buildStateMachineSnapshot({ stateMachine });
    const initialRequest = `请开始${promptName}模式，讲解知识点：「${topic.title}」。\n\n${stateSnapshot}\n\n先讲授第一个部分的内容，讲完后务必调用 ask_user_to_continue 工具暂停，等待我的反馈再继续。`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
      { role: 'user', content: initialRequest },
    ];

    const result = await provider.complete(messages, {
      maxTokens: 4096,
      tools: [ASK_USER_TO_CONTINUE_TOOL],
      tool_choice: 'auto',
    });

    if (!result.content && !result.tool_calls) throw new Error('AI 返回内容为空');

    const assistantMsg = { role: 'assistant', content: result.content || '' };
    if (result.tool_calls) {
      assistantMsg.tool_calls = result.tool_calls;
      _advanceDynamicStateMachine(stateMachine);
    }

    const session = {
      mode,
      status: result.tool_calls ? 'waiting_user' : 'completed',
      finished: !result.tool_calls,
      initialRequest,
      transcript: [assistantMsg],
      stateMachine,
    };

    topic.interactiveSession = session;
    await updateTopic(plan.id, topicId, { interactiveSession: session });

    return { content: result.content || '', tool_calls: result.tool_calls || null, session };
  }

  // ── Other modes: keep the streaming approach ──
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: context },
    { role: 'user', content: `请开始${promptName}模式，讲解知识点：「${topic.title}」。先讲授第一个部分的内容，讲完后等待我的反馈再继续下一部分。` },
  ];

  const fullContent = await provider.stream(messages, { maxTokens: 4096 });
  if (!fullContent) throw new Error('AI 返回内容为空');

  const session = {
    mode,
    status: 'waiting_user',
    finished: false,
    transcript: [{ role: 'ai', content: fullContent }],
    stateMachine: null,
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
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'challenge' ? '考验模式' : mode === 'scaffold' ? '脚手架引导' : mode === 'feynman' ? '费曼学习法' : '半实时分段讲解';

  if (mode === 'stepwise') {
    // ── Stepwise mode: use provider.complete() with tool calling ──
    session.status = 'ai_thinking';

    // Find the last tool call (the one we're waiting on user response for)
    const lastToolCallId = _findPendingToolCallId(session);

    // Reconstruct full message history with tool result
    const context = buildDeterministicContext(plan, topicId);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
      { role: 'user', content: session.initialRequest },
      ...session.transcript,
      { role: 'tool', tool_call_id: lastToolCallId, content: `用户说：${feedback}` },
    ];

    const result = await provider.complete(messages, {
      maxTokens: 4096,
      tools: [ASK_USER_TO_CONTINUE_TOOL],
      tool_choice: 'auto',
    });

    if (!result.content && !result.tool_calls) throw new Error('AI 返回内容为空');

    // Store user feedback as tool result
    session.transcript.push({ role: 'tool', tool_call_id: lastToolCallId, content: `用户说：${feedback}` });

    // Store assistant response
    const assistantMsg = { role: 'assistant', content: result.content || '' };
    if (result.tool_calls) {
      assistantMsg.tool_calls = result.tool_calls;
      _advanceDynamicStateMachine(session.stateMachine);
    }
    session.transcript.push(assistantMsg);

    session.status = result.tool_calls ? 'waiting_user' : 'completed';

    // Detect session end
    if (/\[SESSION_END\]/.test(result.content || '')) {
      session.finished = true;
      session.status = 'completed';
    } else if (!result.tool_calls) {
      session.finished = true;
    }

    topic.interactiveSession = session;
    await updateTopic(plan.id, topicId, { interactiveSession: session });

    return { content: result.content || '', tool_calls: result.tool_calls || null, session, finished: session.finished, status: session.status };
  }

  // ── Other modes (realtime, challenge, scaffold): keep streaming approach ──
  session.transcript.push({ role: 'user', content: feedback });
  session.status = 'ai_thinking';

  const context = buildDeterministicContext(plan, topicId);
  const transcriptText = _buildInteractiveTranscript(session);

  const continuationInstruction = (
    `我们正在进行「${topic.title}」的${promptName}模式。\n\n` +
    `### 到目前为止的对话记录\n` +
    `${transcriptText}\n\n` +
    `### 用户的最新反馈\n` +
    `用户说：${feedback}\n\n` +
    `请根据对话记录和用户的最新反馈，继续你的教学。` +
    `继续讲授下一部分的内容，或根据用户的反馈调整讲解方式。` +
    `讲完当前部分后自然地等待用户的下一步反馈。`
  );

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: context },
    { role: 'user', content: continuationInstruction },
  ];

  const fullContent = await provider.stream(messages, { maxTokens: 4096 });
  if (!fullContent) throw new Error('AI 返回内容为空');

  session.transcript.push({ role: 'ai', content: fullContent });

  session.status = 'waiting_user';

  // Detect session end via explicit marker
  if (/\[SESSION_END\]/.test(fullContent)) {
    session.finished = true;
    session.status = 'completed';
  }

  topic.interactiveSession = session;
  await updateTopic(plan.id, topicId, { interactiveSession: session });

  return { content: fullContent, session, finished: session.finished, status: session.status };
}

/**
 * Find the last pending tool_call_id from the transcript.
 * Walks backwards to find the most recent assistant message with tool_calls.
 */
function _findPendingToolCallId(session) {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const entry = session.transcript[i];
    if (entry.tool_calls && entry.tool_calls.length > 0) {
      return entry.tool_calls[0].id;
    }
  }
  return null; // no pending tool call — caller should fall back to non-tool path
}

/**
 * Start an interactive explanation session with SSE streaming.
 * Streams content via onChunk callback and calls onToolCall when AI pauses.
 * Returns the session after streaming completes.
 */
export async function streamInteractiveStart(providerOrConfig, plan, topicId, mode = 'stepwise', callbacks = {}, model) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'challenge' ? '考验模式' : mode === 'scaffold' ? '脚手架引导' : '半实时分段讲解';
  const context = buildDeterministicContext(plan, topicId);
  const stateMachine = mode === 'stepwise' ? _initDynamicStateMachine() : null;

  const { onChunk, onToolCall, onDone, onError } = callbacks;

  if (mode === 'stepwise') {
    const stateSnapshot = _buildStateMachineSnapshot({ stateMachine });
    const initialRequest = `请开始${promptName}模式，讲解知识点：「${topic.title}」。\n\n${stateSnapshot}\n\n先讲授第一个部分的内容，讲完后务必调用 ask_user_to_continue 工具暂停，等待我的反馈再继续。`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
      { role: 'user', content: initialRequest },
    ];

    try {
      const result = await provider.streamWithTools(messages, {
        maxTokens: 4096,
        tools: [ASK_USER_TO_CONTINUE_TOOL],
        tool_choice: 'auto',
        onChunk: (delta) => { if (onChunk) onChunk(delta); },
        onToolCall: (tcs) => { if (onToolCall) onToolCall(tcs); },
      });

      if (!result.content && !result.tool_calls) throw new Error('AI 返回内容为空');

      const assistantMsg = { role: 'assistant', content: result.content || '' };
      if (result.tool_calls) {
        assistantMsg.tool_calls = result.tool_calls;
        _advanceDynamicStateMachine(stateMachine);
      }

      const session = {
        mode,
        status: result.tool_calls ? 'waiting_user' : 'completed',
        finished: !result.tool_calls,
        initialRequest,
        transcript: [assistantMsg],
        stateMachine,
      };

      topic.interactiveSession = session;
      await updateTopic(plan.id, topicId, { interactiveSession: session });

      if (onDone) onDone({ content: result.content || '', tool_calls: result.tool_calls || null, session });
      return { content: result.content || '', tool_calls: result.tool_calls || null, session };
    } catch (err) {
      if (onError) onError(err);
      throw err;
    }
  }

  // Non-stepwise modes: use regular stream
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
      { role: 'user', content: `请开始${promptName}模式，讲解知识点：「${topic.title}」。先讲授第一个部分的内容，讲完后等待我的反馈再继续下一部分。` },
    ];

    const fullContent = await provider.stream(messages, {
      maxTokens: 4096,
      onChunk: (delta) => { if (onChunk) onChunk(delta); },
    });

    if (!fullContent) throw new Error('AI 返回内容为空');

    const session = {
      mode,
      status: 'waiting_user',
      finished: false,
      transcript: [{ role: 'ai', content: fullContent }],
      stateMachine: null,
    };

    topic.interactiveSession = session;
    await updateTopic(plan.id, topicId, { interactiveSession: session });

    if (onDone) onDone({ content: fullContent, session });
    return { content: fullContent, session };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

/**
 * Continue an interactive session with SSE streaming.
 * Streams content via onChunk callback, calls onToolCall when AI pauses.
 */
export async function streamInteractiveContinue(providerOrConfig, plan, topicId, mode, feedback, callbacks = {}, model) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  if (!topic.interactiveSession) {
    throw new Error('当前没有互动讲解会话，请先点击「分段讲解」或「实时互动」开始');
  }
  const session = topic.interactiveSession;
  if (session.finished) {
    session.finished = false;
  }

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'challenge' ? '考验模式' : mode === 'scaffold' ? '脚手架引导' : '半实时分段讲解';

  const { onChunk, onToolCall, onDone, onError } = callbacks;

  if (mode === 'stepwise') {
    session.status = 'ai_thinking';
    const lastToolCallId = _findPendingToolCallId(session);
    const context = buildDeterministicContext(plan, topicId);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
      { role: 'user', content: session.initialRequest },
      ...session.transcript,
      { role: 'tool', tool_call_id: lastToolCallId, content: `用户说：${feedback}` },
    ];

    try {
      const result = await provider.streamWithTools(messages, {
        maxTokens: 4096,
        tools: [ASK_USER_TO_CONTINUE_TOOL],
        tool_choice: 'auto',
        onChunk: (delta) => { if (onChunk) onChunk(delta); },
        onToolCall: (tcs) => { if (onToolCall) onToolCall(tcs); },
      });

      if (!result.content && !result.tool_calls) throw new Error('AI 返回内容为空');

      session.transcript.push({ role: 'tool', tool_call_id: lastToolCallId, content: `用户说：${feedback}` });
      const assistantMsg = { role: 'assistant', content: result.content || '' };
      if (result.tool_calls) {
        assistantMsg.tool_calls = result.tool_calls;
        _advanceDynamicStateMachine(session.stateMachine);
      }
      session.transcript.push(assistantMsg);

      session.status = result.tool_calls ? 'waiting_user' : 'completed';

      if (/\[SESSION_END\]/.test(result.content || '')) {
        session.finished = true;
        session.status = 'completed';
      } else if (!result.tool_calls) {
        session.finished = true;
      }

      topic.interactiveSession = session;
      await updateTopic(plan.id, topicId, { interactiveSession: session });

      if (onDone) onDone({ content: result.content || '', tool_calls: result.tool_calls || null, session, finished: session.finished });
      return { content: result.content || '', tool_calls: result.tool_calls || null, session, finished: session.finished };
    } catch (err) {
      if (onError) onError(err);
      throw err;
    }
  }

  // Non-stepwise modes
  try {
    session.transcript.push({ role: 'user', content: feedback });
    session.status = 'ai_thinking';
    const context = buildDeterministicContext(plan, topicId);
    const transcriptText = _buildInteractiveTranscript(session);

    const continuationInstruction = (
      `我们正在进行「${topic.title}」的${promptName}模式。\n\n` +
      `### 到目前为止的对话记录\n` +
      `${transcriptText}\n\n` +
      `### 用户的最新反馈\n` +
      `用户说：${feedback}\n\n` +
      `请根据对话记录和用户的最新反馈，继续你的教学。`
    );

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
      { role: 'user', content: continuationInstruction },
    ];

    const fullContent = await provider.stream(messages, {
      maxTokens: 4096,
      onChunk: (delta) => { if (onChunk) onChunk(delta); },
    });

    if (!fullContent) throw new Error('AI 返回内容为空');
    session.transcript.push({ role: 'ai', content: fullContent });
    session.status = 'waiting_user';

    if (/\[SESSION_END\]/.test(fullContent)) {
      session.finished = true;
      session.status = 'completed';
    }

    topic.interactiveSession = session;
    await updateTopic(plan.id, topicId, { interactiveSession: session });

    if (onDone) onDone({ content: fullContent, session, finished: session.finished });
    return { content: fullContent, session, finished: session.finished };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════
//  CHALLENGE: reveal embedded errors on completion
// ═══════════════════════════════════════════════════════

/**
 * Build Q&A context summary for error checking from plan history.
 * Extracts recent user questions and AI responses related to the topic.
 */
function buildQaContextForCheck(plan, topicId) {
  const history = (plan.history || []).filter(h => h.topicId === topicId);
  if (history.length === 0) return '';

  // Pair user + ai messages into Q&A blocks
  const pairs = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
      pairs.push({ question: history[i].content, answer: history[i + 1].content });
      i++;
    }
  }
  if (pairs.length === 0) return '';

  // Take last 10 pairs
  const recentPairs = pairs.slice(-10);
  const lines = ['\n\n## 用户追问记录（扩展讨论）'];
  for (const p of recentPairs) {
    // Truncate long Q&A to keep prompt size manageable
    const q = p.question.length > 200 ? p.question.slice(0, 200) + '...' : p.question;
    const a = p.answer.length > 300 ? p.answer.slice(0, 300) + '...' : p.answer;
    lines.push('- 用户问：' + q);
    lines.push('  AI答：' + a);
  }
  return lines.join('\n');
}

/**
 * Extract confirmed errors from Q&A history.
 * Looks for patterns where the user pointed out an error and the AI confirmed it.
 */
function extractErrorsFromQA(plan, topicId) {
  const history = (plan.history || []).filter(h => h.topicId === topicId);
  const errors = [];

  for (let i = 0; i < history.length - 1; i++) {
    const userEntry = history[i];
    const aiEntry = history[i + 1];
    if (userEntry.role !== 'user' || aiEntry.role !== 'ai') continue;

    const question = userEntry.content;
    const answer = aiEntry.content;

    // Check if user is pointing out a potential error
    const userPointsToError = /不对|错了|错误|应该是|不是这样|有问题|说错了|纠正|不对吧|应该是.*而不是|难道不是|你写错了|代码错|概念错|逻辑错/i.test(question);

    // Check if AI confirms the error
    const aiConfirmsError = /你说得对|确实错了|感谢指正|抱歉.*错|是我的错|你说的是对的|确实是我|正确的理解是|感谢你的纠正|你发现了一个错误|这是个好问题.*确实|我的表述不准确|此处确实|我犯了个错误|你的理解是正确的.*我的/i.test(answer);

    if (userPointsToError && aiConfirmsError) {
      errors.push({
        location: '扩展讨论',
        description: '用户在追问中发现：' + (question.length > 80 ? question.slice(0, 80) + '...' : question),
        correction: answer.length > 300 ? answer.slice(0, 300) + '...' : answer,
        type: '用户发现',
        source: 'qa',
      });
    }
  }

  return errors;
}

/**
 * Deduplicate errors by comparing description similarity.
 */
function deduplicateErrors(errors) {
  const unique = [];
  const seen = new Set();

  for (const err of errors) {
    // Normalize description for comparison
    const key = err.description.replace(/\s+/g, '').slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(err);
    }
  }

  return unique;
}

/**
 * Analyze generated detail content for teaching errors (both intentional and
 * unintentional), incorporating Q&A history and the two-agent generate-check
 * pipeline. Called when user clicks "学完了" to reveal any missed teaching errors.
 *
 * @param {string[]} recognizedErrors - free-text descriptions of errors the
 *   student already claims to have found (used to mark recognized=true).
 */
export async function revealEmbeddedErrors(providerOrConfig, plan, topicId, model, recognizedErrors = []) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');
  if (!topic.detail) return { errors: [], hasErrors: false };

  const provider = _resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  // Step 1: Extract user-discovered errors from Q&A history
  const userDiscoveredErrors = extractErrorsFromQA(plan, topicId);

  // Step 2: Build Q&A context for the AI check
  const qaContext = buildQaContextForCheck(plan, topicId);

  // Step 3: Generation-side detection — ask for structured teaching-error fields
  const typeCodes = MISCONCEPTION_TAXONOMY.errorTypes.map(t => t.code).join('|');
  const prompt =
    '你是一位教学错误审查专家。以下是一篇AI生成的讲解内容。请识别其中所有"有教学价值的错误"（故意埋下的或无意产生的）。\n\n' +
    '注意：\n' +
    '- **故意埋下的错误**：模仿真实学生典型误区的微妙错误（边界条件、概念近似、概念混淆、代码bug、符号/计算、因果谬误等）\n' +
    '- **无意产生的错误**：AI生成时出现的真实错误\n' +
    '- 有些内容是完全正确的，不要为了凑数而误判\n' +
    '- 用户通过追问可能也发现了问题——参考下面的追问记录辅助判断\n\n' +
    '对每个错误，请给出它针对的知识误区(misconception)、认知层次(bloomLevel: 记住/理解/应用/分析/评价/创造)、错误类型(errorType，从 ' + typeCodes + ' 中选)。\n\n' +
    '请以JSON格式返回：{"errors": [{"location": "错误所在章节", "description": "错误描述", "correction": "正确版本", "errorType": "' + typeCodes + '", "misconception": "针对的具体误区", "bloomLevel": "记住|理解|应用|分析|评价|创造"}], "hasErrors": true/false}\n\n' +
    '讲解内容：\n\n' + topic.detail.slice(0, 10000) +
    (qaContext ? qaContext : '');

  const messages = [
    { role: 'system', content: '你是一位严格但友好的教学错误审查专家。只输出JSON。' },
    { role: 'user', content: prompt },
  ];

  try {
    // First pass: identify candidate errors (generation agent output)
    const result = await provider.complete(messages, { maxTokens: 2048, temperature: 0.3, responseFormat: { type: 'json_object' } });
    const parsed = JSON.parse(result.content || '{}');
    const candidateErrors = Array.isArray(parsed.errors) ? parsed.errors : [];

    // Step 4: Examination agent — generate-check: keep only valid teaching errors
    let verifiedErrors = candidateErrors;
    if (candidateErrors.length > 0) {
      try {
        verifiedErrors = await examineTeachingErrors(provider, topic.detail.slice(0, 6000), candidateErrors);
      } catch {
        try {
          verifiedErrors = await verifyErrorCandidates(provider, topic.detail.slice(0, 6000), candidateErrors);
        } catch {
          verifiedErrors = candidateErrors;
        }
      }
    }

    // Step 5: Merge AI-discovered errors with user-discovered errors from Q&A
    const allErrors = deduplicateErrors([...verifiedErrors, ...userDiscoveredErrors]);

    // Step 6: Mark which errors the student recognized (self-report or from Q&A)
    const recognizedTexts = (Array.isArray(recognizedErrors) ? recognizedErrors : [])
      .map(s => String(s || '').replace(/\s+/g, '').toLowerCase()).filter(Boolean);

    const finalErrors = allErrors.map(err => {
      const fromQA = err.source === 'qa';
      const haystack = ((err.description || '') + (err.misconception || '') + (err.location || '')).replace(/\s+/g, '').toLowerCase();
      const matched = recognizedTexts.some(t => t.length >= 2 && (haystack.includes(t) || t.includes(haystack.slice(0, 20))));
      return { ...err, recognized: fromQA || matched };
    });

    // Step 7: Persist teaching errors onto the topic for weak-point analysis linkage
    try {
      await recordTeachingErrors(plan.id, topicId, finalErrors);
      topic.teachingErrors = finalErrors;
    } catch { /* persistence is best-effort */ }

    return {
      errors: finalErrors,
      hasErrors: finalErrors.length > 0,
      unrecognizedCount: finalErrors.filter(e => !e.recognized).length,
    };
  } catch (err) {
    console.warn('[revealEmbeddedErrors] Analysis failed:', err?.message);
    return {
      errors: userDiscoveredErrors,
      hasErrors: userDiscoveredErrors.length > 0,
      unrecognizedCount: 0,
    };
  }
}


/**
 * Examination Agent (generate-check pattern): reviews candidate teaching errors
 * and keeps only genuine, pedagogically valuable ones whose type matches.
 * Enriches each kept error with misconception / bloomLevel / pedagogicalValue.
 */
export async function examineTeachingErrors(provider, detailSnippet, candidates) {
  const candidatesJson = JSON.stringify(candidates.map((c, i) => ({
    index: i,
    location: c.location,
    description: c.description,
    errorType: c.errorType || c.type,
    misconception: c.misconception,
    bloomLevel: c.bloomLevel,
  })), null, 2);

  const messages = [
    { role: 'system', content: STABLE_TEACHING_ERROR_EXAM_PROMPT },
    { role: 'user', content: '讲解内容片段：\n' + detailSnippet + '\n\n候选错误列表：\n' + candidatesJson },
  ];

  const result = await provider.complete(messages, { maxTokens: 1536, temperature: 0.2, responseFormat: { type: 'json_object' } });
  const parsed = JSON.parse(result.content || '{}');
  const reviewed = Array.isArray(parsed.reviewed) ? parsed.reviewed : [];
  if (reviewed.length === 0) return candidates; // unexpected format — keep candidates

  const kept = [];
  for (const r of reviewed) {
    if (r.keep === false) continue;
    if (r.isRealError === false) continue;
    if (typeof r.pedagogicalValue === 'number' && r.pedagogicalValue < 6) continue;
    const base = candidates[r.index];
    if (!base) continue;
    kept.push({
      ...base,
      errorType: r.errorType || base.errorType || base.type || 'concept-approx',
      misconception: r.misconception || base.misconception || '',
      bloomLevel: r.bloomLevel || base.bloomLevel || '',
      pedagogicalValue: typeof r.pedagogicalValue === 'number' ? r.pedagogicalValue : undefined,
    });
  }
  // If examination removed everything, keep original candidates (avoid over-filtering)
  return kept.length > 0 ? kept : candidates;
}

/**
 * Secondary verification pass — review candidate errors to reduce false positives.
 * Asks the AI to confirm each error and provide a confidence level.
 */
async function verifyErrorCandidates(provider, detailSnippet, candidates) {
  const candidatesJson = JSON.stringify(candidates.map((c, i) => ({
    index: i,
    location: c.location,
    description: c.description,
    type: c.type,
  })), null, 2);

  const verifyPrompt =
    '你是一位严格的学习内容审查专家。以下是一份AI讲解内容的片段，以及一份候选错误列表。\n\n' +
    '请逐一判断每个候选错误是否**确实是真正的错误**（不是过度解读或误判）。\n\n' +
    '注意事项：\n' +
    '- 只有当你非常确信某个候选确实是错误时，才保留它\n' +
    '- 如果候选只是表述不够完美但本质正确，或者是不存在的假阳性，请排除\n' +
    '- 重点关注：事实性错误、逻辑矛盾、代码bug、概念混淆\n\n' +
    '请以JSON格式返回：{"verifiedErrors": [{"index": 0, "isRealError": true/false, "reason": "判断理由（一句话）"}], "hasVerifiedErrors": true/false}\n\n' +
    '讲解内容片段：\n' + detailSnippet + '\n\n' +
    '候选错误列表：\n' + candidatesJson;

  const messages = [
    { role: 'system', content: '你是一位严格的学习内容审查专家。只输出JSON。谨防假阳性。' },
    { role: 'user', content: verifyPrompt },
  ];

  try {
    const result = await provider.complete(messages, { maxTokens: 1024, temperature: 0.2, responseFormat: { type: 'json_object' } });
    const parsed = JSON.parse(result.content || '{}');
    const verifiedResults = Array.isArray(parsed.verifiedErrors) ? parsed.verifiedErrors : [];

    if (verifiedResults.length === 0) {
      // Verification response doesn't match expected format — keep all candidates as-is
      return candidates;
    }

    // Only keep candidates that passed verification
    const keepIndices = new Set(
      verifiedResults.filter(v => v.isRealError === true).map(v => v.index)
    );

    const filtered = candidates.filter((_, i) => keepIndices.has(i));
    // If filtering removed everything, keep original (verification may be too aggressive)
    return filtered.length > 0 ? filtered : candidates;
  } catch {
    // Verification failed — keep all candidates as-is
    return candidates;
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

//  EXAM PAPER ENGINE
// ═══════════════════════════════════════════════════════


/**
 * Step 1: Generate blueprint — detailed order list.
 */
export function generateBlueprint(providerOrConfig, plan, topicIds, config = {}) {
  const selectedTopics = plan.topics.filter(t => topicIds.includes(t.id));
  if (selectedTopics.length === 0) throw new Error('未选择任何知识点');
  const topicCount = selectedTopics.length;
  const totalQuestions = config.questionCount || Math.max(10, topicCount * 3);
  const choiceRatio = config.choiceRatio !== undefined ? config.choiceRatio : 0.6;
  const diffRatios = config.difficulty === 'easy' ? { easy:0.5, medium:0.4, hard:0.1 }
    : config.difficulty === 'balanced' ? { easy:0.3, medium:0.5, hard:0.2 }
    : config.difficulty === 'hard' ? { easy:0.1, medium:0.4, hard:0.5 }
    : { easy:0.3, medium:0.5, hard:0.2 };

  // Step 1: Calculate exact counts per cell (difficulty × type)
  const choiceCount = Math.round(totalQuestions * choiceRatio);
  const openCount = totalQuestions - choiceCount;
  const easyCount = Math.round(totalQuestions * diffRatios.easy);
  const hardCount = Math.round(totalQuestions * diffRatios.hard);
  const mediumCount = totalQuestions - easyCount - hardCount;

  const difficultyTotals = [
    { diff: 'easy', count: Math.max(easyCount, 0) },
    { diff: 'medium', count: Math.max(mediumCount, 0) },
    { diff: 'hard', count: Math.max(hardCount, 0) },
  ];

  // Distribute type counts across difficulty levels proportionally
  const orders = [];
  let remainingChoice = choiceCount;
  let remainingOpen = openCount;

  for (const { diff, count } of difficultyTotals) {
    if (count <= 0) continue;
    // Proportional split: this difficulty's share of total questions
    const share = count / totalQuestions;
    const choiceForDiff = Math.min(Math.round(choiceCount * share), remainingChoice, count);
    const openForDiff = count - choiceForDiff;
    remainingChoice -= choiceForDiff;
    remainingOpen -= openForDiff;

    for (let i = 0; i < choiceForDiff; i++) orders.push({ type: 'choice', difficulty: diff });
    for (let i = 0; i < openForDiff; i++) orders.push({ type: 'open', difficulty: diff });
  }

  // Handle any rounding leftovers
  while (remainingChoice > 0) { orders.push({ type: 'choice', difficulty: 'medium' }); remainingChoice--; }
  while (remainingOpen > 0) { orders.push({ type: 'open', difficulty: 'medium' }); remainingOpen--; }

  // Shuffle orders to mix difficulty/types, then distribute across topics via round-robin
  for (let i = orders.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [orders[i], orders[j]] = [orders[j], orders[i]];
  }

  // Assign topics round-robin, ensure each topic gets at least 1
  const topicTitles = selectedTopics.map(t => t.title);
  const assignments = [];
  const perTopic = Math.floor(orders.length / topicCount);
  const extra = orders.length % topicCount;
  let orderIdx = 0;

  for (let t = 0; t < topicCount; t++) {
    const count = perTopic + (t < extra ? 1 : 0);
    for (let i = 0; i < count && orderIdx < orders.length; i++) {
      assignments.push({ ...orders[orderIdx], topicTitle: topicTitles[t], index: assignments.length });
      orderIdx++;
    }
  }

  // Assign remaining orders if any (rounding)
  while (orderIdx < orders.length) {
    const t = orderIdx % topicCount;
    assignments.push({ ...orders[orderIdx], topicTitle: topicTitles[t], index: assignments.length });
    orderIdx++;
  }

  // Build title
  const diffLabel = config.difficulty === 'easy' ? '基础' : config.difficulty === 'hard' ? '困难' : '标准';
  const title = `${plan.name} — ${diffLabel}测验（${assignments.length}题）`;

  return {
    title,
    orders: assignments,
    topicTitleToId: Object.fromEntries(selectedTopics.map(t => [t.title, t.id])),
    topicDetailMap: Object.fromEntries(selectedTopics.map(t => [t.title, t.detail || ''])),
  };
}


/**
 * Step 2: Generate a single question from one blueprint order.
 */
export async function generateSingleQuestion(providerOrConfig, order, topicDetail, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const { v4: uuidv4 } = await import('uuid');
  const detailSnippet = (topicDetail||'').slice(0,2000)||'（暂无详细讲解）';
  // Map difficulty to Bloom's taxonomy levels
  const bloomMap = { easy: ['记住','理解'], medium: ['理解','应用','分析'], hard: ['分析','评价','创造'] };
  const bloomPool = bloomMap[order.difficulty] || ['理解','应用'];
  const bloomLevel = bloomPool[Math.floor(Math.random() * bloomPool.length)];
  const prompt = STABLE_EXAM_SINGLE_QUESTION_PROMPT
    .replace('{topicTitle}',order.topicTitle).replace('{topicDetail}',detailSnippet)
    .replace('{difficulty}',order.difficulty).replace('{questionType}',order.type);
  const messages = [{role:'system',content:prompt},{role:'user',content:'请为知识点「'+order.topicTitle+'」生成一道'+(order.difficulty==='easy'?'基础':order.difficulty==='hard'?'较难':'中等')+(order.type==='choice'?'选择题':'简答题')}];
  const result = await provider.complete(messages,{maxTokens:2048,temperature:0.7,responseFormat:{type:'json_object'}});
  let qData, qErr;
  try { qData = JSON.parse(result.content||'{}'); qErr = validateQuestionOutput(qData); } catch { qErr = 'JSON 解析失败'; }
  if (qErr) return null;
  return { id: uuidv4().slice(0,8), index: order.index, type: order.type, question: qData.question||'', options: qData.options||[], answer: qData.answer||'', explanation: qData.explanation||'', conceptTag: qData.conceptTag||order.topicTitle, topicId: null, difficulty: order.difficulty, validated: false };
}


/**
 * Step 3: Self-correction — AI answers as student to validate question.
 */
export async function selfCorrectQuestion(providerOrConfig, question, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const optionsText = question.options&&question.options.length>0 ? question.options.join('\n') : '';
  const prompt = STABLE_EXAM_SELF_CORRECT_PROMPT.replace('{questionText}',question.question).replace('{optionsText}',optionsText ? `## 选项\n${optionsText}` : '');
  const messages = [{role:'system',content:prompt},{role:'user',content:`请解答此题：${question.question}`}];
  const result = await provider.complete(messages,{maxTokens:1024,temperature:0.3,responseFormat:{type:'json_object'}});
  let studentData;
  try { studentData = JSON.parse(result.content||'{}'); } catch { return false; }
  const studentAnswer = (studentData.studentAnswer||'').trim().toUpperCase();
  const expected = (question.answer||'').trim().toUpperCase();
  if (question.type==='choice') return studentAnswer===expected;
  const jp = `你是一位公正的阅卷老师。判断学生的答案是否与标准答案在核心要点上一致。\n\n题目：${question.question}\n\n标准答案：${expected}\n\n学生答案：${studentAnswer}\n\n输出JSON：{"equivalent": true/false}\n只输出 JSON。`;
  try { const r=await provider.complete([{role:'user',content:jp}],{maxTokens:512,temperature:0.2,responseFormat:{type:'json_object'}}); return (JSON.parse(r.content||'{}')).equivalent===true; } catch { return true; }
}


/**
 * Evaluate question quality (OpenAI Evals-style).
 * Returns { overall, scores, recommendation } or null on failure.
 */
export async function evaluateQuestionQuality(providerOrConfig, question, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const optionsText = question.options && question.options.length > 0 
    ? '\n选项：\n' + question.options.join('\n') : '';
  const context = `知识点：${question.conceptTag || '未知'}
要求难度：${question.difficulty || '未指定'}
题型：${question.type === 'choice' ? '选择题' : '简答题'}

题目：${question.question}${optionsText}

答案：${question.answer}
解析：${question.explanation}`;

  const result = await provider.complete(
    [{ role: 'system', content: STABLE_EXAM_QUALITY_EVAL_PROMPT },
     { role: 'user', content: context }],
    { maxTokens: 1024, temperature: 0.2, responseFormat: { type: 'json_object' } }
  );

  try {
    const data = JSON.parse(result.content || '{}');
    if (data.overall && data.recommendation) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Revise a question based on quality evaluation feedback.
 * Implements "generate -> judge -> revise" iterative improvement.
 */
export async function reviseQuestion(providerOrConfig, question, qualityFeedback, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const optionsText = question.options && question.options.length > 0
    ? '\n选项：\n' + question.options.join('\n') : '';
  const revisePrompt = '你是一位试题修订专家。下面是一道AI生成的试题，请根据质量评估反馈进行修订。\n\n' +
    '## 原始题目\n' +
    '知识点：' + (question.conceptTag || '未知') + '\n' +
    '难度：' + (question.difficulty || '未指定') + '\n' +
    '题型：' + (question.type === 'choice' ? '选择题' : '简答题') + '\n\n' +
    '题目：' + question.question + '\n' +
    (optionsText ? optionsText + '\n' : '') +
    '答案：' + (question.answer || '') + '\n' +
    '解析：' + (question.explanation || '') + '\n\n' +
    '## 质量评估反馈\n' +
    '评分：' + (qualityFeedback.overall || '?') + '/10\n' +
    '问题：' + ((qualityFeedback.issues || []).join('；') || '无具体问题') + '\n\n' +
    '## 修订要求\n' +
    '1. 保留考察的知识点不变\n' +
    '2. 针对反馈的问题逐条修正\n' +
    '3. 保持JSON格式\n\n' +
    '## 输出格式\n' +
    '{"question":"修订后的题干","options":["A.","B.","C.","D."],"answer":"正确答案","explanation":"解析","conceptTag":"知识点"}\n' +
    '只输出JSON，不要其他文字';
  try {
    const result = await provider.complete(
      [{role:'system',content:'你是一位专业的试题修订专家。'},{role:'user',content:revisePrompt}],
      {maxTokens:2048,temperature:0.4,responseFormat:{type:'json_object'}}
    );
    const data = JSON.parse(result.content || '{}');
    if (!data.question) return null;
    return { ...question, question: data.question, options: data.options || question.options, answer: data.answer || question.answer, explanation: data.explanation || question.explanation, revised: true };
  } catch { return null; }
}


/**
 * Generate exam: blueprint → parallel gen → self-correction.
 */
export async function generateExam(providerOrConfig, plan, topicIds, config = {}, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const blueprint = await generateBlueprint(provider, plan, topicIds, config, model);
  const {title, orders, topicTitleToId, topicDetailMap} = blueprint;
  const MAX_RETRIES=2, CONCURRENCY=5;
  const validatedQ = [];
  for (let i=0; i<orders.length; i+=CONCURRENCY) {
    const batch = orders.slice(i, i+CONCURRENCY);
    const results = await Promise.all(batch.map(async order=>{
      for (let a=0; a<=MAX_RETRIES; a++) {
        const q = await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
        if (!q) continue;
        q.topicId = topicTitleToId[order.topicTitle]||null;
        if (await selfCorrectQuestion(provider, q, model)) {
          let quality;
          try { quality = await evaluateQuestionQuality(provider, q, model); } catch { quality = null; }
          if (quality && quality.recommendation === 'revise') {
            const revised = await reviseQuestion(provider, q, quality, model);
            if (revised) { revised.validated=true; revised.qualityScore=quality.overall; return revised; }
          }
        }
      }
      const fb = await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
      if (fb) { fb.topicId=topicTitleToId[order.topicTitle]||null; fb.validated=false; }
      return fb;
    }));
    for (const q of results) { if (q) validatedQ.push(q); }
  }
  validatedQ.forEach((q,i)=>{q.index=i;});
  const {v4:uuidv4}=await import('uuid');
  const examId=uuidv4().slice(0,8);
  const choiceQs=validatedQ.filter(q=>q.type==='choice');
  const openQs=validatedQ.filter(q=>q.type==='open');
  let md=`# ${title}\n\n**总分**：${validatedQ.length*5} 分（每题 5 分）\n\n---\n\n`;
  if (choiceQs.length>0) { md+=`## 一、选择题（共 ${choiceQs.length} 题，每题 5 分）\n\n`; choiceQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n`; for (const o of q.options) md+=`${o}\n\n`; md+='\n';}); }
  if (openQs.length>0) { md+=`## ${choiceQs.length>0?'二':'一'}、简答题（共 ${openQs.length} 题，每题 5 分）\n\n`; openQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n\n`;}); }
  const examPaper = {id:examId, title, config:{topicIds, questionCount:validatedQ.length, choiceRatio:config.choiceRatio||0.6}, paper:md, questions:validatedQ};
  addExamPaper(plan.id, examPaper);
  return examPaper;
}

export async function generateExamStream(providerOrConfig, plan, topicIds, config = {}, writeCallback, model) {
  const blueprint = await generateBlueprint(provider, plan, topicIds, config, model);
  const {title, orders, topicTitleToId, topicDetailMap} = blueprint;
  writeCallback({type:'blueprint', data:{total:orders.length, title}});
  const MAX_RETRIES=2, CONCURRENCY=5;
  const validatedQ = [];
  for (let i=0; i<orders.length; i+=CONCURRENCY) {
    const batch = orders.slice(i, i+CONCURRENCY);
    const results = await Promise.all(batch.map(async order=>{
      for (let a=0; a<=MAX_RETRIES; a++) {
        const q = await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
        if (!q) continue;
        q.topicId=topicTitleToId[order.topicTitle]||null;
        if (await selfCorrectQuestion(provider, q, model)) {
          let quality;
          try { quality = await evaluateQuestionQuality(provider, q, model); } catch { quality = null; }
          if (quality && quality.recommendation === 'revise') {
            const revised = await reviseQuestion(provider, q, quality, model);
            if (revised) { revised.validated=true; revised.qualityScore=quality.overall; return revised; }
          }
        }
      }
      const fb=await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
      if (fb) { fb.topicId=topicTitleToId[order.topicTitle]||null; fb.validated=false; }
      return fb;
    }));
    for (const q of results) { if (q) { q.index=validatedQ.length; validatedQ.push(q); writeCallback({type:'question', data:q}); } }
  }
  const choiceQs=validatedQ.filter(q=>q.type==='choice'); const openQs=validatedQ.filter(q=>q.type==='open');
  let md=`# ${title}\n\n**总分**：${validatedQ.length*5} 分（每题 5 分）\n\n---\n\n`;
  if (choiceQs.length>0) { md+=`## 一、选择题（共 ${choiceQs.length} 题，每题 5 分）\n\n`; choiceQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n`; for (const o of q.options) md+=`${o}\n\n`; md+='\n';}); }
  if (openQs.length>0) { md+=`## ${choiceQs.length>0?'二':'一'}、简答题（共 ${openQs.length} 题，每题 5 分）\n\n`; openQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n\n`;}); }
  const {v4:uuidv4}=await import('uuid'); const examId=uuidv4().slice(0,8);
  const examPaper = {id:examId, title, config:{topicIds, questionCount:validatedQ.length, choiceRatio:config.choiceRatio||0.6}, paper:md, questions:validatedQ};
  addExamPaper(plan.id, examPaper);
  writeCallback({type:'done', data:{examId, totalQuestions:validatedQ.length}});
}


/**
 * Grade submitted exam answers using AI.
 * @param {object} providerOrConfig - Provider instance or config
 * @param {object} plan - The plan object
 * @param {string} examId - The exam paper ID
 * @param {Array} answers - User's answers [{ exerciseIndex, userAnswer }]
 * @returns {Promise<Array>} Grading results
 */
export async function gradeExam(providerOrConfig, plan, examId, answers) {
  const provider = _resolveProvider(providerOrConfig);

  const examPapers = getExamPapers(plan.id);
  const exam = examPapers.find(e => e.id === examId);
  if (!exam) throw new Error('试卷不存在');

  // Prepare grading context
  const gradingContext = {
    title: exam.title,
    questions: exam.questions.map((q, i) => ({
      index: i,
      type: q.type,
      question: q.question,
      options: q.options,
      correctAnswer: q.answer,
      userAnswer: (answers.find(a => a.exerciseIndex === i) || {}).userAnswer || '',
    })),
  };

  const messages = [
    { role: 'system', content: STABLE_EXAM_GRADING_PROMPT },
    { role: 'user', content: JSON.stringify(gradingContext, null, 2) },
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

  const results = gradingResults.results || [];

  // Save exam results to store
  updateExamResults(plan.id, examId, results);

  return results;
}

/**
 * Generate targeted practice questions based on exam paper mistakes.
 * Uses wrong answers from a specific exam to create focused practice.
 */
export async function generateExamPractice(providerOrConfig, plan, examId, count = 5, model) {
  const exam = (plan.examPapers || []).find(e => e.id === examId);
  if (!exam || !exam.results) throw new Error('试卷不存在或尚未批改');

  // Collect wrong answers with topic info
  const wrongItems = [];
  for (const result of exam.results) {
    if (result.correct === false) {
      const q = exam.questions[result.exerciseIndex];
      if (q) {
        const topic = plan.topics.find(t => t.id === q.topicId);
        wrongItems.push({
          question: q.question,
          type: q.type,
          difficulty: q.difficulty,
          conceptTag: q.conceptTag,
          topicTitle: topic ? topic.title : q.conceptTag,
          topicDetail: topic ? (topic.detail || '').slice(0, 1000) : '',
          userAnswer: result.userAnswer,
          correctAnswer: result.correctAnswer,
        });
      }
    }
  }

  if (wrongItems.length === 0) throw new Error('该试卷没有错题，无需针对性练习');

  const provider = _resolveProvider(providerOrConfig, model);
  const practicePrompt = '你是一位学习辅导老师。用户在做完试卷后有一些题目答错了，请根据这些错题生成针对性的练习题，帮助用户巩固薄弱知识点。\n\n' +
    '## 用户的错题\n' +
    wrongItems.map((w, i) =>
      `错题 ${i+1}：${w.question}\n知识点：${w.conceptTag}\n难度：${w.difficulty}\n你的答案：${w.userAnswer}\n正确答案：${w.correctAnswer}`
    ).join('\n\n---\n\n') +
    `\n\n## 要求\n` +
    `请生成 ${count} 道针对性练习题，重点考察用户答错的知识点。\n` +
    `- 每道题至少覆盖一个错题涉及的知识点\n` +
    `- 题型可以混合选择题和简答题\n` +
    `- 难度与原始题目相当\n\n` +
    `## 输出格式（JSON）\n` +
    `{\n` +
    `  "questions": [\n` +
    `    {\n` +
    `      "index": 0,\n` +
    `      "type": "choice" 或 "open",\n` +
    `      "question": "题干",\n` +
    `      "options": ["A.", "B.", "C.", "D."],\n` +
    `      "answer": "正确答案",\n` +
    `      "explanation": "解析",\n` +
    `      "conceptTag": "覆盖的知识点"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `只输出 JSON，不要其他文字`;

  const result = await provider.complete(
    [{ role: 'system', content: '你是一位学习辅导老师，擅长根据学生的错题生成针对性练习题。' },
     { role: 'user', content: practicePrompt }],
    { maxTokens: 4096, temperature: 0.6, responseFormat: { type: 'json_object' } }
  );

  let data;
  try { data = JSON.parse(result.content || '{}'); } catch { throw new Error('AI 生成的练习格式错误'); }
  return data.questions || [];
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
      maxTokens: [redacted],
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
  validateQuestionOutput,
  validateBlueprintOutput,
  startInteractiveDetail,
  continueInteractiveDetail,
  revealEmbeddedErrors,
  examineTeachingErrors,
  decomposeTopic,
  generateQuickQuiz,
  textToSpeech,
  getEngineCacheDiagnostics,
  createProviderFromConfig,
};
