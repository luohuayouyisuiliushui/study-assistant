import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CURRENT_PLAN_DATA_VERSION,
  CURRENT_PROFILE_DATA_VERSION,
  migrateDataDirectory,
  migratePlanData,
  migrateProfileData,
} from '../migrations/data-version.js';

const testRoot = process.env.STUDY_ASSISTANT_TEST_ROOT || os.tmpdir();
const tempDirs = [];
const FIXED_NOW = 1_700_000_000_000;

function createDataDirectory() {
  fs.mkdirSync(testRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(testRoot, 'data-version-owned-'));
  fs.mkdirSync(path.join(dataDir, 'plans'));
  tempDirs.push(dataDir);
  return dataDir;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

afterEach(() => {
  for (const dataDir of tempDirs.splice(0)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('data-version module', () => {
  it('migrates records without mutating callers and leaves current records unchanged', () => {
    const plan = { id: 'plan-1', name: 'Legacy', topics: [] };
    const profile = { learnerPersona: { type: [] } };

    const migratedPlan = migratePlanData(plan);
    const migratedProfile = migrateProfileData(profile);
    const currentPlan = migratePlanData({ ...migratedPlan.data });

    assert.equal(migratedPlan.changed, true);
    assert.equal(migratedProfile.changed, true);
    assert.equal(migratedPlan.data.dataVersion, CURRENT_PLAN_DATA_VERSION);
    assert.equal(migratedProfile.data.dataVersion, CURRENT_PROFILE_DATA_VERSION);
    assert.equal(plan.dataVersion, undefined);
    assert.equal(profile.dataVersion, undefined);
    assert.equal(currentPlan.changed, false);
    assert.notStrictEqual(currentPlan.data, migratedPlan.data);
  });

  it('backs up each changed file and reports the migrated counts', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'plan-1.json');
    const profilePath = path.join(dataDir, 'user-profile.json');
    const plan = { id: 'plan-1', name: 'Legacy', topics: [] };
    const profile = { learnerPersona: { type: [] } };
    writeJson(planPath, plan);
    writeJson(profilePath, profile);

    const result = migrateDataDirectory({ dataDir, now: FIXED_NOW });

    assert.deepEqual(
      { changed: result.changed, plansMigrated: result.plansMigrated, profileMigrated: result.profileMigrated },
      { changed: true, plansMigrated: 1, profileMigrated: true }
    );
    assert.equal(readJson(planPath).dataVersion, CURRENT_PLAN_DATA_VERSION);
    assert.equal(readJson(profilePath).dataVersion, CURRENT_PROFILE_DATA_VERSION);
    assert.deepEqual(readJson(path.join(result.backupDir, 'plans', 'plan-1.json')), plan);
    assert.deepEqual(readJson(path.join(result.backupDir, 'user-profile.json')), profile);
  });

  it('preflights future versions before it creates backups or writes data', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'future.json');
    const futurePlan = {
      id: 'future',
      name: 'Future',
      topics: [],
      dataVersion: CURRENT_PLAN_DATA_VERSION + 1,
    };
    writeJson(planPath, futurePlan);

    assert.throws(() => migrateDataDirectory({ dataDir }), /newer than this application/);
    assert.deepEqual(readJson(planPath), futurePlan);
    assert.equal(fs.existsSync(path.join(dataDir, '.migration-backups')), false);
  });

  it('restores each written file when a later injected write fails', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'plan-1.json');
    const profilePath = path.join(dataDir, 'user-profile.json');
    const plan = { id: 'plan-1', name: 'Legacy', topics: [] };
    const profile = { learnerPersona: { type: [] } };
    writeJson(planPath, plan);
    writeJson(profilePath, profile);

    assert.throws(
      () => migrateDataDirectory({
        dataDir,
        writeFile(filePath, content) {
          if (filePath === profilePath) throw new Error('profile write failed');
          fs.writeFileSync(filePath, content, 'utf-8');
        },
      }),
      /rolled back/
    );
    assert.deepEqual(readJson(planPath), plan);
    assert.deepEqual(readJson(profilePath), profile);
  });

  it('leaves destination unchanged and cleans up temp artifacts after a replacement failure', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'plan-1.json');
    const profilePath = path.join(dataDir, 'user-profile.json');
    const plan = { id: 'plan-1', name: 'Legacy', topics: [] };
    const profile = { learnerPersona: { type: [] } };
    writeJson(planPath, plan);
    writeJson(profilePath, profile);

    const originalPlanBytes = fs.readFileSync(planPath);
    const originalProfileBytes = fs.readFileSync(profilePath);

    // Inject a writeFile that completes the atomic write for the plan but
    // simulates a post-temp-write failure for the profile — the temp file is
    // written but never renamed, mimicking a crash between write and rename.
    let injectedTempPath = null;
    const writeFile = (filePath, content) => {
      if (filePath === profilePath) {
        const tmp = filePath + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, content, 'utf-8');
        injectedTempPath = tmp;
        throw new Error('simulated rename failure');
      }
      // Use atomic pattern for the plan
      const tmp = filePath + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, filePath);
    };

    assert.throws(
      () => migrateDataDirectory({ dataDir, writeFile }),
      /rolled back/
    );

    // Original files are byte-for-byte unchanged
    assert.deepEqual(fs.readFileSync(planPath), originalPlanBytes);
    assert.deepEqual(fs.readFileSync(profilePath), originalProfileBytes);

    // The temp file left by the injected failure is the only allowed artifact
    // (the rollback's own atomic writes do not leave temp files behind).
    const allFiles = [];
    function collect(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else allFiles.push(full);
      }
    }
    collect(dataDir);

    // Ignore .migration-backups and the injected failure's temp file
    const unregisteredTmp = allFiles.filter(
      f => f.includes('.tmp.') && f !== injectedTempPath
    );
    assert.equal(unregisteredTmp.length, 0,
      `Unexpected temp artifacts remain: ${unregisteredTmp.join(', ')}`);

    // Clean up the injected artifact so afterEach teardown works
    if (injectedTempPath && fs.existsSync(injectedTempPath)) {
      fs.unlinkSync(injectedTempPath);
    }
  });

  it('migrates learned and unlearned Topics to v2 at the supplied time', () => {
    const plan = {
      id: 'plan-v1',
      name: 'Version one',
      dataVersion: 1,
      customPlanField: { retained: true },
      topics: [
        {
          id: 'learned',
          title: 'Learned',
          done: true,
          weakPoints: ['closures'],
          sm2History: [{ grade: 5 }],
          customTopicField: 'keep-me',
        },
        { id: 'new', title: 'New', done: false },
      ],
    };

    const migrated = migratePlanData(plan, { now: FIXED_NOW });
    const [learned, unlearned] = migrated.data.topics;

    assert.equal(migrated.fromVersion, 1);
    assert.equal(migrated.toVersion, 2);
    assert.equal(migrated.data.dataVersion, 2);
    assert.deepEqual(migrated.data.customPlanField, { retained: true });
    assert.equal(learned.customTopicField, 'keep-me');
    assert.deepEqual(learned.weakPoints, ['closures']);
    assert.deepEqual(learned.sm2History, [{ grade: 5 }]);
    assert.deepEqual(learned.masteryEvidence, []);
    assert.deepEqual(learned.mistakes, []);
    assert.equal(learned.reviewSession, null);
    assert.equal(learned.mastery.status, 'learning');
    assert.equal(learned.reviewSchedule.dueAt, FIXED_NOW);
    assert.equal(unlearned.mastery.status, 'unassessed');
    assert.equal(unlearned.reviewSchedule.dueAt, null);
    assert.deepEqual(plan.topics[0].masteryEvidence, undefined);
  });

  it('is idempotent and never fabricates evidence or mistakes from legacy fields', () => {
    const legacy = {
      id: 'legacy',
      name: 'Legacy',
      topics: [{
        id: 'topic-1',
        title: 'Closures',
        done: true,
        weakPoints: ['scope'],
        exercises: [{ correct: false }],
        sm2History: [{ grade: 0 }],
      }],
    };

    const first = migratePlanData(legacy, { now: FIXED_NOW });
    const second = migratePlanData(first.data, { now: FIXED_NOW + 50_000 });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(second.data, first.data);
    assert.deepEqual(second.data.topics[0].masteryEvidence, []);
    assert.deepEqual(second.data.topics[0].mistakes, []);
    assert.equal(second.data.topics[0].reviewSchedule.dueAt, FIXED_NOW);
  });

  it('rejects an invalid migration clock before changing caller data', () => {
    const plan = { id: 'plan-1', name: 'Legacy', topics: [] };

    assert.throws(() => migratePlanData(plan, { now: -1 }), /now/);
    assert.equal(plan.dataVersion, undefined);
  });

  it('leaves unrecognized non-Plan JSON files in plans/ completely untouched', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'plan-1.json');
    const foreignPath = path.join(dataDir, 'plans', 'notes.json');
    const missingIdPath = path.join(dataDir, 'plans', 'missing-id.json');
    const arrayPath = path.join(dataDir, 'plans', 'array.json');
    const plan = { id: 'plan-1', name: 'Legacy', topics: [] };
    const foreign = { hello: 'world', unrelated: true };
    const missingId = { name: 'No id here', topics: [] };
    const arrayContent = [{ id: 'plan-1', name: 'Should not be read as a plan' }];
    writeJson(planPath, plan);
    writeJson(foreignPath, foreign);
    writeJson(missingIdPath, missingId);
    writeJson(arrayPath, arrayContent);

    const result = migrateDataDirectory({ dataDir, now: FIXED_NOW });

    assert.equal(result.plansMigrated, 1);
    assert.equal(readJson(planPath).dataVersion, CURRENT_PLAN_DATA_VERSION);
    assert.deepEqual(readJson(foreignPath), foreign);
    assert.deepEqual(readJson(missingIdPath), missingId);
    assert.deepEqual(readJson(arrayPath), arrayContent);
    assert.equal(fs.existsSync(path.join(result.backupDir, 'plans', 'notes.json')), false);
    assert.equal(fs.existsSync(path.join(result.backupDir, 'plans', 'missing-id.json')), false);
    assert.equal(fs.existsSync(path.join(result.backupDir, 'plans', 'array.json')), false);
  });

  it('rolls back the exact file a writeFile call is overwriting when it throws mid-write', () => {
    const dataDir = createDataDirectory();
    const planAPath = path.join(dataDir, 'plans', 'plan-a.json');
    const planBPath = path.join(dataDir, 'plans', 'plan-b.json');
    const planA = { id: 'plan-a', name: 'A', topics: [] };
    const planB = { id: 'plan-b', name: 'B', topics: [] };
    writeJson(planAPath, planA);
    writeJson(planBPath, planB);

    // Simulate a non-atomic writer that partially overwrites the destination
    // (mimicking a crash between write and rename) before throwing on the
    // *same* file it just started overwriting.
    const writeFile = (filePath, content) => {
      if (filePath === planBPath) {
        fs.writeFileSync(filePath, content.slice(0, 5), 'utf-8');
        throw new Error('simulated crash mid non-atomic write');
      }
      fs.writeFileSync(filePath, content, 'utf-8');
    };

    assert.throws(
      () => migrateDataDirectory({ dataDir, now: FIXED_NOW, writeFile }),
      /rolled back/
    );

    assert.deepEqual(readJson(planAPath), planA);
    assert.deepEqual(readJson(planBPath), planB);
  });
});
