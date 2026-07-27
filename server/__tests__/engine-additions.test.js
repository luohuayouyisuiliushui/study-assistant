import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Provider } from '../engine/provider.js';
import {
  recommendResources,
  buildImagePrompt,
} from '../engine/learn-engine.js';
import {
  buildDetailMessages,
  buildDeterministicContext,
} from '../engine/learn-prompts.js';
import { generateSingleQuestion, gradeExam } from '../engine/exam-engine.js';
import * as store from '../engine/learn-store.js';

// ─── Mock provider that returns a fixed completion ───
function createMockProvider(resultContent, modelName = 'mock-model') {
  const mockClient = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{ message: { content: resultContent, role: 'assistant' } }],
            model: modelName,
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
        },
      },
    },
  };
  const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: modelName });
  provider._client = mockClient;
  provider._autoWarm = false;
  return provider;
}

function createSequencedMockProvider(responses, modelName = 'mock-model') {
  const requests = [];
  let responseIndex = 0;
  const mockClient = {
    chat: {
      completions: {
        async create(options) {
          requests.push(options);
          const response = responses[Math.min(responseIndex++, responses.length - 1)];
          return {
            choices: [{
              message: { content: response.content, role: 'assistant' },
              finish_reason: response.finishReason || 'stop',
            }],
            model: modelName,
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
        },
      },
    },
  };
  const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.api/v1', model: modelName });
  provider._client = mockClient;
  provider._autoWarm = false;
  return { provider, requests };
}

let planId = null;

before(async () => {
  const plan = await store.createPlan('rec-test-plan');
  planId = plan.id;
  await store.addTopics(plan.id, ['Socket 编程基础']);
});

after(() => {
  if (planId) {
    try { store.deletePlan(planId); } catch {}
  }
});

describe('recommendResources', () => {
  it('returns structured multi-channel resources from AI JSON', async () => {
    const json = JSON.stringify({
      topicTitle: 'Socket 编程基础',
      resources: [
        { type: 'book', title: 'UNIX 网络编程', source: ' Prentice Hall', level: 'advanced', paid: true, reason: '经典权威', url: 'https://example.com/book' },
        { type: 'video', title: 'Socket 入门视频', source: 'YouTube', level: 'beginner', paid: false, reason: '直观演示', url: '' },
      ],
    });
    const provider = createMockProvider(json);
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    const result = await recommendResources(provider, plan, topicId, 'mock-model');

    assert.equal(result.topicTitle, 'Socket 编程基础');
    assert.equal(result.resources.length, 2);
    assert.equal(result.resources[0].type, 'book');
    assert.equal(result.resources[0].title, 'UNIX 网络编程');
    assert.equal(result.resources[0].paid, true);
    assert.equal(result.resources[1].type, 'video');
  });

  it('accepts a JSON code fence even when the model adds a short introduction', async () => {
    const json = JSON.stringify({
      topicTitle: 'Socket 编程基础',
      resources: [{
        type: 'doc',
        title: 'Linux man-pages',
        source: 'man7.org',
        level: 'intermediate',
        paid: false,
        reason: '权威系统调用文档',
        url: 'https://man7.org/linux/man-pages/',
      }],
    });
    const provider = createMockProvider(`推荐结果如下：\n\`\`\`json\n${json}\n\`\`\``, 'resource-wrapped-json-model');
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    await store.updateTopic(plan.id, topicId, { detail: `围栏 JSON 恢复测试 ${Date.now()}` });

    const result = await recommendResources(
      provider,
      store.getPlan(planId),
      topicId,
      'resource-wrapped-json-model'
    );

    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].title, 'Linux man-pages');
  });

  it('normalizes missing optional fields safely', async () => {
    const json = JSON.stringify({
      topicTitle: 'X',
      resources: [{ title: 'Some article' }], // missing type/source/level/paid/url
    });
    const provider = createMockProvider(json);
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    // Give the topic distinct detail so the request hash differs from the
    // previous test (the Provider shares a process-wide response cache keyed
    // on the exact request — identical prompts would hit the cache).
    await store.updateTopic(plan.id, topicId, { detail: '完全不同的知识点内容用于区分缓存键。' });
    const result = await recommendResources(provider, plan, topicId, 'mock-model');
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].type, 'article'); // defaulted
    assert.equal(result.resources[0].paid, false); // defaulted
    assert.equal(result.resources[0].level, 'intermediate'); // defaulted
  });

  it('throws on unknown topic', async () => {
    const provider = createMockProvider('{}');
    const plan = store.getPlan(planId);
    await assert.rejects(() => recommendResources(provider, plan, 'no-such-topic', 'mock-model'));
  });

  it('retries a truncated response with enough budget and a concise prompt', async () => {
    const resources = Array.from({ length: 6 }, (_, index) => ({
      type: index === 0 ? 'book' : 'doc',
      title: `资源 ${index + 1}`,
      source: '权威来源',
      level: 'intermediate',
      paid: false,
      reason: '紧扣当前知识点',
      url: `https://example.com/resource-${index + 1}`,
    }));
    const { provider, requests } = createSequencedMockProvider([
      {
        content: '{"topicTitle":"Socket 编程基础","resources":[{"type":"book","title":"未完成',
        finishReason: 'length',
      },
      {
        content: JSON.stringify({ topicTitle: 'Socket 编程基础', resources }),
        finishReason: 'stop',
      },
    ], 'resource-retry-model');
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    await store.updateTopic(plan.id, topicId, {
      detail: `资源截断恢复测试 ${Date.now()}`,
    });

    const result = await recommendResources(provider, store.getPlan(planId), topicId, 'resource-retry-model');

    assert.equal(result.resources.length, 6);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].max_tokens >= 4096);
    assert.match(requests[1].messages.at(-1).content, /精简/);
  });

  it('retries instead of silently accepting an empty resource list', async () => {
    const recoveredResource = {
      type: 'doc',
      title: 'Linux man-pages',
      source: 'man7.org',
      level: 'intermediate',
      paid: false,
      reason: '提供权威 API 定义',
      url: 'https://man7.org/linux/man-pages/',
    };
    const { provider, requests } = createSequencedMockProvider([
      { content: '{}', finishReason: 'stop' },
      {
        content: JSON.stringify({
          topicTitle: 'Socket 编程基础',
          resources: [null, recoveredResource],
        }),
        finishReason: 'stop',
      },
    ], 'resource-empty-retry-model');
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    await store.updateTopic(plan.id, topicId, {
      detail: `资源空结果恢复测试 ${Date.now()}`,
    });

    const result = await recommendResources(
      provider,
      store.getPlan(planId),
      topicId,
      'resource-empty-retry-model'
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(result.resources, [recoveredResource]);
  });

  it('forwards a cancellation signal to the provider request', async () => {
    const resource = {
      type: 'doc',
      title: 'POSIX Threads Programming',
      source: 'LLNL',
      level: 'beginner',
      paid: false,
      reason: '线程 API 入门资料',
      url: 'https://hpc-tutorials.llnl.gov/posix/',
    };
    const { provider, requests } = createSequencedMockProvider([{
      content: JSON.stringify({ topicTitle: 'Socket 编程基础', resources: [resource] }),
    }], 'resource-signal-model');
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    await store.updateTopic(plan.id, topicId, { detail: `资源取消测试 ${Date.now()}` });
    const controller = new AbortController();

    await recommendResources(
      provider,
      store.getPlan(planId),
      topicId,
      'resource-signal-model',
      { signal: controller.signal }
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal, controller.signal);
  });
});

