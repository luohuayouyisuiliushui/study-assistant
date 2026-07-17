import * as store from '../engine/learn-store.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const plansDir = path.join(__dirname, '..', 'data', 'learn', 'plans');

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
 * Check if a plan name looks like a test plan (name-based heuristic).
 */
export function looksLikeTestName(name, patterns = DEFAULT_PATTERNS) {
  if (patterns.some(pat => name.startsWith(pat))) return true;
  if (/[-_]test$/i.test(name)) return true;
  return false;
}

/**
 * Check plan content to decide if it's real user data.
 * A plan is considered "real" if any topic has generated detail (讲解)
 * or it has 10+ topics.
 */
function isRealData(plan) {
  if (!plan || !plan.topics) return false;
  const topicCount = plan.topics.length;
  if (topicCount >= 10) return true;
  const hasDetail = plan.topics.some(t => t.detail && t.detail.trim().length > 0);
  if (hasDetail) return true;
  return false;
}

/**
 * Determine whether a plan is safe to remove as test data.
 *
 * A matching test-like name is required. When full plan data is provided,
 * generated Detail or a substantial topic list protects it from deletion.
 */
export function isTestPlan(planOrName, patterns = DEFAULT_PATTERNS) {
  const plan = typeof planOrName === 'object' && planOrName !== null ? planOrName : null;
  const name = plan ? plan.name : planOrName;
  if (!looksLikeTestName(String(name ?? ''), patterns)) return false;
  return !plan || !isRealData(plan);
}

export async function cleanTestPlans({ patterns = DEFAULT_PATTERNS, dryRun = false } = {}) {
  const plans = store.listPlans();

  // Read full plan content for each entry to check topic count / detail
  const matched = [];
  for (const p of plans) {
    let fullPlan;
    try {
      const filePath = path.join(plansDir, `${p.id}.json`);
      if (!fs.existsSync(filePath)) continue;
      fullPlan = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }
    const candidate = { ...fullPlan, name: p.name ?? fullPlan.name };
    if (isTestPlan(candidate, patterns)) matched.push(p);
  }

  if (dryRun) return { deleted: matched.map(p => p.name), count: matched.length, dryRun: true };

  for (const p of matched) {
    try {
      await store.permanentlyDeletePlan(p.id);
    } catch {
      // Plan file may have been removed by a concurrent process
    }
  }

  return { deleted: matched.map(p => ({ id: p.id, name: p.name })), count: matched.length };
}

if (process.argv[1]?.includes('clean-test-plans')) {
  const dryRun = process.argv.includes('--dry-run');
  const result = await cleanTestPlans({ dryRun });
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
