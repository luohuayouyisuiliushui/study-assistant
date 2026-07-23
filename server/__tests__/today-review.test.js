import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  addTopics,
  clearFlag,
  createPlan,
  getPlan,
  getTodayReviewQueue,
  permanentlyDeletePlan,
  updateTopic,
} from '../engine/learn-store.js';
import {
  buildTodayReviewQueue,
  generateReview,
  gradeExercises,
} from '../engine/learn-engine.js';
import { Provider } from '../engine/provider.js';
import { invalidatePlanCache } from '../engine/store/storage.js';
import learnRouter from '../routes/learn.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const REVIEW_MARKDOWN = [
  '# 复习',
  '',
  '## 📝 练习题',
  '',
  '> **练习题 1**（选择题）Alpha 的正确答案是什么？',
  '> - A. 正确',
  '> - B. 错误',
  '> > 正确答案：A',
  '> > 解析：检索 Alpha。',
  '> > 关联概念：Alpha',
].join('\n');

describe('today review queue and persistent ReviewSession', () => {
  const planIds = [];
  let planAId;
  let planBId;
  let topicAId;
  let topicBId;

  before(async () => {
    const planA = await createPlan('today-review-plan-a', { testOnly: true });
    const planB = await createPlan('today-review-plan-b', { testOnly: true });
    planIds.push(planA.id, planB.id);
    planAId = planA.id;
    planBId = planB.id;

    const withTopicsA = await addTopics(planAId, ['Alpha', 'Future']);
    const withTopicsB = await addTopics(planBId, ['Beta']);
    topicAId = withTopicsA.topics[0].id;
    topicBId = withTopicsB.topics[0].id;

    await updateTopic(planAId, topicAId, learnedTopicUpdate(NOW, 0.2, 'Alpha detail'));
    await updateTopic(planAId, withTopicsA.topics[1].id, learnedTopicUpdate(NOW + 1, 0.1, 'Future detail'));
    await updateTopic(planBId, topicBId, learnedTopicUpdate(NOW - 2 * DAY_MS, 0.9, 'Beta detail'));
  });

  after(async () => {
    for (const planId of planIds) {
      await permanentlyDeletePlan(planId);
      clearFlag(planId);
    }
  });

  it('returns a stable cross-plan queue with exact due and limit boundaries', () => {
    const plans = [getPlan(planBId), getPlan(planAId)];
    const before = structuredClone(plans);

    const queue = buildTodayReviewQueue(plans, { now: NOW, limit: 1 });

    assert.deepEqual(plans, before);
    assert.equal(queue.generatedAt, NOW);
    assert.deepEqual(queue.counts, {
      review: 2,
      mistake: 0,
      waitingVerification: 0,
      total: 2,
    });
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].topicId, topicAId);
    assert.equal(queue.items[0].priorityScore, 216);
    assert.throws(() => buildTodayReviewQueue(plans, { now: NOW, limit: 0 }), /1 and 100/);
    assert.throws(() => buildTodayReviewQueue(plans, { now: NOW, limit: 101 }), /1 and 100/);
  });

  it('coalesces mistakes per Topic and suppresses reviews while verification is waiting', () => {
    const plans = [{
      id: 'unified-plan',
      name: 'Unified Plan',
      topics: [
        {
          id: 'coalesced-topic',
          title: 'Coalesced Topic',
          ...learnedTopicUpdate(NOW - DAY_MS, 0.5, 'detail'),
          mistakes: [
            mistakeRecord('mistake-low', {
              conceptLabel: 'Low Concept',
              severity: 'low',
              lastSeenAt: NOW - 30 * DAY_MS,
            }),
            mistakeRecord('mistake-high-due', {
              conceptLabel: 'High Concept',
              status: 'repairing',
              severity: 'high',
              lastSeenAt: NOW - DAY_MS,
              verificationDueAt: NOW,
            }),
          ],
        },
        {
          id: 'older-medium-topic',
          title: 'Older Medium Topic',
          ...learnedTopicUpdate(NOW - DAY_MS, 0.5, 'detail'),
          mistakes: [mistakeRecord('mistake-medium-old', {
            conceptLabel: 'Medium Concept',
            severity: 'medium',
            lastSeenAt: NOW - 30 * DAY_MS,
          })],
        },
        {
          id: 'waiting-topic',
          title: 'Waiting Topic',
          ...learnedTopicUpdate(NOW - 10 * DAY_MS, 0.1, 'detail'),
          mistakes: [mistakeRecord('mistake-waiting', {
            conceptLabel: 'Waiting Concept',
            status: 'repairing',
            severity: 'high',
            lastSeenAt: NOW,
            verificationDueAt: NOW + 1,
          })],
        },
        {
          id: 'review-only-topic',
          title: 'Review Only Topic',
          ...learnedTopicUpdate(NOW, 0, 'detail'),
          mistakes: [],
        },
      ],
    }];
    const before = structuredClone(plans);

    const queue = buildTodayReviewQueue(plans, { now: NOW, limit: 2 });

    assert.deepEqual(plans, before);
    assert.deepEqual(queue.counts, {
      review: 2,
      mistake: 2,
      waitingVerification: 1,
      total: 4,
    });
    assert.equal(queue.items.length, 2);
    assert.deepEqual(queue.items.map(item => item.topicId), [
      'older-medium-topic',
      'coalesced-topic',
    ]);
    const coalesced = queue.items[1];
    assert.equal(coalesced.kind, 'mistake');
    assert.equal(coalesced.priorityScore, 350);
    assert.equal(coalesced.scheduledReviewDue, true);
    assert.equal(coalesced.mistakeCount, 2);
    assert.equal(coalesced.primaryMistakeId, 'mistake-high-due');
    assert.equal(coalesced.primaryMistake.status, 'repairing');
    assert.ok(!Object.hasOwn(coalesced.primaryMistake, 'evidenceIds'));
    // waiting-topic has a due review but its low priority puts it outside the
    // top-2 slice; at a higher limit it must appear as a review item (not suppressed).
    assert.ok(!queue.items.some(item => item.topicId === 'waiting-topic'));
    const full = buildTodayReviewQueue(plans, { now: NOW, limit: 20 });
    const waitingItem = full.items.find(item => item.topicId === 'waiting-topic');
    assert.ok(waitingItem, 'waiting-topic review must appear when limit allows');
    assert.equal(waitingItem.kind, 'review');
    assert.deepEqual(buildTodayReviewQueue(plans, { now: NOW, limit: 2 }), queue);
  });

  it('emits review (not suppressed) for a topic with only future waiting-verification mistakes when its review is due', () => {
    const plans = [{
      id: 'f03-plan',
      name: 'F03 Plan',
      topics: [
        // Case A: only actionable mistake → must output mistake, not review
        {
          id: 'topic-actionable',
          title: 'Actionable Topic',
          ...learnedTopicUpdate(NOW - DAY_MS, 0.5, 'detail'),
          mistakes: [
            mistakeRecord('mistake-open', { conceptLabel: 'Open Concept', severity: 'medium', lastSeenAt: NOW - DAY_MS }),
          ],
        },
        // Case B: only future waiting-verification mistake, review IS due
        // → must output review item AND count in waitingVerification
        {
          id: 'topic-waiting-due',
          title: 'Waiting But Due Topic',
          ...learnedTopicUpdate(NOW - 2 * DAY_MS, 0.3, 'detail'),
          mistakes: [
            mistakeRecord('mistake-future-verify', {
              conceptLabel: 'Future Verify',
              status: 'repairing',
              severity: 'high',
              lastSeenAt: NOW - 2 * DAY_MS,
              verificationDueAt: NOW + DAY_MS,  // future — still waiting
            }),
          ],
        },
        // Case C: only future waiting-verification mistake, review NOT due yet
        // → must output nothing, only increment waitingVerification
        {
          id: 'topic-waiting-not-due',
          title: 'Waiting And Not Due Topic',
          ...learnedTopicUpdate(NOW + DAY_MS, 0.8, 'detail'),  // review not due
          mistakes: [
            mistakeRecord('mistake-future-verify-2', {
              conceptLabel: 'Also Waiting',
              status: 'repairing',
              severity: 'medium',
              lastSeenAt: NOW - DAY_MS,
              verificationDueAt: NOW + 2 * DAY_MS,  // future — still waiting
            }),
          ],
        },
      ],
    }];

    const queue = buildTodayReviewQueue(plans, { now: NOW, limit: 20 });

    // Case A: only the mistake item is emitted (review suppressed as expected)
    const actionableItem = queue.items.find(item => item.topicId === 'topic-actionable');
    assert.ok(actionableItem, 'actionable mistake topic must appear');
    assert.equal(actionableItem.kind, 'mistake');
    assert.equal(actionableItem.scheduledReviewDue, true);

    // Case B: review item is emitted and topic is counted in waitingVerification
    const waitingDueItem = queue.items.find(item => item.topicId === 'topic-waiting-due');
    assert.ok(waitingDueItem, 'waiting-but-due topic must appear as a review item');
    assert.equal(waitingDueItem.kind, 'review');

    // Case C: no item emitted for the not-yet-due review
    assert.ok(!queue.items.some(item => item.topicId === 'topic-waiting-not-due'));

    // waitingVerification counts both case B and case C topics
    assert.equal(queue.counts.waitingVerification, 2);
    assert.equal(queue.counts.mistake, 1);
    assert.equal(queue.counts.review, 1);
    assert.equal(queue.counts.total, 2);

    // Stable: identical inputs always produce identical output
    assert.deepEqual(buildTodayReviewQueue(plans, { now: NOW, limit: 20 }), queue);
  });

  it('persists the latest session across cache reload and rejects stale or empty sessions', async () => {
    const reviewProvider = createMockProvider(REVIEW_MARKDOWN);
    const plan = getPlan(planAId);
    await generateReview(reviewProvider, plan, topicAId, 'test-model', { now: NOW + 10 });
    const firstSession = structuredClone(getPlan(planAId).topics[0].reviewSession);
    assert.equal(firstSession.kind, 'review');
    assert.equal(firstSession.exercises.length, 1);

    invalidatePlanCache(planAId);
    const restoredSession = getPlan(planAId).topics[0].reviewSession;
    assert.deepEqual(restoredSession, firstSession);

    await generateReview(reviewProvider, getPlan(planAId), topicAId, 'test-model', { now: NOW + 20 });
    const secondSession = structuredClone(getPlan(planAId).topics[0].reviewSession);
    assert.notEqual(secondSession.id, firstSession.id);

    const beforeStale = structuredClone(getPlan(planAId));
    await assert.rejects(
      () => gradeExercises(createGradingProvider(true), getPlan(planAId), topicAId, [
        { exerciseIndex: 0, userAnswer: 'A' },
      ], {
        context: 'review',
        sessionId: firstSession.id,
        attemptRef: 'stale-review-attempt',
        observedAt: NOW + 30,
      }),
      error => error.statusCode === 409
    );
    assert.deepEqual(getPlan(planAId), beforeStale);

    await assert.rejects(
      () => generateReview(createMockProvider('# 无练习内容'), getPlan(planAId), topicAId, 'test-model', {
        now: NOW + 40,
      }),
      error => error.statusCode === 422
    );
    assert.deepEqual(getPlan(planAId).topics[0].reviewSession, secondSession);
  });

  it('advances scheduling only after a valid session submission and stays idempotent', async () => {
    const beforeSubmit = structuredClone(getPlan(planAId));
    const session = beforeSubmit.topics[0].reviewSession;

    const results = await gradeExercises(createGradingProvider(true), getPlan(planAId), topicAId, [
      { exerciseIndex: 0, userAnswer: 'A' },
    ], {
      context: 'review',
      sessionId: session.id,
      attemptRef: 'review-roundtrip-attempt',
      observedAt: NOW + 50,
    });
    assert.equal(results[0].correct, true);

    const completed = structuredClone(getPlan(planAId));
    const completedTopic = completed.topics[0];
    assert.ok(completedTopic.masteryEvidence.some(evidence => evidence.source === 'review'));
    assert.equal(completedTopic.reviewSchedule.dueAt, NOW + 50 + DAY_MS);
    const queueAfterSubmit = buildTodayReviewQueue([completed], { now: NOW + 50, limit: 20 });
    assert.ok(!queueAfterSubmit.items.some(item => item.topicId === topicAId));

    await gradeExercises(createGradingProvider(true), getPlan(planAId), topicAId, [
      { exerciseIndex: 0, userAnswer: 'A' },
    ], {
      context: 'review',
      sessionId: session.id,
      attemptRef: 'review-roundtrip-attempt',
      observedAt: NOW + 60,
    });
    assert.deepEqual(getPlan(planAId).topics[0].masteryEvidence, completedTopic.masteryEvidence);
    assert.deepEqual(getPlan(planAId).topics[0].reviewSchedule, completedTopic.reviewSchedule);
  });

  it('exposes read-only Today and compatible single-plan routes with explicit 4xx errors', async () => {
    const before = structuredClone(getPlan(planBId));
    await withLearnServer(async base => {
      const today = await fetch(`${base}/api/learn/reviews/today?limit=1`);
      assert.equal(today.status, 200);
      const todayBody = await today.json();
      assert.ok(Number.isSafeInteger(todayBody.generatedAt));
      assert.equal(todayBody.items.length, 1);
      assert.ok(todayBody.counts.review >= 1);

      const legacy = await fetch(`${base}/api/learn/plans/${planBId}/review-needs`);
      assert.equal(legacy.status, 200);
      const legacyBody = await legacy.json();
      assert.equal(legacyBody.needs.length, 1);
      assert.equal(legacyBody.needs[0].id, topicBId);

      for (const limit of ['0', '101', '1.5']) {
        const invalid = await fetch(`${base}/api/learn/reviews/today?limit=${limit}`);
        assert.equal(invalid.status, 400);
      }

      const badContext = await fetch(`${base}/api/learn/plans/${planBId}/exercises/${topicBId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: [{ exerciseIndex: 0, userAnswer: 'A' }],
          attemptRef: 'invalid-context-attempt',
          context: 'unknown',
        }),
      });
      assert.equal(badContext.status, 400);

      const stale = await fetch(`${base}/api/learn/plans/${planBId}/exercises/${topicBId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
        body: JSON.stringify({
          answers: [{ exerciseIndex: 0, userAnswer: 'A' }],
          attemptRef: 'route-stale-review-attempt',
          context: 'review',
          sessionId: 'missing-session-id',
        }),
      });
      assert.equal(stale.status, 409);
    });

    assert.deepEqual(getPlan(planBId), before);
    assert.ok(getTodayReviewQueue({ now: Date.now(), limit: 100 }).items.some(item => (
      item.planId === planBId && item.topicId === topicBId
    )));
  });
});

