import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Provider } from '../engine/provider.js';
import { generateReview, gradeExercises, analyzeWeakPoints } from '../engine/learn-engine.js';
import * as store from '../engine/learn-store.js';

// ─── Helpers ───

function createMockProvider(resultContent) {
  const mockClient = {
    chat: {
      completions: {
        async create(opts) {
          return {
            choices: [{ message: { content: resultContent, role: 'assistant' } }],
            model: 'mock-model',
            usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
          };
        },
      },
    },
  };
  const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
  provider._client = mockClient;
  provider._autoWarm = false;
  return provider;
}

// Track created plans for cleanup
let testPlanId = null;

async function createFullPlan() {
  const plan = store.createPlan('engine-test-plan');
  testPlanId = plan.id;
  await store.addTopics(plan.id, ['知识点A', '知识点B']);
  const p = store.getPlan(plan.id);
  const t1 = p.topics[0];
  await store.updateTopic(plan.id, t1.id, {
    detail: '这是知识点A的详细讲解内容，包括基本概念和使用方法。\n\n核心要点：\n1. 概念定义\n2. 使用场景\n3. 注意事项',
    done: true,
    weakPoints: ['概念理解不清晰', '应用场景混淆'],
    exercises: [
      { id: 'ex1', type: 'choice', question: '1+1=?', options: ['1', '2', '3'], answer: '2', userAnswer: '1', correct: false, conceptTag: '基础运算' },
      { id: 'ex2', type: 'choice', question: '2+2=?', options: ['3', '4', '5'], answer: '4', userAnswer: '4', correct: true, conceptTag: '基础运算' },
    ],
    reviewGenerated: null,
    reviewUpdatedAt: null,
  });
  await store.addHistory(plan.id, t1.id, 'user', '什么是A？');
  await store.addHistory(plan.id, t1.id, 'ai', 'A是...');
  await store.addHistory(plan.id, t1.id, 'user', '能举个例子吗？');
  await store.addHistory(plan.id, t1.id, 'ai', '例如...');
  return store.getPlan(plan.id);
}

