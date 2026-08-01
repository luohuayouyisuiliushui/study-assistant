import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { answerAnalysisFollowUp, analyzeLearning, generateReview, gradeExercises, analyzeWeakPoints, generateQuickQuiz, analyzeCoreTopics, inferTopicRelations } from '../engine/learn-engine.js';
import { IMPORT_PLAN_PROMPT } from '../engine/learn-prompts.js';
import { dataFlywheelUpdate } from '../engine/adaptive-engine.js';
import { getAIInvocation, registerPlanIdParams } from './middleware.js';
import { refreshDataFlywheel } from './flywheel.js';

const router = Router();
registerPlanIdParams(router, ['id', 'planId']);

// ─── Test Connection ───

/**
 * POST /api/learn/test-connection
 * Test if the provided API configuration works.
 */
router.post('/test-connection', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ ok: false, error: '请提供 API Key（可通过请求头 x-api-key、请求体 apiKey 或环境变量 OPENAI_API_KEY 设置）' });
  }
  const { provider } = getAIInvocation(req);
  const result = await provider.testConnection();
  res.json(result);
});

// ─── Plans ───

router.get('/plans', (req, res) => {
  res.json({ plans: store.listPlans() });
});

router.post('/plans', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '请输入学习计划名称' });
  }
  const plan = await store.createPlan(name.trim());
  res.json({ plan });
});

router.get('/plans/:id', (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  res.json({ plan });
});

router.delete('/plans/:id', async (req, res) => {
  await store.deletePlan(req.params.id);
  res.json({ success: true });
});

/**
 * POST /api/learn/plans/batch-delete
 * Permanently delete multiple plans by their IDs (skips trash).
 * Body: { ids: ["id1", "id2", ...] }
 */
