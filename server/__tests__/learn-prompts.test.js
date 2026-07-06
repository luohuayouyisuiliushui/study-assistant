import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildDeterministicContext, buildDetailMessages, buildFollowUpMessages, STABLE_DETAIL_SYSTEM_PROMPT, STABLE_FOLLOWUP_SYSTEM_PROMPT, STABLE_REVIEW_SYSTEM_PROMPT, STABLE_EXERCISE_GRADING_PROMPT, STABLE_WEAK_POINT_PROMPT, STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT, STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT, STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT, STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT, ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT, IMPORT_PLAN_PROMPT } from '../engine/learn-prompts.js';

function makePlan(overrides = {}) {
  return {
    id: 'test-plan',
    name: '测试计划',
    topics: [
      { id: 't1', title: '知识点A', order: 0, detail: '讲解内容', done: true, difficulty: null, lastError: null },
      { id: 't2', title: '知识点B', order: 1, detail: null, done: false, lastError: null },
      { id: 't3', title: '知识点C', order: 2, detail: null, done: false, lastError: null },
    ],
    phases: [
      { id: 'p1', name: '第一阶段', order: 0 },
    ],
    history: [],
    ...overrides,
  };
}

describe('STABLE_DETAIL_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_DETAIL_SYSTEM_PROMPT === 'string');
    assert.ok(STABLE_DETAIL_SYSTEM_PROMPT.length > 200);
  });

  it('should contain key sections', () => {
    assert.ok(STABLE_DETAIL_SYSTEM_PROMPT.includes('核心职责'));
    assert.ok(STABLE_DETAIL_SYSTEM_PROMPT.includes('输出格式要求'));
    assert.ok(STABLE_DETAIL_SYSTEM_PROMPT.includes('内容结构'));
    assert.ok(STABLE_DETAIL_SYSTEM_PROMPT.includes('质量标准'));
    assert.ok(STABLE_DETAIL_SYSTEM_PROMPT.includes('资源引用规范'));
  });
});

describe('STABLE_FOLLOWUP_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_FOLLOWUP_SYSTEM_PROMPT === 'string');
    assert.ok(STABLE_FOLLOWUP_SYSTEM_PROMPT.length > 200);
  });
});

