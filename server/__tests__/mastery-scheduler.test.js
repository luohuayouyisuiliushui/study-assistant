import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_SOURCES,
  advanceReviewSchedule,
  applyMasteryEvidenceAttempt,
  buildDueReviewItems,
  createInitialMastery,
  createInitialReviewSchedule,
  createInitialTopicLearningState,
  createMasteryEvidence,
  deriveMastery,
  retainMasteryEvidence,
  scoreToQuality,
} from '../engine/mastery-scheduler.js';

const VALID_EVIDENCE = Object.freeze({
  source: 'exercise',
  attemptRef: 'attempt-001',
  sourceRef: 'attempt-001:item-1',
  observedAt: 1_700_000_000_000,
  score: 1,
  quality: 5,
  confidence: 'high',
  conceptTags: ['  Array   methods ', 'Array methods', '', '边界  条件'],
});

describe('mastery evidence contract', () => {
  it('normalizes valid evidence deterministically without mutating the input', () => {
    const input = structuredClone(VALID_EVIDENCE);

    const first = createMasteryEvidence(input);
    const second = createMasteryEvidence(input);

    assert.deepEqual(first, second);
    assert.deepEqual(input, VALID_EVIDENCE);
    assert.equal(first.id.length, 24);
    assert.equal(first.version, 1);
    assert.deepEqual(first.conceptTags, ['Array methods', '边界 条件']);
  });

  it('accepts score and quality boundaries and maps partial scores', () => {
    const lower = createMasteryEvidence({
      ...VALID_EVIDENCE,
      sourceRef: 'attempt-001:lower',
      score: 0,
      quality: 0,
      conceptTags: [],
    });
    const upper = createMasteryEvidence({ ...VALID_EVIDENCE });

    assert.equal(lower.score, 0);
    assert.equal(lower.quality, 0);
    assert.deepEqual(lower.conceptTags, []);
    assert.equal(upper.score, 1);
    assert.equal(upper.quality, 5);
    assert.deepEqual(
      [0, 0.1, 0.4, 0.6, 0.75, 0.9, 1].map(scoreToQuality),
      [0, 1, 2, 3, 4, 5, 5]
    );
  });

  it('rejects malformed evidence with explicit contract errors', () => {
    const invalidCases = [
      [{ ...VALID_EVIDENCE, source: 'pageView' }, /source/],
      [{ ...VALID_EVIDENCE, score: Number.NaN }, /score/],
      [{ ...VALID_EVIDENCE, score: 1.01 }, /score/],
      [{ ...VALID_EVIDENCE, quality: 2.5 }, /quality/],
      [{ ...VALID_EVIDENCE, quality: 6 }, /quality/],
      [{ ...VALID_EVIDENCE, attemptRef: 'short' }, /attemptRef/],
      [{ ...VALID_EVIDENCE, attemptRef: 'a'.repeat(129) }, /attemptRef/],
      [{ ...VALID_EVIDENCE, sourceRef: 'attempt-001:' }, /sourceRef/],
      [{ ...VALID_EVIDENCE, sourceRef: `attempt-001:${'x'.repeat(245)}` }, /sourceRef/],
      [{ ...VALID_EVIDENCE, observedAt: -1 }, /observedAt/],
      [{ ...VALID_EVIDENCE, conceptTags: 'arrays' }, /conceptTags/],
      [{ ...VALID_EVIDENCE, confidence: 'certain' }, /confidence/],
      [{ ...VALID_EVIDENCE, source: 'feynman', quality: 5 }, /Feynman/],
    ];

    for (const [input, pattern] of invalidCases) {
      assert.throws(() => createMasteryEvidence(input), pattern);
    }
  });

  it('exposes only the frozen evidence sources', () => {
    assert.deepEqual([...EVIDENCE_SOURCES], [
      'exercise',
      'quickQuiz',
      'exam',
      'feynman',
      'review',
      'repair',
    ]);
  });
});

