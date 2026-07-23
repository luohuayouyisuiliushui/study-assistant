import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { generateDetail, generateDetailWithImage, generateDetailStream, generateTopicImage,
  createProviderFromConfig, startInteractiveDetail, continueInteractiveDetail,
  revealEmbeddedErrors, decomposeTopic, textToSpeech, recommendResources,
  streamInteractiveStart, streamInteractiveContinue, answerFollowUp } from '../engine/learn-engine.js';
import { AdaptivePromptInjector } from '../engine/adaptive-engine.js';
import { getUserProfile } from '../engine/user-profile.js';
import AgentDispatcher from '../engine/agent-dispatcher.js';
import { getProvider, getModel, getDispatcher, wantsAgentDispatch } from './middleware.js';
import { refreshDataFlywheel } from './flywheel.js';

const router = Router();


router.post('/plans/:planId/generate/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  // Mark topic as generating so PlanView can show a spinner during polling
  await store.updateTopic(req.params.planId, req.params.topicId, {
    generatingAt: Date.now(),
    lastError: null,
  }).catch(() => {});

  res.json({ status: 'generating', topicId: req.params.topicId });

  try {
    const model = getModel(req);
    const explainStyle = req.body?.explainStyle || plan.explainStyle || '';

    // ── Agent dispatch (opt-in): use AgentDispatcher if requested ──
    if (wantsAgentDispatch(req)) {
      const dispatcher = getDispatcher(req);
      const { result: dispatchedResult } = await dispatcher.dispatch('explain',
        (provider) => generateDetail(provider, plan, req.params.topicId, model, explainStyle)
      );
      return; // generateDetail already writes to plan via store
    }

    const provider = getProvider(req);
    const imageApiKey = req.body?.imageApiKey || req.headers['x-image-api-key'] || '';
    const imageModel = req.body?.imageModel || '';
    const imageBaseUrl = req.body?.imageBaseUrl || '';
    if (imageApiKey) {
      await generateDetailWithImage(provider, plan, req.params.topicId, imageApiKey, provider.model, imageModel, explainStyle, imageBaseUrl);
    } else {
      await generateDetail(provider, plan, req.params.topicId, provider.model, explainStyle);
    }
  } catch (err) {
    console.error('Generate failed:', err.message);
    try {
      await store.updateTopic(req.params.planId, req.params.topicId, {
        lastError: '生成失败: ' + err.message,
        generatingAt: null,
        done: false,
      });
    } catch { /* best-effort */ }
    return;
  }
  // Clear generatingAt on success (generateDetail sets done=true, but generatingAt must be cleared)
  store.updateTopic(req.params.planId, req.params.topicId, { generatingAt: null }).catch(() => {});
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

  // Mark topic as generating before streaming begins
  await store.updateTopic(req.params.planId, req.params.topicId, {
    generatingAt: Date.now(),
    lastError: null,
  }).catch(() => {});

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
    const explainStyle = req.body?.explainStyle || plan.explainStyle || '';

    if (wantsAgentDispatch(req)) {
      const dispatcher = getDispatcher(req);
      await dispatcher.dispatch('explain',
        (provider) => generateDetailStream(provider, plan, req.params.topicId, writeEvent, model, explainStyle)
      );
    } else {
      const provider = getProvider(req);
      const imageApiKey = req.body?.imageApiKey || req.headers['x-image-api-key'] || '';
      const imageModel = req.body?.imageModel || '';
      const imageBaseUrl = req.body?.imageBaseUrl || '';
      await generateDetailStream(provider, plan, req.params.topicId, writeEvent, model, explainStyle);
      if (imageApiKey) {
        generateTopicImage(topic, imageApiKey, imageModel, imageBaseUrl).then(imageUrl => {
          if (imageUrl) store.updateTopic(plan.id, topic.id, { imageUrl }).catch(() => {});
        }).catch(() => {});
      }
    }

    clearTimeout(timeout);
    // Clear generating marker on success
    store.updateTopic(req.params.planId, req.params.topicId, { generatingAt: null }).catch(() => {});
    if (!aborted) res.end();
  } catch (err) {
    console.error('[generate-sse]', err);
    // Clear generating marker on error
    store.updateTopic(req.params.planId, req.params.topicId, { generatingAt: null }).catch(() => {});
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    try { res.write('data: ' + JSON.stringify({ type: 'error', data: err.message }) + '\n\n'); res.end(); } catch {}
  }
});

/**
 * POST /api/learn/plans/:planId/image/:topicId
 * Generate an illustration for a topic WITHOUT regenerating text detail.
 * Body: { imageApiKey, imageModel }
 * Header: x-image-api-key (alternative to body param)
 */
router.post('/plans/:planId/image/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  const imageApiKey = req.body?.imageApiKey || req.headers['x-image-api-key'] || '';
  if (!imageApiKey) {
    return res.status(400).json({ error: '请提供图片 API Key（通过 body.imageApiKey 或 x-image-api-key 请求头）' });
  }

  try {
    const imageModel = req.body?.imageModel || '';
    const imageBaseUrl = req.body?.imageBaseUrl || '';
    const imageUrl = await generateTopicImage(topic, imageApiKey, imageModel, imageBaseUrl);
    if (!imageUrl) {
      return res.status(502).json({ error: '图片生成失败，API 未返回有效图片 URL' });
    }
    // Persist the image URL
    await store.updateTopic(plan.id, topic.id, { imageUrl });
    res.json({ imageUrl });
  } catch (err) {
    console.error('[generate-image]', err);
    res.status(500).json({ error: '图片生成失败: ' + (err.message || '未知错误') });
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
    // Flywheel + mode counting: interactive session started
    refreshDataFlywheel('interactive-start');
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
    // Flywheel: SSE interactive session started
    refreshDataFlywheel('interactive-start-sse');
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
//  RESOURCE RECOMMENDATION
// ═══════════════════════════════════════════════════════

/**
 * GET /api/learn/plans/:planId/resources/:topicId
 * Return cached recommendations (if any) without an AI call.
 */
router.get('/plans/:planId/resources/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  res.json({ topicTitle: topic.title, resources: topic.resources || [] });
});

/**
 * POST /api/learn/plans/:planId/resources/:topicId
 * Generate fresh resource recommendations for a topic (multi-channel, multi-form).
 * Result is persisted on the topic for later GET access.
 */
router.post('/plans/:planId/resources/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  try {
    const provider = getProvider(req);
    const result = await recommendResources(provider, plan, req.params.topicId, getModel(req));
    await store.updateTopic(req.params.planId, req.params.topicId, { resources: result.resources });
    res.json(result);
  } catch (err) {
    console.error('[resources]', err);
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
    // Flywheel: Q&A adds to learning history
    refreshDataFlywheel('qa');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
export default router;
