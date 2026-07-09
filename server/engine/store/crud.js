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
// crud.js lives in store/ subdirectory, need two levels up to reach server/
const DATA = path.join(__dirname, '..', '..', 'data', 'learn');
const PLANS_INDEX = path.join(DATA, 'plans.json');
const TRASH_DIR = path.join(DATA, 'trash');
const TRASH_INDEX = path.join(TRASH_DIR, 'index.json');
const TRASH_TTL_DAYS = 30;
const BACKUP_DIR = path.join(DATA, '.backups-v2');

function ensureDir() {
  fs.mkdirSync(path.join(DATA, 'plans'), { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
ensureDir();

// ─── Atomic write ───

function writeAtomic(filePath, data, { backup } = {}) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (renameErr) {
    // Windows EPERM / 跨设备链接失败 → 降级为复制+删除
    try {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);  // 复制成功后删除临时文件
    } catch (copyErr) {
      // 若复制也失败，保留 tmp 文件并抛出错误，由上层重试
      console.error(`Atomic write fallback failed for ${filePath}:`, copyErr);
      throw new Error(`CRITICAL: Data write failed, temp file preserved at ${tmp}`);
    }
  }
  if (backup) {
    // 1. 同目录 .bak（快速恢复）
    const bakPath = filePath + '.bak';
    try {
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
      fs.copyFileSync(filePath, bakPath);
    } catch (bakErr) {
      console.warn(`[learn-store] .bak backup failed: ${bakPath}`, bakErr.message);
    }
    // 2. 独立备份目录 .backups-v2/（防止主目录误清）
    try {
      const planId = path.basename(filePath, '.json');
      if (planId && planId.length > 0) {
        const backupFile = path.join(BACKUP_DIR, planId + '.json');
        if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
        fs.copyFileSync(filePath, backupFile);
      }
    } catch (v2Err) {
      console.warn(`[learn-store] .backups-v2 backup failed: ${filePath}`, v2Err.message);
    }
  }
}

// ─── Per-plan write queue (serializes concurrent writes to same plan) ───

const writeQueues = new Map(); // planId → Promise chain

function enqueueWrite(planId, fn) {
  // 僵尸防护：plan 文件已删除但 Map 条目还在，拒绝写入让 Promise 自然结束
  if (!fs.existsSync(planPath(planId))) {
    return Promise.reject(new Error(`Plan not found: ${planId}`));
  }
  if (!writeQueues.has(planId)) {
    writeQueues.set(planId, Promise.resolve());
  }
  const prev = writeQueues.get(planId);
  const next = prev.then(fn, fn);
  writeQueues.set(planId, next);
  // settle 后替换为新 Promise.resolve()，防止链无限增长
  next.then(
    () => { if (writeQueues.get(planId) === next) writeQueues.set(planId, Promise.resolve()); },
    () => { if (writeQueues.get(planId) === next) writeQueues.set(planId, Promise.resolve()); },
  );
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
    // 尝试从 .bak 恢复
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
        console.warn(`[learn-store] Recovered from .bak: ${bakPath}`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return data;
      } catch (bakErr) {
        console.warn(`[learn-store] .bak also corrupt: ${bakPath}`, bakErr.message);
      }
    }
    // 尝试从独立备份目录 .backups-v2/ 恢复
    try {
      const planId = path.basename(filePath, '.json');
      const v2File = path.join(BACKUP_DIR, planId + '.json');
      if (fs.existsSync(v2File)) {
        const data = JSON.parse(fs.readFileSync(v2File, 'utf-8'));
        console.warn(`[learn-store] Recovered from .backups-v2: ${v2File}`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return data;
      }
    } catch (v2Err) {
      console.warn(`[learn-store] .backups-v2 recovery failed: ${filePath}`, v2Err.message);
    }
    return null;
  }
}

// ─── Index ───

function readIndex() {
  const idx = readJSON(PLANS_INDEX);
  if (idx && idx.length > 0) {
    // 防御性去重：防止历史遗留的重复条目影响运行
    const seen = new Set();
    return idx.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }
  // 索引为空或缺失 → 从 plans/ 重建
  return rebuildIndex();
}

function rebuildIndex() {
  try {
    const plansDir = path.join(DATA, 'plans');
    if (!fs.existsSync(plansDir)) return [];
    const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.json') && !f.endsWith('.bak') && !f.includes('.tmp.'));
    if (files.length === 0) return [];
    const index = [];
    for (const f of files) {
      try {
        const plan = readJSON(path.join(plansDir, f));
        if (plan && plan.id && plan.name) {
          index.push({
            id: plan.id,
            name: plan.name,
            createdAt: plan.createdAt || Date.now(),
            updatedAt: plan.updatedAt || Date.now(),
            topicCount: plan.topics?.length || 0,
          });
        }
      } catch {}
    }
    if (index.length > 0) {
      writeAtomic(PLANS_INDEX, JSON.stringify(index, null, 2), { backup: true });
      console.log(`[learn-store] 🔄 Rebuilt index from ${files.length} plan files → ${index.length} entries`);
    }
    return index;
  } catch (err) {
    console.warn('[learn-store] Index rebuild failed:', err.message);
    return [];
  }
}

function writeIndex(index) {
  writeAtomic(PLANS_INDEX, JSON.stringify(index, null, 2), { backup: true });
}

function updateIndex(planId, updates) {
  let index = readIndex();
  // 按 ID 去重：保留第一个匹配的条目，移除其余重复
  const seen = new Set();
  index = index.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  const entry = index.find(e => e.id === planId);
  if (entry) Object.assign(entry, updates);
  writeIndex(index);
}

// ─── Paths ───

function planPath(id) {
  return path.join(DATA, 'plans', `${id}.json`);
}

// ─── Public API ───

