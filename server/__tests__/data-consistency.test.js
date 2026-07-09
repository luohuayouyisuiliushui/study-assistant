import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../engine/learn-store.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'learn');
const PLANS_DIR = path.join(DATA_DIR, 'plans');
const INDEX_FILE = path.join(DATA_DIR, 'plans.json');

describe('Data Consistency & Integrity', () => {

  describe('Index-Plan file consistency', () => {
    it('every plan in index should have a corresponding file', () => {
      if (!fs.existsSync(INDEX_FILE)) return;
      const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
      for (const entry of idx) {
        const planFile = path.join(PLANS_DIR, `${entry.id}.json`);
        assert.ok(fs.existsSync(planFile), `Missing plan file for ${entry.id}`);
      }
    });

    it('every plan file should be valid JSON', () => {
      if (!fs.existsSync(PLANS_DIR)) return;
      const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const content = fs.readFileSync(path.join(PLANS_DIR, f), 'utf-8');
        assert.doesNotThrow(() => JSON.parse(content), `Invalid JSON in ${f}`);
      }
    });

    it('plan index should be an array', () => {
      if (!fs.existsSync(INDEX_FILE)) return;
      const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
      assert.ok(Array.isArray(idx));
    });
  });

  describe('Plan data structure integrity', () => {
    it('every plan should have required fields', () => {
      const planEntries = store.listPlans();
      for (const entry of planEntries) {
        assert.ok(entry.id, `Plan entry missing id`);
        assert.ok(entry.name, `Plan ${entry.id} missing name`);
        const plan = store.getPlan(entry.id);
        if (plan) {
          assert.ok(Array.isArray(plan.topics), `Plan ${entry.id} topics not array`);
          assert.ok(typeof plan.createdAt === 'number', `Plan ${entry.id} createdAt not number`);
        }
      }
    });

    it('every topic should have required fields', () => {
      const planEntries = store.listPlans();
      for (const entry of planEntries) {
        const plan = store.getPlan(entry.id);
        if (!plan) continue;
        for (const topic of plan.topics) {
          assert.ok(topic.id, `Topic in plan ${entry.id} missing id`);
          assert.ok(topic.title, `Topic ${topic.id} missing title`);
          if (topic.done !== undefined) {
            assert.ok(typeof topic.done === 'boolean' || topic.done === null, `Topic ${topic.id} done not boolean: ${typeof topic.done}`);
          }
          // history may not exist on old plan formats
          if (topic.history !== undefined) {
            assert.ok(Array.isArray(topic.history), `Topic ${topic.id} history not array`);
          }
        }
      }
    });

    it('topics should have unique IDs within a plan', () => {
      const planEntries = store.listPlans();
      for (const entry of planEntries) {
        const plan = store.getPlan(entry.id);
        if (!plan) continue;
        const ids = plan.topics.map(t => t.id);
        const unique = new Set(ids);
        assert.equal(ids.length, unique.size, `Duplicate topic IDs in plan ${entry.id}`);
      }
    });
  });

  describe('Create-Delete cycle consistency', () => {
    it('create and delete should not leave orphan files', async () => {
      const beforeCount = fs.existsSync(INDEX_FILE)
        ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')).length
        : 0;

      const plan = store.createPlan('一致性测试');
      const updated = await store.addTopics(plan.id, ['测试知识点']);
      await store.updateTopic(plan.id, updated.topics[0].id, { detail: '测试内容', done: true });

      const created = store.getPlan(plan.id);
      assert.ok(created);
      assert.equal(created.topics.length, 1);

      await store.deletePlan(plan.id);

      const afterDelete = store.getPlan(plan.id);
      assert.equal(afterDelete, null);

      const afterCount = fs.existsSync(INDEX_FILE)
        ? JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')).length
        : 0;
      assert.equal(afterCount, beforeCount);
    });

    it('trash and restore should preserve all topic data', async () => {
      const plan = store.createPlan('恢复一致性');
      const updated = await store.addTopics(plan.id, ['恢复知识点']);
      await store.updateTopic(plan.id, updated.topics[0].id, {
        detail: '恢复内容',
        done: true,
        weakPoints: ['弱项1'],
        exercises: [{ question: '测试', answer: 'A' }],
      });

      await store.trashPlan(plan.id);
      const trash = await store.listTrash();
      assert.ok(trash.find(t => t.id === plan.id));

      await store.restorePlan(plan.id);
      const restored = store.getPlan(plan.id);
      assert.ok(restored);
      assert.equal(restored.topics[0].detail, '恢复内容');
      assert.equal(restored.topics[0].done, true);
      assert.deepEqual(restored.topics[0].weakPoints, ['弱项1']);
      assert.equal(restored.topics[0].exercises.length, 1);

      await store.deletePlan(plan.id);
    });
  });

  describe('Atomic write verification', () => {
    it('no .tmp files should be left after operations', async () => {
      const plan = store.createPlan('原子写入测试');
      await store.addTopics(plan.id, ['原子写入知识点']);
      await store.deletePlan(plan.id);

      if (fs.existsSync(PLANS_DIR)) {
        const tmpFiles = fs.readdirSync(PLANS_DIR).filter(f => f.includes('.tmp'));
        assert.equal(tmpFiles.length, 0, `Found leftover tmp files: ${tmpFiles}`);
      }
    });
  });

  describe('Exam paper data integrity', () => {
    it('exam paper CRUD should maintain data integrity', async () => {
      const plan = store.createPlan('试卷数据测试');
      const updated = await store.addTopics(plan.id, ['试卷知识点']);
      const topic = updated.topics[0];

      const paper = {
        id: 'test-paper-' + Date.now(),
        title: '测试试卷',
        createdAt: Date.now(),
        config: { topicIds: [topic.id], questionCount: 3, choiceRatio: 0.6 },
        paper: '# 测试试卷',
        questions: [
          { id: 'q1', index: 0, type: 'choice', question: '题目1', options: ['A', 'B', 'C', 'D'], answer: 'A' },
          { id: 'q2', index: 1, type: 'open', question: '题目2', answer: '答案2' },
        ],
        results: null,
      };

      store.addExamPaper(plan.id, paper);
      const papers = store.getExamPapers(plan.id);
      assert.equal(papers.length, 1);
      assert.equal(papers[0].title, '测试试卷');
      assert.equal(papers[0].questions.length, 2);

      store.updateExamResults(plan.id, paper.id, [
        { exerciseIndex: 0, correct: true, userAnswer: 'A', correctAnswer: 'A' },
        { exerciseIndex: 1, correct: false, userAnswer: '错误答案', correctAnswer: '答案2' },
      ]);
      const updatedPapers = store.getExamPapers(plan.id);
      assert.equal(updatedPapers[0].results.length, 2);
      assert.equal(updatedPapers[0].results[0].correct, true);
      assert.equal(updatedPapers[0].results[1].correct, false);

      store.deleteExamPaper(plan.id, paper.id);
      const afterDelete = store.getExamPapers(plan.id);
      assert.equal(afterDelete.length, 0);

      await store.deletePlan(plan.id);
    });
  });

  describe('Teaching errors data integrity', () => {
    it('should persist teaching errors and retrieve them', async () => {
      const plan = store.createPlan('教学错误测试');
      const updated = await store.addTopics(plan.id, ['错误知识点']);
      const topic = updated.topics[0];

      const errors = [
        { misconception: '误解1', bloomLevel: '记忆', errorType: '概念混淆' },
        { misconception: '误解2', bloomLevel: '理解', errorType: '过度简化' },
      ];
      await store.recordTeachingErrors(plan.id, topic.id, errors);

      const plan2 = store.getPlan(plan.id);
      const t = plan2.topics.find(t => t.id === topic.id);
      assert.ok(t.teachingErrors);
      assert.equal(t.teachingErrors.length, 2);
      assert.equal(t.teachingErrors[0].misconception, '误解1');

      await store.deletePlan(plan.id);
    });
  });
});
