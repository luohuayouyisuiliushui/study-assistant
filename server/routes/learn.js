import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { generateDetail, generateDetailWithImage, answerFollowUp, answerAnalysisFollowUp, getEngineCacheDiagnostics, createProviderFromConfig, analyzeLearning, generateReview, gradeExercises, analyzeWeakPoints, generateQuickQuiz, startInteractiveDetail, continueInteractiveDetail, revealEmbeddedErrors, decomposeTopic, textToSpeech, streamInteractiveStart, analyzeFeynmanSession } from '../engine/learn-engine.js';

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

router.delete('/plans/:id', async (req, res) => {
  await store.deletePlan(req.params.id);
  res.json({ success: true });
});

/**
 * POST /api/learn/plans/batch-delete
 * Permanently delete multiple plans by their IDs (skips trash).
 * Body: { ids: ["id1", "id2", ...] }
 */
router.post('/plans/batch-delete', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供要删除的计划 ID 数组' });
  }
  store.deletePlansByIds(ids);
  res.json({ success: true, deleted: ids.length });
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
router.post('/trash/:id/restore', (req, res) => {
  try {
    store.restorePlan(req.params.id);
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

    const plan = store.createPlanWithPhases(planName, phases, relations);

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
  if (!['stepwise', 'realtime', 'challenge', 'scaffold', 'feynman'].includes(mode)) {
    return res.status(400).json({ error: 'mode 必须是 stepwise、realtime、challenge、scaffold 或 feynman' });
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
  if (!['stepwise', 'realtime', 'challenge', 'scaffold', 'feynman'].includes(mode)) {
    return res.status(400).json({ error: 'mode 必须是 stepwise、realtime、challenge、scaffold 或 feynman' });
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
      onDone: (result) => writeEvent({ type: 'done', content: result.content || '', session: result.session }),
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
 * POST /api/learn/plans/:planId/quick-quiz
 * Generate a lightweight quick quiz from random topics.
 */
router.post('/plans/:planId/quick-quiz', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const provider = getProvider(req);
    const result = await generateQuickQuiz(provider, plan, getModel(req));
    res.json(result);
  } catch (err) {
    console.error('[quick-quiz]', err);
    res.status(500).json({ error: '测验生成失败: ' + (err.message || err) });
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

// ═══════════════════════════════════════════════════════
//  EXAM PAPER ROUTES
// ═══════════════════════════════════════════════════════

/**
 * POST /api/learn/plans/:planId/exam/generate
 * Generate an exam paper covering selected topics.
 * Body: { topicIds: string[], config: { questionCount, choiceRatio } }
 */
router.post('/plans/:planId/exam/generate', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const { topicIds, config } = req.body;
  if (!topicIds || !Array.isArray(topicIds) || topicIds.length === 0) {
    return res.status(400).json({ error: '请选择至少一个知识点' });
  }

  try {
    const provider = getProvider(req);
    const exam = await generateExam(provider, plan, topicIds, config || {}, getModel(req));
    res.json({ exam });
  } catch (err) {
    console.error('[exam/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/exam/:examId/submit
 * Submit exam answers for AI grading.
 * Body: { answers: [{ exerciseIndex, userAnswer }] }
 */
router.post('/plans/:planId/exam/:examId/submit', async (req, res) => {
  const { answers } = req.body;
  if (!answers || !Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: '请提供试卷答案' });
  }

  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const provider = getProvider(req);
    const results = await gradeExam(provider, plan, req.params.examId, answers);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/exam/generate-stream
 * Generate exam with SSE streaming (questions arrive progressively).
 * Body: { topicIds: string[], config: { questionCount, choiceRatio } }
 */
router.post('/plans/:planId/exam/generate-stream', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  const { topicIds, config } = req.body;
  if (!topicIds || !Array.isArray(topicIds) || topicIds.length === 0) {
    return res.status(400).json({ error: '请选择至少一个知识点' });
  }
  if (topicIds.length > 50) {
    return res.status(400).json({ error: '一次性最多选择50个知识点' });
  }
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    // Connection keepalive: send initial event
    res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n');

    // Timeout protection: abort after 120 seconds
    const timeout = setTimeout(() => {
      try {
        res.write('data: ' + JSON.stringify({ type: 'error', data: '生成超时，请重试' }) + '\n\n');
        res.end();
      } catch {}
    }, 120_000);

    // Client disconnect cleanup
    let aborted = false;
    res.on('close', () => { aborted = true; clearTimeout(timeout); });

    const provider = getProvider(req);
    const writeEvent = (event) => {
      if (aborted) return;
      try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch { aborted = true; }
    };
    await generateExamStream(provider, plan, topicIds, config || {}, writeEvent, getModel(req));
    clearTimeout(timeout);
    if (!aborted) res.end();
  } catch (err) {
    console.error('[exam/generate-stream]', err);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    try { res.write('data: ' + JSON.stringify({ type: 'error', data: err.message }) + '\n\n'); res.end(); } catch {}
  }
});


/**
 * GET /api/learn/plans/:planId/exams
 * List all saved exam papers.
 */
router.get('/plans/:planId/exams', (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const exams = store.getExamPapers(req.params.planId);
  res.json({ exams });
});

/**
 * DELETE /api/learn/plans/:planId/exam/:examId
 * Delete a saved exam paper.
 */
router.delete('/plans/:planId/exam/:examId', (req, res) => {
  try {
    store.deleteExamPaper(req.params.planId, req.params.examId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/exam/:examId/practice
 * Generate targeted practice questions based on exam mistakes.
 * Body: { count: number }
 */
router.post('/plans/:planId/exam/:examId/practice', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const count = req.body?.count || 5;
  try {
    const provider = getProvider(req);
    const questions = await generateExamPractice(provider, plan, req.params.examId, count, getModel(req));
    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

/**
 * POST /api/learn/plans/:planId/feynman-analyze/:topicId
 * Analyze a Feynman learning session transcript.
 */
router.post('/plans/:planId/feynman-analyze/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '\u8ba1\u5212\u4e0d\u5b58\u5728' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '\u77e5\u8bc6\u70b9\u4e0d\u5b58\u5728' });

  const session = topic.interactiveSession;
  if (!session || !session.transcript || session.transcript.length === 0) {
    return res.status(400).json({ error: '\u6ca1\u6709\u8d39\u66fc\u5b66\u4e60\u5bf9\u8bdd\u8bb0\u5f55' });
  }

  try {
    const provider = getProvider(req);
    const insights = await analyzeFeynmanSession(provider, session.transcript, topic.title);
    topic.feynmanInsights = insights;
    await store.updateTopic(req.params.planId, req.params.topicId, { feynmanInsights: insights });
    res.json(insights);
  } catch (err) {
    console.error('[feynman-analyze]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;