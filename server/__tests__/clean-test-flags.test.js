import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTestFlags } from '../scripts/clean-test-flags.js';

const tempDirs = [];

function createFlagDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-assistant-test-flags-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cleanTestFlags', () => {
  it('only removes test-run notification flags', () => {
    const flagDir = createFlagDir();
    fs.writeFileSync(path.join(flagDir, 'flag-test-123.flag'), '{}', 'utf8');
    fs.writeFileSync(path.join(flagDir, '7d45f64e-8a18-42af-a34c-a6d0d019a2b6.flag'), '{}', 'utf8');

    const result = cleanTestFlags({ flagDir });

    assert.equal(result.candidateCount, 1);
    assert.equal(result.count, 1);
    assert.equal(fs.existsSync(path.join(flagDir, 'flag-test-123.flag')), false);
    assert.equal(fs.existsSync(path.join(flagDir, '7d45f64e-8a18-42af-a34c-a6d0d019a2b6.flag')), true);
  });

  it('reports candidates without deleting them in dry-run mode', () => {
    const flagDir = createFlagDir();
    fs.writeFileSync(path.join(flagDir, 'flag-test-456.flag'), '{}', 'utf8');

    const result = cleanTestFlags({ flagDir, dryRun: true });

    assert.equal(result.candidateCount, 1);
    assert.equal(result.count, 0);
    assert.equal(fs.existsSync(path.join(flagDir, 'flag-test-456.flag')), true);
  });
});
