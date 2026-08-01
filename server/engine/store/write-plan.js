/**
 * Plan mutation seam: one module owns write consistency for plan files.
 *
 * Every mutation path (domain CRUD, create, bulk restore) goes through these
 * primitives so the caller never composes atomic-write, index, cache and
 * backup policies itself.  Domain modules keep their operation names and
 * describe only the domain change inside the mutator.
 */

import { writeFlag } from './crud-flags.js';
import {
  appendIndexEntry,
  enqueueWrite,
  getCachedPlan,
  invalidatePlanCache,
  planPath,
  readJSON,
  updateIndex,
  withPlanWriteLocks,
  writeAtomic,
} from './storage.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

/**
 * Serialized write: execute fn(plan), then atomically save.
 * fn receives a deep clone of the current plan and should mutate it.
 * Returns the saved plan.
 */
export function writePlan(planId, fn, { updateIndexFn = updateIndex, allowMissing = false } = {}) {
  return enqueueWrite(planId, async () => {
    const current = getCachedPlan(planId, () => readJSON(planPath(planId)));
    if (!current) {
      if (!allowMissing) throw new Error(`Plan not found: ${planId}`);
    }
    const plan = clone(current) || {};
    fn(plan);
    plan.updatedAt = Date.now();
    writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
    invalidatePlanCache(planId);
    // Index update is best-effort: the plan file is already durably written,
    // so a failing index update must not invalidate the write. The index will
    // be reconciled on the next rebuildIndex() pass.
    try {
      await updateIndexFn(planId, {
        topicCount: plan.topics.length,
        updatedAt: plan.updatedAt,
      });
    } catch (indexErr) {
      console.warn(`[writePlan] index update failed for ${planId} (non-fatal, will be reconciled on rebuild):`, indexErr.message);
    }
    // 通知标记：写入 .flag 文件（study-trace 通知模式）
    writeFlag(planId);
    return plan;
  }, { allowMissing });
}

/**
 * Create one plan through the same write seam.
 * The index entry is appended (not merged) with the full create metadata.
 */
export function createPlanRecord(id, initial, { indexEntry } = {}) {
  return writePlan(
    id,
    (plan) => { Object.assign(plan, initial); },
    {
      allowMissing: true,
      updateIndexFn: async (planId, meta) => {
        const entry = indexEntry
          ? indexEntry(meta)
          : {
              id: planId,
              name: initial.name,
              createdAt: initial.createdAt,
              updatedAt: meta.updatedAt,
              topicCount: (initial.topics || []).length,
            };
        await appendIndexEntry(entry);
      },
    },
  );
}

/**
 * Atomically replace several plan files, then invalidate their caches.
 * Used by bulk-restore flows; callers keep their own rollback policy.
 *
 * By default the per-plan write queues are acquired so the batch is isolated
 * from concurrent single-plan writes. Pass ``lock: false`` when the caller
 * already holds the same queues (e.g. inside an outer withPlanWriteLocks
 * callback) — re-acquiring them would deadlock on the caller's own slot.
 */
export async function writePlansAtomic(plans, { lock = true } = {}) {
  const entries = [...new Map(plans.map(plan => [plan.id, plan])).values()];
  const write = async () => {
    for (const plan of entries) {
      writeAtomic(planPath(plan.id), JSON.stringify(plan, null, 2), { backup: true });
      invalidatePlanCache(plan.id);
    }
    return entries;
  };
  if (!lock) return write();
  return withPlanWriteLocks(entries.map(plan => plan.id), write);
}