function learnedTopicUpdate(dueAt, masteryLevel, detail) {
  return {
    done: true,
    detail,
    mastery: {
      algorithm: 'evidence-v1',
      level: masteryLevel,
      status: 'learning',
      sampleSize: 0,
      lastEvidenceAt: null,
    },
    reviewSchedule: {
      algorithm: 'sm2-v1',
      dueAt,
      intervalDays: 0,
      easeFactor: 2.5,
      repetitions: 0,
      lapses: 0,
      lastReviewedAt: null,
      lastQuality: null,
      paused: false,
    },
  };
}

function mistakeRecord(id, {
  conceptLabel,
  status = 'open',
  severity,
  lastSeenAt,
  verificationDueAt = null,
}) {
  return {
    id,
    version: 1,
    conceptKey: conceptLabel.toLowerCase(),
    conceptLabel,
    status,
    severity,
    evidenceIds: [`evidence-${id}`],
    occurrenceCount: 1,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    verificationDueAt,
    verifiedAt: null,
    verificationEvidenceId: null,
    dismissedAt: null,
    dismissReason: null,
  };
}

function createMockProvider(content) {
  const provider = new Provider({
    apiKey: 'test-key',
    baseURL: 'https://test.invalid/v1',
    model: 'test-model',
  });
  provider.complete = async () => ({ content });
  return provider;
}

function createGradingProvider(correct) {
  return createMockProvider(JSON.stringify({
    results: [{
      exerciseIndex: 0,
      correct,
      userAnswer: 'A',
      correctAnswer: 'A',
      explanation: 'graded',
    }],
  }));
}

function withLearnServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', learnRouter);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const address = server.address();
        const result = await run(`http://127.0.0.1:${address.port}`);
        server.close(error => error ? reject(error) : resolve(result));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
    server.on('error', reject);
  });
}
