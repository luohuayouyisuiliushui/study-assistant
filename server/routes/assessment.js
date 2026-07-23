import { createHash } from 'node:crypto';
import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { getEngineCacheDiagnostics, createProviderFromConfig,
  generateExamStream, generateExam, gradeExam, generateExamPractice,
  analyzeFeynmanSession, factCheckDetail, autoFixUncertainClaims,
  applyFixesToContent, buildFactCheckReport } from '../engine/learn-engine.js';
import { analyzePlanAdaptive, dataFlywheelUpdate, AdaptivePromptInjector } from '../engine/adaptive-engine.js';
import { getUserProfile } from '../engine/user-profile.js';
import { getProvider, getModel, getDispatcher, wantsAgentDispatch } from './middleware.js';
import { refreshDataFlywheel } from './flywheel.js';
import AgentDispatcher from '../engine/agent-dispatcher.js';

const router = Router();

function readAttemptRef(body) {
  if (typeof body?.attemptRef !== 'string') return null;
  const attemptRef = body.attemptRef.trim();
  return attemptRef.length >= 8 && attemptRef.length <= 128 ? attemptRef : null;
}

function assessmentErrorStatus(error) {
  return error instanceof TypeError || error instanceof RangeError || /Topic not found/.test(error.message)
    ? 400
    : 500;
}
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
    const model = getModel(req);

    // ── Agent dispatch (opt-in) ──
    if (wantsAgentDispatch(req)) {
      const dispatcher = getDispatcher(req);
      const { result } = await dispatcher.dispatch('examGenerate',
        (provider) => generateExam(provider, plan, topicIds, config || {}, model)
      );
      return res.json({ exam: result });
    }

    const provider = getProvider(req);
    const exam = await generateExam(provider, plan, topicIds, config || {}, model);
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
  const attemptRef = readAttemptRef(req.body);
  if (!attemptRef) return res.status(400).json({ error: 'attemptRef 必须是 8..128 字符' });

  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  try {
    const provider = getProvider(req);
    const results = await gradeExam(provider, plan, req.params.examId, answers, {
      attemptRef,
      observedAt: Date.now(),
    });

    // ── Data flywheel: update user profile with latest exam results ──
    setImmediate(() => {
      try {
        const allPlans = store.listPlans().map(p => store.getPlan(p.id)).filter(Boolean);
        dataFlywheelUpdate(allPlans);
      } catch (fwErr) {
        console.warn('[flywheel] exam submit update failed (non-fatal):', fwErr.message);
      }
    });

    res.json({ results });
  } catch (err) {
    res.status(assessmentErrorStatus(err)).json({ error: err.message });
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

  const count = Math.max(1, Math.min(20, parseInt(req.body?.count) || 5));
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

// ═══════════════════════════════════════════════════════
//  FACT-CHECK ROUTES (Anti-Hallucination Engine)
// ═══════════════════════════════════════════════════════

/**
 * POST /api/learn/plans/:planId/fact-check/:topicId
 * Run a full fact-check audit on a topic's generated detail.
 * Returns structured findings with confidence scores.
 */
router.post('/plans/:planId/fact-check/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });
  if (!topic.detail) return res.status(400).json({ error: '该知识点还没有讲解内容' });

  try {
    const provider = getProvider(req);
    const result = await factCheckDetail(provider, topic.detail, topic.title, getModel(req));

    // Store fact-check result on topic
    await store.updateTopic(req.params.planId, req.params.topicId, { factCheck: result });

    // Also build a human-readable report
    const report = buildFactCheckReport(result);
    res.json({ factCheck: result, report });
  } catch (err) {
    console.error('[fact-check]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/fact-check-auto-fix/:topicId
 * Auto-fix uncertain/wrong claims identified in the fact-check report.
 * Merges corrections back into the topic detail.
 * Body: { findings: [...] } — the uncertain findings from the fact-check
 */
router.post('/plans/:planId/fact-check-auto-fix/:topicId', async (req, res) => {
  const plan = store.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '计划不存在' });

  const topic = plan.topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: '知识点不存在' });
  if (!topic.detail) return res.status(400).json({ error: '该知识点还没有讲解内容' });

  const { findings } = req.body || {};
  if (!findings || !Array.isArray(findings) || findings.length === 0) {
    return res.status(400).json({ error: '请提供待修正的存疑陈述列表' });
  }

  try {
    const provider = getProvider(req);
    const fixes = await autoFixUncertainClaims(provider, findings, getModel(req));
    const { content: corrected, fixedCount } = applyFixesToContent(topic.detail, fixes);

    if (corrected !== topic.detail && fixedCount > 0) {
      await store.updateTopic(req.params.planId, req.params.topicId, { detail: corrected });
      res.json({ corrected: true, fixedCount, detail: corrected, fixes });
    } else {
      res.json({ corrected: false, fixedCount: 0, message: '无需修改或修正未能匹配到原文', fixes });
    }
  } catch (err) {
    console.error('[fact-check-auto-fix]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/plans/:planId/adaptive-analysis
 * Run adaptive analysis: error state machine + user profile injection + intervention recommendations.
 * Returns structured recommendations for what the user should focus on next.
 */
router.post('/plans/:planId/adaptive-analysis', (req, res) => {
  try {
    const plan = store.getPlan(req.params.planId);
    if (!plan) return res.status(404).json({ error: '计划不存在' });

    const result = analyzePlanAdaptive(plan);
    res.json(result);
  } catch (err) {
    console.error('[adaptive-analysis]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/learn/adaptive-context
 * Get the adaptive context string that would be injected into prompts.
 * Useful for previewing what personalization looks like before generating.
 */
router.post('/adaptive-context', (req, res) => {
  try {
    const profile = getUserProfile();
    const injector = new AdaptivePromptInjector(profile);
    const context = injector.buildAdaptiveContext();
    res.json({
      hasProfile: injector.hasMeaningfulProfile,
      context,
      compactHint: injector.compactHint,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const transcriptDigest = createHash('sha256')
      .update(JSON.stringify(session.transcript.map(message => ({
        role: message.role,
        content: message.content,
      }))), 'utf8')
      .digest('hex');
    await store.saveFeynmanResults(req.params.planId, req.params.topicId, insights, {
      attemptRef: transcriptDigest,
      observedAt: Date.now(),
    });
    res.json(insights);
    // Flywheel: Feynman analysis adds behavioral evidence
    refreshDataFlywheel('feynman-analyze');
  } catch (err) {
    console.error('[feynman-analyze]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents/list', (req, res) => {
  res.json({ agents: AgentDispatcher.listAgents() });
});

router.post('/agents/usage', (req, res) => {
  const dispatcher = getDispatcher(req);
  res.json({ usage: dispatcher.usageStats });
});

// ═══════════════════════════════════════════════════════
export default router;
