import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { generateDetail, generateDetailWithImage, generateDetailStream, generateTopicImage,
  createProviderFromConfig, startInteractiveDetail, continueInteractiveDetail,
  revealEmbeddedErrors, decomposeTopic, textToSpeech,
  streamInteractiveStart, streamInteractiveContinue } from '../engine/learn-engine.js';
import { AdaptivePromptInjector } from '../engine/adaptive-engine.js';
import { getUserProfile } from '../engine/user-profile.js';
import AgentDispatcher from '../engine/agent-dispatcher.js';
import { getProvider, getModel, getDispatcher, wantsAgentDispatch } from './middleware.js';

const router = Router();


router.post('/plans/:planId/generate/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  res.json({ status: 'generating', topicId: req.params.topicId });

  try {
    const model = getModel(req);

    // ── Agent dispatch (opt-in): use AgentDispatcher if requested ──
    if (wantsAgentDispatch(req)) {
      const dispatcher = getDispatcher(req);
      const { result: dispatchedResult } = await dispatcher.dispatch('explain',
        (provider) => generateDetail(provider, plan, req.params.topicId, model)
      );
      return; // generateDetail already writes to plan via store
    }

    const provider = getProvider(req);
    const imageApiKey = req.body?.imageApiKey || req.headers['x-image-api-key'] || '';
    const imageModel = req.body?.imageModel || '';
    if (imageApiKey) {
      // Generate text + illustration
      await generateDetailWithImage(provider, plan, req.params.topicId, imageApiKey, provider.model, imageModel);
    } else {
      await generateDetail(provider, plan, req.params.topicId, provider.model);
    }
  } catch (err) {
    console.error('Generate failed:', err.message);
    // Store error on topic so frontend polling can detect failure
    try {
      await store.updateTopic(req.params.planId, req.params.topicId, {
        lastError: '生成失败: ' + err.message,
        done: false,
      });
    } catch { /* best-effort */ }
  }
});

/**
 * POST /api/learn/plans/:planId/generate-sse/:topicId
 * SSE streaming variant of generate. Streams content chunks in real-time.
 * Events: chunk ({ content }), done ({ topicId, detail }), error ({ data })
 * Supports agent dispatch via x-use-agent-dispatch header.
 */
router.post('/plans/:planId/generate-sse/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');

    const timeout = setTimeout(() => {
      try {
        res.write('data: ' + JSON.stringify({ type: 'error', data: '生成超时，请重试' }) + '\n\n');
        res.end();
      } catch {}
    }, 180_000);

    let aborted = false;
    res.on('close', () => { aborted = true; clearTimeout(timeout); });

    const writeEvent = (event) => {
      if (aborted) return;
      try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch { aborted = true; }
    };

    const model = getModel(req);

    if (wantsAgentDispatch(req)) {
      const dispatcher = getDispatcher(req);
      await dispatcher.dispatch('explain',
        (provider) => generateDetailStream(provider, plan, req.params.topicId, writeEvent, model)
      );
    } else {
      const provider = getProvider(req);
      const imageApiKey = req.body?.imageApiKey || req.headers['x-image-api-key'] || '';
      const imageModel = req.body?.imageModel || '';
      await generateDetailStream(provider, plan, req.params.topicId, writeEvent, model);
      if (imageApiKey) {
        generateTopicImage(topic, imageApiKey, imageModel).then(imageUrl => {
          if (imageUrl) store.updateTopic(plan.id, topic.id, { imageUrl }).catch(() => {});
        }).catch(() => {});
      }
    }

    clearTimeout(timeout);
    if (!aborted) res.end();
  } catch (err) {
    console.error('[generate-sse]', err);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    try { res.write('data: ' + JSON.stringify({ type: 'error', data: err.message }) + '\n\n'); res.end(); } catch {}
  }
});

// ═══════════════════════════════════════════════════════
//  INTERACTIVE MODE ROUTES (stepwise + realtime)
// ═══════════════════════════════════════════════════════

