import { Router } from 'express';
import * as store from '../engine/learn-store.js';
import {
  STUDY_TRACE_THEORY_CONTRACT_VERSION,
  projectPlanForStudyTrace,
} from '../engine/topic-learning-state.js';
import { registerPlanIdParams } from './middleware.js';

const router = Router();
registerPlanIdParams(router, ['id']);

router.get('/plans', (req, res) => {
  const plans = store.listPlans()
    .map(entry => store.getPlan(entry.id))
    .filter(Boolean)
    .map(projectPlanForStudyTrace);
  res.json({ contractVersion: STUDY_TRACE_THEORY_CONTRACT_VERSION, plans });
});

router.get('/plans/:id', (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: '计划不存在' });
  res.json({
    contractVersion: STUDY_TRACE_THEORY_CONTRACT_VERSION,
    plan: projectPlanForStudyTrace(plan),
  });
});

export default router;