describe('initial Topic learning state', () => {
  it('treats done as learned rather than evidence of mastery', () => {
    const state = createInitialTopicLearningState({ done: true });

    assert.deepEqual(state.masteryEvidence, []);
    assert.deepEqual(state.mistakes, []);
    assert.equal(state.reviewSession, null);
    assert.deepEqual(state.mastery, createInitialMastery({ done: true }));
    assert.equal(state.mastery.status, 'learning');
    assert.notEqual(state.mastery.status, 'mastered');
  });

  it('uses the documented shared defaults for unassessed Topics', () => {
    const state = createInitialTopicLearningState();

    assert.deepEqual(state, {
      masteryEvidence: [],
      mastery: {
        algorithm: 'evidence-v1',
        level: 0,
        status: 'unassessed',
        sampleSize: 0,
        lastEvidenceAt: null,
      },
      reviewSchedule: {
        algorithm: 'sm2-v1',
        dueAt: null,
        intervalDays: 0,
        easeFactor: 2.5,
        repetitions: 0,
        lapses: 0,
        lastReviewedAt: null,
        lastQuality: null,
        paused: false,
      },
      reviewSession: null,
      mistakes: [],
    });
    assert.deepEqual(state.reviewSchedule, createInitialReviewSchedule());
  });

  it('validates initial schedule inputs', () => {
    assert.equal(createInitialReviewSchedule({ dueAt: 0 }).dueAt, 0);
    assert.throws(() => createInitialReviewSchedule({ dueAt: -1 }), /dueAt/);
    assert.throws(() => createInitialReviewSchedule({ dueAt: 1.5 }), /dueAt/);
    assert.throws(() => createInitialMastery({ done: 'yes' }), /done/);
  });
});

describe('mastery derivation', () => {
  it('derives weighted recent mastery deterministically without mutating evidence', () => {
    const day = 86_400_000;
    const evidence = [
      createMasteryEvidence({
        ...VALID_EVIDENCE,
        attemptRef: 'attempt-a',
        sourceRef: 'attempt-a:item-1',
        score: 0.8,
        quality: 4,
        observedAt: VALID_EVIDENCE.observedAt,
      }),
      createMasteryEvidence({
        ...VALID_EVIDENCE,
        attemptRef: 'attempt-b',
        sourceRef: 'attempt-b:item-1',
        score: 0.6,
        quality: 3,
        confidence: 'medium',
        observedAt: VALID_EVIDENCE.observedAt + day / 2,
      }),
      createMasteryEvidence({
        ...VALID_EVIDENCE,
        attemptRef: 'attempt-c',
        sourceRef: 'attempt-c:item-1',
        score: 1,
        quality: 5,
        observedAt: VALID_EVIDENCE.observedAt + day,
      }),
    ];
    const before = structuredClone(evidence);

    const mastery = deriveMastery(evidence, { done: true });

    assert.deepEqual(mastery, {
      algorithm: 'evidence-v1',
      level: 0.8261,
      status: 'mastered',
      sampleSize: 3,
      lastEvidenceAt: VALID_EVIDENCE.observedAt + day,
    });
    assert.deepEqual(evidence, before);
    assert.deepEqual(deriveMastery(evidence, { done: true }), mastery);
  });

  it('requires the mastered evidence span to reach the exact 24-hour boundary', () => {
    const start = VALID_EVIDENCE.observedAt;
    const makeEvidence = (suffix, observedAt) => createMasteryEvidence({
      ...VALID_EVIDENCE,
      attemptRef: `attempt-${suffix}`,
      sourceRef: `attempt-${suffix}:item-1`,
      observedAt,
    });
    const firstTwo = [makeEvidence('one', start), makeEvidence('two', start + 1)];

    assert.equal(
      deriveMastery([...firstTwo, makeEvidence('early', start + 86_400_000 - 1)], { done: true }).status,
      'developing'
    );
    assert.equal(
      deriveMastery([...firstTwo, makeEvidence('exact', start + 86_400_000)], { done: true }).status,
      'mastered'
    );
  });

  it('rejects an invalid learned-state flag', () => {
    const evidence = [createMasteryEvidence(VALID_EVIDENCE)];
    assert.throws(() => deriveMastery(evidence, { done: 'yes' }), /done/);
  });
});

