import { createHash } from 'node:crypto';
import { createMasteryEvidence } from './mastery-scheduler.js';

export const MISTAKE_RECORD_VERSION = 1;
export const MISTAKE_VERIFICATION_DELAY_MS = 24 * 60 * 60 * 1000;
export const MISTAKE_STATUSES = Object.freeze(['open', 'repairing', 'verified', 'dismissed']);
export const MISTAKE_SEVERITIES = Object.freeze(['low', 'medium', 'high']);

const OBJECTIVE_SOURCES = new Set(['exercise', 'quickQuiz', 'exam', 'review', 'repair']);

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

function normalizeText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized) throw new RangeError(`${label} must not be empty`);
  return normalized;
}

function normalizeNullableText(value, label) {
  if (value === null) return null;
  return normalizeText(value, label);
}

function normalizeId(value, label) {
  const normalized = normalizeText(value, label);
  if (normalized.length > 128) throw new RangeError(`${label} must contain at most 128 characters`);
  return normalized;
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeId(value, `${label} entry`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeConceptLabel(value) {
  return normalizeText(value, 'conceptLabel');
}

export function normalizeConceptKey(value) {
  return normalizeConceptLabel(value).toLowerCase();
}

export function defaultMistakeIdFactory({ conceptKey }) {
  const digest = createHash('sha256').update(conceptKey, 'utf8').digest('hex').slice(0, 20);
  return `mistake-${digest}`;
}

export function normalizeMistakeRecord(input) {
  requireObject(input, 'MistakeRecord');
  const id = normalizeId(input.id, 'MistakeRecord id');
  const conceptLabel = normalizeConceptLabel(input.conceptLabel);
  const conceptKey = normalizeConceptKey(input.conceptKey);
  if (!MISTAKE_STATUSES.includes(input.status)) {
    throw new TypeError(`status must be one of: ${MISTAKE_STATUSES.join(', ')}`);
  }
  if (!MISTAKE_SEVERITIES.includes(input.severity)) {
    throw new TypeError(`severity must be one of: ${MISTAKE_SEVERITIES.join(', ')}`);
  }
  if (!Number.isInteger(input.occurrenceCount) || input.occurrenceCount < 1) {
    throw new RangeError('occurrenceCount must be a positive integer');
  }

  return {
    ...structuredClone(input),
    id,
    version: MISTAKE_RECORD_VERSION,
    conceptKey,
    conceptLabel,
    status: input.status,
    severity: input.severity,
    evidenceIds: uniqueStrings(input.evidenceIds, 'evidenceIds'),
    occurrenceCount: input.occurrenceCount,
    firstSeenAt: requireEpoch(input.firstSeenAt, 'firstSeenAt'),
    lastSeenAt: requireEpoch(input.lastSeenAt, 'lastSeenAt'),
    verificationDueAt: requireEpoch(input.verificationDueAt, 'verificationDueAt', { nullable: true }),
    verifiedAt: requireEpoch(input.verifiedAt, 'verifiedAt', { nullable: true }),
    verificationEvidenceId: input.verificationEvidenceId === null
      ? null
      : normalizeId(input.verificationEvidenceId, 'verificationEvidenceId'),
    dismissedAt: requireEpoch(input.dismissedAt, 'dismissedAt', { nullable: true }),
    dismissReason: normalizeNullableText(input.dismissReason, 'dismissReason'),
  };
}

export function normalizeMistakeRecords(input) {
  if (!Array.isArray(input)) throw new TypeError('mistakes must be an array');
  const records = input.map(normalizeMistakeRecord);
  const ids = new Set();
  const conceptKeys = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw new TypeError(`duplicate MistakeRecord id: ${record.id}`);
    if (conceptKeys.has(record.conceptKey)) {
      throw new TypeError(`duplicate MistakeRecord conceptKey: ${record.conceptKey}`);
    }
    ids.add(record.id);
    conceptKeys.add(record.conceptKey);
  }
  return records;
}

function createRecord({ conceptKey, conceptLabel, errors, idFactory }) {
  const firstSeenAt = Math.min(...errors.map(item => item.observedAt));
  const lastSeenAt = Math.max(...errors.map(item => item.observedAt));
  const id = normalizeId(idFactory({ conceptKey, conceptLabel }), 'generated MistakeRecord id');
  return {
    id,
    version: MISTAKE_RECORD_VERSION,
    conceptKey,
    conceptLabel,
    status: 'open',
    severity: errors.some(item => item.score < 0.4) ? 'medium' : 'low',
    evidenceIds: uniqueStrings(errors.map(item => item.id), 'evidenceIds'),
    occurrenceCount: 1,
    firstSeenAt,
    lastSeenAt,
    verificationDueAt: null,
    verifiedAt: null,
    verificationEvidenceId: null,
    dismissedAt: null,
    dismissReason: null,
  };
}

function reopenRecord(record, errors) {
  return {
    ...record,
    status: 'open',
    severity: 'high',
    evidenceIds: uniqueStrings([...record.evidenceIds, ...errors.map(item => item.id)], 'evidenceIds'),
    occurrenceCount: record.occurrenceCount + 1,
    lastSeenAt: Math.max(record.lastSeenAt, ...errors.map(item => item.observedAt)),
    verificationDueAt: null,
    verifiedAt: null,
    verificationEvidenceId: null,
    dismissedAt: null,
    dismissReason: null,
  };
}

function applyQualifiedCorrection(record, correction, { sameBatchError = false } = {}) {
  const verificationDueAt = record.lastSeenAt + MISTAKE_VERIFICATION_DELAY_MS;
  if (!sameBatchError && correction.observedAt >= verificationDueAt) {
    return {
      ...record,
      status: 'verified',
      verificationDueAt: null,
      verifiedAt: correction.observedAt,
      verificationEvidenceId: correction.id,
      dismissedAt: null,
      dismissReason: null,
    };
  }
  return {
    ...record,
    status: 'repairing',
    verificationDueAt,
    verifiedAt: null,
    verificationEvidenceId: null,
    dismissedAt: null,
    dismissReason: null,
  };
}

function groupEvidenceByConcept(evidence, topicTitle) {
  const groups = new Map();
  for (const item of evidence) {
    if (!OBJECTIVE_SOURCES.has(item.source)) continue;
    const labels = item.conceptTags.length > 0 ? item.conceptTags : [topicTitle];
    const seenForItem = new Set();
    for (const rawLabel of labels) {
      const conceptLabel = normalizeConceptLabel(rawLabel);
      const conceptKey = normalizeConceptKey(conceptLabel);
      if (seenForItem.has(conceptKey)) continue;
      seenForItem.add(conceptKey);
      if (!groups.has(conceptKey)) groups.set(conceptKey, { conceptKey, conceptLabel, evidence: [] });
      groups.get(conceptKey).evidence.push(item);
    }
  }
  return groups;
}

export function applyEvidenceToMistakeLedger(
  currentMistakes,
  evidenceBatch,
  { topicTitle, idFactory = defaultMistakeIdFactory } = {}
) {
  const normalizedTopicTitle = normalizeConceptLabel(topicTitle);
  if (typeof idFactory !== 'function') throw new TypeError('idFactory must be a function');
  const original = normalizeMistakeRecords(currentMistakes);
  if (!Array.isArray(evidenceBatch)) throw new TypeError('evidenceBatch must be an array');
  const evidence = evidenceBatch.map(createMasteryEvidence).sort((left, right) => (
    left.observedAt - right.observedAt || left.id.localeCompare(right.id)
  ));
  if (new Set(evidence.map(item => item.attemptRef)).size > 1) {
    throw new TypeError('evidenceBatch must contain one attemptRef');
  }

  const next = original.map(record => structuredClone(record));
  const recordByConcept = new Map(next.map(record => [record.conceptKey, record]));
  const groups = groupEvidenceByConcept(evidence, normalizedTopicTitle);

  for (const group of groups.values()) {
    const errors = group.evidence.filter(item => item.quality < 3);
    const corrections = group.evidence.filter(item => (
      item.confidence === 'high' && item.score >= 0.8 && item.quality >= 4
    ));
    let record = recordByConcept.get(group.conceptKey);

    if (errors.length > 0) {
      if (record) {
        const index = next.findIndex(item => item.id === record.id);
        record = reopenRecord(record, errors);
        next[index] = record;
      } else {
        record = createRecord({ ...group, errors, idFactory });
        if (next.some(item => item.id === record.id)) {
          throw new TypeError(`duplicate generated MistakeRecord id: ${record.id}`);
        }
        next.push(record);
      }
      recordByConcept.set(group.conceptKey, record);

      if (corrections.length > 0) {
        const index = next.findIndex(item => item.id === record.id);
        record = applyQualifiedCorrection(record, corrections.at(-1), { sameBatchError: true });
        next[index] = record;
        recordByConcept.set(group.conceptKey, record);
      }
      continue;
    }

    if (!record || !['open', 'repairing'].includes(record.status) || corrections.length === 0) continue;
    const index = next.findIndex(item => item.id === record.id);
    record = applyQualifiedCorrection(record, corrections.at(-1));
    next[index] = record;
    recordByConcept.set(group.conceptKey, record);
  }

  return {
    mistakes: next,
    changed: JSON.stringify(next) !== JSON.stringify(original),
    protectedEvidenceIds: getActiveMistakeEvidenceIds(next),
  };
}

function transitionMistake(currentMistakes, mistakeId, transition) {
  const mistakes = normalizeMistakeRecords(currentMistakes);
  const normalizedId = normalizeId(mistakeId, 'mistakeId');
  const index = mistakes.findIndex(record => record.id === normalizedId);
  if (index === -1) throw new RangeError('MistakeRecord not found');
  const updated = transition(mistakes[index]);
  mistakes[index] = normalizeMistakeRecord(updated);
  return { mistakes, changed: true, mistake: mistakes[index] };
}

export function startMistakeRepair(currentMistakes, mistakeId, { now } = {}) {
  requireEpoch(now, 'now');
  return transitionMistake(currentMistakes, mistakeId, record => {
    if (!['open', 'repairing'].includes(record.status)) {
      throw new TypeError(`illegal repair transition from ${record.status}`);
    }
    return record.status === 'repairing' ? record : {
      ...record,
      status: 'repairing',
      verificationDueAt: null,
      verifiedAt: null,
      verificationEvidenceId: null,
      dismissedAt: null,
      dismissReason: null,
    };
  });
}

export function dismissMistake(currentMistakes, mistakeId, reason, { now } = {}) {
  const dismissedAt = requireEpoch(now, 'now');
  if (typeof reason !== 'string') throw new TypeError('dismiss reason must be a string');
  const dismissReason = reason.trim();
  if (dismissReason.length < 1 || dismissReason.length > 200) {
    throw new RangeError('dismiss reason must contain 1..200 characters');
  }
  return transitionMistake(currentMistakes, mistakeId, record => {
    if (!['open', 'repairing'].includes(record.status)) {
      throw new TypeError(`illegal dismiss transition from ${record.status}`);
    }
    return {
      ...record,
      status: 'dismissed',
      verificationDueAt: null,
      verifiedAt: null,
      verificationEvidenceId: null,
      dismissedAt,
      dismissReason,
    };
  });
}

export function getActiveMistakeEvidenceIds(currentMistakes) {
  const activeIds = [];
  const seen = new Set();
  for (const record of normalizeMistakeRecords(currentMistakes)) {
    if (!['open', 'repairing'].includes(record.status)) continue;
    for (const id of record.evidenceIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      activeIds.push(id);
    }
  }
  return activeIds;
}
