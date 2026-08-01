import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import { registerPlanIdParams } from './middleware.js';

const router = Router();
registerPlanIdParams(router);

function parseTimestamp(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError(`${field} is required`);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError(`${field} must be a non-negative timestamp`);
  return parsed;
}

function parseBudget(value) {
  if (value === undefined || value === '') return 30;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 120) {
    throw new TypeError('budgetMinutes must be an integer between 10 and 120');
  }
  return parsed;
}

function validateTopicId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TypeError('topicId is invalid');
  }
}

function sendError(res, error) {
  if (error?.code === 'PLAN_NOT_FOUND' || error?.code === 'TOPIC_NOT_FOUND' || error?.code === 'MISTAKE_NOT_FOUND') {
    return res.status(404).json({ error: error.message, code: error.code });
  }
  if (/sessionId does not match/i.test(error?.message || '')) {
    return res.status(409).json({ error: error.message, code: 'SESSION_MISMATCH' });
  }
  if (/question set/i.test(error?.message || '')) {
    return res.status(409).json({ error: error.message, code: 'SESSION_QUESTION_SET_MISMATCH' });
  }
  if (/Review Session is not active/i.test(error?.message || '')) {
    return res.status(409).json({ error: error.message, code: 'SESSION_NOT_ACTIVE' });
  }
  if (error?.code === 'SESSION_CONFLICT') {
    return res.status(409).json({ error: error.message, code: error.code });
  }
  if (error instanceof TypeError || error?.code === 'INVALID_BACKUP') {
    return res.status(400).json({ error: error.message, code: error.code || 'INVALID_REQUEST' });
  }
  console.error('[mastery]', error);
  return res.status(500).json({ error: error?.message || 'Mastery operation failed' });
}

router.get('/today-review', (req, res) => {
  try {
    const budgetMinutes = parseBudget(req.query.budgetMinutes);
    const now = parseTimestamp(req.query.now, 'now');
    const queue = store.getTodayReview({ budgetMinutes, ...(now === undefined ? {} : { now }) });
    res.json({ queue });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/mastery/metrics', (req, res) => {
  try {
    const budgetMinutes = parseBudget(req.query.budgetMinutes);
    const now = parseTimestamp(req.query.now, 'now');
    const metrics = store.getMasteryMetrics({ budgetMinutes, ...(now === undefined ? {} : { now }) });
    res.json({ metrics });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/plans/:planId/topics/:topicId/mastery', async (req, res) => {
  try {
    validateTopicId(req.params.topicId);
    const now = parseTimestamp(req.query.now, 'now');
    const state = await store.getMasteryState(
      req.params.planId,
      req.params.topicId,
      now === undefined ? {} : { now },
    );
    res.json({ state });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/plans/:planId/topics/:topicId/mastery/evidence', async (req, res) => {
  try {
    validateTopicId(req.params.topicId);
    const result = await store.appendTopicMasteryEvidence(req.params.planId, req.params.topicId, req.body);
    res.status(result.added ? 201 : 200).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/plans/:planId/topics/:topicId/review-session', async (req, res) => {
  try {
    validateTopicId(req.params.topicId);
    const result = await store.createOrResumeReviewSession(req.params.planId, req.params.topicId, req.body || {});
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/plans/:planId/topics/:topicId/review-session/submit', async (req, res) => {
  try {
    validateTopicId(req.params.topicId);
    const result = await store.submitTopicReviewSession(req.params.planId, req.params.topicId, req.body || {});
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/plans/:planId/topics/:topicId/review/defer', async (req, res) => {
  try {
    validateTopicId(req.params.topicId);
    const until = parseTimestamp(req.body?.until, 'until', { required: true });
    const now = parseTimestamp(req.body?.now, 'now');
    const state = await store.deferTopicReview(
      req.params.planId,
      req.params.topicId,
      until,
      now === undefined ? {} : { now },
    );
    res.json({ state });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/plans/:planId/topics/:topicId/mistakes/:conceptKey/repair-session', async (req, res) => {
  try {
    validateTopicId(req.params.topicId);
    const result = await store.createOrResumeMistakeRepairSession(
      req.params.planId,
      req.params.topicId,
      req.params.conceptKey,
      req.body || {},
    );
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/plans/:planId/topics/:topicId/mistakes/:conceptKey/dismiss', async (req, res) => {
  try {
    validateTopicId(req.params.topicId);
    const dismissedAt = parseTimestamp(req.body?.dismissedAt, 'dismissedAt');
    const state = await store.dismissTopicMistake(
      req.params.planId,
      req.params.topicId,
      req.params.conceptKey,
      {
        reason: req.body?.reason,
        ...(dismissedAt === undefined ? {} : { dismissedAt }),
      },
    );
    res.json({ state });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/mastery/backup', async (req, res) => {
  try {
    const now = parseTimestamp(req.query.now, 'now');
    const backup = await store.createMasteryBackup(now === undefined ? {} : { now });
    res.json({ backup });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/mastery/restore/preview', async (req, res) => {
  try {
    const preview = await store.previewMasteryRestore(req.body?.backup);
    res.json({ preview });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/mastery/restore', async (req, res) => {
  try {
    if (req.body?.confirm !== true) throw new TypeError('confirm must be true to restore a backup');
    const result = await store.restoreMasteryBackup(req.body?.backup);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
