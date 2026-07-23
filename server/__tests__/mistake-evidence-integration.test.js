import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  addExamPaper,
  addTopics,
  applyMasteryOutcome,
  clearFlag,
  createPlan,
  getPlan,
  permanentlyDeletePlan,
  saveExerciseResults,
  saveFeynmanResults,
  saveQuickQuizResults,
  saveReviewResults,
  saveReviewSession,
  updateExamResults,
  writePlan,
} from '../engine/learn-store.js';
import { createMasteryEvidence } from '../engine/mastery-scheduler.js';
import {
  dismissMistake,
  MISTAKE_VERIFICATION_DELAY_MS,
} from '../engine/mistake-ledger.js';
import { planPath, readJSON } from '../engine/store/storage.js';

const NOW = 1_700_000_000_000;
const createdPlanIds = new Set();
let fixtureSequence = 0;

async function createFixture(topicTitles) {
  fixtureSequence += 1;
  const plan = await createPlan(`mistake-evidence-${fixtureSequence}`, { testOnly: true });
  createdPlanIds.add(plan.id);
  const populated = await addTopics(plan.id, topicTitles);
  return { planId: plan.id, topics: populated.topics };
}

function findTopic(plan, topicId) {
  return plan.topics.find(topic => topic.id === topicId);
}

function evidenceForMistake(topic, mistake) {
  return topic.masteryEvidence.find(evidence => mistake.evidenceIds.includes(evidence.id));
}

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

