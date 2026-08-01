/**
 * Shared storage layer: atomic writes, JSON read/write, index management.
 *
 * All file persistence for the learning assistant goes through this module.
 * crud.js imports these primitives to build the CRUD operations.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// storage.js lives in store/ subdirectory, need two levels up to reach server/
const configuredDataDir = process.env.STUDY_ASSISTANT_DATA_DIR?.trim();
const DATA = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(__dirname, '..', '..', 'data', 'learn');
const PLANS_INDEX = path.join(DATA, 'plans.json');
const TRASH_DIR = path.join(DATA, 'trash');
const TRASH_INDEX = path.join(TRASH_DIR, 'index.json');
const TRASH_TTL_DAYS = 30;
const BACKUP_DIR = path.join(DATA, '.backups-v2');

function ensureDir() {
  fs.mkdirSync(path.join(DATA, 'plans'), { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
ensureDir();

// ── Startup cleanup: remove orphaned .tmp.* files from crashed processes ──
function cleanupOrphanedTempFiles() {
  const dirsToScan = [
    path.join(DATA, 'plans'),
    DATA, // also scan the learn/ root for user-profile.json.tmp.* etc.
  ];
  const now = Date.now();
  const MIN_AGE_MS = 10_000;

  for (const dir of dirsToScan) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!entry.includes('.tmp.')) continue;
        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs >= MIN_AGE_MS) {
            fs.unlinkSync(fullPath);
            console.log(`[learn-store] 🧹 Cleaned orphaned temp file: ${fullPath}`);
          }
        } catch (cleanErr) {
          if (cleanErr.code !== 'ENOENT') {
            console.warn(`[learn-store] Could not clean temp file ${fullPath}: ${cleanErr.message}`);
          }
        }
      }
    } catch (scanErr) {
      if (scanErr.code !== 'ENOENT') {
        console.warn(`[learn-store] Temp cleanup scan failed for ${dir}: ${scanErr.message}`);
      }
    }
  }
}
cleanupOrphanedTempFiles();

// ─── Atomic write (EPERM-safe) ───

function writeAtomic(filePath, data, { backup } = {}) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (renameErr) {
    // Windows EPERM / cross-device link → fallback to copy + delete
    try {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
    } catch (copyErr) {
      console.error(`Atomic write fallback failed for ${filePath}:`, copyErr);
      throw new Error(`CRITICAL: Data write failed, temp file preserved at ${tmp}`);
    }
  }
  if (backup) {
    // 1. Same-dir .bak (fast recovery)
    const bakPath = filePath + '.bak';
    try {
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
      fs.copyFileSync(filePath, bakPath);
    } catch (bakErr) {
      console.warn(`[learn-store] .bak backup failed: ${bakPath}`, bakErr.message);
    }
    // 2. Separate backup dir .backups-v2/ (prevents accidental mass-deletion)
    try {
      const planId = path.basename(filePath, '.json');
      if (planId && planId.length > 0) {
        const backupFile = path.join(BACKUP_DIR, planId + '.json');
        if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
        fs.copyFileSync(filePath, backupFile);
      }
    } catch (v2Err) {
      console.warn(`[learn-store] .backups-v2 backup failed: ${filePath}`, v2Err.message);
    }
  }
}

// ─── Backup cleanup helper ───

function removePlanBackups(planId, { strict = false } = {}) {
  const errors = [];
  try {
    const bakPath = planPath(planId) + '.bak';
    if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
  } catch (error) {
    errors.push(error);
  }
  try {
    const v2Backup = path.join(BACKUP_DIR, planId + '.json');
    if (fs.existsSync(v2Backup)) fs.unlinkSync(v2Backup);
  } catch (error) {
    errors.push(error);
  }
  if (strict && errors.length > 0) {
    throw new Error(`Failed to remove Plan backups: ${errors.map(error => error.message).join('; ')}`);
  }
}

// ─── Per-plan write queue (serializes concurrent writes to same plan) ───

const writeQueues = new Map();

function enqueueWrite(planId, fn, { allowMissing = false } = {}) {
  if (!allowMissing && !fs.existsSync(planPath(planId))) {
    return Promise.reject(new Error(`Plan not found: ${planId}`));
  }
  if (!writeQueues.has(planId)) {
    writeQueues.set(planId, Promise.resolve());
  }
  const prev = writeQueues.get(planId);
  const next = prev.then(fn, fn);
  writeQueues.set(planId, next);
  // When this write settles, drop the Map entry if no newer write has been
  // queued against the same planId. This prevents idle entries from
  // accumulating over the server's lifetime (the previous implementation
  // only reset the entry to Promise.resolve() and never deleted it, so the
  // Map grew unboundedly for long-running processes). A subsequent
  // enqueueWrite will simply recreate the entry via the has() check above.
  next.then(
    () => { if (writeQueues.get(planId) === next) writeQueues.delete(planId); },
    () => { if (writeQueues.get(planId) === next) writeQueues.delete(planId); },
  );
  return next;
}

async function withPlanWriteLocks(planIds, fn) {
  const ids = [...new Set(planIds)].sort();
  let releaseLocks;
  const releasePromise = new Promise(resolve => { releaseLocks = resolve; });
  const ready = ids.map(() => {
    let resolveReady;
    const promise = new Promise(resolve => { resolveReady = resolve; });
    return { promise, resolve: resolveReady };
  });
  const locks = ids.map((planId, index) => enqueueWrite(planId, async () => {
    ready[index].resolve();
    await releasePromise;
  }, { allowMissing: true }));

  await Promise.all(ready.map(item => item.promise));
  try {
    return await fn();
  } finally {
    releaseLocks();
    await Promise.allSettled(locks);
  }
}

// ─── Index write mutex (prevents TOCTOU race on plans.json) ───

let _indexMutex = Promise.resolve();

function _locked(fn) {
  const prev = _indexMutex;
  let release;
  _indexMutex = new Promise(resolve => { release = resolve; });
  return prev.then(() => fn()).finally(() => release());
}

// ─── JSON safe read (with encoding resilience + backup recovery) ───

function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    let raw = fs.readFileSync(filePath, 'utf-8');
    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      console.warn(`[learn-store] UTF-8 parse failed for ${filePath}, trying GBK: ${parseErr.message}`);
      try {
        const rawBuf = fs.readFileSync(filePath);
        return JSON.parse(new TextDecoder('gbk').decode(rawBuf));
      } catch (gbkErr) {
        console.warn(`[learn-store] GBK fallback also failed for ${filePath}: ${gbkErr.message}`);
        throw parseErr;
      }
    }
  } catch (err) {
    console.warn(`[learn-store] JSON parse error: ${filePath}`, err.message);
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
        console.warn(`[learn-store] Recovered from .bak: ${bakPath}`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return data;
      } catch (bakErr) {
        console.warn(`[learn-store] .bak also corrupt: ${bakPath}`, bakErr.message);
      }
    }
    try {
      const planId = path.basename(filePath, '.json');
      const v2File = path.join(BACKUP_DIR, planId + '.json');
      if (fs.existsSync(v2File)) {
        const data = JSON.parse(fs.readFileSync(v2File, 'utf-8'));
        console.warn(`[learn-store] Recovered from .backups-v2: ${v2File}`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return data;
      }
    } catch (v2Err) {
      console.warn(`[learn-store] .backups-v2 recovery failed: ${filePath}`, v2Err.message);
    }
    return null;
  }
}

// ─── Index ───

function rebuildIndex() {
  try {
    const plansDir = path.join(DATA, 'plans');
    if (!fs.existsSync(plansDir)) return [];
    const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.json') && !f.endsWith('.bak') && !f.includes('.tmp.'));
    if (files.length === 0) return [];
    const index = [];
    for (const f of files) {
      try {
        const plan = readJSON(path.join(plansDir, f));
        if (plan && plan.id && plan.name) {
          index.push({
            id: plan.id,
            name: plan.name,
            createdAt: plan.createdAt || Date.now(),
            updatedAt: plan.updatedAt || Date.now(),
            topicCount: plan.topics?.length || 0,
          });
        }
      } catch {}
    }
    if (index.length > 0) {
      _locked(() => {
        writeAtomic(PLANS_INDEX, JSON.stringify(index, null, 2), { backup: true });
        console.log(`[learn-store] 🔄 Rebuilt index from ${files.length} plan files → ${index.length} entries`);
      });
    }
    return index;
  } catch (err) {
    console.warn('[learn-store] Index rebuild failed:', err.message);
    return [];
  }
}

function readIndex() {
  const idx = readJSON(PLANS_INDEX);
  if (idx && idx.length > 0) {
    const seen = new Set();
    return idx.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }
  return rebuildIndex();
}

function writeIndex(index) {
  return _locked(() => {
    writeAtomic(PLANS_INDEX, JSON.stringify(index, null, 2), { backup: true });
  });
}

function mutateIndex(mutator) {
  return _locked(() => {
    const seen = new Set();
    const current = readIndex().filter(entry => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    const next = mutator(current);
    if (!Array.isArray(next)) throw new Error('Index mutator must return an array');
    writeAtomic(PLANS_INDEX, JSON.stringify(next, null, 2), { backup: true });
    return next;
  });
}

function appendIndexEntry(entry) {
  return mutateIndex(index => [
    ...index.filter(item => item.id !== entry.id),
    entry,
  ]);
}

function removeIndexEntries(planIds) {
  const ids = new Set(
    (Array.isArray(planIds) ? planIds : [planIds])
      .filter(id => typeof id === 'string' && id.length > 0)
  );
  return mutateIndex(index => index.filter(entry => !ids.has(entry.id)));
}

function updateIndex(planId, updates) {
  return mutateIndex(index => {
    const entry = index.find(e => e.id === planId);
    if (entry) Object.assign(entry, updates);
    return index;
  });
}

// ─── Paths ───

const PLAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isValidPlanId(id) {
  return typeof id === 'string' && PLAN_ID_RE.test(id);
}

function planPath(id) {
  return path.join(DATA, 'plans', `${id}.json`);
}

// ─── Write queue drain (for plan deletion) ───

async function drainWriteQueue(planId) {
  const queue = writeQueues.get(planId);
  if (queue) {
    try { await queue; } catch { /* ignore — deleting anyway */ }
  }
  writeQueues.delete(planId);
}

// ─── In-memory plan cache (TTL 5s, reduces disk reads for hot data) ───

const _planCache = new Map();

function getCachedPlan(planId, loader) {
  const entry = _planCache.get(planId);
  const now = Date.now();
  if (entry && (now - entry.ts) < 5000) return entry.data;
  const data = loader();
  if (data !== null) {
    _planCache.set(planId, { data, ts: now });
  }
  return data;
}

function invalidatePlanCache(planId) {
  _planCache.delete(planId);
}

export {
  DATA,
  PLANS_INDEX,
  TRASH_DIR,
  TRASH_INDEX,
  TRASH_TTL_DAYS,
  BACKUP_DIR,
  writeAtomic,
  removePlanBackups,
  enqueueWrite,
  withPlanWriteLocks,
  drainWriteQueue,
  readJSON,
  readIndex,
  rebuildIndex,
  writeIndex,
  mutateIndex,
  appendIndexEntry,
  removeIndexEntries,
  updateIndex,
  isValidPlanId,
  planPath,
  getCachedPlan,
  invalidatePlanCache,
  writeQueues,
};
