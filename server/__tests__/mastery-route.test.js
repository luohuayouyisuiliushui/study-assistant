import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BASE = Date.UTC(2026, 0, 1, 8);
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
      path: `${url.pathname}${url.search}`,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const helper = new URL('./helpers/isolated-learn-server.js', import.meta.url);
    serverProcess = fork(helper, [], {
      env: { ...process.env, STUDY_ASSISTANT_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timeout = setTimeout(() => reject(new Error('Timed out starting isolated server')), 10_000);
    const finish = callback => value => {
      clearTimeout(timeout);
      serverProcess.removeAllListeners('message');
      serverProcess.removeAllListeners('error');
      callback(value);
    };
    serverProcess.once('message', finish(message => {
      if (message?.error) reject(new Error(message.error));
      else resolve(`http://127.0.0.1:${message.port}`);
    }));
    serverProcess.once('error', finish(reject));
  });
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.killed) return;
  await new Promise(resolve => {
    serverProcess.once('exit', resolve);
    serverProcess.kill();
  });
}

describe('Mastery HTTP API', () => {
  before(async () => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-assistant-mastery-route-'));
    baseUrl = await startServer(tempDataDir);
  });

  after(async () => {
    await stopServer();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('persists the review loop and backup across a process restart', async () => {
    const created = await request('POST', '/api/learn/plans', { name: 'Mastery API' });
    const planId = created.body.plan.id;
    const added = await request('POST', `/api/learn/plans/${planId}/topics`, { titles: ['TCP'] });
    const topicId = added.body.plan.topics[0].id;
    await request('PUT', `/api/learn/plans/${planId}/topics/${topicId}`, { done: true });

    const queue = await request('GET', `/api/learn/today-review?budgetMinutes=30&now=${BASE}`);
    assert.equal(queue.status, 200);
    assert.equal(queue.body.queue.items.length, 1);
    assert.equal(queue.body.queue.items[0].topicId, topicId);
    assert.equal(queue.body.queue.items[0].reason, 'due-review');

    const questions = [
      { id: 'q1', prompt: 'TCP 是什么？', expectedAnswer: '传输控制协议', conceptKey: 'TCP' },
      { id: 'q2', prompt: '可靠传输？', expectedAnswer: '是', conceptKey: 'TCP' },
    ];
    const session = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/review-session`, {
      sessionId: 'route-session', createdAt: BASE, questions,
    });
    assert.equal(session.status, 200);
    assert.equal(session.body.resumed, false);
    assert.equal(Object.hasOwn(session.body.session.questions[0], 'expectedAnswer'), false);

    const resumed = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/review-session`, {
      sessionId: 'replacement', createdAt: BASE + 1,
      questions: [{ id: 'other', prompt: 'other', expectedAnswer: 'other' }],
    });
    assert.equal(resumed.body.resumed, true);
    assert.equal(resumed.body.session.id, 'route-session');

    const mismatch = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/review-session/submit`, {
      sessionId: 'wrong',
      answers: questions.map(question => ({ questionId: question.id, answer: question.expectedAnswer })),
      submittedAt: BASE + 1000,
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, 'SESSION_MISMATCH');

    const submitted = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/review-session/submit`, {
      sessionId: 'route-session',
      answers: [
        { questionId: 'q1', answer: '传输控制协议' },
        { questionId: 'q2', answer: '否' },
      ],
      submittedAt: BASE + 1000,
    });
    assert.equal(submitted.status, 200);
    assert.deepEqual(submitted.body.results.map(result => result.correct), [true, false]);
    assert.equal(submitted.body.state.topic.masteryEvidence.length, 2);
    assert.equal(submitted.body.state.topic.mistakeRecords[0].status, 'open');

    const backupResponse = await request('GET', `/api/learn/mastery/backup?now=${BASE + 2000}`);
    assert.equal(backupResponse.status, 200);
    const backup = backupResponse.body.backup;
    const preview = await request('POST', '/api/learn/mastery/restore/preview', { backup });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.valid, true);
    assert.equal(preview.body.preview.counts.sessions, 1);

    const deferred = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/review/defer`, {
      until: BASE + 7 * 24 * 60 * 60 * 1000, now: BASE + 2000,
    });
    assert.equal(deferred.status, 200);
    const restored = await request('POST', '/api/learn/mastery/restore', { backup, confirm: true });
    assert.equal(restored.status, 200);

    await stopServer();
    baseUrl = await startServer(tempDataDir);
    const state = await request('GET', `/api/learn/plans/${planId}/topics/${topicId}/mastery?now=${BASE + 3000}`);
    assert.equal(state.status, 200);
    assert.equal(state.body.state.topic.reviewSession.status, 'completed');
    assert.equal(state.body.state.topic.reviewSchedule.dueAt, BASE + 24 * 60 * 60 * 1000 + 1000);
    assert.equal(deferred.body.state.topic.reviewSchedule.dueAt > state.body.state.topic.reviewSchedule.dueAt, true);
  });

  it('validates queue budgets, restore confirmation, and Plan ids', async () => {
    const budget = await request('GET', '/api/learn/today-review?budgetMinutes=9');
    assert.equal(budget.status, 400);

    const restore = await request('POST', '/api/learn/mastery/restore', { backup: {}, confirm: false });
    assert.equal(restore.status, 400);

    const invalidPlan = await request('GET', '/api/learn/plans/invalid%24id/topics/topic/mastery');
    assert.equal(invalidPlan.status, 400);

    const created = await request('POST', '/api/learn/plans', { name: 'No fake repair' });
    const planId = created.body.plan.id;
    const added = await request('POST', `/api/learn/plans/${planId}/topics`, { titles: ['TCP'] });
    const topicId = added.body.plan.topics[0].id;
    const fakeRepair = await request('POST', `/api/learn/plans/${planId}/topics/${topicId}/review-session`, {
      kind: 'mistake-repair', conceptKey: 'tcp',
      questions: [{ id: 'fake', prompt: 'Fake?', expectedAnswer: 'yes' }],
    });
    assert.equal(fakeRepair.status, 400);
  });

  it('threads the selected daily budget into mastery metrics', async () => {
    const created = await request('POST', '/api/learn/plans', { name: 'Metrics budget' });
    const planId = created.body.plan.id;
    const added = await request('POST', `/api/learn/plans/${planId}/topics`, {
      titles: ['Budget one', 'Budget two'],
    });
    for (const [index, topic] of added.body.plan.topics.entries()) {
      await request('POST', `/api/learn/plans/${planId}/topics/${topic.id}/mastery/evidence`, {
        source: 'Exercise', sourceRef: `metrics-${index}`, sessionId: `metrics-session-${index}`,
        occurredAt: BASE, correct: false, confidence: 1,
        gradingMethod: 'deterministic', conceptKey: topic.title,
      });
    }

    const constrained = await request('GET', `/api/learn/mastery/metrics?now=${BASE}&budgetMinutes=10`);
    const spacious = await request('GET', `/api/learn/mastery/metrics?now=${BASE}&budgetMinutes=120`);
    assert.equal(constrained.status, 200);
    assert.equal(spacious.status, 200);
    assert.ok(constrained.body.metrics.budgetOverrunCount > spacious.body.metrics.budgetOverrunCount);
  });

  it('matches repair-session concept keys using domain normalization', async () => {
    const created = await request('POST', '/api/learn/plans', { name: 'Normalized mistake lookup' });
    const planId = created.body.plan.id;
    const added = await request('POST', `/api/learn/plans/${planId}/topics`, { titles: ['TCP'] });
    const topicId = added.body.plan.topics[0].id;
    const evidence = await request(
      'POST',
      `/api/learn/plans/${planId}/topics/${topicId}/mastery/evidence`,
      {
        source: 'Exercise',
        sourceRef: 'normalized-mistake:1',
        sessionId: 'normalized-mistake-session',
        occurredAt: BASE,
        correct: false,
        confidence: 1,
        gradingMethod: 'deterministic',
        conceptKey: 'TCP  Handshake',
      },
    );
    assert.equal(evidence.status, 201);

    const repair = await request(
      'POST',
      `/api/learn/plans/${planId}/topics/${topicId}/mistakes/tcp_handshake/repair-session`,
      { sessionId: 'normalized-repair-session', createdAt: BASE + 1 },
    );
    assert.equal(repair.status, 200);
    assert.equal(repair.body.session.kind, 'mistake-repair');
    assert.equal(repair.body.session.targetConceptKey, 'tcp handshake');
    assert.deepEqual(repair.body.session.questions.map(question => question.conceptKey), ['tcp handshake']);
  });
});
