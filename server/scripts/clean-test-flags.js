import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FLAG_DIR = path.join(__dirname, '..', 'data', 'learn', 'flags');
const TEST_FLAG_FILE = /^flag-test-\d+\.flag$/i;

export function cleanTestFlags({ flagDir = DEFAULT_FLAG_DIR, dryRun = false } = {}) {
  const result = {
    dryRun: Boolean(dryRun),
    candidateCount: 0,
    count: 0,
    candidates: [],
    deleted: [],
    errors: [],
  };
  if (!fs.existsSync(flagDir)) return result;

  let names;
  try {
    names = fs.readdirSync(flagDir).filter(name => TEST_FLAG_FILE.test(name));
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }

  result.candidates = names;
  result.candidateCount = names.length;
  if (!result.dryRun) {
    for (const name of names) {
      try {
        fs.unlinkSync(path.join(flagDir, name));
      } catch (error) {
        result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    result.deleted = names.filter(name => !result.errors.some(error => error.startsWith(`${name}:`)));
  }
  result.count = result.deleted.length;
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  const result = cleanTestFlags({ dryRun: process.argv.includes('--dry-run') });
  console.log(`[clean-test-flags] mode=${result.dryRun ? 'dry-run' : 'delete'} candidates=${result.candidateCount} deleted=${result.count} errors=${result.errors.length}`);
  for (const error of result.errors) console.error(`  error: ${error}`);
  if (result.errors.length > 0) process.exitCode = 1;
}
