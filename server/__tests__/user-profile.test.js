/**
 * Tests for server/engine/user-profile.js — user profile logic.
 *
 * Tests cover:
 * - aggregateAllPlans: cross-plan data aggregation (0, 1, multiple plans)
 * - getUserProfile: reading stored profile
 * - getProfileSummary: lightweight stats
 * - generateUserProfile: AI-powered generation with mock provider
 *
 * Follows the same patterns as learn-store.test.js (uses store API for setup,
 * cleanup in after hooks).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from '../engine/learn-store.js';
import {
  aggregateAllPlans,
  getUserProfile,
  getProfileSummary,
  generateUserProfile,
} from '../engine/user-profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_FILE = path.join(__dirname, '..', 'engine', '..', 'data', 'learn', 'user-profile.json');

// Track test plan IDs for cleanup
const testPlanIds = [];

function makeMockProvider(returnContent) {
  return {
    complete: async (messages, opts) => ({
      content: returnContent,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  };
}

/**
 * deletePlan is async (enqueueWrite). Wrap in helper with await.
 */
async function deletePlanSafe(id) {
  try { await store.deletePlan(id); } catch {}
}

async function cleanupTestPlans() {
  for (const id of testPlanIds) {
    await deletePlanSafe(id);
  }
  testPlanIds.length = 0;
  // Clean trash
  for (const tp of store.listTrash()) {
    try { await store.permanentlyDeleteTrash(tp.id); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
// aggregateAllPlans
// ═══════════════════════════════════════════════════════════

describe('aggregateAllPlans', () => {
  after(async () => {
    await cleanupTestPlans();
  });

  it('should return null or valid object when there are no plans', () => {
    const result = aggregateAllPlans();
    if (result === null) {
      assert.strictEqual(result, null);
    } else {
      assert.ok(result.stats);
      assert.ok(Array.isArray(result.planSummaries));
    }
  });

  it('should aggregate a single plan correctly', async () => {
    const p = store.createPlan('画像测试单计划');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['知识点A', '知识点B']);
    // Mark one as done
    const plan = store.getPlan(p.id);
    assert.ok(plan.topics.length > 0, '计划应有知识点');
    const t = plan.topics[0];
    await store.updateTopic(p.id, t.id, { done: true });

    const result = aggregateAllPlans();
    assert.ok(result !== null);
    assert.strictEqual(result.stats.totalPlans >= 1, true);
    // Find our test plan
    const ourPlan = result.planSummaries.find(ps => ps.id === p.id);
    assert.ok(ourPlan, '测试计划应在聚合结果中');
    assert.strictEqual(ourPlan.topicCount, 2);
    assert.strictEqual(ourPlan.doneCount, 1);
    assert.strictEqual(ourPlan.completionRate, 50);
  });

  it('should aggregate multiple plans', async () => {
    const p1 = store.createPlan('画像测试多计划1');
    testPlanIds.push(p1.id);
    await store.addTopics(p1.id, ['T1', 'T2']);

    const p2 = store.createPlan('画像测试多计划2');
    testPlanIds.push(p2.id);
    await store.addTopics(p2.id, ['U1', 'U2', 'U3']);
    const plan2 = store.getPlan(p2.id);
    assert.ok(plan2.topics.length >= 2, '计划2 应有至少 2 个知识点');
    await store.updateTopic(p2.id, plan2.topics[0].id, { done: true });
    await store.updateTopic(p2.id, plan2.topics[1].id, { done: true });

    const result = aggregateAllPlans();
    assert.ok(result !== null);
    assert.ok(result.stats.totalTopics >= 5);
    assert.ok(result.stats.totalPlans >= 2);
  });

  it('should collect weak points across plans', async () => {
    const p = store.createPlan('画像测试薄弱点');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['薄弱点测试主题']);
    const plan = store.getPlan(p.id);
    assert.ok(plan.topics.length > 0);
    const t = plan.topics[0];
    await store.updateTopic(p.id, t.id, {
      done: true,
      weakPoints: ['概念混淆', '公式记错'],
    });

    const result = aggregateAllPlans();
    assert.ok(result !== null);
    const weakEntry = result.weakPoints.find(w => w.topic === '薄弱点测试主题');
    assert.ok(weakEntry, 'weakPoints 应包含该主题');
    assert.deepStrictEqual(weakEntry.weakPoints, ['概念混淆', '公式记错']);
    // Cross-plan summary
    const wpSummary = result.weakPointsSummary.find(w => w.name === '概念混淆');
    assert.ok(wpSummary);
    assert.ok(wpSummary.count >= 1);
  });

  it('should aggregate exercise stats', async () => {
    const p = store.createPlan('画像测试练习');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['练习统计主题']);
    const plan = store.getPlan(p.id);
    assert.ok(plan.topics.length > 0);
    const t = plan.topics[0];
    await store.updateTopic(p.id, t.id, {
      done: true,
      exercises: [
        { question: 'Q1', correct: true },
        { question: 'Q2', correct: false },
        { question: 'Q3', correct: true },
      ],
    });

    const result = aggregateAllPlans();
    assert.ok(result !== null);
    assert.ok(result.exerciseStats.total >= 3);
    assert.ok(result.exerciseStats.correct >= 2);
  });

  it('should aggregate time spent', async () => {
    const p = store.createPlan('画像测试时间');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['时间统计主题']);
    const plan = store.getPlan(p.id);
    assert.ok(plan.topics.length > 0);
    const t = plan.topics[0];
    await store.updateTopic(p.id, t.id, { timeSpent: 3600 }); // 1 hour

    const result = aggregateAllPlans();
    assert.ok(result !== null);
    assert.ok(result.stats.totalTimeSeconds >= 3600);
    assert.ok(result.stats.totalTimeHours >= 1);
  });

  it('should handle plans with exam results', async () => {
    const p = store.createPlan('画像测试考试');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['考试主题']);
    const plan = store.getPlan(p.id);

    // Manually add exam papers by writing the array
    plan.examPapers = [{
      id: 'exam-test-1',
      title: '测试试卷',
      results: [
        { question: 'Q1', correct: true, topicId: plan.topics[0].id },
        { question: 'Q2', correct: false, topicId: plan.topics[0].id },
      ],
    }];
    // Persist by writing directly to the plan file
    const planFilePath = path.join(__dirname, '..', 'data', 'learn', 'plans', p.id + '.json');
    fs.writeFileSync(planFilePath, JSON.stringify(plan, null, 2), 'utf-8');

    const result = aggregateAllPlans();
    assert.ok(result !== null);
    assert.ok(typeof result.examStats.total === 'number');
  });
});

