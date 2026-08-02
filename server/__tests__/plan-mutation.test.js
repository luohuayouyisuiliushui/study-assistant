import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import * as store from '../engine/learn-store.js';
import { DATA } from '../engine/store/storage.js';
import { replacePlanRecords } from '../engine/store/write-plan.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const createdPlanIds = [];

after(async () => {
  for (const id of createdPlanIds) await store.permanentlyDeletePlan(id);
});

function runFixRelationsScript(planId, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(serverDir, 'scripts', 'fix-missing-relations.js'), planId, ...extraArgs],
      {
        cwd: serverDir,
        env: { ...process.env, STUDY_ASSISTANT_DATA_DIR: DATA },
      },
    );
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('Plan mutation seam replaces records, index entries, and cached reads together', async () => {
  const original = await store.createPlan('mutation-seam-original');
  createdPlanIds.push(original.id);
  assert.equal(store.getPlan(original.id).name, 'mutation-seam-original');

  const replacement = {
    ...original,
    name: 'mutation-seam-restored',
    updatedAt: original.updatedAt + 1,
    topics: [{ id: 'topic-1', title: 'TCP' }],
  };
  await replacePlanRecords([replacement]);

  assert.equal(store.getPlan(original.id).name, 'mutation-seam-restored');
  const indexEntry = store.listPlans().find(item => item.id === original.id);
  assert.deepEqual(indexEntry, {
    id: original.id,
    name: 'mutation-seam-restored',
    createdAt: original.createdAt,
    updatedAt: replacement.updatedAt,
    topicCount: 1,
  });
});

test('fix-missing-relations script persists extracted relations through the writePlan seam', async () => {
  const plan = await store.createPlan('fix-missing-relations-seam');
  createdPlanIds.push(plan.id);
  await store.addTopics(plan.id, ['Topic One', 'Topic Two']);
  const seeded = store.getPlan(plan.id);
  const [topicOne, topicTwo] = seeded.topics;

  await store.updateTopic(plan.id, topicOne.id, {
    detail: `${'背景内容'.repeat(100)}\n\n## 与相关知识点的联系\n- **Topic Two**：需要先掌握的前置基础知识。`,
  });

  const { code, output } = await runFixRelationsScript(plan.id);
  assert.equal(code, 0, output);

  const saved = store.getPlan(plan.id);
  const repaired = saved.topics.find(t => t.id === topicOne.id);
  assert.deepEqual(repaired.prerequisites, [topicTwo.id]);

  // The seam stamps updatedAt and writes the notification flag; a direct
  // plan-file write would do neither.
  assert.ok(saved.updatedAt >= seeded.updatedAt, 'writePlan updates updatedAt');
  const flags = store.readFlags();
  assert.ok(flags.includes(plan.id), `expected flag for ${plan.id}, got ${flags.join(', ')}`);
});