describe('exam engine runtime wiring', () => {
  it('generates a validated single question', async () => {
    const provider = createMockProvider(JSON.stringify({
      question: 'TCP 建立连接需要哪种报文？',
      options: ['A. SYN', 'B. FIN', 'C. RST', 'D. PSH'],
      answer: 'A',
      explanation: '客户端首先发送 SYN。',
      conceptTag: 'TCP 三次握手',
    }), 'single-question-runtime-model');

    const question = await generateSingleQuestion(provider, {
      index: 0,
      type: 'choice',
      difficulty: 'medium',
      topicTitle: 'Socket 编程基础',
    }, 'TCP 通过三次握手建立连接。', 'single-question-runtime-model');

    assert.ok(question);
    assert.equal(question.question, 'TCP 建立连接需要哪种报文？');
    assert.equal(question.options.length, 4);
  });

  it('persists exam results and wrong-answer weak points before returning', async () => {
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    const examId = 'runtime-wiring-exam';
    await store.addExamPaper(plan.id, {
      id: examId,
      title: '运行时接线测试',
      config: {},
      paper: '',
      questions: [{
        id: 'q1',
        index: 0,
        type: 'choice',
        question: 'TCP 建立连接首先发送什么？',
        options: ['A. SYN', 'B. FIN'],
        answer: 'A',
        explanation: '首先发送 SYN。',
        conceptTag: 'TCP 三次握手',
        topicId,
        difficulty: 'easy',
      }],
    });
    const provider = createMockProvider(JSON.stringify({
      results: [{
        exerciseIndex: 0,
        correct: false,
        userAnswer: 'B',
        correctAnswer: 'A',
        explanation: '应选择 SYN。',
      }],
    }), 'grade-runtime-model');

    await gradeExam(provider, store.getPlan(plan.id), examId, [
      { exerciseIndex: 0, userAnswer: 'B' },
    ]);

    const persisted = store.getPlan(plan.id);
    const persistedExam = persisted.examPapers.find(exam => exam.id === examId);
    assert.equal(persistedExam.results[0].correct, false);
    assert.ok(persisted.topics[0].weakPoints.includes('TCP 三次握手'));
  });
});

