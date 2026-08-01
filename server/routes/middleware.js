/**
 * Shared middleware helpers for all route modules.
 */

import { createAIInvocationFromRequest } from '../engine/ai-runtime.js';
import { isValidPlanId } from '../engine/learn-store.js';

function getAIInvocation(req) {
  return createAIInvocationFromRequest(req);
}

function registerPlanIdParams(router, parameters = ['planId']) {
  for (const parameter of parameters) {
    router.param(parameter, (req, res, next, value) => {
      if (!isValidPlanId(value)) {
        return res.status(400).json({ error: '无效的计划 ID' });
      }
      next();
    });
  }
  return router;
}

export { getAIInvocation, registerPlanIdParams };
