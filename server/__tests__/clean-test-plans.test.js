import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_PLAN_MARKER } from '../engine/store/test-plan-marker.js';
import {
  DEFAULT_LEGACY_PATTERNS,
  classifyPlanForCleanup,
  cleanTestPlans,
  hasUserLearningData,
  looksLikeLegacyTestName,
  parseCleanupArgs,
} from '../scripts/clean-test-plans.js';

function markedPlan(id, name, overrides = {}) {
  return {
    id,
    name,
    topics: [],
    history: [],
    __testPlan: { marker: TEST_PLAN_MARKER, runner: 'node:test', createdAt: Date.now() },
    ...overrides,
  };
}

function fakeStore(plans, {
  indexEntries,
  loadErrors = new Map(),
  deleteErrors = new Map(),
  storedPlans,
  scanErrors = [],
} = {}) {
  const records = new Map(plans.map(plan => [plan.id, plan]));
  const index = indexEntries ?? plans.map(plan => ({ id: plan.id, name: plan.name }));
  const deleteCalls = [];

  const storeApi = {
    deleteCalls,
    listPlans() {
      return index.map(entry => ({ ...entry }));
    },
    getPlan(id) {
      if (loadErrors.has(id)) throw loadErrors.get(id);
      return records.get(id) ?? null;
    },
    async permanentlyDeletePlan(id) {
      deleteCalls.push(id);
      if (deleteErrors.has(id)) throw deleteErrors.get(id);
      records.delete(id);
      for (let i = index.length - 1; i >= 0; i--) {
        if (index[i]?.id === id) index.splice(i, 1);
      }
    },
  };

  if (storedPlans) {
    storeApi.scanStoredPlans = () => ({ plans: storedPlans, errors: scanErrors });
    storeApi.pruneMissingPlanIndexEntries = async (ids) => {
      const idSet = new Set(ids);
      const removed = [];
      for (let i = index.length - 1; i >= 0; i--) {
        const entry = index[i];
        if (idSet.has(entry?.id) && !records.has(entry.id)) {
          removed.push(...index.splice(i, 1));
        }
      }
      return {
        removed,
        retained: ids.filter(id => !removed.some(entry => entry.id === id)),
      };
    };
  }

  return storeApi;
}

describe('clean-test-plans classification', () => {
  it('keeps legacy name matching isolated from the default marker mode', () => {
    assert.ok(DEFAULT_LEGACY_PATTERNS.includes('engine-test-'));
    assert.equal(looksLikeLegacyTestName('engine-test-plan'), true);
    assert.equal(looksLikeLegacyTestName('feature_test'), true);
    assert.equal(looksLikeLegacyTestName('analysis-fu-empty'), true);
    assert.equal(looksLikeLegacyTestName('quiz-malformed'), true);
    assert.equal(looksLikeLegacyTestName('画像生成测试'), true);
    assert.equal(looksLikeLegacyTestName('Software Test Fundamentals'), false);

    assert.deepEqual(
      classifyPlanForCleanup({ id: 'p1', name: 'engine-test-plan', topics: [], history: [] }),
      { status: 'skipped', reason: 'not-explicitly-marked' },
    );
  });

  it('recognizes learning data that must protect legacy plans', () => {
    assert.equal(hasUserLearningData({ topics: [{ detail: 'generated lesson' }] }), true);
    assert.equal(hasUserLearningData({ topics: [], history: [{ role: 'user', content: 'answer' }] }), true);
    assert.equal(hasUserLearningData({ topics: Array.from({ length: 10 }, () => ({})) }), true);
    assert.equal(hasUserLearningData({ topics: [{ title: 'empty scaffold' }], history: [] }), false);
  });
});

