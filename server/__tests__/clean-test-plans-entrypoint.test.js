import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const cleanupModuleUrl = pathToFileURL(path.join(serverDir, 'scripts', 'clean-test-plans.js')).href;

describe('clean-test-plans module entrypoint', () => {
  it('does not execute cleanup merely because an importing filename contains clean-test-plans', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-assistant-cleanup-import-'));
    const probePath = path.join(tempDir, 'clean-test-plans-import-probe.mjs');
    fs.writeFileSync(probePath, `await import(${JSON.stringify(cleanupModuleUrl)}); console.log('IMPORT_OK');\n`, 'utf8');

    try {
      const result = spawnSync(process.execPath, [probePath], {
        cwd: serverDir,
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.trim(), 'IMPORT_OK');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});