describe('assessment evidence to Mistake Ledger integration', () => {
  it('records errors from every objective assessment source', async () => {
    const { planId, topics } = await createFixture([
      'Exercise Topic',
      'Quiz Topic',
      'Exam Topic',
      'Review Topic',
      'Repair Topic',
    ]);
    const [exerciseTopic, quizTopic, examTopic, reviewTopic, repairTopic] = topics;

    await saveExerciseResults(planId, exerciseTopic.id, [
      { id: 'exercise-item', question: 'Exercise?', conceptTag: 'Exercise Concept' },
    ], [
      { exerciseIndex: 0, correct: false, userAnswer: 'wrong' },
    ], {
      attemptRef: 'exercise-attempt-001',
      observedAt: NOW,
    });

    await saveQuickQuizResults(planId, {
      questions: [{ id: 'quiz-item', topicId: quizTopic.id, conceptTag: 'Quiz Concept' }],
      results: [{ exerciseIndex: 0, correct: false, userAnswer: 'wrong' }],
    }, {
      attemptRef: 'quick-quiz-attempt-001',
      observedAt: NOW + 1,
    });

    await addExamPaper(planId, {
      id: 'ledger-exam-001',
      title: 'Ledger Exam',
      config: {},
      paper: '',
      questions: [{ id: 'exam-item', topicId: examTopic.id, conceptTag: 'Exam Concept' }],
    });
    await updateExamResults(planId, 'ledger-exam-001', [
      { exerciseIndex: 0, correct: false, userAnswer: 'wrong' },
    ], {
      attemptRef: 'exam-attempt-001',
      observedAt: NOW + 2,
    });

    await saveReviewSession(planId, reviewTopic.id, {
      kind: 'review',
      content: 'Review content',
      exercises: [{ id: 'review-item', conceptTag: 'Review Concept' }],
    }, {
      now: NOW + 3,
      sessionId: 'review-session-001',
    });
    await saveReviewResults(planId, reviewTopic.id, [
      { exerciseIndex: 0, correct: false, userAnswer: 'wrong' },
    ], {
      context: 'review',
      sessionId: 'review-session-001',
      attemptRef: 'review-attempt-001',
      observedAt: NOW + 4,
    });

    await saveExerciseResults(planId, repairTopic.id, [
      { id: 'repair-seed-item', conceptTag: 'Repair Concept' },
    ], [
      { exerciseIndex: 0, correct: false, userAnswer: 'wrong' },
    ], {
      attemptRef: 'repair-seed-attempt',
      observedAt: NOW + 5,
    });
    const repairMistakeId = findTopic(getPlan(planId), repairTopic.id).mistakes[0].id;
    await saveReviewSession(planId, repairTopic.id, {
      kind: 'repair',
      mistakeId: repairMistakeId,
      content: 'Repair content',
      exercises: [{ id: 'repair-item', conceptTag: 'Repair Concept' }],
    }, {
      now: NOW + 6,
      sessionId: 'repair-session-001',
    });
    await saveReviewResults(planId, repairTopic.id, [
      { exerciseIndex: 0, correct: false, userAnswer: 'wrong' },
    ], {
      context: 'repair',
      sessionId: 'repair-session-001',
      mistakeId: repairMistakeId,
      attemptRef: 'repair-attempt-001',
      observedAt: NOW + 7,
    });

    const persisted = getPlan(planId);
    const expectedSources = ['exercise', 'quickQuiz', 'exam', 'review'];
    for (const [index, expectedSource] of expectedSources.entries()) {
      const topic = findTopic(persisted, topics[index].id);
      assert.equal(topic.mistakes.length, 1);
      assert.equal(topic.mistakes[0].status, 'open');
      assert.equal(topic.mistakes[0].occurrenceCount, 1);
      assert.equal(evidenceForMistake(topic, topic.mistakes[0]).source, expectedSource);
    }
    const persistedRepair = findTopic(persisted, repairTopic.id);
    const repairSources = persistedRepair.masteryEvidence
      .filter(evidence => persistedRepair.mistakes[0].evidenceIds.includes(evidence.id))
      .map(evidence => evidence.source);
    assert.equal(persistedRepair.mistakes.length, 1);
    assert.equal(persistedRepair.mistakes[0].occurrenceCount, 2);
    assert.equal(persistedRepair.mistakes[0].severity, 'high');
    assert.ok(repairSources.includes('repair'));
  });

  it('merges cross-source recurrence, ignores replay and Feynman, and verifies at 24 hours', async () => {
    const { planId, topics: [objectiveTopic, feynmanTopic] } = await createFixture([
      'Array Methods',
      'Feynman Topic',
    ]);
    await addExamPaper(planId, {
      id: 'verification-exam-001',
      title: 'Verification Exam',
      config: {},
      paper: '',
      questions: [{
        id: 'verification-item',
        topicId: objectiveTopic.id,
        conceptTag: 'Array Methods',
      }],
    });

    const quizData = {
      questions: [{
        id: 'recurrence-quiz-item',
        topicId: objectiveTopic.id,
        conceptTag: ' Array   Methods ',
      }],
      results: [{ exerciseIndex: 0, correct: false, userAnswer: 'wrong' }],
    };
    const quizOptions = {
      attemptRef: 'recurrence-quiz-attempt',
      observedAt: NOW,
    };
    await saveQuickQuizResults(planId, quizData, quizOptions);
    await saveQuickQuizResults(planId, quizData, quizOptions);

    let topic = findTopic(getPlan(planId), objectiveTopic.id);
    assert.equal(topic.mistakes[0].occurrenceCount, 1);
    assert.equal(topic.masteryEvidence.filter(item => item.source === 'quickQuiz').length, 1);

    await saveExerciseResults(planId, objectiveTopic.id, [
      { id: 'recurrence-exercise-item', conceptTag: 'Ａrray Methods' },
    ], [
      { exerciseIndex: 0, correct: false, userAnswer: 'wrong again' },
    ], {
      attemptRef: 'recurrence-exercise-attempt',
      observedAt: NOW + 100,
    });

    topic = findTopic(getPlan(planId), objectiveTopic.id);
    assert.equal(topic.mistakes.length, 1);
    assert.equal(topic.mistakes[0].conceptKey, 'array methods');
    assert.equal(topic.mistakes[0].occurrenceCount, 2);
    assert.equal(topic.mistakes[0].severity, 'high');

    const verifiedAt = NOW + 100 + MISTAKE_VERIFICATION_DELAY_MS;
    await updateExamResults(planId, 'verification-exam-001', [
      { exerciseIndex: 0, correct: true, userAnswer: 'correct' },
    ], {
      attemptRef: 'verification-exam-attempt',
      observedAt: verifiedAt,
    });
    await saveFeynmanResults(planId, feynmanTopic.id, {
      teachingQuality: 'needsWork',
      gaps: ['This gap is not an objective mistake'],
    }, {
      attemptRef: 'feynman-gap-attempt',
      observedAt: verifiedAt + 1,
    });

    const persisted = getPlan(planId);
    topic = findTopic(persisted, objectiveTopic.id);
    const mistake = topic.mistakes[0];
    const verificationEvidence = topic.masteryEvidence.find(item => (
      item.id === mistake.verificationEvidenceId
    ));
    assert.equal(mistake.status, 'verified');
    assert.equal(mistake.verifiedAt, verifiedAt);
    assert.equal(verificationEvidence.source, 'exam');
    assert.equal(findTopic(persisted, feynmanTopic.id).mistakes.length, 0);
  });

  it('protects active evidence and releases it after verification or dismissal', async () => {
    const { planId, topics: [verifiedTopic, dismissedTopic] } = await createFixture([
      'Verified Retention',
      'Dismissed Retention',
    ]);
    const verifiedSeed = await seedEvidenceAtLimit(planId, verifiedTopic.id, 'verified');
    const dismissedSeed = await seedEvidenceAtLimit(planId, dismissedTopic.id, 'dismissed');

    const verificationAt = NOW + MISTAKE_VERIFICATION_DELAY_MS;
    await applyMasteryOutcome(planId, {
      source: 'exam',
      attemptRef: 'verified-correction-attempt',
      observedAt: verificationAt,
      items: [{
        topicId: verifiedTopic.id,
        itemRef: 'verified-correction-item',
        correct: true,
        conceptTags: ['Verified Retention Concept'],
      }],
    });

    let topic = findTopic(getPlan(planId), verifiedTopic.id);
    assert.equal(topic.masteryEvidence.length, 200);
    assert.ok(topic.masteryEvidence.some(item => item.id === verifiedSeed.errorEvidenceId));
    assert.ok(!topic.masteryEvidence.some(item => item.id === verifiedSeed.firstFillerId));
    assert.equal(topic.mistakes[0].status, 'verified');

    await applyMasteryOutcome(planId, {
      source: 'exercise',
      attemptRef: 'verified-next-compression',
      observedAt: verificationAt + 1,
      items: [{
        topicId: verifiedTopic.id,
        itemRef: 'verified-next-item',
        correct: true,
        conceptTags: ['Different Concept'],
      }],
    });
    topic = findTopic(getPlan(planId), verifiedTopic.id);
    assert.equal(topic.masteryEvidence.length, 200);
    assert.ok(!topic.masteryEvidence.some(item => item.id === verifiedSeed.errorEvidenceId));

    await writePlan(planId, plan => {
      const target = findTopic(plan, dismissedTopic.id);
      target.mistakes = dismissMistake(
        target.mistakes,
        target.mistakes[0].id,
        'Not part of this learning goal',
        { now: NOW + 500 }
      ).mistakes;
    });
    await applyMasteryOutcome(planId, {
      source: 'review',
      attemptRef: 'dismissed-next-compression',
      observedAt: NOW + 501,
      items: [{
        topicId: dismissedTopic.id,
        itemRef: 'dismissed-next-item',
        correct: true,
        conceptTags: ['Different Concept'],
      }],
    });
    topic = findTopic(getPlan(planId), dismissedTopic.id);
    assert.equal(topic.mistakes[0].status, 'dismissed');
    assert.equal(topic.masteryEvidence.length, 200);
    assert.ok(!topic.masteryEvidence.some(item => item.id === dismissedSeed.errorEvidenceId));
  });

  it('rolls back result, evidence, mastery, schedule, and mistakes when the Plan write fails', async () => {
    const { planId, topics: [topic] } = await createFixture(['Write Failure Topic']);
    const targetPath = path.resolve(planPath(planId));
    const tempPath = `${targetPath}.tmp.${process.pid}`;
    const beforeCache = structuredClone(getPlan(planId));
    const beforeDisk = structuredClone(readJSON(targetPath));
    const originalRenameSync = fs.renameSync;
    const originalCopyFileSync = fs.copyFileSync;

    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === targetPath) throw new Error('injected rename failure');
      return originalRenameSync(source, destination);
    };
    fs.copyFileSync = (source, destination, ...args) => {
      if (path.resolve(destination) === targetPath) throw new Error('injected copy failure');
      return originalCopyFileSync(source, destination, ...args);
    };

    try {
      await assert.rejects(
        () => saveExerciseResults(planId, topic.id, [
          { id: 'failed-write-item', conceptTag: 'Failed Write Concept' },
        ], [
          { exerciseIndex: 0, correct: false, userAnswer: 'wrong' },
        ], {
          attemptRef: 'failed-write-attempt',
          observedAt: NOW,
        }),
        /CRITICAL: Data write failed/
      );
    } finally {
      fs.renameSync = originalRenameSync;
      fs.copyFileSync = originalCopyFileSync;
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }

    assert.deepEqual(getPlan(planId), beforeCache);
    assert.deepEqual(readJSON(targetPath), beforeDisk);
  });
});

async function seedEvidenceAtLimit(planId, topicId, prefix) {
  const conceptTag = `${prefix[0].toUpperCase()}${prefix.slice(1)} Retention Concept`;
  await applyMasteryOutcome(planId, {
    source: 'exercise',
    attemptRef: `${prefix}-seed-error-attempt`,
    observedAt: NOW,
    items: [{
      topicId,
      itemRef: `${prefix}-seed-error-item`,
      correct: false,
      conceptTags: [conceptTag],
    }],
  });
  const errorEvidenceId = findTopic(getPlan(planId), topicId).masteryEvidence[0].id;
  const fillers = Array.from({ length: 199 }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    const attemptRef = `${prefix}-filler-${suffix}`;
    return createMasteryEvidence({
      source: 'exercise',
      attemptRef,
      sourceRef: `${attemptRef}:item`,
      observedAt: NOW + index + 1,
      score: 1,
      quality: 5,
      confidence: 'high',
      conceptTags: [`Filler ${suffix}`],
    });
  });
  await writePlan(planId, plan => {
    const topic = findTopic(plan, topicId);
    topic.masteryEvidence = [...topic.masteryEvidence, ...fillers];
  });
  return { errorEvidenceId, firstFillerId: fillers[0].id };
}