export function listPlans() {
  return readIndex().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getPlan(planId) {
  return readJSON(planPath(planId));
}

export function createPlan(name) {
  const id = uuidv4();
  const plan = {
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    topics: [],
    phases: [],
    history: [],
  };
  // Write plan file first, then index (if crash between, orphan file is harmless)
  writeAtomic(planPath(id), JSON.stringify(plan, null, 2));
  const index = readIndex();
  index.push({ id, name, createdAt: plan.createdAt, updatedAt: plan.updatedAt, topicCount: 0 });
  writeIndex(index);
  return plan;
}

// ─── Trash / Recycle Bin ───

export async function deletePlan(planId) {
  await trashPlan(planId);
}

/**
 * Permanently delete a plan — removes the file, removes from index, skips trash.
 * Also cleans up any trash entry for the same plan ID.
 */
export async function permanentlyDeletePlan(planId) {
  // 先等待队列清空，再删除（和 trashPlan 保持一致）
  const queue = writeQueues.get(planId);
  if (queue) {
    try { await queue; } catch { /* ignore — we're deleting anyway */ }
  }
  writeQueues.delete(planId);

  // Delete plan file from plans/
  const src = planPath(planId);
  try {
    if (fs.existsSync(src)) fs.unlinkSync(src);
  } catch (err) {
    console.warn(`[learn-store] Failed to delete plan file: ${err.message}`);
  }

  // Delete .tmp files
  try {
    const dir = path.dirname(src);
    const prefix = path.basename(src);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix + '.tmp')) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}

  // Delete backup file if exists
  try {
    const bak = src + '.bak';
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  } catch {}

  // Remove from active index
  const index = readIndex().filter(e => e.id !== planId);
  writeIndex(index);

  // Also remove from trash if present
  const trashFile = findTrashFile(planId);
  if (trashFile) {
    try { fs.unlinkSync(trashFile); } catch {}
  }
  const trashIndex = readTrashIndex().filter(e => e.id !== planId);
  writeTrashIndex(trashIndex);
}

/**
 * Batch-delete multiple plans permanently by their IDs.
 */
export async function deletePlansByIds(planIds) {
  for (const id of planIds) {
    await permanentlyDeletePlan(id);
  }
}

/**
 * Move a plan to the recycle bin instead of permanent deletion.
 * The plan file is moved to the trash directory; the index entry is removed.
 * Plans with rich learning data (history, detail, exercises) are flagged so
 * the data file is preserved even after the 30-day auto-cleanup.
 */
export async function trashPlan(planId) {
  // Drain pending writes before moving to trash — otherwise hasData
  // check reads a stale file (writes are queued as promise microtasks).
  const queue = writeQueues.get(planId);
  if (queue) {
    try { await queue; } catch { /* ignore queue errors — we're deleting anyway */ }
  }
  writeQueues.delete(planId);
  const src = planPath(planId);
  if (!fs.existsSync(src)) {
    // Plan file may already be gone — just remove from index
    const index = readIndex().filter(e => e.id !== planId);
    writeIndex(index);
    return;
  }

  // Read the plan to assess data richness
  let plan = null;
  let hasData = false;
  try {
    plan = JSON.parse(fs.readFileSync(src, 'utf-8'));
    if (plan) {
      const hasDetail = plan.topics && plan.topics.some(t => t.detail);
      const hasHistory = plan.history && plan.history.length > 0;
      const hasExercises = plan.topics && plan.topics.some(t => t.exercises && t.exercises.length > 0);
      hasData = hasDetail || hasHistory || hasExercises;
    }
  } catch { /* best-effort read */ }

  // Move plan file to trash directory
  const dest = path.join(TRASH_DIR, `${planId}.json`);
  try {
    // If dest exists already, append timestamp to avoid collision
    const finalDest = fs.existsSync(dest)
      ? path.join(TRASH_DIR, `${planId}_${Date.now()}.json`)
      : dest;
    fs.renameSync(src, finalDest);
  } catch (err) {
    // 不降级删除 — rename 失败时保留原文件，抛出让用户知道删除未完成
    throw new Error(`移动到回收站失败: ${err.message}`);
  }

  // Remove .tmp files
  try {
    const dir = path.dirname(src);
    const prefix = path.basename(src);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix + '.tmp')) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}

  // Remove from active index
  const index = readIndex().filter(e => e.id !== planId);
  writeIndex(index);

  // Add to trash index
  const now = Date.now();
  const trashEntry = {
    id: planId,
    name: plan?.name || '未知计划',
    topicCount: plan?.topics?.length || 0,
    deletedAt: now,
    expiresAt: now + TRASH_TTL_DAYS * 24 * 60 * 60 * 1000,
    hasData,
  };
  const trashIndex = readTrashIndex();
  trashIndex.push(trashEntry);
  writeTrashIndex(trashIndex);
}

/**
 * Read the trash index (sorted by deletion time, newest first).
 */
export function listTrash() {
  return readTrashIndex().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

/**
 * Restore a plan from the recycle bin back to active plans.
 */
export function restorePlan(planId) {
  const trashIndex = readTrashIndex();
  const entry = trashIndex.find(e => e.id === planId);
  if (!entry) throw new Error(`回收站中未找到计划: ${planId}`);

  // Move file back
  const trashFile = findTrashFile(planId);
  if (trashFile) {
    try {
      fs.renameSync(trashFile, planPath(planId));
    } catch (err) {
      throw new Error(`恢复计划文件失败: ${err.message}`);
    }
  }

  // Re-add to active index — read plan to get current topicCount
  const plan = getPlan(planId);
  if (plan) {
    const index = readIndex();
    index.push({
      id: plan.id,
      name: plan.name,
      createdAt: plan.createdAt,
      updatedAt: Date.now(),
      topicCount: plan.topics?.length || 0,
    });
    writeIndex(index);

    // Restore notification flag
    writeFlag(planId);
  }

  // Remove from trash index
  const updated = trashIndex.filter(e => e.id !== planId);
  writeTrashIndex(updated);
}

/**
 * Permanently delete a plan from the recycle bin.
 */
export function permanentlyDeleteTrash(planId) {
  // Delete the file from trash
  const trashFile = findTrashFile(planId);
  if (trashFile) {
    try { fs.unlinkSync(trashFile); } catch {}
  }
  // Remove from trash index
  const trashIndex = readTrashIndex().filter(e => e.id !== planId);
  writeTrashIndex(trashIndex);
}

/**
 * Empty the entire recycle bin — permanently delete all trash entries.
 */
export function emptyTrash() {
  const trashIndex = readTrashIndex();
  for (const entry of trashIndex) {
    const trashFile = findTrashFile(entry.id);
    if (trashFile) {
      try { fs.unlinkSync(trashFile); } catch {}
    }
  }
  writeTrashIndex([]);
  console.log(`[learn-store] 🗑️ Emptied recycle bin (${trashIndex.length} items)`);
}

/**
 * Clean up expired trash entries (older than TRASH_TTL_DAYS).
 * Plans flagged with hasData keep their data file but lose the index entry.
 * Plans without data get their file permanently deleted.
 */
export function cleanExpiredTrash() {
  const now = Date.now();
  const trashIndex = readTrashIndex();
  const remaining = [];
  let cleaned = 0;
  for (const entry of trashIndex) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      cleaned++;
      // Delete file only if plan has no valuable data
      if (!entry.hasData) {
        const trashFile = findTrashFile(entry.id);
        if (trashFile) {
          try { fs.unlinkSync(trashFile); } catch {}
        }
      }
      // If hasData, keep the file but remove from index
    } else {
      remaining.push(entry);
    }
  }
  if (cleaned > 0) {
    writeTrashIndex(remaining);
    console.log(`[learn-store] 🗑️ Cleaned ${cleaned} expired trash entries`);
  }
}

