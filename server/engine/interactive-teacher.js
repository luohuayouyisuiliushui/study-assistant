/**
 * Interactive teaching engine — stepwise, realtime, scaffold, challenge, feynman, stepwise-challenge, realtime-challenge, and error detection.
 *
 * Uses shared Provider infrastructure from learn-engine.js (resolveProvider).
 */

import { Provider } from './provider.js';
import { AdaptivePromptInjector } from './adaptive-engine.js';
import {
  STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_FEYNMAN_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_STEPWISE_CHALLENGE_PROMPT,
  STABLE_INTERACTIVE_REALTIME_CHALLENGE_PROMPT,
  STABLE_TEACHING_ERROR_EXAM_PROMPT, MISCONCEPTION_TAXONOMY,
  buildDeterministicContext,
} from './learn-prompts.js';
import { getUserProfile } from './user-profile.js';
import { recordTeachingErrors, updateTopic, getTopicHistory } from './learn-store.js';
import { resolveProvider } from './learn-engine.js';
import { engineCacheMonitor } from './learn-engine.js';


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
  if (mode === 'stepwise-challenge') return STABLE_INTERACTIVE_STEPWISE_CHALLENGE_PROMPT;
  if (mode === 'realtime-challenge') return STABLE_INTERACTIVE_REALTIME_CHALLENGE_PROMPT;
  return STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT;
}

/**
 * Track explicit interactive mode usage count on a topic.
 * Updates topic.interactiveModeUsage with { count, lastUsedAt } per mode.
 */
