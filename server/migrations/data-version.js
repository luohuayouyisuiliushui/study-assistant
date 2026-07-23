import fs from 'node:fs';
import path from 'node:path';
import {
  createInitialMastery,
  createInitialReviewSchedule,
} from '../engine/mastery-scheduler.js';

export const CURRENT_PLAN_DATA_VERSION = 2;
export const CURRENT_PROFILE_DATA_VERSION = 1;

function cloneRecord(data, label) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError(`${label} data must be an object`);
  }
  return structuredClone(data);
}

function readVersion(data, label) {
  if (data.dataVersion == null) return 0;
  if (!Number.isInteger(data.dataVersion) || data.dataVersion < 0) {
    throw new TypeError(`${label} dataVersion must be a non-negative integer`);
  }
  return data.dataVersion;
}

function migrateRecord(data, currentVersion, label) {
  const copy = cloneRecord(data, label);
  const fromVersion = readVersion(copy, label);

  if (fromVersion > currentVersion) {
    throw new Error(`${label} data version ${fromVersion} is newer than this application (supports ${currentVersion})`);
  }

  if (fromVersion === currentVersion) {
    return { changed: false, data: copy, fromVersion, toVersion: currentVersion };
  }

  copy.dataVersion = currentVersion;
  return { changed: true, data: copy, fromVersion, toVersion: currentVersion };
}

function requireMigrationTime(now) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative epoch millisecond integer');
  }
  return now;
}

function migratePlanV0ToV1(plan) {
  plan.dataVersion = 1;
}

function migratePlanV1ToV2(plan, now) {
  if (plan.topics == null) plan.topics = [];
  if (!Array.isArray(plan.topics)) {
    throw new TypeError('Plan topics must be an array');
  }

  for (const topic of plan.topics) {
    if (!topic || typeof topic !== 'object' || Array.isArray(topic)) {
      throw new TypeError('Plan topics entries must be objects');
    }
    if (!Object.hasOwn(topic, 'masteryEvidence')) topic.masteryEvidence = [];
    if (!Object.hasOwn(topic, 'mastery')) {
      topic.mastery = createInitialMastery({ done: topic.done === true });
    }
    if (!Object.hasOwn(topic, 'reviewSchedule')) {
      topic.reviewSchedule = createInitialReviewSchedule({
        dueAt: topic.done === true ? now : null,
      });
    }
    if (!Object.hasOwn(topic, 'reviewSession')) topic.reviewSession = null;
    if (!Object.hasOwn(topic, 'mistakes')) topic.mistakes = [];

    if (!Array.isArray(topic.masteryEvidence)) {
      throw new TypeError('Topic masteryEvidence must be an array');
    }
    if (!topic.mastery || typeof topic.mastery !== 'object' || Array.isArray(topic.mastery)) {
      throw new TypeError('Topic mastery must be an object');
    }
    if (!topic.reviewSchedule || typeof topic.reviewSchedule !== 'object' || Array.isArray(topic.reviewSchedule)) {
      throw new TypeError('Topic reviewSchedule must be an object');
    }
    if (topic.reviewSession !== null && (typeof topic.reviewSession !== 'object' || Array.isArray(topic.reviewSession))) {
      throw new TypeError('Topic reviewSession must be null or an object');
    }
    if (!Array.isArray(topic.mistakes)) {
      throw new TypeError('Topic mistakes must be an array');
    }
  }
  plan.dataVersion = 2;
}

const PLAN_MIGRATIONS = new Map([
  [0, migratePlanV0ToV1],
  [1, migratePlanV1ToV2],
]);

export function migratePlanData(plan, { now = Date.now() } = {}) {
  requireMigrationTime(now);
  const copy = cloneRecord(plan, 'Plan');
  const fromVersion = readVersion(copy, 'Plan');

  if (fromVersion > CURRENT_PLAN_DATA_VERSION) {
    throw new Error(`Plan data version ${fromVersion} is newer than this application (supports ${CURRENT_PLAN_DATA_VERSION})`);
  }
  if (fromVersion === CURRENT_PLAN_DATA_VERSION) {
    return {
      changed: false,
      data: copy,
      fromVersion,
      toVersion: CURRENT_PLAN_DATA_VERSION,
    };
  }

  let version = fromVersion;
  while (version < CURRENT_PLAN_DATA_VERSION) {
    const migrate = PLAN_MIGRATIONS.get(version);
    if (!migrate) throw new Error(`Missing Plan migration from version ${version}`);
    migrate(copy, now);
    version += 1;
    if (copy.dataVersion !== version) {
      throw new Error(`Plan migration from version ${version - 1} did not produce version ${version}`);
    }
  }

  return {
    changed: true,
    data: copy,
    fromVersion,
    toVersion: CURRENT_PLAN_DATA_VERSION,
  };
}

export function migrateProfileData(profile) {
  return migrateRecord(profile, CURRENT_PROFILE_DATA_VERSION, 'Profile');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`Unable to read migration input ${filePath}: ${error.message}`);
  }
}

