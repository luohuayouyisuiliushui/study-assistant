/**
 * Recycle bin (trash) management for plans.
 *
 * Handles moving plans to trash, restoring them, and periodic cleanup.
 * Trash helpers (readTrashIndex, writeTrashIndex, findTrashFile) are
 * exported here so other modules (e.g. crud-plans) can reuse them
 * without duplicating the file-scanning logic.
 */

import fs from 'fs';
import path from 'path';
import {
  TRASH_DIR, TRASH_TTL_DAYS, TRASH_INDEX,
  writeAtomic, removePlanBackups, drainWriteQueue,
  readJSON, appendIndexEntry, removeIndexEntries, planPath,
  invalidatePlanCache,
} from './storage.js';
import { getPlan } from './crud-plans.js';
import { writeFlag } from './crud-flags.js';

const TRANSIENT_RENAME_ERRORS = new Set(['EBUSY', 'EPERM']);

async function movePlanFile(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_ERRORS.has(error.code) || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

// ─── Internal trash helpers ───

export function readTrashIndex() {
  return readJSON(TRASH_INDEX) || [];
}

export function writeTrashIndex(index) {
  writeAtomic(TRASH_INDEX, JSON.stringify(index, null, 2));
}

/**
 * Find a trash file for the given plan ID, trying possible name variants.
 */
export function findTrashFile(planId) {
  try {
    if (!fs.existsSync(TRASH_DIR)) return null;
    // First try exact match
    const exact = path.join(TRASH_DIR, `${planId}.json`);
    if (fs.existsSync(exact)) return exact;
    // Fallback: scan for planId + timestamp variants (e.g. abc_1742000000000.json)
    for (const f of fs.readdirSync(TRASH_DIR)) {
      if (f === 'index.json') continue;
      if (f.startsWith(planId + '_')) return path.join(TRASH_DIR, f);
    }
  } catch {}
  return null;
}

// ─── Public trash operations ───

/**
 * Move a plan to the recycle bin instead of permanent deletion.
 * The plan file is moved to the trash directory; the index entry is removed.
 * Plans with rich learning data (history, detail, exercises) are flagged so
 * the data file is preserved even after the 30-day auto-cleanup.
 */
export async function trashPlan(planId) {
  // Drain pending writes before moving to trash
  await drainWriteQueue(planId);
  const src = planPath(planId);
  if (!fs.existsSync(src)) {
    // Plan file may already be gone — just remove from index
    await removeIndexEntries(planId);
    return;
  }

  // Read the plan to assess data richness
  let plan = null;
  let hasData = false;
  try {
    plan = JSON.parse(fs.readFileSync(src, 'utf-8'));
    if (plan) {
      const hasDetail = plan.topics && plan.topics.some(t => t.detail);
      const hasHistory = plan.history && plan.history.length > 0;
      const hasExercises = plan.topics && plan.topics.some(t => t.exercises && t.exercises.length > 0);
      hasData = hasDetail || hasHistory || hasExercises;
    }
  } catch { /* best-effort read */ }

  // Move plan file to trash directory
  const dest = path.join(TRASH_DIR, `${planId}.json`);
  try {
    // If dest exists already, append timestamp to avoid collision
    const finalDest = fs.existsSync(dest)
      ? path.join(TRASH_DIR, `${planId}_${Date.now()}.json`)
      : dest;
    await movePlanFile(src, finalDest);
  } catch (err) {
    // 不降级删除 — rename 失败时保留原文件，抛出让用户知道删除未完成
    throw new Error(`移动到回收站失败: ${err.message}`);
  }

  // Remove .tmp files
  try {
    const dir = path.dirname(src);
    const prefix = path.basename(src);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix + '.tmp')) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}

  // Remove from active index
  await removeIndexEntries(planId);

  // Add to trash index
  const now = Date.now();
  const trashEntry = {
    id: planId,
    name: plan?.name || '未知计划',
    topicCount: plan?.topics?.length || 0,
    deletedAt: now,
    expiresAt: now + TRASH_TTL_DAYS * 24 * 60 * 60 * 1000,
    hasData,
  };
  const trashIndex = readTrashIndex();
  trashIndex.push(trashEntry);
  writeTrashIndex(trashIndex);

  invalidatePlanCache(planId);
}

