import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTERY_SCHEMA_VERSION,
  appendMasteryEvidence,
  applyMistakeEvidence,
  advanceReviewSchedule,
  buildTodayReview,
  computeMasteryMetrics,
  createReviewSession,
  createReviewSchedule,
  deriveMastery,
  dismissMistake,
  migrateLegacyPlan,
  projectReviewSession,
  recordMistake,
  submitReviewSession,
} from '../engine/mastery-engine.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1, 8);

function correctEvidence(sourceRef, sessionId, occurredAt, overrides = {}) {
  return {
    source: 'Review',
    sourceRef,
    sessionId,
    occurredAt,
    correct: true,
    confidence: 0.95,
    conceptKey: 'tcp',
    ...overrides,
  };
}

describe('mastery evidence', () => {
  it('deduplicates immutable evidence by source and sourceRef', () => {
    const first = appendMasteryEvidence([], correctEvidence('r1', 's1', BASE));
    const duplicate = appendMasteryEvidence(first.items, {
      ...correctEvidence('r1', 's2', BASE + DAY),
      correct: false,
    });

    assert.equal(first.added, true);
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.items.length, 1);
    assert.equal(duplicate.items[0].correct, true);
    assert.equal(Object.isFrozen(first.items[0]), true);
  });

  it('rejects unknown sources and incomplete source references', () => {
    assert.throws(() => appendMasteryEvidence([], correctEvidence('', 's1', BASE)), /sourceRef/);
    assert.throws(() => appendMasteryEvidence([], correctEvidence('r1', 's1', BASE, { source: 'PageView' })), /source/);
  });

  it('requires three independent high-confidence sessions and a 24 hour span', () => {
    const evidence = [
      correctEvidence('r1', 's1', BASE),
      correctEvidence('r2', 's2', BASE + 2 * 60 * 60 * 1000),
      correctEvidence('r3', 's3', BASE + DAY - 1),
    ];
    assert.equal(deriveMastery(evidence).status, 'learning');

    evidence[2] = correctEvidence('r3', 's3', BASE + DAY);
    const mastery = deriveMastery(evidence);
    assert.equal(mastery.status, 'mastered');
    assert.equal(mastery.sampleSize, 3);
    assert.equal(mastery.level, 1);
    assert.equal(mastery.lastEvidenceAt, BASE + DAY);
  });

  it('does not count low-confidence or repeated-session correct results', () => {
    const evidence = [
      correctEvidence('r1', 's1', BASE),
      correctEvidence('r2', 's1', BASE + DAY),
      correctEvidence('r3', 's2', BASE + 2 * DAY, { confidence: 0.7 }),
      correctEvidence('r4', 's3', BASE + 3 * DAY),
    ];
    assert.equal(deriveMastery(evidence).status, 'learning');
  });

  it('downgrades mastery after a later high-confidence error', () => {
    const evidence = [
      correctEvidence('r1', 's1', BASE),
      correctEvidence('r2', 's2', BASE + DAY),
      correctEvidence('r3', 's3', BASE + 2 * DAY),
      correctEvidence('r4', 's4', BASE + 3 * DAY, { correct: false }),
    ];
    assert.equal(deriveMastery(evidence).status, 'learning');
  });

  it('requires a new spaced success run after a high-confidence error', () => {
    const evidence = [
      correctEvidence('r1', 's1', BASE),
      correctEvidence('r2', 's2', BASE + DAY),
      correctEvidence('r3', 's3', BASE + 2 * DAY),
      correctEvidence('r4', 's4', BASE + 3 * DAY, { correct: false }),
      correctEvidence('r5', 's5', BASE + 3 * DAY + 1000),
    ];

    assert.equal(deriveMastery(evidence).status, 'learning');
  });
});

