import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STUDY_TRACE_THEORY_CONTRACT_VERSION,
  projectPlanForStudyTrace,
  projectTopicLearningState,
} from '../engine/topic-learning-state.js';

describe('Topic learning-state projection', () => {
  it('exports the stable study-trace theory contract version', () => {
    assert.equal(STUDY_TRACE_THEORY_CONTRACT_VERSION, 'study-trace-theory-v1');
  });

  it('keeps studied, detail availability, evidence, and mastery separate', () => {
    const projected = projectTopicLearningState({
      id: 't1', title: 'TCP', done: true, detail: '  detail  ', timeSpent: 90,
      exercises: [
        { userAnswer: 'A', correct: true },
        { userAnswer: '', correct: false },
        { userAnswer: null, correct: null },
      ],
      weakPoints: ['拥塞控制'], timeLog: [{ date: '2026-07-29', seconds: 90 }],
    });

    assert.equal(projected.studied, true);
    assert.equal(projected.detailAvailable, true);
    assert.equal(projected.answeredExercises, 2);
    assert.equal(projected.correctExercises, 1);
    assert.equal(projected.incorrectExercises, 1);
    assert.deepEqual(projected.mastery, {
      level: 0, status: 'unassessed', sampleSize: 0, lastEvidenceAt: null,
    });
    assert.equal(Object.hasOwn(projected, 'done'), false);
  });

  it('derives mastery from immutable evidence rather than studied state', () => {
    const projected = projectTopicLearningState({
      id: 't1', title: 'TCP', done: false, studied: true, exercises: [],
      masteryEvidence: [
        { source: 'Review', sourceRef: 'r1', sessionId: 's1', occurredAt: 0, correct: true, confidence: 1 },
        { source: 'Review', sourceRef: 'r2', sessionId: 's2', occurredAt: 86_400_000, correct: true, confidence: 1 },
        { source: 'Review', sourceRef: 'r3', sessionId: 's3', occurredAt: 172_800_000, correct: true, confidence: 1 },
      ],
    });

    assert.equal(projected.studied, true);
    assert.equal(projected.mastery.status, 'mastered');
  });

  it('attributes exam evidence without exposing raw Plan data', () => {
    const projected = projectPlanForStudyTrace({
      id: 'p1', name: 'Plan', phases: [],
      topics: [{ id: 't1', title: 'TCP', done: false, detail: null, exercises: [] }],
      examPapers: [{
        questions: [{ topicId: 't1' }],
        results: [{ exerciseIndex: 0, correct: true }],
      }],
      history: [{ private: true }],
    });

    assert.equal(projected.topics[0].answeredExercises, 1);
    assert.equal(projected.answeredExercises, 1);
    assert.equal(Object.hasOwn(projected, 'history'), false);
    assert.equal(Object.hasOwn(projected, 'examPapers'), false);
  });

  it('attributes quick-quiz evidence by normalized topic title', () => {
    const projected = projectPlanForStudyTrace({
      id: 'p1', name: 'Plan', phases: [],
      topics: [{ id: 't1', title: 'TCP 状态机', done: false, detail: null, exercises: [] }],
      examPapers: [],
      quickQuizHistory: [{
        questions: [{ topicTitle: '  tcp   状态机 ' }],
        results: [{ exerciseIndex: 0, correct: true }],
      }],
    });

    assert.equal(projected.topics[0].answeredExercises, 1);
    assert.equal(projected.topics[0].correctExercises, 1);
    assert.equal(projected.answeredExercises, 1);
  });

  it('keeps scored but unmatched quick-quiz evidence in plan totals', () => {
    const projected = projectPlanForStudyTrace({
      id: 'p1', name: 'Plan', phases: [],
      topics: [{ id: 't1', title: 'TCP', done: false, detail: null, exercises: [] }],
      examPapers: [],
      quickQuizHistory: [{
        questions: [{ topicTitle: '未知主题' }, { topicTitle: 'TCP' }],
        results: [
          { exerciseIndex: 0, correct: false },
          { exerciseIndex: 1, correct: null },
        ],
      }],
    });

    assert.equal(projected.topics[0].answeredExercises, 0);
    assert.equal(projected.answeredExercises, 1);
    assert.equal(projected.incorrectExercises, 1);
  });
});