/**
 * A minimal, permissive shape check for "this JSON file is a Plan record".
 * Every Plan ever produced by this application carries a non-empty string
 * `id` and `name`. JSON files in `plans/` that lack this shape are treated
 * as foreign/unrecognized and are left completely untouched by migration
 * (not read into the pending set, not backed up, not counted). A file that
 * *does* match this shape but has an invalid `topics`/etc. is still
 * "recognized" and must fail closed via the normal migration validation.
 */
function isPlanLikeRecord(data) {
  return Boolean(data)
    && typeof data === 'object'
    && !Array.isArray(data)
    && typeof data.id === 'string' && data.id.length > 0
    && typeof data.name === 'string' && data.name.length > 0;
}

function getPlanEntries(dataDir, now) {
  const plansDir = path.join(dataDir, 'plans');
  if (!fs.existsSync(plansDir)) return [];

  const entries = [];
  const files = fs.readdirSync(plansDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of files) {
    const filePath = path.join(plansDir, entry.name);
    const original = readJson(filePath);
    if (!isPlanLikeRecord(original)) continue;
    entries.push({
      kind: 'plan',
      filePath,
      relativePath: path.join('plans', entry.name),
      original,
      migration: migratePlanData(original, { now }),
    });
  }
  return entries;
}

function getProfileEntry(dataDir) {
  const filePath = path.join(dataDir, 'user-profile.json');
  if (!fs.existsSync(filePath)) return null;

  const original = readJson(filePath);
  return {
    kind: 'profile',
    filePath,
    relativePath: 'user-profile.json',
    original,
    migration: migrateProfileData(original),
  };
}

function createBackupDirectory(dataDir, now) {
  const parent = path.join(dataDir, '.migration-backups');
  fs.mkdirSync(parent, { recursive: true });

  const baseName = `data-version-${Number(now)}`;
  let backupDir = path.join(parent, baseName);
  let suffix = 1;
  while (fs.existsSync(backupDir)) {
    backupDir = path.join(parent, `${baseName}-${suffix}`);
    suffix += 1;
  }
  fs.mkdirSync(backupDir);
  return backupDir;
}

function writeBackup(backupDir, entry) {
  const backupPath = path.join(backupDir, entry.relativePath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(entry.filePath, backupPath);
}

/**
 * Atomically replace a file: write to a .tmp.PID sibling, then rename.
 * If the rename fails, the temp file is cleaned up and the original
 * destination remains unchanged.
 */
function atomicReplace(filePath, content) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (renameErr) {
    try { fs.unlinkSync(tmp); } catch {}
    throw renameErr;
  }
}

function restoreWrittenEntries(entries) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    try {
      atomicReplace(entry.filePath, JSON.stringify(entry.original, null, 2));
    } catch (error) {
      failures.push(`${entry.filePath}: ${error.message}`);
    }
  }
  return failures;
}

/**
 * Migrate a standalone learn-data directory. All input is parsed and version
 * checked before backups or writes begin, so a newer schema cannot be mixed
 * with partially migrated files.
 */
export function migrateDataDirectory({ dataDir, now = Date.now(), writeFile = atomicReplace } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('dataDir must be a non-empty path');
  }
  if (typeof writeFile !== 'function') {
    throw new TypeError('writeFile must be a function');
  }
  requireMigrationTime(now);

  const resolvedDataDir = path.resolve(dataDir);
  const entries = getPlanEntries(resolvedDataDir, now);
  const profileEntry = getProfileEntry(resolvedDataDir);
  if (profileEntry) entries.push(profileEntry);

  const pending = entries.filter(entry => entry.migration.changed);
  const plansMigrated = pending.filter(entry => entry.kind === 'plan').length;
  const profileMigrated = pending.some(entry => entry.kind === 'profile');

  if (pending.length === 0) {
    return {
      changed: false,
      plansMigrated: 0,
      profileMigrated: false,
      backupDir: null,
    };
  }

  const backupDir = createBackupDirectory(resolvedDataDir, now);
  for (const entry of pending) writeBackup(backupDir, entry);

  const written = [];
  try {
    for (const entry of pending) {
      // Mark this entry as "attempted" before calling writeFile. A custom
      // writeFile may overwrite the destination and only then throw (for
      // example a crash mid non-atomic write); if we only recorded entries
      // *after* a successful call, that entry would never be rolled back.
      written.push(entry);
      writeFile(entry.filePath, JSON.stringify(entry.migration.data, null, 2), 'utf-8');
    }
  } catch (error) {
    const rollbackFailures = restoreWrittenEntries(written);
    const rollbackDetail = rollbackFailures.length > 0
      ? `; rollback failures: ${rollbackFailures.join('; ')}`
      : '';
    throw new Error(`Data migration failed and rolled back: ${error.message}${rollbackDetail}`);
  }

  return {
    changed: true,
    plansMigrated,
    profileMigrated,
    backupDir,
  };
}
