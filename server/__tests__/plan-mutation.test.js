import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../engine/learn-store.js';
import { replacePlanRecords } from '../engine/store/write-plan.js';

const createdPlanIds = [];

after(async () => {
  for (const id of createdPlanIds) await store.permanentlyDeletePlan(id);
});

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
