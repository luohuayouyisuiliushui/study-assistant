/**
 * Unit tests for the data-flywheel / profile-updater / STEP-1 closed loop.
 *
 * 覆盖：
 *   profileUpdater()
 *     √ 练习结果 → strength/weakness masteryLevel 更新
 *     √ 问答类型 → learnerPersona 类型推断
 *     √ 低正确率概念 → crossPlanWeakPoints 累积
 *     √ 空 profile → 骨架降级
 *     √ 多计划数据合并
 *
 *   dataFlywheelUpdate()（集成到 adaptive-engine）
 *     √ 返回 AdaptivePromptInjector
 *     √ 调用 profile → incrementally update → injector
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../engine/learn-store.js';
import { profileUpdater } from '../engine/user-profile.js';
import {
  AdaptivePromptInjector,
  dataFlywheelUpdate,
  getCurrentInjector,
} from '../engine/adaptive-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_FILE = path.join(__dirname, '..', 'engine', '..', 'data', 'learn', 'user-profile.json');

let testPlanIds = [];

async function makePlan(name, topicsData) {
  const plan = store.createPlan(name);
  testPlanIds.push(plan.id);
  const titles = topicsData.map(t => (typeof t === 'string' ? t : t.title));
  await store.addTopics(plan.id, titles);
  return store.getPlan(plan.id);
}

/** 为指定 topic 设置练习结果 */
async function setExercises(planId, topicTitle, exercises) {
  const p = store.getPlan(planId);
  const t = p.topics.find(t => t.title === topicTitle);
  if (!t) throw new Error('topic not found: ' + topicTitle);
  await store.updateTopic(planId, t.id, { exercises, done: true, detail: 'mock detail for ' + topicTitle });
}

/** 追加 Q&A 记录（addHistory 是异步的） */
async function addQA(planId, topicId, questions) {
  for (const q of questions) {
    await store.addHistory(planId, topicId, 'user', q);
    await store.addHistory(planId, topicId, 'ai', 'mock answer');
  }
}

// ─── Tests ───

describe('profileUpdater（数据飞轮—闭环核心）', () => {
  after(() => {
    for (const id of testPlanIds) {
      try { store.permanentlyDeletePlan(id); } catch {}
    }
  });

  it('空画像 + 无计划 → 返回骨架', () => {
    const result = profileUpdater(null, []);
    assert.ok(result, '应该返回画像');
    assert.ok(result.learnerPersona, '应该包含 learnerPersona');
    assert.strictEqual(result.learnerPersona.confidence, 0.5);
    assert.ok(Array.isArray(result.strengths));
    assert.ok(Array.isArray(result.weaknesses));
    assert.strictEqual(result._lastIncrementalUpdate > 0, true);
  });

  it('练习正确率高 → strength masteryLevel >= 0.7', async () => {
    const plan = await makePlan('flywheel-test-1', ['TCP协议', 'HTTP协议']);
    await setExercises(plan.id, 'TCP协议', [
      { id: 'e1', type: 'choice', question: 'q1?', answer: 'B', userAnswer: 'B', correct: true, conceptTag: 'TCP' },
      { id: 'e2', type: 'choice', question: 'q2?', answer: 'B', userAnswer: 'B', correct: true, conceptTag: 'TCP' },
      { id: 'e3', type: 'open',  question: 'q3?', answer: 'x',  userAnswer: 'x',  correct: true, conceptTag: 'TCP' },
    ]);

    const plans = [store.getPlan(plan.id)].filter(Boolean);
    const result = profileUpdater(null, plans);

    assert.ok(result.strengths.length > 0, '应该有 strength 条目');
    const tcpStrength = result.strengths.find(s => s.topics.includes('TCP协议'));
    assert.ok(tcpStrength, '应该找到 TCP 的 strength 记录');
    assert.strictEqual(tcpStrength.masteryLevel, 1);
  });

  it('练习正确率低 → weakness masteryLevel < 0.7 + 跨计划薄弱点', async () => {
    const plan = await makePlan('flywheel-test-2', ['UDP协议']);
    await setExercises(plan.id, 'UDP协议', [
      { id: 'e1', type: 'choice', question: 'q1?', answer: 'B', userAnswer: 'A', correct: false, conceptTag: 'UDP' },
      { id: 'e2', type: 'choice', question: 'q2?', answer: 'C', userAnswer: 'A', correct: false, conceptTag: 'UDP' },
      { id: 'e3', type: 'open',  question: 'q3?', answer: 'x',  userAnswer: 'y',  correct: false, conceptTag: 'UDP' },
      { id: 'e4', type: 'open',  question: 'q4?', answer: 'z',  userAnswer: 'z',  correct: true,  conceptTag: 'UDP' },
    ]);

    const plans = [store.getPlan(plan.id)].filter(Boolean);
    const result = profileUpdater(null, plans);

    assert.ok(result.weaknesses.length > 0, '应该有 weakness 条目');
    const udpWeak = result.weaknesses.find(w => w.topics.includes('UDP协议'));
    assert.ok(udpWeak, '应该找到 UDP 的 weakness 记录');
    assert.strictEqual(udpWeak.masteryLevel, 0.25);

    // accuracy < 0.5 → 推入 crossPlanWeakPoints
    assert.ok(result.crossPlanWeakPoints.includes('UDP协议'),
      'UDP协议 应被添加到跨计划薄弱点中');
  });

  it('提问类型推断 learnerPersona', async () => {
    const plan = await makePlan('flywheel-test-3', ['DNS协议']);
    await setExercises(plan.id, 'DNS协议', []);
    const p = store.getPlan(plan.id);
    const topicId = p.topics[0].id;

    // 模拟“深度思考型”用户——大量 why 提问
    await addQA(plan.id, topicId, [
      'DNS解析的原理是什么？',
      '为什么DNS要使用UDP而不是TCP？',
      'DNS缓存的原因是什么？',
      '底层是如何实现的？',
    ]);

    // With 4 why-type questions, learnerPersona should be inferred as 深度思考型
    const plans = [store.getPlan(plan.id)].filter(Boolean);
    const result = profileUpdater(null, plans);

    assert.ok(result.learnerPersona.type.length > 0, '应该推断出学习者类型，got: ' + JSON.stringify(result.learnerPersona.type));
    assert.ok(result.learnerPersona.type.includes('深度思考型'),
      `应该是深度思考型，实际: ${result.learnerPersona.type.join(',')}`);
    // Confidence should increase slightly due to sample size
    assert.ok(result.learnerPersona.confidence > 0.5,
      `置信度应 > 0.5, 实际: ${result.learnerPersona.confidence}`);
  });

  it('多次调用 → 增量更新计数递增', async () => {
    const plan = await makePlan('flywheel-test-4', ['IP协议']);
    await setExercises(plan.id, 'IP协议', [
      { id: 'e1', type: 'choice', question: 'q?', answer: 'A', userAnswer: 'A', correct: true, conceptTag: 'IP' },
    ]);
    const plans = [store.getPlan(plan.id)].filter(Boolean);

    const r1 = profileUpdater(null, plans);
    assert.strictEqual(r1._totalIncrementalUpdates, 1);

    const r2 = profileUpdater(r1, plans);
    assert.strictEqual(r2._totalIncrementalUpdates, 2);
  });

  it('多计划合并 → 跨计划薄弱点聚合', async () => {
    const p1 = await makePlan('flywheel-merge-1', ['TCP']);
    const p2 = await makePlan('flywheel-merge-2', ['HTTP']);
    await setExercises(p1.id, 'TCP', [
      { id: 'e1', correct: false, conceptTag: 'TCP', question: 'q', answer: 'A', userAnswer: 'B' },
    ]);
    await setExercises(p2.id, 'HTTP', [
      { id: 'e2', correct: false, conceptTag: 'HTTP', question: 'q', answer: 'A', userAnswer: 'B' },
    ]);

    const plans = [store.getPlan(p1.id), store.getPlan(p2.id)].filter(Boolean);
    const result = profileUpdater(null, plans);

    assert.ok(result.crossPlanWeakPoints.includes('TCP'),
      '跨计划薄弱点应包含 TCP');
    assert.ok(result.crossPlanWeakPoints.includes('HTTP'),
      '跨计划薄弱点应包含 HTTP');
  });
});

