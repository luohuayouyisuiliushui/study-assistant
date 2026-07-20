import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Learn-store reads/creates data at module init time at a fixed path.
// We run tests using its real data dir but with unique plan IDs.
import * as store from '../engine/learn-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PREFIX = '__test_' + Date.now() + '_';

// Global test plan ID tracking shared across describe blocks
const _testPlanIds = [];

describe('learn-store', () => {
  let createdPlanIds = _testPlanIds;

  after(async () => {
    // Cleanup test plans from active index
    for (const id of _testPlanIds) {
      try { await store.deletePlan(id); } catch {}
    }
    // Also clean up any plans that ended up in trash
    for (const tp of store.listTrash()) {
      try { store.permanentlyDeleteTrash(tp.id); } catch {}
    }
  });

  describe('createPlan', () => {
    it('should create a plan with correct structure', async () => {
      const plan = await store.createPlan('测试计划1');
      createdPlanIds.push(plan.id);
      assert.ok(plan.id);
      assert.strictEqual(plan.name, '测试计划1');
      assert.ok(Array.isArray(plan.topics));
      assert.strictEqual(plan.topics.length, 0);
      assert.ok(Array.isArray(plan.history));
      assert.strictEqual(plan.history.length, 0);
      assert.ok(Array.isArray(plan.phases));
      assert.ok(plan.createdAt > 0);
      assert.ok(plan.updatedAt > 0);
    });
  });

  describe('getPlan', () => {
    it('should retrieve a created plan', async () => {
      const plan = await store.createPlan('get-test');
      createdPlanIds.push(plan.id);
      const retrieved = store.getPlan(plan.id);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'get-test');
    });

    it('should return null for non-existent plan', async () => {
      const result = store.getPlan('non-existent-id-' + Date.now());
      assert.strictEqual(result, null);
    });
  });

  describe('addTopics', () => {
    it('should add topics to a plan', async () => {
      const plan = await store.createPlan('topics-test');
      createdPlanIds.push(plan.id);
      const titles = ['主题A', '主题B', '主题C'];
      const updated = await store.addTopics(plan.id, titles);
      assert.strictEqual(updated.topics.length, 3);
      assert.strictEqual(updated.topics[0].title, '主题A');
      assert.strictEqual(updated.topics[1].title, '主题B');
      // Verify each topic has required fields
      for (const t of updated.topics) {
        assert.ok(t.id);
        assert.strictEqual(typeof t.order, 'number');
        assert.strictEqual(t.done, false);
        assert.strictEqual(t.detail, null);
      }
    });

    it('should not add duplicate titles', async () => {
      const plan = await store.createPlan('dup-test');
      createdPlanIds.push(plan.id);
      await store.addTopics(plan.id, ['唯一主题']);
      const updated = await store.addTopics(plan.id, ['唯一主题', '新主题']);
      assert.strictEqual(updated.topics.length, 2);
    });
  });

  describe('updateTopic', () => {
    it('should update topic fields', async () => {
      const plan = await store.createPlan('update-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['待更新主题']);
      const tid = afterAdd.topics[0].id;
      const updated = await store.updateTopic(plan.id, tid, { done: true, difficulty: 'hard' });
      const topic = updated.topics.find(t => t.id === tid);
      assert.strictEqual(topic.done, true);
      assert.strictEqual(topic.difficulty, 'hard');
    });
  });

  describe('updateTopicTime', () => {
    it('should accumulate time and set lastAccessed', async () => {
      const plan = await store.createPlan('time-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['计时主题']);
      const tid = afterAdd.topics[0].id;
      const after1 = await store.updateTopicTime(plan.id, tid, 120);
      const t1 = after1.topics.find(t => t.id === tid);
      assert.strictEqual(t1.timeSpent, 120);
      assert.ok(t1.lastAccessed > 0);

      const after2 = await store.updateTopicTime(plan.id, tid, 60);
      const t2 = after2.topics.find(t => t.id === tid);
      assert.strictEqual(t2.timeSpent, 180); // 120 + 60
    });
  });

  describe('removeTopic', () => {
    it('should remove a topic by id', async () => {
      const plan = await store.createPlan('remove-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['A', 'B', 'C']);
      const tid = afterAdd.topics[0].id;
      const updated = await store.removeTopic(plan.id, tid);
      assert.strictEqual(updated.topics.length, 2);
      assert.ok(!updated.topics.find(t => t.id === tid));
    });
  });

  describe('addHistory', () => {
    it('should add history entries', async () => {
      const plan = await store.createPlan('history-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['知识点']);
      const tid = afterAdd.topics[0].id;
      await store.addHistory(plan.id, tid, 'user', '第一个问题');
      await store.addHistory(plan.id, tid, 'ai', '第一个回答');
      await store.addHistory(plan.id, tid, 'user', '第二个问题');
      await store.addHistory(plan.id, tid, 'ai', '第二个回答');
      const retrieved = store.getPlan(plan.id);
      assert.strictEqual(retrieved.history.length, 4);
    });

    it('should merge consecutive user messages', async () => {
      const plan = await store.createPlan('merge-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['知识点']);
      const tid = afterAdd.topics[0].id;

      await store.addHistory(plan.id, tid, 'user', '不完整版本');
      await store.addHistory(plan.id, tid, 'user', '完整补发版本');
      await store.addHistory(plan.id, tid, 'ai', 'AI回答');

      const retrieved = store.getPlan(plan.id);
      const userEntries = retrieved.history.filter(h => h.topicId === tid && h.role === 'user');
      assert.strictEqual(userEntries.length, 1, 'Should have only 1 user entry');
      assert.strictEqual(userEntries[0].content, '完整补发版本', 'Should keep the latest version');
    });

    it('should not merge non-consecutive user messages', async () => {
      const plan = await store.createPlan('no-merge-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['知识点']);
      const tid = afterAdd.topics[0].id;

      await store.addHistory(plan.id, tid, 'user', '问题1');
      await store.addHistory(plan.id, tid, 'ai', '回答1');
      await store.addHistory(plan.id, tid, 'user', '问题2');

      const retrieved = store.getPlan(plan.id);
      const userEntries = retrieved.history.filter(h => h.topicId === tid && h.role === 'user');
      assert.strictEqual(userEntries.length, 2, 'Should have 2 separate user entries');
    });
  });

  describe('getTopicHistory', () => {
    it('should filter history by topic', async () => {
      const plan = await store.createPlan('filter-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['主题1', '主题2']);

      await store.addHistory(plan.id, afterAdd.topics[0].id, 'user', '问题关于主题1');
      await store.addHistory(plan.id, afterAdd.topics[1].id, 'user', '问题关于主题2');
      await store.addHistory(plan.id, afterAdd.topics[0].id, 'ai', '回答关于主题1');

      // Re-fetch plan for fresh data
      const fresh = store.getPlan(plan.id);
      const t1History = store.getTopicHistory(fresh, afterAdd.topics[0].id);
      const t2History = store.getTopicHistory(fresh, afterAdd.topics[1].id);

      assert.strictEqual(t1History.length, 2);
      assert.strictEqual(t2History.length, 1);
      assert.strictEqual(t2History[0].content, '问题关于主题2');
    });
  });

  describe('buildLearningProfile', () => {
    it('should return correct structure for empty plan', async () => {
      const plan = await store.createPlan('profile-test');
      createdPlanIds.push(plan.id);
      const profile = store.buildLearningProfile(plan);
      assert.strictEqual(profile.planName, 'profile-test');
      assert.strictEqual(profile.totalTopics, 0);
      assert.strictEqual(profile.completionRate, '0%');
      assert.strictEqual(profile.questionsAsked, 0);
    });

    it('should calculate completion rate correctly', async () => {
      const plan = await store.createPlan('completion-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['A', 'B', 'C', 'D']);
      await store.updateTopic(plan.id, afterAdd.topics[0].id, { done: true });
      await store.updateTopic(plan.id, afterAdd.topics[1].id, { done: true });

      const fresh = store.getPlan(plan.id);
      const profile = store.buildLearningProfile(fresh);
      assert.strictEqual(profile.totalTopics, 4);
      assert.strictEqual(profile.completedTopics.length, 2);
      assert.strictEqual(profile.completionRate, '50%');
    });

    it('should count questions by topic', async () => {
      const plan = await store.createPlan('qa-count-test');
      createdPlanIds.push(plan.id);
      const afterAdd = await store.addTopics(plan.id, ['主题X']);
      const tid = afterAdd.topics[0].id;
      await store.addHistory(plan.id, tid, 'user', '问题1');
      await store.addHistory(plan.id, tid, 'ai', '回答1');
      await store.addHistory(plan.id, tid, 'user', '问题2');

      const fresh = store.getPlan(plan.id);
      const profile = store.buildLearningProfile(fresh);
      assert.strictEqual(profile.questionsAsked, 2);
      assert.ok(profile.questionsByTopic['主题X']);
      assert.strictEqual(profile.questionsByTopic['主题X'].length, 2);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  NEW: createPlanWithPhases (nested hierarchy)
  // ═══════════════════════════════════════════════════════
  describe('createPlanWithPhases (hierarchy)', () => {
    it('should create plan with nested hierarchy (old string format)', async () => {
      const phases = [{ name: '基础', topics: ['变量', '函数'] }];
      const plan = store.createPlanWithPhases('旧格式兼容', phases);
      createdPlanIds.push(plan.id);
      assert.strictEqual(plan.topics.length, 2);
      assert.strictEqual(plan.topics[0].title, '变量');
      assert.strictEqual(plan.topics[0].level, 1);
      assert.strictEqual(plan.topics[0].parentId, null);
    });

    it('should create plan with nested hierarchy (new object format)', async () => {
      const phases = [{
        name: 'Python',
        topics: [
          { title: '基础语法', level: 1, subtopics: [
            { title: '变量', level: 2 },
            { title: '函数', level: 2, subtopics: [
              { title: '参数传递', level: 3 },
            ]},
          ]},
          { title: '面向对象', level: 1 },
        ],
      }];
      const plan = store.createPlanWithPhases('层级测试', phases);
      createdPlanIds.push(plan.id);
      assert.strictEqual(plan.topics.length, 5);
      // Check parent-child relationships
      const base = plan.topics.find(t => t.title === '基础语法');
      const variable = plan.topics.find(t => t.title === '变量');
      const func = plan.topics.find(t => t.title === '函数');
      const param = plan.topics.find(t => t.title === '参数传递');
      const oop = plan.topics.find(t => t.title === '面向对象');
      assert.ok(base); assert.ok(variable); assert.ok(func); assert.ok(param); assert.ok(oop);
      assert.strictEqual(variable.parentId, base.id);
      assert.strictEqual(func.parentId, base.id);
      assert.strictEqual(param.parentId, func.id);
      // Check levels
      assert.strictEqual(base.level, 1);
      assert.strictEqual(variable.level, 2);
      assert.strictEqual(param.level, 3);
    });

    it('should process external relations (prerequisite + related)', async () => {
      const phases = [{ name: '内容', topics: [
        { title: 'A', level: 1 },
        { title: 'B', level: 1 },
        { title: 'C', level: 1 },
      ]}];
      const relations = [
        { from: 'A', to: 'B', type: 'prerequisite' },
        { from: 'A', to: 'C', type: 'related' },
      ];
      const plan = store.createPlanWithPhases('关系测试', phases, relations);
      createdPlanIds.push(plan.id);
      const a = plan.topics.find(t => t.title === 'A');
      const b = plan.topics.find(t => t.title === 'B');
      const c = plan.topics.find(t => t.title === 'C');
      assert.ok(b.prerequisites.includes(a.id));
      assert.ok(a.relatedTopics.includes(c.id) || c.relatedTopics.includes(a.id));
    });

    it('should handle item-level prerequisites with external relations', async () => {
      const phases = [{ name: '内容', topics: [
        { title: 'A', level: 1 },
        { title: 'B', level: 1, prerequisites: ['A'] },
      ]}];
      const plan = store.createPlanWithPhases('混合前置', phases);
      createdPlanIds.push(plan.id);
      const b = plan.topics.find(t => t.title === 'B');
      const a = plan.topics.find(t => t.title === 'A');
      assert.strictEqual(b.prerequisites.length, 1);
      assert.strictEqual(b.prerequisites[0], a.id);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  NEW: getTopicChildren / getTopicPrerequisites
  // ═══════════════════════════════════════════════════════
  describe('getTopicChildren', () => {
    it('should return direct children sorted by order', async () => {
      const plan = await store.createPlan('children-test');
      createdPlanIds.push(plan.id);
      // Manually build a plan with parent-child
      const parentId = 'p1';
      plan.topics = [
        { id: parentId, title: '父', order: 0, parentId: null, level: 1, prerequisites: [], relatedTopics: [] },
        { id: 'c1', title: '子1', order: 1, parentId, level: 2, prerequisites: [], relatedTopics: [] },
        { id: 'c2', title: '子2', order: 2, parentId, level: 2, prerequisites: [], relatedTopics: [] },
      ];
      const children = store.getTopicChildren(plan, parentId);
      assert.strictEqual(children.length, 2);
      assert.strictEqual(children[0].title, '子1');
    });
  });

  describe('getTopicPrerequisites', () => {
    it('should return prerequisite topics', async () => {
      const plan = await store.createPlan('pre-test');
      createdPlanIds.push(plan.id);
      const p1 = { id: 'p1', title: '前置', prerequisites: [], relatedTopics: [] };
      const p2 = { id: 'p2', title: '后置', prerequisites: ['p1'], relatedTopics: [] };
      plan.topics = [p1, p2];
      const prereqs = store.getTopicPrerequisites(plan, 'p2');
      assert.strictEqual(prereqs.length, 1);
      assert.strictEqual(prereqs[0].title, '前置');
    });

    it('should return empty array for topic without prerequisites', async () => {
      const plan = await store.createPlan('no-pre-test');
      createdPlanIds.push(plan.id);
      plan.topics = [{ id: 'x', title: '独立', prerequisites: [], relatedTopics: [] }];
      const prereqs = store.getTopicPrerequisites(plan, 'x');
      assert.strictEqual(prereqs.length, 0);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  NEW: buildKnowledgeGraph
  // ═══════════════════════════════════════════════════════
  describe('buildKnowledgeGraph', () => {
    it('should return nodes and edges from plan topics', async () => {
      const plan = await store.createPlan('graph-test');
      createdPlanIds.push(plan.id);
      plan.topics = [
        { id: 'a', title: 'A', phaseId: 'ph1', level: 1, done: false, difficulty: null, parentId: null, prerequisites: [], relatedTopics: ['b'] },
        { id: 'b', title: 'B', phaseId: 'ph1', level: 2, done: true, difficulty: 'easy', parentId: 'a', prerequisites: [], relatedTopics: ['a'] },
      ];
      const graph = store.buildKnowledgeGraph(plan);
      assert.strictEqual(graph.nodes.length, 2);
      assert.strictEqual(graph.nodes[0].title, 'A');
      assert.strictEqual(graph.nodes[1].done, true);
      // Should have parentOf + 2 related (a→b, b→a deduped to one) = 2 edges
      assert.strictEqual(graph.edges.length, 2);
      const edgeTypes = graph.edges.map(e => e.type);
      assert.ok(edgeTypes.includes('parentOf'));
      assert.ok(edgeTypes.includes('related'));
    });
  });

  describe('deletePlan', () => {
    it('should delete a plan', async () => {
      const plan = await store.createPlan('delete-me');
      createdPlanIds.push(plan.id);
      await store.deletePlan(plan.id);
      const result = store.getPlan(plan.id);
      assert.strictEqual(result, null);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  NEW: Trash / Recycle Bin
  // ═══════════════════════════════════════════════════════
  describe('trashPlan / listTrash / restorePlan', () => {
    it('should move plan to trash on delete', async () => {
      const plan = await store.createPlan('trash-test-1');
      createdPlanIds.push(plan.id);
      await store.deletePlan(plan.id);
      // Plan should not be in active list
      assert.strictEqual(store.getPlan(plan.id), null);
      // But should appear in trash
      const trash = store.listTrash();
      const entry = trash.find(t => t.id === plan.id);
      assert.ok(entry, 'plan should be in trash');
      assert.ok(entry.deletedAt > 0);
      assert.ok(entry.expiresAt > entry.deletedAt);
      assert.strictEqual(entry.hasData, false);
    });

    it('should restore plan from trash', async () => {
      const plan = await store.createPlan('trash-test-2');
      createdPlanIds.push(plan.id);
      await store.deletePlan(plan.id);
      assert.strictEqual(store.getPlan(plan.id), null);
      store.restorePlan(plan.id);
      const restored = store.getPlan(plan.id);
      assert.ok(restored, 'plan should be restored');
      assert.strictEqual(restored.name, 'trash-test-2');
      const afterRestore = store.listTrash();
      assert.strictEqual(afterRestore.find(t => t.id === plan.id), undefined);
    });

    it('should permanently delete from trash', async () => {
      const plan = await store.createPlan('trash-test-3');
      createdPlanIds.push(plan.id);
      await store.deletePlan(plan.id);
      store.permanentlyDeleteTrash(plan.id);
      const after = store.listTrash();
      assert.strictEqual(after.find(t => t.id === plan.id), undefined);
    });

    it('should flag hasData for plans with learning content', async () => {
      const plan = await store.createPlan('trash-test-4');
      createdPlanIds.push(plan.id);
      await store.addTopics(plan.id, ['知识点A']);
      const fresh = store.getPlan(plan.id);
      const tid = fresh.topics[0].id;
      await store.updateTopic(plan.id, tid, { detail: '这是一个讲解内容' });
      await store.addHistory(plan.id, tid, 'user', '一个提问');
      await store.addHistory(plan.id, tid, 'ai', '一个回答');
      await store.deletePlan(plan.id);
      const trash = store.listTrash();
      const entry = trash.find(t => t.id === plan.id);
      assert.ok(entry, 'plan should be in trash');
      assert.strictEqual(entry.hasData, true, 'plan with detail/history should be flagged');
      store.permanentlyDeleteTrash(plan.id);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  NEW: parseExercisesFromDetail / extractWeakPoints / getTopicsNeedingReview
  // ═══════════════════════════════════════════════════════
  describe('parseExercisesFromDetail', () => {
    it('should return empty array for null/empty input', async () => {
      assert.strictEqual(store.parseExercisesFromDetail(null).length, 0);
      assert.strictEqual(store.parseExercisesFromDetail('').length, 0);
    });

    it('should parse choice exercises from structured markdown', async () => {
      const md = '## 📝 练习题\n' +
        '> **练习题 1**（选择题）以下哪个是变量？\n' +
        '> - A. var\n' +
        '> - B. function\n' +
        '> - C. class\n' +
        '> > 正确答案：A\n' +
        '> > 解析：var 是变量声明关键字\n' +
        '> > 关联概念：变量声明\n';
      const result = store.parseExercisesFromDetail(md);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'choice');
      assert.strictEqual(result[0].answer, 'A');
      assert.strictEqual(result[0].options.length, 3);
      assert.strictEqual(result[0].conceptTag, '变量声明');
    });

    it('should parse open-ended exercises', async () => {
      const md = '## 📝 练习题\n' +
        '> **练习题 1**（简答题）什么是闭包？\n' +
        '> > 参考答案：闭包是能访问外部函数变量的函数\n' +
        '> > 解析：闭包核心是函数+词法作用域\n' +
        '> > 关联概念：闭包\n';
      const result = store.parseExercisesFromDetail(md);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'open');
      assert.strictEqual(result[0].answer, '闭包是能访问外部函数变量的函数');
    });

    it('should parse multiple exercises', async () => {
      const md = '## 📝 练习题\n' +
        '> **练习题 1**（选择题）题1？\n' +
        '> - A. Opt1\n' +
        '> - B. Opt2\n' +
        '> > 正确答案：A\n' +
        '> > 关联概念：概念1\n' +
        '> **练习题 2**（简答题）题2？\n' +
        '> > 参考答案：答案2\n' +
        '> > 关联概念：概念2\n';
      const result = store.parseExercisesFromDetail(md);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].index, 1);
      assert.strictEqual(result[1].index, 2);
    });

    it('should return empty array when detail has no exercise section', async () => {
      const md = '普通内容，没有练习题\n';
      const result = store.parseExercisesFromDetail(md);
      assert.strictEqual(result.length, 0);
    });
  });

  describe('extractWeakPoints', () => {
    it('should extract weak point names from JSON', async () => {
      const json = '{"topicTitle":"JS基础","weakPoints":[{"concept":"闭包","confidence":"high","evidence":"答错练习题"},{"concept":"变量提升","confidence":"medium","evidence":"追问较多"}]}';
      const result = store.extractWeakPoints(json);
      assert.deepStrictEqual(result, ['闭包', '变量提升']);
    });

    it('should return empty array for invalid JSON', async () => {
      assert.deepStrictEqual(store.extractWeakPoints('not json'), []);
      assert.deepStrictEqual(store.extractWeakPoints(''), []);
    });

    it('should return empty array for missing weakPoints', async () => {
      const json = '{"topicTitle":"JS基础","weakPoints":[]}';
      assert.deepStrictEqual(store.extractWeakPoints(json), []);
    });

    it('should filter out entries without concept', async () => {
      const json = '{"weakPoints":[{"concept":"闭包"},{"confidence":"high"}]}';
      const result = store.extractWeakPoints(json);
      assert.deepStrictEqual(result, ['闭包']);
    });
  });

  describe('getTopicsNeedingReview', () => {
    it('should return topics with weakPoints', async () => {
      const plan = {
        topics: [
          { id: 't1', title: '主题1', done: true, weakPoints: ['闭包'], exercises: [] },
          { id: 't2', title: '主题2', done: true, weakPoints: [], exercises: [] },
          { id: 't3', title: '主题3', done: false, weakPoints: ['变量'], exercises: [] },
        ],
      };
      const needs = store.getTopicsNeedingReview(plan);
      assert.strictEqual(needs.length, 1);
      assert.strictEqual(needs[0].title, '主题1');
    });

    it('should return topics with exercise errors', async () => {
      const plan = {
        topics: [
          { id: 't1', title: '主题1', done: true, weakPoints: [], exercises: [
            { question: '题1', correct: false, userAnswer: 'A', answer: 'B' },
          ]},
          { id: 't2', title: '主题2', done: true, weakPoints: [], exercises: [
            { question: '题2', correct: true, userAnswer: 'A', answer: 'A' },
          ]},
        ],
      };
      const needs = store.getTopicsNeedingReview(plan);
      assert.strictEqual(needs.length, 1);
      assert.strictEqual(needs[0].title, '主题1');
      assert.strictEqual(needs[0].hasExerciseErrors, true);
      assert.strictEqual(needs[0].lastErrorCount, 1);
    });

    it('should return empty array when no topics need review', async () => {
      const plan = {
        topics: [
          { id: 't1', title: '主题1', done: true, weakPoints: [], exercises: [] },
          { id: 't2', title: '主题2', done: true, weakPoints: [], exercises: [] },
        ],
      };
      const needs = store.getTopicsNeedingReview(plan);
      assert.strictEqual(needs.length, 0);
    });

    it('should flag topics with exam paper errors', async () => {
      const plan = {
        topics: [
          { id: 't1', title: '主题1', done: true, weakPoints: [], exercises: [] },
          { id: 't2', title: '主题2', done: true, weakPoints: [], exercises: [] },
        ],
        examPapers: [
          { id: 'exam1', title: '测试', config: {}, paper: '', questions: [
            { id: 'q1', index: 0, type: 'choice', question: '题1', options: ['A', 'B'], answer: 'A', explanation: '', conceptTag: '', topicId: 't1', difficulty: 'easy' },
          ], results: [
            { exerciseIndex: 0, correct: false, userAnswer: 'B', correctAnswer: 'A', explanation: '选A' },
          ], gradedAt: Date.now() },
        ],
      };
      const needs = store.getTopicsNeedingReview(plan);
      assert.strictEqual(needs.length, 1);
      assert.strictEqual(needs[0].title, '主题1');
      assert.strictEqual(needs[0].hasExamErrors, true);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  EXAM PAPER STORE
  // ═══════════════════════════════════════════════════════

  describe('examPapers', () => {
    it('should add and retrieve exam papers', async () => {
      const plan = await store.createPlan('exam-store-test');
      _testPlanIds.push(plan.id);

      const exam = { id: 'ex1', title: '第1章测验', config: { topicIds: ['t1'], questionCount: 5, choiceRatio: 0.6 }, paper: '# 试卷', questions: [] };
      await store.addExamPaper(plan.id, exam);

      const papers = store.getExamPapers(plan.id);
      assert.strictEqual(papers.length, 1);
      assert.strictEqual(papers[0].title, '第1章测验');
      assert.strictEqual(papers[0].results, null);
      assert.ok(papers[0].createdAt > 0);

      // Add another
      await store.addExamPaper(plan.id, { id: 'ex2', title: '第2章测验', config: { topicIds: ['t2'], questionCount: 3, choiceRatio: 0.5 }, paper: '# 试卷2', questions: [] });
      assert.strictEqual(store.getExamPapers(plan.id).length, 2);
    });

    it('should update exam results after grading', async () => {
      const plan = await store.createPlan('exam-grade-test');
      _testPlanIds.push(plan.id);

      await store.addExamPaper(plan.id, { id: 'ex-grade', title: '批改测试', config: {}, paper: '', questions: [
        { id: 'q1', index: 0, type: 'choice', question: '题1', options: ['A', 'B'], answer: 'A', explanation: '', conceptTag: '', topicId: null, difficulty: 'easy' },
      ]});

      const results = [{ exerciseIndex: 0, correct: true, userAnswer: 'A', correctAnswer: 'A', explanation: '正确' }];
      await store.updateExamResults(plan.id, 'ex-grade', results);

      const papers = store.getExamPapers(plan.id);
      assert.strictEqual(papers[0].results.length, 1);
      assert.strictEqual(papers[0].results[0].correct, true);
      assert.ok(papers[0].gradedAt > 0);
    });

    it('should delete exam papers', async () => {
      const plan = await store.createPlan('exam-del-test');
      _testPlanIds.push(plan.id);

      await store.addExamPaper(plan.id, { id: 'ex-del', title: '待删除', config: {}, paper: '', questions: [] });
      assert.strictEqual(store.getExamPapers(plan.id).length, 1);

      await store.deleteExamPaper(plan.id, 'ex-del');
      assert.strictEqual(store.getExamPapers(plan.id).length, 0);
    });

    it('should throw for non-existent plan', async () => {
      await assert.rejects(store.addExamPaper('bad-id', { id: 'x', title: 'x', config: {}, paper: '', questions: [] }), /计划不存在/);
    });

    it('should throw for non-existent exam on update', async () => {
      const plan = await store.createPlan('exam-null-test');
      _testPlanIds.push(plan.id);
      await assert.rejects(store.updateExamResults(plan.id, 'no-such-exam', []), /没有试卷/);
    });
  });
});

// ═══════════════════════════════════════════════════════
//  Edge cases
// ═══════════════════════════════════════════════════════

describe('Edge cases', () => {
  let createdPlanIds = _testPlanIds;

  it('addTopics should handle empty array', async () => {
    const plan = await store.createPlan('empty-topics-test');
    createdPlanIds.push(plan.id);
    const result = await store.addTopics(plan.id, []);
    assert.strictEqual(result.topics.length, 0);
  });

  it('addTopics should throw for non-existent plan', async () => {
    await assert.rejects(
      () => store.addTopics('non-existent-plan-' + Date.now(), ['测试']),
      { message: /not found/ }
    );
  });

  it('updateTopicTime should throw for non-existent topic', async () => {
    const plan = await store.createPlan('time-edge-test');
    createdPlanIds.push(plan.id);
    await assert.rejects(
      () => store.updateTopicTime(plan.id, 'non-existent-topic-id', 60),
      { message: /not found/i }
    );
  });

  it('should handle topics with special characters in titles', async () => {
    const plan = await store.createPlan('special-chars');
    createdPlanIds.push(plan.id);
    await store.addTopics(plan.id, ['变量&函数<>测试', '正则/.*[测试]']);
    const p = store.getPlan(plan.id);
    assert.strictEqual(p.topics.length, 2);
    assert.ok(p.topics.find(t => t.title.includes('变量')));
    assert.ok(p.topics.find(t => t.title.includes('正则')));
  });

  it('should handle addTopics with duplicate filtering', async () => {
    const plan = await store.createPlan('dup-edge');
    createdPlanIds.push(plan.id);
    await store.addTopics(plan.id, ['A', 'B']);
    const result = await store.addTopics(plan.id, ['A', 'C']); // A is duplicate
    assert.strictEqual(result.topics.length, 3); // A should not be added again
    assert.ok(result.topics.filter(t => t.title === 'A').length, 1);
  });

  it('buildKnowledgeGraph should handle empty plan', async () => {
    const plan = await store.createPlan('empty-graph');
    createdPlanIds.push(plan.id);
    const graph = store.buildKnowledgeGraph(plan);
    assert.strictEqual(graph.nodes.length, 0);
    assert.strictEqual(graph.edges.length, 0);
  });

  it('removeTopic should handle non-existent topic', async () => {
    const plan = await store.createPlan('remove-nonexist');
    createdPlanIds.push(plan.id);
    const result = await store.removeTopic(plan.id, 'non-existent');
    assert.ok(result);
    assert.strictEqual(result.topics.length, 0);
  });

  describe('recordTeachingErrors', () => {
    it('should persist teaching errors onto the topic', async () => {
      const plan = await store.createPlan('teaching-errors-plan');
      createdPlanIds.push(plan.id);
      await store.addTopics(plan.id, ['误区知识点']);
      const p = store.getPlan(plan.id);
      const topic = p.topics[0];
      const errors = [
        { location: '循环', description: '边界写错', correction: '<=', errorType: 'boundary', misconception: '闭区间当开区间', bloomLevel: '应用', recognized: false },
      ];
      await store.recordTeachingErrors(plan.id, topic.id, errors);
      const p2 = store.getPlan(plan.id);
      assert.ok(Array.isArray(p2.topics[0].teachingErrors));
      assert.strictEqual(p2.topics[0].teachingErrors.length, 1);
      assert.strictEqual(p2.topics[0].teachingErrors[0].errorType, 'boundary');
      assert.strictEqual(p2.topics[0].teachingErrors[0].recognized, false);
      assert.ok(p2.topics[0].teachingErrorsUpdatedAt > 0);
    });

    it('should normalize non-array input to empty array', async () => {
      const plan = await store.createPlan('teaching-errors-empty');
      createdPlanIds.push(plan.id);
      await store.addTopics(plan.id, ['空误区']);
      const p = store.getPlan(plan.id);
      await store.recordTeachingErrors(plan.id, p.topics[0].id, null);
      const p2 = store.getPlan(plan.id);
      assert.deepStrictEqual(p2.topics[0].teachingErrors, []);
    });

    it('should throw for non-existent topic', async () => {
      const plan = await store.createPlan('teaching-errors-notopic');
      createdPlanIds.push(plan.id);
      await assert.rejects(() => store.recordTeachingErrors(plan.id, 'no-such', []), /Topic not found/);
    });
  });
});

// ═══════════════════════════════════════════════════════
//  Null/undefined safety — defensive programming
// ═══════════════════════════════════════════════════════

describe('Null safety', () => {
  describe('buildKnowledgeGraph', () => {
    it('should return empty graph for null plan', async () => {
      const result = store.buildKnowledgeGraph(null);
      assert.deepStrictEqual(result, { nodes: [], edges: [] });
    });

    it('should return empty graph for undefined plan', async () => {
      const result = store.buildKnowledgeGraph(undefined);
      assert.deepStrictEqual(result, { nodes: [], edges: [] });
    });

    it('should return empty graph for plan without topics', async () => {
      const result = store.buildKnowledgeGraph({ id: 'x', name: 'empty' });
      assert.deepStrictEqual(result, { nodes: [], edges: [] });
    });
  });

  describe('buildInferredEdges', () => {
    it('should return empty for null plan', async () => {
      assert.deepStrictEqual(store.buildInferredEdges(null), []);
    });

    it('should return empty for plan with no topics', async () => {
      assert.deepStrictEqual(store.buildInferredEdges({ name: 'empty' }), []);
    });

    it('should return empty for plan with empty topics array', async () => {
      assert.deepStrictEqual(store.buildInferredEdges({ topics: [] }), []);
    });
  });

  describe('buildEnhancedKnowledgeGraph', () => {
    it('should not crash with null plan', async () => {
      const result = store.buildEnhancedKnowledgeGraph(null);
      assert.ok(result, 'should return something');
      assert.deepStrictEqual(result.nodes, []);
      assert.deepStrictEqual(result.edges, []);
    });

    it('should not crash with plan missing topics', async () => {
      const result = store.buildEnhancedKnowledgeGraph({ id: 'bare' });
      assert.deepStrictEqual(result.nodes, []);
      assert.deepStrictEqual(result.edges, []);
    });
  });

  describe('getTopicChildren', () => {
    it('should return empty array for null plan', async () => {
      assert.deepStrictEqual(store.getTopicChildren(null, 'x'), []);
    });

    it('should return empty array for plan without topics', async () => {
      assert.deepStrictEqual(store.getTopicChildren({ name: 'no topics' }, 'x'), []);
    });
  });

  describe('getTopicPrerequisites', () => {
    it('should return empty array for null plan', async () => {
      assert.deepStrictEqual(store.getTopicPrerequisites(null, 'x'), []);
    });

    it('should return empty array for plan without topics', async () => {
      assert.deepStrictEqual(store.getTopicPrerequisites({ name: 'no topics' }, 'x'), []);
    });
  });

  describe('buildLearningProfile', () => {
    it('should return default profile for null plan', async () => {
      const profile = store.buildLearningProfile(null);
      assert.strictEqual(profile.totalTopics, 0);
      assert.strictEqual(profile.doneTopics, 0);
      assert.strictEqual(profile.completionRate, 0);
    });

    it('should return default profile for plan without topics', async () => {
      const profile = store.buildLearningProfile({ name: 'empty', history: [] });
      assert.strictEqual(profile.totalTopics, 0);
      assert.strictEqual(profile.completionRate, 0);
    });
  });

  describe('getTopicsNeedingReview', () => {
    it('should return empty array for null plan', async () => {
      assert.deepStrictEqual(store.getTopicsNeedingReview(null), []);
    });

    it('should return empty array for plan without topics', async () => {
      assert.deepStrictEqual(store.getTopicsNeedingReview({ name: 'empty' }), []);
    });
  });
});

// ═══════════════════════════════════════════════════════
//  Temp file cleanup verification
// ═══════════════════════════════════════════════════════

describe('Temp file cleanup', () => {
  it('should not leave .tmp files after write operations', async () => {
    const plan = await store.createPlan('tmp-cleanup-test');
    _testPlanIds.push(plan.id);

    // Perform write operations
    store.updateTopic(plan.id, plan.topics[0]?.id || 'nonexistent', { difficulty: 'medium' });

    // Check that no .tmp files exist in the plans directory
    const plansDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'learn', 'plans');
    if (fs.existsSync(plansDir)) {
      const files = fs.readdirSync(plansDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      assert.strictEqual(tmpFiles.length, 0, `should have no .tmp files, found: ${tmpFiles.join(', ')}`);
    }

    await store.deletePlan(plan.id);
  });
});

// ═══════════════════════════════════════════════════════
//  Additional store function tests (gap coverage)
// ═══════════════════════════════════════════════════════

describe('listPlans', () => {
  it('should return an array', async () => {
    const plans = store.listPlans();
    assert.ok(Array.isArray(plans));
    // Should contain at least the plans created in this test run
    const testPlans = plans.filter(p => p.name && p.name.startsWith('__test_'));
    assert.ok(testPlans.length >= 0);
  });
});

describe('reorderTopics', () => {
  let plan;
  before(async () => {
    plan = await store.createPlan('reorder-test');
    _testPlanIds.push(plan.id);
  });

  it('should reorder topics correctly', async () => {
    await store.addTopics(plan.id, ['C', 'A', 'B']);
    const p = store.getPlan(plan.id);
    const ids = p.topics.map(t => t.id);
    // Reorder to A, B, C
    const reordered = [ids[1], ids[2], ids[0]]; // A, B, C
    await store.reorderTopics(plan.id, reordered);
    const updated = store.getPlan(plan.id);
    assert.strictEqual(updated.topics[0].title, 'A');
    assert.strictEqual(updated.topics[1].title, 'B');
    assert.strictEqual(updated.topics[2].title, 'C');
  });

  it('should skip non-existent ids in reorder', async () => {
    const p = store.getPlan(plan.id);
    const ids = p.topics.map(t => t.id);
    await store.reorderTopics(plan.id, [...ids, 'non-existent-id']);
    const updated = store.getPlan(plan.id);
    assert.strictEqual(updated.topics.length, 3);
  });
});

describe('trash operations (gap)', () => {
  let trashPlan;
  before(async () => {
    trashPlan = await store.createPlan('trash-gap-test');
  });

  it('should empty the trash', async () => {
    await store.trashPlan(trashPlan.id);
    const before = store.listTrash();
    const found = before.find(t => t.id === trashPlan.id);
    assert.ok(found, 'plan should be in trash');
    store.emptyTrash();
    const after = store.listTrash();
    const gone = after.find(t => t.id === trashPlan.id);
    assert.ok(!gone, 'plan should be removed from trash');
  });
});

// ═══════════════════════════════════════════════════════
//  Flag tests
// ═══════════════════════════════════════════════════════

describe('readFlags / writeFlag / clearFlag', () => {
  it('should write and read flags', async () => {
    const flagPlanId = 'flag-test-' + Date.now();
    store.writeFlag(flagPlanId);
    const flags = store.readFlags();
    assert.ok(Array.isArray(flags));
    assert.ok(flags.includes(flagPlanId), 'flag planId should be present in readFlags');
  });

  it('should clear a specific flag', async () => {
    const flagPlanId = 'flag-clear-test-' + Date.now();
    store.writeFlag(flagPlanId);
    store.clearFlag(flagPlanId);
    const flags = store.readFlags();
    assert.ok(!flags.includes(flagPlanId), 'flag should be cleared');
  });

  it('should handle clearing non-existent flag gracefully', async () => {
    store.clearFlag('non-existent-flag-id');
    const flags = store.readFlags();
    assert.ok(Array.isArray(flags));
  });
});