// ═══════════════════════════════════════════════════════════
// getUserProfile
// ═══════════════════════════════════════════════════════════

describe('getUserProfile', () => {
  const PROFILE_BACKUP = PROFILE_FILE + '.test-bak';

  before(() => {
    // Backup existing profile if any
    if (fs.existsSync(PROFILE_FILE)) {
      fs.copyFileSync(PROFILE_FILE, PROFILE_BACKUP);
    }
  });

  after(() => {
    // Restore original profile
    if (fs.existsSync(PROFILE_BACKUP)) {
      fs.copyFileSync(PROFILE_BACKUP, PROFILE_FILE);
      try { fs.unlinkSync(PROFILE_BACKUP); } catch {}
    }
  });

  it('should return null when no profile file exists', () => {
    // Remove profile file temporarily
    if (fs.existsSync(PROFILE_FILE)) {
      fs.renameSync(PROFILE_FILE, PROFILE_FILE + '.tmp');
    }
    try {
      const result = getUserProfile();
      assert.strictEqual(result, null);
    } finally {
      if (fs.existsSync(PROFILE_FILE + '.tmp')) {
        fs.renameSync(PROFILE_FILE + '.tmp', PROFILE_FILE);
      }
    }
  });

  it('should return parsed profile when file exists', () => {
    const testProfile = {
      updatedAt: 123456789,
      lastAnalyzedAt: 123456789,
      learnerPersona: { type: ['测试型'], summary: '测试', confidence: 0.5 },
      strengths: [],
      weaknesses: [],
      recommendations: ['测试建议'],
    };
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(testProfile), 'utf-8');

    const result = getUserProfile();
    assert.ok(result !== null);
    assert.strictEqual(result.learnerPersona.type[0], '测试型');
    assert.strictEqual(result.recommendations[0], '测试建议');
  });

  it('should return null for corrupt profile file', () => {
    fs.writeFileSync(PROFILE_FILE, 'this is not json', 'utf-8');
    const result = getUserProfile();
    assert.strictEqual(result, null);
  });
});

// ═══════════════════════════════════════════════════════════
// getProfileSummary
// ═══════════════════════════════════════════════════════════