/**
 * POST /api/learn/plans/:planId/interactive-start/:topicId
 * Start an interactive explanation session.
 * Body: { mode: 'stepwise'|'realtime' }
 */
router.post('/plans/:planId/interactive-start/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  const mode = req.body?.mode || 'stepwise';
  if (!['stepwise', 'realtime', 'challenge', 'scaffold', 'feynman', 'stepwise-challenge', 'realtime-challenge'].includes(mode)) {
    return res.status(400).json({ error: 'mode 必须是 stepwise、realtime、challenge、scaffold、feynman、stepwise-challenge 或 realtime-challenge' });
  }

  try {
    const provider = getProvider(req);
    const result = await startInteractiveDetail(provider, plan, req.params.topicId, mode, provider.model);
    res.json(result);
  } catch (err) {
    console.error('[interactive-start]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/interactive-continue/:topicId
 * Continue an interactive session with user feedback.
 * Body: { mode: 'stepwise'|'realtime'|'stepwise-challenge'|'realtime-challenge', feedback: '...' }
 */
router.post('/plans/:planId/interactive-continue/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  const { mode, feedback } = req.body;
  if (!mode || !feedback || !feedback.trim()) {
    return res.status(400).json({ error: '\u8bf7\u63d0\u4f9b mode \u548c feedback \u53c2\u6570' });
  }

  try {
    const provider = getProvider(req);
    const result = await continueInteractiveDetail(provider, plan, req.params.topicId, mode, feedback.trim(), provider.model);
    res.json(result);
  } catch (err) {
    console.error('[interactive-continue]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/interactive-start-sse/:topicId
 * SSE streaming version: start an interactive session and stream content.
 * Body: { mode: 'stepwise'|'realtime' }
 * Events: chunk, pause (tool_calls), done, error
 */
router.post('/plans/:planId/interactive-start-sse/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  const mode = req.body?.mode || 'stepwise';
  if (!['stepwise', 'realtime', 'challenge', 'scaffold', 'feynman', 'stepwise-challenge', 'realtime-challenge'].includes(mode)) {
    return res.status(400).json({ error: 'mode 必须是 stepwise、realtime、challenge、scaffold、feynman、stepwise-challenge 或 realtime-challenge' });
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');

    let idleTimer = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { res.write('data: ' + JSON.stringify({ type: 'error', data: '生成超时' }) + '\n\n'); res.end(); } catch {}
      }, 120_000);
    };

    let aborted = false;
    res.on('close', () => { aborted = true; if (idleTimer) clearTimeout(idleTimer); });

    const provider = getProvider(req);
    const writeEvent = (event) => {
      if (aborted) return;
      try { res.write('data: ' + JSON.stringify(event) + '\n\n'); resetIdleTimer(); } catch { aborted = true; }
    };
    resetIdleTimer();

    await streamInteractiveStart(provider, plan, req.params.topicId, mode, {
      onChunk: (delta) => writeEvent({ type: 'chunk', content: delta }),
      onToolCall: (tcs) => writeEvent({ type: 'pause', tool_calls: tcs }),
      onDone: (result) => writeEvent({ type: 'done', content: result.content || '', session: result.session, finished: result.finished }),
      onError: (err) => writeEvent({ type: 'error', data: err.message }),
    });

    if (idleTimer) clearTimeout(idleTimer);
    if (!aborted) res.end();
  } catch (err) {
    console.error('[interactive-start-sse]', err);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    try { res.write('data: ' + JSON.stringify({ type: 'error', data: err.message }) + '\n\n'); res.end(); } catch {}
  }
});

/**
 * POST /api/learn/plans/:planId/interactive-continue-sse/:topicId
 * SSE streaming version: continue an interactive session.
 * Body: { mode: 'stepwise'|'realtime', feedback: '...' }
 * Events: chunk, pause (tool_calls), done, error
 */
router.post('/plans/:planId/interactive-continue-sse/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  const { mode, feedback } = req.body;
  if (!mode || !feedback || !feedback.trim()) {
    return res.status(400).json({ error: '请提供 mode 和 feedback 参数' });
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');

    let idleTimer = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { res.write('data: ' + JSON.stringify({ type: 'error', data: '生成超时' }) + '\n\n'); res.end(); } catch {}
      }, 120_000);
    };

    let aborted = false;
    res.on('close', () => { aborted = true; if (idleTimer) clearTimeout(idleTimer); });

    const provider = getProvider(req);
    const writeEvent = (event) => {
      if (aborted) return;
      try { res.write('data: ' + JSON.stringify(event) + '\n\n'); resetIdleTimer(); } catch { aborted = true; }
    };
    resetIdleTimer();

    await streamInteractiveContinue(provider, plan, req.params.topicId, mode, feedback.trim(), {
      onChunk: (delta) => writeEvent({ type: 'chunk', content: delta }),
      onToolCall: (tcs) => writeEvent({ type: 'pause', tool_calls: tcs }),
      onDone: (result) => writeEvent({ type: 'done', content: result.content || '', session: result.session, finished: result.finished }),
      onError: (err) => writeEvent({ type: 'error', data: err.message }),
    });

    if (idleTimer) clearTimeout(idleTimer);
    if (!aborted) res.end();
  } catch (err) {
    console.error('[interactive-continue-sse]', err);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    try { res.write('data: ' + JSON.stringify({ type: 'error', data: err.message }) + '\n\n'); res.end(); } catch {}
  }
});