// ─── Internal trash helpers ───

function readTrashIndex() {
  return readJSON(TRASH_INDEX) || [];
}

function writeTrashIndex(index) {
  writeAtomic(TRASH_INDEX, JSON.stringify(index, null, 2));
}

/**
 * Find a trash file for the given plan ID, trying possible name variants.
 */
function findTrashFile(planId) {
  try {
    if (!fs.existsSync(TRASH_DIR)) return null;
    // First try exact match
    const exact = path.join(TRASH_DIR, `${planId}.json`);
    if (fs.existsSync(exact)) return exact;
    // Fallback: scan for planId + timestamp variants (e.g. abc_1742000000000.json)
    for (const f of fs.readdirSync(TRASH_DIR)) {
      if (f === 'index.json') continue;
      if (f.startsWith(planId + '_')) return path.join(TRASH_DIR, f);
    }
  } catch {}
  return null;
}

// ─── Auto-cleanup: run every hour ───
setInterval(() => cleanExpiredTrash(), 60 * 60 * 1000);
cleanExpiredTrash(); // also run once on startup

/**
 * Create a plan with pre-structured phases and topics (from AI import).
 * phases: [{ name, topics: [title, ...] }]
 */
/**
 * Flatten a nested phase/topics structure into a flat topics array
 * with level, parentId, prerequisites, and relatedTopics.
 *
 * Input format (from AI import):
 *   phases: [{ name, topics: [{
 *     title, level, prerequisites?: [],
 *     subtopics?: [{ title, level, prerequisites?: [], subtopics?: [...] }]
 *   }] }]
 *   relations?: [{ from: title, to: title, type: 'prerequisite'|'related' }]
 *
 * Returns: { topics: [...], relationMap: { fromTitle: { toTitle: type, ... }, ... } }
 */
function flattenTopics(phases, phasesById) {
  const topics = [];
  const titleToId = {};
  const relationPairs = [];
  let globalOrder = 0;

  function walk(items, parentId, phaseId) {
    for (const item of items) {
      // Support both string items (old format: ['知识1', '知识2'])
      // and object items (new format: [{ title: '知识1', level: 1, subtopics: [...] }])
      const title = typeof item === 'string' ? item : item.title;
      if (!title) continue;

      const id = uuidv4().slice(0, 8);
      const topic = {
        id,
        title,
        phaseId,
        level: (typeof item === 'object' && item.level) || 1,
        parentId: parentId || null,
        order: globalOrder++,
        detail: null,
        difficulty: null,
        done: false,
        lastError: null,
        exercises: [],
        weakPoints: [],
        reviewGenerated: null,
        reviewUpdatedAt: null,
        prerequisites: [],
        relatedTopics: [],
      };
      topics.push(topic);
      titleToId[title] = id;

      // Collect relation pairs from prerequisites field (only for object items)
      if (typeof item === 'object' && item.prerequisites && Array.isArray(item.prerequisites)) {
        for (const pre of item.prerequisites) {
          relationPairs.push({ from: pre, to: title, type: 'prerequisite' });
        }
      }

      // Recurse into subtopics (only for object items)
      if (typeof item === 'object' && item.subtopics && Array.isArray(item.subtopics)) {
        walk(item.subtopics, id, phaseId);
      }
    }
  }

  for (const phase of phases) {
    const phaseId = phasesById[phase.name];
    if (phase.topics && Array.isArray(phase.topics)) {
      walk(phase.topics, null, phaseId);
    }
  }

  // Resolve relation pairs to IDs
  for (const pair of relationPairs) {
    const fromId = titleToId[pair.from];
    const toId = titleToId[pair.to];
    if (fromId && toId) {
      const toTopic = topics.find(t => t.id === toId);
      if (toTopic && !toTopic.prerequisites.includes(fromId)) {
        toTopic.prerequisites.push(fromId);
      }
      if (pair.type === 'related') {
        const fromTopic = topics.find(t => t.id === fromId);
        if (fromTopic && !fromTopic.relatedTopics.includes(toId)) {
          fromTopic.relatedTopics.push(toId);
        }
        if (toTopic && !toTopic.relatedTopics.includes(fromId)) {
          toTopic.relatedTopics.push(fromId);
        }
      }
    }
  }

  return { topics, titleToId };
}

/**
 * Get children topics for a given parent topic.
 */
export function getTopicChildren(plan, parentId) {
  return plan.topics.filter(t => t.parentId === parentId).sort((a, b) => a.order - b.order);
}

/**
 * Get topic prerequisites (topics that should be learned first).
 */
export function getTopicPrerequisites(plan, topicId) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic || !topic.prerequisites?.length) return [];
  return topic.prerequisites.map(id => plan.topics.find(t => t.id === id)).filter(Boolean);
}

/**
 * Get topic descendants (recursively) for tree operations.
 */
export function getTopicDescendants(plan, parentId) {
  const result = [];
  const children = getTopicChildren(plan, parentId);
  for (const child of children) {
    result.push(child);
    result.push(...getTopicDescendants(plan, child.id));
  }
  return result;
}

