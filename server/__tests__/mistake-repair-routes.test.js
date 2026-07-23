import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  addTopics,
  applyMasteryOutcome,
  clearFlag,
  createPlan,
  getPlan,
  permanentlyDeletePlan,
  updateTopic,
} from '../engine/learn-store.js';
import {
  buildTodayReviewQueue,
  createProviderFromConfig,
} from '../engine/learn-engine.js';
import { MISTAKE_VERIFICATION_DELAY_MS } from '../engine/mistake-ledger.js';
import learnRouter from '../routes/learn.js';

const REPAIR_MARKDOWN = [
  '# Targeted repair',
  '',
  '## 练习题',
  '',
  '> **练习题 1**（选择题）Which answer repairs the target concept?',
  '> - A. Correct',
  '> - B. Incorrect',
  '> > 正确答案：A',
  '> > 解析：Practice the target concept.',
  '> > 关联概念：Provider supplied unrelated label',
].join('\n');

const createdPlanIds = new Set();
let fixtureSequence = 0;
let providerSequence = 0;

afterEach(async () => {
  for (const planId of [...createdPlanIds]) {
    try {
      await permanentlyDeletePlan(planId);
    } finally {
      clearFlag(planId);
      createdPlanIds.delete(planId);
    }
  }
});

describe('mistake repair and dismiss routes', () => {
  it('binds a targeted session, reopens on error, and delays verification after correction', async () => {
    const fixture = await createMistakeFixture({ dueReview: true });
    const provider = configureRouteProvider();

    await withLearnServer(async base => {
      const repairUrl = mistakeUrl(base, fixture, 'repair');
      const firstRepair = await fetch(repairUrl, {
        method: 'POST',
        headers: provider.headers,
      });
      assert.equal(firstRepair.status, 200);
      const firstBody = await firstRepair.json();
      assert.equal(firstBody.reviewSession.kind, 'repair');
      assert.equal(firstBody.reviewSession.mistakeId, fixture.mistakeId);
      assert.equal(firstBody.exercises.length, 1);
      assert.equal(firstBody.exercises[0].conceptTag, fixture.conceptLabel);

      let topic = getFixtureTopic(fixture);
      assert.equal(topic.mistakes[0].status, 'repairing');
      assert.equal(topic.mistakes[0].verificationDueAt, null);
      let queue = buildTodayReviewQueue([getPlan(fixture.planId)], {
        now: Date.now(),
        limit: 20,
      });
      assert.equal(queue.items[0].kind, 'mistake');
      assert.equal(queue.items[0].scheduledReviewDue, true);

      const beforeMismatch = structuredClone(getPlan(fixture.planId));
      const mismatch = await submitRepair(base, fixture, provider.headers, {
        sessionId: firstBody.reviewSession.id,
        mistakeId: 'different-mistake-id',
        attemptRef: 'repair-mismatch-attempt',
        userAnswer: 'A',
      });
      assert.equal(mismatch.status, 409);
      assert.deepEqual(getPlan(fixture.planId), beforeMismatch);

      const wrong = await submitRepair(base, fixture, provider.headers, {
        sessionId: firstBody.reviewSession.id,
        mistakeId: fixture.mistakeId,
        attemptRef: 'repair-wrong-attempt',
        userAnswer: 'B',
      });
      assert.equal(wrong.status, 200);
      topic = getFixtureTopic(fixture);
      assert.equal(topic.mistakes[0].status, 'open');
      assert.equal(topic.mistakes[0].occurrenceCount, 2);

      const secondRepair = await fetch(repairUrl, {
        method: 'POST',
        headers: provider.headers,
      });
      assert.equal(secondRepair.status, 200);
      const secondBody = await secondRepair.json();
      assert.notEqual(secondBody.reviewSession.id, firstBody.reviewSession.id);

      const corrected = await submitRepair(base, fixture, provider.headers, {
        sessionId: secondBody.reviewSession.id,
        mistakeId: fixture.mistakeId,
        attemptRef: 'repair-correct-attempt',
        userAnswer: 'A',
      });
      assert.equal(corrected.status, 200);
      const correctedBody = await corrected.json();
      assert.equal(correctedBody.mistake.status, 'repairing');

      topic = getFixtureTopic(fixture);
      const mistake = topic.mistakes[0];
      assert.equal(mistake.status, 'repairing');
      assert.equal(
        mistake.verificationDueAt,
        mistake.lastSeenAt + MISTAKE_VERIFICATION_DELAY_MS
      );
      assert.ok(mistake.verificationDueAt > Date.now());

      queue = buildTodayReviewQueue([getPlan(fixture.planId)], {
        now: Date.now(),
        limit: 20,
      });
      assert.deepEqual(queue.counts, {
        review: 0,
        mistake: 0,
        waitingVerification: 1,
        total: 0,
      });
      assert.equal(queue.items.length, 0);

      const beforeToday = structuredClone(getPlan(fixture.planId));
      const today = await fetch(`${base}/api/learn/reviews/today?limit=100`);
      assert.equal(today.status, 200);
      const todayBody = await today.json();
      assert.ok(todayBody.counts.waitingVerification >= 1);
      assert.ok(!todayBody.items.some(item => (
        item.planId === fixture.planId && item.topicId === fixture.topicId
      )));
      assert.deepEqual(getPlan(fixture.planId), beforeToday);
    });
  });

  it('keeps failed generation retryable and validates dismiss before reopening on recurrence', async () => {
    const fixture = await createMistakeFixture();
    const failingProvider = configureRouteProvider({ generationError: true });

    await withLearnServer(async base => {
      const beforeFailure = structuredClone(getPlan(fixture.planId));
      const failedRepair = await fetch(mistakeUrl(base, fixture, 'repair'), {
        method: 'POST',
        headers: failingProvider.headers,
      });
      assert.equal(failedRepair.status, 500);
      assert.deepEqual(getPlan(fixture.planId), beforeFailure);
      assert.equal(getFixtureTopic(fixture).mistakes[0].status, 'open');
      assert.equal(getFixtureTopic(fixture).reviewSession, null);

      const wrongPlan = await fetch(
        `${base}/api/learn/plans/missing-plan/topics/${fixture.topicId}/mistakes/${fixture.mistakeId}/repair`,
        { method: 'POST', headers: failingProvider.headers }
      );
      const wrongTopic = await fetch(
        `${base}/api/learn/plans/${fixture.planId}/topics/missing-topic/mistakes/${fixture.mistakeId}/repair`,
        { method: 'POST', headers: failingProvider.headers }
      );
      const wrongMistake = await fetch(
        `${base}/api/learn/plans/${fixture.planId}/topics/${fixture.topicId}/mistakes/missing-mistake/repair`,
        { method: 'POST', headers: failingProvider.headers }
      );
      assert.deepEqual(
        [wrongPlan.status, wrongTopic.status, wrongMistake.status],
        [404, 404, 404]
      );

      const beforeInvalidDismiss = structuredClone(getPlan(fixture.planId));
      const invalidDismiss = await fetch(mistakeUrl(base, fixture, 'dismiss'), {
        method: 'POST',
        headers: failingProvider.headers,
        body: JSON.stringify({ reason: '   ' }),
      });
      assert.equal(invalidDismiss.status, 400);
      assert.deepEqual(getPlan(fixture.planId), beforeInvalidDismiss);

      const dismissed = await fetch(mistakeUrl(base, fixture, 'dismiss'), {
        method: 'POST',
        headers: failingProvider.headers,
        body: JSON.stringify({ reason: ' Outside the current learning goal ' }),
      });
      assert.equal(dismissed.status, 200);
      const dismissedBody = await dismissed.json();
      assert.equal(dismissedBody.mistake.status, 'dismissed');
      assert.equal(dismissedBody.mistake.dismissReason, 'Outside the current learning goal');

      const repairAfterDismiss = await fetch(mistakeUrl(base, fixture, 'repair'), {
        method: 'POST',
        headers: failingProvider.headers,
      });
      assert.equal(repairAfterDismiss.status, 409);

      let queue = buildTodayReviewQueue([getPlan(fixture.planId)], {
        now: Date.now(),
        limit: 20,
      });
      assert.ok(!queue.items.some(item => item.kind === 'mistake'));

      await applyMasteryOutcome(fixture.planId, {
        source: 'quickQuiz',
        attemptRef: 'dismissed-recurrence-attempt',
        observedAt: Date.now(),
        items: [{
          topicId: fixture.topicId,
          itemRef: 'dismissed-recurrence-item',
          correct: false,
          conceptTags: [fixture.conceptLabel],
        }],
      });
      const reopened = getFixtureTopic(fixture).mistakes[0];
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.severity, 'high');
      queue = buildTodayReviewQueue([getPlan(fixture.planId)], {
        now: Date.now(),
        limit: 20,
      });
      assert.equal(queue.items[0].kind, 'mistake');
      assert.equal(queue.items[0].primaryMistakeId, fixture.mistakeId);
    });
  });
});