describe('buildDeterministicContext', () => {
  it('should return empty string for missing topic', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 'non-existent');
    assert.strictEqual(result, '');
  });

  it('should include plan name and topic title', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 't1');
    assert.ok(result.includes('测试计划'));
    assert.ok(result.includes('知识点A'));
    assert.ok(result.includes('学习上下文'));
  });

  it('should show topic position', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 't2');
    assert.ok(result.includes('第2/3个'));
  });

  it('should show previous topics as foundation', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 't2');
    assert.ok(result.includes('已有基础'));
    assert.ok(result.includes('知识点A')); // t1 is done
  });

  it('should show next topics as targets', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 't2');
    assert.ok(result.includes('后续目标'));
    assert.ok(result.includes('知识点C'));
  });

  it('should show learning progress', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 't2');
    assert.ok(result.includes('1/3 已完成'));
  });

  it('should include Q&A pairs as history', () => {
    const plan = makePlan({
      history: [
        { topicId: 't1', role: 'user', content: '什么是X？', timestamp: 1000 },
        { topicId: 't1', role: 'ai', content: 'X是一种概念。', timestamp: 1001 },
        { topicId: 't1', role: 'user', content: '那Y呢？', timestamp: 1002 },
        { topicId: 't1', role: 'ai', content: 'Y是X的扩展。', timestamp: 1003 },
      ],
    });
    const result = buildDeterministicContext(plan, 't1');
    assert.ok(result.includes('学习历史记录'));
    assert.ok(result.includes('什么是X？'));
    assert.ok(result.includes('X是一种概念。'));
    assert.ok(result.includes('那Y呢？'));
    assert.ok(result.includes('Y是X的扩展。'));
  });

  it('should format Q&A pairs in order', () => {
    const plan = makePlan({
      history: [
        { topicId: 't1', role: 'user', content: 'Q1', timestamp: 1000 },
        { topicId: 't1', role: 'ai', content: 'A1', timestamp: 1001 },
        { topicId: 't1', role: 'user', content: 'Q2', timestamp: 1002 },
        { topicId: 't1', role: 'ai', content: 'A2', timestamp: 1003 },
      ],
    });
    const result = buildDeterministicContext(plan, 't1');
    // Check that Q1 appears before Q2
    const q1Idx = result.indexOf('Q1');
    const q2Idx = result.indexOf('Q2');
    assert.ok(q1Idx >= 0 && q2Idx >= 0);
    assert.ok(q1Idx < q2Idx, 'Q1 should appear before Q2');
    // Check format has 用户 and 助手 labels
    assert.ok(result.includes('用户:'));
    assert.ok(result.includes('助手:'));
  });

  it('should include all Q&A pairs within limit', () => {
    const history = [];
    for (let i = 0; i < 12; i++) {
      history.push({ topicId: 't1', role: 'user', content: `Q${i}`, timestamp: i * 10 });
      history.push({ topicId: 't1', role: 'ai', content: `A${i}`, timestamp: i * 10 + 1 });
    }
    const plan = makePlan({ history });
    const result = buildDeterministicContext(plan, 't1');
    // With limit raised to 20, all 12 pairs should be included
    assert.ok(result.includes('12轮问答'));
    // All pairs should appear (within the 20-round limit)
    assert.ok(result.includes('Q0'), 'Q0 should appear (all 12 pairs fit in 20-round limit)');
    assert.ok(result.includes('Q7'), 'Recent Q7 should appear');
  });

  it('should handle empty history gracefully', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 't1');
    assert.ok(!result.includes('学习历史记录'));
  });

  it('should handle unmatched user messages gracefully (no ai follow-up)', () => {
    const plan = makePlan({
      history: [
        { topicId: 't1', role: 'user', content: '孤立问题', timestamp: 1000 },
        // no ai response follows — should be skipped
      ],
    });
    const result = buildDeterministicContext(plan, 't1');
    assert.ok(!result.includes('学习历史记录'), 'orphan user message should not create history');
  });

  it('should include done count in progress', () => {
    const plan = makePlan();
    const result = buildDeterministicContext(plan, 't2');
    const progressLine = result.split('\n').find(l => l.includes('学习进度'));
    assert.ok(progressLine, 'should have progress line');
    assert.ok(progressLine.includes('1'), 'should show 1 done');
  });
});

describe('STABLE_REVIEW_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_REVIEW_SYSTEM_PROMPT === 'string');
    assert.ok(STABLE_REVIEW_SYSTEM_PROMPT.length > 100);
  });

  it('should mention key review concepts', () => {
    assert.ok(STABLE_REVIEW_SYSTEM_PROMPT.includes('复习'));
    assert.ok(STABLE_REVIEW_SYSTEM_PROMPT.includes('薄弱点'));
    assert.ok(STABLE_REVIEW_SYSTEM_PROMPT.includes('精简'));
  });
});

describe('STABLE_EXERCISE_GRADING_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_EXERCISE_GRADING_PROMPT === 'string');
    assert.ok(STABLE_EXERCISE_GRADING_PROMPT.length > 100);
  });

  it('should require JSON output format', () => {
    assert.ok(STABLE_EXERCISE_GRADING_PROMPT.includes('results'));
    assert.ok(STABLE_EXERCISE_GRADING_PROMPT.includes('"correct"'));
  });
});

describe('STABLE_WEAK_POINT_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_WEAK_POINT_PROMPT === 'string');
    assert.ok(STABLE_WEAK_POINT_PROMPT.length > 100);
  });

  it('should mention exercise analysis', () => {
    assert.ok(STABLE_WEAK_POINT_PROMPT.includes('薄弱'));
    assert.ok(STABLE_WEAK_POINT_PROMPT.includes('confidence'));
  });
});

describe('STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT === 'string');
    assert.ok(STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT.length > 200);
  });

  it('should contain stepwise teaching keywords', () => {
    assert.ok(STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT.includes('分段输出'));
    assert.ok(STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT.includes('等待用户'));
    assert.ok(STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT.includes('[SESSION_END]'));
  });
});