/**
 * Build a knowledge graph data structure for visualization.
 * Returns { nodes: [...], edges: [...] }
 */
export function buildKnowledgeGraph(plan) {
  const nodes = plan.topics.map(t => ({
    id: t.id,
    title: t.title,
    phaseId: t.phaseId,
    level: t.level || 1,
    done: t.done,
    difficulty: t.difficulty,
  }));

  const edges = [];
  const seen = new Set();

  // Parent-child edges
  for (const t of plan.topics) {
    if (t.parentId) {
      const key = `${t.parentId}-parentOf-${t.id}`;
      if (!seen.has(key)) {
        edges.push({ from: t.parentId, to: t.id, type: 'parentOf' });
        seen.add(key);
      }
    }
  }

  // Prerequisite edges
  for (const t of plan.topics) {
    if (t.prerequisites) {
      for (const preId of t.prerequisites) {
        const key = `${preId}-prerequisite-${t.id}`;
        if (!seen.has(key)) {
          edges.push({ from: preId, to: t.id, type: 'prerequisite' });
          seen.add(key);
        }
      }
    }
  }

  // Related edges (undirected, show as bidirectional)
  for (const t of plan.topics) {
    if (t.relatedTopics) {
      for (const relId of t.relatedTopics) {
        const key = [t.id, relId].sort().join('-related-');
        if (!seen.has(key)) {
          edges.push({ from: t.id, to: relId, type: 'related' });
          seen.add(key);
        }
      }
    }
  }

  return { nodes, edges };
}

/**
 * Relationship type keywords for inferring relation types from AI detail text.
 * Maps keyword patterns to relationship types.
 */
const RELATION_TYPE_KEYWORDS = [
  { keywords: ['下一步学习', '下一步', '先学', '前置', '基础', '预备', '需要掌握', '建议先'], type: 'prerequisite' },
  { keywords: ['扩展', '深入', '进阶', '进一步学习', '更深', '提升'], type: 'extends' },
  { keywords: ['示例', '例子', '实例', '应用场景', '实际应用', '实践'], type: 'exampleOf' },
  { keywords: ['对比', '区别', '异同', '比较', 'vs', 'versus', '差异', '不同'], type: 'contrasts' },
  { keywords: ['构建于', '基于', '依赖', '建立在', '依托'], type: 'buildsOn' },
  { keywords: ['参考', '引用', '参见', '详见', '参阅'], type: 'references' },
];

/**
 * Extract relationship edges from a topic's AI-generated detail text.
 * Parses the "与相关知识点的联系" section and infers edge types from descriptions.
 * @param {string} detail - The topic's Markdown detail content
 * @param {Array} allTopics - All topics in the plan (for title matching)
 * @param {string} currentTopicId - The ID of the topic whose detail is being parsed
 * @returns {Array} Inferred edges: [{ from, to, type, description, source: 'detail' }]
 */
export function extractRelationsFromDetail(detail, allTopics, currentTopicId) {
  if (!detail || !allTopics || !currentTopicId) return [];
  const edges = [];

  // Section headers indicating a "related topics" section
  const sectionPatterns = [
    /^#{2,4}\s*与相关知识点的联系\s*$/m,
    /^#{2,4}\s*(?:关联|相关|联系|后续|延伸)(?:知识|学习|概念|主题)?(?:点)?\s*(?:的联系|的关系)?\s*$/m,
  ];

  let sectionStart = -1;
  let sectionEnd = -1;
  const lines = detail.split('\n');

  // Find the matching section
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (sectionStart === -1) {
      for (const pat of sectionPatterns) {
        if (pat.test(line)) {
          sectionStart = i;
          break;
        }
      }
    } else if (sectionStart >= 0 && line.startsWith('#')) {
      // Next heading ends the section
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) return [];
  if (sectionEnd === -1) sectionEnd = lines.length;

  // Normalize a string for fuzzy matching
  const normalize = (s) => s.toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, '')
    .replace(/\s+/g, '');

  // Build a map of normalized titles for matching
  const titleMap = [];
  for (const t of allTopics) {
    if (t.id === currentTopicId) continue;
    titleMap.push({ id: t.id, title: t.title, norm: normalize(t.title) });
  }

  // Parse each line within the section
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

    // Bullet point with **Title** pattern: - **Title**：description
    let bulletMatch = line.match(/^[-*]\s+\*\*(.+?)\*\*\s*[：:]\s*(.*)/);
    if (!bulletMatch) {
      // Try without bullet: **Title**：description
      bulletMatch = line.match(/^\*\*(.+?)\*\*\s*[：:]\s*(.*)/);
    }
    if (!bulletMatch) {
      // Try [Title] pattern
      bulletMatch = line.match(/^[-*]\s*\[(.+?)\]\s*[：:]\s*(.*)/);
    }
    if (!bulletMatch) continue;

    const bulletTitle = bulletMatch[1].trim();
    const description = bulletMatch[2].trim();
    if (!bulletTitle) continue;

    // Match title to a topic
    const bulletNorm = normalize(bulletTitle);
    let matchedTopic = null;

    // Exact match first
    matchedTopic = titleMap.find(t => t.norm === bulletNorm);
    if (!matchedTopic) {
      // Partial match: bullet title is contained in stored title or vice versa
      matchedTopic = titleMap.find(t =>
        t.norm.includes(bulletNorm) || bulletNorm.includes(t.norm)
      );
    }

    if (!matchedTopic) continue;

    // Infer relationship type from description
    let relType = 'related';
    for (const rule of RELATION_TYPE_KEYWORDS) {
      const descLower = description.toLowerCase();
      if (rule.keywords.some(kw => descLower.includes(kw))) {
        relType = rule.type;
        break;
      }
    }

    // Determine edge direction based on description semantics:
    // - "下一步学习/深入/扩展" → current topic is foundation, matched comes after → current → matched
    // - "先学/前置/基础/需要掌握/构建于/基于" → matched topic is foundation → matched → current
    // - "示例/例子" → current's example → current → matched
    // - "对比/区别" → symmetric, keep current → matched
    let from = currentTopicId;
    let to = matchedTopic.id;

    const nextStepKeywords = ['下一步学习', '下一步', '扩展', '深入', '进阶', '进一步学习', '更深', '提升', '延伸'];
    const foundationKeywords = ['先学', '前置', '基础', '需要掌握', '建议先', '预备知识',
                                '构建于', '基于', '依赖', '建立在', '依托',
                                '参考', '引用', '参见'];

    const isNextStep = nextStepKeywords.some(kw => description.includes(kw));
    const isFoundation = foundationKeywords.some(kw => description.includes(kw));

    if (relType === 'buildsOn' || relType === 'references') {
      // Linked topic is the foundation → reverse direction: matched → current
      from = matchedTopic.id;
      to = currentTopicId;
    } else if (relType === 'prerequisite') {
      if (isFoundation) {
        // Linked topic should be learned first → matched → current
        from = matchedTopic.id;
        to = currentTopicId;
      }
      // else: isNextStep → current → matched (already the default)
    }
    // For 'extends', 'exampleOf', 'contrasts', 'related': keep default current → matched

    edges.push({
      from,
      to,
      type: relType,
      description: description.substring(0, 120),
      source: 'detail',
    });
  }

  return edges;
}

