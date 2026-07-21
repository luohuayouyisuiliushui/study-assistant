import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasTestPlanMarker } from '../engine/store/test-plan-marker.js';

// ── Path helpers (mirrors storage.js planPath) ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARN_DIR = path.join(__dirname, '..', 'data', 'learn');
const PLANS_DIR = path.join(LEARN_DIR, 'plans');

function planFilePath(id) {
  return path.join(PLANS_DIR, `${id}.json`);
}

// ── Legacy test name patterns ──
// Only used with --legacy-names. Each pattern is a startsWith match.
// Tightened to test-code-specific prefixes (no overly generic terms like
// "analysis-", "mode-", "quiz-" that could match real learning plans).
export const DEFAULT_LEGACY_PATTERNS = Object.freeze([
  // learn-engine.test.js
  'engine-test-',
  'adaptive-test-',
  'empty-topic-',
  'gendetail-',
  'empty-fb-',
  'followup-',
  'reveal-',
  'decompose-',
  'fc-',
  'session-end-',
  'reopen-',
  'no-session-',
  'persist-test',
  // learn-store.test.js
  'reorder-test',
  'teaching-errors-',
  'remove-nonexist',
  'empty-graph',
  'dup-edge',
  'special-chars',
  'time-edge-test',
  'empty-topics-test',
  'get-test',
  'topics-test',
  'dup-test',
  'update-test',
  'time-test',
  'remove-test',
  'history-test',
  'merge-test',
  'no-merge-test',
  'filter-test',
  'profile-test',
  'completion-test',
  'qa-count-test',
  'children-test',
  'pre-test',
  'no-pre-test',
  'graph-test',
  'delete-me',
  'trash-test-',
  'exam-store-test',
  'exam-grade-test',
  'exam-del-test',
  'exam-null-test',
  'tmp-cleanup-test',
  'trash-gap-test',
  // data-consistency.test.js
  '一致性测试',
  '恢复一致性',
  '原子写入测试',
  '试卷数据测试',
  '教学错误测试',
  // edge-cases.test.js
  '边界测试计划',
  'Emoji测试',
  '换行测试',
  '批量测试',
  '大内容测试',
  '空更新测试',
  '字段保留测试',
  '历史测试',
  '快速历史',
  '单知识点图谱',
  '循环依赖',
  '恢复测试',
  // user-profile.test.js
  '画像测试',
  '画像摘要测试',
  '画像生成测试',
  '画像合并测试',
  // test-plan-marker.test.js
  'marker-',
  // fact-checker.test.js
  'fact-check-',
  // learn-engine.test.js (analysis / core20 / feynman / scaffold / mode / quiz)
  'analysis-',
  'empty-analysis',
  'core20-',
  'feynman-',
  'scaffold-',
  'mode-',
  'quiz-',
  // Generic test suffixes
  'clean-plan',
  'interactive-test-',
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

// ── Orphaned file detection ──
// (see scanPlanFilesOnDisk below, used in cleanTestPlans step 4)

/**
 * Scan the plans/ directory and return a Set of plan IDs that exist on disk.
 * Only checks file existence — does NOT load plan content.
 * Used for stale-index detection and orphan-file discovery.
 */
function scanDiskPlanIds() {
  try {
    const files = fs.readdirSync(PLANS_DIR).filter(f =>
      f.endsWith('.json') && !f.endsWith('.bak') && !f.includes('.tmp.')
    );
    return new Set(files.map(f => path.basename(f, '.json')));
  } catch {
    return null; // directory not readable
  }
}

/**
 * Load a single plan from disk (used for orphaned files not reachable via store).
 */
function loadPlanFromDisk(id) {
  const fp = planFilePath(id);
  try {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

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
    candidates: [],       // ① 明确测试标记 + ② 旧版名称 + ③ 失效索引
    deleted: [],
    protected: [],        // ⑤ 含用户数据的计划
    skipped: [],
    orphanedFiles: [],    // ④ 磁盘有但索引无的孤立文件
    errors: [],
  };

  // ── 1. Read index ──
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

  // ── 2. Build disk file set (only for real store — mock stores are in-memory) ──
  const usingRealStore = !storeApi;
  const diskIds = usingRealStore ? scanDiskPlanIds() : null;

  // ── 3. Use store's scanStoredPlans for bulk loading when available ──
  let storedPlansById = null;
  const unreadableStoredIds = new Set();
  if (typeof activeStore.scanStoredPlans === 'function') {
    try {
      const scan = await activeStore.scanStoredPlans();
      if (scan && Array.isArray(scan.plans) && Array.isArray(scan.errors)) {
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
      }
    } catch (error) {
      result.errors.push({ stage: 'scan', message: errorMessage(error) });
      storedPlansById = null;
    }
  }

  // ── 4. Process each index entry ──
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

    // ── ③ Stale index detection ──
    // Skip entries flagged as unreadable by scanStoredPlans
    if (unreadableStoredIds.has(id)) continue;

    // If diskIds is available (directory readable), check file existence directly.
    // If diskIds is null (directory unreadable), fall back: if storedPlansById
    // is available, check membership; otherwise trust the store's getPlan.
    const fileMissing = diskIds !== null ? !diskIds.has(id)
      : storedPlansById ? !storedPlansById.has(id)
      : false;

    if (fileMissing) {
      // When we have a reliable disk scan or stored-plans scan showing
      // the file is absent, mark as stale-index candidate.
      if (diskIds !== null || storedPlansById) {
        result.candidates.push({
          id,
          name: indexName ?? null,
          reason: 'stale-index-entry',
          source: 'stale-index',
        });
        continue;
      }
      // Without any disk/scan data, we can't be sure it's stale.
      // Fall through to load via getPlan.
    }

    // ── Load plan content ──
    let plan = null;
    if (storedPlansById) {
      plan = storedPlansById.get(id) ?? null;
    }
    if (!plan) {
      try {
        plan = await activeStore.getPlan(id);
      } catch (error) {
        result.errors.push({ id, name: indexName ?? null, stage: 'load', message: errorMessage(error) });
        continue;
      }
    }

    if (!plan) {
      // plan not loadable via any means
      if (diskIds !== null && diskIds.has(id)) {
        // File exists on disk but store can't load it
        result.errors.push({ id, name: indexName ?? null, stage: 'load', message: 'Plan file exists on disk but could not be loaded' });
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

  // ── 5. Detect orphaned files: on disk / storedPlansById but not in index ──
  // When storedPlansById is available (from scanStoredPlans), check it first.
  // Then check real disk files (when available).
  const orphanCandidates = [];

  if (storedPlansById) {
    for (const [id, plan] of storedPlansById) {
      if (seenIds.has(id)) continue;
      orphanCandidates.push({ id, plan });
    }
  }

  if (diskIds !== null) {
    for (const id of diskIds) {
      if (seenIds.has(id)) continue;
      // Avoid double-processing if already covered by storedPlansById
      if (storedPlansById?.has(id)) continue;

      const plan = loadPlanFromDisk(id);
      if (!plan) {
        result.errors.push({ id, stage: 'disk-scan', message: 'Orphaned plan file could not be read' });
        continue;
      }
      orphanCandidates.push({ id, plan });
    }
  }

  for (const { id, plan } of orphanCandidates) {
    const name = plan.name ?? null;
    const classification = classifyPlanForCleanup(plan, { legacyNames, patterns });
    const record = { id, name, reason: classification.reason, orphaned: true };

    if (classification.status === 'candidate') {
      result.orphanedFiles.push({ ...record, source: classification.source });
      result.candidates.push({ ...record, source: classification.source });
    } else if (classification.status === 'protected') {
      result.orphanedFiles.push({ ...record, signals: classification.signals, protected: true });
    } else {
      result.orphanedFiles.push({ ...record, skipped: true });
    }
  }

  // ── 6. Verify index–disk consistency ──
  result.consistency = {
    indexEntryCount: indexEntries.length,
    diskFileCount: diskIds?.size ?? null,
    inSync: true,
  };
  if (diskIds !== null) {
    const indexIdSet = new Set(indexEntries.map(e => e?.id).filter(Boolean));
    const missingFromIndex = [...diskIds].filter(id => !indexIdSet.has(id));
    if (missingFromIndex.length > 0) {
      result.consistency.inSync = false;
      result.consistency.missingFromIndex = missingFromIndex;
    }
    const missingFromDisk = indexEntries
      .filter(e => e?.id && !diskIds.has(e.id))
      .map(e => e.id);
    if (missingFromDisk.length > 0) {
      result.consistency.inSync = false;
      result.consistency.missingFromDisk = missingFromDisk;
    }
  }

  // ── 7. Dry-run / delete ──
  result.candidateCount = result.candidates.length;
  if (effectiveDryRun) return result;

  // ③ Stale index cleanup
  const staleCandidates = result.candidates.filter(c => c.source === 'stale-index');
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
          staleCandidates.map(c => c.id)
        );
        const removedIds = new Set((pruneResult?.removed ?? []).map(e => e.id));
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

  // ① + ② Delete test-marked and legacy-name plans (including orphaned files)
  for (const candidate of result.candidates) {
    if (candidate.source === 'stale-index') continue;

    // For orphaned files without an index entry, try store first, then delete file directly.
    // (orphaned files from storedPlansById may exist only in the store, not on real disk.)
    if (candidate.orphaned) {
      let storeDeleted = false;
      try {
        // Try store deletion first (works for mock/test stores and real store alike)
        if (typeof activeStore.permanentlyDeletePlan === 'function') {
          await activeStore.permanentlyDeletePlan(candidate.id);
          // Verify
          const remaining = await activeStore.getPlan(candidate.id);
          if (!remaining) storeDeleted = true;
        }
      } catch {
        // store deletion failed, fall through to file deletion
      }

      if (!storeDeleted) {
        try {
          const fp = planFilePath(candidate.id);
          if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
            const bakPath = fp + '.bak';
            if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
          }
        } catch (error) {
          result.errors.push({
            id: candidate.id,
            name: candidate.name,
            stage: 'delete-orphan',
            message: errorMessage(error),
          });
          continue;
        }
      }
      result.deleted.push(candidate);
      continue;
    }

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

Data categories:
  ① Explicit marker  — plans with __testPlan marker (always cleaned)
  ② Legacy name      — plans matching legacy test name patterns
  ③ Stale index      — index entries whose plan file no longer exists
  ④ Orphaned files   — plan files on disk missing from plans.json
  ⑤ Protected        — plans with user learning data (never deleted)

Default cleanup removes ① + ③. Use --legacy-names for ② + ④.`);
}

function printResult(result) {
  const mode = result.dryRun ? 'dry-run' : 'delete';

  // ── Summary line ──
  const parts = [
    `mode=${mode}`,
    `candidates=${result.candidateCount}`,
    `deleted=${result.count}`,
  ];
  if (result.protected.length > 0) parts.push(`protected=${result.protected.length}`);
  if (result.orphanedFiles.length > 0) {
    const orphanProtected = result.orphanedFiles.filter(f => f.protected).length;
    parts.push(`orphaned=${result.orphanedFiles.length}`);
    if (orphanProtected > 0) parts.push(`orphan-protected=${orphanProtected}`);
  }
  parts.push(`skipped=${result.skipped.length}`);
  parts.push(`errors=${result.errors.length}`);
  console.log(`[clean-test-plans] ${parts.join(' ')}`);

  // ── Consistency check ──
  if (result.consistency) {
    const c = result.consistency;
    if (c.inSync) {
      console.log(`[clean-test-plans] consistency: OK (index=${c.indexEntryCount}, disk=${c.diskFileCount})`);
    } else {
      if (c.missingFromDisk?.length) {
        console.log(`[clean-test-plans] consistency: ${c.missingFromDisk.length} index entries have no file on disk`);
      }
      if (c.missingFromIndex?.length) {
        console.log(`[clean-test-plans] consistency: ${c.missingFromIndex.length} files on disk have no index entry`);
      }
    }
  }

  // ── Candidates grouped by source ──
  if (result.dryRun && result.candidates.length > 0) {
    const bySource = new Map();
    for (const c of result.candidates) {
      const src = c.source ?? 'unknown';
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push(c);
    }
    const sourceLabels = {
      'marker': '① Explicit test marker',
      'legacy-name': '② Legacy test name',
      'stale-index': '③ Stale index entry',
      'orphaned': '④ Orphaned file',
    };
    for (const [source, items] of bySource) {
      const label = sourceLabels[source] ?? source;
      console.log(`  ── ${label} (${items.length}) ──`);
      for (const item of items.slice(0, 30)) {
        console.log(`    ${item.id} ${JSON.stringify(item.name)}`);
      }
      if (items.length > 30) {
        console.log(`    ... and ${items.length - 30} more`);
      }
    }
  }

  // ── Orphaned files detail ──
  if (result.orphanedFiles.length > 0 && !result.dryRun) {
    const protectedOrphans = result.orphanedFiles.filter(f => f.protected);
    if (protectedOrphans.length > 0) {
      console.log(`  ⚠ ${protectedOrphans.length} orphaned file(s) protected (user data detected):`);
      for (const f of protectedOrphans) {
        console.log(`    ${f.id} ${JSON.stringify(f.name)} (${(f.signals ?? []).join(', ')})`);
      }
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
