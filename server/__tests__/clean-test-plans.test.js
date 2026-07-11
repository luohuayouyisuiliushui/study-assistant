import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as store from '../engine/learn-store.js';
import { cleanTestPlans, isTestPlan, DEFAULT_PATTERNS } from '../scripts/clean-test-plans.js';

const testPlanIds = [];

function createPlan(name) {
  const p = store.createPlan(name);
  testPlanIds.push(p.id);
  return p;
}

describe('cleanTestPlans — 测试计划清理', () => {
  after(() => {
    for (const id of testPlanIds) {
      try { store.permanentlyDeletePlan(id); } catch {}
    }
    testPlanIds.length = 0;
  });

  // ─── isTestPlan 单元测试 ───

  describe('isTestPlan', () => {
    it('匹配已知前缀', () => {
      assert.ok(isTestPlan('engine-test-plan'));
      assert.ok(isTestPlan('adaptive-test-plan'));
      assert.ok(isTestPlan('empty-topic-plan'));
      assert.ok(isTestPlan('reorder-test'));
      assert.ok(isTestPlan('teaching-errors-plan'));
      assert.ok(isTestPlan('core20-cache-test'));
      assert.ok(isTestPlan('feynman-continue'));
      assert.ok(isTestPlan('scaffold-continue'));
      assert.ok(isTestPlan('mode-realtime-test'));
      assert.ok(isTestPlan('empty-fb-test'));
      assert.ok(isTestPlan('gendetail-preserve'));
    });

    it('匹配以 -test/_test 结尾的名称', () => {
      assert.ok(isTestPlan('my-feature-test'));
      assert.ok(isTestPlan('my_feature_test'));
      assert.ok(!isTestPlan('abcTest'), 'abcTest 不应匹配（缺少 - 或 _ 前缀）');
    });

    it('匹配包含 test 关键词的名称', () => {
      assert.ok(isTestPlan('V2 Test Plan'));
      assert.ok(isTestPlan('Integration Test Suite'));
    });

    it('不匹配真实计划名称', () => {
      assert.ok(!isTestPlan('Linux 编程核心'));
      assert.ok(!isTestPlan('我的学习计划'));
      assert.ok(!isTestPlan('Python 基础'));
    });
  });

  // ─── 默认模式测试 ───

  it('默认模式包含所有已知测试前缀', () => {
    const expected = [
      'engine-test-', 'adaptive-test-', 'empty-topic-', 'reorder-test',
      'teaching-errors-', 'remove-nonexist', 'empty-graph', 'dup-edge',
      'special-chars', 'time-edge-test', 'empty-topics-test',
      'core20-', 'feynman-', 'scaffold-', 'mode-', 'empty-fb-', 'gendetail-', 'V2 Test',
    ];
    for (const pat of expected) {
      assert.ok(DEFAULT_PATTERNS.includes(pat), `缺少默认模式: ${pat}`);
    }
  });

  describe('默认模式安全性', () => {
    before(() => cleanTestPlans());

    it('默认模式不会误删真实计划', () => {
      const p = createPlan('Linux 编程核心');
      const result = cleanTestPlans();
      assert.strictEqual(result.count, 0, '默认模式不应匹配真实计划名');
      assert.ok(store.getPlan(p.id));
    });
  });

  // ─── 新增前缀的删除测试 ───

  it('删除 core20-/feynman-/scaffold- 前缀的计划', () => {
    createPlan('core20-cache-test');
    createPlan('core20-empty-cache-test');
    createPlan('feynman-continue');
    createPlan('feynman-test');
    createPlan('scaffold-continue');
    createPlan('mode-realtime-test');
    createPlan('empty-fb-test');
    createPlan('gendetail-preserve');
    createPlan('gendetail-empty');
    createPlan('gendetail-test');
    const result = cleanTestPlans();
    assert.strictEqual(result.count, 10, `应删除 10 个测试计划，实际 ${result.count}`);
  });

  it('删除匹配名称模式的计划', () => {
    createPlan('engine-test-plan');
    createPlan('adaptive-test-plan');
    const result = cleanTestPlans({ patterns: ['engine-test-', 'adaptive-test-'] });
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.dryRun, undefined);
    const remaining = store.listPlans();
    assert.ok(!remaining.some(p => p.name === 'engine-test-plan'));
    assert.ok(!remaining.some(p => p.name === 'adaptive-test-plan'));
  });

  it('不删除不匹配的计划', () => {
    const p = createPlan('我的真实学习计划');
    const result = cleanTestPlans({ patterns: ['engine-test-', 'adaptive-test-'] });
    assert.strictEqual(result.count, 0);
    assert.ok(store.getPlan(p.id), '真实计划应保留');
  });

  it('dry-run 不删除任何计划', () => {
    const p = createPlan('engine-test-plan');
    const beforeCount = store.listPlans().length;

    const result = cleanTestPlans({ patterns: ['engine-test-'], dryRun: true });

    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.dryRun, true);
    assert.deepStrictEqual(result.deleted, ['engine-test-plan']);
    assert.ok(store.getPlan(p.id), 'dry-run 不应删除计划');
    assert.strictEqual(store.listPlans().length, beforeCount);
  });

  it('自定义 patterns 与正则兜底并行生效', () => {
    // engine-test-plan 从 dry-run 测试残留，包含 "test" 会被正则匹配
    const result = cleanTestPlans({ patterns: ['never-match-xxx'] });
    assert.ok(result.count >= 1, '正则兜底应匹配到含 test 的残留计划');
  });

  it('isTestPlan 传入自定义 patterns 可跳过正则', () => {
    // isTestPlan 只用 patterns 前缀匹配时，不含前缀的名称不匹配
    assert.ok(!isTestPlan('zzz-unique-learning-plan', ['never-match-xxx']));
  });

  it('不存在的模式不崩溃', () => {
    const result = cleanTestPlans({ patterns: ['zzz-nonexistent-xxxxx'] });
    assert.strictEqual(result.count, 0);
  });
});
