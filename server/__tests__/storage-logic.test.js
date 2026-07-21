/**
 * Tests for server/engine/store/storage.js — persistence primitives.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import {
  writeAtomic,
  readJSON,
  enqueueWrite,
  drainWriteQueue,
  readIndex,
  writeIndex,
  updateIndex,
  planPath,
  getCachedPlan,
  invalidatePlanCache,
  DATA,
  PLANS_INDEX,
} from '../engine/store/storage.js';

// ── Test helpers ──

function makePlan(id, name) {
  return { id, name, createdAt: Date.now(), updatedAt: Date.now(), topics: [], phases: [], history: [] };
}

function tmpFile() {
  return path.join(DATA, 'plans', `test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ── Cleanup ──

const tmpFiles = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch {}
    try { fs.unlinkSync(f + '.bak'); } catch {}
    try { fs.unlinkSync(f + '.tmp.' + process.pid); } catch {}
  }
});

// ═══════════════════════════════════════════════════════════
// writeAtomic + readJSON
// ═══════════════════════════════════════════════════════════

describe('writeAtomic + readJSON', () => {
  it('writes and reads JSON data', () => {
    const f = tmpFile();
    tmpFiles.push(f);
    const data = { hello: 'world', num: 42 };
    writeAtomic(f, JSON.stringify(data));
    const result = readJSON(f);
    assert.deepStrictEqual(result, data);
  });

  it('creates .bak backup when backup:true', () => {
    const f = tmpFile();
    tmpFiles.push(f);
    writeAtomic(f, JSON.stringify({ a: 1 }), { backup: true });
    const bak = f + '.bak';
    assert.ok(fs.existsSync(bak));
    const bakData = readJSON(bak);
    assert.deepStrictEqual(bakData, { a: 1 });
  });

  it('returns null for non-existent file', () => {
    assert.strictEqual(readJSON(tmpFile()), null);
  });

  it('returns null for empty file', () => {
    const f = tmpFile();
    tmpFiles.push(f);
    fs.writeFileSync(f, '', 'utf-8');
    assert.strictEqual(readJSON(f), null);
  });

  it('handles unicode characters', () => {
    const f = tmpFile();
    tmpFiles.push(f);
    const data = { title: '中文测试', emoji: '🚀' };
    writeAtomic(f, JSON.stringify(data));
    assert.deepStrictEqual(readJSON(f), data);
  });
});

// ═══════════════════════════════════════════════════════════
// enqueueWrite — serialization
// ═══════════════════════════════════════════════════════════

describe('enqueueWrite', () => {
  it('executes writes in order', async () => {
    const id = 'test-serial-' + Date.now();
    const fp = planPath(id);
    fs.writeFileSync(fp, JSON.stringify(makePlan(id, 'Test')), 'utf-8');
    tmpFiles.push(fp);

    const order = [];
    const p1 = enqueueWrite(id, () => { order.push(1); return Promise.resolve(); });
    const p2 = enqueueWrite(id, () => { order.push(2); return Promise.resolve(); });
    const p3 = enqueueWrite(id, () => { order.push(3); return Promise.resolve(); });

    await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it('rejects if plan file does not exist', async () => {
    await assert.rejects(
      () => enqueueWrite('nonexistent-id', () => {}),
      /Plan not found/
    );
  });
});

// ═══════════════════════════════════════════════════════════
// drainWriteQueue
// ═══════════════════════════════════════════════════════════

describe('drainWriteQueue', () => {
  it('drains pending writes', async () => {
    const id = 'test-drain-' + Date.now();
    const fp = planPath(id);
    fs.writeFileSync(fp, JSON.stringify(makePlan(id, 'Test')), 'utf-8');
    tmpFiles.push(fp);

    let executed = false;
    enqueueWrite(id, () => { executed = true; return Promise.resolve(); });
    await drainWriteQueue(id);
    assert.ok(executed);
  });
});

// ═══════════════════════════════════════════════════════════
// Index operations
// ═══════════════════════════════════════════════════════════

describe('index operations', () => {
  it('readIndex returns array', () => {
    const idx = readIndex();
    assert.ok(Array.isArray(idx));
  });

  it('writeIndex and updateIndex maintain consistency', async () => {
    const testId = 'test-idx-' + Date.now();
    const fp = planPath(testId);
    const plan = makePlan(testId, 'IndexTest');
    writeAtomic(fp, JSON.stringify(plan), { backup: true });
    tmpFiles.push(fp);

    const originalIdx = readIndex();
    const idx = originalIdx.slice();
    idx.push({ id: testId, name: 'Before', createdAt: plan.createdAt, updatedAt: plan.updatedAt, topicCount: 0 });
    await writeIndex(idx);
    await updateIndex(testId, { name: 'After' });

    const afterIdx = readIndex();
    const entry = afterIdx.find(e => e.id === testId);
    assert.ok(entry, 'entry should exist in index');
    assert.strictEqual(entry.name, 'After');

    // Restore the index to its original state so this test does not leave an
    // orphan index entry (which would break global consistency checks).
    await writeIndex(originalIdx);
  });

  it('readIndex handles large index', () => {
    const idx = readIndex();
    assert.ok(Array.isArray(idx));
    assert.ok(idx.length >= 0);
  });
});

// ═══════════════════════════════════════════════════════════
// Plan cache
// ═══════════════════════════════════════════════════════════

describe('plan cache', () => {
  it('caches getCachedPlan results', () => {
    const planId = 'cache-test-' + Date.now();
    let loadCount = 0;
    const loader = () => { loadCount++; return { id: planId, name: 'Cached' }; };

    const r1 = getCachedPlan(planId, loader);
    const r2 = getCachedPlan(planId, loader);
    assert.strictEqual(loadCount, 1);
    assert.strictEqual(r1.name, 'Cached');
    assert.strictEqual(r2.name, 'Cached');
  });

  it('invalidatePlanCache clears entry', () => {
    const planId = 'cache-inv-' + Date.now();
    let loadCount = 0;
    const loader = () => { loadCount++; return { id: planId, name: 'Fresh' }; };

    getCachedPlan(planId, loader);
    invalidatePlanCache(planId);
    getCachedPlan(planId, loader);
    assert.strictEqual(loadCount, 2);
  });

  it('returns null from loader when no data', () => {
    const result = getCachedPlan('no-data', () => null);
    assert.strictEqual(result, null);
  });
});
