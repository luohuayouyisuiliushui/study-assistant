/**
 * Tests for the production domain stores exposed through learn-store.js.
 * Focus: pure transformation functions that don't require network or file I/O.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildKnowledgeGraph,
  buildEnhancedKnowledgeGraph,
  buildInferredEdges,
  extractRelationsFromDetail,
  parseExercisesFromDetail,
  extractWeakPoints,
  getTopicsNeedingReview,
  computeGraphCentrality,
} from '../engine/learn-store.js';

// ═══════════════════════════════════════════════════════════
// Helper: make a minimal plan object
// ═══════════════════════════════════════════════════════════

function makePlan(topics, opts = {}) {
  return {
    id: 'test-' + Date.now(),
    name: opts.name || 'Test',
    topics,
    phases: opts.phases || [{ id: 'p1', name: 'Phase', order: 0 }],
    history: opts.history || [],
  };
}

// ═══════════════════════════════════════════════════════════
// buildKnowledgeGraph — node + edge construction
// ═══════════════════════════════════════════════════════════

describe('buildKnowledgeGraph', () => {
  it('should return nodes for all topics', () => {
    const topics = [
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, prerequisites: [], relatedTopics: [] },
      { id: 't2', title: 'B', level: 2, parentId: 't1', order: 1, prerequisites: [], relatedTopics: [] },
    ];
    const graph = buildKnowledgeGraph(makePlan(topics));
    assert.strictEqual(graph.nodes.length, 2);
    // parent-child edge should exist
    const parentEdge = graph.edges.find(e => e.from === 't1' && e.to === 't2');
    assert.ok(parentEdge);
    assert.strictEqual(parentEdge.type, 'parentOf');
  });

  it('should create prerequisite edges from prerequisites array', () => {
    const topics = [
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, prerequisites: [], relatedTopics: [] },
      { id: 't2', title: 'B', level: 1, parentId: null, order: 1, prerequisites: ['t1'], relatedTopics: [] },
    ];
    const graph = buildKnowledgeGraph(makePlan(topics));
    const preqEdge = graph.edges.find(e => e.from === 't1' && e.to === 't2');
    assert.ok(preqEdge, 'should have prerequisite edge from t1 to t2');
    assert.strictEqual(preqEdge.type, 'prerequisite');
  });

  it('should create related-to edges from relatedTopics array', () => {
    const topics = [
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, prerequisites: [], relatedTopics: ['t2'] },
      { id: 't2', title: 'B', level: 1, parentId: null, order: 1, prerequisites: [], relatedTopics: ['t1'] },
    ];
    const graph = buildKnowledgeGraph(makePlan(topics));
    const relatedEdge = graph.edges.find(e => e.from === 't1' && e.to === 't2');
    assert.ok(relatedEdge);
    assert.strictEqual(relatedEdge.type, 'related');
  });

  it('should create parent-child edges', () => {
    const topics = [
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, prerequisites: [], relatedTopics: [] },
      { id: 't2', title: 'B', level: 2, parentId: 't1', order: 0, prerequisites: [], relatedTopics: [] },
    ];
    const graph = buildKnowledgeGraph(makePlan(topics));
    const parentEdge = graph.edges.find(e => e.from === 't1' && e.to === 't2');
    assert.ok(parentEdge);
    assert.strictEqual(parentEdge.type, 'parentOf');
  });

  it('should handle topics with no relationships gracefully', () => {
    const topics = [
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, prerequisites: [], relatedTopics: [] },
    ];
    const graph = buildKnowledgeGraph(makePlan(topics));
    assert.strictEqual(graph.nodes.length, 1);
    assert.strictEqual(graph.edges.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════
// computeGraphCentrality — PageRank + degree centrality
// ═══════════════════════════════════════════════════════════

describe('computeGraphCentrality', () => {
  it('should return empty Map for empty graph', () => {
    const m = computeGraphCentrality({ nodes: [], edges: [] });
    assert.strictEqual(m.size, 0);
  });

  it('should return empty Map for null/undefined graph', () => {
    assert.strictEqual(computeGraphCentrality(null).size, 0);
    assert.strictEqual(computeGraphCentrality(undefined).size, 0);
  });

  it('should give single isolated node pageRank=1.0 and zero degrees', () => {
    const graph = {
      nodes: [{ id: 't1' }],
      edges: [],
    };
    const m = computeGraphCentrality(graph);
    const c = m.get('t1');
    assert.strictEqual(c.inDegree, 0);
    assert.strictEqual(c.outDegree, 0);
    assert.ok(Math.abs(c.pageRank - 1.0) < 1e-9, 'single node should have pageRank 1.0');
  });

  it('should count directed edges: prerequisite t1->t2 gives t1.outDegree=1, t2.inDegree=1', () => {
    const graph = {
      nodes: [{ id: 't1' }, { id: 't2' }],
      edges: [{ from: 't1', to: 't2', type: 'prerequisite' }],
    };
    const m = computeGraphCentrality(graph);
    assert.strictEqual(m.get('t1').outDegree, 1);
    assert.strictEqual(m.get('t1').inDegree, 0);
    assert.strictEqual(m.get('t2').outDegree, 0);
    assert.strictEqual(m.get('t2').inDegree, 1);
  });

  it('should treat "related" edges as bidirectional (both degrees increment)', () => {
    const graph = {
      nodes: [{ id: 't1' }, { id: 't2' }],
      edges: [{ from: 't1', to: 't2', type: 'related' }],
    };
    const m = computeGraphCentrality(graph);
    assert.strictEqual(m.get('t1').inDegree, 1);
    assert.strictEqual(m.get('t1').outDegree, 1);
    assert.strictEqual(m.get('t2').inDegree, 1);
    assert.strictEqual(m.get('t2').outDegree, 1);
  });

  it('should preserve total pageRank across iterations (sum ~ 1.0)', () => {
    const graph = {
      nodes: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
      edges: [
        { from: 't1', to: 't2', type: 'prerequisite' },
        { from: 't1', to: 't3', type: 'prerequisite' },
        { from: 't2', to: 't3', type: 'extends' },
        { from: 't3', to: 't4', type: 'prerequisite' },
      ],
    };
    const m = computeGraphCentrality(graph);
    let sum = 0;
    for (const c of m.values()) sum += c.pageRank;
    assert.ok(Math.abs(sum - 1.0) < 1e-6, `pageRank sum should be ~1.0, got ${sum}`);
  });

  it('should give higher pageRank to a node pointed to by multiple nodes', () => {
    // Hub: t3 is pointed to by t1, t2, t4 → high pageRank
    // Leaves: t1, t2, t4 point outward only
    const graph = {
      nodes: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
      edges: [
        { from: 't1', to: 't3', type: 'references' },
        { from: 't2', to: 't3', type: 'references' },
        { from: 't4', to: 't3', type: 'references' },
      ],
    };
    const m = computeGraphCentrality(graph);
    const hubPR = m.get('t3').pageRank;
    const leafPR = m.get('t1').pageRank;
    assert.ok(hubPR > leafPR, `hub (${hubPR}) should outrank leaf (${leafPR})`);
    assert.strictEqual(m.get('t3').inDegree, 3);
  });

  it('should handle dangling nodes (no outbound edges) without NaN', () => {
    // t2 is a dangling node (no outbound); t1 points to t2.
    const graph = {
      nodes: [{ id: 't1' }, { id: 't2' }],
      edges: [{ from: 't1', to: 't2', type: 'prerequisite' }],
    };
    const m = computeGraphCentrality(graph);
    for (const c of m.values()) {
      assert.ok(Number.isFinite(c.pageRank), 'pageRank must be finite');
      assert.ok(c.pageRank > 0, 'pageRank must be positive');
    }
  });

  it('should ignore edges referencing unknown nodes', () => {
    const graph = {
      nodes: [{ id: 't1' }],
      edges: [
        { from: 't1', to: 'ghost', type: 'prerequisite' },
        { from: 'ghost', to: 't1', type: 'prerequisite' },
      ],
    };
    const m = computeGraphCentrality(graph);
    const c = m.get('t1');
    assert.strictEqual(c.inDegree, 0);
    assert.strictEqual(c.outDegree, 0);
    assert.ok(Number.isFinite(c.pageRank));
  });

  it('buildEnhancedKnowledgeGraph should include centrality field', () => {
    const topics = [
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, prerequisites: [], relatedTopics: [] },
      { id: 't2', title: 'B', level: 1, parentId: null, order: 1, prerequisites: ['t1'], relatedTopics: [] },
    ];
    const graph = buildKnowledgeGraph(makePlan(topics));
    // buildKnowledgeGraph itself does not include centrality (backward compat)
    assert.ok(!graph.centrality);
    // computeGraphCentrality can be applied to any {nodes, edges} graph
    const centrality = computeGraphCentrality(graph);
    assert.ok(centrality.get('t1'));
    assert.ok(centrality.get('t2'));
    assert.strictEqual(centrality.get('t1').outDegree, 1);
    assert.strictEqual(centrality.get('t2').inDegree, 1);
  });

  it('should serialize enhanced graph centrality as node-keyed JSON data', () => {
    const plan = makePlan([
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, prerequisites: [], relatedTopics: [] },
      { id: 't2', title: 'B', level: 1, parentId: null, order: 1, prerequisites: ['t1'], relatedTopics: [] },
    ]);
    const graph = buildEnhancedKnowledgeGraph(plan, {
      includeDetailExtraction: false,
      includeTransitive: false,
      includeInherited: false,
      includeSiblingRelated: false,
      includeSequential: false,
      includeKeywordCrossPhase: false,
    });
    const serialized = JSON.parse(JSON.stringify(graph));

    assert.ok(serialized.centrality.t1);
    assert.ok(serialized.centrality.t2);
    assert.equal(serialized.centrality.t1.outDegree, 1);
    assert.equal(serialized.centrality.t2.inDegree, 1);
  });
});

// ═══════════════════════════════════════════════════════════
// buildInferredEdges — edge inference from detail text
// ═══════════════════════════════════════════════════════════

describe('buildInferredEdges', () => {
  it('should return empty for topics without detail text', () => {
    const topics = [
      { id: 't1', title: 'A', level: 1, parentId: null, order: 0, detail: null, prerequisites: [], relatedTopics: [] },
      { id: 't2', title: 'B', level: 1, parentId: null, order: 1, detail: null, prerequisites: [], relatedTopics: [] },
    ];
    const edges = buildInferredEdges(makePlan(topics));
    assert.ok(Array.isArray(edges));
    const detailEdges = edges.filter(e => e.source === 'detail');
    assert.strictEqual(detailEdges.length, 0);
  });

  it('should not crash with detail text that has relation section', () => {
    const topics = [
      { id: 't1', title: 'Socket基础', level: 1, parentId: null, order: 0,
        detail: '## 与相关知识点的联系\n- **epoll**: 在Socket基础之上构建高性能IO模型',
        prerequisites: [], relatedTopics: [] },
      { id: 't2', title: 'epoll', level: 1, parentId: null, order: 1,
        detail: '基于Socket的文件描述符操作', prerequisites: [], relatedTopics: [] },
    ];
    const edges = buildInferredEdges(makePlan(topics));
    // Should not throw; edges may or may not be found
    assert.ok(Array.isArray(edges));
  });
});

describe('extractRelationsFromDetail', () => {
  it('keeps the current topic as the prerequisite when the description says this section is foundational', () => {
    const topics = [
      { id: 'threads', title: '多线程编程' },
      { id: 'reactor', title: '主从 Reactor 架构' },
    ];
    const detail = [
      '## 与相关知识点的联系',
      '- **主从 Reactor 架构**：多线程最终会演进为事件驱动的线程池模型，本节是理解该架构的前置。',
    ].join('\n');

    const edges = extractRelationsFromDetail(detail, topics, 'threads');

    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].type, 'prerequisite');
    assert.strictEqual(edges[0].from, 'threads');
    assert.strictEqual(edges[0].to, 'reactor');
  });
});

// ═══════════════════════════════════════════════════════════
// parseExercisesFromDetail — exercise extraction from Markdown
// ═══════════════════════════════════════════════════════════

describe('parseExercisesFromDetail', () => {
  const sampleDetail = [
    '## 核心概念',
    '',
    '内容介绍...',
    '',
    '## 📝 练习题',
    '',
    '> **练习题 1**（选择题）以下哪个是正确的？',
    '> - A. 选项A',
    '> - B. 选项B',
    '> - C. 选项C',
    '> > 正确答案：A',
    '> > 解析：因为A是正确的',
    '> > 关联概念：变量作用域',
    '',
    '> **练习题 2**（简答题）请解释什么是回调？',
    '> > 参考答案：回调是一种...',
    '> > 解析：回调机制...',
    '',
    '## 总结',
  ].join('\n');

  it('should parse exercises from detail with standard format', () => {
    const exercises = parseExercisesFromDetail(sampleDetail);
    assert.strictEqual(exercises.length, 2);
    assert.strictEqual(exercises[0].type, 'choice');
    assert.strictEqual(exercises[0].index, 1);
    assert.strictEqual(exercises[0].options.length, 3);
    assert.strictEqual(exercises[0].answer, 'A');
    assert.strictEqual(exercises[0].conceptTag, '变量作用域');
    assert.strictEqual(exercises[1].type, 'open');
    assert.strictEqual(exercises[1].index, 2);
  });

  it('should return empty array for null/undefined/empty detail', () => {
    assert.deepStrictEqual(parseExercisesFromDetail(null), []);
    assert.deepStrictEqual(parseExercisesFromDetail(undefined), []);
    assert.deepStrictEqual(parseExercisesFromDetail(''), []);
  });

  it('should return empty array for detail without exercise section', () => {
    assert.deepStrictEqual(parseExercisesFromDetail('## 只有内容\n没有练习题'), []);
  });

  it('should handle plain markdown heading for exercise section', () => {
    const detail = '## 练习题\n> **练习题 1**（选择题）测试？\n> - A. 是\n> > 正确答案：A\n> > 解析：测试';
    const exercises = parseExercisesFromDetail(detail);
    assert.strictEqual(exercises.length, 1);
  });

  it('should parse choice exercises with 4 options', () => {
    const detail = [
      '## 📝 练习题',
      '> **练习题 1**（选择题）以下关于TCP正确的是？',
      '> - A. 面向连接',
      '> - B. 无连接',
      '> - C. 不可靠',
      '> - D. 以上都不对',
      '> > 正确答案：A',
      '> > 解析：TCP是面向连接的协议',
      '> > 关联概念：TCP协议',
    ].join('\n');
    const exercises = parseExercisesFromDetail(detail);
    assert.strictEqual(exercises.length, 1);
    assert.strictEqual(exercises[0].type, 'choice');
    assert.strictEqual(exercises[0].options.length, 4);
    assert.strictEqual(exercises[0].answer, 'A');
  });
});

// ═══════════════════════════════════════════════════════════
// extractWeakPoints — weak point extraction from AI JSON
// ═══════════════════════════════════════════════════════════

describe('extractWeakPoints', () => {
  it('should extract concept names from valid JSON', () => {
    const json = JSON.stringify({
      weakPoints: [
        { concept: '指针运算', confidence: 'high', evidence: '答错了题' },
        { concept: '内存管理', confidence: 'medium', evidence: '追问较多' },
      ]
    });
    const result = extractWeakPoints(json);
    assert.deepStrictEqual(result, ['指针运算', '内存管理']);
  });

  it('should return empty array for invalid JSON', () => {
    assert.deepStrictEqual(extractWeakPoints('not json'), []);
    assert.deepStrictEqual(extractWeakPoints('{broken'), []);
  });

  it('should return empty array for JSON without weakPoints field', () => {
    assert.deepStrictEqual(extractWeakPoints('{"other": "data"}'), []);
  });

  it('should return empty array for non-array weakPoints', () => {
    assert.deepStrictEqual(extractWeakPoints('{"weakPoints": "string"}'), []);
  });

  it('should skip items without concept field', () => {
    const json = JSON.stringify({
      weakPoints: [
        { concept: '有效点', confidence: 'high' },
        { confidence: 'medium' },
        { concept: '另一个点', confidence: 'low' },
      ]
    });
    assert.deepStrictEqual(extractWeakPoints(json), ['有效点', '另一个点']);
  });
});

// ═══════════════════════════════════════════════════════════
// getTopicsNeedingReview — review recommendation logic
// ═══════════════════════════════════════════════════════════

describe('getTopicsNeedingReview', () => {
  it('should return topics with weak points', () => {
    const topics = [
      { id: 't1', title: 'A', done: true, weakPoints: ['指针'], exercises: [], detail: 'abc' },
      { id: 't2', title: 'B', done: true, weakPoints: [], exercises: [], detail: 'abc' },
      { id: 't3', title: 'C', done: false, weakPoints: [], exercises: [], detail: 'abc' },
    ];
    const plan = makePlan(topics);
    const needs = getTopicsNeedingReview(plan);
    assert.strictEqual(needs.length, 1);
    assert.strictEqual(needs[0].title, 'A');
  });

  it('should return topics with exercise errors', () => {
    const topics = [
      { id: 't1', title: 'A', done: true, weakPoints: [],
        exercises: [{ correct: true }, { correct: false }], detail: 'abc' },
      { id: 't2', title: 'B', done: true, weakPoints: [],
        exercises: [{ correct: true }], detail: 'abc' },
    ];
    const plan = makePlan(topics);
    const needs = getTopicsNeedingReview(plan);
    assert.strictEqual(needs.length, 1);
    assert.strictEqual(needs[0].title, 'A');
    assert.strictEqual(needs[0].hasExerciseErrors, true);
    assert.strictEqual(needs[0].lastErrorCount, 1);
  });

  it('should return empty for all-correct topics with no weak points', () => {
    const topics = [
      { id: 't1', title: 'A', done: true, weakPoints: [],
        exercises: [{ correct: true }], detail: 'abc' },
    ];
    const plan = makePlan(topics);
    assert.deepStrictEqual(getTopicsNeedingReview(plan), []);
  });

  it('should skip undoned topics even with weak points', () => {
    const topics = [
      { id: 't1', title: 'A', done: false, weakPoints: ['指针'], exercises: [], detail: null },
    ];
    const plan = makePlan(topics);
    assert.deepStrictEqual(getTopicsNeedingReview(plan), []);
  });
});

// ═══════════════════════════════════════════════════════════
// Import route title cleanup regex (tests the pattern directly)
// ═══════════════════════════════════════════════════════════

describe('import title cleanup pattern', () => {
  const pattern = /^(Sprint\s*\d+\s*[：:]\s*|Sprint\s*\d+\s*[-—–]\s*|第[一二三四五六七八九十\d]+[章节篇部][：:\s]*|Part\s*\d+\s*[：:]\s*|Phase\s*\d+\s*[：:]\s*|Chapter\s*\d+\s*[：:]\s*)/i;
  const clean = (title) => title.replace(pattern, '').trim();

  it('should strip "Sprint 1: " prefix', () => {
    assert.strictEqual(clean('Sprint 1: 基础框架与协议解析'), '基础框架与协议解析');
  });

  it('should strip "Sprint 1：" with Chinese colon', () => {
    assert.strictEqual(clean('Sprint 1：基础框架'), '基础框架');
  });

  it('should strip "Sprint1:" without space', () => {
    assert.strictEqual(clean('Sprint1:基础'), '基础');
  });

  it('should strip "第1章 " prefix', () => {
    assert.strictEqual(clean('第1章 Socket编程'), 'Socket编程');
  });

  it('should strip "第一章：" prefix', () => {
    assert.strictEqual(clean('第一章：基础入门'), '基础入门');
  });

  it('should strip "Part 1: " prefix', () => {
    assert.strictEqual(clean('Part 1: Introduction'), 'Introduction');
  });

  it('should strip "Phase 2: " prefix', () => {
    assert.strictEqual(clean('Phase 2: 网络编程核心'), '网络编程核心');
  });

  it('should strip "Chapter 3: " prefix', () => {
    assert.strictEqual(clean('Chapter 3: Advanced'), 'Advanced');
  });

  it('should not affect titles without prefix', () => {
    assert.strictEqual(clean('Socket编程基础'), 'Socket编程基础');
    assert.strictEqual(clean('HTTP协议解析'), 'HTTP协议解析');
  });

  it('should not strip mid-title text like "章节" or "Sprint"', () => {
    assert.strictEqual(clean('深入理解Sprint机制'), '深入理解Sprint机制');
  });
});
