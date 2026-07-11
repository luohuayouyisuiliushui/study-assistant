import * as store from '../engine/learn-store.js';

export const DEFAULT_PATTERNS = [
  'engine-test-',
  'adaptive-test-',
  'empty-topic-',
  'reorder-test',
  'teaching-errors-',
  'remove-nonexist',
  'empty-graph',
  'dup-edge',
  'special-chars',
  'time-edge-test',
  'empty-topics-test',
  'core20-',
  'feynman-',
  'scaffold-',
  'mode-',
  'empty-fb-',
  'gendetail-',
  'V2 Test',
];

/**
 * Check if a plan name looks like a test plan.
 * Matches: known prefixes, names ending with -test/_test, or containing "test"/"Test".
 */
export function isTestPlan(name, patterns = DEFAULT_PATTERNS) {
  if (patterns.some(pat => name.startsWith(pat))) return true;
  if (/[-_]test$/i.test(name)) return true;
  if (/\btest\b/i.test(name)) return true;
  return false;
}

export function cleanTestPlans({ patterns = DEFAULT_PATTERNS, dryRun = false } = {}) {
  const plans = store.listPlans();
  const matched = plans.filter(p => isTestPlan(p.name, patterns));

  if (dryRun) return { deleted: matched.map(p => p.name), count: matched.length, dryRun: true };

  for (const p of matched) {
    try {
      store.permanentlyDeletePlan(p.id);
    } catch {
      // Plan file may have been removed by a concurrent process
    }
  }

  return { deleted: matched.map(p => ({ id: p.id, name: p.name })), count: matched.length };
}

if (process.argv[1]?.includes('clean-test-plans')) {
  const dryRun = process.argv.includes('--dry-run');
  const result = cleanTestPlans({ dryRun });
  if (dryRun) {
    if (result.count === 0) {
      console.log('没有匹配的测试计划');
    } else {
      console.log(`[dry-run] 将删除 ${result.count} 个测试计划:`);
      for (const name of result.deleted) console.log('  ' + name);
    }
  } else {
    console.log(`已清理 ${result.count} 个测试计划`);
  }
}