/**
 * Build inferred relationships from a plan:
 * 1. Parse detail text of each topic for explicit relationships
 * 2. Compute transitive prerequisites (if A→B and B→C, then A→C)
 * 3. Inherit prerequisites down the tree (if parent has prereq P, children also effectively depend on P)
 * @param {object} plan - The plan object
 * @param {object} options
 * @param {boolean} options.includeDetailExtraction - Parse detail text (default: true)
 * @param {boolean} options.includeTransitive - Compute transitive closures (default: true)
 * @param {boolean} options.includeInherited - Inherit prerequisites to children (default: true)
 * @returns {Array} All inferred edges
 */
export function buildInferredEdges(plan, options = {}) {
  const {
    includeDetailExtraction = true,
    includeTransitive = true,
    includeInherited = true,
    includeSiblingRelated = true,
    includeSequential = true,
    includeKeywordCrossPhase = true,
  } = options;

  const inferredEdges = [];
  const seen = new Set();
  const topicMap = {};
  for (const t of plan.topics) {
    topicMap[t.id] = t;
  }

  // 0. Structure-based edges: parent-child hierarchy (works even without detail)
  for (const t of plan.topics) {
    if (t.parentId && topicMap[t.parentId]) {
      const key = `${t.parentId}:parentOf:${t.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        inferredEdges.push({
          from: t.parentId,
          to: t.id,
          type: 'parentOf',
          description: `「${topicMap[t.parentId]?.title || ''}」包含子知识点「${t.title}」`,
          source: 'structure',
          weight: 1.0,
        });
      }
    }
  }

  // 1. Extract from detail text
  if (includeDetailExtraction) {
    for (const t of plan.topics) {
      if (!t.detail) continue;
      const extracted = extractRelationsFromDetail(t.detail, plan.topics, t.id);
      for (const e of extracted) {
        const isUndirected = e.type === 'related' || e.type === 'contrasts';
        const key = isUndirected
          ? [e.from, e.to].sort().join(':') + ':' + e.type
          : e.from + ':' + e.type + ':' + e.to;
        if (!seen.has(key)) {
          seen.add(key);
          inferredEdges.push(e);
        }
      }
    }
  }

  // 2. Inherit prerequisites to children
  if (includeInherited) {
    for (const t of plan.topics) {
      if (!t.prerequisites) continue;
      // Find all descendants of this topic
      const descendants = getTopicDescendants(plan, t.id);
      for (const preId of t.prerequisites) {
        for (const desc of descendants) {
          const key = `${preId}:inheritedPrerequisite:${desc.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            inferredEdges.push({
              from: preId,
              to: desc.id,
              type: 'inheritedPrerequisite',
              description: `父知识点「${topicMap[t.id]?.title || ''}」的前置依赖传递给子知识点`,
              source: 'inherited',
            });
          }
        }
      }
    }
  }

  // 3. Compute transitive prerequisites (A→B, B→C => A→C)
  if (includeTransitive) {
    // Build adjacency list
    const prereqOf = {}; // topicId → Set of topics that depend on it
    for (const t of plan.topics) {
      if (!t.prerequisites) continue;
      for (const preId of t.prerequisites) {
        if (!prereqOf[preId]) prereqOf[preId] = new Set();
        prereqOf[preId].add(t.id);
      }
    }

    // For each topic, BFS to find all transitive dependents
    for (const t of plan.topics) {
      const visited = new Set();
      const queue = [...(t.prerequisites || [])];
      while (queue.length > 0) {
        const depId = queue.shift();
        if (visited.has(depId)) continue;
        visited.add(depId);

        // Add edge: depId → t.id (already exists as direct, skip)
        // Instead, find: if depId has its own prerequisites, those are transitive prerequisites of t
        const depTopic = topicMap[depId];
        if (depTopic && depTopic.prerequisites) {
          for (const transPreId of depTopic.prerequisites) {
            if (transPreId === t.id) continue;
            // Check this isn't already a direct prerequisite
            if (t.prerequisites && t.prerequisites.includes(transPreId)) continue;
            const key = `${transPreId}:transitivePrerequisite:${t.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              inferredEdges.push({
                from: transPreId,
                to: t.id,
                type: 'transitivePrerequisite',
                description: `通过「${topicMap[depId]?.title || ''}」传递的间接前置依赖`,
                source: 'transitive',
              });
            }
          }
        }
      }
    }
  }

  // 4. Sibling relatedness — topics under the same parent are inherently related
  if (includeSiblingRelated) {
    const siblingsByParent = {};
    for (const t of plan.topics) {
      const key = t.parentId || '__root__';
      if (!siblingsByParent[key]) siblingsByParent[key] = [];
      siblingsByParent[key].push(t);
    }
    for (const [parentKey, siblings] of Object.entries(siblingsByParent)) {
      if (siblings.length < 2) continue;
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          const a = siblings[i], b = siblings[j];
          const key = `${[a.id, b.id].sort().join(':')}:related`;
          if (seen.has(key)) continue;
          seen.add(key);
          inferredEdges.push({
            from: a.id,
            to: b.id,
            type: 'related',
            description: `同属于「${topicMap[parentKey]?.title || '根节点'}」的兄弟知识点`,
            source: 'structure',
            weight: 0.6,
          });
        }
      }
    }
  }

  // 5. Sequential dependency — ordered topics under the same parent imply builds-on
  if (includeSequential) {
    const groups = {};
    for (const t of plan.topics) {
      const gk = t.parentId || '__root__';
      if (!groups[gk]) groups[gk] = [];
      groups[gk].push(t);
    }
    for (const [, group] of Object.entries(groups)) {
      group.sort((a, b) => a.order - b.order);
      for (let i = 0; i < group.length - 1; i++) {
        const a = group[i], b = group[i + 1];
        if (b.prerequisites && b.prerequisites.includes(a.id)) continue;
        const key = `${a.id}:buildsOn:${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inferredEdges.push({
          from: a.id,
          to: b.id,
          type: 'buildsOn',
          description: `在学习顺序上位于「${b.title}」之前`,
          source: 'structure',
          weight: 0.4,
        });
      }
    }
  }

  // 6. Cross-phase keyword matching
  if (includeKeywordCrossPhase) {
    const keywordIndex = [];
    const skipWords = new Set(['的', '与', '和', '及', '在', '之', '基础', '入门', '详解', '介绍', '概述', '浅析', '初步']);
    for (const t of plan.topics) {
      const words = t.title.split(/[\s,，、：:()（）\/]/).filter(Boolean);
      const keywords = [];
      for (const w of words) {
        const trimmed = w.trim();
        if (!trimmed || trimmed.length < 2) continue;
        if (skipWords.has(trimmed)) continue;
        keywords.push(trimmed);
      }
      keywordIndex.push({ id: t.id, title: t.title, phaseId: t.phaseId, keywords });
    }
    for (let i = 0; i < keywordIndex.length; i++) {
      for (let j = i + 1; j < keywordIndex.length; j++) {
        const a = keywordIndex[i], b = keywordIndex[j];
        if (a.phaseId === b.phaseId) continue;
        const key = `${[a.id, b.id].sort().join(':')}:related`;
        if (seen.has(key)) continue;
        const overlap = a.keywords.filter(kw => b.keywords.some(bkw => bkw.includes(kw) || kw.includes(bkw)));
        if (overlap.length === 0) continue;
        seen.add(key);
        inferredEdges.push({
          from: a.id,
          to: b.id,
          type: 'related',
          description: `共享关键词「${overlap.join('、')}」的跨阶段关联`,
          source: 'structure',
          weight: Math.min(0.3 + overlap.length * 0.1, 0.8),
        });
      }
    }
  }

  return inferredEdges;
}

/**
 * Build knowledge graph with optional inferred edges.
 * Extends buildKnowledgeGraph by supporting inferred relationships from detail text,
 * transitive dependencies, and inherited prerequisites.
 * @param {object} plan
 * @param {object} options
 * @returns {{ nodes: Array, edges: Array, inferredCount: number }}
 */
export function buildEnhancedKnowledgeGraph(plan, options = {}) {
  const base = buildKnowledgeGraph(plan);
  const inferredEdges = buildInferredEdges(plan, options);
  // Dedup: base edges take priority over inferred
  const baseKeys = new Set();
  for (const e of base.edges) {
    // For undirected types (related), use sorted key
    const key = e.type === 'related'
      ? [e.from, e.to].sort().join(':') + ':related'
      : e.from + ':' + e.type + ':' + e.to;
    baseKeys.add(key);
  }
  const dedupedInferred = inferredEdges.filter(e => {
    const key = e.type === 'related'
      ? [e.from, e.to].sort().join(':') + ':related'
      : e.from + ':' + e.type + ':' + e.to;
    return !baseKeys.has(key);
  });
  const allEdges = [...base.edges, ...dedupedInferred];
  return {
    nodes: base.nodes,
    edges: allEdges,
    baseEdgeCount: base.edges.length,
    inferredCount: dedupedInferred.length,
  };
}

export function createPlanWithPhases(name, phases, relations) {
  const id = uuidv4();
  const sortedPhases = phases.map((p, i) => ({
    id: uuidv4().slice(0, 8),
    name: p.name,
    order: i,
  }));
  const phaseIdMap = {};
  for (const p of sortedPhases) phaseIdMap[p.name] = p.id;

  const { topics, titleToId } = flattenTopics(phases, phaseIdMap);

  // Process external relations from AI import (cross-topic prerequisite/related links)
  if (relations && Array.isArray(relations)) {
    for (const rel of relations) {
      const fromId = titleToId[rel.from];
      const toId = titleToId[rel.to];
      if (!fromId || !toId) continue;
      if (rel.type === 'prerequisite') {
        const toTopic = topics.find(t => t.id === toId);
        if (toTopic && !toTopic.prerequisites.includes(fromId)) {
          toTopic.prerequisites.push(fromId);
        }
      } else if (rel.type === 'related') {
        const fromTopic = topics.find(t => t.id === fromId);
        const toTopic = topics.find(t => t.id === toId);
        if (fromTopic && !fromTopic.relatedTopics.includes(toId)) {
          fromTopic.relatedTopics.push(toId);
        }
        if (toTopic && !toTopic.relatedTopics.includes(fromId)) {
          toTopic.relatedTopics.push(fromId);
        }
      }
    }
  }

  const plan = {
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phases: sortedPhases,
    topics,
    history: [],
  };

  writeAtomic(planPath(id), JSON.stringify(plan, null, 2));
  const index = readIndex();
  index.push({ id, name, createdAt: plan.createdAt, updatedAt: plan.updatedAt, topicCount: plan.topics.length });
  writeIndex(index);
  return plan;
}

/**
 * Serialized write: execute fn(plan), then atomically save.
 * fn receives the plan object and should mutate it in place.
 */
function writePlan(planId, fn) {
  return enqueueWrite(planId, () => {
    const plan = getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    fn(plan);
    plan.updatedAt = Date.now();
    writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
    updateIndex(planId, {
      topicCount: plan.topics.length,
      updatedAt: plan.updatedAt,
    });
    // 通知标记：写入 .flag 文件（study-trace 通知模式）
    writeFlag(planId);
    return plan;
  });
}

export function addTopics(planId, titles, options = {}) {
  return writePlan(planId, (plan) => {
    const existingTitles = new Set(plan.topics.map(t => t.title));
    for (const title of titles) {
      if (!existingTitles.has(title)) {
        plan.topics.push({
          id: uuidv4().slice(0, 8),
          title,
          order: plan.topics.length,
          detail: null,
          difficulty: null,
          done: false,
          lastError: null,
          exercises: [],
          weakPoints: [],
          reviewGenerated: null,
          reviewUpdatedAt: null,
          level: options.level || 1,
          parentId: options.parentId || null,
          prerequisites: [],
          relatedTopics: [],
        });
        existingTitles.add(title);
      }
    }
  });
}

export function updateTopic(planId, topicId, updates) {
  return writePlan(planId, (plan) => {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    Object.assign(topic, updates);
  });
}

/**
 * Accumulate time spent on a topic (in seconds).
 */
export function updateTopicTime(planId, topicId, seconds) {
  return writePlan(planId, (plan) => {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    topic.timeSpent = (topic.timeSpent || 0) + seconds;
    topic.lastAccessed = Date.now();
  });
}

/**
 * Save or update the core 20% analysis for a plan.
 */
export function saveCoreAnalysis(planId, analysis) {
  return writePlan(planId, (plan) => {
    plan.coreAnalysis = {
      coreTopics: analysis.coreTopics || [],
      summary: analysis.summary || '',
      corePrinciple: analysis.corePrinciple || '',
      analyzedAt: analysis.analyzedAt || Date.now(),
    };
    plan.updatedAt = Date.now();
  });
}

export function reorderTopics(planId, orderedIds) {
  return writePlan(planId, (plan) => {
    const map = {};
    for (const t of plan.topics) map[t.id] = t;
    plan.topics = orderedIds.filter(id => map[id]).map((id, i) => {
      map[id].order = i;
      return map[id];
    });
  });
}

export function removeTopic(planId, topicId) {
  return writePlan(planId, (plan) => {
    plan.topics = plan.topics.filter(t => t.id !== topicId);
  });
}

export function addHistory(planId, topicId, role, content) {
  return writePlan(planId, (plan) => {
    // 合并连续的 user 消息：如果上一条也是 user，用新内容替代旧内容
    // 防止误触 Enter 导致不完整的提问被发送
    if (role === 'user') {
      const lastEntry = plan.history.filter(h => h.topicId === topicId).pop();
      if (lastEntry && lastEntry.role === 'user') {
        lastEntry.content = content;
        lastEntry.timestamp = Date.now();
        return;
      }
    }
    plan.history.push({ topicId, role, content, timestamp: Date.now() });
  });
}

export function getTopicHistory(plan, topicId) {
  return plan.history.filter(h => h.topicId === topicId);
}

/**
 * Parse exercises from the AI-generated Markdown detail content.
 * Extracts structured exercise data from the 📝 练习题 section.
 * @param {string} detail - The Markdown content with exercises
 * @returns {Array} Parsed exercise objects
 */
export function parseExercisesFromDetail(detail) {
  if (!detail) return [];
  const exercises = [];
  const lines = detail.split('\n');
  let currentExercise = null;
  let inExerciseSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect exercise section start
    if (line.includes('📝 练习题') || line.match(/^#{1,3}\s*练习题/)) {
      inExerciseSection = true;
      continue;
    }

    if (!inExerciseSection) continue;

    // Detect exercise question (format: > **练习题 X**)
    const exerciseMatch = line.match(/^>\s*\*\*练习题\s*(\d+)\*\*\s*[（(]([^)）]+)[)）]/);
    if (exerciseMatch) {
      if (currentExercise) exercises.push(currentExercise);
      currentExercise = {
        id: uuidv4().slice(0, 8),
        index: parseInt(exerciseMatch[1]),
        type: exerciseMatch[2] === '选择题' ? 'choice' : 'open',
        question: '',
        options: [],
        answer: '',
        explanation: '',
        conceptTag: '',
        userAnswer: null,
        correct: null,
      };
      // Extract question text after type
      const qStart = line.indexOf(')') + 1;
      if (qStart < line.length) {
        currentExercise.question = line.slice(qStart).replace(/^[）\)]\s*/, '').trim();
      }
      continue;
    }

    if (!currentExercise) continue;

    // Collect options (format: > - A. xxx)
    const optionMatch = line.match(/^>\s*-\s*([A-D])[.．、]\s*(.+)/);
    if (optionMatch) {
      currentExercise.options.push(optionMatch[1] + '. ' + optionMatch[2]);
      continue;
    }

    // Answer (format: > > 正确答案：A or > > 参考答案：...)
    const answerMatch = line.match(/^>\s*>\s*(?:正确答案|参考答案)[：:]\s*(.+)/);
    if (answerMatch) {
      currentExercise.answer = answerMatch[1].trim();
      continue;
    }

    // Explanation (format: > > 解析：...)
    const explMatch = line.match(/^>\s*>\s*解析[：:]\s*(.+)/);
    if (explMatch) {
      currentExercise.explanation = explMatch[1].trim();
      continue;
    }

    // Concept tag (format: > > 关联概念：...)
    const conceptMatch = line.match(/^>\s*>\s*关联概念[：:]\s*(.+)/);
    if (conceptMatch) {
      currentExercise.conceptTag = conceptMatch[1].trim();
      continue;
    }

    // Multi-line question continuation (> text without special prefix)
    if (line.startsWith('> ') && !line.startsWith('> -') && !line.startsWith('> >') && !line.startsWith('> **练习题')) {
      const text = line.slice(2).trim();
      if (text && !text.startsWith('**练习题') && !currentExercise.answer) {
        currentExercise.question += (currentExercise.question ? ' ' : '') + text;
      }
    }
  }

  if (currentExercise) exercises.push(currentExercise);
  return exercises;
}

