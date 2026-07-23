import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMasteryEvidence } from '../engine/mastery-scheduler.js';
import {
  MISTAKE_VERIFICATION_DELAY_MS,
  applyEvidenceToMistakeLedger,
  dismissMistake,
  getActiveMistakeEvidenceIds,
  startMistakeRepair,
} from '../engine/mistake-ledger.js';

const NOW = 1_700_000_000_000;

function evidence({
  item = 'item-1',
  attemptRef = 'attempt-001',
  source = 'exercise',
  observedAt = NOW,
  score = 0,
  quality = 0,
  confidence = 'high',
  conceptTags = ['闭包'],
} = {}) {
  return createMasteryEvidence({
    source,
    attemptRef,
    sourceRef: `${attemptRef}:${item}`,
    observedAt,
    score,
    quality,
    confidence,
    conceptTags,
  });
}

const idFactory = ({ conceptKey }) => `mistake-${conceptKey}`;

describe('Mistake Ledger state machine', () => {
  it('opens, deduplicates within one batch, and reopens recurring concepts', () => {
    const initial = [];
    const firstBatch = [
      evidence({ item: 'wrong-1', conceptTags: [' 闭包 '] }),
      evidence({ item: 'wrong-2', score: 0.5, quality: 2, conceptTags: ['閉包', '闭包'] }),
    ];

    const first = applyEvidenceToMistakeLedger(initial, firstBatch, {
      topicTitle: 'JavaScript 闭包',
      idFactory,
    });

    assert.deepEqual(initial, []);
    assert.equal(first.changed, true);
    assert.equal(first.mistakes.length, 2);
    const simplified = first.mistakes.find(record => record.conceptKey === '闭包');
    assert.equal(simplified.status, 'open');
    assert.equal(simplified.severity, 'medium');
    assert.equal(simplified.occurrenceCount, 1);
    assert.deepEqual(simplified.evidenceIds, [firstBatch[0].id, firstBatch[1].id]);

    const verified = applyEvidenceToMistakeLedger(first.mistakes, [evidence({
      item: 'verified',
      attemptRef: 'attempt-002',
      observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS,
      score: 0.8,
      quality: 4,
      conceptTags: ['闭包'],
    })], { topicTitle: 'JavaScript 闭包', idFactory });
    assert.equal(verified.mistakes.find(record => record.conceptKey === '闭包').status, 'verified');

    const recurringEvidence = evidence({
      item: 'wrong-again',
      attemptRef: 'attempt-003',
      source: 'exam',
      observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS + 1,
      conceptTags: ['闭包'],
    });
    const reopened = applyEvidenceToMistakeLedger(verified.mistakes, [recurringEvidence], {
      topicTitle: 'JavaScript 闭包',
      idFactory,
    });
    const record = reopened.mistakes.find(item => item.conceptKey === '闭包');
    assert.equal(record.status, 'open');
    assert.equal(record.severity, 'high');
    assert.equal(record.occurrenceCount, 2);
    assert.equal(record.verificationDueAt, null);
    assert.equal(record.verifiedAt, null);
    assert.equal(record.verificationEvidenceId, null);
    assert.equal(record.dismissedAt, null);
    assert.equal(record.dismissReason, null);
  });

  it('verifies only at the exact delay and score boundaries', () => {
    const opened = applyEvidenceToMistakeLedger([], [evidence()], {
      topicTitle: '闭包',
      idFactory,
    }).mistakes;

    const early = applyEvidenceToMistakeLedger(opened, [evidence({
      item: 'early',
      attemptRef: 'attempt-early',
      observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS - 1,
      score: 1,
      quality: 5,
    })], { topicTitle: '闭包', idFactory }).mistakes[0];
    assert.equal(early.status, 'repairing');
    assert.equal(early.verificationDueAt, NOW + MISTAKE_VERIFICATION_DELAY_MS);
    assert.equal(early.verifiedAt, null);

    const lowScore = applyEvidenceToMistakeLedger(opened, [evidence({
      item: 'low-score',
      attemptRef: 'attempt-low-score',
      observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS,
      score: 0.79,
      quality: 4,
    })], { topicTitle: '闭包', idFactory }).mistakes[0];
    assert.equal(lowScore.status, 'open');

    const exactEvidence = evidence({
      item: 'exact',
      attemptRef: 'attempt-exact',
      observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS,
      score: 0.8,
      quality: 4,
    });
    const exact = applyEvidenceToMistakeLedger(opened, [exactEvidence], {
      topicTitle: '闭包',
      idFactory,
    }).mistakes[0];
    assert.equal(exact.status, 'verified');
    assert.equal(exact.verifiedAt, NOW + MISTAKE_VERIFICATION_DELAY_MS);
    assert.equal(exact.verificationEvidenceId, exactEvidence.id);
    assert.equal(exact.verificationDueAt, null);
  });

  it('rejects illegal records, transitions, and dismiss reasons without mutating input', () => {
    const opened = applyEvidenceToMistakeLedger([], [evidence()], {
      topicTitle: '闭包',
      idFactory,
    }).mistakes;
    const before = structuredClone(opened);

    assert.throws(() => dismissMistake(opened, opened[0].id, '   ', { now: NOW + 1 }), /reason/);
    assert.throws(() => dismissMistake(opened, opened[0].id, 'x'.repeat(201), { now: NOW + 1 }), /reason/);
    assert.deepEqual(opened, before);

    const dismissed = dismissMistake(opened, opened[0].id, ' 已在其他练习中解决 ', { now: NOW + 1 });
    assert.equal(dismissed.mistakes[0].status, 'dismissed');
    assert.equal(dismissed.mistakes[0].dismissReason, '已在其他练习中解决');
    assert.throws(() => dismissMistake(dismissed.mistakes, opened[0].id, '再次忽略', { now: NOW + 2 }), /transition/);

    const verified = applyEvidenceToMistakeLedger(opened, [evidence({
      item: 'verified',
      attemptRef: 'attempt-verified',
      observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS,
      score: 1,
      quality: 5,
    })], { topicTitle: '闭包', idFactory }).mistakes;
    assert.throws(() => startMistakeRepair(verified, verified[0].id, { now: NOW + MISTAKE_VERIFICATION_DELAY_MS }), /transition/);
    assert.throws(() => applyEvidenceToMistakeLedger([{ ...opened[0], status: 'unknown' }], [], {
      topicTitle: '闭包',
      idFactory,
    }), /status/);
  });

  it('keeps same-session corrections in repairing and ignores ineligible correct evidence', () => {
    const sameSession = applyEvidenceToMistakeLedger([], [
      evidence({ item: 'wrong' }),
      evidence({
        item: 'corrected',
        observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS * 2,
        score: 1,
        quality: 5,
      }),
    ], { topicTitle: '闭包', idFactory }).mistakes[0];
    assert.equal(sameSession.status, 'repairing');
    assert.equal(sameSession.verifiedAt, null);
    assert.equal(sameSession.verificationDueAt, NOW + MISTAKE_VERIFICATION_DELAY_MS);

    const opened = applyEvidenceToMistakeLedger([], [evidence()], {
      topicTitle: '闭包',
      idFactory,
    }).mistakes;
    const ineligible = [
      evidence({ item: 'medium', attemptRef: 'attempt-ineligible', observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS, score: 1, quality: 5, confidence: 'medium' }),
      evidence({ item: 'feynman', attemptRef: 'attempt-ineligible', source: 'feynman', observedAt: NOW + MISTAKE_VERIFICATION_DELAY_MS, score: 1, quality: 4, confidence: 'medium' }),
    ];
    const ignored = applyEvidenceToMistakeLedger(opened, ineligible, {
      topicTitle: '闭包',
      idFactory,
    });
    assert.equal(ignored.changed, false);
    assert.deepEqual(ignored.mistakes, opened);
  });

  it('consumes MasteryEvidence batches with normalized fallback concepts and active evidence IDs', () => {
    const batch = [evidence({
      item: 'full-width',
      source: 'quickQuiz',
      conceptTags: [' Ａrray   Methods ', 'Array Methods'],
    })];
    const result = applyEvidenceToMistakeLedger([], batch, {
      topicTitle: 'Fallback Topic',
      idFactory,
    });

    assert.deepEqual(result.mistakes[0], {
      id: 'mistake-array methods',
      version: 1,
      conceptKey: 'array methods',
      conceptLabel: 'Array Methods',
      status: 'open',
      severity: 'medium',
      evidenceIds: [batch[0].id],
      occurrenceCount: 1,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      verificationDueAt: null,
      verifiedAt: null,
      verificationEvidenceId: null,
      dismissedAt: null,
      dismissReason: null,
    });
    assert.deepEqual(getActiveMistakeEvidenceIds(result.mistakes), [batch[0].id]);

    const fallback = applyEvidenceToMistakeLedger([], [evidence({ conceptTags: [] })], {
      topicTitle: '  Fallback   Topic ',
      idFactory,
    }).mistakes[0];
    assert.equal(fallback.conceptKey, 'fallback topic');
    assert.equal(fallback.conceptLabel, 'Fallback Topic');
  });
});

describe('learn engine compatibility', () => {
  it('re-exports the Mistake Ledger public API', async () => {
    const engine = await import('../engine/learn-engine.js');

    assert.equal(engine.applyEvidenceToMistakeLedger, applyEvidenceToMistakeLedger);
    assert.equal(engine.dismissMistake, dismissMistake);
    assert.equal(engine.startMistakeRepair, startMistakeRepair);
  });
});
