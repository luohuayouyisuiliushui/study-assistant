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
  'analysis-',
  'decompose-',
  'empty-analysis',
  'feynman-',
  'scaffold-',
  'mode-',
  'quiz-',
  'reveal-',
  'empty-fb-',
  'gendetail-',
  '画像测试',
  '画像摘要测试',
  '画像生成测试',
  '画像合并测试',
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

  let storedPlansById = null;
  const unreadableStoredIds = new Set();
  if (typeof activeStore.scanStoredPlans === 'function') {
    try {
      const scan = await activeStore.scanStoredPlans();
      if (!scan || !Array.isArray(scan.plans) || !Array.isArray(scan.errors)) {
        throw new TypeError('scanStoredPlans() returned an invalid result');
      }
      storedPlansById = new Map();
      let scanIsComplete = true;
      for (const scanError of scan.errors) {
        if (typeof scanError?.id === 'string') {
          unreadableStoredIds.add(scanError.id);
        } else {
          scanIsComplete = false;
        }
        result.errors.push({
          id: scanError?.id ?? null,
          stage: 'scan',
          message: scanError?.message ?? 'Stored plan could not be scanned',
        });
      }
      for (const plan of scan.plans) {
        if (!plan || typeof plan !== 'object' || typeof plan.id !== 'string' || plan.id.length === 0) {
          result.errors.push({ stage: 'scan', message: 'Stored plan has an invalid id' });
          continue;
        }
        if (storedPlansById.has(plan.id)) {
          result.errors.push({ id: plan.id, name: plan.name ?? null, stage: 'scan', message: 'Duplicate stored plan id' });
          continue;
        }
        storedPlansById.set(plan.id, plan);
      }
      if (!scanIsComplete) storedPlansById = null;
    } catch (error) {
      result.errors.push({ stage: 'scan', message: errorMessage(error) });
      storedPlansById = null;
    }
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
    if (storedPlansById) {
      if (unreadableStoredIds.has(id)) continue;
      plan = storedPlansById.get(id) ?? null;
    } else {
      try {
        plan = await activeStore.getPlan(id);
      } catch (error) {
        result.errors.push({ id, name: indexName ?? null, stage: 'load', message: errorMessage(error) });
        continue;
      }
    }

    if (!plan) {
      if (storedPlansById) {
        result.candidates.push({
          id,
          name: indexName ?? null,
          reason: 'stale-index-entry',
          source: 'stale-index',
        });
      } else {
        result.skipped.push({ id, name: indexName ?? null, reason: 'plan-file-missing' });
      }
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

  if (storedPlansById) {
    for (const [id, plan] of storedPlansById) {
      if (seenIds.has(id)) continue;
      const name = plan.name ?? null;
      const classification = classifyPlanForCleanup(plan, { legacyNames, patterns });
      const record = { id, name, reason: classification.reason, orphaned: true };

      if (classification.status === 'candidate') {
        result.candidates.push({ ...record, source: classification.source });
      } else if (classification.status === 'protected') {
        result.protected.push({ ...record, signals: classification.signals });
      } else {
        result.skipped.push(record);
      }
    }
  }

  result.candidateCount = result.candidates.length;
  if (effectiveDryRun) return result;

  const staleCandidates = result.candidates.filter(candidate => candidate.source === 'stale-index');
  if (staleCandidates.length > 0) {
    if (typeof activeStore.pruneMissingPlanIndexEntries !== 'function') {
      for (const candidate of staleCandidates) {
        result.errors.push({
          id: candidate.id,
          name: candidate.name,
          stage: 'prune-index',
          message: 'Store does not support stale index cleanup',
        });
      }
    } else {
      try {
        const pruneResult = await activeStore.pruneMissingPlanIndexEntries(
          staleCandidates.map(candidate => candidate.id)
        );
        const removedIds = new Set((pruneResult?.removed ?? []).map(entry => entry.id));
        for (const candidate of staleCandidates) {
          if (removedIds.has(candidate.id)) {
            result.deleted.push(candidate);
          } else {
            result.errors.push({
              id: candidate.id,
              name: candidate.name,
              stage: 'prune-index',
              message: 'Index entry was retained because a plan file exists or the entry changed',
            });
          }
        }
      } catch (error) {
        result.errors.push({ stage: 'prune-index', message: errorMessage(error) });
      }
    }
  }

  for (const candidate of result.candidates) {
    if (candidate.source === 'stale-index') continue;

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

Default cleanup removes stale index entries and plans carrying the explicit node:test marker.`);
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