/**
 * Read the trash index (sorted by deletion time, newest first).
 */
export function listTrash() {
  return readTrashIndex().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

/**
 * Restore a plan from the recycle bin back to active plans.
 */
export async function restorePlan(planId) {
  const trashIndex = readTrashIndex();
  const entry = trashIndex.find(e => e.id === planId);
  if (!entry) throw new Error(`回收站中未找到计划: ${planId}`);

  // Move file back
  const trashFile = findTrashFile(planId);
  if (trashFile) {
    try {
      fs.renameSync(trashFile, planPath(planId));
    } catch (err) {
      throw new Error(`恢复计划文件失败: ${err.message}`);
    }
  }

  // Re-add to active index — read plan to get current topicCount
  const plan = getPlan(planId);
  if (plan) {
    await appendIndexEntry({
      id: plan.id,
      name: plan.name,
      createdAt: plan.createdAt,
      updatedAt: Date.now(),
      topicCount: plan.topics?.length || 0,
    });

    // Restore notification flag
    writeFlag(planId);
  }

  // Remove from trash index
  const updated = trashIndex.filter(e => e.id !== planId);
  writeTrashIndex(updated);

  invalidatePlanCache(planId);
}

/**
 * Permanently delete a plan from the recycle bin.
 */
export function permanentlyDeleteTrash(planId) {
  // Delete the file from trash
  const trashFile = findTrashFile(planId);
  if (trashFile) {
    try { fs.unlinkSync(trashFile); } catch {}
  }
  // Delete all backup files (.bak + .backups-v2/)
  removePlanBackups(planId);
  // Remove from trash index
  const trashIndex = readTrashIndex().filter(e => e.id !== planId);
  writeTrashIndex(trashIndex);
}

/**
 * Empty the entire recycle bin — permanently delete all trash entries.
 */
export function emptyTrash() {
  const trashIndex = readTrashIndex();
  for (const entry of trashIndex) {
    const trashFile = findTrashFile(entry.id);
    if (trashFile) {
      try { fs.unlinkSync(trashFile); } catch {}
    }
    // Delete all backup files (.bak + .backups-v2/)
    removePlanBackups(entry.id);
  }
  writeTrashIndex([]);
  console.log(`[learn-store] 🗑️ Emptied recycle bin (${trashIndex.length} items)`);
}

/**
 * Clean up expired trash entries (older than TRASH_TTL_DAYS).
 * Plans flagged with hasData keep their data file but lose the index entry.
 * Plans without data get their file permanently deleted.
 */
export function cleanExpiredTrash() {
  const now = Date.now();
  const trashIndex = readTrashIndex();
  const remaining = [];
  let cleaned = 0;
  for (const entry of trashIndex) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      cleaned++;
      // Delete file only if plan has no valuable data
      if (!entry.hasData) {
        const trashFile = findTrashFile(entry.id);
        if (trashFile) {
          try { fs.unlinkSync(trashFile); } catch {}
        }
        // Delete all backup files (.bak + .backups-v2/)
        removePlanBackups(entry.id);
      }
      // If hasData, keep the file but remove from index
    } else {
      remaining.push(entry);
    }
  }
  if (cleaned > 0) {
    writeTrashIndex(remaining);
    console.log(`[learn-store] 🗑️ Cleaned ${cleaned} expired trash entries`);
  }
}

// ─── Auto-cleanup: run every hour ───
const trashCleanupTimer = setInterval(() => cleanExpiredTrash(), 60 * 60 * 1000);
trashCleanupTimer.unref(); // Do not keep one-off CLI scripts alive after their work is done.
cleanExpiredTrash(); // also run once on startup
