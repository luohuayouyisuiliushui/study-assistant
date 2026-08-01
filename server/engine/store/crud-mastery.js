import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import {
  MASTERY_SCHEMA_VERSION,
  REVIEW_SCHEDULE_VERSION,
  advanceReviewSchedule,
  appendMasteryEvidence,
  applyMistakeEvidence,
  assessmentAnswerKey,
  buildTodayReview,
  computeMasteryMetrics,
  createMasteryEvidence,
  createReviewSchedule,
  createReviewSession,
  deferReviewSchedule,
  deriveMastery,
  dismissMistake,
  isHighConfidenceEvidence,
  migrateLegacyPlan,
  normalizeAssessmentAnswer,
  normalizeConceptKey,
  projectReviewSession,
  recordMistake,
  submitReviewSession,
} from '../mastery-engine.js';
import {
  invalidatePlanCache,
  isValidPlanId,
  mutateIndex,
  planPath,
  readIndex,
  readJSON,
  removePlanBackups,
  withPlanWriteLocks,
  writeAtomic,
} from './storage.js';
import { getPlan, listPlans } from './crud-plans.js';
import { writePlan } from './crud-content.js';

export const MASTERY_BACKUP_SCHEMA_VERSION = 'study-assistant-backup-v1';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getTopic(plan, topicId) {
  const topic = plan?.topics?.find(item => item.id === topicId);
  if (!topic) throw codedError('TOPIC_NOT_FOUND', `Topic not found: ${topicId}`);
  return topic;
}

function requiresMasteryMigration(plan) {
  if (plan?.masterySchemaVersion !== MASTERY_SCHEMA_VERSION) return true;
  return (Array.isArray(plan?.topics) ? plan.topics : []).some(topic =>
    typeof topic.studied !== 'boolean' ||
    !Array.isArray(topic.masteryEvidence) ||
    !topic.mastery ||
    !Array.isArray(topic.mistakeRecords)
  );
}

function migratePlanInPlace(plan, now) {
  const migrated = migrateLegacyPlan(plan, now);
  for (const key of Object.keys(plan)) delete plan[key];
  Object.assign(plan, migrated);
  return plan;
}

function ensureReviewSchedule(topic, now) {
  if (!topic.reviewSchedule) topic.reviewSchedule = createReviewSchedule(now);
  return topic.reviewSchedule;
}

function projectTopic(topic) {
  return {
    ...clone(topic),
    reviewSession: topic.reviewSession ? projectReviewSession(topic.reviewSession) : null,
  };
}

function projectState(plan, topicId) {
  const topic = getTopic(plan, topicId);
  return {
    schemaVersion: plan.masterySchemaVersion,
    plan: { id: plan.id, name: plan.name },
    topic: projectTopic(topic),
  };
}

function applyEvidenceToTopic(topic, input) {
  const appended = appendMasteryEvidence(topic.masteryEvidence, input);
  if (!appended.added) return appended;

  topic.masteryEvidence = appended.items;
  ensureReviewSchedule(topic, appended.evidence.occurredAt);
  topic.reviewDeferredUntil = null;
  topic.mistakeRecords = applyMistakeEvidence(topic.mistakeRecords, appended.evidence);
  if (!appended.evidence.correct && isHighConfidenceEvidence(appended.evidence)) {
    topic.mistakeRecords = recordMistake(topic.mistakeRecords, appended.evidence);
  }
  topic.mastery = deriveMastery(topic.masteryEvidence);
  return appended;
}

function advanceScheduleForAttempt(topic, evidence, now) {
  const trusted = (Array.isArray(evidence) ? evidence : []).filter(isHighConfidenceEvidence);
  if (trusted.length === 0) return;
  ensureReviewSchedule(topic, now);
  const correct = trusted.every(item => item.correct);
  const quality = correct ? 5 : trusted.some(item => item.correct) ? 2 : 1;
  topic.reviewSchedule = advanceReviewSchedule(
    topic.reviewSchedule,
    { correct, confidence: 1, gradingMethod: 'deterministic', quality },
    now,
  );
}