async function createMistakeFixture({ dueReview = false } = {}) {
  fixtureSequence += 1;
  const plan = await createPlan(`mistake-repair-route-${fixtureSequence}`, { testOnly: true });
  createdPlanIds.add(plan.id);
  const populated = await addTopics(plan.id, [`Repair Topic ${fixtureSequence}`]);
  const topic = populated.topics[0];
  await updateTopic(plan.id, topic.id, {
    done: true,
    detail: '# Topic detail\nThe target concept is explained here.',
  });
  const conceptLabel = `Target Concept ${fixtureSequence}`;
  const errorAt = Date.now();
  await applyMasteryOutcome(plan.id, {
    source: 'exercise',
    attemptRef: `repair-route-seed-${fixtureSequence}`,
    observedAt: errorAt,
    items: [{
      topicId: topic.id,
      itemRef: 'seed-error-item',
      correct: false,
      conceptTags: [conceptLabel],
    }],
  });
  if (dueReview) {
    const current = getPlan(plan.id).topics.find(candidate => candidate.id === topic.id);
    await updateTopic(plan.id, topic.id, {
      reviewSchedule: { ...current.reviewSchedule, dueAt: errorAt },
    });
  }
  const persistedTopic = getPlan(plan.id).topics.find(candidate => candidate.id === topic.id);
  return {
    planId: plan.id,
    topicId: topic.id,
    mistakeId: persistedTopic.mistakes[0].id,
    conceptLabel,
  };
}

