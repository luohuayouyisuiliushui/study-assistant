import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_PLAN_MARKER } from '../engine/store/test-plan-marker.js';
import { cleanTestTrash } from '../scripts/clean-test-trash.js';

const tempDirs = [];

function createTrashDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-assistant-test-trash-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.json'), '[]', 'utf8');
  return dir;
}

function writePlan(dir, plan) {
  fs.writeFileSync(path.join(dir, `${plan.id}.json`), JSON.stringify(plan), 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cleanTestTrash', () => {
  it('removes explicitly marked test plans from the recycle bin and updates its index', () => {
    const trashDir = createTrashDir();
    const testPlan = {
      id: 'marked-test',
      name: 'Test plan with generated data',
      topics: [{ detail: 'lesson' }],
      history: [{ role: 'user', content: 'test answer' }],
      __testPlan: { marker: TEST_PLAN_MARKER },
    };
    const userPlan = { id: 'user-plan', name: 'Real course', topics: [], history: [] };
    writePlan(trashDir, testPlan);
    writePlan(trashDir, userPlan);
    fs.writeFileSync(path.join(trashDir, 'index.json'), JSON.stringify([
      { id: testPlan.id },
      { id: userPlan.id },
    ]), 'utf8');

    const result = cleanTestTrash({ trashDir });

    assert.equal(result.count, 1);
    assert.deepEqual(result.deleted.map(item => item.id), ['marked-test']);
    assert.equal(fs.existsSync(path.join(trashDir, 'marked-test.json')), false);
    assert.equal(fs.existsSync(path.join(trashDir, 'user-plan.json')), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(trashDir, 'index.json'), 'utf8')), [{ id: 'user-plan' }]);
  });

  it('only deletes legacy-named trash after confirmation', () => {
    const trashDir = createTrashDir();
    const fixture = {
      id: 'manual-fixture',
      name: 'V-01 Fixture',
      topics: [{ done: true }],
      history: [{ role: 'user', content: 'browser smoke test' }],
    };
    writePlan(trashDir, fixture);

    const preview = cleanTestTrash({ trashDir, legacyNames: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.candidateCount, 1);
    assert.equal(fs.existsSync(path.join(trashDir, 'manual-fixture.json')), true);

    const result = cleanTestTrash({ trashDir, legacyNames: true, confirmLegacy: true });
    assert.equal(result.count, 1);
    assert.equal(fs.existsSync(path.join(trashDir, 'manual-fixture.json')), false);
  });

  it('reports legacy-name matches with learning data as protected', () => {
    const trashDir = createTrashDir();
    writePlan(trashDir, {
      id: 'protected-legacy',
      name: 'engine-test-my-real-course',
      topics: [{ detail: 'real lesson' }],
      history: [],
    });

    const result = cleanTestTrash({ trashDir, legacyNames: true, confirmLegacy: true });

    assert.equal(result.count, 0);
    assert.deepEqual(result.protected.map(item => item.id), ['protected-legacy']);
    assert.equal(fs.existsSync(path.join(trashDir, 'protected-legacy.json')), true);
  });

  it('removes empty legacy test plans after confirmation', () => {
    const trashDir = createTrashDir();
    writePlan(trashDir, {
      id: 'empty-integration-test',
      name: '集成测试计划',
      topics: [],
      history: [],
    });

    const result = cleanTestTrash({ trashDir, legacyNames: true, confirmLegacy: true });

    assert.equal(result.count, 1);
    assert.equal(fs.existsSync(path.join(trashDir, 'empty-integration-test.json')), false);
  });
});