describe('getProfileSummary', () => {
  after(async () => {
    await cleanupTestPlans();
  });

  it('should return valid shape when no plans exist or plans exist', () => {
    const result = getProfileSummary();
    assert.ok(typeof result.hasData === 'boolean');
    assert.ok(result.hasAIAnalysis === undefined || typeof result.hasAIAnalysis === 'boolean');
  });

  it('should return hasData=true when plans exist', async () => {
    const p = store.createPlan('画像摘要测试');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['摘要主题']);
    const plan = store.getPlan(p.id);
    assert.ok(plan.topics.length > 0);
    await store.updateTopic(p.id, plan.topics[0].id, { done: true });

    const result = getProfileSummary();
    assert.strictEqual(result.hasData, true);
    assert.ok(result.stats);
    assert.ok(result.stats.totalTopics >= 1);
    assert.ok(result.stats.totalPlans >= 1);
    assert.ok(Array.isArray(result.planSummaries));
  });

  it('should include stats in the summary', () => {
    const result = getProfileSummary();
    if (result.hasData) {
      assert.ok(typeof result.stats.totalPlans === 'number');
      assert.ok(typeof result.stats.totalTopics === 'number');
      assert.ok(typeof result.stats.totalDone === 'number');
      assert.ok(typeof result.stats.overallCompletionRate === 'number');
      assert.ok(typeof result.stats.totalQuestions === 'number');
      assert.ok(typeof result.stats.totalTimeSeconds === 'number');
      assert.ok(typeof result.exerciseStats.total === 'number');
      assert.ok(typeof result.exerciseStats.correct === 'number');
      assert.ok(typeof result.exerciseStats.rate === 'number');
      assert.ok(Array.isArray(result.planSummaries));
    }
  });

  it('should include AI analysis fields when profile exists', () => {
    const testProfile = {
      lastAnalyzedAt: Date.now(),
      learnerPersona: { type: ['测试型'], summary: '测试画像', confidence: 0.5 },
      strengths: [{ domain: '测试', topics: ['T'], masteryLevel: 0.8, evidence: 'OK' }],
      weaknesses: [],
      recommendations: ['建议1'],
    };
    const PROFILE_BACKUP = PROFILE_FILE + '.bak2';
    if (fs.existsSync(PROFILE_FILE)) {
      fs.copyFileSync(PROFILE_FILE, PROFILE_BACKUP);
    }
    try {
      fs.writeFileSync(PROFILE_FILE, JSON.stringify(testProfile), 'utf-8');

      const result = getProfileSummary();
      assert.strictEqual(result.hasAIAnalysis, true);
      assert.ok(result.learnerPersona);
      assert.strictEqual(result.learnerPersona.type[0], '测试型');
      assert.ok(result.strengths);
      assert.strictEqual(result.strengths.length, 1);
      assert.ok(Array.isArray(result.recommendations));
    } finally {
      if (fs.existsSync(PROFILE_BACKUP)) {
        fs.copyFileSync(PROFILE_BACKUP, PROFILE_FILE);
        try { fs.unlinkSync(PROFILE_BACKUP); } catch {}
      } else if (fs.existsSync(PROFILE_FILE)) {
        try { fs.unlinkSync(PROFILE_FILE); } catch {}
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// generateUserProfile
// ═══════════════════════════════════════════════════════════

describe('generateUserProfile', () => {
  const PROFILE_BACKUP = PROFILE_FILE + '.gen-bak';

  before(() => {
    if (fs.existsSync(PROFILE_FILE)) {
      fs.copyFileSync(PROFILE_FILE, PROFILE_BACKUP);
    }
  });

  after(async () => {
    // Restore original profile
    if (fs.existsSync(PROFILE_BACKUP)) {
      fs.copyFileSync(PROFILE_BACKUP, PROFILE_FILE);
      try { fs.unlinkSync(PROFILE_BACKUP); } catch {}
    }
    await cleanupTestPlans();
  });

  it('should throw when no plans exist', async () => {
    const mockProvider = makeMockProvider('{}');
    const aggregated = aggregateAllPlans();
    if (aggregated === null) {
      await assert.rejects(
        () => generateUserProfile(mockProvider, 'gpt-4o-mini'),
        { message: /没有学习计划数据/ }
      );
    }
    // If there ARE plans in the env, skip this assertion
  });

  it('should generate a profile with valid AI response', async () => {
    // Ensure there's at least one plan
    const p = store.createPlan('画像生成测试');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['生成主题']);

    const validJSON = JSON.stringify({
      learnerPersona: {
        type: ['深度思考型'],
        summary: '用户喜欢深入思考，喜欢追根溯源',
        confidence: 0.85,
      },
      strengths: [
        { domain: '测试领域', topics: ['生成主题'], evidence: '已完成', masteryLevel: 0.8 },
      ],
      weaknesses: [],
      crossPlanWeakPoints: [],
      learningPatterns: {
        questionStyle: '喜欢问为什么',
        avgQuestionsPerTopic: 1.5,
        timeDistribution: '分散学习',
        completionTrend: '稳定上升',
      },
      recommendations: ['继续保持'],
      aiAnalysis: '## 测试分析报告\n\n整体情况良好。',
    });

    const mockProvider = makeMockProvider(validJSON);
    const profile = await generateUserProfile(mockProvider, 'gpt-4o-mini');

    assert.ok(profile);
    assert.ok(profile.updatedAt);
    assert.ok(profile.lastAnalyzedAt);
    assert.ok(profile.planSummary);
    assert.strictEqual(profile.learnerPersona.type[0], '深度思考型');
    assert.strictEqual(profile.learnerPersona.summary, '用户喜欢深入思考，喜欢追根溯源');
    assert.strictEqual(profile.learnerPersona.confidence, 0.85);
    assert.ok(profile.strengths);
    assert.strictEqual(profile.strengths[0].domain, '测试领域');
    assert.strictEqual(profile.recommendations[0], '继续保持');
    assert.ok(profile.aiAnalysis);
    assert.ok(typeof profile.exerciseRate === 'number');
    assert.ok(typeof profile.examRate === 'number');

    // Should have been persisted
    const saved = getUserProfile();
    assert.ok(saved !== null);
    assert.strictEqual(saved.learnerPersona.type[0], '深度思考型');
  });

  it('should throw when AI response is not valid JSON', async () => {
    const mockProvider = makeMockProvider('这不是有效的 JSON');
    await assert.rejects(
      () => generateUserProfile(mockProvider, 'gpt-4o-mini'),
      { message: /AI 返回 JSON 解析失败/ }
    );
  });

  it('should handle markdown-wrapped JSON response', async () => {
    const validJSON = '```json\n{\n  "learnerPersona": {\n    "type": ["测试型"],\n    "summary": "测试",\n    "confidence": 0.5\n  },\n  "strengths": [],\n  "weaknesses": [],\n  "crossPlanWeakPoints": [],\n  "learningPatterns": {\n    "questionStyle": "测试",\n    "avgQuestionsPerTopic": 0,\n    "timeDistribution": "测试",\n    "completionTrend": "测试"\n  },\n  "recommendations": ["测试"],\n  "aiAnalysis": "测试"\n}\n```';
    const mockProvider = makeMockProvider(validJSON);
    const profile = await generateUserProfile(mockProvider, 'gpt-4o-mini');
    assert.ok(profile);
    assert.strictEqual(profile.learnerPersona.type[0], '测试型');
  });

  it('should merge computed stats into profile', async () => {
    const p = store.createPlan('画像合并测试');
    testPlanIds.push(p.id);
    await store.addTopics(p.id, ['合并主题A', '合并主题B']);
    const plan = store.getPlan(p.id);
    assert.ok(plan.topics.length > 0);
    await store.updateTopic(p.id, plan.topics[0].id, { done: true, timeSpent: 1800 });

    const simpleJSON = JSON.stringify({
      learnerPersona: { type: ['测试型'], summary: '测试', confidence: 0.5 },
      strengths: [],
      weaknesses: [],
      crossPlanWeakPoints: [],
      learningPatterns: { questionStyle: '测试', avgQuestionsPerTopic: 0, timeDistribution: '测试', completionTrend: '测试' },
      recommendations: ['测试'],
      aiAnalysis: '测试',
    });

    const mockProvider = makeMockProvider(simpleJSON);
    const profile = await generateUserProfile(mockProvider, 'gpt-4o-mini');

    // Should have learningPatterns.preferredModes from computed data
    assert.ok(profile.learningPatterns.preferredModes);
    assert.ok(typeof profile.learningPatterns.preferredModes.stepwise === 'number');
    // Should have _rawWeakPoints
    assert.ok(Array.isArray(profile._rawWeakPoints));
    // Should have planSummary
    assert.ok(profile.planSummary.plans.length > 0);
  });
});
