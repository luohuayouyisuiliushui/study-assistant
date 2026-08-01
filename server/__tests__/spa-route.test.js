import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(new URL('../index.js', import.meta.url)));

function request(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: route }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await request(port, '/');
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for server');
}

describe('production SPA fallback', () => {
  let child;
  let dataDir;
  let port;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-assistant-spa-'));
    port = await reservePort();
    child = spawn(process.execPath, ['index.js'], {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(port),
        STUDY_ASSISTANT_DATA_DIR: dataDir,
      },
      stdio: 'ignore',
    });
    await waitForServer(port, child);
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves index.html for a plan deep link from a dot-directory checkout', async () => {
    const response = await request(port, '/plan/example/topic/example?practice=1');

    assert.equal(response.status, 200);
    assert.match(response.body, /<div id="root"><\/div>/);
  });
});
