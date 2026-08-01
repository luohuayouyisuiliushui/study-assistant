const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

export const MASTERY_SCHEMA_VERSION = 'mastery-v1';
export const REVIEW_SCHEDULE_VERSION = 'sm2-v1';
export const MASTERY_EVIDENCE_SOURCES = Object.freeze([
  'Exercise', 'Quiz', 'Exam', 'Feynman', 'Review', 'Mistake Repair',
]);

const SOURCE_BY_LOWER = new Map(
  MASTERY_EVIDENCE_SOURCES.map(source => [source.toLocaleLowerCase(), source]),
);

function finiteTimestamp(value, field) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a non-negative timestamp`);
  return value;
}

function finiteConfidence(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('confidence must be between 0 and 1');
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function isHighConfidenceEvidence(evidence) {
  return evidence?.gradingMethod === 'deterministic' ||
    (Number.isFinite(evidence?.confidence) && evidence.confidence >= HIGH_CONFIDENCE_THRESHOLD);
}

function canonicalSource(value) {
  const source = SOURCE_BY_LOWER.get(String(value || '').trim().toLocaleLowerCase());
  if (!source) throw new TypeError(`source must be one of: ${MASTERY_EVIDENCE_SOURCES.join(', ')}`);
  return source;
}

export function normalizeConceptKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}

export function createMasteryEvidence(input) {
  if (!input || typeof input !== 'object') throw new TypeError('evidence must be an object');
  const source = canonicalSource(input.source);
  const sourceRef = String(input.sourceRef || '').trim();
  const sessionId = String(input.sessionId || '').trim();
  if (!sourceRef) throw new TypeError('sourceRef is required');
  if (!sessionId) throw new TypeError('sessionId is required');
  if (typeof input.correct !== 'boolean') throw new TypeError('correct must be boolean');

  const evidence = {
    id: `${source}:${sourceRef}`,
    source,
    sourceRef,
    sessionId,
    occurredAt: finiteTimestamp(input.occurredAt, 'occurredAt'),
    correct: input.correct,
    confidence: finiteConfidence(input.confidence),
    gradingMethod: input.gradingMethod === 'deterministic' ? 'deterministic' : 'ai',
    conceptKey: normalizeConceptKey(input.conceptKey),
  };
  if (input.questionRef) evidence.questionRef = String(input.questionRef);
  if (input.detail) evidence.detail = String(input.detail).slice(0, 500);
  return Object.freeze(evidence);
}

export function appendMasteryEvidence(existing, rawEvidence) {
  const items = Array.isArray(existing) ? existing : [];
  const evidence = createMasteryEvidence(rawEvidence);
  const duplicate = items.find(item => item?.source === evidence.source && item?.sourceRef === evidence.sourceRef);
  if (duplicate) return { items, evidence: duplicate, added: false };
  return { items: [...items, evidence], evidence, added: true };
}

export function deriveMastery(rawEvidence) {
  const evidence = (Array.isArray(rawEvidence) ? rawEvidence : [])
    .filter(item => item && Number.isFinite(item.occurredAt) && typeof item.correct === 'boolean')
    .slice()
    .sort((a, b) => a.occurredAt - b.occurredAt);

  if (evidence.length === 0) {
    return { level: 0, status: 'unassessed', sampleSize: 0, lastEvidenceAt: null };
  }

  const highConfidence = evidence.filter(isHighConfidenceEvidence);
  const lastErrorIndex = highConfidence.findLastIndex(item => item.correct === false);
  const currentRun = highConfidence.slice(lastErrorIndex + 1);
  const correctBySession = new Map();
  for (const item of currentRun) {
    if (item.correct && item.sessionId && !correctBySession.has(item.sessionId)) {
      correctBySession.set(item.sessionId, item);
    }
  }
  const correctSessions = [...correctBySession.values()].sort((a, b) => a.occurredAt - b.occurredAt);
  const highConfidenceCorrect = currentRun.filter(item => item.correct).length;
  const accuracy = currentRun.length > 0 ? highConfidenceCorrect / currentRun.length : 0;
  const level = Math.round(clamp((correctSessions.length / 3) * accuracy, 0, 1) * 100) / 100;
  const span = correctSessions.length > 1
    ? correctSessions.at(-1).occurredAt - correctSessions[0].occurredAt
    : 0;
  const mastered = correctSessions.length >= 3 &&
    span >= DAY_MS;

  return {
    level,
    status: mastered ? 'mastered' : 'learning',
    sampleSize: evidence.length,
    lastEvidenceAt: evidence.at(-1).occurredAt,
  };
}

export function createReviewSchedule(now = Date.now()) {
  finiteTimestamp(now, 'now');
  return {
    version: REVIEW_SCHEDULE_VERSION,
    dueAt: now,
    intervalDays: 0,
    easeFactor: 2.5,
    consecutiveSuccesses: 0,
    lapses: 0,
    lastReviewedAt: null,
  };
}

export function advanceReviewSchedule(rawSchedule, result, now = Date.now()) {
  const schedule = rawSchedule?.version === REVIEW_SCHEDULE_VERSION
    ? rawSchedule
    : createReviewSchedule(now);
  finiteTimestamp(now, 'now');
  if (!result || typeof result.correct !== 'boolean' || !isHighConfidenceEvidence(result)) return schedule;

  if (!result.correct) {
    return {
      ...schedule,
      dueAt: now + DAY_MS,
      intervalDays: 1,
      easeFactor: Math.max(1.3, schedule.easeFactor - 0.2),
      consecutiveSuccesses: 0,
      lapses: schedule.lapses + 1,
      lastReviewedAt: now,
    };
  }

  const successes = schedule.consecutiveSuccesses + 1;
  const quality = clamp(Number.isFinite(result.quality) ? result.quality : 4, 3, 5);
  const easeFactor = Math.max(
    1.3,
    schedule.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
  );
  const intervalDays = successes === 1
    ? 1
    : successes === 2
      ? 6
      : Math.max(1, Math.round(Math.max(1, schedule.intervalDays) * easeFactor));

  return {
    ...schedule,
    dueAt: now + intervalDays * DAY_MS,
    intervalDays,
    easeFactor: Math.round(easeFactor * 100) / 100,
    consecutiveSuccesses: successes,
    lastReviewedAt: now,
  };
}

export function normalizeAssessmentAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
}

export function assessmentAnswerKey(value) {
  const normalized = normalizeAssessmentAnswer(value);
  const match = normalized.match(/^([a-z])(?:[.．、:：)）\s]|$)/i);
  return match ? match[1] : normalized;
}

function answersMatch(question, userAnswer) {
  if (normalizeAssessmentAnswer(userAnswer) === normalizeAssessmentAnswer(question.expectedAnswer)) return true;
  return Array.isArray(question.options) && question.options.length > 0 &&
    assessmentAnswerKey(userAnswer) === assessmentAnswerKey(question.expectedAnswer);
}

export function createReviewSession(input) {
  if (!input || typeof input !== 'object') throw new TypeError('session input is required');
  const id = String(input.id || '').trim();
  const planId = String(input.planId || '').trim();
  const topicId = String(input.topicId || '').trim();
  const topicTitle = String(input.topicTitle || '').trim();
  if (!id || !planId || !topicId) throw new TypeError('id, planId, and topicId are required');
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  if (rawQuestions.length === 0) throw new TypeError('questions are required');
  const seen = new Set();
  const questions = rawQuestions.map((raw, index) => {
    const questionId = String(raw?.id || `q${index + 1}`).trim();
    const prompt = String(raw?.prompt || raw?.question || '').trim();
    const expectedAnswer = String(raw?.expectedAnswer ?? raw?.answer ?? '').trim();
    if (!questionId || seen.has(questionId)) throw new TypeError('question ids must be unique');
    if (!prompt || !expectedAnswer) throw new TypeError('question prompt and expectedAnswer are required');
    seen.add(questionId);
    const gradingMethod = raw?.gradingMethod === 'ai'
      ? 'ai'
      : raw?.gradingMethod === 'exact-only'
        ? 'exact-only'
        : 'deterministic';
    return Object.freeze({
      id: questionId,
      prompt,
      expectedAnswer,
      explanation: String(raw?.explanation || '').trim(),
      conceptKey: normalizeConceptKey(raw?.conceptKey || topicTitle),
      options: Object.freeze(Array.isArray(raw?.options) ? raw.options.map(String) : []),
      gradingMethod,
      confidence: gradingMethod === 'ai'
        ? finiteConfidence(Number.isFinite(raw?.confidence) ? raw.confidence : 0.5)
        : 1,
    });
  });
  const createdAt = finiteTimestamp(input.createdAt ?? Date.now(), 'createdAt');
  return {
    id,
    planId,
    topicId,
    topicTitle,
    kind: input.kind === 'mistake-repair' ? 'mistake-repair' : 'review',
    targetConceptKey: input.kind === 'mistake-repair'
      ? normalizeConceptKey(input.targetConceptKey)
      : '',
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    estimatedMinutes: clamp(Number(input.estimatedMinutes) || questions.length * 2, 1, 120),
    questions: Object.freeze(questions),
    results: [],
  };
}

export function projectReviewSession(session) {
  if (!session || typeof session !== 'object') return null;
  const projected = {
    id: session.id,
    planId: session.planId,
    topicId: session.topicId,
    topicTitle: session.topicTitle,
    kind: session.kind,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    estimatedMinutes: session.estimatedMinutes,
    questions: (Array.isArray(session.questions) ? session.questions : []).map(question => ({
      id: question.id,
      prompt: question.prompt,
      conceptKey: question.conceptKey,
      options: Array.isArray(question.options) ? [...question.options] : [],
    })),
  };
  if (session.targetConceptKey) projected.targetConceptKey = session.targetConceptKey;
  if (session.status === 'completed') projected.results = clone(session.results || []);
  return projected;
}

export function submitReviewSession(session, input) {
  if (!session || session.status !== 'active') throw new Error('Review Session is not active');
  if (String(input?.sessionId || '') !== session.id) throw new Error('sessionId does not match the active Review Session');
  const submittedAt = finiteTimestamp(input.submittedAt ?? Date.now(), 'submittedAt');
  const submittedAnswers = Array.isArray(input.answers) ? input.answers : [];
  const answerIds = submittedAnswers.map(answer => String(answer?.questionId || ''));
  const questionIds = session.questions.map(question => question.id);
  if (answerIds.length !== questionIds.length ||
      new Set(answerIds).size !== answerIds.length ||
      answerIds.some(id => !questionIds.includes(id))) {
    throw new Error('submitted answers do not match the persisted question set');
  }
  const answers = new Map(submittedAnswers.map(answer => [String(answer.questionId), answer.answer]));
  const source = session.kind === 'mistake-repair' ? 'Mistake Repair' : 'Review';
  const results = session.questions.map(question => {
    const userAnswer = String(answers.get(question.id) ?? '').trim();
    const correct = answersMatch(question, userAnswer);
    const uncertainMismatch = question.gradingMethod === 'exact-only' && !correct;
    return {
      questionId: question.id,
      userAnswer,
      correct,
      confidence: uncertainMismatch ? 0.5 : question.confidence,
      gradingMethod: uncertainMismatch || question.gradingMethod === 'ai' ? 'ai' : 'deterministic',
      expectedAnswer: question.expectedAnswer,
      explanation: question.explanation,
      conceptKey: question.conceptKey,
    };
  });
  const evidence = results.map(result => createMasteryEvidence({
    source,
    sourceRef: `${session.id}:${result.questionId}`,
    sessionId: session.id,
    occurredAt: submittedAt,
    correct: result.correct,
    confidence: result.confidence,
    gradingMethod: result.gradingMethod,
    conceptKey: result.conceptKey,
    questionRef: result.questionId,
  }));
  return {
    session: {
      ...session,
      status: 'completed',
      submittedAt,
      updatedAt: submittedAt,
      results,
    },
    results,
    evidence,
  };
}

export function deferReviewSchedule(rawSchedule, until, deferredAt = Date.now()) {
  finiteTimestamp(until, 'until');
  finiteTimestamp(deferredAt, 'deferredAt');
  const schedule = rawSchedule?.version === REVIEW_SCHEDULE_VERSION
    ? rawSchedule
    : createReviewSchedule(until);
  return { ...schedule, dueAt: until, deferredAt };
}

function mistakeKey(record) {
  return normalizeConceptKey(record?.conceptKey);
}

export function recordMistake(rawRecords, input) {
  const records = clone(Array.isArray(rawRecords) ? rawRecords : []);
  const conceptKey = normalizeConceptKey(input?.conceptKey);
  if (!conceptKey) throw new TypeError('conceptKey is required');
  const occurredAt = finiteTimestamp(input.occurredAt, 'occurredAt');
  const index = records.findIndex(record => mistakeKey(record) === conceptKey);
  const occurrence = {
    source: canonicalSource(input.source),
    sourceRef: String(input.sourceRef || '').trim(),
    occurredAt,
  };
  if (input.questionRef) occurrence.questionRef = String(input.questionRef);
  if (!occurrence.sourceRef) throw new TypeError('sourceRef is required');

  if (index === -1) {
    records.push({
      conceptKey,
      status: 'open',
      openedAt: occurredAt,
      lastErrorAt: occurredAt,
      occurrences: [occurrence],
    });
    return records;
  }

  records[index] = {
    ...records[index],
    status: 'open',
    lastErrorAt: occurredAt,
    repairingAt: null,
    repairSessionId: null,
    verificationDueAt: null,
    verifiedAt: null,
    dismissedAt: null,
    dismissReason: null,
    occurrences: [...(records[index].occurrences || []), occurrence],
  };
  return records;
}

export function applyMistakeEvidence(rawRecords, rawEvidence) {
  const records = clone(Array.isArray(rawRecords) ? rawRecords : []);
  const evidence = createMasteryEvidence(rawEvidence);
  if (!evidence.conceptKey || !isHighConfidenceEvidence(evidence)) return records;
  const index = records.findIndex(record => mistakeKey(record) === evidence.conceptKey);
  if (index === -1) return records;
  const current = records[index];

  if (!evidence.correct) {
    records[index] = {
      ...current,
      status: 'open',
      lastErrorAt: evidence.occurredAt,
      repairingAt: null,
      repairSessionId: null,
      verificationDueAt: null,
      verifiedAt: null,
    };
    return records;
  }

  if (current.status === 'open') {
    records[index] = {
      ...current,
      status: 'repairing',
      repairingAt: evidence.occurredAt,
      repairSessionId: evidence.sessionId,
      verificationDueAt: evidence.occurredAt + DAY_MS,
    };
    return records;
  }

  if (current.status === 'repairing' &&
      evidence.sessionId !== current.repairSessionId &&
      evidence.occurredAt >= current.verificationDueAt) {
    records[index] = { ...current, status: 'verified', verifiedAt: evidence.occurredAt };
  }
  return records;
}

export function dismissMistake(rawRecords, conceptKey, dismissedAt = Date.now(), reason = '') {
  finiteTimestamp(dismissedAt, 'dismissedAt');
  const normalized = normalizeConceptKey(conceptKey);
  return (Array.isArray(rawRecords) ? rawRecords : []).map(record => {
    if (mistakeKey(record) !== normalized || record.status === 'verified' || record.status === 'dismissed') {
      return clone(record);
    }
    return { ...clone(record), status: 'dismissed', dismissedAt, dismissReason: String(reason).slice(0, 300) };
  });
}

function topicPriority(topic, now) {
  if (Number.isFinite(topic.reviewDeferredUntil) && topic.reviewDeferredUntil > now) return null;
  const records = Array.isArray(topic.mistakeRecords) ? topic.mistakeRecords : [];
  const open = records.find(record => record.status === 'open');
  if (open) return {
    priority: 0,
    reason: 'open-mistake',
    dueAt: open.lastErrorAt || open.openedAt || now,
    mistake: { conceptKey: open.conceptKey, status: open.status },
  };
  const repairing = records.find(record => record.status === 'repairing' && record.verificationDueAt <= now);
  if (repairing) return {
    priority: 1,
    reason: 'repairing-due',
    dueAt: repairing.verificationDueAt,
    mistake: { conceptKey: repairing.conceptKey, status: repairing.status },
  };

  const dueAt = topic.reviewSchedule?.dueAt;
  if (!Number.isFinite(dueAt) || dueAt > now) return null;
  return dueAt < now
    ? { priority: 2, reason: 'overdue-review', dueAt }
    : { priority: 3, reason: 'due-review', dueAt };
}

export function buildTodayReview(rawPlans, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const budgetMinutes = clamp(Number(options.budgetMinutes) || 30, 10, 120);
  const candidates = [];
  const seen = new Set();

  for (const plan of Array.isArray(rawPlans) ? rawPlans : []) {
    for (const topic of Array.isArray(plan?.topics) ? plan.topics : []) {
      const uniqueKey = `${plan.id}:${topic.id}`;
      if (seen.has(uniqueKey)) continue;
      const priority = topicPriority(topic, now);
      if (!priority) continue;
      seen.add(uniqueKey);
      const estimatedMinutes = clamp(Number(topic.estimatedReviewMinutes) || 5, 1, 120);
      candidates.push({
        planId: plan.id,
        planName: plan.name || '',
        topicId: topic.id,
        topicTitle: topic.title || '',
        reason: priority.reason,
        priority: priority.priority,
        dueAt: priority.dueAt,
        overdueDays: Math.max(0, Math.floor((now - priority.dueAt) / DAY_MS)),
        lapses: Number(topic.reviewSchedule?.lapses) || 0,
        masteryLevel: Number(topic.mastery?.level) || 0,
        estimatedMinutes,
        activeSession: topic.reviewSession?.status === 'active' ? projectReviewSession(topic.reviewSession) : null,
        mistake: priority.mistake || null,
      });
    }
  }

  candidates.sort((a, b) =>
    a.priority - b.priority ||
    b.overdueDays - a.overdueDays ||
    b.lapses - a.lapses ||
    a.masteryLevel - b.masteryLevel ||
    String(a.planId).localeCompare(String(b.planId)) ||
    String(a.topicId).localeCompare(String(b.topicId))
  );

  const items = [];
  let scheduledMinutes = 0;
  for (const item of candidates) {
    if (scheduledMinutes + item.estimatedMinutes > budgetMinutes) continue;
    items.push(item);
    scheduledMinutes += item.estimatedMinutes;
  }
  return {
    generatedAt: now,
    budgetMinutes,
    scheduledMinutes,
    totalCount: candidates.length,
    remainingCount: candidates.length - items.length,
    items,
  };
}

function legacyEvidence(topic, plan) {
  const evidence = [];
  for (const exercise of Array.isArray(topic.exercises) ? topic.exercises : []) {
    if (!exercise?.id || !Number.isFinite(exercise.gradedAt) || typeof exercise.correct !== 'boolean') continue;
    const appended = appendMasteryEvidence(evidence, {
      source: 'Exercise',
      sourceRef: `${topic.id}:exercise:${exercise.id}`,
      sessionId: exercise.sessionId || `legacy-exercise:${exercise.gradedAt}`,
      occurredAt: exercise.gradedAt,
      correct: exercise.correct,
      confidence: Number.isFinite(exercise.confidence) ? exercise.confidence : 0.5,
      conceptKey: exercise.conceptTag || topic.title,
      gradingMethod: exercise.gradingMethod,
    });
    if (appended.added) evidence.push(appended.evidence);
  }

  for (const paper of Array.isArray(plan.examPapers) ? plan.examPapers : []) {
    const occurredAt = paper?.gradedAt;
    if (!paper?.id || !Number.isFinite(occurredAt)) continue;
    const questions = Array.isArray(paper.questions) ? paper.questions : [];
    for (const result of Array.isArray(paper.results) ? paper.results : []) {
      const question = questions[result?.exerciseIndex];
      if (question?.topicId !== topic.id || typeof result.correct !== 'boolean') continue;
      const appended = appendMasteryEvidence(evidence, {
        source: 'Exam',
        sourceRef: `${paper.id}:${result.exerciseIndex}`,
        sessionId: paper.id,
        occurredAt,
        correct: result.correct,
        confidence: Number.isFinite(result.confidence) ? result.confidence : 0.5,
        conceptKey: question.conceptTag || topic.title,
        gradingMethod: result.gradingMethod,
      });
      if (appended.added) evidence.push(appended.evidence);
    }
  }

  for (const quiz of Array.isArray(plan.quickQuizHistory) ? plan.quickQuizHistory : []) {
    if (!quiz?.id || !Number.isFinite(quiz.createdAt)) continue;
    const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
    for (const result of Array.isArray(quiz.results) ? quiz.results : []) {
      const question = questions[result?.exerciseIndex];
      const matches = question?.topicId === topic.id || question?.topicTitle === topic.title;
      if (!matches || typeof result.correct !== 'boolean') continue;
      const appended = appendMasteryEvidence(evidence, {
        source: 'Quiz',
        sourceRef: `${quiz.id}:${result.exerciseIndex}`,
        sessionId: quiz.id,
        occurredAt: quiz.createdAt,
        correct: result.correct,
        confidence: Number.isFinite(result.confidence) ? result.confidence : 0.5,
        conceptKey: question.conceptTag || topic.title,
        gradingMethod: result.gradingMethod,
      });
      if (appended.added) evidence.push(appended.evidence);
    }
  }
  return evidence;
}

export function migrateLegacyPlan(rawPlan, now = Date.now()) {
  const plan = clone(rawPlan || {});
  plan.masterySchemaVersion = MASTERY_SCHEMA_VERSION;
  plan.topics = (Array.isArray(plan.topics) ? plan.topics : []).map(rawTopic => {
    const topic = { ...rawTopic, studied: rawTopic.studied === true || rawTopic.done === true };
    let evidence = [];
    for (const rawEvidence of Array.isArray(topic.masteryEvidence) ? topic.masteryEvidence : []) {
      try {
        const appended = appendMasteryEvidence(evidence, rawEvidence);
        if (appended.added) evidence.push(appended.evidence);
      } catch {}
    }
    for (const item of legacyEvidence(topic, plan)) {
      const appended = appendMasteryEvidence(evidence, item);
      if (appended.added) evidence.push(appended.evidence);
    }
    topic.masteryEvidence = evidence;
    topic.mastery = deriveMastery(evidence);
    topic.mistakeRecords = Array.isArray(topic.mistakeRecords) ? topic.mistakeRecords : [];
    if (!topic.reviewSchedule && (topic.studied || evidence.length > 0)) {
      topic.reviewSchedule = createReviewSchedule(
        topic.mastery.lastEvidenceAt || Number(rawTopic.reviewUpdatedAt) || now,
      );
    }
    return topic;
  });
  return plan;
}

export function computeMasteryMetrics(rawPlans, now = Date.now(), options = {}) {
  const plans = Array.isArray(rawPlans) ? rawPlans : [];
  let due = 0;
  let overdueAgeDays = 0;
  let openMistakes = 0;
  let verifiedMistakes = 0;
  let duplicateEvidence = 0;
  let completedReviews = 0;
  let deferredReviews = 0;
  let totalRepairMilliseconds = 0;
  let measuredRepairs = 0;
  for (const plan of plans) {
    for (const topic of Array.isArray(plan?.topics) ? plan.topics : []) {
      if (Number.isFinite(topic.reviewSchedule?.dueAt) && topic.reviewSchedule.dueAt <= now) {
        due += 1;
        overdueAgeDays += Math.max(0, Math.floor((now - topic.reviewSchedule.dueAt) / DAY_MS));
      }
      completedReviews += Math.max(0, Number(topic.reviewCompletionCount) || 0);
      deferredReviews += Math.max(0, Number(topic.reviewDeferralCount) || 0);
      const seen = new Set();
      for (const item of Array.isArray(topic.masteryEvidence) ? topic.masteryEvidence : []) {
        const key = `${item?.source}:${item?.sourceRef}`;
        if (seen.has(key)) duplicateEvidence += 1;
        seen.add(key);
      }
      for (const record of Array.isArray(topic.mistakeRecords) ? topic.mistakeRecords : []) {
        if (record.status === 'open' || record.status === 'repairing') openMistakes += 1;
        if (record.status === 'verified') {
          verifiedMistakes += 1;
          if (Number.isFinite(record.openedAt) && Number.isFinite(record.verifiedAt) && record.verifiedAt >= record.openedAt) {
            totalRepairMilliseconds += record.verifiedAt - record.openedAt;
            measuredRepairs += 1;
          }
        }
      }
    }
  }
  const reviewOpportunities = completedReviews + deferredReviews;
  const budgetMinutes = clamp(Number(options.budgetMinutes) || 30, 10, 120);
  const queue = buildTodayReview(plans, { now, budgetMinutes });
  return {
    dueCount: due,
    averageOverdueDays: due > 0 ? Math.round((overdueAgeDays / due) * 10) / 10 : 0,
    openMistakes,
    verifiedMistakes,
    duplicateEvidence,
    reviewCompletionRate: reviewOpportunities > 0
      ? Math.round((completedReviews / reviewOpportunities) * 100) / 100
      : 0,
    averageMistakeRepairHours: measuredRepairs > 0
      ? Math.round((totalRepairMilliseconds / measuredRepairs / (60 * 60 * 1000)) * 10) / 10
      : 0,
    budgetOverrunCount: queue.remainingCount,
  };
}