describe('STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT === 'string');
    assert.ok(STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT.length > 200);
  });

  it('should contain realtime teaching keywords', () => {
    assert.ok(STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT.includes('小块输出'));
    assert.ok(STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT.includes('高频率'));
    assert.ok(STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT.includes('[SESSION_END]'));
  });
});

describe('STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT === 'string');
    assert.ok(STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT.length > 200);
  });

  it('should contain challenge teaching keywords', () => {
    assert.ok(STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT.includes('故意'));
    assert.ok(STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT.includes('用户发现'));
    assert.ok(STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT.includes('[SESSION_END]'));
  });
});

describe('STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT === 'string');
    assert.ok(STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT.length > 200);
  });

  it('should contain scaffold teaching keywords', () => {
    assert.ok(STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT.includes('子问题'));
    assert.ok(STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT.includes('鼓励'));
    assert.ok(STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT.includes('[SESSION_END]'));
  });
});

describe('ANALYSIS_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof ANALYSIS_SYSTEM_PROMPT === 'string');
    assert.ok(ANALYSIS_SYSTEM_PROMPT.length > 200);
  });

  it('should contain analysis keywords', () => {
    assert.ok(ANALYSIS_SYSTEM_PROMPT.includes('分析'));
    assert.ok(ANALYSIS_SYSTEM_PROMPT.includes('个性化'));
  });
});

describe('ANALYSIS_FOLLOWUP_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof ANALYSIS_FOLLOWUP_PROMPT === 'string');
    assert.ok(ANALYSIS_FOLLOWUP_PROMPT.length > 100);
  });

  it('should contain follow-up keywords', () => {
    assert.ok(ANALYSIS_FOLLOWUP_PROMPT.includes('分析报告'));
    assert.ok(ANALYSIS_FOLLOWUP_PROMPT.includes('进一步的问题'));
  });
});

describe('IMPORT_PLAN_PROMPT', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof IMPORT_PLAN_PROMPT === 'string');
    assert.ok(IMPORT_PLAN_PROMPT.length > 500);
  });

  it('should contain JSON output requirements', () => {
    assert.ok(IMPORT_PLAN_PROMPT.includes('documentAnalysis'));
    assert.ok(IMPORT_PLAN_PROMPT.includes('phases'));
    assert.ok(IMPORT_PLAN_PROMPT.includes('relations'));
  });
});

describe('buildDetailMessages', () => {
  it('should return array with system + context messages', () => {
    const plan = makePlan();
    const msgs = buildDetailMessages(plan, 't1');
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, 'system');
    assert.strictEqual(msgs[0].content, STABLE_DETAIL_SYSTEM_PROMPT);
    assert.strictEqual(msgs[1].role, 'user');
    assert.ok(msgs[1].content.includes('学习上下文'));
  });

  it('should include question when provided', () => {
    const plan = makePlan();
    const msgs = buildDetailMessages(plan, 't1', '请讲解这个知识点');
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[2].role, 'user');
    assert.strictEqual(msgs[2].content, '请讲解这个知识点');
  });

  it('should not include question when omitted', () => {
    const plan = makePlan();
    const msgs = buildDetailMessages(plan, 't1');
    assert.strictEqual(msgs.length, 2);
  });

  it('should return empty context for missing topic', () => {
    const plan = makePlan();
    const msgs = buildDetailMessages(plan, 'non-existent');
    assert.strictEqual(msgs[1].content, '');
  });
});

describe('buildFollowUpMessages', () => {
  it('should return array with system + context messages', () => {
    const plan = makePlan();
    const msgs = buildFollowUpMessages(plan, 't1');
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, 'system');
    assert.strictEqual(msgs[0].content, STABLE_FOLLOWUP_SYSTEM_PROMPT);
  });

  it('should include question when provided', () => {
    const plan = makePlan();
    const msgs = buildFollowUpMessages(plan, 't1', '追问问题');
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[2].content, '追问问题');
  });

  it('should use follow-up prompt (not detail prompt)', () => {
    const plan = makePlan();
    const msgs = buildFollowUpMessages(plan, 't1');
    assert.ok(msgs[0].content.includes('追问'));
    assert.ok(!msgs[0].content.includes('练习题'));
  });
});

