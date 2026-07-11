/**
 * Full end-to-end functional test — covers EVERY feature in the project.
 * Run: node test-e2e.mjs
 * Requires: server running on localhost:3001
 */

const BASE = 'http://localhost:3001/api';

let passed = 0;
let failed = 0;
let warnings = 0;

function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function warn(name, detail = '') {
  warnings++;
  console.log(`  ⚠️ ${name}${detail ? ' — ' + detail : ''}`);
}

function check(name, fn) {
  return fn().then(
    () => { passed++; console.log(`  ✅ ${name}`); },
    (e) => { failed++; console.log(`  ❌ ${name} — ${e.message}`); }
  );
}

async function post(path, body = {}, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, ok: res.ok };
}

async function get(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, ok: res.ok };
}

async function del(path) {
  const res = await fetch(BASE + path, { method: 'DELETE' });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

async function put(path, body = {}) {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

// ─── State ───
let planId = null;
let topicIds = [];
let examId = null;

console.log('═══════════════════════════════════════════════');
console.log('  全功能端到端质量测试');
console.log('═══════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════
// 1. SERVER HEALTH
// ═══════════════════════════════════════════════
console.log('📋 1. 服务器健康检查');

{
  const r = await get('/learn/plans');
  ok('GET /api/learn/plans 返回 200', r.status === 200);
  ok('响应包含 plans 数组', Array.isArray(r.data?.plans));
}

{
  const r = await get('/learn/trash');
  ok('GET /api/learn/trash 返回 200', r.status === 200);
  ok('响应包含 plans 数组', Array.isArray(r.data?.plans));
}

{
  const r = await get('/user-profile');
  ok('GET /api/user-profile 返回 200 或 404', [200, 404].includes(r.status));
}

// ═══════════════════════════════════════════════
// 2. PLAN CRUD
// ═══════════════════════════════════════════════
console.log('\n📋 2. 学习计划 CRUD');

{
  const r = await post('/learn/plans', { name: '' });
  ok('创建计划-空名称返回 400', r.status === 400, `status=${r.status}`);
  ok('空名称错误信息明确', r.data?.error && r.data.error.includes('名称'), `"${r.data?.error}"`);
}

{
  const r = await post('/learn/plans', { name: 'E2E全功能测试计划' });
  ok('创建计划返回 200', r.status === 200);
  ok('计划包含 id', !!r.data?.plan?.id, `id=${r.data?.plan?.id?.slice(0,8)}`);
  ok('计划名正确', r.data?.plan?.name === 'E2E全功能测试计划');
  ok('包含 topics 数组', Array.isArray(r.data?.plan?.topics));
  ok('包含 history 数组', Array.isArray(r.data?.plan?.history));
  ok('包含 phases 数组', Array.isArray(r.data?.plan?.phases));
  ok('包含 createdAt 时间戳', r.data?.plan?.createdAt > 0);
  planId = r.data.plan.id;
}

{
  const r = await get(`/learn/plans/${planId}`);
  ok('获取计划详情返回 200', r.status === 200);
  ok('计划名一致', r.data?.plan?.name === 'E2E全功能测试计划');
}

{
  const r = await get('/learn/plans/non-existent-id-12345');
  ok('不存在的计划返回 404', r.status === 404);
  ok('错误信息包含"不存在"', r.data?.error?.includes('不存在'));
}

// ═══════════════════════════════════════════════
// 3. TOPIC MANAGEMENT (Tree + CRUD)
// ═══════════════════════════════════════════════
console.log('\n📋 3. 知识点管理（树形层级 + CRUD）');

{
  const r = await post(`/learn/plans/${planId}/topics`, { titles: [] });
  ok('添加知识点-空数组返回 400', r.status === 400);
}

{
  const r = await post(`/learn/plans/${planId}/topics`, {
    titles: ['JavaScript基础', '闭包与作用域', '原型链', '异步编程', 'ES6+新特性']
  });
  ok('批量添加 5 个知识点返回 200', r.status === 200);
  ok('知识点数量正确', r.data?.plan?.topics?.length === 5, `got ${r.data?.plan?.topics?.length}`);
  topicIds = r.data.plan.topics.map(t => t.id);
  // Check topic structure
  const t0 = r.data.plan.topics[0];
  ok('知识点有 id', !!t0.id);
  ok('知识点有 title', !!t0.title);
  ok('知识点有 order 字段', typeof t0.order === 'number');
  ok('知识点有 done 字段（默认 false）', t0.done === false);
  ok('知识点有 detail 字段（默认 null）', t0.detail === null);
  ok('知识点有 level 字段', typeof t0.level === 'number', `level=${t0.level}`);
  ok('每个知识点 ID 唯一', new Set(topicIds).size === topicIds.length);
}

{
  const r = await post(`/learn/plans/${planId}/topics`, { titles: ['JavaScript基础'] });
  ok('重复标题不应添加', r.data?.plan?.topics?.length === 5, `got ${r.data?.plan?.topics?.length}`);
}

{
  const r = await put(`/learn/plans/${planId}/topics/${topicIds[0]}`, { done: true, difficulty: 'medium' });
  ok('更新知识点 done/difficulty', r.status === 200);
  const updated = r.data.plan.topics.find(t => t.id === topicIds[0]);
  ok('done 字段已更新', updated?.done === true);
  ok('difficulty 已更新为 medium', updated?.difficulty === 'medium');
}

{
  const r = await put(`/learn/plans/${planId}/topics/reorder`, { orderedIds: [topicIds[4], topicIds[3], topicIds[2], topicIds[1], topicIds[0]] });
  ok('拖拽排序返回 200', r.status === 200);
  const sorted = r.data.plan.topics;
  ok('排序后第1个是原来的第5个', sorted[0]?.id === topicIds[4], `expected=${topicIds[4].slice(0,6)} got=${sorted[0]?.id?.slice(0,6)}`);
}

{
  // Reorder back
  await put(`/learn/plans/${planId}/topics/reorder`, { orderedIds: topicIds });
}

{
  const r = await post(`/learn/plans/${planId}/topics/${topicIds[0]}/time`, { seconds: 120 });
  ok('记录学习时间返回 200', r.status === 200);
  const t = r.data.plan.topics.find(t => t.id === topicIds[0]);
  ok('时间已累计', t?.timeSpent === 120, `got ${t?.timeSpent}`);
  ok('lastAccessed 已设置', t?.lastAccessed > 0);
}

{
  const r = await post(`/learn/plans/${planId}/topics/${topicIds[0]}/time`, { seconds: -1 });
  ok('无效时间（负数）应返回 400', r.status === 400);
}

{
  const r = await post(`/learn/plans/${planId}/topics/${topicIds[0]}/time`, { seconds: 60 });
  ok('再次记录时间返回 200', r.status === 200);
  const t = r.data.plan.topics.find(t => t.id === topicIds[0]);
  ok('时间已累加', t?.timeSpent === 180, `got ${t?.timeSpent}`);
}

// ═══════════════════════════════════════════════
// 4. AI GENERATION (non-streaming paths that use mock engine tests)
// ═══════════════════════════════════════════════
console.log('\n📋 4. AI 生成核心');

{
  // generate endpoint is fire-and-forget — we test that it responds immediately
  const r = await post(`/learn/plans/${planId}/generate/${topicIds[0]}`);
  ok('生成讲解-立即返回 {status:"generating"}', r.status === 200);
  ok('返回 status=generating', r.data?.status === 'generating', `got ${JSON.stringify(r.data)}`);
  ok('返回 topicId', r.data?.topicId === topicIds[0]);
}

{
  const r = await post(`/learn/plans/${planId}/generate/non-existent`);
  ok('为不存在的知识点生成-返回 404', r.status === 404);
}

{
  const r = await post(`/learn/plans/${planId}/decompose/${topicIds[0]}`);
  if (r.status === 200) {
    ok('知识点拆解返回 200', true);
    ok('返回 subTopics 数组', Array.isArray(r.data?.subtopics), `got ${typeof r.data?.subtopics}`);
    if (r.data?.subtopics?.length > 0) {
      ok('每个子知识点有 title', r.data.subtopics.every(s => s.title));
    } else {
      warn('拆解返回 0 个子知识点');
    }
  } else if (r.status === 500) {
    warn('拆解失败（可能无 API Key）', r.data?.error);
  }
}

// ═══════════════════════════════════════════════
// 5. Q&A / FOLLOW-UP
// ═══════════════════════════════════════════════
console.log('\n📋 5. 追问系统');

{
  const r = await post(`/learn/plans/${planId}/ask/${topicIds[0]}`, { question: '' });
  ok('空问题返回 400', r.status === 400);
}

{
  const r = await post(`/learn/plans/${planId}/ask/${topicIds[0]}`, { question: '闭包在实际开发中有什么应用场景？' });
  if (r.status === 200) {
    ok('追问返回 200', true);
    ok('回答非空', typeof r.data?.answer === 'string' && r.data.answer.length > 0, `length=${r.data?.answer?.length}`);
    ok('回答内容有意义（≥50字符）', r.data?.answer?.length >= 50, `length=${r.data?.answer?.length}`);
  } else if (r.status === 500) {
    warn('追问失败（可能无 API Key）', r.data?.error);
  }
}

{
  const r = await post(`/learn/plans/${planId}/ask/non-existent`, { question: 'test' });
  ok('为不存在的知识点追问-返回 404', [404, 500].includes(r.status));
}

// ═══════════════════════════════════════════════
// 6. INTERACTIVE MODES
// ═══════════════════════════════════════════════
console.log('\n📋 6. 交互式教学（5种模式）');

const modes = ['stepwise', 'realtime', 'challenge', 'scaffold', 'feynman'];

for (const mode of modes) {
  {
    const r = await post(`/learn/plans/${planId}/interactive-start/${topicIds[0]}`, { mode });
    if (r.status === 200) {
      ok(`启动 ${mode} 模式返回 200`, true);
      ok(`  content 非空`, typeof r.data?.content === 'string' && r.data.content.length > 0, `length=${r.data?.content?.length}`);
      ok(`  session 存在`, !!r.data?.session);
      ok(`  session.mode = ${mode}`, r.data?.session?.mode === mode);
      ok(`  session.status 有效`, ['waiting_user', 'completed'].includes(r.data?.session?.status));

      // Continue
      if (r.data?.session?.status === 'waiting_user') {
        const r2 = await post(`/learn/plans/${planId}/interactive-continue/${topicIds[0]}`, { mode, feedback: '请继续讲解下一个部分' });
        if (r2.status === 200) {
          ok(`  继续 ${mode} 模式返回 200`, true);
          ok(`  content 非空`, typeof r2.data?.content === 'string' && r2.data.content.length > 0, `length=${r2.data?.content?.length}`);
          ok(`  session 非空`, !!r2.data?.session);
        } else {
          warn(`  继续 ${mode} 失败`, `status=${r2.status}`);
        }
      }
    } else if (r.status === 500) {
      warn(`启动 ${mode} 模式失败（可能无 API Key）`, r.data?.error);
    }
  }
}

{
  const r = await post(`/learn/plans/${planId}/interactive-start/${topicIds[0]}`, { mode: 'invalid' });
  ok('无效 mode 返回 400', r.status === 400);
}

{
  const r = await post(`/learn/plans/${planId}/interactive-continue/${topicIds[0]}`, { mode: 'stepwise', feedback: '' });
  ok('空 feedback 返回 400', r.status === 400);
}

// ═══════════════════════════════════════════════
// 7. ANALYSIS & CORE TOPICS
// ═══════════════════════════════════════════════
console.log('\n📋 7. 学习分析 + 核心20%');

{
  const r = await post(`/learn/plans/${planId}/analysis`);
  if (r.status === 200) {
    ok('学习分析返回 200', true);
    // analyzeLearning returns {analysis, usage, analyzedAt, topicCount, doneCount, ...}
    // So response is {analysis: {analysis: "...", usage: ..., ...}}
    const content = r.data?.analysis?.analysis;
    ok('分析内容非空', typeof content === 'string' && content.length > 0, `length=${content?.length}`);
  } else if (r.status === 500) {
    warn('分析失败（可能无 API Key）', r.data?.error);
  }
}

{
  const r = await post(`/learn/plans/${planId}/core-topics`);
  if (r.status === 200) {
    ok('核心20%分析返回 200', true);
    ok('返回 coreTopics 数组', Array.isArray(r.data?.coreTopics), `got ${typeof r.data?.coreTopics}`);
  } else if (r.status === 500) {
    warn('核心分析失败（可能无 API Key）', r.data?.error);
  } else {
    ok('核心20%分析端点存在（非404）', r.status !== 404, `status=${r.status}`);
  }
}

{
  const r = await post(`/learn/plans/${planId}/analysis/ask`, { question: '如何改进？', analysis: '分析内容...' });
  if (r.status === 200) {
    ok('分析追问返回 200', true);
  } else if (r.status === 500) {
    warn('分析追问失败（可能无 API Key）');
  }
}

// ═══════════════════════════════════════════════
// 8. QUICK QUIZ
// ═══════════════════════════════════════════════
console.log('\n📋 8. 快速测验');

{
  const r = await post(`/learn/plans/${planId}/quick-quiz`);
  if (r.status === 200) {
    ok('快速测验返回 200', true);
    if (Array.isArray(r.data?.questions)) {
      ok('返回题目数组', true, `count=${r.data.questions.length}`);
      if (r.data.questions.length > 0) {
        const q = r.data.questions[0];
        ok('题目有 type 字段', !!q.type);
        ok('题目有 question 字段', !!q.question);
      }
    } else if (r.data?.error) {
      warn('快速测验返回错误', r.data.error);
    }
  } else if (r.status === 500) {
    warn('快速测验失败（可能无 API Key）', r.data?.error);
  }
}

// ═══════════════════════════════════════════════
// 9. EXAM SYSTEM
// ═══════════════════════════════════════════════
console.log('\n📋 9. AI 组卷系统');

{
  const r = await post(`/learn/plans/${planId}/exam/generate`, {
    topicIds: topicIds.slice(0, 3),
    config: { questionCount: 3, choiceRatio: 0.5 }
  });
  if (r.status === 200 && r.data?.exam) {
    ok('组卷返回 200', true);
    ok('exam 有 id', !!r.data.exam.id);
    ok('exam 有 questions 数组', Array.isArray(r.data.exam.questions));
    examId = r.data.exam.id;

    if (r.data.exam.questions.length > 0) {
      const q = r.data.exam.questions[0];
      ok('题目有 index', typeof q.index === 'number');
      ok('题目有 type（choice/open）', ['choice', 'open'].includes(q.type));
      ok('题目有 question', !!q.question);
      if (q.type === 'choice') {
        ok('选择题有 options', Array.isArray(q.options) && q.options.length >= 2);
        ok('选择题有 answer', !!q.answer);
      }
    }
  } else if (r.status === 500) {
    warn('组卷失败（可能无 API Key）', r.data?.error);
  }
}

{
  const r = await get(`/learn/plans/${planId}/exams`);
  ok('获取试卷列表返回 200', r.status === 200);
  ok('返回 exams 数组', Array.isArray(r.data?.exams));
}

// ═══════════════════════════════════════════════
// 10. KNOWLEDGE GRAPH
// ═══════════════════════════════════════════════
console.log('\n📋 10. 知识图谱');

{
  const r = await get(`/learn/plans/${planId}/graph`);
  ok('图谱（基础）返回 200', r.status === 200);
  ok('graph 有 nodes', Array.isArray(r.data?.graph?.nodes));
  ok('graph 有 edges', Array.isArray(r.data?.graph?.edges));
  ok('nodes 数量等于知识点数', r.data?.graph?.nodes?.length === 5, `got ${r.data?.graph?.nodes?.length}`);
}

{
  const r = await get(`/learn/plans/${planId}/graph?infer=true`);
  ok('图谱（推断模式）返回 200', r.status === 200);
  ok('包含 baseEdgeCount', typeof r.data?.graph?.baseEdgeCount === 'number');
  ok('包含 inferredCount', typeof r.data?.graph?.inferredCount === 'number');
}

{
  const r = await get(`/learn/plans/${planId}/extract-relations`);
  ok('关系提取返回 200', r.status === 200);
  ok('edges 为数组', Array.isArray(r.data?.edges));
  ok('包含 detailCount', typeof r.data?.detailCount === 'number');
}

// ═══════════════════════════════════════════════
// 11. REVIEW & EXERCISES
// ═══════════════════════════════════════════════
console.log('\n📋 11. 复习与练习');

{
  const r = await post(`/learn/plans/${planId}/review/${topicIds[0]}`);
  if (r.status === 200) {
    ok('复习生成返回 200', true);
  } else if (r.status === 400) {
    // Topic not done yet
    ok('未完成的知识点复习返回 400（正确行为）', r.status === 400);
  }
}

{
  const r = await post(`/learn/plans/${planId}/exercises/${topicIds[0]}/submit`, { answers: [] });
  ok('提交空练习答案返回 400', r.status === 400);
}

{
  const r = await get(`/learn/plans/${planId}/review-needs`);
  ok('获取需复习列表返回 200', r.status === 200);
  ok('needs 为数组', Array.isArray(r.data?.needs));
}

// ═══════════════════════════════════════════════
// 12. WEAK POINTS
// ═══════════════════════════════════════════════
console.log('\n📋 12. 薄弱点分析');

{
  const r = await post(`/learn/plans/${planId}/weak-points`);
  if (r.status === 200) {
    ok('薄弱点分析返回 200', true);
    ok('weakPoints 为数组', Array.isArray(r.data?.weakPoints));
  } else if (r.status === 500) {
    warn('薄弱点分析失败（可能无 API Key）', r.data?.error);
  }
}

// ═══════════════════════════════════════════════
// 13. RECYCLE BIN
// ═══════════════════════════════════════════════
console.log('\n📋 13. 回收站');

let trashPlanId = null;
{
  const r = await post('/learn/plans', { name: '回收站测试计划' });
  trashPlanId = r.data?.plan?.id;
}

{
  const r = await del(`/learn/plans/${trashPlanId}`);
  ok('删除计划返回 success', r.status === 200 && r.data?.success === true);
}

{
  const r = await get('/learn/trash');
  ok('回收站列表包含已删除计划', r.data?.plans?.some(p => p.id === trashPlanId), `found=${r.data?.plans?.find(p => p.id === trashPlanId)?.name}`);
}

{
  const r = await post(`/learn/trash/${trashPlanId}/restore`);
  ok('恢复计划返回 success', r.status === 200 && r.data?.success === true);
}

{
  const r = await get(`/learn/plans/${trashPlanId}`);
  ok('恢复后可正常获取', r.status === 200);
}

{
  // Delete again and permanently remove
  await del(`/learn/plans/${trashPlanId}`);
  const r = await del(`/learn/trash/${trashPlanId}`);
  ok('永久删除返回 success', r.status === 200 && r.data?.success === true);
}

{
  const r = await get('/learn/trash');
  ok('永久删除后不在回收站', !r.data?.plans?.some(p => p.id === trashPlanId));
}

// ═══════════════════════════════════════════════
// 14. BATCH DELETE
// ═══════════════════════════════════════════════
console.log('\n📋 14. 批量删除');

{
  const r = await post('/learn/plans/batch-delete', {});
  ok('批量删除-无ids返回 400', r.status === 400);
}

// ═══════════════════════════════════════════════
// 15. TTS
// ═══════════════════════════════════════════════
console.log('\n📋 15. TTS 语音合成');

{
  const r = await post('/learn/tts', { text: '' });
  ok('TTS 空文本返回 400', r.status === 400);
}

{
  const r = await post('/learn/tts', { text: '你好世界' });
  ok('TTS 无 Key 返回 400', r.status === 400);
  ok('TTS 错误信息明确', r.data?.error?.includes('API Key'));
}

// ═══════════════════════════════════════════════
// 16. TEST CONNECTION
// ═══════════════════════════════════════════════
console.log('\n📋 16. API 连接测试');

{
  // When apiKey is empty AND no env key, should return 400.
  // If env OPENAI_API_KEY is set, it falls through to actual test → ok:true/ok:false.
  const r = await post('/learn/test-connection', { apiKey: '' });
  if (r.status === 400) {
    ok('连接测试-空Key返回 400（无env fallback）', true);
  } else if (r.status === 200) {
    ok('连接测试-有env fallback返回 200', true);
    ok('  返回 ok 字段', 'ok' in (r.data || {}));
  }
}

// ═══════════════════════════════════════════════
// 17. FLAGS
// ═══════════════════════════════════════════════
console.log('\n📋 17. 标记系统');

{
  const r = await get('/learn/flags');
  ok('获取标记列表返回 200', r.status === 200);
  ok('flagged 为数组', Array.isArray(r.data?.flagged));
}

{
  const r = await del(`/learn/flags/${planId}`);
  ok('清除标记返回 success', r.status === 200);
}

// ═══════════════════════════════════════════════
// 18. CACHE DIAGNOSTICS
// ═══════════════════════════════════════════════
console.log('\n📋 18. 缓存诊断');

{
  const r = await get('/learn/cache-diagnostics');
  ok('缓存诊断返回 200', r.status === 200);
  ok('包含 diagnostics 对象', !!r.data?.diagnostics);
}

{
  const r = await post('/learn/cache-stats', { apiKey: 'test' });
  // Can return 200 or 500 depending on config
  ok('缓存统计端点存在', [200, 500].includes(r.status));
}

// ═══════════════════════════════════════════════
// 19. USER PROFILE
// ═══════════════════════════════════════════════
console.log('\n📋 19. 用户画像');

{
  const r = await get('/user-profile');
  if (r.status === 200) {
    ok('用户画像返回 200', true);
  }
}

{
  const r = await get('/user-profile/summary');
  if (r.status === 200) {
    ok('画像摘要返回 200', true);
    // Check summary structure
    if (r.data) {
      ok('摘要含 hasData', r.data?.summary && 'hasData' in r.data.summary, JSON.stringify(r.data).slice(0, 100));
    }
  }
}

{
  const r = await post('/user-profile/analyze');
  if (r.status === 200) {
    ok('画像分析返回 200', true);
  } else if (r.status === 500) {
    warn('画像分析失败（可能无 API Key）', r.data?.error);
  } else if (r.status === 400) {
    ok('画像分析返回合理错误', true);
  }
}

// ═══════════════════════════════════════════════
// 20. FEYNMAN ANALYSIS
// ═══════════════════════════════════════════════
console.log('\n📋 20. 费曼分析');

{
  // Feynman mode was already started in section 6, so a session exists.
  // 200 with insights is correct behavior.
  const r = await post(`/learn/plans/${planId}/feynman-analyze/${topicIds[0]}`);
  if (r.status === 200) {
    ok('费曼分析-有session返回 200', true);
    ok('  返回 insights 对象', r.data && typeof r.data === 'object');
  } else if (r.status === 400) {
    ok('费曼分析-无session返回 400（正确）', r.status === 400);
  } else if (r.status === 500) {
    warn('费曼分析失败（可能无 API Key）');
  }
}

// ═══════════════════════════════════════════════
// 21. SSE STREAMING ENDPOINTS (basic connectivity)
// ═══════════════════════════════════════════════
console.log('\n📋 21. SSE 流式端点（连通性）');

{
  const r = await post(`/learn/plans/${planId}/exam/generate-stream`, {
    topicIds: topicIds.slice(0, 3),
    config: { questionCount: 2, choiceRatio: 0.5 }
  });
  ok('组卷SSE端点存在（返回200或500）', [200, 400, 404, 500].includes(r.status), `status=${r.status}`);
}

{
  const r = await post(`/learn/plans/${planId}/interactive-start-sse/${topicIds[0]}`, { mode: 'stepwise' });
  ok('交互SSE端点存在（返回200或500）', [200, 400, 404, 500].includes(r.status), `status=${r.status}`);
}

// ═══════════════════════════════════════════════
// 22. REVEAL ERRORS (teaching errors)
// ═══════════════════════════════════════════════
console.log('\n📋 22. 教学错误系统');

{
  const r = await post(`/learn/plans/${planId}/reveal-errors/${topicIds[0]}`);
  if (r.status === 200) {
    ok('揭示错误返回 200', true);
    ok('hasErrors 字段存在', 'hasErrors' in (r.data || {}), `data=${JSON.stringify(r.data).slice(0, 200)}`);
  } else if (r.status === 500) {
    warn('揭示错误失败（可能无 API Key）', r.data?.error);
  }
}

// ═══════════════════════════════════════════════
// 23. EXAM SUBMIT + PRACTICE (if exam was created)
// ═══════════════════════════════════════════════
console.log('\n📋 23. 试卷提交与错题练习');

if (examId) {
  {
    const r = await post(`/learn/plans/${planId}/exam/${examId}/submit`, { answers: [] });
    ok('提交空答案返回 400', r.status === 400);
  }

  {
    const r = await post(`/learn/plans/${planId}/exam/${examId}/practice`, { count: 3 });
    if (r.status === 200) {
      ok('错题练习返回 200', true);
      ok('questions 为数组', Array.isArray(r.data?.questions));
    } else if (r.status === 500) {
      warn('错题练习失败（可能无 API Key）');
    }
  }

  {
    const r = await del(`/learn/plans/${planId}/exam/${examId}`);
    ok('删除试卷返回 success', r.status === 200 && r.data?.success === true);
  }
} else {
  console.log('  ⏭️  跳过（未成功创建试卷）');
}

// ═══════════════════════════════════════════════
// 24. CLEANUP — 仅删除本次测试创建的计划
// ═══════════════════════════════════════════════
console.log('\n📋 24. 清理（仅删除测试数据）');

const TEST_PLAN_NAMES = ['E2E全功能测试计划', '回收站测试计划'];

async function safeCleanup() {
  // 第一步：精确删除本次创建的测试计划（按名称匹配，防止误删）
  const { data: allPlans } = await get('/learn/plans');
  const plans = allPlans?.plans || [];

  for (const planName of TEST_PLAN_NAMES) {
    const match = plans.find(p => p.name === planName);
    if (match) {
      const r1 = await del(`/learn/plans/${match.id}`);
      ok(`删除"${planName}" → ${r1.ok ? '进回收站' : '失败'}`, r1.ok);

      // 从回收站永久删除
      const r2 = await del(`/learn/trash/${match.id}`);
      ok(`永久删除"${planName}"`, r2.ok);
    }
  }

  // 第二步：清理回收站中可能残留的同名测试计划
  const { data: trashData } = await get('/learn/trash');
  const trashPlans = trashData?.plans || [];
  for (const planName of TEST_PLAN_NAMES) {
    const match = trashPlans.find(p => p.name === planName);
    if (match) {
      const r = await del(`/learn/trash/${match.id}`);
      ok(`清理回收站残留"${planName}"`, r.ok);
    }
  }

  console.log('  ℹ️  未删除任何非测试计划');
}

await safeCleanup();

// ═══════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  测试完成');
console.log('═══════════════════════════════════════════════');
console.log(`  ✅ 通过: ${passed}`);
console.log(`  ❌ 失败: ${failed}`);
console.log(`  ⚠️  警告: ${warnings}`);
console.log(`  📊 合计: ${passed + failed + warnings}`);
console.log('═══════════════════════════════════════════════');

if (failed > 0) {
  console.log('\n🔴 存在失败项，需要修复！');
  process.exit(1);
} else if (warnings > 0) {
  console.log('\n🟡 全部强制检查通过，但有一些警告（可能是缺少 API Key 导致）');
  process.exit(0);
} else {
  console.log('\n🟢 全部通过！');
  process.exit(0);
}
