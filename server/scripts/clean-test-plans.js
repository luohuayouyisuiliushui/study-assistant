import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasTestPlanMarker } from '../engine/store/test-plan-marker.js';

export const DEFAULT_LEGACY_PATTERNS = Object.freeze([
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
]);

let defaultStorePromise;

function loadDefaultStore() {
  defaultStorePromise ??= import('../engine/learn-store.js');
  return defaultStorePromise;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function learningDataSignals(plan) {
  if (!plan || typeof plan !== 'object') return [];

  const signals = [];
  const topics = Array.isArray(plan.topics) ? plan.topics : [];

  if (topics.length >= 10) signals.push('substantial-topic-list');
  if (topics.some(topic => hasText(topic?.detail))) signals.push('topic-detail');
  if (topics.some(topic => topic?.done === true)) signals.push('completed-topic');
  if (topics.some(topic => Number(topic?.timeSpent) > 0 || hasItems(topic?.timeLog))) {
    signals.push('learning-time');
  }
  if (topics.some(topic => hasItems(topic?.exercises))) signals.push('topic-exercises');
  if (topics.some(topic => hasItems(topic?.teachingErrors))) signals.push('teaching-errors');
  if (topics.some(topic => topic?.interactiveSession && typeof topic.interactiveSession === 'object')) {
    signals.push('interactive-session');
  }
  if (topics.some(topic => hasText(topic?.reviewGenerated) || hasItems(topic?.weakPoints))) {
    signals.push('review-data');
  }
  if (hasItems(plan.history)) signals.push('learning-history');
  if (hasItems(plan.examPapers)) signals.push('exam-history');
  if (hasItems(plan.quickQuizHistory)) signals.push('quiz-history');
  if (plan.coreAnalysis && typeof plan.coreAnalysis === 'object') signals.push('core-analysis');

  return signals;
}

/**
 * Legacy compatibility heuristic. It is never used by the default cleanup mode.
 */
export function looksLikeLegacyTestName(name, patterns = DEFAULT_LEGACY_PATTERNS) {
  const normalizedName = String(name ?? '');
  const normalizedPatterns = Array.isArray(patterns) ? patterns : [];
  if (normalizedPatterns.some(pattern =>
    typeof pattern === 'string' && pattern.length > 0 && normalizedName.startsWith(pattern)
  )) {
    return true;
  }
  return /[-_]test$/i.test(normalizedName);
}

/**
 * Conservative guard for legacy name-based cleanup.
 */
export function hasUserLearningData(plan) {
  return learningDataSignals(plan).length > 0;
}

/**
 * Classify one fully loaded plan without mutating it.
 */
export function classifyPlanForCleanup(plan, {
  legacyNames = false,
  patterns = DEFAULT_LEGACY_PATTERNS,
} = {}) {
  if (!plan || typeof plan !== 'object') {
    return { status: 'skipped', reason: 'invalid-plan' };
  }

  if (hasTestPlanMarker(plan)) {
    return {
      status: 'candidate',
      reason: 'explicit-test-marker',
      source: 'marker',
    };
  }

  if (!legacyNames) {
    return { status: 'skipped', reason: 'not-explicitly-marked' };
  }

  if (!looksLikeLegacyTestName(plan.name, patterns)) {
    return { status: 'skipped', reason: 'legacy-name-not-matched' };
  }

  const signals = learningDataSignals(plan);
  if (signals.length > 0) {
    return {
      status: 'protected',
      reason: 'user-learning-data',
      signals,
    };
  }

  return {
    status: 'candidate',
    reason: 'legacy-test-name',
    source: 'legacy-name',
  };
}

/**
 * Safely clean plans created by the test runner.
 *
 * Default mode only removes plans carrying the explicit node:test marker.
 * Legacy name matching is opt-in and is forced into dry-run unless confirmed.
 */
export async function cleanTestPlans({
  legacyNames = false,
  confirmLegacy = false,
  dryRun = false,
  patterns = DEFAULT_LEGACY_PATTERNS,
  storeApi,
} = {}) {
  const activeStore = storeApi ?? await loadDefaultStore();
  const confirmationRequired = Boolean(legacyNames && !confirmLegacy);
  const effectiveDryRun = Boolean(dryRun || confirmationRequired);
  const result = {
    dryRun: effectiveDryRun,
    legacyNames: Boolean(legacyNames),
    confirmationRequired,
    candidateCount: 0,
    count: 0,
    candidates: [],
    deleted: [],
    protected: [],
    skipped: [],
    errors: [],
  };

  let indexEntries;
  try {
    indexEntries = await activeStore.listPlans();
    if (!Array.isArray(indexEntries)) {
      throw new TypeError('listPlans() did not return an array');
    }
  } catch (error) {
    result.errors.push({ stage: 'list', message: errorMessage(error) });
    return result;
  }

  const seenIds = new Set();
  for (const entry of indexEntries) {
    const id = entry?.id;
    const indexName = entry?.name;

    if (typeof id !== 'string' || id.length === 0) {
      result.skipped.push({ id: id ?? null, name: indexName ?? null, reason: 'invalid-index-entry' });
      continue;
    }
    if (seenIds.has(id)) {
      result.skipped.push({ id, name: indexName ?? null, reason: 'duplicate-index-entry' });
      continue;
    }
    seenIds.add(id);

    let plan;
    try {
      plan = await activeStore.getPlan(id);
    } catch (error) {
      result.errors.push({ id, name: indexName ?? null, stage: 'load', message: errorMessage(error) });
      continue;
    }

    if (!plan) {
      result.skipped.push({ id, name: indexName ?? null, reason: 'plan-file-missing' });
      continue;
    }
    if (typeof plan !== 'object' || (plan.id != null && plan.id !== id)) {
      result.errors.push({
        id,
        name: indexName ?? null,
        stage: 'validate',
        message: 'Plan data does not match its index entry',
      });
      continue;
    }

    const name = plan.name ?? indexName ?? null;
    const classification = classifyPlanForCleanup({ ...plan, id, name }, { legacyNames, patterns });
    const record = { id, name, reason: classification.reason };

    if (classification.status === 'candidate') {
      result.candidates.push({ ...record, source: classification.source });
    } else if (classification.status === 'protected') {
      result.protected.push({ ...record, signals: classification.signals });
    } else {
      result.skipped.push(record);
    }
  }

  result.candidateCount = result.candidates.length;
  if (effectiveDryRun) return result;

  for (const candidate of result.candidates) {
    try {
      await activeStore.permanentlyDeletePlan(candidate.id);
    } catch (error) {
      result.errors.push({
        id: candidate.id,
        name: candidate.name,
        stage: 'delete',
        message: errorMessage(error),
      });
      continue;
    }

    try {
      const remainingPlan = await activeStore.getPlan(candidate.id);
      if (remainingPlan) {
        result.errors.push({
          id: candidate.id,
          name: candidate.name,
          stage: 'verify-delete',
          message: 'Plan still exists after deletion',
        });
        continue;
      }
    } catch (error) {
      result.errors.push({
        id: candidate.id,
        name: candidate.name,
        stage: 'verify-delete',
        message: errorMessage(error),
      });
      continue;
    }

    result.deleted.push(candidate);
  }

  result.count = result.deleted.length;
  return result;
}

export function parseCleanupArgs(argv = []) {
  const options = {
    legacyNames: false,
    confirmLegacy: false,
    dryRun: false,
    help: false,
    confirmationRequired: false,
  };

  for (const arg of argv) {
    if (arg === '--legacy-names') options.legacyNames = true;
    else if (arg === '--confirm') options.confirmLegacy = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.confirmationRequired = options.legacyNames && !options.confirmLegacy;
  if (options.confirmationRequired) options.dryRun = true;
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/clean-test-plans.js [options]

Options:
  --dry-run       Show candidates without deleting anything
  --legacy-names  Also inspect old name-based test plans (dry-run by default)
  --confirm       Allow deletion of safe legacy-name candidates
  -h, --help      Show this help

Default cleanup only deletes plans carrying the explicit node:test marker.`);
}

function printResult(result) {
  const mode = result.dryRun ? 'dry-run' : 'delete';
  console.log(
    `[clean-test-plans] mode=${mode} candidates=${result.candidateCount} ` +
    `deleted=${result.count} protected=${result.protected.length} ` +
    `skipped=${result.skipped.length} errors=${result.errors.length}`
  );

  if (result.dryRun) {
    for (const candidate of result.candidates) {
      console.log(`  candidate ${candidate.id} ${JSON.stringify(candidate.name)} (${candidate.source})`);
    }
  }
  for (const item of result.protected) {
    console.log(`  protected ${item.id} ${JSON.stringify(item.name)} (${item.signals.join(', ')})`);
  }
  for (const error of result.errors) {
    console.error(`  error ${error.stage}${error.id ? ` ${error.id}` : ''}: ${error.message}`);
  }
  if (result.confirmationRequired) {
    console.log('[clean-test-plans] --legacy-names requires --confirm for deletion; dry-run was enforced.');
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
const isDirectExecution = invokedPath === modulePath;

if (isDirectExecution) {
  try {
    const options = parseCleanupArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const result = await cleanTestPlans(options);
      printResult(result);
      if (result.errors.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[clean-test-plans] ${errorMessage(error)}`);
    printHelp();
    process.exitCode = 1;
  }
}
