import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { generateDetail, answerFollowUp, answerAnalysisFollowUp, getEngineCacheDiagnostics, createProviderFromConfig, analyzeLearning } from '../engine/learn-engine.js';

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
 */
router.get('/plans/:id/graph', (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  const graph = store.buildKnowledgeGraph(plan);
  res.json({ graph });
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
    await generateDetail(provider, plan, req.params.topicId, provider.model);
  } catch (err) {
    console.error('Generate failed:', err.message);
  }
});

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
