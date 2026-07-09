import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = 'http://localhost:3001';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: 'localhost',
      port: 3001,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Route Integration (requires running server)', () => {
  let serverRunning = false;

  before(async () => {
    try {
      await request('GET', '/api/learn/plans');
      serverRunning = true;
    } catch {
      console.log('⚠ Server not running — skipping route integration tests');
    }
  });

  it('GET /api/learn/plans should return plans array', async () => {
    if (!serverRunning) return;
    const res = await request('GET', '/api/learn/plans');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.plans));
  });

  it('GET /api/learn/trash should return plans array', async () => {
    if (!serverRunning) return;
    const res = await request('GET', '/api/learn/trash');
    assert.equal(res.status, 200);
    // trash endpoint returns {plans: [...]}
    assert.ok(Array.isArray(res.body.plans));
  });

  it('GET /api/user-profile should return profile or 404', async () => {
    if (!serverRunning) return;
    const res = await request('GET', '/api/user-profile');
    assert.ok([200, 404].includes(res.status));
  });

  it('POST /api/learn/plans with invalid body should return 400', async () => {
    if (!serverRunning) return;
    const res = await request('POST', '/api/learn/plans', { name: '' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('POST /api/learn/plans should create a plan and return it', async () => {
    if (!serverRunning) return;
    const res = await request('POST', '/api/learn/plans', { name: '集成测试计划' });
    assert.equal(res.status, 200);
    assert.ok(res.body.plan);
    assert.ok(res.body.plan.id);
    assert.equal(res.body.plan.name, '集成测试计划');
    await request('DELETE', `/api/learn/plans/${res.body.plan.id}`);
  });

  it('GET /api/learn/plans/:id with non-existent id should return 404', async () => {
    if (!serverRunning) return;
    const res = await request('GET', '/api/learn/plans/non-existent-id');
    assert.equal(res.status, 404);
  });

  it('POST /api/learn/plans/batch-delete with empty ids should return 400', async () => {
    if (!serverRunning) return;
    const res = await request('POST', '/api/learn/plans/batch-delete', { ids: [] });
    assert.equal(res.status, 400);
  });

  it('GET /api/learn/plans/:planId/exams should return exams array', async () => {
    if (!serverRunning) return;
    const createRes = await request('POST', '/api/learn/plans', { name: '试卷测试计划' });
    const planId = createRes.body.plan.id;
    const res = await request('GET', `/api/learn/plans/${planId}/exams`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.exams));
    await request('DELETE', `/api/learn/plans/${planId}`);
  });
});