/**
 * Extract weak points from AI analysis result.
 * @param {string} analysisJson - JSON string from weak point analysis
 * @returns {Array} Weak point strings
 */
export function extractWeakPoints(analysisJson) {
  try {
    const data = JSON.parse(analysisJson);
    if (!data.weakPoints || !Array.isArray(data.weakPoints)) return [];
    return data.weakPoints.filter(wp => wp.concept).map(wp => wp.concept);
  } catch {
    return [];
  }
}

/**
 * Get topics that need review (have weak points or exercise errors).
 * Also considers exam paper results for identifying weak areas.
 * @param {object} plan
 * @returns {Array} Topics needing review with weakPoints summary
 */
export function getTopicsNeedingReview(plan) {
  // Collect topics with weak points from exam results
  const examWeakTopics = new Set();
  if (plan.examPapers) {
    for (const exam of plan.examPapers) {
      if (!exam.results) continue;
      for (const result of exam.results) {
        if (result.correct === false) {
          const question = exam.questions?.[result.exerciseIndex];
          if (question?.topicId) {
            examWeakTopics.add(question.topicId);
          }
        }
      }
    }
  }

  return plan.topics.filter(t => t.done && (
    (t.weakPoints && t.weakPoints.length > 0) ||
    (t.exercises && t.exercises.some(e => e.correct === false)) ||
    examWeakTopics.has(t.id)
  )).map(t => ({
    id: t.id,
    title: t.title,
    weakPoints: t.weakPoints || [],
    hasExerciseErrors: t.exercises ? t.exercises.some(e => e.correct === false) : false,
    lastErrorCount: t.exercises ? t.exercises.filter(e => e.correct === false).length : 0,
    hasExamErrors: examWeakTopics.has(t.id),
    difficulty: t.difficulty,
  }));
}

