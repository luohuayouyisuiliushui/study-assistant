import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateHTML } from '../engine/html-exporter.js';
import * as store from '../engine/learn-store.js';
import exportRouter from '../routes/export.js';

const MOCK_PLAN = {
  id: 'plan-1',
  name: '数据结构与算法',
  topics: [
    {
      id: 'topic-1',
      title: '二分查找',
      difficulty: '中等',
      done: true,
      timeSpent: 1800,
      detail: `## 基本思想

二分查找（Binary Search）是一种在 **有序数组** 中查找目标值的高效算法。

### 算法步骤

1. 初始化左右指针：\`left = 0\`, \`right = n - 1\`
2. 循环直到 left > right

\`\`\`js
function binarySearch(arr, target) {
  let left = 0, right = arr.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) left = mid + 1;
    else right = mid - 1;
  }
  return -1;
}
\`\`\`

### 复杂度分析

| 指标 | 值 |
|------|-----|
| 时间复杂度 | $O(\\log n)$ |
| 空间复杂度 | $O(1)$ |

> 二分查找的前提是数组必须有序。

### 流程图

\`\`\`mermaid
flowchart TD
  A[开始] --> B[结束]
\`\`\`

## 📝 练习题

> **练习题 1**（选择题）：二分查找的时间复杂度是多少？
> - A. O(n)
> - B. O(log n)
> - C. O(n log n)
> - D. O(n^2)
> > 正确答案：B
> > 解析：每次查找将搜索范围缩小一半，因此复杂度为 O(log n)。
> > 关联概念：时间复杂度

> **练习题 2**（开放题）：简述二分查找的适用条件。
> > 参考答案：数组必须是有序的，并且支持随机访问（如数组）。
> > 解析：这是二分查找能够正确工作的前提条件。
`,
      exercises: [
        { id: 'ex1', index: 1, type: 'choice', question: '二分查找的时间复杂度是多少？', options: ['A. O(n)', 'B. O(log n)', 'C. O(n log n)', 'D. O(n^2)'], answer: 'B', explanation: '每次查找将搜索范围缩小一半，因此复杂度为 O(log n)。', conceptTag: '时间复杂度', userAnswer: null, correct: null },
        { id: 'ex2', index: 2, type: 'open', question: '简述二分查找的适用条件。', options: [], answer: '数组必须是有序的，并且支持随机访问（如数组）。', explanation: '这是二分查找能够正确工作的前提条件。', conceptTag: '', userAnswer: null, correct: null },
      ],
    },
  ],
  history: [
    { role: 'user', content: '二分查找为什么高效？', topicId: 'topic-1', timestamp: Date.now() - 3600000 },
    { role: 'ai', content: '因为每次查找都将搜索范围缩小一半，所以时间复杂度只有 O(log n)。', topicId: 'topic-1', timestamp: Date.now() - 3599000 },
  ],
};

let storedPlanId;
let storedTopicId;

before(async () => {
  const plan = await store.createPlan('HTML 导出路由测试', { testOnly: true });
  storedPlanId = plan.id;
  const planWithTopic = await store.addTopics(storedPlanId, ['二分查找']);
  storedTopicId = planWithTopic.topics[0].id;

  await store.updateTopic(storedPlanId, storedTopicId, {
    detail: MOCK_PLAN.topics[0].detail,
    exercises: MOCK_PLAN.topics[0].exercises,
  });
  await store.addHistory(storedPlanId, storedTopicId, 'user', '二分查找为什么高效？');
  await store.addHistory(storedPlanId, storedTopicId, 'ai', '因为每次查找都将搜索范围缩小一半，所以时间复杂度只有 O(log n)。');
});

after(async () => {
  if (storedPlanId) {
    await store.permanentlyDeletePlan(storedPlanId);
    store.clearFlag(storedPlanId);
  }
});