function classifyAssessment(question, result) {
  const expected = question?.answer ?? question?.expectedAnswer ?? result?.correctAnswer ?? '';
  const actual = result?.userAnswer ?? '';
  const exact = normalizeAssessmentAnswer(actual) !== '' &&
    normalizeAssessmentAnswer(actual) === normalizeAssessmentAnswer(expected);
  if (question?.type === 'choice') {
    return {
      correct: assessmentAnswerKey(actual) !== '' &&
        assessmentAnswerKey(actual) === assessmentAnswerKey(expected),
      confidence: 1,
      gradingMethod: 'deterministic',
    };
  }
  if (exact) return { correct: true, confidence: 1, gradingMethod: 'deterministic' };
  return {
    correct: result?.correct === true,
    confidence: Number.isFinite(result?.confidence) ? result.confidence : 0.5,
    gradingMethod: 'ai',
  };
}

function toReviewQuestion(question, index, fallbackPrefix) {
  const isChoice = question.type === 'choice' ||
    (Array.isArray(question.options) && question.options.length > 0);
  return {
    id: String(question.id || `${fallbackPrefix}-${index + 1}`),
    prompt: question.question,
    expectedAnswer: question.answer,
    explanation: question.explanation || '',
    conceptKey: question.conceptTag,
    options: Array.isArray(question.options) ? question.options : [],
    gradingMethod: isChoice ? 'deterministic' : 'exact-only',
  };
}