// ─── Notification flag (study-trace pending-checkin pattern) ───

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

/**
 * Build a structured learning profile for AI analysis.
 * Summarizes what the user has learned, their questions, and struggle points.
 */
export function buildLearningProfile(plan) {
  const doneTopics = plan.topics.filter(t => t.done && !t.lastError);
  const inProgress = plan.topics.filter(t => !t.done && !t.lastError);
  const failed = plan.topics.filter(t => t.lastError);

  // Extract user questions and AI response patterns
  const userQuestions = plan.history.filter(h => h.role === 'user');
  const qaTopics = {};
  for (const h of plan.history) {
    if (h.role === 'user') {
      const topic = plan.topics.find(t => t.id === h.topicId);
      const topicName = topic?.title || 'unknown';
      if (!qaTopics[topicName]) qaTopics[topicName] = [];
      qaTopics[topicName].push(h.content);
    }
  }

  return {
    planName: plan.name,
    totalTopics: plan.topics.length,
    completedTopics: doneTopics.map(t => t.title),
    inProgressTopics: inProgress.map(t => t.title),
    failedTopics: failed.map(t => ({ title: t.title, error: t.lastError })),
    completionRate: plan.topics.length > 0
      ? Math.round((doneTopics.length / plan.topics.length) * 100) + '%'
      : '0%',
    questionsAsked: userQuestions.length,
    questionsByTopic: qaTopics,
    // Phases breakdown
    phases: (plan.phases || []).map(p => {
      const phaseTopics = plan.topics.filter(t => t.phaseId === p.id);
      return {
        name: p.name,
        total: phaseTopics.length,
        done: phaseTopics.filter(t => t.done).length,
        topics: phaseTopics.map(t => ({ title: t.title, done: t.done })),
      };
    }),
  };
}