function getFixtureTopic(fixture) {
  return getPlan(fixture.planId).topics.find(topic => topic.id === fixture.topicId);
}

function configureRouteProvider({ generationError = false } = {}) {
  providerSequence += 1;
  const apiKey = `repair-route-key-${providerSequence}`;
  const baseURL = `https://repair-route-${providerSequence}.invalid/v1`;
  const model = `repair-route-model-${providerSequence}`;
  const provider = createProviderFromConfig(apiKey, baseURL, model);
  provider.complete = async (messages, options = {}) => {
    if (generationError) throw new Error('injected repair generation failure');
    if (options.responseFormat?.type === 'json_object') {
      const context = JSON.parse(messages.at(-1).content);
      const userAnswer = context.exercises[0].userAnswer;
      return {
        content: JSON.stringify({
          results: [{
            exerciseIndex: 0,
            correct: userAnswer === 'A',
            userAnswer,
            correctAnswer: 'A',
            explanation: 'graded',
          }],
        }),
      };
    }
    return { content: REPAIR_MARKDOWN };
  };
  return {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'x-api-base': baseURL,
      'x-api-model': model,
    },
  };
}

function mistakeUrl(base, fixture, action) {
  return `${base}/api/learn/plans/${fixture.planId}/topics/${fixture.topicId}/mistakes/${fixture.mistakeId}/${action}`;
}

function submitRepair(base, fixture, headers, {
  sessionId,
  mistakeId,
  attemptRef,
  userAnswer,
}) {
  return fetch(`${base}/api/learn/plans/${fixture.planId}/exercises/${fixture.topicId}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      answers: [{ exerciseIndex: 0, userAnswer }],
      context: 'repair',
      sessionId,
      mistakeId,
      attemptRef,
    }),
  });
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