describe('sm2-v1 review schedule', () => {
  it('advances only on high-confidence scored attempts', () => {
    const initial = createReviewSchedule(BASE);
    const lowConfidence = advanceReviewSchedule(initial, { correct: true, confidence: 0.6 }, BASE);
    assert.deepEqual(lowConfidence, initial);

    const first = advanceReviewSchedule(initial, { correct: true, confidence: 0.95 }, BASE);
    assert.equal(first.intervalDays, 1);
    assert.equal(first.dueAt, BASE + DAY);
    assert.equal(first.consecutiveSuccesses, 1);

    const second = advanceReviewSchedule(first, { correct: true, confidence: 0.95 }, BASE + DAY);
    assert.equal(second.intervalDays, 6);
    assert.equal(second.consecutiveSuccesses, 2);
  });

  it('resets the interval and increments lapses after an error', () => {
    const schedule = { ...createReviewSchedule(BASE), intervalDays: 14, consecutiveSuccesses: 4 };
    const failed = advanceReviewSchedule(schedule, { correct: false, confidence: 0.99 }, BASE);
    assert.equal(failed.intervalDays, 1);
    assert.equal(failed.consecutiveSuccesses, 0);
    assert.equal(failed.lapses, 1);
  });
});

describe('persistent Review Session', () => {
  const questions = [
    { id: 'q1', prompt: 'TCP 是什么？', expectedAnswer: '传输控制协议', conceptKey: 'TCP' },
    { id: 'q2', prompt: '可靠传输？', expectedAnswer: '是', conceptKey: 'TCP' },
  ];

  it('keeps a fixed question set and hides answers before submission', () => {
    const session = createReviewSession({
      id: 'session-1', planId: 'p1', topicId: 't1', topicTitle: 'TCP',
      questions, createdAt: BASE,
    });
    const projected = projectReviewSession(session);

    assert.equal(session.status, 'active');
    assert.equal(Object.isFrozen(session.questions[0]), true);
    assert.deepEqual(projected.questions, [
      { id: 'q1', prompt: 'TCP 是什么？', conceptKey: 'tcp', options: [] },
      { id: 'q2', prompt: '可靠传输？', conceptKey: 'tcp', options: [] },
    ]);
    assert.equal(Object.hasOwn(projected.questions[0], 'expectedAnswer'), false);
  });

  it('rejects a mismatched session id and reveals grading only after submit', () => {
    const session = createReviewSession({
      id: 'session-1', planId: 'p1', topicId: 't1', topicTitle: 'TCP',
      questions, createdAt: BASE,
    });
    assert.throws(() => submitReviewSession(session, {
      sessionId: 'wrong', answers: [{ questionId: 'q1', answer: '传输控制协议' }], submittedAt: BASE + 1000,
    }), /sessionId/);

    const submitted = submitReviewSession(session, {
      sessionId: 'session-1',
      answers: [
        { questionId: 'q1', answer: '传输控制协议' },
        { questionId: 'q2', answer: '否' },
      ],
      submittedAt: BASE + 1000,
    });
    assert.equal(submitted.session.status, 'completed');
    assert.deepEqual(submitted.results.map(result => result.correct), [true, false]);
    assert.equal(submitted.results[0].expectedAnswer, '传输控制协议');
    assert.equal(submitted.evidence.length, 2);
    assert.equal(submitted.evidence[0].sourceRef, 'session-1:q1');
    assert.equal(submitted.evidence[0].gradingMethod, 'deterministic');
  });

  it('requires answers to match the persisted question set exactly', () => {
    const session = createReviewSession({
      id: 'session-1', planId: 'p1', topicId: 't1', topicTitle: 'TCP',
      questions, createdAt: BASE,
    });

    assert.throws(() => submitReviewSession(session, {
      sessionId: 'session-1',
      answers: [{ questionId: 'q1', answer: '传输控制协议' }],
      submittedAt: BASE + 1000,
    }), /question set/);
    assert.throws(() => submitReviewSession(session, {
      sessionId: 'session-1',
      answers: [
        { questionId: 'q1', answer: '传输控制协议' },
        { questionId: 'unknown', answer: '是' },
      ],
      submittedAt: BASE + 1000,
    }), /question set/);
  });

  it('matches a selected option label to its persisted answer key', () => {
    const session = createReviewSession({
      id: 'choice-session', planId: 'p1', topicId: 't1', topicTitle: 'TCP', createdAt: BASE,
      questions: [{
        id: 'q1', prompt: '可靠传输？', expectedAnswer: 'A', options: ['A. 是', 'B. 否'],
      }],
    });

    const submitted = submitReviewSession(session, {
      sessionId: 'choice-session',
      answers: [{ questionId: 'q1', answer: 'A. 是' }],
      submittedAt: BASE + 1000,
    });

    assert.equal(submitted.results[0].correct, true);
  });

  it('only treats an exact open-answer match as high-confidence evidence', () => {
    const input = {
      id: 'exact-session', planId: 'p1', topicId: 't1', topicTitle: 'TCP', createdAt: BASE,
      questions: [{
        id: 'q1', prompt: 'TCP 是什么？', expectedAnswer: '传输控制协议',
        gradingMethod: 'exact-only',
      }],
    };
    const paraphrase = submitReviewSession(createReviewSession(input), {
      sessionId: 'exact-session',
      answers: [{ questionId: 'q1', answer: '一种可靠传输协议' }],
      submittedAt: BASE + 1000,
    });
    assert.deepEqual(
      [paraphrase.results[0].correct, paraphrase.results[0].confidence, paraphrase.results[0].gradingMethod],
      [false, 0.5, 'ai'],
    );

    const exact = submitReviewSession(createReviewSession(input), {
      sessionId: 'exact-session',
      answers: [{ questionId: 'q1', answer: '传输控制协议' }],
      submittedAt: BASE + 2000,
    });
    assert.deepEqual(
      [exact.results[0].correct, exact.results[0].confidence, exact.results[0].gradingMethod],
      [true, 1, 'deterministic'],
    );
  });
});

