import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('root test script runs both server and client test suites', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, 'package.json'), 'utf8'),
  );

  assert.match(packageJson.scripts.test, /npm test --prefix server/);
  assert.match(packageJson.scripts.test, /npm test --prefix client/);
  assert.match(packageJson.scripts.lint, /npm run lint --prefix server/);
  assert.match(packageJson.scripts.lint, /npm run lint --prefix client/);
});

test('workspace guide documents the configured development port', async () => {
  const guide = await readFile(path.join(rootDir, 'AGENTS.md'), 'utf8');

  assert.doesNotMatch(guide, /\b5173\b/);
  assert.match(guide, /\b5270\b/);
});

test('workspace packages and active guides share one release version', async () => {
  const [rootPackage, serverPackage, clientPackage] = await Promise.all(
    ['package.json', 'server/package.json', 'client/package.json'].map(async file =>
      JSON.parse(await readFile(path.join(rootDir, file), 'utf8'))
    ),
  );
  assert.equal(serverPackage.version, rootPackage.version);
  assert.equal(clientPackage.version, rootPackage.version);

  for (const file of ['README.md', 'AGENTS.md', 'client/README.md']) {
    const text = await readFile(path.join(rootDir, file), 'utf8');
    assert.match(text, new RegExp(`v${rootPackage.version.replaceAll('.', '\\.')}`), file);
    assert.doesNotMatch(text, /v1\.(?:14|15)\.0/, file);
  }
});

test('assistant guide states the cross-project authority boundary', async () => {
  const guide = await readFile(path.join(rootDir, 'README.md'), 'utf8');
  for (const phrase of ['study-trace-theory-v1', 'study_trace', '不决定实践完成']) {
    assert.match(guide, new RegExp(phrase), phrase);
  }
});
