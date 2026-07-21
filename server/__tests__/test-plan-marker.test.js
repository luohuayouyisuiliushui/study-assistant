import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import * as store from '../engine/learn-store.js';
import { TEST_PLAN_MARKER as MARKER } from '../engine/store/test-plan-marker.js';

const createdIds = [];

async function track(planOrPromise) {
  const plan = await planOrPromise;
  createdIds.push(plan.id);
  return plan;
}

after(async () => {
  for (const id of createdIds) {
    try { await store.permanentlyDeletePlan(id); } catch {}
  }
});

describe('test plan marker', () => {
  it('marks plans created under node:test automatically', async () => {
    const plan = await track(store.createPlan('marker-auto-test'));
    assert.strictEqual(plan.__testPlan?.marker, MARKER);
    assert.strictEqual(plan.__testPlan?.runner, 'node:test');
  });

  it('allows a test to create an explicitly unmarked fixture', async () => {
    const plan = await track(store.createPlan('marker-opt-out', { testOnly: false }));
    assert.strictEqual(plan.__testPlan, undefined);
  });

  it('marks phase-based plans created under node:test', async () => {
    const plan = await track(store.createPlanWithPhases('marker-phases-test', [
      { name: '阶段一', topics: ['知识点 A'] },
    ]));
    assert.strictEqual(plan.__testPlan?.marker, MARKER);
  });

  it('invalidates the plan cache after permanent deletion', async () => {
    const plan = await track(store.createPlan('marker-cache-delete'));
    assert.ok(store.getPlan(plan.id), 'fixture should be cached before deletion');

    await store.permanentlyDeletePlan(plan.id);

    assert.strictEqual(store.getPlan(plan.id), null);
  });
});