describe('dataFlywheelUpdate & getCurrentInjector（adaptive-engine 集成）', () => {
  // dataFlywheelUpdate now persists the profile to disk when one exists, so
  // back up the real user profile before these tests and restore after, to
  // avoid corrupting real user data (mirrors user-profile.test.js pattern).
  const PROFILE_BACKUP = PROFILE_FILE + '.flywheel-bak';
  let hadProfileBefore = false;

  before(() => {
    hadProfileBefore = fs.existsSync(PROFILE_FILE);
    if (hadProfileBefore) {
      fs.copyFileSync(PROFILE_FILE, PROFILE_BACKUP);
    }
  });

  after(() => {
    for (const id of testPlanIds) {
      try { store.permanentlyDeletePlan(id); } catch {}
    }
    if (hadProfileBefore) {
      try { fs.copyFileSync(PROFILE_BACKUP, PROFILE_FILE); } catch {}
      try { fs.unlinkSync(PROFILE_BACKUP); } catch {}
    } else if (fs.existsSync(PROFILE_FILE)) {
      // No profile existed before; remove whatever the test wrote.
      try { fs.unlinkSync(PROFILE_FILE); } catch {}
    }
  });

  it('dataFlywheelUpdate → 返回可以 buildAdaptiveContext 的 injector', async () => {
    const plan = await makePlan('flywheel-integ-1', ['TCP']);
    await setExercises(plan.id, 'TCP', [
      { id: 'e1', correct: true, conceptTag: 'TCP', question: 'q', answer: 'A', userAnswer: 'A' },
    ]);

    const plans = [store.getPlan(plan.id)].filter(Boolean);
    const injector = dataFlywheelUpdate(plans);

    assert.ok(injector instanceof AdaptivePromptInjector);
    // 首次 dataFlywheelUpdate 可能因练习正确率触发 strength 条目，
    // 但 hasMeaningfulProfile 需要 AI 生成的 learnerPersona 数据。
    // 当前只做规则推断，不一定有 type → 不做断言。
    // 只验证不崩溃即可。

    // 验证它可以 buildAdaptiveContext（即使没有AI分析也不会崩溃）
    const ctx = injector.buildAdaptiveContext();
    assert.strictEqual(typeof ctx, 'string');
  });

  it('getCurrentInjector → 即使无画像也不抛异常', async () => {
    const injector = getCurrentInjector();
    assert.ok(injector instanceof AdaptivePromptInjector);
    // 无用户画像 → 不出自适应上下文（或返回非空字符串表示已有数据在前面测试写入）
    const ctx = injector.buildAdaptiveContext();
    assert.strictEqual(typeof ctx, 'string');
  });
});