router.post('/plans/batch-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供要删除的计划 ID 数组' });
  }
  if (ids.some(id => !store.isValidPlanId(id))) {
    return res.status(400).json({ error: '计划 ID 数组包含无效值' });
  }
  try {
    await store.deletePlansByIds(ids);
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/delete-test-data
 * Permanently delete all test/automatically created plans (name contains 'test' or 'engine-test' etc.)
 * Keeps only user-created plans with meaningful names.
 */
router.post('/plans/delete-test-data', (req, res) => {
  const plans = store.listPlans();
  const testPlanNames = [
    'engine-test-plan', 'empty-topic-plan', 'empty-topics-test',
    'time-edge-test', 'dup-edge', 'remove-nonexist', 'empty-graph',
    'special-chars', 'reopen-test', 'pre-test', 'no-pre-test', 'graph-test',
  ];
  const toDelete = plans.filter(p => testPlanNames.includes(p.name)).map(p => p.id);

  // Also clean up trash items with test names
  const trashItems = store.listTrash();
  const trashToDelete = trashItems.filter(t => testPlanNames.includes(t.name)).map(t => t.id);

  const allIds = [...new Set([...toDelete, ...trashToDelete])];
  store.deletePlansByIds(allIds);

  res.json({ success: true, deleted: allIds.length });
});

// ─── Trash / Recycle Bin ───

/**
 * GET /api/learn/trash
 * List all plans in the recycle bin.
 */
router.get('/trash', (req, res) => {
  res.json({ plans: store.listTrash() });
});

/**
 * POST /api/learn/trash/:id/restore
 * Restore a plan from the recycle bin.
 */
router.post('/trash/:id/restore', async (req, res) => {
  try {
    await store.restorePlan(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/learn/trash
 * Empty the entire recycle bin.
 */
router.delete('/trash', (req, res) => {
  try {
    store.emptyTrash();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/learn/trash/:id
 * Permanently delete a plan from the recycle bin.
 */
router.delete('/trash/:id', (req, res) => {
  try {
    store.permanentlyDeleteTrash(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    res.status(500).json({ error: err.message });
  }
});

router.put('/plans/:id/topics/reorder', async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds 必须是数组' });
  try {
    const plan = await store.reorderTopics(req.params.id, orderedIds);
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/plans/:planId/topics/:topicId', async (req, res) => {
  try {
    const plan = await store.removeTopic(req.params.planId, req.params.topicId);
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/plans/:planId/topics/:topicId', async (req, res) => {
  const { done, difficulty } = req.body;
  try {
    const plan = await store.updateTopic(req.params.planId, req.params.topicId, { done, difficulty });
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

router.post('/plans/:planId/topics/:topicId/weak-points', async (req, res) => {
  const point = typeof req.body?.point === 'string' ? req.body.point.trim() : '';
  if (!point || point.length > 500) {
    return res.status(400).json({ error: '弱项必须是 1 到 500 个字符的文本' });
  }
  try {
    const result = await store.appendWeakPoint(req.params.planId, req.params.topicId, point);
    res.json({ changed: result.changed, plan: result.plan });
  } catch (err) {
    const status = /Topic not found|Plan not found/.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── AI Import ───

router.post('/plans/import', async (req, res) => {
  const { text, name: overrideName } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: '请粘贴学习计划文本' });
  }

  try {
    const { provider } = getAIInvocation(req);

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
        '## 核心要求\n' +
        '- **Phase（学习阶段）**：通常只有 1 个（除非资料明确分阶段），不要把每个章节都当成一个 phase\n' +
        '- **Level=1（主要章节）**：每个 phase 下 3-6 个，反映资料的核心模块\n' +
        '- **Level=2（子知识点）**：每个 level=1 下 2-5 个\n' +
        '- 确保知识层级统帅关系清晰：level=1 统领 level=2\n\n' +
        '输出 JSON 时，第一个字段必须是 "documentAnalysis"：先写一段对整份资料的完整理解总结（主题、逻辑结构、内容风格），再输出知识点结构。\n\n' +
        '请严格按照以下结构输出 JSON：\n' +
        '{\n' +
        '  "documentAnalysis": "对整份资料的完整理解...",\n' +
        '  "name": "学习计划名称",\n' +
        '  "phases": [\n' +
        '    {\n' +
        '      "name": "核心内容",\n' +
        '      "topics": [\n' +
        '        { "title": "主要章节1", "level": 1, "subtopics": [\n' +
        '          { "title": "子知识点1", "level": 2 },\n' +
        '          { "title": "子知识点2", "level": 2 }\n' +
        '        ]},\n' +
        '        { "title": "主要章节2", "level": 1, "subtopics": [\n' +
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

    // ── Post-processing: validate and normalize phases structure ──
    // Filter out empty phases and fix common AI mistakes
    const chapterPattern = /^第[一二三四五六七八九十\d一二三四五六七八九十百]+[章节篇部]/;
    phases = phases
      .filter(p => p.topics && p.topics.length > 0)
      .map(p => {
        // If a single-phase result has a raw chapter name as phase title, rename generically
        if (phases.length === 1 && chapterPattern.test(p.name)) {
          return { ...p, name: '核心内容' };
        }
        return p;
      });

    // ── Title cleanup: strip "Sprint X:", "Part X", "第X章" etc. from all topic titles ──
    const titlePrefixPattern = /^(Sprint\s*\d+\s*[：:]\s*|Sprint\s*\d+\s*[-—–]\s*|第[一二三四五六七八九十\d]+[章节篇部][：:\s]*|Part\s*\d+\s*[：:]\s*|Phase\s*\d+\s*[：:]\s*|Chapter\s*\d+\s*[：:]\s*)/i;
    const cleanTitle = (title) => title.replace(titlePrefixPattern, '').trim();
    const cleanTopicsRecursive = (topics) => {
      if (!topics) return topics;
      return topics.map(t => ({
        ...t,
        title: cleanTitle(t.title),
        subtopics: t.subtopics ? cleanTopicsRecursive(t.subtopics) : t.subtopics,
      }));
    };
    phases = phases.map(p => ({ ...p, topics: cleanTopicsRecursive(p.topics) }));

    const plan = await store.createPlanWithPhases(planName, phases, relations);

    // ── Infer missing prerequisites from topic ordering ──
    // If AI didn't output explicit relations, infer basic prerequisite chains:
    // topics earlier in the same phase are prerequisites for later ones
    if ((!relations || relations.length === 0) && plan.topics.length > 1) {
      const sorted = [...plan.topics].sort((a, b) => a.order - b.order);
      const phaseGroups = {};
      for (const t of sorted) {
        if (!phaseGroups[t.phaseId]) phaseGroups[t.phaseId] = [];
        phaseGroups[t.phaseId].push(t);
      }
      for (const group of Object.values(phaseGroups)) {
        for (let i = 1; i < group.length; i++) {
          const prev = group[i - 1];
          const curr = group[i];
          if (!curr.prerequisites || curr.prerequisites.length === 0) {
            await store.updateTopic(plan.id, curr.id, { prerequisites: [prev.id] });
          }
        }
      }
    }

    res.json({ plan });
  } catch (err) {
    console.error('[import]', err);
    res.status(500).json({ error: '解析失败: ' + err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/infer-relations
 * Trigger AI inference of topic relationships for a plan.
 * Fire-and-forget: responds immediately, inference runs in background.
 * Idempotent: skips if relations have already been inferred.
 */
router.post('/plans/:planId/infer-relations', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  // Already inferred or has existing relationships?
  if (plan.relationsInferredAt) {
    return res.json({ status: 'already_inferred', inferredAt: plan.relationsInferredAt });
  }

  // Check if any topic already has relationship data (e.g. from AI import)
  const hasAnyRelations = plan.topics.some(t =>
    (t.prerequisites && t.prerequisites.length > 0) ||
    (t.relatedTopics && t.relatedTopics.length > 0) ||
    t.parentId
  );
  if (hasAnyRelations) {
    // Mark as inferred to avoid re-checking
    await store.markRelationsInferred(plan.id);
    return res.json({ status: 'already_populated' });
  }

  // Respond immediately — inference runs in background
  res.json({ status: 'inferring' });

  try {
    const { provider, model } = getAIInvocation(req);
    await inferTopicRelations(provider, plan, model);

    // Mark plan as inferred
    await store.markRelationsInferred(plan.id);
    console.log(`[infer-relations] Completed for plan ${plan.id} (${plan.name})`);
  } catch (err) {
    console.error(`[infer-relations] Failed for plan ${plan.id}:`, err.message);
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


// ─── Learning Analysis ───

/**
 * POST /api/learn/plans/:id/analysis
 * Generate AI-powered learning analysis and insights.
 */
router.post('/plans/:id/analysis', async (req, res) => {
  try {
    const plan = store.getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: '计划不存在' });

    const { provider } = getAIInvocation(req);
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

    const { provider } = getAIInvocation(req);
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
 * POST /api/learn/plans/:planId/core-topics
 * Analyze core ~20% topics using the Pareto principle (AI-driven).
 * Results are cached on the plan for reuse.
 */
router.post('/plans/:planId/core-topics', async (req, res) => {
  try {
    const plan = store.getPlan(req.params.planId);
    if (!plan) return res.status(404).json({ error: '计划不存在' });

    const { provider, model } = getAIInvocation(req);
    const force = req.body?.force === true;
    const result = await analyzeCoreTopics(provider, plan, model, { force });
    res.json(result);
  } catch (err) {
    console.error('[core-topics]', err);
    try {
      res.status(500).json({ error: '核心分析失败: ' + (err.message || err) });
    } catch {
      res.status(500).end('分析失败');
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
    const { provider, model } = getAIInvocation(req);
    const review = await generateReview(provider, plan, req.params.topicId, model);
    const exercises = store.parseExercisesFromDetail(review);
    res.json({ review, exercises });
  } catch (err) {
  console.error('[review]', err);
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
    const { provider } = getAIInvocation(req);
    const results = await gradeExercises(provider, plan, req.params.topicId, answers);

    // ── Data flywheel: update user profile with latest exercise results ──
    try {
      const allPlans = store.listPlans().map(p => store.getPlan(p.id)).filter(Boolean);
      dataFlywheelUpdate(allPlans);
    } catch (fwErr) {
      console.warn('[flywheel] exercise submit update failed (non-fatal):', fwErr.message);
    }

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
    const { provider, model } = getAIInvocation(req);
    const results = await analyzeWeakPoints(provider, plan, model);

    // ── Data flywheel: update user profile with weak point analysis results ──
    try {
      const allPlans = store.listPlans().map(p => store.getPlan(p.id)).filter(Boolean);
      dataFlywheelUpdate(allPlans);
    } catch (fwErr) {
      console.warn('[flywheel] weak-point analysis update failed (non-fatal):', fwErr.message);
    }

    res.json({ weakPoints: results });
  } catch (err) {
  console.error('[weak-points]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/quick-quiz
 * Generate a lightweight quick quiz from random topics.
 */
router.post('/plans/:planId/quick-quiz', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const { provider, model } = getAIInvocation(req);
    const result = await generateQuickQuiz(provider, plan, model);
    res.json(result);
  } catch (err) {
    console.error('[quick-quiz]', err);
    res.status(500).json({ error: '测验生成失败: ' + (err.message || err) });
  }
});

/**
 * POST /api/learn/plans/:planId/quick-quiz/submit
 * Save quick quiz results. Await save before flywheel refresh.
 */
router.post('/plans/:planId/quick-quiz/submit', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const { questions, results } = req.body;
    if (!Array.isArray(questions) || !Array.isArray(results)) {
      return res.status(400).json({ error: 'questions 和 results 必须是数组' });
    }
    await store.saveQuickQuizAssessment(req.params.planId, { questions, results });
    // Flywheel best-effort after successful save
    try { refreshDataFlywheel('quick-quiz'); } catch {}
    res.json({ success: true });
  } catch (err) {
    console.error('[quick-quiz-submit]', err);
    res.status(500).json({ error: '保存测验结果失败: ' + (err.message || err) });
  }
});

/**
 * POST /api/learn/plans/:planId/topic/:topicId/feedback
 * Submit generation quality feedback for a topic.
 * Body: { reason: string, mode: string }
 * Stores last 20 entries (old→new order), await persist before response.
 */
router.post('/plans/:planId/topic/:topicId/feedback', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });

  const VALID_MODES = ['detail', 'stepwise', 'realtime', 'feynman', 'challenge', 'stepwise-challenge', 'realtime-challenge', 'scaffold'];
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  const mode = typeof req.body?.mode === 'string' ? req.body.mode.trim().slice(0, 64) : '';
  if (!reason || !mode) {
    return res.status(400).json({ error: '请提供非空的 reason 和 mode 参数' });
  }
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode 必须是: ${VALID_MODES.join(', ')}` });
  }

  try {
    const entry = { reason, mode, timestamp: Date.now() };
    const result = await store.appendGenerationFeedback(req.params.planId, req.params.topicId, entry, 20);
    res.json({ success: true, total: result.total });
  } catch (err) {
    console.error('[topic-feedback]', err);
    res.status(500).json({ error: '保存反馈失败' });
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

export default router;
