import { createHash } from 'node:crypto';

export const EVIDENCE_SOURCES = Object.freeze([
  'exercise',
  'quickQuiz',
  'exam',
  'feynman',
  'review',
  'repair',
]);

export const EVIDENCE_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const MASTERY_EVIDENCE_VERSION = 1;
export const MASTERY_ALGORITHM = 'evidence-v1';
export const REVIEW_ALGORITHM = 'sm2-v1';

const ATTEMPT_REF_MIN_LENGTH = 8;
const ATTEMPT_REF_MAX_LENGTH = 128;
const SOURCE_REF_MAX_LENGTH = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
const MASTERY_WINDOW_SIZE = 20;
const MASTERY_EVIDENCE_SOFT_LIMIT = 200;
const CONFIDENCE_WEIGHTS = Object.freeze({ high: 1, medium: 0.7, low: 0.4 });

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function requireEpoch(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative epoch millisecond integer`);
  }
  return value;
}

function normalizeAttemptRef(value) {
  if (typeof value !== 'string') {
    throw new TypeError('attemptRef must be a string');
  }
  const normalized = value.trim();
  if (normalized.length < ATTEMPT_REF_MIN_LENGTH || normalized.length > ATTEMPT_REF_MAX_LENGTH) {
    throw new RangeError(`attemptRef must contain ${ATTEMPT_REF_MIN_LENGTH}..${ATTEMPT_REF_MAX_LENGTH} characters`);
  }
  return normalized;
}

function normalizeSourceRef(value, attemptRef) {
  if (typeof value !== 'string') {
    throw new TypeError('sourceRef must be a string');
  }
  const normalized = value.trim();
  if (normalized.length > SOURCE_REF_MAX_LENGTH) {
    throw new RangeError(`sourceRef must contain at most ${SOURCE_REF_MAX_LENGTH} characters`);
  }
  const prefix = `${attemptRef}:`;
  if (!normalized.startsWith(prefix) || normalized.length === prefix.length) {
    throw new TypeError('sourceRef must contain attemptRef followed by a non-empty item reference');
  }
  return normalized;
}

export function normalizeConceptTags(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('conceptTags must be an array');
  }

  const normalized = [];
  const seen = new Set();
  for (const tag of value) {
    if (typeof tag !== 'string') {
      throw new TypeError('conceptTags entries must be strings');
    }
    const clean = tag.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }
  return normalized;
}

export function scoreToQuality(score) {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new RangeError('score must be a finite number between 0 and 1');
  }
  if (score >= 0.9) return 5;
  if (score >= 0.75) return 4;
  if (score >= 0.6) return 3;
  if (score >= 0.4) return 2;
  if (score > 0) return 1;
  return 0;
}

export function createMasteryEvidence(input) {
  requireObject(input, 'MasteryEvidence input');

  if (!EVIDENCE_SOURCES.includes(input.source)) {
    throw new TypeError(`source must be one of: ${EVIDENCE_SOURCES.join(', ')}`);
  }
  if (!EVIDENCE_CONFIDENCE.includes(input.confidence)) {
    throw new TypeError(`confidence must be one of: ${EVIDENCE_CONFIDENCE.join(', ')}`);
  }
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
    throw new RangeError('score must be a finite number between 0 and 1');
  }
  if (!Number.isInteger(input.quality) || input.quality < 0 || input.quality > 5) {
    throw new RangeError('quality must be an integer between 0 and 5');
  }
  if (input.source === 'feynman' && input.quality > 4) {
    throw new RangeError('Feynman evidence quality cannot exceed 4');
  }

  const attemptRef = normalizeAttemptRef(input.attemptRef);
  const sourceRef = normalizeSourceRef(input.sourceRef, attemptRef);
  const observedAt = requireEpoch(input.observedAt, 'observedAt');
  const conceptTags = normalizeConceptTags(input.conceptTags);
  const id = createHash('sha256')
    .update(`${input.source}\0${sourceRef}`, 'utf8')
    .digest('hex')
    .slice(0, 24);

  return {
    id,
    version: MASTERY_EVIDENCE_VERSION,
    source: input.source,
    attemptRef,
    sourceRef,
    observedAt,
    score: input.score,
    quality: input.quality,
    confidence: input.confidence,
    conceptTags,
  };
}

function normalizeEvidenceCollection(evidence) {
  if (!Array.isArray(evidence)) {
    throw new TypeError('evidence must be an array');
  }
  return evidence.map(createMasteryEvidence).sort((left, right) => (
    left.observedAt - right.observedAt || left.id.localeCompare(right.id)
  ));
}

export function deriveMastery(evidence, { done = false } = {}) {
  const initial = createInitialMastery({ done });
  const normalized = normalizeEvidenceCollection(evidence);
  if (normalized.length === 0) return initial;

  const recent = normalized.slice(-MASTERY_WINDOW_SIZE);
  let weightedScore = 0;
  let totalWeight = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    const distanceFromLatest = recent.length - 1 - index;
    const recencyWeight = Math.max(0.25, 1 - 0.05 * distanceFromLatest);
    const weight = recencyWeight * CONFIDENCE_WEIGHTS[recent[index].confidence];
    weightedScore += recent[index].score * weight;
    totalWeight += weight;
  }

  const level = Math.round((weightedScore / totalWeight + Number.EPSILON) * 10_000) / 10_000;
  const latest = recent.at(-1);
  let status = level < 0.6 || latest.quality < 3 ? 'needsWork' : 'developing';
  const qualifyingHigh = recent.filter(item => item.confidence === 'high' && item.score >= 0.8);
  const attemptCount = new Set(recent.map(item => item.attemptRef)).size;
  const spansDay = qualifyingHigh.length >= 2
    && qualifyingHigh.at(-1).observedAt - qualifyingHigh[0].observedAt >= DAY_MS;
  if (level >= 0.8 && attemptCount >= 3 && qualifyingHigh.length >= 2 && spansDay) {
    status = 'mastered';
  }

  return {
    algorithm: MASTERY_ALGORITHM,
    level,
    status,
    sampleSize: recent.length,
    lastEvidenceAt: latest.observedAt,
  };
}

export function createInitialMastery({ done = false } = {}) {
  if (typeof done !== 'boolean') {
    throw new TypeError('done must be a boolean');
  }
  return {
    algorithm: MASTERY_ALGORITHM,
    level: 0,
    status: done ? 'learning' : 'unassessed',
    sampleSize: 0,
    lastEvidenceAt: null,
  };
}

export function createInitialReviewSchedule({ dueAt = null } = {}) {
  return {
    algorithm: REVIEW_ALGORITHM,
    dueAt: requireEpoch(dueAt, 'dueAt', { nullable: true }),
    intervalDays: 0,
    easeFactor: 2.5,
    repetitions: 0,
    lapses: 0,
    lastReviewedAt: null,
    lastQuality: null,
    paused: false,
  };
}

function normalizeReviewSchedule(schedule) {
  requireObject(schedule, 'ReviewSchedule');
  if (schedule.algorithm !== REVIEW_ALGORITHM) {
    throw new TypeError(`ReviewSchedule algorithm must be ${REVIEW_ALGORITHM}`);
  }
  requireEpoch(schedule.dueAt, 'dueAt', { nullable: true });
  requireEpoch(schedule.lastReviewedAt, 'lastReviewedAt', { nullable: true });
  if (!Number.isInteger(schedule.intervalDays) || schedule.intervalDays < 0 || schedule.intervalDays > 365) {
    throw new RangeError('intervalDays must be an integer between 0 and 365');
  }
  if (!Number.isFinite(schedule.easeFactor) || schedule.easeFactor < 1.3) {
    throw new RangeError('easeFactor must be a finite number greater than or equal to 1.3');
  }
  if (!Number.isInteger(schedule.repetitions) || schedule.repetitions < 0) {
    throw new RangeError('repetitions must be a non-negative integer');
  }
  if (!Number.isInteger(schedule.lapses) || schedule.lapses < 0) {
    throw new RangeError('lapses must be a non-negative integer');
  }
  if (schedule.lastQuality !== null
    && (!Number.isInteger(schedule.lastQuality) || schedule.lastQuality < 0 || schedule.lastQuality > 5)) {
    throw new RangeError('lastQuality must be null or an integer between 0 and 5');
  }
  if (typeof schedule.paused !== 'boolean') {
    throw new TypeError('paused must be a boolean');
  }
  return structuredClone(schedule);
}

export function advanceReviewSchedule(schedule, quality, { now } = {}) {
  const current = normalizeReviewSchedule(schedule);
  requireEpoch(now, 'now');
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
    throw new RangeError('quality must be an integer between 0 and 5');
  }

  const difference = 5 - quality;
  const easeFactor = Math.round(Math.max(
    1.3,
    current.easeFactor + 0.1 - difference * (0.08 + difference * 0.02)
  ) * 10_000) / 10_000;
  const successful = quality >= 3;
  const repetitions = successful ? current.repetitions + 1 : 0;
  let intervalDays = 1;
  if (successful && repetitions === 2) {
    intervalDays = 6;
  } else if (successful && repetitions > 2) {
    intervalDays = Math.round(current.intervalDays * easeFactor);
  }
  intervalDays = Math.max(1, Math.min(365, intervalDays));
  const dueAt = requireEpoch(now + intervalDays * DAY_MS, 'dueAt');

  return {
    ...current,
    algorithm: REVIEW_ALGORITHM,
    dueAt,
    intervalDays,
    easeFactor,
    repetitions,
    lapses: current.lapses + (successful ? 0 : 1),
    lastReviewedAt: now,
    lastQuality: quality,
  };
}

function evidenceKey(evidence) {
  return `${evidence.source}\0${evidence.sourceRef}`;
}

export function retainMasteryEvidence(evidence, { protectedEvidenceIds = [] } = {}) {
  if (!Array.isArray(protectedEvidenceIds) || protectedEvidenceIds.some(id => typeof id !== 'string')) {
    throw new TypeError('protectedEvidenceIds must be an array of strings');
  }
  const retained = normalizeEvidenceCollection(evidence);
  const protectedIds = new Set(protectedEvidenceIds);
  while (retained.length > MASTERY_EVIDENCE_SOFT_LIMIT) {
    const removableIndex = retained.findIndex(item => !protectedIds.has(item.id));
    if (removableIndex === -1) break;
    retained.splice(removableIndex, 1);
  }
  return retained;
}

export function applyMasteryEvidenceAttempt({
  currentEvidence,
  reviewSchedule,
  evidence,
  done = true,
  protectedEvidenceIds = [],
  now,
}) {
  requireEpoch(now, 'now');
  const existing = normalizeEvidenceCollection(currentEvidence);
  const currentSchedule = normalizeReviewSchedule(reviewSchedule);
  const incoming = normalizeEvidenceCollection(evidence);
  if (incoming.length === 0) {
    throw new RangeError('evidence must contain at least one item');
  }
  const attemptRefs = new Set(incoming.map(item => item.attemptRef));
  if (attemptRefs.size !== 1) {
    throw new TypeError('evidence items in one attempt must share attemptRef');
  }

  const knownKeys = new Set(existing.map(evidenceKey));
  const insertedEvidence = [];
  for (const item of incoming) {
    const key = evidenceKey(item);
    if (knownKeys.has(key)) continue;
    knownKeys.add(key);
    insertedEvidence.push(item);
  }

  if (insertedEvidence.length === 0) {
    return {
      inserted: false,
      insertedEvidence: [],
      aggregateQuality: null,
      masteryEvidence: existing,
      mastery: deriveMastery(existing, { done }),
      reviewSchedule: currentSchedule,
    };
  }

  const averageScore = insertedEvidence.reduce((sum, item) => sum + item.score, 0)
    / insertedEvidence.length;
  const aggregateQuality = Math.min(
    scoreToQuality(averageScore),
    insertedEvidence.some(item => item.source === 'feynman') ? 4 : 5
  );
  const masteryEvidence = retainMasteryEvidence([...existing, ...insertedEvidence], {
    protectedEvidenceIds,
  });

  return {
    inserted: true,
    insertedEvidence,
    aggregateQuality,
    masteryEvidence,
    mastery: deriveMastery(masteryEvidence, { done }),
    reviewSchedule: advanceReviewSchedule(currentSchedule, aggregateQuality, { now }),
  };
}

function compareStableStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validateReviewQueueInput(plans, now, limit) {
  requireEpoch(now, 'now');
  if (!Array.isArray(plans)) {
    throw new TypeError('plans must be an array');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer between 1 and 100');
  }
}

function collectDueReviewItems(plans, now) {
  const items = [];
  for (const plan of plans) {
    requireObject(plan, 'Plan');
    if (!Array.isArray(plan.topics)) {
      throw new TypeError('Plan topics must be an array');
    }
    for (const topic of plan.topics) {
      if (topic.done !== true || !topic.reviewSchedule || topic.reviewSchedule.paused === true) continue;
      const dueAt = requireEpoch(topic.reviewSchedule.dueAt, 'dueAt', { nullable: true });
      if (dueAt === null || dueAt > now) continue;
      const level = topic.mastery?.level;
      if (!Number.isFinite(level) || level < 0 || level > 1) {
        throw new RangeError('mastery.level must be a finite number between 0 and 1');
      }
      const overdueDays = Math.min(30, Math.max(0, Math.floor((now - dueAt) / DAY_MS)));
      const queueItemId = `review:${plan.id}:${topic.id}`;
      items.push({
        queueItemId,
        kind: 'review',
        planId: plan.id,
        planName: plan.name,
        topicId: topic.id,
        topicTitle: topic.title,
        dueAt,
        priorityScore: 200 + overdueDays + Math.round((1 - level) * 20),
        mastery: structuredClone(topic.mastery),
      });
    }
  }

  return items.sort((left, right) => (
    right.priorityScore - left.priorityScore
    || left.dueAt - right.dueAt
    || compareStableStrings(left.queueItemId, right.queueItemId)
  ));
}

export function buildDueReviewItems(plans, { now, limit = 20 } = {}) {
  validateReviewQueueInput(plans, now, limit);
  return collectDueReviewItems(plans, now).slice(0, limit);
}

const MISTAKE_SEVERITY_BONUS = Object.freeze({ low: 0, medium: 25, high: 50 });

function topicQueueKey(planId, topicId) {
  return `${planId}\0${topicId}`;
}

function publicMistakeSummary(record) {
  return {
    id: record.id,
    conceptLabel: record.conceptLabel,
    status: record.status,
    severity: record.severity,
    occurrenceCount: record.occurrenceCount,
    lastSeenAt: record.lastSeenAt,
    verificationDueAt: record.verificationDueAt,
  };
}

function collectMistakeQueueItems(plans, now, dueReviews) {
  const dueReviewKeys = new Set(dueReviews.map(item => topicQueueKey(item.planId, item.topicId)));
  const suppressedReviewKeys = new Set();
  const items = [];
  let waitingVerification = 0;

  for (const plan of plans) {
    for (const topic of plan.topics) {
      const candidates = [];
      for (const record of Array.isArray(topic.mistakes) ? topic.mistakes : []) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        let dueAt;
        if (record.status === 'open') {
          dueAt = requireEpoch(record.lastSeenAt, 'MistakeRecord lastSeenAt');
        } else if (record.status === 'repairing') {
          const verificationDueAt = requireEpoch(
            record.verificationDueAt,
            'MistakeRecord verificationDueAt',
            { nullable: true }
          );
          if (verificationDueAt !== null && verificationDueAt > now) {
            waitingVerification += 1;
            continue;
          }
          dueAt = verificationDueAt ?? requireEpoch(record.lastSeenAt, 'MistakeRecord lastSeenAt');
        } else {
          continue;
        }

        const severityBonus = MISTAKE_SEVERITY_BONUS[record.severity];
        if (severityBonus === undefined) {
          throw new TypeError('MistakeRecord severity must be low, medium, or high');
        }
        const overdueDays = Math.min(30, Math.max(0, Math.floor((now - dueAt) / DAY_MS)));
        candidates.push({
          record,
          dueAt,
          priorityScore: 300 + severityBonus + overdueDays,
        });
      }

      const key = topicQueueKey(plan.id, topic.id);
      if (candidates.length === 0) {
        // No actionable mistakes on this topic. When only future waiting-verification
        // mistakes exist, the due review must still appear in the queue — per the
        // frozen spec the topic is counted in waitingVerification but its scheduled
        // review is NOT suppressed. Only add to suppressedReviewKeys when there are
        // actual actionable mistake items (see the candidates.length > 0 branch below).
        continue;
      }

      suppressedReviewKeys.add(key);
      candidates.sort((left, right) => (
        right.priorityScore - left.priorityScore
        || left.dueAt - right.dueAt
        || compareStableStrings(String(left.record.id), String(right.record.id))
      ));
      const primary = candidates[0];
      const primaryMistake = publicMistakeSummary(primary.record);
      items.push({
        queueItemId: `mistake:${plan.id}:${topic.id}`,
        kind: 'mistake',
        planId: plan.id,
        planName: plan.name,
        topicId: topic.id,
        topicTitle: topic.title,
        dueAt: primary.dueAt,
        priorityScore: primary.priorityScore,
        mastery: topic.mastery ? structuredClone(topic.mastery) : null,
        scheduledReviewDue: dueReviewKeys.has(key),
        mistakeCount: candidates.length,
        primaryMistakeId: primary.record.id,
        primaryMistake,
        conceptLabel: primaryMistake.conceptLabel,
        status: primaryMistake.status,
        severity: primaryMistake.severity,
        occurrenceCount: primaryMistake.occurrenceCount,
        verificationDueAt: primaryMistake.verificationDueAt,
      });
    }
  }

  return { items, suppressedReviewKeys, waitingVerification };
}

export function buildTodayReviewQueue(plans, { now, limit = 20 } = {}) {
  validateReviewQueueInput(plans, now, limit);
  const dueReviews = collectDueReviewItems(plans, now);
  const mistakeQueue = collectMistakeQueueItems(plans, now, dueReviews);
  const reviews = dueReviews.filter(item => (
    !mistakeQueue.suppressedReviewKeys.has(topicQueueKey(item.planId, item.topicId))
  ));
  const items = [...mistakeQueue.items, ...reviews].sort((left, right) => (
    right.priorityScore - left.priorityScore
    || left.dueAt - right.dueAt
    || compareStableStrings(left.queueItemId, right.queueItemId)
  ));
  return {
    generatedAt: now,
    counts: {
      review: reviews.length,
      mistake: mistakeQueue.items.length,
      waitingVerification: mistakeQueue.waitingVerification,
      total: items.length,
    },
    items: items.slice(0, limit),
  };
}

export function createInitialTopicLearningState({ done = false, dueAt = null } = {}) {
  return {
    masteryEvidence: [],
    mastery: createInitialMastery({ done }),
    reviewSchedule: createInitialReviewSchedule({ dueAt }),
    reviewSession: null,
    mistakes: [],
  };
}