describe('mistake repair lifecycle', () => {
  it('requires an independent delayed confirmation before verification', () => {
    const opened = recordMistake([], {
      conceptKey: ' TCP ', source: 'Exercise', sourceRef: 'e1', occurredAt: BASE,
    });
    assert.equal(opened[0].status, 'open');

    const immediate = applyMistakeEvidence(opened, correctEvidence('repair-1', 'repair-session', BASE + 1000));
    assert.equal(immediate[0].status, 'repairing');

    const sameSession = applyMistakeEvidence(immediate, correctEvidence('verify-1', 'repair-session', BASE + 2 * DAY));
    assert.equal(sameSession[0].status, 'repairing');

    const verified = applyMistakeEvidence(immediate, correctEvidence('verify-2', 'verify-session', BASE + DAY + 1000));
    assert.equal(verified[0].status, 'verified');
  });

  it('does not treat dismissing a mistake as mastery evidence', () => {
    const opened = recordMistake([], {
      conceptKey: 'tcp', source: 'Exercise', sourceRef: 'e1', occurredAt: BASE,
    });
    const dismissed = dismissMistake(opened, 'tcp', BASE + 1000, 'not relevant');
    assert.equal(dismissed[0].status, 'dismissed');
    assert.equal(Object.hasOwn(dismissed[0], 'masteryEvidence'), false);
  });

  it('keeps verified and already-dismissed Mistake Records terminal', () => {
    const opened = recordMistake([], {
      conceptKey: 'tcp', source: 'Exercise', sourceRef: 'e1', occurredAt: BASE,
    });
    const dismissed = dismissMistake(opened, 'tcp', BASE + 1000, 'first reason');
    assert.deepEqual(dismissMistake(dismissed, 'tcp', BASE + 2000, 'replacement'), dismissed);

    const repairing = applyMistakeEvidence(opened, correctEvidence('repair', 'repair', BASE + 1000));
    const verified = applyMistakeEvidence(repairing, correctEvidence('verify', 'verify', BASE + DAY + 1000));
    assert.deepEqual(dismissMistake(verified, 'tcp', BASE + 2 * DAY, 'replacement'), verified);
  });
});

