/**
 * Plan mutation seam: one module owns write consistency for plan files.
 *
 * Every mutation path (domain CRUD, create, bulk restore) goes through these
 * primitives so the caller never composes atomic-write, index, cache and
 * backup policies itself.  Domain modules keep their operation names and
 * describe only the domain change inside the mutator.
 */

import fs from 'node:fs';

import { writeFlag } from './crud-flags.js';
import {
  appendIndexEntry,
  enqueueWrite,
  getCachedPlan,
  invalidatePlanCache,
  mutateIndex,
  planPath,
  readIndex,
  readJSON,
  removePlanBackups,
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
 * Re-register an existing plan file into the active index through the seam.
 * Used by trash-restore flows: the file is already back on disk, and the
 * domain change is "this plan is active again". Index uses append semantics
 * because a restored plan was removed from the index while trashed.
 */
export function restorePlanRecord(planId, { indexEntry } = {}) {
  return writePlan(planId, () => {}, {
    updateIndexFn: async (id, meta) => {
      const entry = indexEntry
        ? indexEntry(meta)
        : {
            id,
            name: '',
            createdAt: Date.now(),
            updatedAt: meta.updatedAt,
            topicCount: meta.topicCount,
          };
      await appendIndexEntry(entry);
    },
  });
}

function planIndexEntry(plan) {
  return {
    id: plan.id,
    name: plan.name,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    topicCount: Array.isArray(plan.topics) ? plan.topics.length : 0,
  };
}

function uniquePlanRecords(plans) {
  const records = [...new Map((plans || []).map(plan => [plan?.id, plan])).values()];
  if (records.some(plan => !plan?.id)) throw new Error('Plan replacement requires stable plan ids');
  return records;
}

async function writePlanRecords(records, { onWrite } = {}) {
  for (const plan of records) {
    writeAtomic(planPath(plan.id), JSON.stringify(plan, null, 2), { backup: true });
    invalidatePlanCache(plan.id);
    onWrite?.(plan);
  }
  return records;
}

/**
 * Replace a group of Plan records as one recoverable mutation.
 *
 * This is the bulk counterpart to writePlan(): it owns locks, durable writes,
 * index replacement, cache invalidation, backup cleanup, notification flags,
 * and rollback. Domain modules only validate and supply complete Plan records.
 */
export async function replacePlanRecords(plans) {
  const records = uniquePlanRecords(plans);
  const planIds = records.map(plan => plan.id);
  const replacedIds = new Set(planIds);

  return withPlanWriteLocks(planIds, async () => {
    const originals = new Map(planIds.map(id => [id, clone(readJSON(planPath(id)))]));
    const originalEntries = readIndex().filter(entry => replacedIds.has(entry.id));
    const applied = [];
    try {
      await writePlanRecords(records, { onWrite: plan => applied.push(plan.id) });
      await mutateIndex(index => [
        ...index.filter(entry => !replacedIds.has(entry.id)),
        ...records.map(planIndexEntry),
      ]);
      for (const plan of records) writeFlag(plan.id);
      return records;
    } catch (error) {
      const rollbackErrors = [];
      try {
        for (const planId of applied.slice().reverse()) {
          const original = originals.get(planId);
          if (original) {
            await writePlanRecords([original]);
          } else {
            if (fs.existsSync(planPath(planId))) fs.unlinkSync(planPath(planId));
            removePlanBackups(planId, { strict: true });
            invalidatePlanCache(planId);
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
      try {
        await mutateIndex(index => [
          ...index.filter(entry => !replacedIds.has(entry.id)),
          ...originalEntries,
        ]);
      } catch (rollbackError) {
        rollbackErrors.push(`index: ${rollbackError.message}`);
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `Plan replacement failed (${error.message}); rollback also failed: ${rollbackErrors.join('; ')}`,
        );
      }
      throw error;
    }
  });
}
