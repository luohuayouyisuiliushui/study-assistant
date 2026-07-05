import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { generateDetail, generateDetailWithImage, answerFollowUp, answerAnalysisFollowUp, getEngineCacheDiagnostics, createProviderFromConfig, analyzeLearning, generateReview, gradeExercises, analyzeWeakPoints, startInteractiveDetail, continueInteractiveDetail, revealEmbeddedErrors, decomposeTopic, textToSpeech } from '../engine/learn-engine.js';

const router = Router();

// ─── Middleware: get or create Provider instance ───

function getProvider(req) {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey || process.env.OPENAI_API_KEY;
  const baseURL = req.headers['x-api-base'] || req.body?.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = req.headers['x-api-model'] || req.body?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return createProviderFromConfig(apiKey, baseURL, model);
}

function getModel(req) {
  return req.headers['x-api-model'] || req.body?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

// ─── Test Connection ───

/**
 * POST /api/learn/test-connection
 * Test if the provided API configuration works.
 */
router.post('/test-connection', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: '请提供 API Key（可通过请求头 x-api-key、请求体 apiKey 或环境变量 OPENAI_API_KEY 设置）' });
  }
  const provider = getProvider(req);
  const result = await provider.testConnection();
  res.json(result);
});

// ─── Plans ───

router.get('/plans', (req, res) => {
  res.json({ plans: store.listPlans() });
});

router.post('/plans', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '请输入学习计划名称' });
  }
  const plan = store.createPlan(name.trim());
  res.json({ plan });
});

router.get('/plans/:id', (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  res.json({ plan });
});

router.delete('/plans/:id', (req, res) => {
  store.deletePlan(req.params.id);
  res.json({ success: true });
});

router.get('/plans/:id/profile', (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  const profile = store.buildLearningProfile(plan);
  res.json({ profile });
});

router.get('/flags', (req, res) => {
  res.json({ flagged: store.readFlags() });
});

router.delete('/flags/:planId', (req, res) => {
  store.clearFlag(req.params.planId);
  res.json({ success: true });
});

// ─── Topics ───

