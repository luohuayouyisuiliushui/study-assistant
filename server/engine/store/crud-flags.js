/**
 * Flag management — study-trace pending-checkin pattern.
 *
 * Flag files signal that a plan has been updated, so AI can check which
 * plans have new data.
 */

import fs from 'fs';
import path from 'path';
import { DATA } from './storage.js';

const FLAG_DIR = path.join(DATA, 'flags');
function ensureFlagDir() { fs.mkdirSync(FLAG_DIR, { recursive: true }); }
ensureFlagDir();

/**
 * Write a flag file to signal that a plan has been updated.
 * AI can check for flag files to know which plans have new data.
 */
export function writeFlag(planId) {
  try {
    fs.writeFileSync(
      path.join(FLAG_DIR, `${planId}.flag`),
      JSON.stringify({ planId, timestamp: Date.now() }),
      'utf-8'
    );
  } catch { /* best effort */ }
}

/**
 * Read all pending flag files and return their plan IDs.
 */
export function readFlags() {
  try {
    ensureFlagDir();
    return fs.readdirSync(FLAG_DIR)
      .filter(f => f.endsWith('.flag'))
      .map(f => f.replace('.flag', ''));
  } catch { return []; }
}

/**
 * Clear a flag after it has been consumed.
 */
export function clearFlag(planId) {
  try {
    const f = path.join(FLAG_DIR, `${planId}.flag`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}
