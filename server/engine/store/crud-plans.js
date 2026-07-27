/**
 * Plan CRUD operations.
 *
 * Manages the lifecycle of learning plans: create, read, list, delete.
 * Persistence primitives (writeAtomic, readJSON, index management) come from storage.js.
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  DATA, PLANS_INDEX,
  writeAtomic, removePlanBackups, drainWriteQueue,
  readJSON, readIndex, appendIndexEntry, removeIndexEntries, planPath,
  getCachedPlan, invalidatePlanCache,
} from './storage.js';
import { markPlanForTestCleanup } from './test-plan-marker.js';
import {
  trashPlan, readTrashIndex, writeTrashIndex, findTrashFile,
} from './crud-trash.js';

export function listPlans() {
  return readIndex().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Scan every persisted plan file, including files missing from plans.json.
 * Cleanup and integrity tooling use this instead of reaching into data paths.
 */
export function scanStoredPlans() {
  const plans = [];
  const errors = [];
  const plansDir = path.join(DATA, 'plans');

  let files;
  try {
    files = fs.readdirSync(plansDir).filter(file => file.endsWith('.json'));
  } catch (error) {
    return { plans, errors: [{ id: null, message: error.message }] };
  }

  for (const file of files) {
    const fileId = path.basename(file, '.json');
    const plan = readJSON(path.join(plansDir, file));
    if (!plan || typeof plan !== 'object') {
      errors.push({ id: fileId, message: 'Plan file could not be read' });
      continue;
    }
    if (plan.id !== fileId) {
      errors.push({ id: fileId, message: `Plan file contains mismatched id: ${plan.id ?? 'missing'}` });
      continue;
    }
    plans.push(plan);
  }

  return { plans, errors };
}

/**
 * Remove index entries only when their corresponding plan file is absent.
 * Existing (including unreadable) files are never deleted by this operation.
 */
export async function pruneMissingPlanIndexEntries(planIds) {
  const requestedIds = new Set(
    (Array.isArray(planIds) ? planIds : []).filter(id => typeof id === 'string' && id.length > 0)
  );
  const missingIds = new Set([...requestedIds].filter(id => !fs.existsSync(planPath(id))));
  const index = readIndex();
  const removed = index.filter(entry => missingIds.has(entry.id));

  if (removed.length > 0) {
    await removeIndexEntries([...missingIds]);
    for (const entry of removed) invalidatePlanCache(entry.id);
  }

  return {
    removed,
    retained: [...requestedIds].filter(id => !removed.some(entry => entry.id === id)),
  };
}

export function getPlan(planId) {
  return getCachedPlan(planId, () => readJSON(planPath(planId)));
}

export async function createPlan(name, options = {}) {
  const id = uuidv4();
  const plan = {
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    topics: [],
    phases: [],
    history: [],
  };
  markPlanForTestCleanup(plan, options);
  writeAtomic(planPath(id), JSON.stringify(plan, null, 2));
  await appendIndexEntry({ id, name, createdAt: plan.createdAt, updatedAt: plan.updatedAt, topicCount: 0 });
  return plan;
}

// ─── Trash / Recycle Bin ───

export async function deletePlan(planId) {
  // Lazy import to avoid a circular module-dependency at load time.
  const { trashPlan } = await import('./crud-trash.js');
  await trashPlan(planId);
}

/**
 * Permanently delete a plan — removes the file, removes from index, skips trash.
 * Also cleans up any trash entry for the same plan ID.
 */
export async function permanentlyDeletePlan(planId) {
  // 先等待队列清空，再删除
  await drainWriteQueue(planId);
  invalidatePlanCache(planId);

  // Delete plan file from plans/
  const src = planPath(planId);
  try {
    if (fs.existsSync(src)) fs.unlinkSync(src);
  } catch (err) {
    console.warn(`[learn-store] Failed to delete plan file: ${err.message}`);
  }

  // Delete .tmp files
  try {
    const dir = path.dirname(src);
    const prefix = path.basename(src);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix + '.tmp')) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}

  // Delete all backup files (.bak + .backups-v2/)
  removePlanBackups(planId);

  // Remove from active index
  await removeIndexEntries(planId);

  // Also remove from trash if present
  const trashFile = findTrashFile(planId);
  if (trashFile) {
    try { fs.unlinkSync(trashFile); } catch {}
  }
  const trashIndex = readTrashIndex().filter(e => e.id !== planId);
  writeTrashIndex(trashIndex);
}

/**
 * Batch-delete multiple plans permanently by their IDs.
 */
export async function deletePlansByIds(planIds) {
  for (const id of planIds) {
    await permanentlyDeletePlan(id);
  }
}
