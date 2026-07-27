import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let serverProcess;
let baseUrl;
let tempDataDir;

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function startIsolatedServer(dataDir) {
  return new Promise((resolve, reject) => {
    const helper = new URL('./helpers/isolated-learn-server.js', import.meta.url);
    serverProcess = fork(helper, [], {
      env: { ...process.env, STUDY_ASSISTANT_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    const timeout = setTimeout(() => reject(new Error('Timed out starting isolated learn server')), 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      serverProcess.off('message', onMessage);
      serverProcess.off('error', onError);
      serverProcess.off('exit', onExit);
    };
    const onMessage = message => {
      cleanup();
      if (message?.error) reject(new Error(message.error));
      else resolve(`http://127.0.0.1:${message.port}`);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Isolated learn server exited before listening (code=${code}, signal=${signal})`));
    };

    serverProcess.on('message', onMessage);
    serverProcess.once('error', onError);
    serverProcess.once('exit', onExit);
  });
}

async function stopIsolatedServer() {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.killed) return;
  await new Promise(resolve => {
    serverProcess.once('exit', resolve);
    serverProcess.kill();
  });
}

describe('Route Integration', () => {
  before(async () => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-assistant-route-'));
    baseUrl = await startIsolatedServer(tempDataDir);
  });

  after(async () => {
    await stopIsolatedServer();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('GET /api/learn/plans returns an isolated plans array', async () => {
    const res = await request('GET', '/api/learn/plans');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans, []);
  });

  it('rejects an invalid create request', async () => {
    const res = await request('POST', '/api/learn/plans', { name: '' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('creates and moves plans to trash without touching port 3001', async () => {
    const created = await request('POST', '/api/learn/plans', { name: '集成测试计划' });
    assert.equal(created.status, 200);
    assert.ok(created.body.plan.id);

    const deleted = await request('DELETE', `/api/learn/plans/${created.body.plan.id}`);
    assert.equal(deleted.status, 200);

    const trash = await request('GET', '/api/learn/trash');
    assert.equal(trash.status, 200);
    assert.equal(trash.body.plans.some(plan => plan.id === created.body.plan.id), true);
  });

  it('persists topic weak points through the public cross-project contract', async () => {
    const created = await request('POST', '/api/learn/plans', { name: '弱项契约测试' });
    const planId = created.body.plan.id;
    const topics = await request('POST', `/api/learn/plans/${planId}/topics`, { titles: ['线程同步'] });
    const topicId = topics.body.plan.topics[0].id;

    const first = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/weak-points`, { point: '条件变量' });
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, true);

    const duplicate = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/weak-points`, { point: '条件变量' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.changed, false);

    const missing = await request('POST', `/api/learn/plans/${planId}/topics/missing-topic/weak-points`, { point: '条件变量' });
    assert.equal(missing.status, 404);

    const stored = await request('GET', `/api/learn/plans/${planId}`);
    assert.deepEqual(stored.body.plan.topics[0].weakPoints, ['条件变量']);
  });

  it('waits for batch deletion before responding', async () => {
    const first = await request('POST', '/api/learn/plans', { name: '批量删除集成测试 1' });
    const second = await request('POST', '/api/learn/plans', { name: '批量删除集成测试 2' });
    const ids = [first.body.plan.id, second.body.plan.id];

    const res = await request('POST', '/api/learn/plans/batch-delete', { ids });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, deleted: 2 });

    for (const id of ids) {
      const plan = await request('GET', `/api/learn/plans/${id}`);
      assert.equal(plan.status, 404);
    }
  });
});
