/**
 * Data model & persistence for the learning assistant.
 *
 * Structure:
 *   data/learn/
 *     plans.json              — index of all plans
 *     plans/{planId}.json     — plan with topics + learning history
 *
 * Atomic writes: all file writes go through writeAtomic() which uses
 * temp-file + rename to prevent corruption on crash.
 *
 * Per-plan serialization: writes to the same plan are queued to prevent
 * read-modify-write races.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'learn');
const PLANS_INDEX = path.join(DATA, 'plans.json');
const TRASH_DIR = path.join(DATA, 'trash');
const TRASH_INDEX = path.join(TRASH_DIR, 'index.json');
const TRASH_TTL_DAYS = 30;

function ensureDir() {
  fs.mkdirSync(path.join(DATA, 'plans'), { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}
ensureDir();

// ─── Atomic write ───

function writeAtomic(filePath, data, { backup } = {}) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
  // 写入成功后备份（study-trace 模式：损坏可恢复）
  if (backup) {
    const bakPath = filePath + '.bak';
    try {
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
      fs.copyFileSync(filePath, bakPath);
    } catch (bakErr) {
      console.warn(`[learn-store] Backup write failed: ${bakPath}`, bakErr.message);
    }
  }
}

// ─── Per-plan write queue (serializes concurrent writes to same plan) ───

const writeQueues = new Map(); // planId → Promise chain

function enqueueWrite(planId, fn) {
  if (!writeQueues.has(planId)) {
    writeQueues.set(planId, Promise.resolve());
  }
  const prev = writeQueues.get(planId);
  const next = prev.then(fn, fn);
  writeQueues.set(planId, next);
  return next;
}

// ─── JSON safe read (with encoding resilience) ───

/**
 * Read a JSON file safely with fallback for GBK/ANSI-encoded files.
 * Node.js 'utf-8' strips BOM normally, but if a file was manually
 * saved in Windows ANSI (GBK), we try GBK as a fallback.
 */
function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    let raw = fs.readFileSync(filePath, 'utf-8');
    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      // If utf-8 parse fails, try raw bytes as GBK (Windows ANSI fallback)
      console.warn(`[learn-store] UTF-8 parse failed for ${filePath}, trying GBK: ${parseErr.message}`);
      try {
        const rawBuf = fs.readFileSync(filePath);
        return JSON.parse(new TextDecoder('gbk').decode(rawBuf));
      } catch (gbkErr) {
        console.warn(`[learn-store] GBK fallback also failed for ${filePath}: ${gbkErr.message}`);
        throw parseErr; // re-throw original so outer catch can attempt backup recovery
      }
    }
  } catch (err) {
    console.warn(`[learn-store] JSON parse error: ${filePath}`, err.message);
    // 尝试从备份恢复（study-trace 模式：损坏自动恢复）
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
        console.warn(`[learn-store] Recovered from backup: ${bakPath}`);
        // 自动修复损坏的文件
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return data;
      } catch (bakErr) {
        console.warn(`[learn-store] Backup also corrupt: ${bakPath}`, bakErr.message);
      }
    }
    return null;
  }
}

// ─── Index ───

function readIndex() {
  return readJSON(PLANS_INDEX) || [];
}

function writeIndex(index) {
  writeAtomic(PLANS_INDEX, JSON.stringify(index, null, 2), { backup: true });
}

function updateIndex(planId, updates) {
  const index = readIndex();
  const entry = index.find(e => e.id === planId);
  if (entry) Object.assign(entry, updates);
  writeIndex(index);
}

// ─── Paths ───

function planPath(id) {
  return path.join(DATA, 'plans', `${id}.json`);
}

// ─── Public API ───