router.post('/plans/:id/topics', async (req, res) => {
  const { titles } = req.body;
  if (!titles || !Array.isArray(titles) || titles.length === 0) {
    return res.status(400).json({ error: '请提供知识点列表' });
  }
  try {
    const plan = await store.addTopics(req.params.id, titles.map(t => t.trim()).filter(Boolean));
    res.json({ plan });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.put('/plans/:id/topics/reorder', async (req, res) => {
  const { orderedIds } = req.body;
  try {
    const plan = await store.reorderTopics(req.params.id, orderedIds);
    res.json({ plan });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete('/plans/:planId/topics/:topicId', async (req, res) => {
  try {
    const plan = await store.removeTopic(req.params.planId, req.params.topicId);
    res.json({ plan });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.put('/plans/:planId/topics/:topicId', async (req, res) => {
  const { done, difficulty } = req.body;
  try {
    const plan = await store.updateTopic(req.params.planId, req.params.topicId, { done, difficulty });
    res.json({ plan });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/topics/:topicId/time
 * Record time spent on a topic (accumulated seconds).
 */
router.post('/plans/:planId/topics/:topicId/time', async (req, res) => {
  const { seconds } = req.body;
  if (typeof seconds !== 'number' || seconds <= 0) {
    return res.status(400).json({ error: '无效的时间' });
  }
  try {
    const plan = await store.updateTopicTime(req.params.planId, req.params.topicId, seconds);
    res.json({ plan });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── AI Import ───

router.post('/plans/import', async (req, res) => {
  const { text, name: overrideName } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: '请粘贴学习计划文本' });
  }

  try {
    const provider = getProvider(req);
    const { IMPORT_PLAN_PROMPT } = await import('../engine/learn-prompts.js');

    // ── First attempt: deep analysis with IMPORT_PLAN_PROMPT ──
    let parsed;
    let phases;
    let relations;
    let planName;

    const firstAttempt = await provider.complete(
      [
        { role: 'system', content: IMPORT_PLAN_PROMPT },
        { role: 'user', content: text.trim() },
      ],
      { temperature: 0.3, responseFormat: { type: 'json_object' } }
    );

    parsed = JSON.parse(firstAttempt.content || '{}');
    planName = overrideName || parsed.name || '导入的学习计划';

    // Handle both old format (topics as string arrays) and new format (topics as objects with level/subtopics)
    const rawPhases = (parsed.phases && parsed.phases.length > 0)
      ? parsed.phases
      : [{ name: '核心内容', topics: [] }];

    phases = rawPhases.map(p => {
      if (p.topics && p.topics.length > 0 && typeof p.topics[0] === 'string') {
        return { ...p, topics: p.topics.map(t => ({ title: t, level: 1 })) };
      }
      return p;
    });

    const hasTopics = phases.some(p => p.topics && p.topics.length > 0);

    // ── Retry if AI failed to extract any topics ──
    if (!hasTopics) {
      console.log('[import] First attempt yielded no topics, retrying with corrective prompt...');
      const retryPrompt =
        '之前你分析了这份材料但没有成功提取出知识点。请重新认真分析以下资料。\n\n' +
        '⚠️ 重要：不要逐行拆分！你需要先理解整篇内容的逻辑，再提取核心知识点（3-15 个），而不是每一行/每一句都列出来。\n\n' +
        '输出 JSON 时，第一个字段必须是 "documentAnalysis"：先写一段对整份资料的完整理解总结（主题、逻辑结构、内容风格），再输出知识点结构。\n\n' +
        '请严格按照以下结构输出 JSON：\n' +
        '{\n' +
        '  "documentAnalysis": "对整份资料的完整理解...",\n' +
        '  "name": "学习计划名称",\n' +
        '  "phases": [\n' +
        '    {\n' +
        '      "name": "阶段名称",\n' +
        '      "topics": [\n' +
        '        { "title": "知识点1", "level": 1, "subtopics": [\n' +
        '          { "title": "子知识点", "level": 2 }\n' +
        '        ]}\n' +
        '      ]\n' +
        '    }\n' +
        '  ],\n' +
        '  "relations": []\n' +
        '}\n\n' +
        '资料内容：\n' + text.trim();

      const retryResult = await provider.complete(
        [
          { role: 'system', content: '你是一位学习内容结构分析专家。你的核心方法是「先理解，再结构化」：先在 JSON 的第一个字段 "documentAnalysis" 中完整总结对整份资料的理解，再从中提炼出 3-15 个核心知识点，形成有层次的学习计划。注意：不要逐行拆分，要理解全文后做语义聚合。知识点应反映主要章节/概念，而不是每一句话。' },
          { role: 'user', content: retryPrompt },
        ],
        { temperature: 0.4, responseFormat: { type: 'json_object' } }
      );

      parsed = JSON.parse(retryResult.content || '{}');
      const retryRawPhases = (parsed.phases && parsed.phases.length > 0)
        ? parsed.phases
        : [{ name: '核心内容', topics: [] }];

      phases = retryRawPhases.map(p => {
        if (p.topics && p.topics.length > 0 && typeof p.topics[0] === 'string') {
          return { ...p, topics: p.topics.map(t => ({ title: t, level: 1 })) };
        }
        return p;
      });

      const retryHasTopics = phases.some(p => p.topics && p.topics.length > 0);
      if (!retryHasTopics) {
        // Both attempts failed — tell the user instead of silently splitting by line
        return res.status(422).json({
          error: 'AI 无法从这段资料中提取出知识点结构。请尝试：\n' +
            '1. 简化输入内容，给出更清晰的大纲格式\n' +
            '2. 使用「手动创建」模式，自己列出知识点\n' +
            '3. 将较长的资料先拆分成几个小段分别导入',
        });
      }

      planName = overrideName || parsed.name || (planName + '（修正版）');
    }

    relations = parsed.relations || [];
    const plan = store.createPlanWithPhases(planName, phases, relations);
    res.json({ plan });
  } catch (err) {
    console.error('[import]', err);
    res.status(500).json({ error: '解析失败: ' + err.message });
  }
});

/**
 * GET /api/learn/plans/:id/graph
 * Get knowledge graph data (nodes + edges) for visualization.
 * Query params:
 *   infer=true — include inferred edges from detail text, transitive dependencies, and inherited prerequisites
 */
router.get('/plans/:id/graph', (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const infer = req.query.infer === 'true';
  let graph;
  if (infer) {
    graph = store.buildEnhancedKnowledgeGraph(plan);
  } else {
    graph = store.buildKnowledgeGraph(plan);
  }
  res.json({ graph });
});

/**
 * GET /api/learn/plans/:id/extract-relations
 * Parse AI-generated detail text to extract knowledge relationships,
 * and return them as suggested edges that can be previewed before saving.
 */
router.get('/plans/:id/extract-relations', (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const inferredEdges = store.buildInferredEdges(plan);
  const detailEdges = inferredEdges.filter(e => e.source === 'detail');
  const transitiveEdges = inferredEdges.filter(e => e.source === 'transitive');
  const inheritedEdges = inferredEdges.filter(e => e.source === 'inherited');

  res.json({
    edges: inferredEdges,
    detailCount: detailEdges.length,
    transitiveCount: transitiveEdges.length,
    inheritedCount: inheritedEdges.length,
    totalCount: inferredEdges.length,
  });
});

// ─── Generation & Q&A ───

router.post('/plans/:planId/generate/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  res.json({ status: 'generating', topicId: req.params.topicId });

  try {
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
  if (!['stepwise', 'realtime', 'challenge', 'scaffold'].includes(mode)) {
    return res.status(400).json({ error: 'mode 必须是 stepwise、realtime、challenge 或 scaffold' });
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
 * Body: { mode: 'stepwise'|'realtime', feedback: '...' }
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
    const result = await revealEmbeddedErrors(provider, plan, req.params.topicId, provider.model);
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
  // ... existing decompose route ...
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
router.post('/tts', async (req, res) => {
  const { text } = req.body;
  const apiKey = req.body?.imageApiKey || req.headers['x-image-api-key'] || '';

  if (!text || !text.trim()) {
    return res.status(400).json({ error: '请输入文本' });
  }
  if (!apiKey) {
    return res.status(400).json({ error: '请先配置硅基流动 API Key（设置中的图片API Key）' });
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
 * POST /api/learn/plans/:planId/ask/:topicId', async (req, res) => {
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

// ─── Learning Analysis ───

/**
 * POST /api/learn/plans/:id/analysis
 * Generate AI-powered learning analysis and insights.
 */
router.post('/plans/:id/analysis', async (req, res) => {
  try {
    const plan = store.getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: '计划不存在' });

    const provider = getProvider(req);
    const analysis = await analyzeLearning(provider, plan, provider.model, req.body?.analysisChat);
    res.json({ analysis });
  } catch (err) {
    console.error('[analysis]', err);
    // Ensure we always send a JSON response even if the error object is unusual
    try {
      res.status(500).json({ error: '分析失败: ' + (err.message || err) });
    } catch {
      res.status(500).end('分析失败');
    }
  }
});
router.post('/plans/:id/analysis/ask', async (req, res) => {
  try {
    const plan = store.getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: '计划不存在' });

    const { question, analysis } = req.body;
    if (!question || !analysis) {
      return res.status(400).json({ error: '缺少 question 或 analysis 参数' });
    }

    const provider = getProvider(req);
    const result = await answerAnalysisFollowUp(provider, plan, analysis, question.trim(), provider.model);
    res.json({ answer: result.content });
  } catch (err) {
    console.error('[analysis-ask]', err);
    try {
      res.status(500).json({ error: '追问失败: ' + (err.message || err) });
    } catch {
      res.status(500).end('追问失败');
    }
  }
});

// ═══════════════════════════════════════════════════════
//  EXERCISE & REVIEW ROUTES
// ═══════════════════════════════════════════════════════

/**
 * POST /api/learn/plans/:planId/review/:topicId
 * Generate review content for a completed topic.
 */
router.post('/plans/:planId/review/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });
  if (!topic.done) return res.status(400).json({ error: '该知识点尚未完成学习，无需复习' });

  try {
    const provider = getProvider(req);
    const review = await generateReview(provider, plan, req.params.topicId, getModel(req));
    const exercises = store.parseExercisesFromDetail(review);
    res.json({ review, exercises });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/exercises/:topicId/submit
 * Submit exercise answers for AI grading.
 */
router.post('/plans/:planId/exercises/:topicId/submit', async (req, res) => {
  const { answers } = req.body;
  if (!answers || !Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: '请提供练习答案' });
  }

  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const provider = getProvider(req);
    const results = await gradeExercises(provider, plan, req.params.topicId, answers);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/weak-points
 * Analyze weak points across all done topics.
 */
router.post('/plans/:planId/weak-points', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const provider = getProvider(req);
    const results = await analyzeWeakPoints(provider, plan, getModel(req));
    res.json({ weakPoints: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/learn/plans/:planId/review-needs
 * Get topics needing review with weak point details.
 */
router.get('/plans/:planId/review-needs', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const needs = store.getTopicsNeedingReview(plan);
  res.json({ needs });
});

/**
 * GET /api/learn/cache-diagnostics
 * Get cumulative cache performance metrics.
 * Useful for monitoring how well the cache optimization is working.
 */
router.get('/cache-diagnostics', (req, res) => {
  const diagnostics = getEngineCacheDiagnostics();
  res.json({ diagnostics });
});

/**
 * POST /api/learn/cache-stats
 * Get detailed per-provider cache statistics (requires API config in body/headers).
 * Returns response cache hit rates, disk cache size, prefix stability.
 */
router.post('/cache-stats', (req, res) => {
  try {
    const provider = getProvider(req);
    const stats = provider.getCacheStats();
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