describe('SM-2 v1 review scheduling', () => {
  it('follows the frozen 1-6-growth sequence and resets after a lapse', () => {
    const day = 86_400_000;
    const start = VALID_EVIDENCE.observedAt;
    const initial = createInitialReviewSchedule();

    const first = advanceReviewSchedule(initial, 5, { now: start });
    const second = advanceReviewSchedule(first, 5, { now: start + day });
    const third = advanceReviewSchedule(second, 4, { now: start + 2 * day });
    const failed = advanceReviewSchedule(third, 2, { now: start + 3 * day });

    assert.deepEqual(initial, createInitialReviewSchedule());
    assert.deepEqual(
      [first.intervalDays, second.intervalDays, third.intervalDays, failed.intervalDays],
      [1, 6, 16, 1]
    );
    assert.deepEqual(
      [first.repetitions, second.repetitions, third.repetitions, failed.repetitions],
      [1, 2, 3, 0]
    );
    assert.equal(first.easeFactor, 2.6);
    assert.equal(second.easeFactor, 2.7);
    assert.equal(third.easeFactor, 2.7);
    assert.equal(failed.easeFactor, 2.38);
    assert.equal(failed.lapses, 1);
    assert.equal(failed.lastQuality, 2);
    assert.equal(failed.lastReviewedAt, start + 3 * day);
    assert.equal(failed.dueAt, start + 4 * day);
  });

  it('clamps ease and interval boundaries and rejects invalid state', () => {
    const now = VALID_EVIDENCE.observedAt;
    const maximum = advanceReviewSchedule({
      ...createInitialReviewSchedule(),
      intervalDays: 365,
      repetitions: 3,
    }, 5, { now });
    const minimum = advanceReviewSchedule({
      ...createInitialReviewSchedule(),
      easeFactor: 1.3,
    }, 0, { now });

    assert.equal(maximum.intervalDays, 365);
    assert.equal(minimum.easeFactor, 1.3);
    assert.throws(() => advanceReviewSchedule(createInitialReviewSchedule(), 5), /now/);
    assert.throws(() => advanceReviewSchedule({
      ...createInitialReviewSchedule(),
      intervalDays: -1,
    }, 5, { now }), /intervalDays/);
    assert.throws(() => advanceReviewSchedule(createInitialReviewSchedule(), 2.5, { now }), /quality/);
  });
});

describe('mastery evidence attempts', () => {
  it('groups a multi-item attempt into one schedule update and ignores replay', () => {
    const now = VALID_EVIDENCE.observedAt;
    const attempt = [
      createMasteryEvidence({
        ...VALID_EVIDENCE,
        attemptRef: 'attempt-multi',
        sourceRef: 'attempt-multi:item-1',
        observedAt: now,
        score: 1,
        quality: 5,
      }),
      createMasteryEvidence({
        ...VALID_EVIDENCE,
        attemptRef: 'attempt-multi',
        sourceRef: 'attempt-multi:item-2',
        observedAt: now,
        score: 0,
        quality: 0,
      }),
    ];
    const input = {
      currentEvidence: [],
      reviewSchedule: createInitialReviewSchedule(),
      evidence: attempt,
      done: true,
      now,
    };
    const before = structuredClone(input);

    const first = applyMasteryEvidenceAttempt(input);
    const replay = applyMasteryEvidenceAttempt({
      ...input,
      currentEvidence: first.masteryEvidence,
      reviewSchedule: first.reviewSchedule,
    });

    assert.deepEqual(input, before);
    assert.equal(first.inserted, true);
    assert.equal(first.insertedEvidence.length, 2);
    assert.equal(first.aggregateQuality, 2);
    assert.equal(first.reviewSchedule.repetitions, 0);
    assert.equal(first.reviewSchedule.lapses, 1);
    assert.equal(first.mastery.level, 0.4872);
    assert.equal(first.mastery.status, 'needsWork');
    assert.equal(replay.inserted, false);
    assert.deepEqual(replay.insertedEvidence, []);
    assert.equal(replay.aggregateQuality, null);
    assert.deepEqual(replay.masteryEvidence, first.masteryEvidence);
    assert.deepEqual(replay.mastery, first.mastery);
    assert.deepEqual(replay.reviewSchedule, first.reviewSchedule);
  });

  it('retains protected evidence while deterministically enforcing the soft limit', () => {
    const evidence = Array.from({ length: 201 }, (_, index) => {
      const attemptRef = `attempt-${String(index).padStart(3, '0')}`;
      return createMasteryEvidence({
        ...VALID_EVIDENCE,
        attemptRef,
        sourceRef: `${attemptRef}:item-1`,
        observedAt: VALID_EVIDENCE.observedAt + index,
      });
    });
    const reversed = evidence.toReversed();
    const before = structuredClone(reversed);

    const retained = retainMasteryEvidence(reversed, {
      protectedEvidenceIds: [evidence[0].id],
    });

    assert.deepEqual(reversed, before);
    assert.equal(retained.length, 200);
    assert.ok(retained.some(item => item.id === evidence[0].id));
    assert.ok(!retained.some(item => item.id === evidence[1].id));
    assert.equal(retained.at(-1).id, evidence.at(-1).id);
    assert.deepEqual(retainMasteryEvidence(evidence.slice(0, 200)), evidence.slice(0, 200));
  });

  it('caps aggregated Feynman quality at four', () => {
    const evidence = createMasteryEvidence({
      ...VALID_EVIDENCE,
      source: 'feynman',
      attemptRef: 'feynman-attempt',
      sourceRef: 'feynman-attempt:transcript',
      score: 0.9,
      quality: 4,
      confidence: 'medium',
    });

    const result = applyMasteryEvidenceAttempt({
      currentEvidence: [],
      reviewSchedule: createInitialReviewSchedule(),
      evidence: [evidence],
      now: evidence.observedAt,
    });

    assert.equal(result.aggregateQuality, 4);
    assert.equal(result.reviewSchedule.lastQuality, 4);
  });
});