describe('Today Review', () => {
  it('deduplicates topics, applies priority, and stops at the time budget', () => {
    const plans = [
      {
        id: 'p1', name: 'One', topics: [
          {
            id: 'open', title: 'Open', estimatedReviewMinutes: 10,
            mistakeRecords: [{ conceptKey: 'x', status: 'open', openedAt: BASE }],
            reviewSchedule: { ...createReviewSchedule(BASE), dueAt: BASE - DAY },
            reviewSession: createReviewSession({
              id: 'active', planId: 'p1', topicId: 'open', topicTitle: 'Open', createdAt: BASE,
              questions: [{ id: 'q1', prompt: 'Q', expectedAnswer: 'secret' }],
            }),
          },
          {
            id: 'overdue', title: 'Overdue', estimatedReviewMinutes: 15,
            mistakeRecords: [], reviewSchedule: { ...createReviewSchedule(BASE), dueAt: BASE - 3 * DAY },
          },
        ],
      },
      {
        id: 'p2', name: 'Two', topics: [
          {
            id: 'due', title: 'Due', estimatedReviewMinutes: 10,
            mistakeRecords: [], reviewSchedule: { ...createReviewSchedule(BASE), dueAt: BASE },
          },
        ],
      },
    ];

    const result = buildTodayReview(plans, { now: BASE, budgetMinutes: 30 });
    assert.deepEqual(result.items.map(item => item.topicId), ['open', 'overdue']);
    assert.equal(result.items[0].reason, 'open-mistake');
    assert.deepEqual(result.items[0].mistake, { conceptKey: 'x', status: 'open' });
    assert.equal(Object.hasOwn(result.items[0].activeSession.questions[0], 'expectedAnswer'), false);
    assert.equal(result.scheduledMinutes, 25);
    assert.equal(result.remainingCount, 1);
    assert.equal(new Set(result.items.map(item => item.topicId)).size, result.items.length);
  });

  it('keeps a deferred Topic out of the queue even when it has an open mistake', () => {
    const plans = [{
      id: 'p1', name: 'One', topics: [{
        id: 'deferred', title: 'Deferred', estimatedReviewMinutes: 5,
        reviewDeferredUntil: BASE + DAY,
        mistakeRecords: [{ conceptKey: 'tcp', status: 'open', openedAt: BASE - DAY }],
        reviewSchedule: { ...createReviewSchedule(BASE), dueAt: BASE - DAY },
      }],
    }];

    assert.equal(buildTodayReview(plans, { now: BASE, budgetMinutes: 30 }).totalCount, 0);
    assert.equal(buildTodayReview(plans, { now: BASE + DAY, budgetMinutes: 30 }).items[0].reason, 'open-mistake');
  });

  it('recomputes completion, overdue, repair, duplicate, and budget metrics', () => {
    const duplicate = correctEvidence('same-ref', 's1', BASE);
    const metrics = computeMasteryMetrics([{
      id: 'p1',
      topics: [
        {
          id: 't1', title: 'TCP', estimatedReviewMinutes: 20,
          reviewSchedule: { ...createReviewSchedule(BASE), dueAt: BASE - DAY },
          reviewCompletionCount: 3,
          reviewDeferralCount: 1,
          masteryEvidence: [duplicate, { ...duplicate }],
          mistakeRecords: [{
            conceptKey: 'tcp', status: 'verified', openedAt: BASE - 3 * DAY, verifiedAt: BASE - DAY,
          }],
        },
        {
          id: 't2', title: 'UDP', estimatedReviewMinutes: 20,
          reviewSchedule: { ...createReviewSchedule(BASE), dueAt: BASE },
          masteryEvidence: [], mistakeRecords: [],
        },
      ],
    }], BASE, { budgetMinutes: 30 });

    assert.equal(metrics.reviewCompletionRate, 0.75);
    assert.equal(metrics.averageOverdueDays, 0.5);
    assert.equal(metrics.averageMistakeRepairHours, 48);
    assert.equal(metrics.duplicateEvidence, 1);
    assert.equal(metrics.budgetOverrunCount, 1);
  });
});

describe('legacy migration', () => {
  it('keeps done as studied and only backfills stable timestamped evidence', () => {
    const migrated = migrateLegacyPlan({
      id: 'p1', name: 'Plan', topics: [{
        id: 't1', title: 'TCP', done: true,
        exercises: [
          { id: 'e1', gradedAt: BASE, correct: true, confidence: 0.95 },
          { correct: true, gradedAt: BASE },
        ],
      }],
      examPapers: [], quickQuizHistory: [],
    });

    assert.equal(migrated.masterySchemaVersion, MASTERY_SCHEMA_VERSION);
    assert.equal(migrated.topics[0].studied, true);
    assert.equal(migrated.topics[0].masteryEvidence.length, 1);
    assert.notEqual(migrated.topics[0].mastery.status, 'mastered');
  });

  it('does not use an Exam creation timestamp as grading evidence', () => {
    const migrated = migrateLegacyPlan({
      id: 'p1', name: 'Plan', topics: [{ id: 't1', title: 'TCP' }],
      examPapers: [{
        id: 'exam-1', createdAt: BASE,
        questions: [{ topicId: 't1' }],
        results: [{ exerciseIndex: 0, correct: true, confidence: 1 }],
      }],
      quickQuizHistory: [],
    });

    assert.equal(migrated.topics[0].masteryEvidence.length, 0);
  });
});
