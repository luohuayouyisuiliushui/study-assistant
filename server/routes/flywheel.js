/**
 * Shared flywheel helper — best-effort data flywheel update after learning events.
 *
 * Loads all non-test plans and passes them through dataFlywheelUpdate.
 * Catches and logs errors as non-fatal warnings so they never break the
 * primary request/response flow.
 */

import * as store from '../engine/learn-store.js';
import { dataFlywheelUpdate } from '../engine/adaptive-engine.js';

export function refreshDataFlywheel(contextLabel = 'flywheel') {
  setImmediate(() => {
    try {
      const allPlans = store.listPlans().map(p => store.getPlan(p.id)).filter(Boolean);
      dataFlywheelUpdate(allPlans);
    } catch (fwErr) {
      console.warn(`[${contextLabel}] update failed (non-fatal):`, fwErr.message);
    }
  });
}