describe('HTML Exporter', () => {
  it('should return empty string for missing topic', () => {
    const result = generateHTML(MOCK_PLAN, 'nonexistent');
    assert.equal(result, '');
  });

  it('should return empty string for plan with no detail', () => {
    const plan = {
      ...MOCK_PLAN,
      topics: [{ id: 't2', title: 'Empty', detail: null }],
    };
    const result = generateHTML(plan, 't2');
    assert.equal(result, '');
  });

  it('should generate HTML with title in document head', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('<title>二分查找'));
    assert.ok(html.includes('学习笔记'));
  });

  it('should include plan name in metadata', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('数据结构与算法'));
  });

  it('should render code block with syntax highlighting', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('binarySearch'));
    assert.ok(html.includes('class="lang-js"'));
    assert.ok(html.includes('copy-btn'));
  });

  it('should preserve Mermaid diagram Markdown', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('class="lang-mermaid"'));
    assert.ok(html.includes('flowchart TD'));
    assert.ok(html.includes('A[开始] --&gt; B[结束]'));
  });

  it('should render math formula $O(\\log n)$', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('class="mi"'));
  });

  it('should render markdown headings', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('<h2 id="基本思想">'));
    assert.ok(html.includes('<h3 id="算法步骤">'));
    assert.ok(html.includes('<h3 id="复杂度分析">'));
  });

  it('should render collapsible exercises with details/summary', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('<details class="ei">'));
    assert.ok(html.includes('<summary>1. 二分查找的时间复杂度是多少？'));
    assert.ok(html.includes('<summary>2. 简述二分查找的适用条件。'));
    assert.ok(html.includes('<strong>答案：</strong>'));
    assert.ok(html.includes('<strong>解析：</strong>'));
  });

  it('should render Q&A history', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('二分查找为什么高效？'));
    assert.ok(html.includes('因为每次查找都将搜索范围缩小一半'));
  });

  it('should include dark mode toggle button', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('toggleDarkMode()'));
  });

  it('should include TOC sidebar', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('tocSidebar') || html.includes('class="toc"'));
    assert.ok(html.includes('#基本思想'));
    assert.ok(html.includes('#算法步骤'));
    assert.ok(html.includes('#复杂度分析'));
  });

  it('should include mobile hamburger toggle', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('toc-toggle'));
  });

  it('should include copy code button script', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('copyCode(this)'));
  });

  it('should render blockquote correctly', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('<blockquote>'));
    assert.ok(html.includes('二分查找的前提是数组必须有序'));
  });

  it('should render table markup', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('时间复杂度'));
    assert.ok(html.includes('空间复杂度'));
  });

  it('should include responsive / dark mode / print CSS media queries', () => {
    const html = generateHTML(MOCK_PLAN, 'topic-1');
    assert.ok(html.includes('prefers-color-scheme'));
    assert.ok(html.includes('max-width:768px'));
    assert.ok(html.includes('@media print'));
  });
});

describe('HTML Exporter - POST /api/export/html endpoint', () => {
  it('should return 400 when topicId missing', async () => {
    const res = await withServer(function(base) {
      return fetch(base + '/api/export/html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.ok(data.error);
  });

  it('should return 400 when plan missing', async () => {
    const res = await withServer(function(base) {
      return fetch(base + '/api/export/html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicId: 'topic-1' }),
      });
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.ok(data.error);
  });

  it('should return HTML with correct content type', async () => {
    const res = await withServer(function(base) {
      return fetch(base + '/api/export/html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: MOCK_PLAN, topicId: 'topic-1' }),
      });
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('二分查找'));
    assert.ok(html.includes('class="lang-js"'));
    assert.ok(html.includes('class="mi"'));
    assert.ok(html.includes('<details class="ei">'));
    assert.ok(html.includes('toggleDarkMode()'));
  });
});

describe('HTML Exporter - downloaded routes', () => {
  it('serves Q&A and Markdown diagram content from canonical and compatibility URLs', async () => {
    const responses = await withServer(base => Promise.all([
      fetch(`${base}/api/export/plans/${storedPlanId}/export/html/${storedTopicId}`),
      fetch(`${base}/api/learn/plans/${storedPlanId}/export/html/${storedTopicId}`),
    ]));

    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.match(response.headers.get('content-disposition'), /^attachment;/);

      const html = await response.text();
      assert.ok(html.includes('二分查找为什么高效？'));
      assert.ok(html.includes('因为每次查找都将搜索范围缩小一半'));
      assert.ok(html.includes('class="lang-mermaid"'));
      assert.ok(html.includes('flowchart TD'));
      assert.ok(html.includes('A[开始] --&gt; B[结束]'));
    }
  });
});

function withServer(fn) {
  return new Promise(function(resolve, reject) {
    var app = express();
    app.use(express.json());
    app.use('/api/export', exportRouter);
    app.use('/api/learn', exportRouter);
    var server = app.listen(0, function() {
      var port = server.address().port;
      var base = 'http://localhost:' + port;
      fn(base).then(function(result) {
        server.close(function() { resolve(result); });
      }).catch(function(err) {
        server.close(function() { reject(err); });
      });
    });
  });
}
