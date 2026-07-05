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

describe('learn-store', () => {
  let createdPlanIds = [];

  after(() => {
    // Cleanup test plans
    for (const id of createdPlanIds) {
      try { store.deletePlan(id); } catch {}
    }
  });

  describe('createPlan', () => {
    it('should create a plan with correct structure', () => {
      const plan = store.createPlan('测试计划1');
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
    it('should retrieve a created plan', () => {
      const plan = store.createPlan('get-test');
      createdPlanIds.push(plan.id);
      const retrieved = store.getPlan(plan.id);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'get-test');
    });

    it('should return null for non-existent plan', () => {
      const result = store.getPlan('non-existent-id-' + Date.now());
      assert.strictEqual(result, null);
    });
  });

  describe('addTopics', () => {
    it('should add topics to a plan', async () => {
      const plan = store.createPlan('topics-test');
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
      const plan = store.createPlan('dup-test');
      createdPlanIds.push(plan.id);
      await store.addTopics(plan.id, ['唯一主题']);
      const updated = await store.addTopics(plan.id, ['唯一主题', '新主题']);
      assert.strictEqual(updated.topics.length, 2);
    });
  });

  describe('updateTopic', () => {
    it('should update topic fields', async () => {
      const plan = store.createPlan('update-test');
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
      const plan = store.createPlan('time-test');
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
      const plan = store.createPlan('remove-test');
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
      const plan = store.createPlan('history-test');
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
      const plan = store.createPlan('merge-test');
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
      const plan = store.createPlan('no-merge-test');
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
      const plan = store.createPlan('filter-test');
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
    it('should return correct structure for empty plan', () => {
      const plan = store.createPlan('profile-test');
      createdPlanIds.push(plan.id);
      const profile = store.buildLearningProfile(plan);
      assert.strictEqual(profile.planName, 'profile-test');
      assert.strictEqual(profile.totalTopics, 0);
      assert.strictEqual(profile.completionRate, '0%');
      assert.strictEqual(profile.questionsAsked, 0);
    });

    it('should calculate completion rate correctly', async () => {
      const plan = store.createPlan('completion-test');
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
      const plan = store.createPlan('qa-count-test');
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

  describe('deletePlan', () => {
    it('should delete a plan', () => {
      const plan = store.createPlan('delete-me');
      createdPlanIds.push(plan.id);
      store.deletePlan(plan.id);
      const result = store.getPlan(plan.id);
      assert.strictEqual(result, null);
    });
  });
});