// ═══════════════════════════════════════════════════════
//  CHALLENGE: reveal embedded errors on completion
// ═══════════════════════════════════════════════════════

/**
 * POST /api/learn/plans/:planId/reveal-errors/:topicId
 * Analyze topic content for subtle embedded errors.
 */
router.post('/plans/:planId/reveal-errors/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const provider = getProvider(req);
    const recognizedErrors = Array.isArray(req.body && req.body.recognizedErrors) ? req.body.recognizedErrors : [];
    const result = await revealEmbeddedErrors(provider, plan, req.params.topicId, provider.model, recognizedErrors);
    res.json(result);
  } catch (err) {
    console.error('[reveal-errors]', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  SCAFFOLD: decompose a topic into sub-topics
// ═══════════════════════════════════════════════════════

/**
 * POST /api/learn/plans/:planId/decompose/:topicId
 * Decompose a topic into 3-6 sub-topics using AI.
 */
router.post('/plans/:planId/decompose/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  try {
    const provider = getProvider(req);
    const subtopics = await decomposeTopic(provider, plan, req.params.topicId, getModel(req));
    res.json({ subtopics });
  } catch (err) {
    console.error('[decompose]', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  TTS: text-to-speech via SiliconFlow
// ═══════════════════════════════════════════════════════

/**
 * POST /api/learn/tts
 * Synthesize speech from text.
 * Body: { text: '...', imageApiKey: '...' }
 * Returns: audio/mpeg binary
 */
router.post('/plans/:planId/tts/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const { text } = req.body || {};
  const apiKey = req.headers['x-image-api-key'] || '';

  if (!text || !text.trim()) {
    return res.status(400).json({ error: '请输入文本' });
  }
  if (!apiKey) {
    return res.status(400).json({ error: '请通过请求头 x-image-api-key 传入 API Key' });
  }

  try {
    const audioBuffer = await textToSpeech(apiKey, text);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length.toString());
    res.end(audioBuffer);
  } catch (err) {
    console.error('[tts]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/ask/:topicId
 * Ask a follow-up question on a topic.
 * Body: { question }
 */
router.post('/plans/:planId/ask/:topicId', async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: '请输入问题' });
  }

  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const provider = getProvider(req);
    const answer = await answerFollowUp(provider, plan, req.params.topicId, question.trim(), provider.model);
    res.json({ answer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
export default router;
