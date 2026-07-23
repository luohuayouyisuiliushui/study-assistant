import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../engine/learn-store.js';
import {
  calculateNextReview,
  calculateSm2Schedule,
  recordSm2Review,
} from '../engine/spaced-repetition.js';

const FIXED_NOW = new Date('2026-01-15T00:00:00.000Z');
const createdPlanIds = [];

async function createTopicFixture() {
  const plan = await store.createPlan('SM-2 排程测试', { testOnly: true });
  createdPlanIds.push(plan.id);
  const planWithTopic = await store.addTopics(plan.id, ['固定时钟知识点']);
  return { planId: plan.id, topicId: planWithTopic.topics[0].id };
}

after(async () => {
  for (const planId of createdPlanIds) {
    await store.permanentlyDeletePlan(planId);
    store.clearFlag(planId);
  }
});

describe('SM-2 scheduling', () => {
  it('uses the supplied clock when scheduling a reviewed topic', () => {
    const schedule = calculateSm2Schedule({
      sm2History: [{
        reviewDate: '2026-01-10T00:00:00.000Z',
        grade: 5,
        easeFactor: 2.5,
      }],
    }, FIXED_NOW);

    assert.equal(schedule.grade, 5);
    assert.equal(schedule.easeFactor, 2.5);
    assert.equal(schedule.nextReview.toISOString(), '2026-02-15T00:00:00.000Z');
  });

  it('uses the supplied clock for the initial review schedule', () => {
    const schedule = calculateSm2Schedule({ sm2History: [] }, FIXED_NOW);

    assert.equal(schedule.algorithm, 'SM-2 Initial');
    assert.equal(schedule.nextReview.toISOString(), '2026-01-17T12:00:00.000Z');
  });

  it('keeps quality 0 and 5 schedules within SM-2 boundaries', () => {
    const failedReview = calculateNextReview(0, 2.5, 8);
    const perfectReview = calculateNextReview(5, 2.5, 1);

    assert.deepEqual(failedReview, {
      interval: 1,
      easeFactor: 1.7,
      grade: 0,
      algorithm: 'SM-2',
    });
    assert.deepEqual(perfectReview, {
      interval: 6,
      easeFactor: 2.5,
      grade: 5,
      algorithm: 'SM-2',
    });
  });

  it('records a first review with the supplied timestamp', async () => {
    const { planId, topicId } = await createTopicFixture();

    const result = await recordSm2Review(planId, topicId, 5, 'manual', FIXED_NOW);
    const topic = store.getPlan(planId).topics.find(candidate => candidate.id === topicId);

    assert.equal(result.review.reviewDate, FIXED_NOW.toISOString());
    assert.equal(result.nextReview.interval, 1);
    assert.equal(topic.nextReviewDate, '2026-01-16T00:00:00.000Z');
    assert.equal(topic.sm2History.length, 1);
  });

  it('keeps only the newest 100 review records', async () => {
    const { planId, topicId } = await createTopicFixture();
    const history = Array.from({ length: 100 }, (_, index) => ({
      marker: index,
      reviewDate: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      quality: 4,
      grade: 4,
      easeFactor: 2.5,
      reviewType: 'manual',
      algorithm: 'SM-2',
    }));
    await store.updateTopic(planId, topicId, { sm2History: history });

    await recordSm2Review(planId, topicId, 5, 'manual', FIXED_NOW);
    const topic = store.getPlan(planId).topics.find(candidate => candidate.id === topicId);

    assert.equal(topic.sm2History.length, 100);
    assert.equal(topic.sm2History[0].marker, 1);
    assert.equal(topic.sm2History.at(-1).reviewDate, FIXED_NOW.toISOString());
  });

  it('reports missing plans and topics explicitly', async () => {
    await assert.rejects(
      recordSm2Review('missing-sm2-plan', 'missing-topic', 5, 'manual', FIXED_NOW),
      /Plan not found/
    );

    const { planId } = await createTopicFixture();
    await assert.rejects(
      recordSm2Review(planId, 'missing-topic', 5, 'manual', FIXED_NOW),
      /Topic not found/
    );
  });
});
