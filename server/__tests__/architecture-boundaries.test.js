import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(serverDir, 'engine');

test('AI runtime owns provider acquisition and preserves learn-engine compatibility', async () => {
  const runtime = await import('../engine/ai-runtime.js');
  const providerModule = await import('../engine/provider.js');
  const config = { apiKey: 'test-key', baseURL: 'https://example.invalid/v1' };

  const first = runtime.resolveProvider(config, 'test-model');
  const second = runtime.resolveProvider(config, 'test-model');
  assert.ok(first instanceof providerModule.Provider);
  assert.strictEqual(first, second);
  assert.strictEqual(runtime.resolveProvider(first, 'ignored'), first);

  const learnEngine = await import('../engine/learn-engine.js');
  assert.strictEqual(learnEngine.resolveProvider, runtime.resolveProvider);
  assert.strictEqual(learnEngine.engineCacheMonitor, runtime.engineCacheMonitor);
});

test('only AI runtime creates or caches Providers', async () => {
  const dispatcher = await readFile(path.join(engineDir, 'agent-dispatcher.js'), 'utf8');
  const factChecker = await readFile(path.join(engineDir, 'fact-checker.js'), 'utf8');

  for (const [file, source] of [
    ['agent-dispatcher.js', dispatcher],
    ['fact-checker.js', factChecker],
  ]) {
    assert.doesNotMatch(source, /new Provider\(/, `${file} creates a private Provider`);
    assert.doesNotMatch(source, /providerCache|_providers/, `${file} owns a Provider cache`);
  }
});

test('domain CRUD consumes the Plan mutation seam directly', async () => {
  const storeDir = path.join(engineDir, 'store');
  for (const file of ['crud-exercises.js', 'crud-mastery.js']) {
    const source = await readFile(path.join(storeDir, file), 'utf8');
    assert.match(source, /from ['"]\.\/write-plan\.js['"]/);
    assert.doesNotMatch(source, /from ['"]\.\/crud-content\.js['"]/);
  }

  const content = await readFile(path.join(storeDir, 'crud-content.js'), 'utf8');
  assert.doesNotMatch(content, /export \{ writePlan \}/);
});

test('relation repair script uses the public Plan seam instead of storage internals', async () => {
  const script = await readFile(
    path.join(serverDir, 'scripts', 'fix-missing-relations.js'),
    'utf8',
  );
  assert.match(script, /from ['"]\.\.\/engine\/learn-store\.js['"]/);
  assert.doesNotMatch(script, /from ['"]\.\.\/engine\/store\//);
  assert.doesNotMatch(script, /writeFileSync\s*\(/, 'script still writes files directly');
  assert.doesNotMatch(
    script,
    /resolve\(__dirname, '\.\.', 'data', 'learn', 'plans'/,
    'script still composes a plan-file path for writing',
  );
});

test('learning engines depend on AI runtime instead of the catch-all engine', async () => {
  for (const file of ['exam-engine.js', 'interactive-teacher.js', 'learning-analyzer.js']) {
    const source = await readFile(path.join(engineDir, file), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\/learn-engine\.js['"]/);
    assert.match(source, /from ['"]\.\/ai-runtime\.js['"]/);
  }

  const middleware = await readFile(path.join(serverDir, 'routes', 'middleware.js'), 'utf8');
  assert.match(middleware, /from ['"]\.\.\/engine\/ai-runtime\.js['"]/);
});

test('routes cross one AI invocation boundary instead of composing legacy helpers', async () => {
  const routeDir = path.join(serverDir, 'routes');
  for (const file of ['learn.js', 'content.js', 'assessment.js', 'user-profile.js']) {
    const source = await readFile(path.join(routeDir, file), 'utf8');
    assert.match(source, /getAIInvocation/);
    assert.doesNotMatch(
      source,
      /\b(?:getProvider|getModel|getDispatcher|wantsAgentDispatch)\b/,
      `${file} still composes legacy AI helpers`,
    );
  }

  const middleware = await import('../routes/middleware.js');
  assert.equal(typeof middleware.getAIInvocation, 'function');
  for (const helper of ['getProvider', 'getModel', 'getDispatcher', 'wantsAgentDispatch']) {
    assert.equal(middleware[helper], undefined);
  }
});