describe('buildImagePrompt', () => {
  it('produces a coherent, text-free educational brief', () => {
    const prompt = buildImagePrompt({ title: 'TCP 三次握手', detail: '客户端发送 SYN，服务端回 SYN-ACK，客户端再发 ACK 建立连接。' });
    assert.ok(prompt.includes('TCP 三次握手'), 'should mention the title');
    assert.ok(/network|拓扑|连接|通信/i.test(prompt), 'should detect a network-type illustration');
    assert.ok(prompt.length > 50 && prompt.length < 1200, 'prompt should be reasonably sized');
  });

  it('does not require a language-tagged input', () => {
    const prompt = buildImagePrompt('进程与线程');
    assert.ok(prompt.includes('进程与线程'));
  });
});

describe('explainStyle injection', () => {
  it('injects the chosen style guide into the deterministic context', () => {
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    const ctx = buildDeterministicContext(plan, topicId, undefined, 'visual');
    assert.ok(ctx.includes('【讲解风格：直观图解】'), 'visual style should be injected');
  });

  it('respects plan.explainStyle when no explicit arg is given', () => {
    const plan = store.getPlan(planId);
    plan.explainStyle = 'abstract';
    const topicId = plan.topics[0].id;
    const ctx = buildDeterministicContext(plan, topicId);
    assert.ok(ctx.includes('【讲解风格：抽象精炼】'));
    delete plan.explainStyle;
  });

  it('omits style line when none selected', () => {
    const plan = store.getPlan(planId);
    delete plan.explainStyle;
    const topicId = plan.topics[0].id;
    const ctx = buildDeterministicContext(plan, topicId);
    assert.ok(!/【讲解风格/.test(ctx));
  });

  it('buildDetailMessages forwards explainStyle into the context message', () => {
    const plan = store.getPlan(planId);
    const topicId = plan.topics[0].id;
    const msgs = buildDetailMessages(plan, topicId, '讲讲看', 'textbook');
    assert.ok(msgs[1].content.includes('【讲解风格：纸质教材感】'));
  });
});
