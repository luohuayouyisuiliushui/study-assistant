import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CURRENT_PLAN_DATA_VERSION,
  CURRENT_PROFILE_DATA_VERSION,
  migrateDataDirectory,
  migratePlanData,
} from '../migrations/data-version.js';

const tempDirs = [];
const testRoot = process.env.STUDY_ASSISTANT_TEST_ROOT || os.tmpdir();

function createDataDirectory() {
  fs.mkdirSync(testRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(testRoot, 'study-assistant-migration-'));
  fs.mkdirSync(path.join(dataDir, 'plans'), { recursive: true });
  tempDirs.push(dataDir);
  return dataDir;
}

function writeJSON(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('data-version migrations', () => {
  it('adds the current version without mutating the caller data', () => {
    const legacyPlan = { id: 'plan-1', name: 'Legacy Plan', topics: [] };

    const migrated = migratePlanData(legacyPlan);

    assert.equal(migrated.changed, true);
    assert.equal(migrated.data.dataVersion, CURRENT_PLAN_DATA_VERSION);
    assert.equal(legacyPlan.dataVersion, undefined);
  });

  it('migrates every plan and the user profile after backing up the original files', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'plan-1.json');
    const profilePath = path.join(dataDir, 'user-profile.json');
    const legacyPlan = { id: 'plan-1', name: 'Legacy Plan', topics: [], phases: [], history: [] };
    const legacyProfile = { learnerPersona: { type: [] } };
    writeJSON(planPath, legacyPlan);
    writeJSON(profilePath, legacyProfile);

    const result = migrateDataDirectory({ dataDir, now: 1_700_000_000_000 });

    assert.equal(result.changed, true);
    assert.equal(result.plansMigrated, 1);
    assert.equal(result.profileMigrated, true);
    assert.equal(readJSON(planPath).dataVersion, CURRENT_PLAN_DATA_VERSION);
    assert.equal(readJSON(profilePath).dataVersion, CURRENT_PROFILE_DATA_VERSION);

    const backupPlan = path.join(result.backupDir, 'plans', 'plan-1.json');
    const backupProfile = path.join(result.backupDir, 'user-profile.json');
    assert.deepEqual(readJSON(backupPlan), legacyPlan);
    assert.deepEqual(readJSON(backupProfile), legacyProfile);
  });

  it('rejects a newer data version before writing any files', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'plan-1.json');
    const futurePlan = { id: 'plan-1', name: 'Future Plan', topics: [], dataVersion: CURRENT_PLAN_DATA_VERSION + 1 };
    writeJSON(planPath, futurePlan);

    assert.throws(
      () => migrateDataDirectory({ dataDir }),
      /newer than this application/
    );
    assert.deepEqual(readJSON(planPath), futurePlan);
  });

  it('restores already-written files when a later migration write fails', () => {
    const dataDir = createDataDirectory();
    const planPath = path.join(dataDir, 'plans', 'plan-1.json');
    const profilePath = path.join(dataDir, 'user-profile.json');
    const legacyPlan = { id: 'plan-1', name: 'Legacy Plan', topics: [] };
    const legacyProfile = { learnerPersona: { type: [] } };
    writeJSON(planPath, legacyPlan);
    writeJSON(profilePath, legacyProfile);

    const writeFile = (filePath, content) => {
      if (filePath === profilePath) throw new Error('simulated write failure');
      fs.writeFileSync(filePath, content, 'utf-8');
    };

    assert.throws(
      () => migrateDataDirectory({ dataDir, writeFile }),
      /rolled back/
    );
    assert.deepEqual(readJSON(planPath), legacyPlan);
    assert.deepEqual(readJSON(profilePath), legacyProfile);
  });

  it('preserves non-migration fields while adding empty v2 learning state', () => {
    const legacyPlan = {
      id: 'plan-1',
      name: 'Legacy Plan',
      topics: [{
        id: 'topic-1',
        title: 'Pointers',
        done: true,
        weakPoints: ['ownership'],
        arbitrary: { value: 42 },
      }],
    };

    const migrated = migratePlanData(legacyPlan, { now: 123_456 });
    const topic = migrated.data.topics[0];

    assert.deepEqual(topic.arbitrary, { value: 42 });
    assert.deepEqual(topic.masteryEvidence, []);
    assert.deepEqual(topic.mistakes, []);
    assert.equal(topic.reviewSchedule.dueAt, 123_456);
  });
});
