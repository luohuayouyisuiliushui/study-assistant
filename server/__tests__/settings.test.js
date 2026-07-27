import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let server;
let tempDir;
let previousEnvPath;

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path: url,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('settings route', () => {
  before(async () => {
    previousEnvPath = process.env.STUDY_ASSISTANT_ENV_LOCAL_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-assistant-settings-'));
    process.env.STUDY_ASSISTANT_ENV_LOCAL_PATH = path.join(tempDir, '.env.local');

    const express = (await import('express')).default;
    const router = (await import('../routes/settings.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/settings', router);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousEnvPath === undefined) delete process.env.STUDY_ASSISTANT_ENV_LOCAL_PATH;
    else process.env.STUDY_ASSISTANT_ENV_LOCAL_PATH = previousEnvPath;
  });

  it('reports a missing isolated settings file', async () => {
    const res = await request('GET', '/api/settings/env-key');
    assert.deepEqual(res.body, { exists: false, keySet: false });
  });

  it('writes valid settings only to the isolated file', async () => {
    const res = await request('POST', '/api/settings/env-key', {
      apiKey: 'sk-test123', baseURL: 'https://test.example.com/v1', model: 'gpt-4',
    });
    assert.equal(res.status, 200);
    const content = fs.readFileSync(process.env.STUDY_ASSISTANT_ENV_LOCAL_PATH, 'utf8');
    assert.match(content, /^OPENAI_API_KEY=sk-test123/m);
    assert.match(content, /^OPENAI_BASE_URL=https:\/\/test.example.com\/v1/m);
  });

  it('rejects newline injection into environment values', async () => {
    const res = await request('POST', '/api/settings/env-key', {
      apiKey: 'sk-safe\nOPENAI_MODEL=attacker',
    });
    assert.equal(res.status, 400);
  });
});
