import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL_PATH = path.join(__dirname, '..', '.env.local');
const BACKUP_PATH = ENV_LOCAL_PATH + '.test.bak';

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path: url,
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

describe('settings route — .env.local', () => {
  let server;

  before(async () => {
    // Backup existing .env.local if it exists
    if (fs.existsSync(ENV_LOCAL_PATH)) {
      fs.copyFileSync(ENV_LOCAL_PATH, BACKUP_PATH);
      fs.unlinkSync(ENV_LOCAL_PATH);
    }
    const express = (await import('express')).default;
    const router = (await import('../routes/settings.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/settings', router);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
  });

  after(() => {
    server.close();
    // Restore backup
    if (fs.existsSync(BACKUP_PATH)) {
      if (fs.existsSync(ENV_LOCAL_PATH)) fs.unlinkSync(ENV_LOCAL_PATH);
      fs.copyFileSync(BACKUP_PATH, ENV_LOCAL_PATH);
      fs.unlinkSync(BACKUP_PATH);
    } else if (fs.existsSync(ENV_LOCAL_PATH)) {
      fs.unlinkSync(ENV_LOCAL_PATH);
    }
  });

  it('GET /api/settings/env-key — returns { exists: false } when no file', async () => {
    const res = await request(server, 'GET', '/api/settings/env-key');
    assert.equal(res.status, 200);
    assert.equal(res.body.exists, false);
    assert.equal(res.body.keySet, false);
  });

  it('POST /api/settings/env-key — rejects empty apiKey', async () => {
    const res = await request(server, 'POST', '/api/settings/env-key', {});
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('POST /api/settings/env-key — writes key and returns success', async () => {
    const res = await request(server, 'POST', '/api/settings/env-key', {
      apiKey: 'sk-test123',
      baseURL: 'https://test.example.com/v1',
      model: 'gpt-4',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const content = fs.readFileSync(ENV_LOCAL_PATH, 'utf-8');
    assert.ok(content.includes('OPENAI_API_KEY=sk-test123'));
    assert.ok(content.includes('OPENAI_BASE_URL=https://test.example.com/v1'));
    assert.ok(content.includes('OPENAI_MODEL=gpt-4'));
  });

  it('GET /api/settings/env-key — returns { exists: true, keySet: true } after write', async () => {
    const res = await request(server, 'GET', '/api/settings/env-key');
    assert.equal(res.status, 200);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.keySet, true);
  });

  it('POST /api/settings/env-key — overwrites existing file', async () => {
    const res = await request(server, 'POST', '/api/settings/env-key', {
      apiKey: 'sk-overwrite',
    });
    assert.equal(res.status, 200);
    const content = fs.readFileSync(ENV_LOCAL_PATH, 'utf-8');
    assert.ok(content.includes('OPENAI_API_KEY=sk-overwrite'));
    assert.equal(content.includes('sk-test123'), false);
  });
});
