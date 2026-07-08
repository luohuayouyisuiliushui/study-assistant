import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Provider } from '../engine/provider.js';
import { CacheMonitor } from '../engine/cache-diagnostics.js';
import { generateReview, gradeExercises, analyzeWeakPoints, generateQuickQuiz, startInteractiveDetail, continueInteractiveDetail, revealEmbeddedErrors, decomposeTopic, generateDetail, answerFollowUp, analyzeLearning, answerAnalysisFollowUp, getEngineCacheDiagnostics, createProviderFromConfig, generateTopicImage } from '../engine/learn-engine.js';
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

// ═══════════════════════════════════════════════════════
//  INTERACTIVE MODE TESTS
// ═══════════════════════════════════════════════════════

/**
 * Create a mock provider that supports streaming (async iterable).
 */
function createStreamMockProvider(content) {
  const mockClient = {
    chat: {
      completions: {
        async create(opts) {
          const chars = (content || '').split('');
          const chunks = chars.map((char) => ({
            choices: [{ delta: { content: char }, index: 0 }],
          }));
          // Send usage in a separate final chunk so provider doesn't skip the last content char
          chunks.push({ choices: [{ delta: { content: '' }, index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
          if (chunks.length <= 1) {
            chunks.push({ choices: [{ delta: { content: '' }, index: 0 }] });
          }
          return (async function* () {
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
        },
      },
    },
  };
  const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: 'mock-model' });
  provider._client = mockClient;
  provider._autoWarm = false;
  provider._lastPrefixHash = null;
  return provider;
}

/**
 * Create a mock Provider that returns content + tool_calls from complete().
 */
function createToolMockProvider(content, toolCalls = null) {
  const mockClient = {
    chat: {
      completions: {
        async create(opts) {
          const message = { content: content || '', role: 'assistant' };
          if (toolCalls) message.tool_calls = toolCalls;
          return {
            choices: [{ message, index: 0, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
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
  provider._lastPrefixHash = null;
  return provider;
}

describe('Interactive mode', () => {
  let testPlan = null;
  let testTopicId = null;

  before(async () => {
    const plan = store.createPlan('interactive-test-plan');
    await store.addTopics(plan.id, ['交互测试知识点']);
    const p = store.getPlan(plan.id);
    testPlan = p;
    testTopicId = p.topics[0].id;
  });

  after(() => {
    if (testPlan) {
      try { store.deletePlan(testPlan.id); } catch {}
    }
  });

  it('startInteractiveDetail should return content and session', async () => {
    const provider = createToolMockProvider('这是第一部分的讲解内容。你理解了吗？', [
      { id: 'call_start1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"讲解了核心概念"}' } }
    ]);
    const result = await startInteractiveDetail(provider, testPlan, testTopicId, 'stepwise');

    assert.ok(result.content, 'should return content');
    assert.ok(result.content.includes('第一部分'), 'should include expected text');
    assert.ok(result.session, 'should return session object');
    assert.strictEqual(result.session.mode, 'stepwise', 'session mode should be stepwise');
    assert.strictEqual(result.session.finished, false, 'should not be finished (tool_calls = waiting)');
    assert.strictEqual(result.session.status, 'waiting_user', 'session should be waiting for user');
    assert.strictEqual(result.session.transcript.length, 1, 'transcript should have one AI entry');
    // Dynamic state machine advances on tool call
    assert.ok(result.session.stateMachine, 'stepwise should have stateMachine');
    assert.strictEqual(result.session.stateMachine.completedSteps, 1, 'should have 1 completed step after tool call');
    assert.strictEqual(result.session.stateMachine.currentStep, 1, 'should be at step 1');
  });

  it('startInteractiveDetail should support all modes', async () => {
    for (const mode of ['stepwise', 'realtime', 'challenge', 'scaffold']) {
      const provider = mode === 'stepwise'
        ? createToolMockProvider('测试内容', [{ id: 'call_m1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{}' } }])
        : createStreamMockProvider('测试内容');
      const result = await startInteractiveDetail(provider, testPlan, testTopicId, mode);
      assert.strictEqual(result.session.mode, mode, `mode should be ${mode}`);
      if (mode === 'stepwise') {
        assert.ok(result.session.stateMachine, 'stepwise should have stateMachine');
        assert.ok(result.tool_calls, 'stepwise should return tool_calls');
      } else {
        assert.strictEqual(result.session.stateMachine, null, `non-stepwise (${mode}) should not have stateMachine`);
      }
      assert.ok(result.content, `${mode} should return content`);
    }
  });

  it('should throw for non-existent topic', async () => {
    const provider = createStreamMockProvider('');
    await assert.rejects(
      () => startInteractiveDetail(provider, testPlan, 'non-existent', 'stepwise'),
      { message: 'Topic not found' }
    );
  });

  it('should persist session on topic after start', async () => {
    const provider = createStreamMockProvider('第一部分内容');
    await startInteractiveDetail(provider, testPlan, testTopicId, 'stepwise');
    const p = store.getPlan(testPlan.id);
    const topic = p.topics.find(t => t.id === testTopicId);
    assert.ok(topic.interactiveSession, 'session should be persisted');
    assert.strictEqual(topic.interactiveSession.mode, 'stepwise');
  });

  // ═════════════════════════════════════════════════════════
  //  continueInteractiveDetail tests
  // ═════════════════════════════════════════════════════════

  // State machine tests removed — stepwise mode no longer uses a fixed 6-step plan

  // State machine retry test removed — no longer tracked on the backend

  it('continueInteractiveDetail should advance dynamic state machine on tool call', async () => {
    const sepPlan = store.createPlan('fc-step-test');
    await store.addTopics(sepPlan.id, ['工具调用推进测试']);
    const p = store.getPlan(sepPlan.id);

    const provider1 = createToolMockProvider('第一部分内容。', [
      { id: 'call_1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"第一部分"}' } }
    ]);
    await startInteractiveDetail(provider1, p, p.topics[0].id, 'stepwise');

    const provider2 = createToolMockProvider('第二部分内容。', [
      { id: 'call_2', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"第二部分"}' } }
    ]);
    const result = await continueInteractiveDetail(provider2, p, p.topics[0].id, 'stepwise', '继续');

    assert.strictEqual(result.session.stateMachine.completedSteps, 2, 'should have 2 completed steps');
    assert.strictEqual(result.session.stateMachine.currentStep, 2, 'should advance to step 2');
    assert.ok(result.tool_calls, 'should have tool_calls');
    store.deletePlan(sepPlan.id);
  });

  it('continueInteractiveDetail should not advance state machine without tool call', async () => {
    const sepPlan = store.createPlan('fc-no-tc');
    await store.addTopics(sepPlan.id, ['无工具调用']);
    const p = store.getPlan(sepPlan.id);

    const provider1 = createToolMockProvider('第一部分内容（没有工具调用）');
    await startInteractiveDetail(provider1, p, p.topics[0].id, 'stepwise');
    // No tool_calls → session.finished = true
    assert.ok(store.getPlan(sepPlan.id).topics[0].interactiveSession.finished, 'should be finished without tool call');
    store.deletePlan(sepPlan.id);
  });

  it('continueInteractiveDetail should take feedback and return next section', async () => {
    const provider1 = createToolMockProvider('第一部分：核心概念。', [
      { id: 'call_fb1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"核心概念"}' } }
    ]);
    await startInteractiveDetail(provider1, testPlan, testTopicId, 'stepwise');

    const provider2 = createToolMockProvider('第二部分：我们来深入讲讲细节。', [
      { id: 'call_fb2', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"深入细节"}' } }
    ]);
    const result = await continueInteractiveDetail(provider2, testPlan, testTopicId, 'stepwise', '继续');

    assert.ok(result.content, 'should return next section content');
    assert.ok(result.content.includes('第二部分'), 'should include expected next content');
    assert.ok(result.session, 'should return session');
    // transcript entries: [assistant1, tool1, assistant2]
    assert.strictEqual(result.session.transcript.length, 3, 'transcript should have 3 entries');
    assert.strictEqual(result.session.transcript[1].role, 'tool', 'second entry should be tool result');
  });

  it('continueInteractiveDetail should detect [SESSION_END] marker', async () => {
    // Use a separate plan to avoid cross-test interference
    const sepPlan = store.createPlan('session-end-test');
    await store.addTopics(sepPlan.id, ['测试结束检测']);
    const p = store.getPlan(sepPlan.id);
    const provider1 = createToolMockProvider('以上是全部内容。', [
      { id: 'call_se1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"全部内容"}' } }
    ]);
    await startInteractiveDetail(provider1, p, p.topics[0].id, 'stepwise');

    const provider2 = createToolMockProvider('以上是全部内容。[SESSION_END]', [
      { id: 'call_se2', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"结束"}' } }
    ]);
    const result = await continueInteractiveDetail(provider2, p, p.topics[0].id, 'stepwise', '继续');

    assert.ok(result.finished, 'session should be marked as finished');
    assert.strictEqual(result.session.finished, true, 'session.finished should be true');
    store.deletePlan(sepPlan.id);
  });

  it('continueInteractiveDetail should re-open finished session for further questions', async () => {
    // Use separate plan
    const reopenPlan = store.createPlan('reopen-test');
    await store.addTopics(reopenPlan.id, ['重开测试']);
    const p2 = store.getPlan(reopenPlan.id);

    // First mark session as finished — mock without tool_calls so session completes
    const finishProvider = createToolMockProvider('所有内容结束。[SESSION_END]');
    await startInteractiveDetail(finishProvider, p2, p2.topics[0].id, 'stepwise');
    // Since no tool_calls, session is finished already, no continue needed

    // Now ask a follow-up question — session should re-open
    const reopenProvider = createToolMockProvider('好问题！让我解释一下这个细节。', [
      { id: 'call_re1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{"summary":"回答了追问"}' } }
    ]);
    const result = await continueInteractiveDetail(reopenProvider, p2, p2.topics[0].id, 'stepwise', '我还有问题');

    assert.ok(result.content, 'should return answer for follow-up question');
    assert.strictEqual(result.session.finished, false, 'session should be re-opened (finished = false)');
    store.deletePlan(reopenPlan.id);
  });

  it('continueInteractiveDetail should throw when no session exists', async () => {
    const provider = createStreamMockProvider('');
    // Call continue without starting interactive session first
    const freshPlan = store.createPlan('no-session-test');
    await store.addTopics(freshPlan.id, ['无会话知识点']);
    const p = store.getPlan(freshPlan.id);

    await assert.rejects(
      () => continueInteractiveDetail(provider, p, p.topics[0].id, 'stepwise', '继续'),
      { message: /没有互动讲解会话/ }
    );

    store.deletePlan(freshPlan.id);
  });

  it('continueInteractiveDetail should support all modes with feedback', async () => {
    for (const mode of ['realtime', 'challenge', 'scaffold']) {
      const provider = createStreamMockProvider(`这是${mode}模式的回应。`);
      await startInteractiveDetail(provider, testPlan, testTopicId, mode);

      const result = await continueInteractiveDetail(provider, testPlan, testTopicId, mode, '好的继续');

      assert.ok(result.content, `${mode}: should return content`);
      assert.ok(result.content.includes(mode), `${mode}: should include mode-specific content`);
      assert.strictEqual(result.session.mode, mode, `${mode}: session mode should be preserved`);
    }
  });

  it('continueInteractiveDetail should accumulate transcript across multiple turns', async () => {
    const provider1 = createToolMockProvider('第一轮内容', [
      { id: 'call_tr1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{}' } }
    ]);
    await startInteractiveDetail(provider1, testPlan, testTopicId, 'stepwise');

    const provider2 = createToolMockProvider('第二轮内容', [
      { id: 'call_tr2', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{}' } }
    ]);
    await continueInteractiveDetail(provider2, testPlan, testTopicId, 'stepwise', '继续');

    const provider3 = createToolMockProvider('第三轮内容', [
      { id: 'call_tr3', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{}' } }
    ]);
    await continueInteractiveDetail(provider3, testPlan, testTopicId, 'stepwise', '再继续');

    // Re-read from store to verify persistence
    const p = store.getPlan(testPlan.id);
    const topic = p.topics.find(t => t.id === testTopicId);
    const transcript = topic.interactiveSession.transcript;

    // transcript: [assistant1, tool1, assistant2, tool2, assistant3]
    assert.strictEqual(transcript.length, 5, 'transcript should have 5 entries');
    assert.strictEqual(transcript[0].role, 'assistant', 'entry 0: assistant');
    assert.strictEqual(transcript[1].role, 'tool', 'entry 1: tool result');
    assert.strictEqual(transcript[2].role, 'assistant', 'entry 2: assistant');
    assert.strictEqual(transcript[3].role, 'tool', 'entry 3: tool result');
    assert.strictEqual(transcript[4].role, 'assistant', 'entry 4: assistant');
  });
});

// ═══════════════════════════════════════════════════════
//  generateDetail tests
// ═══════════════════════════════════════════════════════

describe('generateDetail', () => {
  it('should generate content and mark topic as done', async () => {
    const plan = store.createPlan('gendetail-test');
    await store.addTopics(plan.id, ['测试核心生成']);
    const p = store.getPlan(plan.id);
    const topicId = p.topics[0].id;

    const provider = createStreamMockProvider('这是讲解内容。包括核心概念和实际代码。');
    const result = await generateDetail(provider, p, topicId);

    assert.ok(result, 'should return content');
    assert.ok(result.includes('核心概念'), 'should include expected content');

    // Verify topic is marked as done
    const p2 = store.getPlan(plan.id);
    const topic = p2.topics[0];
    assert.strictEqual(topic.done, true, 'topic should be marked done');
    assert.ok(topic.detail, 'topic should have detail');

    store.deletePlan(plan.id);
  });

  it('should throw for non-existent topic', async () => {
    const plan = store.createPlan('gendetail-err');
    const provider = createStreamMockProvider('');
    await assert.rejects(
      () => generateDetail(provider, plan, 'non-existent'),
      { message: 'Topic not found' }
    );
    store.deletePlan(plan.id);
  });

  it('should handle empty AI response as error', async () => {
    const plan = store.createPlan('gendetail-empty');
    await store.addTopics(plan.id, ['空响应']);
    const p = store.getPlan(plan.id);
    const provider = createStreamMockProvider('');
    await assert.rejects(
      () => generateDetail(provider, p, p.topics[0].id),
      { message: 'AI 返回内容为空' }
    );
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  answerFollowUp tests
// ═══════════════════════════════════════════════════════

describe('answerFollowUp', () => {
  it('should answer a follow-up question and store in history', async () => {
    const plan = store.createPlan('followup-test');
    await store.addTopics(plan.id, ['测试追问']);
    const p = store.getPlan(plan.id);
    // Set up detail so context is non-empty
    store.updateTopic(plan.id, p.topics[0].id, {
      detail: '这是讲解内容。',
      done: true,
    });
    const p2 = store.getPlan(plan.id);

    const provider = createMockProvider('这是一个很好的问题！让我详细解释一下。');
    const answer = await answerFollowUp(provider, p2, p2.topics[0].id, '能再解释一下吗？');

    assert.ok(answer, 'should return an answer');
    assert.ok(answer.includes('很好'), 'should include relevant response');

    // Verify history was stored
    const p3 = store.getPlan(plan.id);
    const topicHistory = p3.history.filter(h => h.topicId === p2.topics[0].id);
    assert.ok(topicHistory.length >= 2, 'should have user+ai entries in history');
    assert.strictEqual(topicHistory[topicHistory.length - 2].role, 'user', 'penultimate entry should be user question');
    assert.strictEqual(topicHistory[topicHistory.length - 2].content, '能再解释一下吗？');

    store.deletePlan(plan.id);
  });

  it('should throw for empty question', async () => {
    const plan = store.createPlan('followup-empty');
    const provider = createMockProvider('');
    await assert.rejects(
      () => answerFollowUp(provider, plan, 'some-topic', '   '),
      { message: '问题不能为空' }
    );
    store.deletePlan(plan.id);
  });

  it('should throw for non-existent topic', async () => {
    const plan = store.createPlan('followup-nope');
    const provider = createMockProvider('');
    await assert.rejects(
      () => answerFollowUp(provider, plan, 'non-existent', '你好'),
      { message: 'Topic not found' }
    );
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  revealEmbeddedErrors tests
// ═══════════════════════════════════════════════════════

describe('revealEmbeddedErrors', () => {
  it('should return empty when topic has no detail', async () => {
    const plan = store.createPlan('reveal-no-detail');
    await store.addTopics(plan.id, ['空知识点']);
    const p = store.getPlan(plan.id);
    const provider = createMockProvider('{}');
    const result = await revealEmbeddedErrors(provider, p, p.topics[0].id);
    assert.strictEqual(result.hasErrors, false);
    assert.deepStrictEqual(result.errors, []);
    store.deletePlan(plan.id);
  });

  it('should detect errors from AI response', async () => {
    const plan = store.createPlan('reveal-test');
    await store.addTopics(plan.id, ['带错误的知识点']);
    const p = store.getPlan(plan.id);
    const topic = p.topics[0];
    await store.updateTopic(plan.id, topic.id, {
      detail: '这段内容包含一个错误。变量赋值为 x = 5 + 3 = 10。',
      done: false,
    });
    const p2 = store.getPlan(plan.id);

    const mockResult = JSON.stringify({
      errors: [{
        location: '变量赋值部分',
        description: '5 + 3 应该等于 8，不是 10',
        correction: 'x = 5 + 3 = 8',
        type: '概念偏差',
      }],
      hasErrors: true,
    });
    const provider = createMockProvider(mockResult);
    const result = await revealEmbeddedErrors(provider, p2, topic.id);
    assert.strictEqual(result.hasErrors, true);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].correction.includes('8'));
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  decomposeTopic tests
// ═══════════════════════════════════════════════════════

describe('decomposeTopic', () => {
  it('should return subtopics from AI', async () => {
    const plan = store.createPlan('decompose-test');
    await store.addTopics(plan.id, ['JavaScript 闭包']);
    const p = store.getPlan(plan.id);

    const mockResult = JSON.stringify({
      subtopics: [
        { title: '作用域链', summary: '理解变量查找机制', order: 1 },
        { title: '闭包的定义与原理', summary: '闭包的本质是函数+外层作用域', order: 2 },
        { title: '闭包的实际应用', summary: '模块模式和私有变量', order: 3 },
      ],
    });
    const provider = createMockProvider(mockResult);
    const result = await decomposeTopic(provider, p, p.topics[0].id);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].title, '作用域链');
    assert.strictEqual(result[1].title, '闭包的定义与原理');
    store.deletePlan(plan.id);
  });

  it('should throw for non-existent topic', async () => {
    const plan = store.createPlan('decompose-nope');
    const provider = createMockProvider('');
    await assert.rejects(
      () => decomposeTopic(provider, plan, 'non-existent'),
      { message: 'Topic not found' }
    );
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  analyzeLearning tests
// ═══════════════════════════════════════════════════════

describe('analyzeLearning', () => {
  it('should return analysis structure with provider response', async () => {
    const mockProvider = createMockProvider('## 分析结果\n\n学习进度良好，继续努力！');
    const plan = store.createPlan('analysis-test');
    await store.addTopics(plan.id, ['分析测试']);
    const p1 = store.getPlan(plan.id); // reload after addTopics
    await store.updateTopic(p1.id, p1.topics[0].id, {
      detail: '讲解了分析相关内容',
      done: true,
    });
    await store.addHistory(p1.id, p1.topics[0].id, 'user', '这个知识点难吗？');
    await store.addHistory(p1.id, p1.topics[0].id, 'ai', '不难，掌握就好。');
    const p = store.getPlan(plan.id);

    const result = await analyzeLearning(mockProvider, p, 'mock-model');
    assert.ok(result.analysis, 'should have analysis text');
    assert.ok(result.analysis.includes('分析结果'), 'should include AI response');
    assert.ok(result.analyzedAt > 0, 'should have timestamp');
    assert.strictEqual(result.topicCount, 1, 'should count topics');
    assert.strictEqual(result.doneCount, 1, 'should count done topics');
    assert.strictEqual(result.totalQuestions, 1, 'should count questions');
    assert.ok(result.usage, 'should include usage data');
    store.deletePlan(plan.id);
  });

  it('should handle empty plan gracefully', async () => {
    const mockProvider = createMockProvider('无分析数据。');
    const plan = store.createPlan('empty-analysis');
    const p = store.getPlan(plan.id);

    const result = await analyzeLearning(mockProvider, p, 'mock-model');
    assert.ok(result.analysis, 'should still return analysis');
    assert.strictEqual(result.topicCount, 0, 'no topics');
    assert.strictEqual(result.doneCount, 0, 'no done topics');
    store.deletePlan(plan.id);
  });

  it('should include previous analysis chat when provided', async () => {
    const mockProvider = createMockProvider('根据之前的讨论，我调整了分析。');
    const plan = store.createPlan('analysis-chat-test');
    const p = store.getPlan(plan.id);
    const chatHistory = [
      { role: 'user', content: '能详细说下我的学习风格吗？' },
      { role: 'assistant', content: '你的学习风格是偏向理论驱动的。' },
    ];

    const result = await analyzeLearning(mockProvider, p, 'mock-model', chatHistory);
    assert.ok(result.analysis, 'should have analysis');
    assert.ok(result.analysis.includes('之前的讨论'), 'should reference chat');
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  analyzeCoreTopics tests
// ═══════════════════════════════════════════════════════

describe('analyzeCoreTopics', () => {
  it('should identify core 20% topics from a plan', async () => {
    const mockResult = {
      coreTopics: [
        { topicId: 'placeholder', title: '变量与数据类型', reasons: ['所有编程的基础概念', '几乎每段代码都用到'], importance: 'high', coverage: '变量声明、类型转换、作用域' },
        { topicId: 'placeholder2', title: '函数', reasons: ['代码复用的核心机制', '模块化编程的基础'], importance: 'high', coverage: '函数定义、参数、返回值' },
      ],
      summary: '该计划共有8个知识点，其中变量与数据类型、函数是最核心的20%，覆盖日常编程80%场景。',
      corePrinciple: '先掌握变量和函数的本质，再学其他内容事半功倍',
    };
    const provider = createMockProvider(JSON.stringify(mockResult));

    const plan = store.createPlan('core20-test');
    await store.addTopics(plan.id, ['变量与数据类型', '运算符', '控制流', '函数', '数组', '对象', '类与继承', '异步编程']);
    const p = store.getPlan(plan.id);

    const result = await analyzeCoreTopics(provider, p, 'mock-model');
    assert.ok(result, 'should return result');
    assert.ok(Array.isArray(result.coreTopics), 'coreTopics should be an array');
    assert.ok(result.coreTopics.length >= 1, 'should identify at least one core topic');
    assert.ok(result.summary, 'should have summary');
    assert.ok(result.corePrinciple, 'should have core principle');

    // Match topics by title (mock ids are placeholders, engine should map to real ids)
    const foundVariables = result.coreTopics.find(ct => ct.title === '变量与数据类型');
    assert.ok(foundVariables, 'should identify "变量与数据类型" as a core topic');
    assert.ok(foundVariables.topicId, 'should have real topicId from plan');
    assert.ok(foundVariables.reasons.length > 0, 'should have reasons');

    // Verify topicId matches a real topic in the plan
    const matchedTopic = p.topics.find(t => t.id === foundVariables.topicId);
    assert.ok(matchedTopic, 'core topicId should match a plan topic');
    assert.strictEqual(matchedTopic.title, '变量与数据类型');

    store.deletePlan(plan.id);
  });

  it('should handle empty core topics gracefully', async () => {
    const mockResult = { coreTopics: [], summary: '暂无足够数据确定核心知识点', corePrinciple: '' };
    const provider = createMockProvider(JSON.stringify(mockResult));

    const plan = store.createPlan('core20-empty-test');
    await store.addTopics(plan.id, ['知识点A']);
    const p = store.getPlan(plan.id);

    const result = await analyzeCoreTopics(provider, p, 'mock-model');
    assert.deepStrictEqual(result.coreTopics, []);
    assert.ok(result.summary);

    store.deletePlan(plan.id);
  });

  it('should handle malformed AI response gracefully', async () => {
    const provider = createMockProvider('不是JSON格式的响应');

    const plan = store.createPlan('core20-malformed-test');
    await store.addTopics(plan.id, ['测试知识点']);
    const p = store.getPlan(plan.id);

    const result = await analyzeCoreTopics(provider, p, 'mock-model');
    assert.ok(result, 'should still return an object');
    assert.ok(Array.isArray(result.coreTopics), 'should have topics array');
    assert.strictEqual(result.coreTopics.length, 0, 'should be empty for malformed response');

    store.deletePlan(plan.id);
  });

  it('should save core analysis to the plan', async () => {
    const mockResult = {
      coreTopics: [
        { topicId: 'placeholder', title: '核心知识点', reasons: ['最重要'], importance: 'high', coverage: '全部' },
      ],
      summary: '总结内容',
      corePrinciple: '核心原则',
    };
    const provider = createMockProvider(JSON.stringify(mockResult));

    const plan = store.createPlan('core20-save-test');
    await store.addTopics(plan.id, ['核心知识点', '次要知识点']);
    const p = store.getPlan(plan.id);

    await analyzeCoreTopics(provider, p, 'mock-model');

    // Reload from store to verify persistence
    const updatedPlan = store.getPlan(plan.id);
    assert.ok(updatedPlan.coreAnalysis, 'plan should have coreAnalysis data');
    assert.ok(updatedPlan.coreAnalysis.analyzedAt, 'should have timestamp');
    assert.strictEqual(updatedPlan.coreAnalysis.summary, '总结内容');

    store.deletePlan(plan.id);
  });

  it('should return cached result if already analyzed', async () => {
    const plan = store.createPlan('core20-cache-test');
    await store.addTopics(plan.id, ['知识点A']);

    // Pre-set coreAnalysis via store
    const existingAnalysis = {
      coreTopics: [{ topicId: '', title: '知识点A', reasons: ['已分析'], importance: 'high', coverage: '' }],
      summary: '已有分析',
      corePrinciple: '已有原则',
      analyzedAt: Date.now(),
    };
    await store.saveCoreAnalysis(plan.id, existingAnalysis);

    // Reload plan from store so it has coreAnalysis
    const p = store.getPlan(plan.id);

    // Create a provider that would fail if called
    const failProvider = createMockProvider('should not be called');
    const result = await analyzeCoreTopics(failProvider, p, 'mock-model');

    assert.strictEqual(result.summary, '已有分析', 'should return cached result');
    assert.strictEqual(result.coreTopics[0].title, '知识点A');

    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  answerAnalysisFollowUp tests
// ═══════════════════════════════════════════════════════

describe('answerAnalysisFollowUp', () => {
  it('should return answer for analysis follow-up', async () => {
    const analysis = '## 分析报告\n你的学习进度良好。';
    const mockProvider = createMockProvider('这是一个很好的追问！让我详细说明。');
    const plan = store.createPlan('analysis-fu-test');
    const p = store.getPlan(plan.id);
    await store.addTopics(plan.id, ['追问测试']);
    const p2 = store.getPlan(plan.id);

    const result = await answerAnalysisFollowUp(mockProvider, p2, analysis, '能详细说明一下吗？');
    assert.ok(result, 'should return result');
    assert.ok(result.content, 'should have content');
    assert.ok(result.content.includes('很好'), 'should include response');
    store.deletePlan(plan.id);
  });

  it('should handle empty question gracefully', async () => {
    const mockProvider = createMockProvider('请提供你的问题。');
    const plan = store.createPlan('analysis-fu-empty');
    const p = store.getPlan(plan.id);

    const result = await answerAnalysisFollowUp(mockProvider, p, '报告内容', '');
    assert.ok(result, 'should still return something');
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  getEngineCacheDiagnostics tests
// ═══════════════════════════════════════════════════════

describe('getEngineCacheDiagnostics', () => {
  it('should return cache diagnostics object', () => {
    const diag = getEngineCacheDiagnostics();
    assert.ok(diag, 'should return diagnostics');
    assert.ok('summary' in diag, 'should have summary');
    assert.ok('prefixChanges' in diag, 'should have prefixChanges');
  });

  it('should have summary with totalCalls', () => {
    const diag = getEngineCacheDiagnostics();
    assert.strictEqual(typeof diag.summary.totalCalls, 'number');
  });
});

// ═══════════════════════════════════════════════════════
//  createProviderFromConfig tests
// ═══════════════════════════════════════════════════════

describe('createProviderFromConfig', () => {
  it('should create a Provider from config values', () => {
    const provider = createProviderFromConfig('test-key', 'https://test.api/v1', 'test-model');
    assert.ok(provider instanceof Provider, 'should be a Provider instance');
    assert.strictEqual(provider.model, 'test-model');
  });

  it('should return the same instance for same config (cached)', () => {
    const p1 = createProviderFromConfig('cache-key', 'https://cache.api/v1', 'cache-model');
    const p2 = createProviderFromConfig('cache-key', 'https://cache.api/v1', 'cache-model');
    assert.strictEqual(p1, p2, 'should be the same instance');
  });

  it('should create different instances for different config', () => {
    const p1 = createProviderFromConfig('key1', 'https://api1/v1', 'model1');
    const p2 = createProviderFromConfig('key2', 'https://api2/v1', 'model2');
    assert.notStrictEqual(p1, p2, 'should be different instances');
  });
});

// ═══════════════════════════════════════════════════════
//  buildImagePrompt tests (pure function, internal)
// ═══════════════════════════════════════════════════════

describe('buildImagePrompt', () => {
  // We test via generateTopicImage with mock — the buildImagePrompt is internal.
  // Since it's not exported, we test generateTopicImage returns null for missing inputs.
  it('generateTopicImage should return null for missing topic id', async () => {
    // generateTopicImage is not directly exported to test the internal function,
    // but we can verify it handles edge cases
    const result = await generateTopicImage(null, 'some-key');
    assert.strictEqual(result, null);
  });

  it('generateTopicImage should return null for missing title', async () => {
    const result = await generateTopicImage({ id: 't1' }, 'some-key');
    assert.strictEqual(result, null);
  });

  it('generateTopicImage should return null for missing apiKey', async () => {
    const result = await generateTopicImage({ id: 't1', title: '测试' }, null);
    assert.strictEqual(result, null);
  });
});

// ═══════════════════════════════════════════════════════
//  Interactive mode edge cases
// ═══════════════════════════════════════════════════════

describe('Interactive mode - edge cases', () => {
  // "跳过" test removed — state machine no longer tracks step skipping

  it('continueInteractiveDetail should handle empty feedback gracefully', async () => {
    const plan = store.createPlan('empty-fb-test');
    await store.addTopics(plan.id, ['空反馈测试']);
    const p = store.getPlan(plan.id);

    const provider = createStreamMockProvider('回应内容');
    await startInteractiveDetail(provider, p, p.topics[0].id, 'realtime');

    // Empty feedback should not crash
    const result = await continueInteractiveDetail(provider, p, p.topics[0].id, 'realtime', '');
    assert.ok(result.content, 'should still return content');
    assert.strictEqual(result.session.transcript.length, 3, 'should have 3 entries');

    store.deletePlan(plan.id);
  });

  // "stepwise mode without stateMachine" test removed — state machine no longer exists

  it('should persist interactive session across multiple restarts', async () => {
    const plan = store.createPlan('persist-test');
    await store.addTopics(plan.id, ['持久化测试']);
    const p = store.getPlan(plan.id);

    const provider1 = createToolMockProvider('第一轮内容', [
      { id: 'call_p1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{}' } }
    ]);
    await startInteractiveDetail(provider1, p, p.topics[0].id, 'stepwise');

    // Read back from store
    const pAfterStart = store.getPlan(plan.id);
    const sessionAfterStart = pAfterStart.topics.find(t => t.id === p.topics[0].id)?.interactiveSession;
    assert.ok(sessionAfterStart, 'session should be persisted');
    assert.strictEqual(sessionAfterStart.transcript.length, 1);

    const provider2 = createToolMockProvider('第二轮内容', [
      { id: 'call_p2', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{}' } }
    ]);
    await continueInteractiveDetail(provider2, p, p.topics[0].id, 'stepwise', '继续');

    // Read back from store again
    const pAfterContinue = store.getPlan(plan.id);
    const sessionAfterContinue = pAfterContinue.topics.find(t => t.id === p.topics[0].id)?.interactiveSession;
    assert.ok(sessionAfterContinue, 'session should still be persisted');
    // transcript: [assistant1, tool1, assistant2]
    assert.strictEqual(sessionAfterContinue.transcript.length, 3);

    store.deletePlan(plan.id);
  });

  it('startInteractiveDetail should support all modes and return correct mode', async () => {
    // This supplements the existing all-modes test with additional assertions
    const modes = ['stepwise', 'realtime', 'challenge', 'scaffold'];
    for (const mode of modes) {
      const plan = store.createPlan(`mode-${mode}-test`);
      await store.addTopics(plan.id, [`${mode}模式测试`]);
      const p = store.getPlan(plan.id);
      const provider = mode === 'stepwise'
        ? createToolMockProvider(`这是${mode}模式的讲解。`, [{ id: 'call_ma1', type: 'function', function: { name: 'ask_user_to_continue', arguments: '{}' } }])
        : createStreamMockProvider(`这是${mode}模式的讲解。`);
      const result = await startInteractiveDetail(provider, p, p.topics[0].id, mode);
      assert.strictEqual(result.session.mode, mode);
      assert.strictEqual(result.session.finished, false);
      assert.ok(result.content.includes(mode) || result.content.length > 0);
      store.deletePlan(plan.id);
    }
  });

  it('continueInteractiveDetail should work with exercise mode (scaffold)', async () => {
    const plan = store.createPlan('scaffold-continue');
    await store.addTopics(plan.id, ['脚手架继续测试']);
    const p = store.getPlan(plan.id);
    const provider = createStreamMockProvider('子问题1：什么是变量？');
    await startInteractiveDetail(provider, p, p.topics[0].id, 'scaffold');

    const result = await continueInteractiveDetail(provider, p, p.topics[0].id, 'scaffold', '变量是存储数据的容器');
    assert.ok(result.content, 'should return next content');
    assert.strictEqual(result.session.mode, 'scaffold');
    assert.strictEqual(result.session.transcript.length, 3);
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  Feynman mode tests
// ═══════════════════════════════════════════════════════

describe('Feynman mode', () => {
  it('startInteractiveDetail should support feynman mode', async () => {
    const plan = store.createPlan('feynman-test');
    await store.addTopics(plan.id, ['费曼测试']);
    const p = store.getPlan(plan.id);
    const provider = createStreamMockProvider('好的，我准备好了！请你开始讲解吧。');
    const result = await startInteractiveDetail(provider, p, p.topics[0].id, 'feynman');
    assert.strictEqual(result.session.mode, 'feynman');
    assert.ok(result.content, 'should return welcome content');
    assert.strictEqual(result.session.finished, false);
    store.deletePlan(plan.id);
  });

  it('continueInteractiveDetail should work with feynman mode', async () => {
    const plan = store.createPlan('feynman-continue');
    await store.addTopics(plan.id, ['费曼继续测试']);
    const p = store.getPlan(plan.id);
    const provider1 = createStreamMockProvider('好的，请开始讲解「费曼继续测试」。');
    const r1 = await startInteractiveDetail(provider1, p, p.topics[0].id, 'feynman');
    assert.strictEqual(r1.session.mode, 'feynman');

    const provider2 = createStreamMockProvider('能给我举个具体的例子吗？');
    const r2 = await continueInteractiveDetail(provider2, p, p.topics[0].id, 'feynman', '变量就是存储数据的容器');
    assert.ok(r2.content, 'should return follow-up question');
    assert.strictEqual(r2.session.transcript.length, 3);
    assert.strictEqual(r2.session.mode, 'feynman');
    store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  generateQuickQuiz tests
// ═══════════════════════════════════════════════════════

describe('generateQuickQuiz', () => {
  it('should generate quiz questions from plan topics', async () => {
    const mockResult = {
      questions: [
        { topicTitle: '变量', type: 'choice', question: '1+1=?', options: ['1', '2', '3'], answer: '2', explanation: '1+1=2' },
        { topicTitle: '函数', type: 'open', question: '什么是函数？', answer: '函数是可复用的代码块', explanation: '基本概念' },
      ],
    };
    const provider = createMockProvider(JSON.stringify(mockResult));
    const plan = store.createPlan('quiz-test');
    await store.addTopics(plan.id, ['变量', '函数', '循环']);
    const p = store.getPlan(plan.id);
    // Mark two as done with detail
    await store.updateTopic(plan.id, p.topics[0].id, { detail: '变量讲解内容', done: true });
    await store.updateTopic(plan.id, p.topics[1].id, { detail: '函数讲解内容', done: true });
    const p2 = store.getPlan(plan.id);

    const result = await generateQuickQuiz(provider, p2, 'mock-model');
    assert.ok(result, 'should return result');
    assert.ok(Array.isArray(result.questions), 'questions should be an array');
    assert.strictEqual(result.topicCount, 2, 'should count topics');
    store.deletePlan(plan.id);
  });

  it('should handle empty plan gracefully', async () => {
    const provider = createMockProvider('{}');
    const plan = store.createPlan('quiz-empty');
    const p = store.getPlan(plan.id);
    const result = await generateQuickQuiz(provider, p, 'mock-model');
    assert.ok(Array.isArray(result.questions));
    assert.strictEqual(result.questions.length, 0);
    store.deletePlan(plan.id);
  });

  it('should handle malformed AI response gracefully', async () => {
    const provider = createMockProvider('不是JSON');
    const plan = store.createPlan('quiz-malformed');
    await store.addTopics(plan.id, ['测试']);
    const p = store.getPlan(plan.id);
    const result = await generateQuickQuiz(provider, p, 'mock-model');
    assert.ok(Array.isArray(result.questions));
    assert.strictEqual(result.questions.length, 0);
    store.deletePlan(plan.id);
  });
});

