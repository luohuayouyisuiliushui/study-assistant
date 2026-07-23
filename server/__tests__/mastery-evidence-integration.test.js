import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  addExamPaper,
  addTopics,
  clearFlag,
  createPlan,
  getPlan,
  permanentlyDeletePlan,
  saveExerciseResults,
  saveFeynmanResults,
  saveQuickQuizResults,
  updateExamResults,
} from '../engine/learn-store.js';
import { gradeExam, gradeExercises } from '../engine/learn-engine.js';
import { Provider } from '../engine/provider.js';
import assessmentRouter from '../routes/assessment.js';
import learnRouter from '../routes/learn.js';

const NOW = 1_700_000_000_000;

describe('mastery evidence assessment transactions', () => {
  let planId;
  let topicA;
  let topicB;

  before(async () => {
    const plan = await createPlan('mastery-evidence-integration', { testOnly: true });
    planId = plan.id;
    const withTopics = await addTopics(planId, ['Topic A', 'Topic B']);
    [topicA, topicB] = withTopics.topics;
  });

  after(async () => {
    if (!planId) return;
    await permanentlyDeletePlan(planId);
    clearFlag(planId);
  });

  it('records quick-quiz Topics once and keeps a replay out of history and scheduling', async () => {
    const questions = [
      { id: 'quiz-a', topicId: topicA.id, topicTitle: topicA.title, conceptTag: 'Alpha' },
      { id: 'quiz-b', topicId: topicB.id, topicTitle: topicB.title, conceptTag: 'Beta' },
    ];
    const results = [
      { exerciseIndex: 0, correct: true, userAnswer: 'A' },
      { exerciseIndex: 1, correct: false, userAnswer: 'B' },
    ];
    const options = { attemptRef: 'quick-attempt-001', observedAt: NOW };

    await saveQuickQuizResults(planId, { questions, results }, options);
    const first = structuredClone(getPlan(planId));
    await saveQuickQuizResults(planId, { questions, results }, options);
    const replay = getPlan(planId);

    assert.equal(first.quickQuizHistory.length, 1);
    assert.equal(replay.quickQuizHistory.length, 1);
    assert.deepEqual(replay.topics, first.topics);
    assert.equal(replay.topics[0].masteryEvidence[0].source, 'quickQuiz');
    assert.deepEqual(replay.topics[0].masteryEvidence[0].conceptTags, ['Alpha']);
    assert.equal(replay.topics[0].reviewSchedule.repetitions, 1);
    assert.equal(replay.topics[1].reviewSchedule.lapses, 1);
  });

  it('atomically persists exercise, exam, and Feynman results with exact mappings', async () => {
    const exercises = [
      { id: 'exercise-a', question: 'A?', conceptTag: 'Alpha', userAnswer: 'yes', correct: true },
      { id: 'exercise-b', question: 'B?', conceptTag: 'Alpha', userAnswer: 'no', correct: false },
    ];
    const exerciseResults = [
      { exerciseIndex: 0, correct: true, userAnswer: 'yes' },
      { exerciseIndex: 1, correct: false, userAnswer: 'no' },
    ];
    await saveExerciseResults(planId, topicA.id, exercises, exerciseResults, {
      attemptRef: 'exercise-attempt-001',
      observedAt: NOW + 1,
    });

    await addExamPaper(planId, {
      id: 'exam-001',
      title: 'Exam',
      config: {},
      paper: '',
      questions: [
        { id: 'exam-a', topicId: topicA.id, conceptTag: 'Alpha' },
        { id: 'exam-b', topicId: topicB.id, conceptTag: 'Beta' },
      ],
    });
    const examResults = [
      { exerciseIndex: 0, correct: false, userAnswer: 'x' },
      { exerciseIndex: 1, correct: true, userAnswer: 'y' },
    ];
    await updateExamResults(planId, 'exam-001', examResults, {
      attemptRef: 'exam-attempt-001',
      observedAt: NOW + 2,
    });

    await saveFeynmanResults(planId, topicA.id, {
      teachingQuality: 'excellent',
      strengths: ['clear'],
    }, {
      attemptRef: 'feynman-transcript-digest-001',
      observedAt: NOW + 3,
    });

    const persisted = getPlan(planId);
    const updatedA = persisted.topics.find(topic => topic.id === topicA.id);
    const updatedB = persisted.topics.find(topic => topic.id === topicB.id);
    const sourcesA = updatedA.masteryEvidence.map(item => item.source);

    assert.deepEqual(updatedA.exercises, exercises);
    assert.deepEqual(persisted.examPapers[0].results, examResults);
    assert.ok(updatedA.weakPoints.includes('Alpha'));
    assert.deepEqual(updatedA.feynmanInsights.strengths, ['clear']);
    assert.ok(sourcesA.includes('exercise'));
    assert.ok(sourcesA.includes('exam'));
    assert.ok(sourcesA.includes('feynman'));
    assert.equal(updatedA.masteryEvidence.find(item => item.source === 'feynman').quality, 4);
    assert.equal(updatedA.masteryEvidence.find(item => item.source === 'feynman').confidence, 'medium');
    assert.ok(updatedB.masteryEvidence.some(item => item.source === 'exam'));
  });

  it('preserves the entire Plan when an assessment has a bad index or orphan Topic', async () => {
    const before = structuredClone(getPlan(planId));

    await assert.rejects(
      () => saveQuickQuizResults(planId, {
        questions: [{ id: 'bad-index', topicId: topicA.id }],
        results: [{ exerciseIndex: 4, correct: true }],
      }, { attemptRef: 'bad-index-attempt', observedAt: NOW + 4 }),
      /exerciseIndex/
    );
    assert.deepEqual(getPlan(planId), before);

    await assert.rejects(
      () => saveQuickQuizResults(planId, {
        questions: [{ id: 'orphan', topicId: 'missing-topic' }],
        results: [{ exerciseIndex: 0, correct: true }],
      }, { attemptRef: 'orphan-topic-attempt', observedAt: NOW + 5 }),
      /Topic not found/
    );
    assert.deepEqual(getPlan(planId), before);
  });

  it('stores unknown Feynman quality without fabricating evidence', async () => {
    const beforeCount = getPlan(planId).topics.find(topic => topic.id === topicB.id).masteryEvidence.length;
    await saveFeynmanResults(planId, topicB.id, {
      teachingQuality: 'unknown',
      gaps: ['needs another pass'],
    }, {
      attemptRef: 'feynman-unknown-digest',
      observedAt: NOW + 6,
    });

    const topic = getPlan(planId).topics.find(candidate => candidate.id === topicB.id);
    assert.equal(topic.masteryEvidence.length, beforeCount);
    assert.deepEqual(topic.feynmanInsights.gaps, ['needs another pass']);
  });

  it('commits engine grading through the assessment transaction only after AI succeeds', async () => {
    const exerciseProvider = createMockProvider(JSON.stringify({
      results: [
        { exerciseIndex: 0, correct: true, userAnswer: 'yes' },
        { exerciseIndex: 1, correct: true, userAnswer: 'no' },
      ],
    }));
    await gradeExercises(exerciseProvider, getPlan(planId), topicA.id, [
      { exerciseIndex: 0, userAnswer: 'yes' },
    ], {
      attemptRef: 'exercise-engine-attempt',
      observedAt: NOW + 7,
    });

    const examProvider = createMockProvider(JSON.stringify({
      results: [
        { exerciseIndex: 0, correct: true, userAnswer: 'x' },
        { exerciseIndex: 1, correct: false, userAnswer: 'y' },
      ],
    }));
    await gradeExam(examProvider, getPlan(planId), 'exam-001', [
      { exerciseIndex: 0, userAnswer: 'x' },
    ], {
      attemptRef: 'exam-engine-attempt-001',
      observedAt: NOW + 8,
    });

    const persisted = getPlan(planId);
    const updatedA = persisted.topics.find(topic => topic.id === topicA.id);
    assert.ok(updatedA.masteryEvidence.some(item => (
      item.source === 'exercise' && item.attemptRef === 'exercise-engine-attempt'
    )));
    assert.ok(updatedA.masteryEvidence.some(item => (
      item.source === 'exam' && item.attemptRef === 'exam-engine-attempt-001'
    )));
    assert.equal(persisted.examPapers[0].results[0].correct, true);

    const beforeFailure = structuredClone(persisted);
    const invalidProvider = createMockProvider('not-json');
    await assert.rejects(
      () => gradeExercises(invalidProvider, persisted, topicA.id, [
        { exerciseIndex: 0, userAnswer: 'retry' },
      ], {
        attemptRef: 'exercise-ai-failure',
        observedAt: NOW + 9,
      }),
      /AI 评分结果格式错误/
    );
    assert.deepEqual(getPlan(planId), beforeFailure);
  });

  it('returns the saved exam result on attemptRef retry without calling the provider again', async () => {
    await addExamPaper(planId, {
      id: 'exam-idempotent-001',
      title: 'Idempotent Exam',
      config: {},
      paper: '',
      questions: [
        { id: 'idem-a', topicId: topicA.id, conceptTag: 'Alpha' },
      ],
    });

    let callCount = 0;
    const provider = createMockProvider(JSON.stringify({
      results: [{ exerciseIndex: 0, correct: true, userAnswer: 'x' }],
    }));
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (...args) => { callCount += 1; return originalComplete(...args); };

    const answers = [{ exerciseIndex: 0, userAnswer: 'x' }];
    const attemptRef = 'exam-idempotent-retry-001';

    const first = await gradeExam(provider, getPlan(planId), 'exam-idempotent-001', answers, {
      attemptRef,
      observedAt: NOW + 10,
    });
    assert.equal(callCount, 1);
    const afterFirst = structuredClone(getPlan(planId));

    const retry = await gradeExam(provider, getPlan(planId), 'exam-idempotent-001', answers, {
      attemptRef,
      observedAt: NOW + 11,
    });
    assert.equal(callCount, 1, 'provider must not be called again on attemptRef retry');
    assert.deepEqual(retry, first);
    assert.deepEqual(getPlan(planId), afterFirst, 'retry must not mutate the Plan');

    // A genuinely new attemptRef must call the provider and grade again.
    const secondProvider = createMockProvider(JSON.stringify({
      results: [{ exerciseIndex: 0, correct: false, userAnswer: 'x' }],
    }));
    let secondCallCount = 0;
    const secondOriginalComplete = secondProvider.complete.bind(secondProvider);
    secondProvider.complete = async (...args) => { secondCallCount += 1; return secondOriginalComplete(...args); };
    const second = await gradeExam(secondProvider, getPlan(planId), 'exam-idempotent-001', answers, {
      attemptRef: 'exam-idempotent-retry-002',
      observedAt: NOW + 12,
    });
    assert.equal(secondCallCount, 1);
    assert.notDeepEqual(second, first);
  });

  it('returns the saved exercise result on attemptRef retry without calling the provider again', async () => {
    // topicA.exercises already holds 2 persisted items from earlier tests in this
    // suite; grading context is built from topic.exercises, so the mock must
    // return one result per existing exercise (same convention as the
    // "commits engine grading" test above).
    let callCount = 0;
    const provider = createMockProvider(JSON.stringify({
      results: [
        { exerciseIndex: 0, correct: true, userAnswer: 'yes' },
        { exerciseIndex: 1, correct: true, userAnswer: 'no' },
      ],
    }));
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (...args) => { callCount += 1; return originalComplete(...args); };

    const answers = [{ exerciseIndex: 0, userAnswer: 'yes' }];
    const attemptRef = 'exercise-idempotent-retry-001';

    const first = await gradeExercises(provider, getPlan(planId), topicA.id, answers, {
      attemptRef,
      observedAt: NOW + 20,
    });
    assert.equal(callCount, 1);
    const afterFirst = structuredClone(getPlan(planId));

    const retry = await gradeExercises(provider, getPlan(planId), topicA.id, answers, {
      attemptRef,
      observedAt: NOW + 21,
    });
    assert.equal(callCount, 1, 'provider must not be called again on attemptRef retry');
    assert.deepEqual(retry, first);
    assert.deepEqual(getPlan(planId), afterFirst, 'retry must not mutate the Plan');

    // A genuinely new attemptRef must call the provider and grade again.
    const secondProvider = createMockProvider(JSON.stringify({
      results: [
        { exerciseIndex: 0, correct: false, userAnswer: 'yes' },
        { exerciseIndex: 1, correct: true, userAnswer: 'no' },
      ],
    }));
    let secondCallCount = 0;
    const secondOriginalComplete = secondProvider.complete.bind(secondProvider);
    secondProvider.complete = async (...args) => { secondCallCount += 1; return secondOriginalComplete(...args); };
    const second = await gradeExercises(secondProvider, getPlan(planId), topicA.id, answers, {
      attemptRef: 'exercise-idempotent-retry-002',
      observedAt: NOW + 22,
    });
    assert.equal(secondCallCount, 1);
    assert.notDeepEqual(second, first);
  });

  it('returns 4xx for invalid assessment contracts without partial writes', async () => {
    const before = structuredClone(getPlan(planId));
    await withAssessmentServer(async base => {
      const requests = [
        fetch(`${base}/api/learn/plans/${planId}/exercises/${topicA.id}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: [{ exerciseIndex: 0, userAnswer: 'x' }], attemptRef: 'short' }),
        }),
        fetch(`${base}/api/learn/plans/${planId}/quick-quiz/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questions: [], results: [], attemptRef: 'short' }),
        }),
        fetch(`${base}/api/learn/plans/${planId}/exam/exam-001/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: [{ exerciseIndex: 0, userAnswer: 'x' }], attemptRef: 'short' }),
        }),
        fetch(`${base}/api/learn/plans/${planId}/quick-quiz/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questions: [{ id: 'bad-route-index', topicId: topicA.id }],
            results: [{ exerciseIndex: 7, correct: true }],
            attemptRef: 'route-bad-index-attempt',
          }),
        }),
      ];
      const responses = await Promise.all(requests);
      assert.deepEqual(responses.map(response => response.status), [400, 400, 400, 400]);
    });
    assert.deepEqual(getPlan(planId), before);
  });
});

function createMockProvider(content) {
  const provider = new Provider({
    apiKey: 'test-key',
    baseURL: 'https://test.invalid/v1',
    model: 'test-model',
  });
  provider.complete = async () => ({ content });
  return provider;
}

function withAssessmentServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/learn', assessmentRouter);
  app.use('/api/learn', learnRouter);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
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
