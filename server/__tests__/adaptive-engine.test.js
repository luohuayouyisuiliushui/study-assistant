/**
 * Unit tests for the adaptive learning engine.
 *
 * Tests cover:
 * 1. ErrorStateMachine — error counting, threshold detection, state transitions
 * 2. AdaptivePromptInjector — profile-based context generation
 * 3. InterventionRecommender — intervention recommendations
 * 4. analyzePlanAdaptive — full pipeline
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as store from '../engine/learn-store.js';
import {
  ErrorStateMachine,
  AdaptivePromptInjector,
  InterventionRecommender,
  analyzePlanAdaptive,
} from '../engine/adaptive-engine.js';

// Replicate locally for test assertions
const ERROR_SOURCES = {
  EXERCISE: 'exercise',
  EXAM: 'exam',
  WEAK_POINT: 'weakPoint',
  FEYNMAN_GAP: 'feynmanGap',
  TEACHING_ERROR_UNRECOGNIZED: 'teachingErrorUnrecognized',
};

let testPlanId = null;

async function createFullPlan() {
  const plan = store.createPlan('adaptive-test-plan');
  testPlanId = plan.id;
  await store.addTopics(plan.id, ['知识点A', '知识点B', '知识点C']);
  const p = store.getPlan(plan.id);
  const t1 = p.topics[0];
  const t2 = p.topics[1];

  // Topic A: has exercise errors and weak points
  await store.updateTopic(plan.id, t1.id, {
    detail: '知识点A的详细讲解内容。包含核心概念、使用场景和注意事项。',
    done: true,
    weakPoints: ['概念理解不清晰', '应用场景混淆'],
    exercises: [
      { id: 'ex1', type: 'choice', question: '1+1=?', options: ['1','2','3'], answer: '2', userAnswer: '1', correct: false, conceptTag: '基础运算' },
      { id: 'ex2', type: 'choice', question: '2+2=?', options: ['3','4','5'], answer: '4', userAnswer: '4', correct: true, conceptTag: '基础运算' },
      { id: 'ex3', type: 'open', question: '什么是A？', answer: '核心定义', userAnswer: '不对的答案', correct: false, conceptTag: '概念理解' },
    ],
    teachingErrors: [
      { description: '边界条件错误', misconception: '边界条件', recognized: false, errorType: 'boundary' },
    ],
  });

  // Topic B: all correct, no issues
  await store.updateTopic(plan.id, t2.id, {
    detail: '知识点B的详细讲解',
    done: true,
    exercises: [
      { id: 'ex4', type: 'choice', question: '3+3=?', options: ['5','6','7'], answer: '6', userAnswer: '6', correct: true, conceptTag: '基础运算' },
    ],
  });

  // Add an exam with errors
  store.addExamPaper(plan.id, {
    id: 'exam-test-1',
    title: '测试试卷',
    config: { topicIds: [t1.id, t2.id], questionCount: 2 },
    paper: '# 测试试卷\n\n...',
    questions: [
      { index: 0, type: 'choice', question: '1+1=?', options: ['1','2','3'], answer: '2', explanation: '', conceptTag: '基础运算', topicId: t1.id, difficulty: 'easy' },
      { index: 1, type: 'open', question: '什么是B？', answer: '核心定义', explanation: '', conceptTag: '概念理解', topicId: t2.id, difficulty: 'medium' },
    ],
  });
  store.updateExamResults(plan.id, 'exam-test-1', [
    { exerciseIndex: 0, correct: false, userAnswer: '1', correctAnswer: '2', explanation: '错' },
    { exerciseIndex: 1, correct: true, userAnswer: '核心定义', correctAnswer: '核心定义', explanation: '对' },
  ]);

  return store.getPlan(plan.id);
}

describe('adaptive-engine', () => {
  after(() => {
    if (testPlanId) {
      try { store.permanentlyDeletePlan(testPlanId); } catch {}
    }
  });

  describe('ErrorStateMachine', () => {
    it('should start with empty state', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      assert.strictEqual(sm.summary.totalConcepts, 0);
      assert.strictEqual(sm.summary.interventionNeeded, 0);
      assert.strictEqual(sm.interventionNeeded.length, 0);
    });

    it('should transition IDLE → WATCHING on first error', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      const result = sm.recordError('概念A', ERROR_SOURCES.EXERCISE, '错了');

      assert.strictEqual(result.state, 'WATCHING');
      assert.strictEqual(result.thresholdCrossed, false);
      assert.strictEqual(result.count, 1);
    });

    it('should stay WATCHING on second error', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      sm.recordError('概念A', ERROR_SOURCES.EXERCISE);
      const result = sm.recordError('概念A', ERROR_SOURCES.EXAM);

      assert.strictEqual(result.state, 'WATCHING');
      assert.strictEqual(result.count, 2);
      assert.strictEqual(result.thresholdCrossed, false);
    });

    it('should transition to INTERVENTION_NEEDED on third error', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      sm.recordError('概念A', ERROR_SOURCES.EXERCISE);
      sm.recordError('概念A', ERROR_SOURCES.EXAM);
      const result = sm.recordError('概念A', ERROR_SOURCES.WEAK_POINT);

      assert.strictEqual(result.state, 'INTERVENTION_NEEDED');
      assert.strictEqual(result.count, 3);
      assert.strictEqual(result.thresholdCrossed, true);
    });

    it('should only fire thresholdCrossed once', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      sm.recordError('概念A', ERROR_SOURCES.EXERCISE);
      sm.recordError('概念A', ERROR_SOURCES.EXAM);
      sm.recordError('概念A', ERROR_SOURCES.WEAK_POINT); // crosses threshold
      const result = sm.recordError('概念A', ERROR_SOURCES.EXERCISE); // already crossed

      assert.strictEqual(result.state, 'INTERVENTION_NEEDED');
      assert.strictEqual(result.thresholdCrossed, false); // already in intervention
      assert.strictEqual(result.count, 4);
    });

    it('should resolve a concept', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      sm.recordError('概念A', ERROR_SOURCES.EXERCISE);
      sm.resolveConcept('概念A');

      const entry = [...sm._conceptErrors.values()][0];
      assert.strictEqual(entry.state, 'RESOLVED');
    });

    it('should track multiple concepts independently', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      sm.recordError('概念A', ERROR_SOURCES.EXERCISE);
      sm.recordError('概念B', ERROR_SOURCES.EXAM);
      sm.recordError('概念B', ERROR_SOURCES.WEAK_POINT);

      assert.strictEqual(sm.watching.length, 2);
      assert.strictEqual(sm.interventionNeeded.length, 0); // B has 2 errors, still WATCHING
    });

    it('should build from a plan correctly', async () => {
      const plan = await createFullPlan();
      const sm = ErrorStateMachine.fromPlan(plan);

      // 基础运算: 1 exercise error + 1 exam error = 2 errors → WATCHING
      // 概念理解: 1 exercise error = 1 error → WATCHING
      // 概念理解不清晰: 1 weak point = 1 error → WATCHING
      // 应用场景混淆: 1 weak point = 1 error → WATCHING
      // 边界条件: 1 unrecognized teaching error = 1 error → WATCHING
      const summary = sm.summary;
      assert.ok(summary.totalConcepts >= 2);
      assert.ok(summary.watching >= 1);
    });

    it('should handle empty plan gracefully', () => {
      const sm = ErrorStateMachine.fromPlan(null);
      assert.strictEqual(sm.summary.totalConcepts, 0);
    });

    it('should handle unknown concept tags as separate entries', () => {
      const sm = new ErrorStateMachine({ id: 'test' });
      sm.recordError('', ERROR_SOURCES.EXERCISE);
      assert.strictEqual(sm.summary.totalConcepts, 0); // empty tag is skipped
    });
  });

  describe('AdaptivePromptInjector', () => {
    it('should return empty string when no profile', () => {
      const injector = new AdaptivePromptInjector(null);
      assert.strictEqual(injector.buildAdaptiveContext(), '');
      assert.strictEqual(injector.hasMeaningfulProfile, false);
    });

    it('should return empty string for profile without persona', () => {
      const injector = new AdaptivePromptInjector({ stats: { totalPlans: 1 } });
      assert.strictEqual(injector.buildAdaptiveContext(), '');
      assert.strictEqual(injector.hasMeaningfulProfile, false);
    });

    it('should generate adaptive context for full profile', () => {
      const profile = {
        learnerPersona: {
          type: ['深度思考型', '实践应用型'],
          summary: '该学习者喜欢深入理解原理，同时注重实际应用',
          confidence: 0.85,
        },
        strengths: [
          { domain: '基础概念', topics: ['变量', '数据类型'], masteryLevel: 0.9 },
        ],
        weaknesses: [
          { domain: '并发编程', topics: ['线程', '锁'], masteryLevel: 0.3, suggestedAction: '从简单的同步例子开始练习' },
        ],
        crossPlanWeakPoints: ['异步编程', '错误处理'],
        learningPatterns: {
          questionStyle: '喜欢追根溯源',
          avgQuestionsPerTopic: 4.5,
        },
        recommendations: ['建议多做实战项目', '尝试费曼学习法巩固理解'],
      };

      const injector = new AdaptivePromptInjector(profile);
      assert.strictEqual(injector.hasMeaningfulProfile, true);

      const context = injector.buildAdaptiveContext();
      assert.ok(context.includes('深度思考型'));
      assert.ok(context.includes('实践应用型'));
      assert.ok(context.includes('基础概念'));
      assert.ok(context.includes('并发编程'));
      assert.ok(context.includes('异步编程'));
      assert.ok(context.includes('追根溯源'));
      assert.ok(context.includes('费曼学习法'));
    });

    it('should generate compact hint', () => {
      const profile = {
        learnerPersona: { type: ['目标驱动型'], summary: 'x', confidence: 0.5 },
      };
      const injector = new AdaptivePromptInjector(profile);
      assert.ok(injector.compactHint.includes('目标驱动型'));
    });

    it('should handle profile with partial data gracefully', () => {
      const profile = {
        learnerPersona: { type: ['视觉感知型'], summary: '', confidence: 0.3 },
      };
      const injector = new AdaptivePromptInjector(profile);
      const context = injector.buildAdaptiveContext();
      assert.ok(context.includes('视觉感知型'));
      assert.ok(context.includes('Mermaid')); // visual learner hint
    });
  });

  describe('InterventionRecommender', () => {
    it('should recommend review for topics with errors', async () => {
      const plan = await createFullPlan();
      const sm = ErrorStateMachine.fromPlan(plan);
      const recommender = new InterventionRecommender(plan, sm);

      const recs = recommender.recommend();
      assert.ok(recs.length > 0, 'Should have at least one recommendation');

      // Topic A has 3 exercise errors + 2 weak points + 1 teaching error = more issues
      const topicARec = recs.find(r => r.topicTitle === '知识点A');
      assert.ok(topicARec, '知识点A should have recommendations');
      assert.ok(topicARec.errorCount >= 3);
      assert.ok(topicARec.interventions.length > 0);

      // Topic A should have at least a review recommendation
      const interventionTypes = topicARec.interventions.map(i => i.type);
      assert.ok(interventionTypes.includes('review'), 'Should recommend review');
    });

    it('should not recommend for topics with no errors', async () => {
      const plan = await createFullPlan();
      const sm = ErrorStateMachine.fromPlan(plan);
      const recommender = new InterventionRecommender(plan, sm);

      const recs = recommender.recommend();
      // Topic C has no detail, no exercises, no errors → should not appear
      const topicCRec = recs.find(r => r.topicTitle === '知识点C');
      assert.strictEqual(topicCRec, undefined, 'Topic C should have no recommendations');
    });

    it('should sort recommendations by urgency', async () => {
      const plan = await createFullPlan();
      const sm = ErrorStateMachine.fromPlan(plan);
      const recommender = new InterventionRecommender(plan, sm);

      const recs = recommender.recommend();
      for (let i = 1; i < recs.length; i++) {
        const prev = recs[i - 1];
        const curr = recs[i];
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        assert.ok(order[prev.urgency] <= order[curr.urgency],
          `Expected ${prev.urgency} <= ${curr.urgency} for ${prev.topicTitle} vs ${curr.topicTitle}`);
      }
    });

    it('should build summary text', async () => {
      const plan = await createFullPlan();
      const sm = ErrorStateMachine.fromPlan(plan);
      const recommender = new InterventionRecommender(plan, sm);
      const recs = recommender.recommend();

      const summary = recommender.buildSummary(recs);
      assert.ok(summary.length > 0);
      assert.ok(summary.includes('🟡') || summary.includes('✅'));
    });

    it('should handle empty plan', () => {
      const emptyPlan = { id: 'empty', name: '空计划', topics: [], history: [], phases: [] };
      const sm = ErrorStateMachine.fromPlan(emptyPlan);
      const recommender = new InterventionRecommender(emptyPlan, sm);
      const recs = recommender.recommend();
      assert.strictEqual(recs.length, 0);
    });
  });

  describe('analyzePlanAdaptive (full pipeline)', () => {
    it('should return complete adaptive analysis', async () => {
      const plan = await createFullPlan();
      const result = analyzePlanAdaptive(plan);

      assert.ok(result.stateMachine);
      assert.ok(result.injector);
      assert.ok(result.recommender);
      assert.ok(Array.isArray(result.recommendations));
      assert.ok(typeof result.adaptiveContext === 'string');
      assert.ok(result.summary);
      assert.ok(typeof result.summary.stateMachine.totalConcepts === 'number');
      assert.ok(Array.isArray(result.summary.topRecommendations));
    });
  });
});
