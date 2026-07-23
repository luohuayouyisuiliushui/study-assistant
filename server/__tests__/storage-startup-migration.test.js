import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initializeStorageDirectory } from '../engine/store/storage.js';

const testRoot = process.env.STUDY_ASSISTANT_TEST_ROOT || os.tmpdir();
const tempDirs = [];

function createFixture(plan) {
  fs.mkdirSync(testRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(testRoot, 'storage-startup-owned-'));
  const plansDir = path.join(dataDir, 'plans');
  fs.mkdirSync(plansDir);
  fs.writeFileSync(path.join(plansDir, `${plan.id}.json`), JSON.stringify(plan, null, 2), 'utf8');
  tempDirs.push(dataDir);
  return dataDir;
}

afterEach(() => {
  for (const dataDir of tempDirs.splice(0)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('storage startup migration', () => {
  it('migrates an isolated data directory before callers read it', () => {
    const dataDir = createFixture({
      id: 'legacy',
      name: 'Legacy',
      dataVersion: 1,
      topics: [{ id: 'topic-1', title: 'Arrays', done: true }],
    });

    const result = initializeStorageDirectory(dataDir, { now: 1_700_000_000_000 });
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'plans', 'legacy.json'), 'utf8'));

    assert.equal(result.changed, true);
    assert.equal(stored.dataVersion, 2);
    assert.equal(stored.topics[0].reviewSchedule.dueAt, 1_700_000_000_000);
    assert.equal(fs.existsSync(result.backupDir), true);
  });

  it('fails closed for a future version without changing the file', () => {
    const future = { id: 'future', name: 'Future', dataVersion: 99, topics: [] };
    const dataDir = createFixture(future);
    const planPath = path.join(dataDir, 'plans', 'future.json');

    assert.throws(() => initializeStorageDirectory(dataDir), /newer than this application/);
    assert.deepEqual(JSON.parse(fs.readFileSync(planPath, 'utf8')), future);
    assert.equal(fs.existsSync(path.join(dataDir, '.migration-backups')), false);
  });
});
