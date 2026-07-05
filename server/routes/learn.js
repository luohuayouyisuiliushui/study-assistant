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

    const result = await provider.complete(
      [
        { role: 'system', content: IMPORT_PLAN_PROMPT },
        { role: 'user', content: text.trim() },
      ],
      { temperature: 0.1, responseFormat: { type: 'json_object' } }
    );

    const parsed = JSON.parse(result.content || '{}');
    const planName = overrideName || parsed.name || '导入的学习计划';
    const phases = (parsed.phases && parsed.phases.length > 0)
      ? parsed.phases
      : [{ name: '核心内容', topics: [] }];

    const hasTopics = phases.some(p => p.topics && p.topics.length > 0);
    if (!hasTopics) {
      const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^[#*\-=~]+$/));
      phases[0].topics = lines.map(l => l.replace(/^[-*\d\s.]+/, '').trim()).filter(Boolean);
    }

    const plan = store.createPlanWithPhases(planName, phases);
    res.json({ plan });
  } catch (err) {
    console.error('[import]', err);
    res.status(500).json({ error: '解析失败: ' + err.message });
  }
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