describe('due review items', () => {
  it('builds only actionable reviews in frozen priority order without mutating plans', () => {
    const now = VALID_EVIDENCE.observedAt;
    const plans = [
      {
        id: 'plan-b',
        name: 'Plan B',
        topics: [
          {
            id: 'topic-b',
            title: 'Older but stronger',
            done: true,
            mastery: { ...createInitialMastery({ done: true }), level: 0.9 },
            reviewSchedule: { ...createInitialReviewSchedule(), dueAt: now - 2 * 86_400_000 },
          },
          {
            id: 'topic-paused',
            title: 'Paused',
            done: true,
            mastery: createInitialMastery({ done: true }),
            reviewSchedule: { ...createInitialReviewSchedule(), dueAt: now, paused: true },
          },
        ],
      },
      {
        id: 'plan-a',
        name: 'Plan A',
        topics: [
          {
            id: 'topic-a',
            title: 'Due and weak',
            done: true,
            mastery: { ...createInitialMastery({ done: true }), level: 0.2 },
            reviewSchedule: { ...createInitialReviewSchedule(), dueAt: now },
          },
          {
            id: 'topic-future',
            title: 'Future',
            done: true,
            mastery: createInitialMastery({ done: true }),
            reviewSchedule: { ...createInitialReviewSchedule(), dueAt: now + 1 },
          },
          {
            id: 'topic-unlearned',
            title: 'Unlearned',
            done: false,
            mastery: createInitialMastery(),
            reviewSchedule: { ...createInitialReviewSchedule(), dueAt: now },
          },
        ],
      },
    ];
    const before = structuredClone(plans);

    const items = buildDueReviewItems(plans, { now, limit: 100 });

    assert.deepEqual(plans, before);
    assert.deepEqual(items.map(item => item.queueItemId), [
      'review:plan-a:topic-a',
      'review:plan-b:topic-b',
    ]);
    assert.deepEqual(items.map(item => item.priorityScore), [216, 204]);
    assert.deepEqual(items[0], {
      queueItemId: 'review:plan-a:topic-a',
      kind: 'review',
      planId: 'plan-a',
      planName: 'Plan A',
      topicId: 'topic-a',
      topicTitle: 'Due and weak',
      dueAt: now,
      priorityScore: 216,
      mastery: { ...createInitialMastery({ done: true }), level: 0.2 },
    });
  });
});

describe('learn engine compatibility', () => {
  it('re-exports the mastery scheduler public API', async () => {
    const learnEngine = await import('../engine/learn-engine.js');

    assert.equal(learnEngine.deriveMastery, deriveMastery);
    assert.equal(learnEngine.advanceReviewSchedule, advanceReviewSchedule);
    assert.equal(learnEngine.applyMasteryEvidenceAttempt, applyMasteryEvidenceAttempt);
    assert.equal(learnEngine.buildDueReviewItems, buildDueReviewItems);
  });
});
