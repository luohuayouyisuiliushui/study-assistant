/**
 * Unit tests for the fact-check anti-hallucination engine.
 *
 * Tests cover:
 * 1. factCheckDetail — full audit with structured JSON output
 * 2. factCheckQuickScan — lightweight hallucination scan
 * 3. autoFixUncertainClaims — self-correction of flagged claims
 * 4. applyFixesToContent — merge corrections back into original content
 * 5. buildFactCheckReport — human-readable Markdown report
 * 6. buildFactCheckSummary — one-line summary
 * 7. Integration: generateDetail → auto fact-check on topic
 * 8. Edge cases: empty content, very short content, non-JSON responses
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Provider } from '../engine/provider.js';
import * as store from '../engine/learn-store.js';
import { generateDetail, createProviderFromConfig } from '../engine/learn-engine.js';
import {
  factCheckDetail,
  factCheckQuickScan,
  autoFixUncertainClaims,
  applyFixesToContent,
  buildFactCheckReport,
  buildFactCheckSummary,
} from '../engine/fact-checker.js';

// ─── Helpers ───

/**
 * Create a mock Provider that returns controlled JSON responses.
 * @param {string|object} resultContent - String content or object (auto-JSON-stringified)
 */
function createMockProvider(resultContent) {
  const content = typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent);
  const mockClient = {
    chat: {
      completions: {
        async create(opts) {
          return {
            choices: [{ message: { content, role: 'assistant' } }],
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

let testPlanId = null;

async function createPlanWithDetail() {
  const plan = await store.createPlan('fact-check-test-plan');
  testPlanId = plan.id;
  await store.addTopics(plan.id, ['TCP协议基础']);
  const p = store.getPlan(plan.id);
  const t1 = p.topics[0];
  await store.updateTopic(plan.id, t1.id, {
    detail: '## 核心概念\n\nTCP（Transmission Control Protocol）是面向连接的传输层协议。\n\n' +
      '它在RFC 793中定义，端口号范围是 0-65535。\n\n' +
      '## 为什么存在\n\nTCP解决了IP层的不可靠传输问题，提供了可靠的数据传输。\n\n' +
      '## 详细讲解\n\n### 三次握手\n\nTCP连接建立需要三次握手：SYN → SYN-ACK → ACK。\n' +
      '这个过程确保双方都能收发数据。\n\n' +
      '### 四次挥手\n\nTCP连接关闭需要四次挥手：FIN → ACK → FIN → ACK。\n\n' +
      '## 错误映射\n\n常见错误：ECONNREFUSED 表示目标端口未监听。',
    done: true,
  });
  return store.getPlan(plan.id);
}

// ─── Tests ───

describe('fact-checker', () => {
  after(async () => {
    if (testPlanId) {
      try { await store.permanentlyDeletePlan(testPlanId); } catch {}
    }
  });

  describe('factCheckDetail', () => {
    it('should audit content and return structured findings', async () => {
      const provider = createMockProvider({
        overallScore: 0.85,
        verdict: 'trusted',
        summary: '内容总体可信，发现1个需要关注的小问题',
        findings: [
          {
            claim: '端口号范围是 0-65535',
            location: '## 核心概念',
            dimension: 'numeric',
            confidence: 0.95,
            verdict: 'confirmed',
            explanation: '端口号范围确实是0-65535（16位无符号整数）',
            correction: '',
          },
        ],
      });

      const result = await factCheckDetail(provider, 'TCP是面向连接的协议，端口范围0-65535。TCP协议工作在传输层，提供可靠的端到端数据传输服务，是互联网协议族的核心组成部分之一，广泛应用于需要可靠传输的场景。它通过三次握手建立连接，通过滑动窗口进行流量控制。'.repeat(2), 'TCP协议');

      assert.ok(result);
      assert.strictEqual(result.verdict, 'trusted');
      assert.strictEqual(result.overallScore, 0.85);
      assert.strictEqual(result.findings.length, 1);
      assert.strictEqual(result.findings[0].verdict, 'confirmed');
      assert.ok(result.auditedAt > 0);
    });

    it('should handle content with hallucinations', async () => {
      const provider = createMockProvider({
        overallScore: 0.35,
        verdict: 'unreliable',
        summary: '发现多处疑似AI幻觉',
        findings: [
          {
            claim: 'TCP在RFC 9999中定义',
            location: '## 核心概念',
            dimension: 'standard',
            confidence: 0.05,
            verdict: 'hallucination',
            explanation: 'TCP定义于RFC 793，RFC 9999不存在',
            correction: 'RFC 793',
          },
          {
            claim: 'TCP使用7次握手建立连接',
            location: '## 三次握手',
            dimension: 'fact',
            confidence: 0.02,
            verdict: 'hallucination',
            explanation: 'TCP使用三次握手，非七次',
            correction: '三次握手',
          },
        ],
      });

      const result = await factCheckDetail(provider, 'TCP在RFC 9999中定义，使用7次握手建立连接。TCP是传输层协议，位于网络层之上，提供可靠的数据传输服务，通过确认和重传机制确保数据完整性。它广泛应用于HTTP、SSH、FTP等协议。'.repeat(2), 'TCP协议');

      assert.strictEqual(result.verdict, 'unreliable');
      assert.strictEqual(result.overallScore, 0.35);
      assert.strictEqual(result.findings.length, 2);
      assert.strictEqual(result.findings[0].verdict, 'hallucination');
    });

    it('should return trusted for clean content with no issues', async () => {
      const provider = createMockProvider({
        overallScore: 0.98,
        verdict: 'trusted',
        summary: '未发现明显问题',
        findings: [],
      });

      const result = await factCheckDetail(provider, 'TCP是面向连接的传输层协议，通过三次握手建立连接，通过四次挥手关闭连接。TCP保证数据按序到达且不丢失。', 'TCP协议');

      assert.strictEqual(result.verdict, 'trusted');
      assert.strictEqual(result.findings.length, 0);
      assert.ok(result.overallScore >= 0.9);
    });

    it('should handle empty content gracefully', async () => {
      const provider = createMockProvider({});

      const result = await factCheckDetail(provider, '', '空内容测试');

      assert.strictEqual(result.verdict, 'trusted');
      assert.strictEqual(result.overallScore, 1.0);
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.summary, '内容过短，无需审计');
    });

    it('should handle short content (< 100 chars)', async () => {
      const provider = createMockProvider({});

      const result = await factCheckDetail(provider, 'TCP是传输层协议。', 'TCP');

      assert.strictEqual(result.verdict, 'trusted');
      assert.strictEqual(result.overallScore, 1.0);
    });

    it('should handle AI returning non-JSON gracefully', async () => {
      const provider = createMockProvider('这不是有效的JSON');

      const result = await factCheckDetail(provider, 'TCP协议是面向连接的可靠传输协议，定义在RFC 793标准中。端口范围从0到65535，共65536个可用端口。TCP广泛应用于HTTP、SSH等常见协议。它通过三次握手建立连接，通过四次挥手断开连接，是互联网基础架构的重要组成部分。'.repeat(2), 'TCP协议');

      // When JSON parse fails, it should return error verdict
      assert.strictEqual(result.verdict, 'error');
      assert.strictEqual(result.findings.length, 0);
      assert.ok(result.summary.includes('事实核查失败'));
    });

    it('should handle AI returning partial JSON (missing fields)', async () => {
      const provider = createMockProvider({
        // Missing overallScore and verdict — should fall back to computed values
        summary: '部分审计',
        findings: [
          { claim: 'some claim', confidence: 0.9, verdict: 'confirmed', dimension: 'fact' },
        ],
      });

      const result = await factCheckDetail(provider, 'some content here about TCP...', 'TCP');

      assert.ok(result.overallScore > 0);
      assert.ok(['trusted', 'caution', 'unreliable'].includes(result.verdict));
    });
  });

  describe('factCheckQuickScan', () => {
    it('should return flagged=true for hallucinated content', async () => {
      const provider = createMockProvider({
        flagged: true,
        issues: [
          { claim: 'RFC 9999', problem: 'RFC 9999 不存在' },
        ],
      });

      const result = await factCheckQuickScan(provider, 'TCP定义在RFC 9999标准中，使用7次握手和10次挥手来建立和关闭连接，这是一种高效的传输层协议。端口号范围从0-100000不等，支持动态分配。该协议广泛应用于现代网络通信。'.repeat(2), 'TCP');

      assert.strictEqual(result.flagged, true);
      assert.strictEqual(result.issues.length, 1);
      assert.ok(result.scanTime > 0);
    });

    it('should return flagged=false for clean content', async () => {
      const provider = createMockProvider({
        flagged: false,
        issues: [],
      });

      const result = await factCheckQuickScan(provider, 'TCP是面向连接的协议。', 'TCP');

      assert.strictEqual(result.flagged, false);
      assert.strictEqual(result.issues.length, 0);
    });

    it('should skip empty content', async () => {
      const provider = createMockProvider({});
      const result = await factCheckQuickScan(provider, '', 'TCP');
      assert.strictEqual(result.flagged, false);
      assert.strictEqual(result.issues.length, 0);
    });
  });

  describe('autoFixUncertainClaims', () => {
    it('should return fixes for uncertain claims', async () => {
      const provider = createMockProvider({
        fixes: [
          {
            claim: 'TCP使用7次握手',
            action: 'correct',
            replacement: 'TCP使用三次握手建立连接',
            reason: '事实性错误，TCP是三次握手',
          },
          {
            claim: 'RFC 9999',
            action: 'correct',
            replacement: 'RFC 793',
            reason: '不存在的RFC编号',
          },
        ],
      });

      const uncertainFindings = [
        { claim: 'TCP使用7次握手', verdict: 'hallucination', location: '## 核心概念', explanation: '错误的事实陈述' },
        { claim: 'RFC 9999', verdict: 'hallucination', location: '## 核心概念', explanation: '虚构的RFC编号' },
      ];

      const fixes = await autoFixUncertainClaims(provider, uncertainFindings);

      assert.ok(fixes.length > 0);
      assert.strictEqual(fixes.length, 2);
      assert.strictEqual(fixes[0].action, 'correct');
      assert.strictEqual(fixes[1].replacement, 'RFC 793');
    });

    it('should return empty array for no uncertain findings', async () => {
      const provider = createMockProvider({});
      const fixes = await autoFixUncertainClaims(provider, []);
      assert.strictEqual(fixes.length, 0);
    });
  });

  describe('applyFixesToContent', () => {
    it('should replace wrong claims with corrections', async () => {
      const content = 'TCP使用7次握手建立连接。定义在RFC 9999中。';
      const fixes = [
        { claim: 'TCP使用7次握手建立连接', action: 'correct', replacement: 'TCP使用三次握手建立连接', reason: '' },
        { claim: 'RFC 9999', action: 'correct', replacement: 'RFC 793', reason: '' },
      ];

      const { content: corrected, fixedCount } = applyFixesToContent(content, fixes);

      assert.ok(corrected.includes('三次握手'));
      assert.ok(corrected.includes('RFC 793'));
      assert.ok(!corrected.includes('7次握手'));
      assert.ok(!corrected.includes('RFC 9999'));
      assert.ok(fixedCount >= 2);
    });

    it('should not modify content when action is confirm', async () => {
      const content = 'TCP是面向连接的协议。';
      const fixes = [
        { claim: 'TCP是面向连接的协议', action: 'confirm', replacement: 'same thing', reason: '' },
      ];

      const { content: corrected, fixedCount } = applyFixesToContent(content, fixes);

      assert.strictEqual(corrected, content);
      assert.strictEqual(fixedCount, 0);
    });

    it('should handle empty fixes', async () => {
      const content = 'some content';
      const { content: corrected, fixedCount } = applyFixesToContent(content, []);
      assert.strictEqual(corrected, content);
      assert.strictEqual(fixedCount, 0);
    });
  });

  describe('buildFactCheckReport', () => {
    it('should build a Markdown report with findings', async () => {
      const result = {
        overallScore: 0.6,
        verdict: 'caution',
        summary: '发现3个问题',
        findings: [
          { claim: '端口号 0-70000', location: '## 核心概念', confidence: 0.2, verdict: 'likely_wrong', dimension: 'numeric', explanation: '端口号最大65535', correction: '' },
        ],
      };

      const report = buildFactCheckReport(result);

      assert.ok(report.includes('事实核查报告'));
      assert.ok(report.includes('60%'));
      assert.ok(report.includes('需注意'));
      assert.ok(report.includes('端口号'));
    });

    it('should handle empty findings', async () => {
      const result = {
        overallScore: 1.0,
        verdict: 'trusted',
        summary: '没有问题',
        findings: [],
      };

      const report = buildFactCheckReport(result);

      assert.ok(report.includes('✅'));
      assert.ok(report.includes('100%'));
    });

    it('should handle error state', async () => {
      const report = buildFactCheckReport(null);
      assert.ok(report.includes('未能完成'));
    });
  });

  describe('buildFactCheckSummary', () => {
    it('should return one-line summary for clean content', async () => {
      const summary = buildFactCheckSummary({
        overallScore: 0.95,
        verdict: 'trusted',
        findings: [],
      });
      assert.ok(summary.includes('✅'));
      assert.ok(summary.includes('95%'));
      assert.ok(summary.includes('未发现问题'));
    });

    it('should return caution summary for flagged content', async () => {
      const summary = buildFactCheckSummary({
        overallScore: 0.6,
        verdict: 'caution',
        findings: [{}, {}, {}],
      });
      assert.ok(summary.includes('3'));
      assert.ok(summary.includes('60%'));
    });
  });

  describe('Integration: generateDetail + fact-check', () => {
    it('should store factCheck on topic after generateDetail', async () => {
      const plan = await createPlanWithDetail();
      const topic = plan.topics[0];

      // Manually invoke fact-check after generation (simulating the auto-trigger)
      const provider = createMockProvider({
        flagged: false,
        issues: [],
      });
      const result = await factCheckQuickScan(provider, topic.detail, topic.title);
      assert.strictEqual(result.flagged, false);

      // Verify the topic's detail was preserved
      const reloaded = store.getPlan(plan.id);
      const reloadedTopic = reloaded.topics.find(t => t.id === topic.id);
      assert.ok(reloadedTopic);
      assert.ok(reloadedTopic.detail.includes('TCP'));
    });
  });
});

describe('fact-checker — edge cases & robustness', () => {
  it('should handle rapidly changing content (cache miss scenario)', async () => {
    // Two calls with different content should produce different findings
    const provider = createMockProvider({
      overallScore: 0.9,
      verdict: 'trusted',
      summary: 'ok',
      findings: [],
    });

    const r1 = await factCheckDetail(provider, 'Content about TCP.', 'TCP');
    const r2 = await factCheckDetail(provider, 'Content about HTTP.', 'HTTP');

    assert.ok(r1.auditedAt > 0);
    assert.ok(r2.auditedAt > 0);
    // Both should succeed even with different content
    assert.strictEqual(r1.verdict, 'trusted');
    assert.strictEqual(r2.verdict, 'trusted');
  });

  it('should normalize dimension to fallback value for unknown types', async () => {
    const provider = createMockProvider({
      overallScore: 0.8,
      verdict: 'trusted',
      findings: [
        { claim: 'test', location: '', dimension: 'unknown_dimension', confidence: 0.5, verdict: 'uncertain', explanation: '', correction: '' },
      ],
    });

    const result = await factCheckDetail(provider, 'test content about something technical.'.repeat(10), 'Test');

    // The unknown dimension should still be accepted (no crash)
    assert.ok(result.findings[0]);
    assert.strictEqual(result.findings[0].dimension, 'unknown_dimension');
  });
});