// ═══════════════════════════════════════════════════════
//  EXAM PAPER STORE FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Add a new exam paper to a plan.
 * @param {string} planId
 * @param {object} examData - { id, title, config, paper, questions }
 * @returns {object} Updated plan
 */
export function addExamPaper(planId, examData) {
  const plan = getPlan(planId);
  if (!plan) throw new Error('计划不存在');

  if (!plan.examPapers) plan.examPapers = [];
  plan.examPapers.push({
    id: examData.id,
    title: examData.title,
    createdAt: Date.now(),
    config: examData.config,
    paper: examData.paper,
    questions: examData.questions,
    results: null,
    gradedAt: null,
  });
  plan.updatedAt = Date.now();

  writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
  updateIndex(planId, { updatedAt: plan.updatedAt });
  writeFlag(planId);
  return plan;
}

/**
 * Get all exam papers for a plan.
 * @param {string} planId
 * @returns {Array} Exam papers
 */
export function getExamPapers(planId) {
  const plan = getPlan(planId);
  if (!plan) return [];
  return plan.examPapers || [];
}

/**
 * Update exam results after grading.
 * @param {string} planId
 * @param {string} examId
 * @param {Array} results - Grading results array
 */
export function updateExamResults(planId, examId, results) {
  const plan = getPlan(planId);
  if (!plan) throw new Error('计划不存在');
  if (!plan.examPapers) throw new Error('该计划没有试卷');

  const exam = plan.examPapers.find(e => e.id === examId);
  if (!exam) throw new Error('试卷不存在');

  exam.results = results;
  exam.gradedAt = Date.now();
  plan.updatedAt = Date.now();

  writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
  updateIndex(planId, { updatedAt: plan.updatedAt });
  writeFlag(planId);
  return plan;
}

/**
 * Delete an exam paper.
 * @param {string} planId
 * @param {string} examId
 */
export function deleteExamPaper(planId, examId) {
  const plan = getPlan(planId);
  if (!plan) throw new Error('计划不存在');
  if (!plan.examPapers) return;

  plan.examPapers = plan.examPapers.filter(e => e.id !== examId);
  plan.updatedAt = Date.now();

  writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
  updateIndex(planId, { updatedAt: plan.updatedAt });
}

/**
 * Persist the teaching errors revealed for a topic (used for weak-point linkage).
 * Stores under topic.teachingErrors for later analysis of unrecognized errors.
 */
export function recordTeachingErrors(planId, topicId, errors) {
  return writePlan(planId, (plan) => {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`Topic not found: `);
    topic.teachingErrors = Array.isArray(errors) ? errors : [];
    topic.teachingErrorsUpdatedAt = Date.now();
  });
}
