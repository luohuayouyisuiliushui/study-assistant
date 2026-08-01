import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  addTopics,
  appendTopicMasteryEvidence,
  createMasteryBackup,
  createOrResumeMistakeRepairSession,
  createOrResumeReviewSession,
  createPlan,
  deferTopicReview,
  dismissTopicMistake,
  getMasteryMetrics,
  getMasteryState,
  getTodayReview,
  listPlans,
  previewMasteryRestore,
  restoreMasteryBackup,
  submitTopicReviewSession,
  updateTopic,
} from '../engine/learn-store.js';
import { MASTERY_SCHEMA_VERSION } from '../engine/mastery-engine.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1, 8);

async function createTopic(title = 'TCP') {
  const plan = await createPlan(`mastery-store-${title}`);
  const withTopic = await addTopics(plan.id, [title]);
  return { planId: plan.id, topicId: withTopic.topics[0].id };
}

describe('mastery store', () => {
  it('conservatively migrates legacy studied state through the Plan write boundary', async () => {
    const { planId, topicId } = await createTopic('Legacy');
    await updateTopic(planId, topicId, { done: true });

    const state = await getMasteryState(planId, topicId, { now: BASE });

    assert.equal(state.schemaVersion, MASTERY_SCHEMA_VERSION);
    assert.equal(state.topic.studied, true);
    assert.equal(state.topic.mastery.status, 'unassessed');
    assert.equal(state.topic.masteryEvidence.length, 0);
    assert.equal(state.topic.reviewSchedule.dueAt, BASE);
  });

  it('resumes one fixed session and atomically applies submitted evidence, mistakes, and schedule', async () => {
    const { planId, topicId } = await createTopic('Sessions');
    const first = await createOrResumeReviewSession(planId, topicId, {
      sessionId: 'review-1',
      createdAt: BASE,
      questions: [
        { id: 'q1', prompt: '可靠传输？', expectedAnswer: '是', conceptKey: 'TCP' },
        { id: 'q2', prompt: '无连接？', expectedAnswer: '否', conceptKey: 'TCP' },
      ],
    });
    const resumed = await createOrResumeReviewSession(planId, topicId, {
      sessionId: 'ignored',
      createdAt: BASE + 1,
      questions: [{ id: 'other', prompt: '被忽略', expectedAnswer: '被忽略' }],
    });

    assert.equal(first.resumed, false);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.session.id, 'review-1');
    assert.deepEqual(resumed.session.questions.map(question => question.id), ['q1', 'q2']);
    assert.equal(Object.hasOwn(resumed.session.questions[0], 'expectedAnswer'), false);

    await assert.rejects(
      () => submitTopicReviewSession(planId, topicId, {
        sessionId: 'wrong',
        answers: [{ questionId: 'q1', answer: '是' }],
        submittedAt: BASE + 1000,
      }),
      /sessionId/,
    );

    const submitted = await submitTopicReviewSession(planId, topicId, {
      sessionId: 'review-1',
      answers: [
        { questionId: 'q1', answer: '是' },
        { questionId: 'q2', answer: '是' },
      ],
      submittedAt: BASE + 1000,
    });

    assert.deepEqual(submitted.results.map(result => result.correct), [true, false]);
    assert.equal(submitted.state.topic.masteryEvidence.length, 2);
    assert.equal(submitted.state.topic.reviewSchedule.lapses, 1);
    assert.equal(submitted.state.topic.mistakeRecords[0].status, 'open');
    await assert.rejects(
      () => submitTopicReviewSession(planId, topicId, {
        sessionId: 'review-1', answers: [], submittedAt: BASE + 2000,
      }),
      /not active/,
    );
  });

  it('does not advance mastery or SM-2 for the ungraded fallback recall', async () => {
    const { planId, topicId } = await createTopic('Fallback');
    const created = await createOrResumeReviewSession(planId, topicId, {
      sessionId: 'fallback-review',
      createdAt: BASE,
    });
    const before = await getMasteryState(planId, topicId, { now: BASE });

    const submitted = await submitTopicReviewSession(planId, topicId, {
      sessionId: created.session.id,
      answers: [{ questionId: 'topic-recall', answer: 'Fallback' }],
      submittedAt: BASE + 1000,
    });

    assert.equal(submitted.results[0].correct, true);
    assert.equal(submitted.state.topic.masteryEvidence[0].gradingMethod, 'ai');
    assert.equal(submitted.state.topic.masteryEvidence[0].confidence, 0.5);
    assert.equal(submitted.state.topic.mastery.status, 'learning');
    assert.deepEqual(submitted.state.topic.reviewSchedule, before.topic.reviewSchedule);
  });

  it('defers a Topic-level mistake queue item until the requested time', async () => {
    const { planId, topicId } = await createTopic('Deferred mistake');
    await appendTopicMasteryEvidence(planId, topicId, {
      source: 'Exercise', sourceRef: 'defer-error', sessionId: 'defer-session', occurredAt: BASE,
      correct: false, confidence: 1, gradingMethod: 'deterministic', conceptKey: 'deferred mistake',
    });

    assert.ok(getTodayReview({ now: BASE }).items.some(item => item.planId === planId));
    await deferTopicReview(planId, topicId, BASE + DAY, { now: BASE });
    assert.equal(getTodayReview({ now: BASE + 1 }).items.some(item => item.planId === planId), false);
    assert.ok(getTodayReview({ now: BASE + DAY }).items.some(item => item.planId === planId));
  });

  it('keeps Mistake Record terminal states stable when dismissing', async () => {
    const { planId, topicId } = await createTopic('Dismiss lifecycle');
    await appendTopicMasteryEvidence(planId, topicId, {
      source: 'Exercise', sourceRef: 'dismiss-error', sessionId: 'dismiss-error-session',
      occurredAt: BASE, correct: false, confidence: 1,
      gradingMethod: 'deterministic', conceptKey: 'dismiss lifecycle',
    });
    const first = await dismissTopicMistake(planId, topicId, 'dismiss lifecycle', {
      dismissedAt: BASE + 1, reason: 'not relevant',
    });
    const repeated = await dismissTopicMistake(planId, topicId, 'dismiss lifecycle', {
      dismissedAt: BASE + 2, reason: 'replacement',
    });
    assert.deepEqual(repeated.topic.mistakeRecords[0], first.topic.mistakeRecords[0]);

    const verifiedFixture = await createTopic('Verified lifecycle');
    for (const evidence of [
      { sourceRef: 'verified-error', sessionId: 'verified-error', occurredAt: BASE, correct: false },
      { sourceRef: 'verified-repair', sessionId: 'verified-repair', occurredAt: BASE + 1, correct: true },
      { sourceRef: 'verified-proof', sessionId: 'verified-proof', occurredAt: BASE + DAY + 1, correct: true },
    ]) {
      await appendTopicMasteryEvidence(verifiedFixture.planId, verifiedFixture.topicId, {
        source: 'Exercise', confidence: 1, gradingMethod: 'deterministic',
        conceptKey: 'verified lifecycle', ...evidence,
      });
    }
    await assert.rejects(
      () => dismissTopicMistake(verifiedFixture.planId, verifiedFixture.topicId, 'verified lifecycle'),
      /verified Mistake Record/i,
    );
  });

  it('builds a Mistake Repair session only from the targeted concept', async () => {
    const { planId, topicId } = await createTopic('Targeted repair');
    await updateTopic(planId, topicId, { exercises: [
      { id: 'tcp-question', question: 'TCP handshake?', answer: 'SYN', conceptTag: 'TCP Handshake' },
      { id: 'udp-question', question: 'UDP handshake?', answer: 'None', conceptTag: 'UDP' },
    ] });
    await appendTopicMasteryEvidence(planId, topicId, {
      source: 'Exercise', sourceRef: 'target-error', sessionId: 'target-error-session', occurredAt: BASE,
      correct: false, confidence: 1, gradingMethod: 'deterministic', conceptKey: 'TCP  Handshake',
    });

    const repair = await createOrResumeMistakeRepairSession(
      planId,
      topicId,
      'tcp_handshake',
      { sessionId: 'target-repair', createdAt: BASE + 1,
        questions: [{ id: 'injected', prompt: 'Injected', expectedAnswer: 'yes' }] },
    );

    assert.equal(repair.session.targetConceptKey, 'tcp handshake');
    assert.deepEqual(repair.session.questions.map(question => question.id), ['tcp-question']);
  });

  it('deduplicates evidence at the durable boundary', async () => {
    const { planId, topicId } = await createTopic('Evidence');
    const evidence = {
      source: 'Exercise', sourceRef: 'exercise-1', sessionId: 'practice-1',
      occurredAt: BASE, correct: true, confidence: 1, gradingMethod: 'deterministic',
      conceptKey: 'evidence',
    };

    const first = await appendTopicMasteryEvidence(planId, topicId, evidence);
    const duplicate = await appendTopicMasteryEvidence(planId, topicId, { ...evidence, correct: false });

    assert.equal(first.added, true);
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.state.topic.masteryEvidence.length, 1);
    assert.equal(duplicate.state.topic.masteryEvidence[0].correct, true);
    assert.equal(duplicate.state.topic.reviewSchedule.intervalDays, 0);
    assert.equal(duplicate.state.topic.reviewSchedule.dueAt, BASE);
  });

  it('computes budget overruns from the selected daily review budget', async () => {
    const plan = await createPlan('mastery-store-metrics-budget');
    const withTopics = await addTopics(plan.id, ['Budget one', 'Budget two']);
    for (const [index, topic] of withTopics.topics.entries()) {
      await appendTopicMasteryEvidence(plan.id, topic.id, {
        source: 'Exercise', sourceRef: `budget-${index}`, sessionId: `budget-session-${index}`,
        occurredAt: BASE, correct: false, confidence: 1,
        gradingMethod: 'deterministic', conceptKey: topic.title,
      });
    }

    const constrained = getMasteryMetrics({ now: BASE, budgetMinutes: 10 });
    const spacious = getMasteryMetrics({ now: BASE, budgetMinutes: 120 });
    assert.ok(constrained.budgetOverrunCount > spacious.budgetOverrunCount);
  });

  it('previews and restores a versioned full-state backup', async () => {
    const { planId, topicId } = await createTopic('Backup');
    await createOrResumeReviewSession(planId, topicId, {
      sessionId: 'persisted-session', createdAt: BASE,
      questions: [{ id: 'q1', prompt: '问题', expectedAnswer: '答案' }],
    });
    await appendTopicMasteryEvidence(planId, topicId, {
      source: 'Exercise', sourceRef: 'e1', sessionId: 's1', occurredAt: BASE,
      correct: true, confidence: 1, gradingMethod: 'deterministic', conceptKey: 'backup',
    });
    const before = await getMasteryState(planId, topicId, { now: BASE });
    const backup = await createMasteryBackup({ now: BASE + DAY });

    await deferTopicReview(planId, topicId, BASE + 7 * DAY, { now: BASE + DAY });
    const preview = await previewMasteryRestore(backup);
    assert.equal(preview.valid, true);
    assert.ok(preview.updatedPlanIds.includes(planId));
    assert.equal(preview.counts.sessions >= 1, true);

    await restoreMasteryBackup(backup);
    const restored = await getMasteryState(planId, topicId, { now: BASE + DAY });
    assert.deepEqual(restored.topic.masteryEvidence, before.topic.masteryEvidence);
    assert.deepEqual(restored.topic.reviewSchedule, before.topic.reviewSchedule);
    assert.deepEqual(restored.topic.reviewSession, before.topic.reviewSession);
  });

  it('rejects corrupt nested mastery state during restore preview', async () => {
    const { planId, topicId } = await createTopic('Invalid backup');
    await appendTopicMasteryEvidence(planId, topicId, {
      source: 'Exercise', sourceRef: 'invalid-backup-evidence', sessionId: 'invalid-backup-session',
      occurredAt: BASE, correct: true, confidence: 1, gradingMethod: 'deterministic', conceptKey: 'backup',
    });
    const backup = structuredClone(await createMasteryBackup({ now: BASE }));
    const plan = backup.plans.find(item => item.id === planId);
    const topic = plan.topics.find(item => item.id === topicId);
    topic.masteryEvidence[0].confidence = 2;

    await assert.rejects(() => previewMasteryRestore(backup), error =>
      error.code === 'INVALID_BACKUP' && /Evidence/i.test(error.message)
    );
  });

  it('rejects invalid Plan timestamps during restore preview', async () => {
    const { planId } = await createTopic('Invalid backup timestamp');
    const backup = structuredClone(await createMasteryBackup({ now: BASE }));
    backup.plans.find(plan => plan.id === planId).createdAt = { invalid: true };

    await assert.rejects(() => previewMasteryRestore(backup), /Plan timestamps/i);
  });

  it('rejects duplicate Evidence and duplicate completed-session results', async () => {
    const { planId, topicId } = await createTopic('Duplicate backup state');
    await appendTopicMasteryEvidence(planId, topicId, {
      source: 'Exercise', sourceRef: 'duplicate-backup-evidence', sessionId: 'duplicate-backup-session',
      occurredAt: BASE, correct: true, confidence: 1, gradingMethod: 'deterministic', conceptKey: 'duplicate',
    });
    await createOrResumeReviewSession(planId, topicId, {
      sessionId: 'completed-backup-session', createdAt: BASE,
      questions: [
        { id: 'q1', prompt: 'One?', expectedAnswer: 'one' },
        { id: 'q2', prompt: 'Two?', expectedAnswer: 'two' },
      ],
    });
    await submitTopicReviewSession(planId, topicId, {
      sessionId: 'completed-backup-session', submittedAt: BASE + 1,
      answers: [{ questionId: 'q1', answer: 'one' }, { questionId: 'q2', answer: 'two' }],
    });

    const valid = structuredClone(await createMasteryBackup({ now: BASE + 2 }));
    const validTopic = valid.plans.find(plan => plan.id === planId).topics.find(topic => topic.id === topicId);
    const duplicateEvidence = structuredClone(valid);
    const evidenceTopic = duplicateEvidence.plans.find(plan => plan.id === planId).topics.find(topic => topic.id === topicId);
    evidenceTopic.masteryEvidence.push(structuredClone(evidenceTopic.masteryEvidence[0]));
    await assert.rejects(() => previewMasteryRestore(duplicateEvidence), /duplicate Mastery Evidence/i);

    validTopic.reviewSession.results[1].questionId = 'q1';
    await assert.rejects(() => previewMasteryRestore(valid), /Review Session results/i);
  });

  it('restores Plan names consistently in the file and index', async () => {
    const { planId } = await createTopic('Restore index name');
    const backup = structuredClone(await createMasteryBackup({ now: BASE }));
    backup.plans.find(plan => plan.id === planId).name = 'Restored index name';

    await restoreMasteryBackup(backup);

    assert.equal(listPlans().find(plan => plan.id === planId).name, 'Restored index name');
  });

  it('preserves an unrelated index update that lands while restore writes Plan files', async () => {
    const { planId } = await createTopic('Restore concurrent index');
    const backup = structuredClone(await createMasteryBackup({ now: BASE }));
    const storage = await import('../engine/store/storage.js');
    const originalCopy = fs.copyFileSync;
    const concurrentId = 'restore-concurrent-index-entry';
    let injected = false;
    fs.copyFileSync = function(source, destination, ...args) {
      if (!injected && destination === `${storage.planPath(planId)}.bak`) {
        injected = true;
        const index = JSON.parse(fs.readFileSync(storage.PLANS_INDEX, 'utf8'));
        fs.writeFileSync(storage.PLANS_INDEX, JSON.stringify([
          ...index,
          { id: concurrentId, name: 'Concurrent', createdAt: BASE, updatedAt: BASE, topicCount: 0 },
        ], null, 2));
      }
      return originalCopy.call(this, source, destination, ...args);
    };

    try {
      await restoreMasteryBackup(backup);
      assert.equal(listPlans().some(plan => plan.id === concurrentId), true);
    } finally {
      fs.copyFileSync = originalCopy;
      await storage.removeIndexEntries(concurrentId);
    }
  });

  it('removes both backup layers when a new-Plan restore rolls back', async () => {
    const { planId } = await createTopic('Restore new rollback');
    const backup = structuredClone(await createMasteryBackup({ now: BASE }));
    const snapshot = backup.plans.find(plan => plan.id === planId);
    const newPlanId = 'restore-new-plan-rollback';
    snapshot.id = newPlanId;
    backup.plans = [snapshot];

    const storage = await import('../engine/store/storage.js');
    const originalRename = fs.renameSync;
    const originalCopy = fs.copyFileSync;
    let failIndexWrite = true;
    fs.renameSync = function(source, destination, ...args) {
      if (failIndexWrite && destination === storage.PLANS_INDEX) {
        throw new Error('simulated index rename failure');
      }
      return originalRename.call(this, source, destination, ...args);
    };
    fs.copyFileSync = function(source, destination, ...args) {
      if (failIndexWrite && destination === storage.PLANS_INDEX) {
        failIndexWrite = false;
        throw new Error('simulated index copy failure');
      }
      return originalCopy.call(this, source, destination, ...args);
    };

    try {
      await assert.rejects(() => restoreMasteryBackup(backup), /Data write failed/);
    } finally {
      fs.renameSync = originalRename;
      fs.copyFileSync = originalCopy;
    }

    assert.equal(fs.existsSync(storage.planPath(newPlanId)), false);
    assert.equal(fs.existsSync(`${storage.planPath(newPlanId)}.bak`), false);
    assert.equal(fs.existsSync(path.join(storage.BACKUP_DIR, `${newPlanId}.json`)), false);
  });

  it('holds each Plan write queue for the full multi-Plan lock callback', async () => {
    const { planId } = await createTopic('Restore lock ordering');
    const { enqueueWrite, withPlanWriteLocks } = await import('../engine/store/storage.js');
    const events = [];
    let releaseFirst;
    let releaseLock;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const lockGate = new Promise(resolve => { releaseLock = resolve; });
    const first = enqueueWrite(planId, async () => {
      events.push('first-start');
      await firstGate;
      events.push('first-end');
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const locked = withPlanWriteLocks([planId], async () => {
      events.push('lock-start');
      await lockGate;
      events.push('lock-end');
    });
    releaseFirst();
    while (!events.includes('lock-start')) await new Promise(resolve => setTimeout(resolve, 0));
    const after = enqueueWrite(planId, async () => { events.push('after'); });
    releaseLock();

    await Promise.all([first, locked, after]);
    assert.deepEqual(events, ['first-start', 'first-end', 'lock-start', 'lock-end', 'after']);
  });
});
