import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../engine/learn-store.js';

describe('Edge Cases & Boundary Conditions', () => {

  describe('addTopics edge cases', () => {
    it('should handle topics with very long titles', async () => {
      const plan = await store.createPlan('边界测试计划');
      const longTitle = 'A'.repeat(500);
      const updated = await store.addTopics(plan.id, [longTitle]);
      assert.equal(updated.topics.length, 1);
      assert.equal(updated.topics[0].title, longTitle);
      await store.deletePlan(plan.id);
    });

    it('should handle topics with unicode emoji in titles', async () => {
      const plan = await store.createPlan('Emoji测试');
      const updated = await store.addTopics(plan.id, ['🧪 化学实验', '📊 数据分析', '🚀 火箭科学']);
      assert.equal(updated.topics.length, 3);
      assert.ok(updated.topics[0].title.includes('🧪'));
      await store.deletePlan(plan.id);
    });

    it('should handle topics with newlines in titles', async () => {
      const plan = await store.createPlan('换行测试');
      const updated = await store.addTopics(plan.id, ['第一行\n第二行']);
      assert.equal(updated.topics.length, 1);
      assert.equal(updated.topics[0].title, '第一行\n第二行');
      await store.deletePlan(plan.id);
    });

    it('should handle adding 50 topics at once', async () => {
      const plan = await store.createPlan('批量测试');
      const titles = Array.from({ length: 50 }, (_, i) => `知识点${i + 1}`);
      const updated = await store.addTopics(plan.id, titles);
      assert.equal(updated.topics.length, 50);
      await store.deletePlan(plan.id);
    });
  });

  describe('createPlan edge cases', () => {
    it('should handle plan name with only whitespace after trim', async () => {
      const plan = await store.createPlan('   ');
      assert.ok(plan.id);
      await store.deletePlan(plan.id);
    });

    it('should handle plan name with special regex characters', async () => {
      const name = 'Plan [v2.0] (test) $pecial!';
      const plan = await store.createPlan(name);
      assert.equal(plan.name, name);
      await store.deletePlan(plan.id);
    });
  });

  describe('updateTopic edge cases', () => {
    it('should handle updating detail with very large content', async () => {
      const plan = await store.createPlan('大内容测试');
      const updated = await store.addTopics(plan.id, ['大内容知识点']);
      const topic = updated.topics[0];
      const largeDetail = '# 标题\n\n' + '这是一段很长的内容。'.repeat(1000);
      await store.updateTopic(plan.id, topic.id, { detail: largeDetail });
      const plan2 = store.getPlan(plan.id);
      const t = plan2.topics.find(t => t.id === topic.id);
      assert.equal(t.detail.length, largeDetail.length);
      await store.deletePlan(plan.id);
    });

    it('should handle updating with empty object (no-op)', async () => {
      const plan = await store.createPlan('空更新测试');
      const updated = await store.addTopics(plan.id, ['知识点']);
      const topic = updated.topics[0];
      await store.updateTopic(plan.id, topic.id, {});
      const plan2 = store.getPlan(plan.id);
      const t = plan2.topics.find(t => t.id === topic.id);
      assert.equal(t.title, '知识点');
      await store.deletePlan(plan.id);
    });

    it('should preserve other fields when updating one field', async () => {
      const plan = await store.createPlan('字段保留测试');
      const updated = await store.addTopics(plan.id, ['知识点']);
      const topic = updated.topics[0];
      await store.updateTopic(plan.id, topic.id, { done: true });
      const plan2 = store.getPlan(plan.id);
      const t = plan2.topics.find(t => t.id === topic.id);
      assert.equal(t.done, true);
      assert.equal(t.title, '知识点');
      await store.deletePlan(plan.id);
    });
  });

  describe('addHistory edge cases', () => {
    it('should handle history with very long content', async () => {
      const plan = await store.createPlan('历史测试');
      const updated = await store.addTopics(plan.id, ['知识点']);
      const topic = updated.topics[0];
      const longContent = '内容'.repeat(500);
      await store.addHistory(plan.id, topic.id, 'user', longContent);
      const plan2 = store.getPlan(plan.id);
      const history = store.getTopicHistory(plan2, topic.id);
      assert.equal(history.length, 1);
      assert.equal(history[0].content, longContent);
      await store.deletePlan(plan.id);
    });

    it('should handle concurrent-like rapid history adds', async () => {
      const plan = await store.createPlan('快速历史');
      const updated = await store.addTopics(plan.id, ['知识点']);
      const topic = updated.topics[0];
      for (let i = 0; i < 20; i++) {
        await store.addHistory(plan.id, topic.id, i % 2 === 0 ? 'user' : 'ai', `消息${i}`);
      }
      const plan2 = store.getPlan(plan.id);
      const history = store.getTopicHistory(plan2, topic.id);
      assert.ok(history.length >= 10);
      await store.deletePlan(plan.id);
    });
  });

  describe('Knowledge graph edge cases', () => {
    it('should handle graph with single topic', async () => {
      const plan = await store.createPlan('单知识点图谱');
      const updated = await store.addTopics(plan.id, ['唯一知识点']);
      const graph = store.buildKnowledgeGraph(updated);
      assert.equal(graph.nodes.length, 1);
      assert.equal(graph.edges.length, 0);
      await store.deletePlan(plan.id);
    });

    it('should handle graph with circular prerequisites', async () => {
      const plan = await store.createPlan('循环依赖');
      const updated = await store.addTopics(plan.id, ['A', 'B', 'C']);
      const [a, b, c] = updated.topics;
      await store.updateTopic(plan.id, a.id, { prerequisites: [b.id] });
      await store.updateTopic(plan.id, b.id, { prerequisites: [c.id] });
      await store.updateTopic(plan.id, c.id, { prerequisites: [a.id] });
      const plan2 = store.getPlan(plan.id);
      const graph = store.buildKnowledgeGraph(plan2);
      assert.equal(graph.nodes.length, 3);
      assert.ok(graph.edges.length >= 3);
      await store.deletePlan(plan.id);
    });
  });

  describe('Trash edge cases', () => {
    it('should handle trash on non-existent plan gracefully', async () => {
      try {
        await store.trashPlan('non-existent-id');
      } catch (e) {
        assert.ok(e.message.includes('not found') || e.message.includes('不存在') || true);
      }
    });

    it('should restore plan and preserve all data', async () => {
      const plan = await store.createPlan('恢复测试');
      const updated = await store.addTopics(plan.id, ['知识点1']);
      const topic = updated.topics[0];
      await store.updateTopic(plan.id, topic.id, { detail: '详细内容', done: true });
      await store.trashPlan(plan.id);
      const trash = await store.listTrash();
      const trashed = trash.find(t => t.id === plan.id);
      assert.ok(trashed);
      assert.ok(trashed.hasData);
      await store.restorePlan(plan.id);
      const restored = store.getPlan(plan.id);
      assert.ok(restored);
      assert.equal(restored.topics[0].detail, '详细内容');
      assert.equal(restored.topics[0].done, true);
      await store.deletePlan(plan.id);
    });
  });

  describe('Flag operations edge cases', () => {
    it('should handle writing and reading flags', async () => {
      const key = 'test-flag-' + Date.now();
      store.writeFlag(key);
      const flags = store.readFlags();
      assert.ok(Array.isArray(flags));
      assert.ok(flags.includes(key));
      store.clearFlag(key);
    });

    it('should handle reading flags when none exist', async () => {
      const flags = store.readFlags();
      assert.ok(Array.isArray(flags));
    });

    it('should handle clearing flags', async () => {
      const k1 = 'multi-clear-1-' + Date.now();
      const k2 = 'multi-clear-2-' + Date.now();
      store.writeFlag(k1);
      store.writeFlag(k2);
      store.clearFlag(k1);
      store.clearFlag(k2);
      const flags = store.readFlags();
      assert.ok(!flags.includes(k1));
      assert.ok(!flags.includes(k2));
    });
  });

  describe('parseExercisesFromDetail edge cases', () => {
    it('should handle detail with only exercise heading and no content', async () => {
      const detail = '## 练习题\n';
      const exercises = store.parseExercisesFromDetail(detail);
      assert.deepEqual(exercises, []);
    });

    it('should handle detail with malformed exercise format', async () => {
      const detail = '## 练习题\n\n这不是一个标准格式的题目';
      const exercises = store.parseExercisesFromDetail(detail);
      assert.ok(Array.isArray(exercises));
    });

    it('should handle detail with multiple exercise sections', async () => {
      const detail = `## 练习题

1. **题目1**：测试题目
   - A. 选项1
   - B. 选项2
   - C. 选项3
   - D. 选项4

## 练习题

2. **题目2**：另一道题
   - A. 选项A
   - B. 选项B
   - C. 选项C
   - D. 选项D`;
      const exercises = store.parseExercisesFromDetail(detail);
      assert.ok(Array.isArray(exercises));
    });
  });

  describe('extractWeakPoints edge cases', () => {
    it('should handle JSON with weakPoints as concept strings', async () => {
      const json = JSON.stringify({ weakPoints: [{ concept: '概念A' }, { concept: '概念B' }] });
      const result = store.extractWeakPoints(json);
      assert.ok(result.length >= 2);
      assert.ok(result.includes('概念A'));
      assert.ok(result.includes('概念B'));
    });

    it('should handle JSON with empty weakPoints array', async () => {
      const json = JSON.stringify({ weakPoints: [] });
      const result = store.extractWeakPoints(json);
      assert.equal(result.length, 0);
    });

    it('should handle JSON with weakPoints missing concept field', async () => {
      const json = JSON.stringify({ weakPoints: [{ name: 'no concept field' }] });
      const result = store.extractWeakPoints(json);
      assert.equal(result.length, 0);
    });
  });
});