function defaultReviewQuestions(topic, targetConceptKey = '', plan = null) {
  const normalizedTarget = normalizeConceptKey(targetConceptKey);
  const exercises = (Array.isArray(topic.exercises) ? topic.exercises : [])
    .filter(exercise => exercise?.question && exercise?.answer)
    .filter(exercise => !normalizedTarget ||
      normalizeConceptKey(exercise.conceptTag || topic.title) === normalizedTarget)
    .slice(0, 5)
    .map((exercise, index) => toReviewQuestion(
      { ...exercise, conceptTag: exercise.conceptTag || topic.title },
      index,
      'exercise',
    ));
  if (exercises.length > 0) return exercises;

  if (normalizedTarget && plan) {
    const seen = new Set();
    const examQuestions = (Array.isArray(plan.examPapers) ? plan.examPapers : [])
      .flatMap(paper => (Array.isArray(paper.questions) ? paper.questions : []).map((question, index) => ({
        ...question,
        id: question?.id || `exam-${paper.id || 'paper'}-${index + 1}`,
      })))
      .filter(question => question?.topicId === topic.id && question?.question && question?.answer)
      .filter(question => normalizeConceptKey(question.conceptTag || topic.title) === normalizedTarget)
      .filter(question => {
        const id = String(question.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, 5)
      .map((question, index) => toReviewQuestion(
        { ...question, conceptTag: question.conceptTag || topic.title },
        index,
        'exam',
      ));
    if (examQuestions.length > 0) return examQuestions;
  }

  const recallTarget = normalizedTarget || normalizeConceptKey(topic.title);
  return [{
    id: 'topic-recall',
    prompt: `请用自己的话回忆“${targetConceptKey || topic.title}”。`,
    expectedAnswer: targetConceptKey || topic.title,
    explanation: '该回答只保存为低置信自我回忆，不会推进掌握度或复习排程。',
    conceptKey: recallTarget,
    options: [],
    gradingMethod: 'ai',
    confidence: 0.5,
  }];
}

export async function getMasteryState(planId, topicId, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let plan = getPlan(planId);
  if (!plan) throw codedError('PLAN_NOT_FOUND', `Plan not found: ${planId}`);
  if (requiresMasteryMigration(plan)) {
    plan = await writePlan(planId, current => migratePlanInPlace(current, now));
  }
  return projectState(plan, topicId);
}

export async function appendTopicMasteryEvidence(planId, topicId, input, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let outcome;
  const plan = await writePlan(planId, current => {
    migratePlanInPlace(current, now);
    const topic = getTopic(current, topicId);
    outcome = applyEvidenceToTopic(topic, input);
  });
  return { added: outcome.added, evidence: clone(outcome.evidence), state: projectState(plan, topicId) };
}

export async function saveExerciseAssessment(planId, topicId, input) {
  const occurredAt = Number.isFinite(input?.occurredAt) ? input.occurredAt : Date.now();
  const attemptId = String(input?.attemptId || uuidv4());
  const exercises = clone(Array.isArray(input?.exercises) ? input.exercises : []);
  const results = Array.isArray(input?.results) ? input.results : [];
  return writePlan(planId, current => {
    migratePlanInPlace(current, occurredAt);
    const topic = getTopic(current, topicId);
    topic.exercises = exercises;
    const addedEvidence = [];
    for (const result of results) {
      const index = Number(result?.exerciseIndex);
      const exercise = exercises[index];
      if (!exercise) continue;
      const assessment = classifyAssessment(exercise, result);
      Object.assign(exercise, {
        userAnswer: result.userAnswer ?? exercise.userAnswer ?? '',
        correct: assessment.correct,
        confidence: assessment.confidence,
        gradingMethod: assessment.gradingMethod,
        gradedAt: occurredAt,
        sessionId: `exercise:${attemptId}`,
      });
      const outcome = applyEvidenceToTopic(topic, {
        source: 'Exercise',
        sourceRef: `${topicId}:${exercise.id || index}:${attemptId}`,
        sessionId: `exercise:${attemptId}`,
        occurredAt,
        ...assessment,
        conceptKey: exercise.conceptTag || topic.title,
        questionRef: exercise.id || String(index),
      });
      if (outcome.added) addedEvidence.push(outcome.evidence);
    }
    advanceScheduleForAttempt(topic, addedEvidence, occurredAt);
  });
}

export async function saveExamAssessment(planId, examId, input) {
  const occurredAt = Number.isFinite(input?.occurredAt) ? input.occurredAt : Date.now();
  const attemptId = String(input?.attemptId || uuidv4());
  const results = clone(Array.isArray(input?.results) ? input.results : []);
  return writePlan(planId, current => {
    migratePlanInPlace(current, occurredAt);
    const exam = current.examPapers?.find(item => item.id === examId);
    if (!exam) throw codedError('EXAM_NOT_FOUND', `Exam not found: ${examId}`);
    exam.results = results;
    exam.gradedAt = occurredAt;
    exam.attemptId = attemptId;
    const evidenceByTopic = new Map();
    for (const result of results) {
      const index = Number(result?.exerciseIndex);
      const question = exam.questions?.[index];
      if (!question?.topicId) continue;
      const topic = getTopic(current, question.topicId);
      const assessment = classifyAssessment(question, result);
      Object.assign(result, assessment);
      const outcome = applyEvidenceToTopic(topic, {
        source: 'Exam',
        sourceRef: `${examId}:${index}:${attemptId}`,
        sessionId: `exam:${examId}:${attemptId}`,
        occurredAt,
        ...assessment,
        conceptKey: question.conceptTag || topic.title,
        questionRef: question.id || String(index),
      });
      if (outcome.added) {
        const evidence = evidenceByTopic.get(topic.id) || [];
        evidence.push(outcome.evidence);
        evidenceByTopic.set(topic.id, evidence);
      }
    }
    for (const [affectedTopicId, evidence] of evidenceByTopic) {
      advanceScheduleForAttempt(getTopic(current, affectedTopicId), evidence, occurredAt);
    }
  });
}

export async function saveQuickQuizAssessment(planId, input) {
  const occurredAt = Number.isFinite(input?.occurredAt) ? input.occurredAt : Date.now();
  const quizId = String(input?.id || uuidv4().slice(0, 8));
  const questions = clone(Array.isArray(input?.questions) ? input.questions : []);
  const results = clone(Array.isArray(input?.results) ? input.results : []);
  return writePlan(planId, current => {
    migratePlanInPlace(current, occurredAt);
    if (!current.quickQuizHistory) current.quickQuizHistory = [];
    current.quickQuizHistory.push({ id: quizId, createdAt: occurredAt, questions, results });
    current.quickQuizHistory = current.quickQuizHistory.slice(-20);
    const evidenceByTopic = new Map();
    for (const result of results) {
      const index = Number(result?.exerciseIndex);
      const question = questions[index];
      const topic = current.topics.find(item =>
        item.id === question?.topicId ||
        normalizeConceptKey(item.title) === normalizeConceptKey(question?.topicTitle || question?.conceptTag)
      );
      if (!topic || typeof result?.correct !== 'boolean') continue;
      const outcome = applyEvidenceToTopic(topic, {
        source: 'Quiz',
        sourceRef: `${quizId}:${index}`,
        sessionId: `quiz:${quizId}`,
        occurredAt,
        correct: result.correct,
        confidence: 0.5,
        gradingMethod: 'ai',
        conceptKey: question.conceptTag || topic.title,
        questionRef: question.id || String(index),
      });
      if (outcome.added) {
        const evidence = evidenceByTopic.get(topic.id) || [];
        evidence.push(outcome.evidence);
        evidenceByTopic.set(topic.id, evidence);
      }
    }
    for (const [affectedTopicId, evidence] of evidenceByTopic) {
      advanceScheduleForAttempt(getTopic(current, affectedTopicId), evidence, occurredAt);
    }
  });
}

export async function saveFeynmanAssessment(planId, topicId, input) {
  const occurredAt = Number.isFinite(input?.occurredAt) ? input.occurredAt : Date.now();
  const sessionId = String(input?.sessionId || uuidv4());
  const insights = clone(input?.insights || {});
  return writePlan(planId, current => {
    migratePlanInPlace(current, occurredAt);
    const topic = getTopic(current, topicId);
    topic.feynmanInsights = insights;
    topic.interactiveSession = {
      ...(topic.interactiveSession || {}),
      masterySessionId: sessionId,
    };
    const correct = insights.teachingQuality === 'excellent' || insights.teachingQuality === 'good';
    const outcome = applyEvidenceToTopic(topic, {
      source: 'Feynman',
      sourceRef: sessionId,
      sessionId,
      occurredAt,
      correct,
      confidence: Number.isFinite(insights.confidence) ? insights.confidence : 0.5,
      gradingMethod: 'ai',
      conceptKey: topic.title,
    });
    if (outcome.added) advanceScheduleForAttempt(topic, [outcome.evidence], occurredAt);
  });
}

function createSessionInTopic(plan, topic, planId, topicId, input, now, requiredConceptKey = '') {
  ensureReviewSchedule(topic, now);
  const normalizedRequired = normalizeConceptKey(requiredConceptKey);
  const actionableMistakes = topic.mistakeRecords.filter(record =>
    record.status === 'open' || record.status === 'repairing'
  );
  const requestedKind = normalizedRequired ? 'mistake-repair' : 'review';
  const targetConceptKey = normalizedRequired;

  if (normalizedRequired && !actionableMistakes.some(record =>
    normalizeConceptKey(record.conceptKey) === normalizedRequired
  )) {
    throw codedError('MISTAKE_NOT_FOUND', `Mistake Record not found: ${requiredConceptKey}`);
  }

  if (topic.reviewSession?.status === 'active') {
    if (normalizedRequired && (
      topic.reviewSession.kind !== 'mistake-repair' ||
      normalizeConceptKey(topic.reviewSession.targetConceptKey) !== normalizedRequired
    )) {
      throw codedError('SESSION_CONFLICT', 'A different Review Session is already active for this Topic');
    }
    return true;
  }

  topic.reviewSession = createReviewSession({
    id: String(input.sessionId || uuidv4()),
    planId,
    topicId,
    topicTitle: topic.title,
    kind: requestedKind,
    targetConceptKey,
    createdAt: now,
    estimatedMinutes: input.estimatedMinutes || topic.estimatedReviewMinutes,
    questions: Array.isArray(input.questions) && input.questions.length > 0
      ? input.questions
      : defaultReviewQuestions(topic, targetConceptKey, plan),
  });
  return false;
}

async function persistReviewSession(planId, topicId, input, requiredConceptKey = '') {
  const now = Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
  const sessionInput = requiredConceptKey ? { ...input, questions: undefined } : input;
  let resumed = false;
  const plan = await writePlan(planId, current => {
    migratePlanInPlace(current, now);
    const topic = getTopic(current, topicId);
    resumed = createSessionInTopic(current, topic, planId, topicId, sessionInput, now, requiredConceptKey);
  });
  return { resumed, session: projectReviewSession(getTopic(plan, topicId).reviewSession) };
}

export async function createOrResumeReviewSession(planId, topicId, input = {}) {
  if (input.kind === 'mistake-repair') {
    throw new TypeError('Mistake Repair sessions must use the dedicated repair-session endpoint');
  }
  return persistReviewSession(planId, topicId, input);
}

export async function createOrResumeMistakeRepairSession(planId, topicId, conceptKey, input = {}) {
  return persistReviewSession(
    planId,
    topicId,
    { ...input, kind: 'mistake-repair', conceptKey },
    conceptKey,
  );
}

export async function submitTopicReviewSession(planId, topicId, input) {
  let submitted;
  const now = Number.isFinite(input?.submittedAt) ? input.submittedAt : Date.now();
  const plan = await writePlan(planId, current => {
    migratePlanInPlace(current, now);
    const topic = getTopic(current, topicId);
    if (!topic.reviewSession) throw codedError('SESSION_NOT_FOUND', 'Review Session not found');
    submitted = submitReviewSession(topic.reviewSession, input);

    const addedEvidence = [];
    for (const evidence of submitted.evidence) {
      const outcome = applyEvidenceToTopic(topic, evidence);
      if (outcome.added) addedEvidence.push(outcome.evidence);
    }
    topic.reviewSession = submitted.session;
    advanceScheduleForAttempt(topic, addedEvidence, now);
    topic.lastReviewCompletedAt = now;
    topic.reviewCompletionCount = (Number(topic.reviewCompletionCount) || 0) + 1;
    submitted.addedEvidence = addedEvidence.length;
  });

  return {
    results: clone(submitted.results),
    addedEvidence: submitted.addedEvidence,
    state: projectState(plan, topicId),
  };
}

export async function deferTopicReview(planId, topicId, until, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const plan = await writePlan(planId, current => {
    migratePlanInPlace(current, now);
    const topic = getTopic(current, topicId);
    topic.reviewSchedule = deferReviewSchedule(ensureReviewSchedule(topic, now), until, now);
    topic.reviewDeferredUntil = until;
    if (topic.reviewSession?.status === 'active') {
      topic.reviewSession = {
        ...topic.reviewSession,
        status: 'deferred',
        deferredUntil: until,
        updatedAt: now,
      };
    }
    topic.reviewDeferralCount = (Number(topic.reviewDeferralCount) || 0) + 1;
  });
  return projectState(plan, topicId);
}

export async function dismissTopicMistake(planId, topicId, conceptKey, options = {}) {
  const now = Number.isFinite(options.dismissedAt) ? options.dismissedAt : Date.now();
  const plan = await writePlan(planId, current => {
    migratePlanInPlace(current, now);
    const topic = getTopic(current, topicId);
    const before = topic.mistakeRecords;
    const normalized = normalizeConceptKey(conceptKey);
    const matching = before.some(record => normalizeConceptKey(record.conceptKey) === normalized);
    if (!matching) throw codedError('MISTAKE_NOT_FOUND', `Mistake Record not found: ${conceptKey}`);
    const record = before.find(item => normalizeConceptKey(item.conceptKey) === normalized);
    if (record.status === 'verified') {
      throw new TypeError('A verified Mistake Record cannot be dismissed');
    }
    topic.mistakeRecords = dismissMistake(before, conceptKey, now, options.reason);
  });
  return projectState(plan, topicId);
}

function loadMigratedPlans(now) {
  return listPlans()
    .map(entry => getPlan(entry.id))
    .filter(Boolean)
    .map(plan => migrateLegacyPlan(plan, now));
}

export function getTodayReview(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return buildTodayReview(loadMigratedPlans(now), { ...options, now });
}

export function getMasteryMetrics(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return computeMasteryMetrics(loadMigratedPlans(now), now, { budgetMinutes: options.budgetMinutes });
}

function invalidBackup(message) {
  throw codedError('INVALID_BACKUP', message);
}

function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function validateSchedule(schedule, context) {
  if (!schedule || schedule.version !== REVIEW_SCHEDULE_VERSION ||
      !isNonNegativeNumber(schedule.dueAt) ||
      !isNonNegativeNumber(schedule.intervalDays) ||
      !Number.isFinite(schedule.easeFactor) || schedule.easeFactor < 1.3 ||
      !Number.isInteger(schedule.consecutiveSuccesses) || schedule.consecutiveSuccesses < 0 ||
      !Number.isInteger(schedule.lapses) || schedule.lapses < 0 ||
      !(schedule.lastReviewedAt === null || isNonNegativeNumber(schedule.lastReviewedAt))) {
    invalidBackup(`${context} has an invalid Review Schedule`);
  }
}

function validateSession(session, planId, topicId, context) {
  if (!session || session.planId !== planId || session.topicId !== topicId ||
      !['active', 'completed', 'deferred'].includes(session.status)) {
    invalidBackup(`${context} has an invalid Review Session`);
  }
  try {
    createReviewSession({ ...session, questions: session.questions });
  } catch (error) {
    invalidBackup(`${context} has an invalid Review Session: ${error.message}`);
  }
  if (!isNonNegativeNumber(session.updatedAt)) {
    invalidBackup(`${context} has an invalid Review Session updatedAt`);
  }
  if (session.status === 'completed') {
    const questionIds = new Set(session.questions.map(question => question.id));
    const results = Array.isArray(session.results) ? session.results : [];
    const resultIds = new Set(results.map(result => result?.questionId));
    if (!isNonNegativeNumber(session.submittedAt) || results.length !== questionIds.size ||
        resultIds.size !== questionIds.size ||
        results.some(result => !questionIds.has(result?.questionId) || typeof result?.correct !== 'boolean')) {
      invalidBackup(`${context} has invalid completed Review Session results`);
    }
  }
  if (session.status === 'deferred' && !isNonNegativeNumber(session.deferredUntil)) {
    invalidBackup(`${context} has an invalid deferred Review Session`);
  }
}

function validateMistakeRecords(records, context) {
  if (!Array.isArray(records)) invalidBackup(`${context} Mistake Records must be an array`);
  const keys = new Set();
  for (const record of records) {
    const conceptKey = normalizeConceptKey(record?.conceptKey);
    if (!conceptKey || keys.has(conceptKey) ||
        !['open', 'repairing', 'verified', 'dismissed'].includes(record?.status) ||
        !isNonNegativeNumber(record?.openedAt) || !isNonNegativeNumber(record?.lastErrorAt) ||
        !Array.isArray(record?.occurrences)) {
      invalidBackup(`${context} contains an invalid Mistake Record`);
    }
    keys.add(conceptKey);
    for (const occurrence of record.occurrences) {
      try {
        createMasteryEvidence({
          ...occurrence,
          sessionId: 'backup-validation',
          correct: false,
          confidence: 1,
          gradingMethod: 'deterministic',
          conceptKey,
        });
      } catch (error) {
        invalidBackup(`${context} contains an invalid Mistake Record occurrence: ${error.message}`);
      }
    }
    if (record.status === 'repairing' && (
      !record.repairSessionId || !isNonNegativeNumber(record.repairingAt) ||
      !isNonNegativeNumber(record.verificationDueAt)
    )) invalidBackup(`${context} contains an invalid repairing Mistake Record`);
    if (record.status === 'verified' && !isNonNegativeNumber(record.verifiedAt)) {
      invalidBackup(`${context} contains an invalid verified Mistake Record`);
    }
    if (record.status === 'dismissed' && !isNonNegativeNumber(record.dismissedAt)) {
      invalidBackup(`${context} contains an invalid dismissed Mistake Record`);
    }
  }
}

function validateTopicState(topic, planId, context) {
  if (!topic || typeof topic.id !== 'string' || !topic.id || !Array.isArray(topic.masteryEvidence)) {
    invalidBackup(`${context} contains an invalid Topic`);
  }
  const evidence = [];
  const evidenceKeys = new Set();
  for (const item of topic.masteryEvidence) {
    try {
      const normalized = createMasteryEvidence(item);
      const evidenceKey = `${normalized.source}\u0000${normalized.sourceRef}`;
      if (evidenceKeys.has(evidenceKey)) {
        invalidBackup(`${context} contains duplicate Mastery Evidence: ${normalized.source} ${normalized.sourceRef}`);
      }
      evidenceKeys.add(evidenceKey);
      evidence.push(normalized);
    } catch (error) {
      if (error?.code === 'INVALID_BACKUP') throw error;
      invalidBackup(`${context} contains invalid Mastery Evidence: ${error.message}`);
    }
  }
  const derived = deriveMastery(evidence);
  if (!topic.mastery || ['level', 'status', 'sampleSize', 'lastEvidenceAt'].some(
    key => topic.mastery[key] !== derived[key]
  )) invalidBackup(`${context} contains stale derived Mastery`);
  if (topic.reviewSchedule) validateSchedule(topic.reviewSchedule, context);
  if (topic.reviewSession) validateSession(topic.reviewSession, planId, topic.id, context);
  validateMistakeRecords(topic.mistakeRecords, context);
  if (topic.reviewDeferredUntil !== undefined && topic.reviewDeferredUntil !== null &&
      !isNonNegativeNumber(topic.reviewDeferredUntil)) {
    invalidBackup(`${context} has an invalid reviewDeferredUntil`);
  }
}

function validateBackup(rawBackup) {
  if (!rawBackup || typeof rawBackup !== 'object') throw codedError('INVALID_BACKUP', 'Backup must be an object');
  if (rawBackup.schemaVersion !== MASTERY_BACKUP_SCHEMA_VERSION) {
    throw codedError('INVALID_BACKUP', `Unsupported backup schema: ${rawBackup.schemaVersion || 'missing'}`);
  }
  if (!Array.isArray(rawBackup.plans)) throw codedError('INVALID_BACKUP', 'Backup plans must be an array');
  const ids = new Set();
  for (const plan of rawBackup.plans) {
    if (!plan || !isValidPlanId(plan.id) || typeof plan.name !== 'string' || !Array.isArray(plan.topics)) {
      throw codedError('INVALID_BACKUP', 'Backup contains an invalid Plan');
    }
    if (!isNonNegativeNumber(plan.createdAt) || !isNonNegativeNumber(plan.updatedAt)) {
      invalidBackup(`Plan ${plan.id} has invalid Plan timestamps`);
    }
    if (plan.masterySchemaVersion !== MASTERY_SCHEMA_VERSION) {
      invalidBackup(`Plan ${plan.id} has an unsupported Mastery schema`);
    }
    if (ids.has(plan.id)) throw codedError('INVALID_BACKUP', `Backup contains duplicate Plan id: ${plan.id}`);
    ids.add(plan.id);
    const topicIds = new Set();
    for (const topic of plan.topics) {
      if (topicIds.has(topic?.id)) invalidBackup(`Plan ${plan.id} contains a duplicate Topic id: ${topic?.id}`);
      topicIds.add(topic?.id);
      validateTopicState(topic, plan.id, `Plan ${plan.id} Topic ${topic?.id || 'missing'}`);
    }
  }
  return rawBackup;
}

function backupCounts(plans) {
  const counts = { plans: plans.length, topics: 0, evidence: 0, schedules: 0, sessions: 0, mistakes: 0 };
  for (const plan of plans) {
    for (const topic of Array.isArray(plan.topics) ? plan.topics : []) {
      counts.topics += 1;
      counts.evidence += Array.isArray(topic.masteryEvidence) ? topic.masteryEvidence.length : 0;
      if (topic.reviewSchedule) counts.schedules += 1;
      if (topic.reviewSession) counts.sessions += 1;
      counts.mistakes += Array.isArray(topic.mistakeRecords) ? topic.mistakeRecords.length : 0;
    }
  }
  return counts;
}

export async function createMasteryBackup(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const plans = loadMigratedPlans(now);
  return {
    schemaVersion: MASTERY_BACKUP_SCHEMA_VERSION,
    masterySchemaVersion: MASTERY_SCHEMA_VERSION,
    createdAt: now,
    plans,
  };
}

export async function previewMasteryRestore(rawBackup) {
  const backup = validateBackup(rawBackup);
  const currentIds = new Set(listPlans().map(plan => plan.id));
  const backupIds = new Set(backup.plans.map(plan => plan.id));
  return {
    valid: true,
    schemaVersion: backup.schemaVersion,
    createdAt: backup.createdAt,
    counts: backupCounts(backup.plans),
    addedPlanIds: [...backupIds].filter(id => !currentIds.has(id)),
    updatedPlanIds: [...backupIds].filter(id => currentIds.has(id)),
    untouchedPlanIds: [...currentIds].filter(id => !backupIds.has(id)),
  };
}

export async function restoreMasteryBackup(rawBackup) {
  const backup = validateBackup(rawBackup);
  const preview = await previewMasteryRestore(backup);
  const planIds = backup.plans.map(plan => plan.id);
  return withPlanWriteLocks(planIds, async () => {
    const originals = new Map(planIds.map(planId => [planId, clone(readJSON(planPath(planId)))]));
    const originalIndex = readIndex();
    const restoredIds = new Set(planIds);
    const originalEntries = originalIndex.filter(entry => restoredIds.has(entry.id));
    const applied = [];
    try {
      for (const snapshot of backup.plans) {
        const plan = clone(snapshot);
        applied.push(plan.id);
        writeAtomic(planPath(plan.id), JSON.stringify(plan, null, 2), { backup: true });
        invalidatePlanCache(plan.id);
      }

      const restoredEntries = backup.plans.map(plan => ({
        id: plan.id,
        name: plan.name,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        topicCount: plan.topics.length,
      }));
      await mutateIndex(index => [
        ...index.filter(entry => !restoredIds.has(entry.id)),
        ...restoredEntries,
      ]);
    } catch (error) {
      const rollbackErrors = [];
      for (const planId of applied.reverse()) {
        try {
          const original = originals.get(planId);
          if (original) {
            writeAtomic(planPath(planId), JSON.stringify(original, null, 2), { backup: true });
          } else {
            if (fs.existsSync(planPath(planId))) fs.unlinkSync(planPath(planId));
            removePlanBackups(planId, { strict: true });
          }
          invalidatePlanCache(planId);
        } catch (rollbackError) {
          rollbackErrors.push(`${planId}: ${rollbackError.message}`);
        }
      }
      try {
        await mutateIndex(index => [
          ...index.filter(entry => !restoredIds.has(entry.id)),
          ...originalEntries,
        ]);
      } catch (rollbackError) {
        rollbackErrors.push(`index: ${rollbackError.message}`);
      }
      if (rollbackErrors.length > 0) {
        throw codedError(
          'RESTORE_ROLLBACK_FAILED',
          `Restore failed (${error.message}); rollback also failed: ${rollbackErrors.join('; ')}`,
        );
      }
      throw error;
    }
    return { restored: backup.plans.length, preview };
  });
}
