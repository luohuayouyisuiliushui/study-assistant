import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addExamPaper,
  addTopics,
  createOrResumeMistakeRepairSession,
  createPlan,
  getPlan,
  getMasteryState,
  saveExamAssessment,
  saveExerciseAssessment,
  saveFeynmanAssessment,
  saveQuickQuizAssessment,
  submitTopicReviewSession,
  updateTopic,
} from '../engine/learn-store.js';
import { gradeExercises } from '../engine/learning-analyzer.js';
import { gradeExam } from '../engine/exam-engine.js';
import { Provider } from '../engine/provider.js';

const BASE = Date.UTC(2026, 0, 1, 8);
const DAY = 24 * 60 * 60 * 1000;

function gradingProvider(payload) {
  const provider = new Provider({ apiKey: 'test-key', baseURL: 'https://test.invalid/v1', autoWarm: false });
  provider._client = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify(payload), role: 'assistant' } }],
      model: 'test-model',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) } },
  };
  return provider;
}

async function topicFixture(title = 'TCP') {
  const plan = await createPlan(`mastery-assessment-${title}`);
  const withTopic = await addTopics(plan.id, [title]);
  return { plan, planId: plan.id, topicId: withTopic.topics[0].id };
}

describe('assessment evidence transactions', () => {
  it('records deterministic Exercise choice evidence in the same Plan transaction', async () => {
    const { planId, topicId } = await topicFixture('Exercise');
    const exercises = [{
      id: 'exercise-1', type: 'choice', question: '选择 A', options: ['A. 对', 'B. 错'],
      answer: 'A', conceptTag: 'TCP', userAnswer: 'A', correct: true,
    }];

    await saveExerciseAssessment(planId, topicId, {
      attemptId: 'attempt-1', occurredAt: BASE, exercises,
      results: [{ exerciseIndex: 0, userAnswer: 'A', correct: true }],
    });
    const state = await getMasteryState(planId, topicId, { now: BASE });

    assert.equal(state.topic.masteryEvidence.length, 1);
    assert.equal(state.topic.masteryEvidence[0].gradingMethod, 'deterministic');
    assert.equal(state.topic.masteryEvidence[0].confidence, 1);
    assert.equal(state.topic.masteryEvidence[0].sourceRef, `${topicId}:exercise-1:attempt-1`);
    assert.equal(state.topic.reviewSchedule.intervalDays, 1);
    assert.equal(state.topic.reviewSchedule.dueAt, BASE + DAY);
  });

  it('routes the Exercise grading engine through the mastery transaction', async () => {
    const { planId, topicId } = await topicFixture('Exercise engine');
    await updateTopic(planId, topicId, { exercises: [{
      id: 'engine-exercise', type: 'choice', question: '选择 A', options: ['A', 'B'],
      answer: 'A', conceptTag: 'TCP', userAnswer: null, correct: null,
    }] });
    const provider = gradingProvider({ results: [{ exerciseIndex: 0, userAnswer: 'A', correct: true }] });

    const current = (await import('../engine/learn-store.js')).getPlan(planId);
    await gradeExercises(provider, current, topicId, [{ exerciseIndex: 0, userAnswer: 'A' }]);
    const state = await getMasteryState(planId, topicId);

    assert.equal(state.topic.masteryEvidence.length, 1);
    assert.equal(state.topic.masteryEvidence[0].gradingMethod, 'deterministic');
    assert.match(state.topic.masteryEvidence[0].sourceRef, /engine-exercise/);
  });

  it('routes the Exam grading engine through the mastery transaction', async () => {
    const { planId, topicId } = await topicFixture('Exam engine');
    await addExamPaper(planId, {
      id: 'engine-exam', title: 'Exam', config: {}, paper: '',
      questions: [{
        id: 'q1', type: 'choice', question: '选择 A', options: ['A', 'B'], answer: 'A',
        conceptTag: 'TCP', topicId,
      }],
    });
    const provider = gradingProvider({ results: [{ exerciseIndex: 0, userAnswer: 'B', correct: false }] });

    const current = (await import('../engine/learn-store.js')).getPlan(planId);
    await gradeExam(provider, current, 'engine-exam', [{ exerciseIndex: 0, userAnswer: 'B' }]);
    const state = await getMasteryState(planId, topicId);

    assert.equal(state.topic.masteryEvidence.length, 1);
    assert.equal(state.topic.masteryEvidence[0].gradingMethod, 'deterministic');
    assert.equal(state.topic.mistakeRecords[0].status, 'open');
  });

  it('opens a Mistake Record for a deterministic Exam error', async () => {
    const { planId, topicId } = await topicFixture('Exam');
    await addExamPaper(planId, {
      id: 'exam-1', title: 'Exam', config: {}, paper: '',
      questions: [{
        id: 'q1', type: 'choice', question: '选择 A', options: ['A', 'B'], answer: 'A',
        conceptTag: 'TCP', topicId,
      }],
    });

    await saveExamAssessment(planId, 'exam-1', {
      attemptId: 'attempt-1', occurredAt: BASE,
      results: [{ exerciseIndex: 0, userAnswer: 'B', correct: false }],
    });
    const state = await getMasteryState(planId, topicId, { now: BASE });

    assert.equal(state.topic.masteryEvidence[0].source, 'Exam');
    assert.equal(state.topic.masteryEvidence[0].correct, false);
    assert.equal(state.topic.mistakeRecords[0].status, 'open');
  });

  it('reuses the original Exam question for a gradeable Mistake Repair', async () => {
    const { planId, topicId } = await topicFixture('Exam repair');
    await addExamPaper(planId, {
      id: 'repair-exam', title: 'Exam', config: {}, paper: '',
      questions: [{
        id: 'repair-q1', type: 'choice', question: 'TCP 握手第一步？',
        options: ['SYN', 'ACK'], answer: 'SYN', conceptTag: 'TCP', topicId,
      }],
    });
    await saveExamAssessment(planId, 'repair-exam', {
      attemptId: 'failed-attempt', occurredAt: BASE,
      results: [{ exerciseIndex: 0, userAnswer: 'ACK', correct: false }],
    });

    const repair = await createOrResumeMistakeRepairSession(
      planId,
      topicId,
      'tcp',
      { sessionId: 'repair-session', createdAt: BASE + 1 },
    );
    assert.deepEqual(repair.session.questions.map(question => question.id), ['repair-q1']);

    const submitted = await submitTopicReviewSession(planId, topicId, {
      sessionId: 'repair-session', submittedAt: BASE + 2,
      answers: [{ questionId: 'repair-q1', answer: 'SYN' }],
    });
    assert.equal(submitted.results[0].confidence, 1);
    assert.equal(submitted.state.topic.mistakeRecords[0].status, 'repairing');
  });

  it('keeps non-exact open-answer repairs low confidence without blocking an exact retry', async () => {
    const { planId, topicId } = await topicFixture('Open Exam repair');
    await addExamPaper(planId, {
      id: 'open-repair-exam', title: 'Exam', config: {}, paper: '',
      questions: [{
        id: 'open-repair-q1', type: 'open', question: 'TCP 是什么？',
        answer: '传输控制协议', conceptTag: 'TCP', topicId,
      }],
    });
    await saveExamAssessment(planId, 'open-repair-exam', {
      attemptId: 'open-failed-attempt', occurredAt: BASE,
      results: [{ exerciseIndex: 0, userAnswer: '不知道', correct: false, confidence: 1 }],
    });

    const first = await createOrResumeMistakeRepairSession(
      planId, topicId, 'tcp', { sessionId: 'open-repair-1', createdAt: BASE + 1 },
    );
    const uncertain = await submitTopicReviewSession(planId, topicId, {
      sessionId: first.session.id, submittedAt: BASE + 2,
      answers: [{ questionId: 'open-repair-q1', answer: '一种可靠传输协议' }],
    });
    assert.equal(uncertain.results[0].confidence, 0.5);
    assert.equal(uncertain.state.topic.mistakeRecords[0].status, 'open');

    const second = await createOrResumeMistakeRepairSession(
      planId, topicId, 'tcp', { sessionId: 'open-repair-2', createdAt: BASE + 3 },
    );
    const exact = await submitTopicReviewSession(planId, topicId, {
      sessionId: second.session.id, submittedAt: BASE + 4,
      answers: [{ questionId: 'open-repair-q1', answer: '传输控制协议' }],
    });
    assert.equal(exact.results[0].confidence, 1);
    assert.equal(exact.state.topic.mistakeRecords[0].status, 'repairing');
  });

  it('advances an attempt from its high-confidence evidence when other results are untrusted', async () => {
    const { planId, topicId } = await topicFixture('Mixed confidence');
    await saveExerciseAssessment(planId, topicId, {
      attemptId: 'mixed-attempt', occurredAt: BASE,
      exercises: [
        { id: 'trusted', type: 'choice', question: '选择 A', options: ['A', 'B'], answer: 'A' },
        { id: 'untrusted', type: 'open', question: '解释 TCP', answer: '参考答案' },
      ],
      results: [
        { exerciseIndex: 0, userAnswer: 'A', correct: true },
        { exerciseIndex: 1, userAnswer: '不同措辞', correct: true },
      ],
    });

    const state = await getMasteryState(planId, topicId, { now: BASE });
    assert.deepEqual(state.topic.masteryEvidence.map(item => item.confidence), [1, 0.5]);
    assert.equal(state.topic.reviewSchedule.intervalDays, 1);
    assert.equal(state.topic.reviewSchedule.dueAt, BASE + DAY);
  });

  it('does not expose a failed Plan transaction through the in-memory cache', async () => {
    const { planId, topicId } = await topicFixture('Cache rollback');
    assert.equal(getPlan(planId).topics[0].feynmanInsights, undefined);

    await assert.rejects(() => saveFeynmanAssessment(planId, topicId, {
      sessionId: 'invalid-feynman', occurredAt: BASE,
      insights: { teachingQuality: 'excellent', confidence: 2 },
    }), /confidence/);

    const cached = getPlan(planId);
    assert.equal(cached.topics[0].feynmanInsights, undefined);
    assert.equal(cached.topics[0].interactiveSession, undefined);
  });

  it('stores untrusted Quiz and Feynman outcomes without advancing mastery', async () => {
    const { planId, topicId } = await topicFixture('Low confidence');
    await saveQuickQuizAssessment(planId, {
      id: 'quiz-1', occurredAt: BASE,
      questions: [{ topicId, question: 'Q', answer: 'A', conceptTag: 'TCP' }],
      results: [{ exerciseIndex: 0, userAnswer: 'A', correct: true }],
    });
    await updateTopic(planId, topicId, {
      interactiveSession: { mode: 'feynman', transcript: [{ role: 'user', content: '解释' }] },
    });
    await saveFeynmanAssessment(planId, topicId, {
      sessionId: 'feynman-1', occurredAt: BASE + 1000,
      insights: { teachingQuality: 'excellent', gaps: [], strengths: ['清楚'] },
    });

    const state = await getMasteryState(planId, topicId, { now: BASE + 1000 });
    assert.deepEqual(state.topic.masteryEvidence.map(item => item.source), ['Quiz', 'Feynman']);
    assert.deepEqual(state.topic.masteryEvidence.map(item => item.confidence), [0.5, 0.5]);
    assert.equal(state.topic.mastery.status, 'learning');
    assert.equal(state.topic.mastery.level, 0);
    assert.equal(state.topic.reviewSchedule.intervalDays, 0);
    assert.equal(state.topic.reviewSchedule.dueAt, BASE);
  });
});
