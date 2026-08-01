import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../engine/learn-store.js';

const createdPlanIds = [];

after(async () => {
  for (const planId of createdPlanIds) {
    await store.permanentlyDeletePlan(planId);
  }
});

async function planWithTopic() {
  const plan = await store.createPlan('plan-transaction-test');
  createdPlanIds.push(plan.id);
  return store.addTopics(plan.id, ['TCP']);
}

function exam(id) {
  return { id, title: id, config: {}, paper: '# exam', questions: [] };
}

describe('serialized Plan transactions', () => {
  it('exposes semantic relation state without the raw plan mutator', async () => {
    const plan = await planWithTopic();
    const inferredAt = 1_785_340_800_000;

    assert.equal('writePlan' in store, false);
    await store.markRelationsInferred(plan.id, inferredAt);

    assert.equal(store.getPlan(plan.id).relationsInferredAt, inferredAt);
  });

  it('preserves concurrent exam and topic mutations', async () => {
    const plan = await planWithTopic();
    const topicId = plan.topics[0].id;

    await Promise.all([
      store.addExamPaper(plan.id, exam('exam-1')),
      store.updateTopic(plan.id, topicId, { difficulty: 'hard' }),
    ]);

    const persisted = store.getPlan(plan.id);
    assert.equal(persisted.topics[0].difficulty, 'hard');
    assert.deepEqual(persisted.examPapers.map(item => item.id), ['exam-1']);
  });

  it('preserves every concurrently added exam', async () => {
    const plan = await planWithTopic();

    await Promise.all([
      store.addExamPaper(plan.id, exam('exam-a')),
      store.addExamPaper(plan.id, exam('exam-b')),
    ]);

    assert.deepEqual(
      store.getPlan(plan.id).examPapers.map(item => item.id).sort(),
      ['exam-a', 'exam-b'],
    );
  });

  it('preserves grading alongside a topic mutation', async () => {
    const plan = await planWithTopic();
    const topicId = plan.topics[0].id;
    await store.addExamPaper(plan.id, exam('exam-grade'));

    await Promise.all([
      store.updateExamResults(plan.id, 'exam-grade', [{ exerciseIndex: 0, correct: true }]),
      store.updateTopic(plan.id, topicId, { done: true }),
    ]);

    const persisted = store.getPlan(plan.id);
    assert.equal(persisted.topics[0].done, true);
    assert.equal(persisted.examPapers[0].results[0].correct, true);
  });
});
