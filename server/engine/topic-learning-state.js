import { deriveMastery } from './mastery-engine.js';

/**
 * Stable cross-project projection for Topic learning facts.
 *
 * `topic.done` is legacy storage for "studied". It is deliberately not
 * exposed as mastery: mastery evidence and the evidence-v1 projection are
 * separate future domain concepts.
 */

export const STUDY_TRACE_THEORY_CONTRACT_VERSION = 'study-trace-theory-v1';

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeTimeLog(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(entry => entry && typeof entry.date === 'string')
    .map(entry => ({
      date: entry.date,
      seconds: finiteNonNegative(entry.seconds),
    }));
}

function exerciseEvidence(topic) {
  const exercises = Array.isArray(topic?.exercises) ? topic.exercises : [];
  const answered = exercises.filter(exercise => exercise?.userAnswer !== null && exercise?.userAnswer !== undefined);
  const correct = answered.filter(exercise => exercise.correct === true).length;
  return {
    answered: answered.length,
    correct,
    incorrect: answered.filter(exercise => exercise.correct === false).length,
  };
}

function examEvidence(plan) {
  const byTopic = new Map();
  const unassigned = { answered: 0, correct: 0, incorrect: 0 };

  for (const paper of Array.isArray(plan?.examPapers) ? plan.examPapers : []) {
    const questions = Array.isArray(paper?.questions) ? paper.questions : [];
    for (const result of Array.isArray(paper?.results) ? paper.results : []) {
      const question = questions[result?.exerciseIndex];
      const topicId = question?.topicId;
      const bucket = typeof topicId === 'string'
        ? (byTopic.get(topicId) || { answered: 0, correct: 0, incorrect: 0 })
        : unassigned;
      bucket.answered += 1;
      if (result?.correct === true) bucket.correct += 1;
      if (result?.correct === false) bucket.incorrect += 1;
      if (typeof topicId === 'string') byTopic.set(topicId, bucket);
    }
  }
  return { byTopic, unassigned };
}

function normalizedTopicTitle(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    : '';
}

function quickQuizEvidence(plan) {
  const topics = Array.isArray(plan?.topics) ? plan.topics : [];
  const topicIds = new Set(topics.map(topic => topic.id));
  const idsByTitle = new Map(
    topics
      .map(topic => [normalizedTopicTitle(topic.title), topic.id])
      .filter(([title]) => title),
  );
  const byTopic = new Map();
  const unassigned = { answered: 0, correct: 0, incorrect: 0 };

  for (const quiz of Array.isArray(plan?.quickQuizHistory) ? plan.quickQuizHistory : []) {
    const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
    for (const result of Array.isArray(quiz?.results) ? quiz.results : []) {
      if (result?.correct !== true && result?.correct !== false) continue;
      const question = questions[result.exerciseIndex];
      const explicitId = question?.topicId;
      const matchedId = typeof explicitId === 'string' && topicIds.has(explicitId)
        ? explicitId
        : idsByTitle.get(normalizedTopicTitle(question?.topicTitle || question?.conceptTag));
      const bucket = matchedId
        ? (byTopic.get(matchedId) || { answered: 0, correct: 0, incorrect: 0 })
        : unassigned;
      bucket.answered += 1;
      if (result.correct === true) bucket.correct += 1;
      else bucket.incorrect += 1;
      if (matchedId) byTopic.set(matchedId, bucket);
    }
  }
  return { byTopic, unassigned };
}

function combineEvidence(...items) {
  return items.reduce((total, item) => ({
    answered: total.answered + item.answered,
    correct: total.correct + item.correct,
    incorrect: total.incorrect + item.incorrect,
  }), { answered: 0, correct: 0, incorrect: 0 });
}

export function projectTopicLearningState(topic, extraEvidence = null) {
  const evidence = combineEvidence(
    exerciseEvidence(topic),
    extraEvidence || { answered: 0, correct: 0, incorrect: 0 },
  );
  return {
    id: topic.id,
    title: typeof topic.title === 'string' ? topic.title : '',
    phaseId: topic.phaseId ?? null,
    level: finiteNonNegative(topic.level) || 1,
    parentId: topic.parentId ?? null,
    order: finiteNonNegative(topic.order),
    detailAvailable: typeof topic.detail === 'string' && topic.detail.trim().length > 0,
    studied: topic.studied === true || topic.done === true,
    timeSpentSeconds: finiteNonNegative(topic.timeSpent),
    answeredExercises: evidence.answered,
    correctExercises: evidence.correct,
    incorrectExercises: evidence.incorrect,
    weakPoints: Array.isArray(topic.weakPoints)
      ? topic.weakPoints.filter(point => typeof point === 'string')
      : [],
    timeLog: normalizeTimeLog(topic.timeLog),
    mastery: deriveMastery(topic.masteryEvidence),
  };
}

export function projectPlanForStudyTrace(plan) {
  const exams = examEvidence(plan);
  const quickQuizzes = quickQuizEvidence(plan);
  const topics = (Array.isArray(plan?.topics) ? plan.topics : []).map(topic =>
    projectTopicLearningState(topic, combineEvidence(
      exams.byTopic.get(topic.id) || { answered: 0, correct: 0, incorrect: 0 },
      quickQuizzes.byTopic.get(topic.id) || { answered: 0, correct: 0, incorrect: 0 },
    ))
  );
  const topicEvidence = topics.reduce((total, topic) => combineEvidence(total, {
    answered: topic.answeredExercises,
    correct: topic.correctExercises,
    incorrect: topic.incorrectExercises,
  }), { answered: 0, correct: 0, incorrect: 0 });
  const evidence = combineEvidence(topicEvidence, exams.unassigned, quickQuizzes.unassigned);

  return {
    id: plan.id,
    name: typeof plan.name === 'string' ? plan.name : '',
    phases: (Array.isArray(plan.phases) ? plan.phases : []).map(phase => ({
      id: phase.id,
      name: typeof phase.name === 'string' ? phase.name : '',
      order: finiteNonNegative(phase.order),
    })),
    topics,
    answeredExercises: evidence.answered,
    correctExercises: evidence.correct,
    incorrectExercises: evidence.incorrect,
  };
}