function _trackModeUsage(topic, mode) {
  if (!topic || !mode) return;
  const usage = topic.interactiveModeUsage || {};
  const existing = usage[mode] || { count: 0 };
  usage[mode] = { count: existing.count + 1, lastUsedAt: Date.now() };
  topic.interactiveModeUsage = usage;
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

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'realtime-challenge' ? '实时考验模式' : mode === 'challenge' ? '考验模式' : mode === 'stepwise-challenge' ? '分段考验模式' : mode === 'scaffold' ? '脚手架引导' : mode === 'feynman' ? '费曼学习法' : '半实时分段讲解';

  // Adaptive context: inject user profile if available
  const profile = getUserProfile();
  const injector = new AdaptivePromptInjector(profile);
  const adaptiveContext = injector.buildAdaptiveContext();
  const context = buildDeterministicContext(plan, topicId);
  const enhancedContext = adaptiveContext && injector.hasMeaningfulProfile
    ? context + '\n' + adaptiveContext
    : context;
  const stateMachine = (mode === 'stepwise' || mode === 'stepwise-challenge') ? _initDynamicStateMachine() : null;

  if (mode === 'stepwise' || mode === 'stepwise-challenge') {
    // ── Stepwise mode: use provider.complete() with tool calling ──
    const stateSnapshot = _buildStateMachineSnapshot({ stateMachine });
    const initialRequest = `请开始${promptName}模式，讲解知识点：「${topic.title}」。\n\n${stateSnapshot}\n\n先讲授第一个部分的内容，讲完后务必调用 ask_user_to_continue 工具暂停，等待我的反馈再继续。`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: enhancedContext },
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
    // Atomically persist session + mode usage
    _trackModeUsage(topic, mode);
    await updateTopic(plan.id, topicId, {
      interactiveSession: session,
      interactiveModeUsage: topic.interactiveModeUsage,
    });

    return { content: result.content || '', tool_calls: result.tool_calls || null, session, finished: session.finished };
  }

  // ── Other modes: keep the streaming approach ──
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: enhancedContext },
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
  // Atomically persist session + mode usage
  _trackModeUsage(topic, mode);
  await updateTopic(plan.id, topicId, {
    interactiveSession: session,
    interactiveModeUsage: topic.interactiveModeUsage,
  });

  return { content: fullContent, session, finished: session.finished };
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

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'realtime-challenge' ? '实时考验模式' : mode === 'challenge' ? '考验模式' : mode === 'stepwise-challenge' ? '分段考验模式' : mode === 'scaffold' ? '脚手架引导' : mode === 'feynman' ? '费曼学习法' : '半实时分段讲解';

  if (mode === 'stepwise' || mode === 'stepwise-challenge') {
    // ── Stepwise mode: use provider.complete() with tool calling ──
    session.status = 'ai_thinking';

    // Find the last tool call (the one we're waiting on user response for)
    const lastToolCallId = _findPendingToolCallId(session);

    // Guard against missing tool call: if no tool was ever called, fall back to
    // non-tool mode (append user feedback directly instead of as a tool result).
    if (!lastToolCallId) {
      session.transcript.push({ role: 'user', content: feedback });
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
      const result = await provider.complete(messages, { maxTokens: 4096 });
      if (!result.content) throw new Error('AI 返回内容为空');
      session.transcript.push({ role: 'ai', content: result.content });
      session.status = 'waiting_user';
      if (/\[SESSION_END\]/.test(result.content || '')) {
        session.finished = true;
        session.status = 'completed';
      }
      topic.interactiveSession = session;
      await updateTopic(plan.id, topicId, { interactiveSession: session });
      return { content: result.content, tool_calls: null, session, finished: session.finished, status: session.status };
    }

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

  const isFeynman = mode === 'feynman';
  const continuationInstruction = isFeynman
    ? (
      `我们正在进行「${topic.title}」的费曼学习法模式。\n\n` +
      `### 到目前为止的对话记录\n` +
      `${transcriptText}\n\n` +
      `### 用户的最新反馈\n` +
      `用户说：${feedback}\n\n` +
      `请根据对话记录和用户的最新反馈，继续你的提问。\n` +
      `⚠️ 重要：你的所有提问必须严格围绕「${topic.title}」这个知识点，` +
      `不要引入其他知识点或超出当前范围的问题。` +
      `如果用户提到了超出范围的内容，请温和地拉回话题。`
    )
    : (
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

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'realtime-challenge' ? '实时考验模式' : mode === 'challenge' ? '考验模式' : mode === 'stepwise-challenge' ? '分段考验模式' : mode === 'scaffold' ? '脚手架引导' : mode === 'feynman' ? '费曼学习法' : '半实时分段讲解';
  const baseContext = buildDeterministicContext(plan, topicId);

  // Adaptive context injection
  const profile = getUserProfile();
  const injector = new AdaptivePromptInjector(profile);
  const adaptiveContext = injector.buildAdaptiveContext();
  const context = adaptiveContext && injector.hasMeaningfulProfile
    ? baseContext + '\n' + adaptiveContext
    : baseContext;
  const stateMachine = (mode === 'stepwise' || mode === 'stepwise-challenge') ? _initDynamicStateMachine() : null;

  const { onChunk, onToolCall, onDone, onError, signal } = callbacks;

  if (mode === 'stepwise' || mode === 'stepwise-challenge') {
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
        signal,
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
      _trackModeUsage(topic, mode);
      await updateTopic(plan.id, topicId, {
        interactiveSession: session,
        interactiveModeUsage: topic.interactiveModeUsage,
      });

      if (onDone) onDone({ content: result.content || '', tool_calls: result.tool_calls || null, session, finished: session.finished });
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
      signal,
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
    _trackModeUsage(topic, mode);
    await updateTopic(plan.id, topicId, {
      interactiveSession: session,
      interactiveModeUsage: topic.interactiveModeUsage,
    });

    if (onDone) onDone({ content: fullContent, session, finished: session.finished });
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
  // Guard against concurrent continue calls (e.g. user double-clicks): if a
  // previous continue is still in flight, refuse rather than letting two
  // streaming responses race to overwrite topic.interactiveSession.
  if (session.status === 'ai_thinking') {
    throw new Error('上一条回复仍在生成中，请等待当前回复完成后再发送下一条消息');
  }
  if (session.finished) {
    session.finished = false;
  }

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
  const systemPrompt = _getInteractivePrompt(mode);
  const promptName = mode === 'realtime' ? '实时互动讲解' : mode === 'realtime-challenge' ? '实时考验模式' : mode === 'challenge' ? '考验模式' : mode === 'stepwise-challenge' ? '分段考验模式' : mode === 'scaffold' ? '脚手架引导' : mode === 'feynman' ? '费曼学习法' : '半实时分段讲解';

  const { onChunk, onToolCall, onDone, onError, signal } = callbacks;

  if (mode === 'stepwise' || mode === 'stepwise-challenge') {
    session.status = 'ai_thinking';
    const lastToolCallId = _findPendingToolCallId(session);

    // Guard against missing tool call: if no tool was ever called, fall back to
    // non-tool mode (append user feedback directly instead of as a tool result).
    // This can happen when the AI finishes without calling ask_user_to_continue.
    if (!lastToolCallId) {
      // Fall back to non-tool: add user feedback directly, rebuild as stream
      session.transcript.push({ role: 'user', content: feedback });
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
      try {
        const fullContent = await provider.stream(messages, {
          maxTokens: 4096,
          signal,
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
        if (onDone) onDone({ content: fullContent, tool_calls: null, session, finished: session.finished });
        return { content: fullContent, tool_calls: null, session, finished: session.finished };
      } catch (err) {
        if (onError) onError(err);
        throw err;
      }
    }

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
        signal,
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

    const isFeynmanSSE = mode === 'feynman';
    const continuationInstruction = isFeynmanSSE
      ? (
        `我们正在进行「${topic.title}」的费曼学习法模式。\n\n` +
        `### 到目前为止的对话记录\n` +
        `${transcriptText}\n\n` +
        `### 用户的最新反馈\n` +
        `用户说：${feedback}\n\n` +
        `请根据对话记录和用户的最新反馈，继续你的提问。\n` +
        `⚠️ 重要：你的所有提问必须严格围绕「${topic.title}」这个知识点，` +
        `不要引入其他知识点或超出当前范围的问题。` +
        `如果用户提到了超出范围的内容，请温和地拉回话题。`
      )
      : (
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
      signal,
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

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

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

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');
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


