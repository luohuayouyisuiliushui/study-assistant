#!/usr/bin/env node
/**
 * Data integrity self-check script.
 * Scans server/data/learn/ for consistency issues:
 *   - Orphaned plan files (on disk but not in index)
 *   - Missing plan files (in index but not on disk)
 *   - Corrupt JSON files
 *   - Orphaned .tmp files from crashed processes
 *   - Backup file integrity
 *
 * Usage: node server/scripts/check-data-integrity.js [--fix]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'learn');
const PLANS_INDEX = path.join(DATA, 'plans.json');
const PLANS_DIR = path.join(DATA, 'plans');
const BACKUP_DIR = path.join(DATA, '.backups-v2');

const shouldFix = process.argv.includes('--fix');
let issuesFound = 0;

function log(level, msg) {
  const prefix = { info: '  ', warn: '⚠ ', error: '✗ ', ok: '✓ ', fix: '🔧' }[level] || '  ';
  console.log(`${prefix} ${msg}`);
  if (level === 'error' || level === 'warn') issuesFound++;
}

// ─── 1. Check plans.json index ───
console.log('\n📋 Checking plans index...');

let index = [];
try {
  if (fs.existsSync(PLANS_INDEX)) {
    const raw = fs.readFileSync(PLANS_INDEX, 'utf-8');
    try {
      index = JSON.parse(raw);
      if (!Array.isArray(index)) {
        log('error', 'plans.json is not an array');
        index = [];
      }
    } catch (e) {
      log('error', `plans.json is corrupt: ${e.message}`);
      if (shouldFix) {
        const bak = PLANS_INDEX + '.bak';
        if (fs.existsSync(bak)) {
          try {
            index = JSON.parse(fs.readFileSync(bak, 'utf-8'));
            fs.writeFileSync(PLANS_INDEX, JSON.stringify(index, null, 2), 'utf-8');
            log('fix', 'Restored plans.json from .bak');
          } catch {
            log('error', '.bak is also corrupt');
            index = [];
          }
        }
      }
    }
  } else {
    log('warn', 'plans.json does not exist');
  }
} catch (e) {
  log('error', `Cannot read plans.json: ${e.message}`);
}

// ─── 2. Check plan files ───
console.log('\n📁 Checking plan files...');

const diskPlanIds = new Set();
if (fs.existsSync(PLANS_DIR)) {
  const files = fs.readdirSync(PLANS_DIR);
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.bak') || f.includes('.tmp.')) continue;
    const filePath = path.join(PLANS_DIR, f);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const plan = JSON.parse(raw);
      if (!plan.id || !plan.name) {
        log('error', `Plan file missing id/name: ${f}`);
        continue;
      }
      diskPlanIds.add(plan.id);

      // Check for corrupt nested structures
      if (!Array.isArray(plan.topics)) log('warn', `${plan.name}: topics is not an array`);

      // Check backup status
      const bakPath = filePath + '.bak';
      const v2Path = path.join(BACKUP_DIR, plan.id + '.json');
      const hasBak = fs.existsSync(bakPath);
      const hasV2 = fs.existsSync(v2Path);
      if (!hasBak && !hasV2) {
        log('info', `${plan.name}: no backups exist (will be created on next write)`);
      }

    } catch (e) {
      log('error', `Cannot parse ${f}: ${e.message}`);

      if (shouldFix) {
        const bakPath = filePath + '.bak';
        if (fs.existsSync(bakPath)) {
          try {
            const bakData = fs.readFileSync(bakPath, 'utf-8');
            const plan = JSON.parse(bakData);
            fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
            log('fix', `Restored ${f} from .bak`);
            if (plan.id) diskPlanIds.add(plan.id);
          } catch {
            log('error', `.bak for ${f} is also corrupt`);
            // Try .backups-v2
            const planId = path.basename(f, '.json');
            const v2Path = path.join(BACKUP_DIR, planId + '.json');
            if (fs.existsSync(v2Path)) {
              try {
                const v2Data = fs.readFileSync(v2Path, 'utf-8');
                const plan = JSON.parse(v2Data);
                fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
                log('fix', `Restored ${f} from .backups-v2`);
                if (plan.id) diskPlanIds.add(plan.id);
              } catch {
                log('error', `.backups-v2 for ${f} is also corrupt — data may be lost`);
              }
            }
          }
        }
      }
    }
  }
} else {
  log('warn', `${PLANS_DIR} does not exist`);
}

// ─── 3. Index-consistency check ───
console.log('\n🔗 Checking index consistency...');

const indexIds = new Set(index.map(e => e.id));

// Orphaned files (on disk, not in index)
for (const id of diskPlanIds) {
  if (!indexIds.has(id)) {
    log('warn', `Orphaned plan file: ${id} (on disk, not in index)`);
    if (shouldFix) {
      const plan = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, `${id}.json`), 'utf-8'));
      index.push({
        id: plan.id,
        name: plan.name,
        createdAt: plan.createdAt || Date.now(),
        updatedAt: plan.updatedAt || Date.now(),
        topicCount: plan.topics?.length || 0,
      });
      log('fix', `Added ${plan.name} to index`);
    }
  }
}

// Missing files (in index, not on disk)
for (const entry of index) {
  if (!diskPlanIds.has(entry.id)) {
    log('warn', `Missing plan file: ${entry.id} (${entry.name}) — in index but not on disk`);
    if (shouldFix) {
      index = index.filter(e => e.id !== entry.id);
      log('fix', `Removed ${entry.name} from index`);
    }
  }
}

if (shouldFix) {
  fs.writeFileSync(PLANS_INDEX, JSON.stringify(index, null, 2), 'utf-8');
}

// ─── 4. Check for orphaned .tmp files ───
console.log('\n🧹 Checking for orphaned temp files...');

if (fs.existsSync(PLANS_DIR)) {
  for (const f of fs.readdirSync(PLANS_DIR)) {
    if (f.includes('.tmp.')) {
      const age = Date.now() - fs.statSync(path.join(PLANS_DIR, f)).mtimeMs;
      if (age > 10_000) {
        log('warn', `Orphaned temp file: ${f} (age: ${Math.round(age / 1000)}s)`);
        if (shouldFix) {
          fs.unlinkSync(path.join(PLANS_DIR, f));
          log('fix', `Deleted ${f}`);
        }
      }
    }
  }
}

// ─── 5. Check backup integrity ───
console.log('\n💾 Checking backup integrity...');

if (fs.existsSync(BACKUP_DIR)) {
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf-8'));
    } catch (e) {
      log('error', `Corrupt backup: ${f}`);
    }
  }
}

// ─── Summary ───
console.log('\n═══════════════════════════════');
if (issuesFound === 0) {
  console.log('✅ All checks passed!');
} else {
  console.log(`⚠ ${issuesFound} issue(s) found.${shouldFix ? ' Attempted fixes applied.' : ' Run with --fix to repair.'}`);
}
console.log('═══════════════════════════════\n');
