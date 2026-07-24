import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPlanForCleanup, parseCleanupArgs } from './clean-test-plans.js';
import { writeAtomic } from '../engine/store/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TRASH_DIR = path.join(__dirname, '..', 'data', 'learn', 'trash');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readTrashIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return [];
  const value = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(value)) throw new TypeError('Trash index must be an array.');
  return value;
}

export function cleanTestTrash({
  legacyNames = false,
  confirmLegacy = false,
  dryRun = false,
  trashDir = DEFAULT_TRASH_DIR,
} = {}) {
  const confirmationRequired = Boolean(legacyNames && !confirmLegacy);
  const effectiveDryRun = Boolean(dryRun || confirmationRequired);
  const result = {
    dryRun: effectiveDryRun,
    confirmationRequired,
    candidateCount: 0,
    count: 0,
    candidates: [],
    deleted: [],
    protected: [],
    skipped: [],
    errors: [],
  };

  if (!fs.existsSync(trashDir)) return result;

  const indexPath = path.join(trashDir, 'index.json');
  let trashIndex;
  try {
    trashIndex = readTrashIndex(indexPath);
  } catch (error) {
    result.errors.push({ stage: 'read-index', message: errorMessage(error) });
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(trashDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'index.json');
  } catch (error) {
    result.errors.push({ stage: 'scan', message: errorMessage(error) });
    return result;
  }

  for (const entry of entries) {
    const filePath = path.join(trashDir, entry.name);
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      result.errors.push({ file: entry.name, stage: 'read', message: errorMessage(error) });
      continue;
    }

    const id = typeof plan?.id === 'string' ? plan.id : null;
    if (!id || entry.name !== `${id}.json`) {
      result.errors.push({ file: entry.name, stage: 'validate', message: 'Trash file name does not match its plan id.' });
      continue;
    }

    const classification = classifyPlanForCleanup(plan, { legacyNames });
    const record = { id, name: plan.name ?? null, file: entry.name, reason: classification.reason };
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
      fs.unlinkSync(path.join(trashDir, candidate.file));
      result.deleted.push(candidate);
    } catch (error) {
      result.errors.push({ id: candidate.id, stage: 'delete', message: errorMessage(error) });
    }
  }

  if (result.deleted.length > 0 && fs.existsSync(indexPath)) {
    try {
      const deletedIds = new Set(result.deleted.map(candidate => candidate.id));
      const nextIndex = trashIndex.filter(entry => !deletedIds.has(entry?.id));
      writeAtomic(indexPath, JSON.stringify(nextIndex, null, 2), { backup: false });
    } catch (error) {
      result.errors.push({ stage: 'write-index', message: errorMessage(error) });
    }
  }

  result.count = result.deleted.length;
  return result;
}

function printResult(result) {
  console.log(`[clean-test-trash] mode=${result.dryRun ? 'dry-run' : 'delete'} candidates=${result.candidateCount} deleted=${result.count} protected=${result.protected.length} skipped=${result.skipped.length} errors=${result.errors.length}`);
  for (const item of result.protected) {
    console.log(`  protected ${item.id} ${JSON.stringify(item.name)} (${item.signals.join(', ')})`);
  }
  for (const error of result.errors) {
    console.error(`  error ${error.stage}${error.id ? ` ${error.id}` : ''}: ${error.message}`);
  }
  if (result.confirmationRequired) {
    console.log('[clean-test-trash] --legacy-names requires --confirm for deletion; dry-run was enforced.');
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  try {
    const options = parseCleanupArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/clean-test-trash.js [--dry-run] [--legacy-names --confirm]');
    } else {
      const result = cleanTestTrash(options);
      printResult(result);
      if (result.errors.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[clean-test-trash] ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