describe('cleanTestPlans', () => {
  it('does not delete an unmarked plan merely because its name looks like a test', async () => {
    const storeApi = fakeStore([
      { id: 'user-plan', name: 'engine-test-my-real-course', topics: [], history: [] },
    ]);

    const result = await cleanTestPlans({ storeApi });

    assert.equal(result.candidateCount, 0);
    assert.equal(result.count, 0);
    assert.deepEqual(storeApi.deleteCalls, []);
    assert.equal(result.skipped[0].reason, 'not-explicitly-marked');
  });

  it('deletes an explicitly marked plan even when it contains rich generated test data', async () => {
    const richTopics = Array.from({ length: 12 }, (_, index) => ({
      title: `Topic ${index + 1}`,
      detail: index === 0 ? 'A generated detail' : null,
    }));
    const storeApi = fakeStore([
      markedPlan('marked-rich', 'ordinary-looking-name', {
        topics: richTopics,
        history: [{ role: 'user', content: 'test answer' }],
      }),
    ]);

    const result = await cleanTestPlans({ storeApi });

    assert.equal(result.candidateCount, 1);
    assert.equal(result.count, 1);
    assert.deepEqual(storeApi.deleteCalls, ['marked-rich']);
    assert.equal(result.deleted[0].source, 'marker');
    assert.equal(result.protected.length, 0);
  });

  it('protects legacy-name plans with real learning data and only deletes empty legacy fixtures', async () => {
    const storeApi = fakeStore([
      { id: 'detail', name: 'engine-test-detail', topics: [{ detail: 'lesson' }], history: [] },
      { id: 'history', name: 'adaptive-test-history', topics: [], history: [{ content: 'answer' }] },
      { id: 'many', name: 'core20-many', topics: Array.from({ length: 10 }, () => ({})), history: [] },
      { id: 'empty', name: 'feynman-empty', topics: [{ title: 'fixture' }], history: [] },
    ]);

    const result = await cleanTestPlans({
      storeApi,
      legacyNames: true,
      confirmLegacy: true,
    });

    assert.equal(result.candidateCount, 1);
    assert.equal(result.count, 1);
    assert.deepEqual(storeApi.deleteCalls, ['empty']);
    assert.deepEqual(result.protected.map(item => item.id).sort(), ['detail', 'history', 'many']);
    assert.ok(result.protected.every(item => item.reason === 'user-learning-data'));
  });

  it('reports dry-run candidates without claiming that they were deleted', async () => {
    const storeApi = fakeStore([markedPlan('preview', 'preview-plan')]);

    const result = await cleanTestPlans({ storeApi, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.count, 0);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.candidates[0].id, 'preview');
    assert.deepEqual(storeApi.deleteCalls, []);
    assert.ok(storeApi.getPlan('preview'));
  });

  it('makes load, deletion, protection, and skip outcomes observable', async () => {
    const plans = [
      markedPlan('ok', 'ok-plan'),
      markedPlan('delete-fails', 'delete-fails-plan'),
      { id: 'protected', name: 'engine-test-course', topics: [], history: [{ content: 'study' }] },
      { id: 'normal', name: 'Normal course', topics: [], history: [] },
    ];
    const storeApi = fakeStore(plans, {
      indexEntries: [
        ...plans.map(plan => ({ id: plan.id, name: plan.name })),
        { id: 'load-fails', name: 'load failure' },
        { id: 'missing', name: 'missing file' },
        { name: 'invalid entry' },
        { id: 'ok', name: 'duplicate entry' },
      ],
      loadErrors: new Map([['load-fails', new Error('cannot read plan')]]),
      deleteErrors: new Map([['delete-fails', new Error('cannot delete plan')]]),
    });

    const result = await cleanTestPlans({
      storeApi,
      legacyNames: true,
      confirmLegacy: true,
    });

    assert.equal(result.candidateCount, 2);
    assert.equal(result.count, 1);
    assert.deepEqual(result.deleted.map(item => item.id), ['ok']);
    assert.deepEqual(result.protected.map(item => item.id), ['protected']);
    assert.ok(result.skipped.some(item => item.reason === 'legacy-name-not-matched'));
    assert.ok(result.skipped.some(item => item.reason === 'plan-file-missing'));
    assert.ok(result.skipped.some(item => item.reason === 'invalid-index-entry'));
    assert.ok(result.skipped.some(item => item.reason === 'duplicate-index-entry'));
    assert.ok(result.errors.some(item => item.stage === 'load' && item.id === 'load-fails'));
    assert.ok(result.errors.some(item => item.stage === 'delete' && item.id === 'delete-fails'));
  });

  it('forces legacy cleanup into dry-run unless explicit confirmation is provided', async () => {
    const storeApi = fakeStore([
      { id: 'legacy', name: 'engine-test-empty', topics: [], history: [] },
    ]);

    const result = await cleanTestPlans({ storeApi, legacyNames: true });

    assert.equal(result.confirmationRequired, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.count, 0);
    assert.deepEqual(storeApi.deleteCalls, []);
  });

  it('cleans stale index entries and discovers marked orphan plan files', async () => {
    const storedPlans = [
      markedPlan('orphan-marker', 'orphan marker fixture'),
      { id: 'real', name: 'Real course', topics: [{ detail: 'lesson' }], history: [] },
    ];
    const storeApi = fakeStore(storedPlans, {
      storedPlans,
      indexEntries: [
        { id: 'stale', name: 'old missing fixture' },
        { id: 'real', name: 'Real course' },
      ],
    });

    const result = await cleanTestPlans({ storeApi });

    assert.equal(result.candidateCount, 2);
    assert.equal(result.count, 2);
    assert.ok(result.deleted.some(item => item.id === 'stale' && item.source === 'stale-index'));
    assert.ok(result.deleted.some(item => item.id === 'orphan-marker' && item.orphaned === true));
    assert.deepEqual(storeApi.deleteCalls, ['orphan-marker']);
    assert.deepEqual(storeApi.listPlans().map(item => item.id), ['real']);
  });

  it('reports stored-plan scan errors without pruning unreadable entries', async () => {
    const storeApi = fakeStore([], {
      storedPlans: [],
      indexEntries: [{ id: 'unreadable', name: 'Unreadable course' }],
      scanErrors: [{ id: 'unreadable', message: 'Plan file could not be read' }],
    });

    const result = await cleanTestPlans({ storeApi });

    assert.equal(result.candidateCount, 0);
    assert.equal(result.count, 0);
    assert.ok(result.errors.some(item => item.stage === 'scan' && item.id === 'unreadable'));
    assert.deepEqual(storeApi.listPlans().map(item => item.id), ['unreadable']);
  });

  it('does not prune the index when the stored-plan directory scan is incomplete', async () => {
    const storeApi = fakeStore([], {
      storedPlans: [],
      indexEntries: [{ id: 'possibly-present', name: 'Possibly present course' }],
      scanErrors: [{ id: null, message: 'Cannot scan plan directory' }],
    });

    const result = await cleanTestPlans({ storeApi });

    assert.equal(result.candidateCount, 0);
    assert.ok(result.errors.some(item => item.stage === 'scan' && item.id === null));
    assert.ok(result.skipped.some(item => item.id === 'possibly-present'));
    assert.deepEqual(storeApi.listPlans().map(item => item.id), ['possibly-present']);
  });
});

describe('parseCleanupArgs', () => {
  it('forces --legacy-names without --confirm into dry-run', () => {
    assert.deepEqual(parseCleanupArgs(['--legacy-names']), {
      legacyNames: true,
      confirmLegacy: false,
      dryRun: true,
      help: false,
      confirmationRequired: true,
    });
  });

  it('allows confirmed legacy deletion while preserving an explicit dry-run', () => {
    assert.equal(parseCleanupArgs(['--legacy-names', '--confirm']).dryRun, false);
    assert.equal(parseCleanupArgs(['--legacy-names', '--confirm']).confirmationRequired, false);
    assert.equal(parseCleanupArgs(['--legacy-names', '--confirm', '--dry-run']).dryRun, true);
  });

  it('rejects unknown arguments', () => {
    assert.throws(() => parseCleanupArgs(['--delete-everything']), /Unknown argument/);
  });
});