describe('learn-engine', () => {
  after(() => {
    if (testPlanId) {
      try { store.deletePlan(testPlanId); } catch {}
    }
  });

  // ─── generateReview ───

  describe('generateReview', () => {
    it('should generate review content for a done topic', async () => {
      const provider = createMockProvider('## 复习总结\n\n### 重点回顾\n\n这是AI生成的复习内容。');
      const plan = await createFullPlan();

      const review = await generateReview(provider, plan, plan.topics[0].id, 'mock-model');
      assert.ok(typeof review === 'string');
      assert.ok(review.length > 0);
      assert.ok(review.includes('复习'));
    });

    it('should throw for non-existent topic', async () => {
      const provider = createMockProvider('复习内容');
      const plan = await createFullPlan();

      await assert.rejects(
        () => generateReview(provider, plan, 'non-existent', 'mock-model'),
        /not found/i
      );
    });

    it('should throw for topic without detail', async () => {
      const provider = createMockProvider('复习内容');
      const plan = await createFullPlan();

      await assert.rejects(
        () => generateReview(provider, plan, plan.topics[1].id, 'mock-model'),
        /没有讲解内容/
      );
    });
  });

  // ─── gradeExercises ───

  describe('gradeExercises', () => {
    it('should grade submitted exercises', async () => {
      const mockResults = {
        results: [
          { exerciseIndex: 0, correct: false, userAnswer: '1', correctAnswer: '2', explanation: '1+1=2' },
          { exerciseIndex: 1, correct: true, userAnswer: '4', correctAnswer: '4', explanation: '正确' },
        ],
      };
      const provider = createMockProvider(JSON.stringify(mockResults));
      const plan = await createFullPlan();

      const userAnswers = [
        { exerciseIndex: 0, userAnswer: '1' },
        { exerciseIndex: 1, userAnswer: '4' },
      ];
      const results = await gradeExercises(provider, plan, plan.topics[0].id, userAnswers);
      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].correct, false);
      assert.strictEqual(results[1].correct, true);
    });

    it('should throw for non-existent topic', async () => {
      const provider = createMockProvider('{}');
      const plan = await createFullPlan();

      await assert.rejects(
        () => gradeExercises(provider, plan, 'non-existent', []),
        /not found/i
      );
    });

    it('should throw for invalid grading response', async () => {
      const provider = createMockProvider('不是JSON');
      const plan = await createFullPlan();

      await assert.rejects(
        () => gradeExercises(provider, plan, plan.topics[0].id, [{ exerciseIndex: 0, userAnswer: '1' }]),
        /评分结果格式错误/
      );
    });
  });

  // ─── analyzeWeakPoints ───

  describe('analyzeWeakPoints', () => {
    it('should analyze weak points for done topics', async () => {
      const mockAnalysis = {
        weakPoints: [
          { concept: '基础运算', severity: 'high', suggestion: '多做练习' },
        ],
      };
      const provider = createMockProvider(JSON.stringify(mockAnalysis));
      const plan = await createFullPlan();

      const results = await analyzeWeakPoints(provider, plan, 'mock-model');
      assert.ok(Array.isArray(results));
      // t1 has exercise errors → should be analyzed
      assert.ok(results.length >= 1);
    });

    it('should skip topics without exercises and Q&A', async () => {
      const provider = createMockProvider(JSON.stringify({ weakPoints: [] }));
      // Create a plan with a done topic that has no exercises and no Q&A
      const plan = store.createPlan('empty-topic-plan');
      testPlanId = plan.id;
      await store.addTopics(plan.id, ['空知识点']);
      const p = store.getPlan(plan.id);
      await store.updateTopic(plan.id, p.topics[0].id, {
        detail: '一些内容',
        done: true,
        exercises: [],
      });

      const results = await analyzeWeakPoints(provider, p, 'mock-model');
      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 0);
    });
  });

  // ─── parseExercisesFromDetail ───

  describe('store.parseExercisesFromDetail', () => {
    it('should parse exercises from markdown detail', () => {
      const detail = `## 讲解内容

### 📝 练习题

> **练习题 1**（选择题） 1+1=?
> - A. 1
> - B. 2
> - C. 3
> > 正确答案：B
> > 解析：1+1=2

> **练习题 2**（简答题） 什么是变量?
> > 参考答案：变量是存储数据的容器
> > 解析：基本概念

### 总结`;
      const exercises = store.parseExercisesFromDetail(detail);
      assert.ok(Array.isArray(exercises));
      assert.strictEqual(exercises.length, 2);
      assert.strictEqual(exercises[0].type, 'choice');
      assert.strictEqual(exercises[1].type, 'open');
    });

    it('should return empty array for no exercises', () => {
      const result = store.parseExercisesFromDetail('## 纯讲解内容\n无练习题');
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });

    it('should return empty array for null/undefined input', () => {
      assert.deepStrictEqual(store.parseExercisesFromDetail(null), []);
      assert.deepStrictEqual(store.parseExercisesFromDetail(undefined), []);
    });
  });

  // ─── extractWeakPoints ───

  describe('store.extractWeakPoints', () => {
    it('should extract concept names from analysis JSON', () => {
      const json = JSON.stringify({
        weakPoints: [
          { concept: '数组', severity: 'high', suggestion: '复习数组操作' },
          { concept: '指针', severity: 'medium', suggestion: '多写代码' },
        ],
      });
      const result = store.extractWeakPoints(json);
      assert.deepStrictEqual(result, ['数组', '指针']);
    });

    it('should return empty array for empty weak points', () => {
      const json = JSON.stringify({ weakPoints: [] });
      assert.deepStrictEqual(store.extractWeakPoints(json), []);
    });

    it('should return empty array for invalid JSON', () => {
      assert.deepStrictEqual(store.extractWeakPoints('invalid json'), []);
    });

    it('should return empty array for missing weakPoints field', () => {
      const json = JSON.stringify({ otherField: 'value' });
      assert.deepStrictEqual(store.extractWeakPoints(json), []);
    });
  });

  // ─── getTopicsNeedingReview ───

  describe('store.getTopicsNeedingReview', () => {
    it('should return done topics with weak points or exercise errors', async () => {
      const plan = await createFullPlan();
      const needs = store.getTopicsNeedingReview(plan);
      assert.ok(Array.isArray(needs));
      // t1 has weak points + exercise errors
      const t1 = needs.find(n => n.id === plan.topics[0].id);
      assert.ok(t1);
      assert.ok(t1.weakPoints.length > 0);
      assert.strictEqual(t1.hasExerciseErrors, true);
    });

    it('should not include topics without weak points and correct exercises', async () => {
      const plan = store.createPlan('clean-plan');
      store.updateTopic(plan.id, store.getPlan(plan.id).topics[0]?.id || 'x', {}); // no-op
      await store.addTopics(plan.id, ['干净知识点']);
      const p = store.getPlan(plan.id);
      store.updateTopic(plan.id, p.topics[0].id, {
        detail: '内容',
        done: true,
        weakPoints: [],
        exercises: [
          { id: 'ex1', correct: true },
        ],
      });
      const needs = store.getTopicsNeedingReview(p);
      const found = needs.find(n => n.id === p.topics[0].id);
      assert.ok(!found, 'should not include topic without issues');
      // Cleanup
      store.deletePlan(plan.id);
    });
  });
});
