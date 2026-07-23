/**
 * CRUD operations for the learning assistant.
 *
 * Persistence primitives (writeAtomic, readJSON, index management) are in storage.js.
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  DATA, PLANS_INDEX, TRASH_DIR, TRASH_INDEX, TRASH_TTL_DAYS, BACKUP_DIR,
  writeAtomic, removePlanBackups, enqueueWrite, drainWriteQueue,
  readJSON, readIndex, rebuildIndex, writeIndex, updateIndex, planPath,
  getCachedPlan, invalidatePlanCache,
} from './storage.js';
import { markPlanForTestCleanup } from './test-plan-marker.js';
import { CURRENT_PLAN_DATA_VERSION } from '../../migrations/data-version.js';
import {
  createInitialTopicLearningState,
  createMasteryEvidence,
  applyMasteryEvidenceAttempt,
  buildTodayReviewQueue as buildTodayReviewQueueFromPlans,
  normalizeConceptTags,
} from '../mastery-scheduler.js';
import {
  applyEvidenceToMistakeLedger,
  dismissMistake,
  getActiveMistakeEvidenceIds,
  startMistakeRepair,
} from '../mistake-ledger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function ensureTopicLearningState(topic) {
  const defaults = createInitialTopicLearningState({ done: topic.done === true });
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(topic, key)) topic[key] = value;
  }
}

// ─── Public API ───

export function listPlans() {
  return readIndex().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Scan every persisted plan file, including files missing from plans.json.
 * Cleanup and integrity tooling use this instead of reaching into data paths.
 */
export function scanStoredPlans() {
  const plans = [];
  const errors = [];
  const plansDir = path.join(DATA, 'plans');

  let files;
  try {
    files = fs.readdirSync(plansDir).filter(file => file.endsWith('.json'));
  } catch (error) {
    return { plans, errors: [{ id: null, message: error.message }] };
  }

  for (const file of files) {
    const fileId = path.basename(file, '.json');
    const plan = readJSON(path.join(plansDir, file));
    if (!plan || typeof plan !== 'object') {
      errors.push({ id: fileId, message: 'Plan file could not be read' });
      continue;
    }
    if (plan.id !== fileId) {
      errors.push({ id: fileId, message: `Plan file contains mismatched id: ${plan.id ?? 'missing'}` });
      continue;
    }
    plans.push(plan);
  }

  return { plans, errors };
}

/**
 * Remove index entries only when their corresponding plan file is absent.
 * Existing (including unreadable) files are never deleted by this operation.
 */
export async function pruneMissingPlanIndexEntries(planIds) {
  const requestedIds = new Set(
    (Array.isArray(planIds) ? planIds : []).filter(id => typeof id === 'string' && id.length > 0)
  );
  const missingIds = new Set([...requestedIds].filter(id => !fs.existsSync(planPath(id))));
  const index = readIndex();
  const removed = index.filter(entry => missingIds.has(entry.id));

  if (removed.length > 0) {
    await writeIndex(index.filter(entry => !missingIds.has(entry.id)));
    for (const entry of removed) invalidatePlanCache(entry.id);
  }

  return {
    removed,
    retained: [...requestedIds].filter(id => !removed.some(entry => entry.id === id)),
  };
}

export function getPlan(planId) {
  return getCachedPlan(planId, () => readJSON(planPath(planId)));
}

export async function createPlan(name, options = {}) {
  const id = uuidv4();
  const plan = {
    id,
    name,
    dataVersion: CURRENT_PLAN_DATA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    topics: [],
    phases: [],
    history: [],
  };
  markPlanForTestCleanup(plan, options);
  writeAtomic(planPath(id), JSON.stringify(plan, null, 2));
  const index = readIndex();
  index.push({ id, name, createdAt: plan.createdAt, updatedAt: plan.updatedAt, topicCount: 0 });
  await writeIndex(index);
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
  // 先等待队列清空，再删除
  await drainWriteQueue(planId);
  invalidatePlanCache(planId);

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

  // Delete all backup files (.bak + .backups-v2/)
  removePlanBackups(planId);

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
  // Drain pending writes before moving to trash
  await drainWriteQueue(planId);
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

  invalidatePlanCache(planId);
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

  invalidatePlanCache(planId);
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
  // Delete all backup files (.bak + .backups-v2/)
  removePlanBackups(planId);
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
    // Delete all backup files (.bak + .backups-v2/)
    removePlanBackups(entry.id);
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
        // Delete all backup files (.bak + .backups-v2/)
        removePlanBackups(entry.id);
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
const trashCleanupTimer = setInterval(() => cleanExpiredTrash(), 60 * 60 * 1000);
trashCleanupTimer.unref(); // Do not keep one-off CLI scripts alive after their work is done.
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
        generationFeedback: [],
        prerequisites: [],
        relatedTopics: [],
        ...createInitialTopicLearningState(),
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
  if (!plan || !plan.topics) return [];
  return plan.topics.filter(t => t.parentId === parentId).sort((a, b) => a.order - b.order);
}

/**
 * Get topic prerequisites (topics that should be learned first).
 */
export function getTopicPrerequisites(plan, topicId) {
  if (!plan || !plan.topics) return [];
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
  if (!plan || !plan.topics) return { nodes: [], edges: [] };

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
    /^#{2,4}\s*承上启下\s*[：:]\s*与相关知识点的联系\s*$/m,
    /^#{2,4}\s*(?:承上启下\s*[：:]\s*)?(?:关联|相关|联系|后续|延伸)(?:知识|学习|概念|主题)?(?:点)?\s*(?:的联系|的关系)?\s*$/m,
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

  if (!plan || !plan.topics || plan.topics.length === 0) return [];

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

export function createPlanWithPhases(name, phases, relations, options = {}) {
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
    dataVersion: CURRENT_PLAN_DATA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phases: sortedPhases,
    topics,
    history: [],
  };
  markPlanForTestCleanup(plan, options);

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
export function writePlan(planId, fn) {
  return enqueueWrite(planId, () => {
    const plan = getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    const snapshot = structuredClone(plan);
    try {
      fn(plan);
      plan.updatedAt = Date.now();
      writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
    } catch (error) {
      replacePlanContents(plan, snapshot);
      throw error;
    }
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
          generationFeedback: [],
          level: options.level || 1,
          parentId: options.parentId || null,
          prerequisites: [],
          relatedTopics: [],
          ...createInitialTopicLearningState(),
        });
        existingTitles.add(title);
      }
    }
  });
}

export function updateTopic(planId, topicId, updates, { now = Date.now() } = {}) {
  return writePlan(planId, (plan) => {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    ensureTopicLearningState(topic);
    const wasDone = topic.done === true;
    Object.assign(topic, updates);

    if (!wasDone && topic.done === true) {
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new TypeError('now must be a non-negative epoch millisecond integer');
      }
      if (topic.reviewSchedule.dueAt === null) {
        topic.reviewSchedule = {
          ...topic.reviewSchedule,
          dueAt: now + DAY_MS,
        };
      }
      if (topic.masteryEvidence.length === 0) {
        topic.mastery = {
          ...topic.mastery,
          status: 'learning',
        };
      }
    }
  });
}

/**
 * Accumulate time spent on a topic (in seconds).
 * Also records a daily time log entry for time distribution tracking.
 */
export function updateTopicTime(planId, topicId, seconds) {
  return writePlan(planId, (plan) => {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    topic.timeSpent = (topic.timeSpent || 0) + seconds;
    topic.lastAccessed = Date.now();

    // Record daily time log for distribution tracking
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    if (!topic.timeLog) topic.timeLog = [];
    const todayEntry = topic.timeLog.find(e => e.date === today);
    if (todayEntry) {
      todayEntry.seconds += seconds;
    } else {
      topic.timeLog.push({ date: today, seconds });
    }
  });
}

/**
 * Revert a topic's done=true mark back to done=false.
 * Safe rules:
 *   - Only reverts if topic.done === true (no-op otherwise).
 *   - Resets reviewSchedule.dueAt to null ONLY when no mastery evidence exists,
 *     preserving any scheduled review earned through actual assessment.
 *   - Resets mastery.status to 'unassessed' ONLY when no mastery evidence exists.
 *   - Never deletes existing masteryEvidence, mistakeRecords, or history.
 */
export function undoneTopic(planId, topicId) {
  return writePlan(planId, (plan) => {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    if (!topic.done) return; // already not done, nothing to do
    ensureTopicLearningState(topic);

    topic.done = false;

    const hasEvidence = Array.isArray(topic.masteryEvidence) && topic.masteryEvidence.length > 0;
    if (!hasEvidence) {
      // No real assessment has happened; safe to fully reset scheduling state
      if (topic.reviewSchedule) {
        topic.reviewSchedule = { ...topic.reviewSchedule, dueAt: null };
      }
      if (topic.mastery) {
        topic.mastery = { ...topic.mastery, status: 'unassessed' };
      }
    }
    // If evidence exists: keep mastery and reviewSchedule intact —
    // user has done real work and we must not destroy it.
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
export function getTopicsNeedingReview(plan, { now = Date.now() } = {}) {
  if (!plan || !Array.isArray(plan.topics)) return [];
  const examWeakTopics = new Set();
  for (const exam of plan.examPapers || []) {
    for (const result of exam.results || []) {
      if (result.correct !== false) continue;
      const question = exam.questions?.[result.exerciseIndex];
      if (question?.topicId) examWeakTopics.add(question.topicId);
    }
  }
  const queue = buildTodayReviewQueueFromPlans([plan], { now, limit: 100 });
  return queue.items.map(item => {
    const topic = plan.topics.find(candidate => candidate.id === item.topicId);
    return {
      id: topic.id,
      title: topic.title,
      weakPoints: topic.weakPoints || [],
      hasExerciseErrors: topic.exercises ? topic.exercises.some(exercise => exercise.correct === false) : false,
      lastErrorCount: topic.exercises ? topic.exercises.filter(exercise => exercise.correct === false).length : 0,
      hasExamErrors: examWeakTopics.has(topic.id),
      difficulty: topic.difficulty,
      dueAt: item.dueAt,
      priorityScore: item.priorityScore,
      mastery: item.mastery,
    };
  });
}

export function getTodayReviewQueue({ now = Date.now(), limit = 20 } = {}) {
  const plans = listPlans().map(entry => getPlan(entry.id)).filter(Boolean);
  return buildTodayReviewQueueFromPlans(plans, { now, limit });
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
  if (!plan || !plan.topics) return { totalTopics: 0, doneTopics: 0, inProgress: 0, failed: 0, completionRate: 0, questionsCount: 0, qaTopics: {} };

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
export async function addExamPaper(planId, examData) {
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
    gradedAttemptRef: null,
  });
  plan.updatedAt = Date.now();

  writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
  invalidatePlanCache(planId);
  await updateIndex(planId, { updatedAt: plan.updatedAt });
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
export async function updateExamResults(planId, examId, results, options = {}) {
  if (options.attemptRef !== undefined) {
    return commitExamAssessment(planId, examId, results, options);
  }
  const plan = getPlan(planId);
  if (!plan) throw new Error('计划不存在');
  if (!plan.examPapers) throw new Error('该计划没有试卷');

  const exam = plan.examPapers.find(e => e.id === examId);
  if (!exam) throw new Error('试卷不存在');

  exam.results = results;
  exam.gradedAt = Date.now();
  plan.updatedAt = Date.now();

  writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
  invalidatePlanCache(planId);
  await updateIndex(planId, { updatedAt: plan.updatedAt });
  writeFlag(planId);
  return plan;
}

/**
 * Delete an exam paper.
 * @param {string} planId
 * @param {string} examId
 */
export async function deleteExamPaper(planId, examId) {
  const plan = getPlan(planId);
  if (!plan) throw new Error('计划不存在');
  if (!plan.examPapers) return;

  plan.examPapers = plan.examPapers.filter(e => e.id !== examId);
  plan.updatedAt = Date.now();

  writeAtomic(planPath(planId), JSON.stringify(plan, null, 2), { backup: true });
  invalidatePlanCache(planId);
  await updateIndex(planId, { updatedAt: plan.updatedAt });
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

/**
 * Save quick quiz results for a plan.
 * Stores each quiz attempt with questions, user answers, and correctness.
 */
export function saveQuickQuizResults(planId, quizData, options = {}) {
  if (options.attemptRef !== undefined) {
    return commitQuickQuizAssessment(planId, quizData, options);
  }
  return writePlan(planId, (plan) => {
    if (!plan.quickQuizHistory) plan.quickQuizHistory = [];
    plan.quickQuizHistory.push({
      id: quizData.id || crypto.randomUUID().slice(0, 8),
      createdAt: Date.now(),
      questions: quizData.questions,
      results: quizData.results,
    });
    // Keep only last 20 quiz attempts to avoid unbounded growth
    if (plan.quickQuizHistory.length > 20) {
      plan.quickQuizHistory = plan.quickQuizHistory.slice(-20);
    }
  });
}

/**
 * Atomically append a generation feedback entry to a topic.
 * All operations (read existing, append, slice) happen inside a single
 * writePlan mutator, making it safe against concurrent writes.
 *
 * @param {string} planId
 * @param {string} topicId
 * @param {object} entry - { reason, mode, timestamp }
 * @param {number} [limit=20] - max entries to retain
 * @returns {number} total entries after append
 */
export async function appendGenerationFeedback(planId, topicId, entry, limit = 20) {
  // Normalize limit: finite positive integer, max 100
  const maxLen = (Number.isFinite(limit) && limit > 0) ? Math.min(Math.round(limit), 100) : 20;
  let total = 0;
  await writePlan(planId, (plan) => {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const existing = Array.isArray(topic.generationFeedback) ? topic.generationFeedback : [];
    const updated = [...existing, entry].slice(-maxLen);
    topic.generationFeedback = updated;
    total = updated.length;
  });
  return { total };
}

// ═══════════════════════════════════════════════════════
//  MASTERY EVIDENCE OUTCOMES
// ═══════════════════════════════════════════════════════

const P1_SOURCES = Object.freeze(['exercise', 'quickQuiz', 'exam', 'feynman', 'review', 'repair']);

const FEYNMAN_QUALITY_MAP = Object.freeze({
  excellent: { score: 0.90, quality: 4, confidence: 'medium' },
  good: { score: 0.75, quality: 4, confidence: 'medium' },
  fair: { score: 0.55, quality: 2, confidence: 'medium' },
  needsWork: { score: 0.25, quality: 1, confidence: 'medium' },
});

/**
 * Validate and normalize assessment outcome items before mutation.
 * Throws on invalid input — no side effects.
 * Each item must carry a stable itemRef (original question ID/index).
 */
function validateOutcomeItems(items, source) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RangeError('items must be a non-empty array');
  }

  const configs = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      throw new TypeError(`items[${i}] must be an object`);
    }
    if (typeof item.topicId !== 'string' || !item.topicId) {
      throw new TypeError(`items[${i}].topicId must be a non-empty string`);
    }
    if (typeof item.itemRef !== 'string' || !item.itemRef) {
      throw new TypeError(`items[${i}].itemRef must be a non-empty string`);
    }

    let score, quality, confidence, conceptTags;

    if (source === 'feynman') {
      const mapped = FEYNMAN_QUALITY_MAP[item.teachingQuality];
      if (!mapped) {
        throw new RangeError(
          `items[${i}].teachingQuality must be one of: ${Object.keys(FEYNMAN_QUALITY_MAP).join(', ')}`
        );
      }
      score = mapped.score;
      quality = mapped.quality;
      confidence = 'medium';
    } else {
      // Objective sources: exercise, quickQuiz, exam, review, repair
      if (typeof item.correct !== 'boolean') {
        throw new TypeError(`items[${i}].correct must be a boolean for source '${source}'`);
      }
      score = item.correct ? 1 : 0;
      quality = item.correct ? 5 : 0;
      confidence = 'high';
    }

    conceptTags = Array.isArray(item.conceptTags) ? item.conceptTags : [];
    configs.push({
      topicId: item.topicId,
      itemRef: item.itemRef,
      score,
      quality,
      confidence,
      conceptTags,
    });
  }
  return configs;
}

/**
 * Apply assessment outcomes to Topic mastery/review schedule in a single
 * serialized writePlan mutator. All validation occurs before any write.
 *
 * Rules:
 * - source must be one of P1_SOURCES (exercise/quickQuiz/exam/feynman/review/repair)
 * - observedAt must be a non-negative safe integer when provided; omitted defaults to Date.now()
 * - Each item must carry a stable itemRef; sourceRef = `${attemptRef}:${itemRef}`
 * - All next-state computations are completed before any Topic field assignment
 *   to prevent partial cached mutation on failure.
 *
 * @param {string} planId
 * @param {object} options
 * @param {string} options.source - 'exercise'|'quickQuiz'|'exam'|'feynman'|'review'|'repair'
 * @param {Array} options.items - Outcome items. Each: { topicId, itemRef, correct|teachingQuality, conceptTags? }
 * @param {string} options.attemptRef - Unique attempt identifier (8-128 chars)
 * @param {number} [options.observedAt] - Epoch ms; omitted -> Date.now(), invalid -> throws
 * @returns {Promise<{results: Array, plan: object}>}
 */
function normalizeAssessmentClock(observedAt) {
  if (observedAt === undefined) return Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new TypeError('observedAt must be a non-negative safe integer when provided');
  }
  return observedAt;
}

function normalizeAssessmentAttemptRef(attemptRef) {
  if (typeof attemptRef !== 'string') throw new TypeError('attemptRef must be a string');
  const normalized = attemptRef.trim();
  if (normalized.length < 8 || normalized.length > 128) {
    throw new RangeError('attemptRef must be 8-128 characters');
  }
  return normalized;
}

function computeMasteryOutcome(plan, { source, items, attemptRef, observedAt } = {}) {
  if (!P1_SOURCES.includes(source)) {
    throw new TypeError(`source must be one of: ${P1_SOURCES.join(', ')}`);
  }
  const normalizedAttemptRef = normalizeAssessmentAttemptRef(attemptRef);
  const now = normalizeAssessmentClock(observedAt);
  const configs = validateOutcomeItems(items, source);
  const topicMap = new Map(plan.topics.map(topic => [topic.id, topic]));
  const seenItemRefs = new Set();
  const topicGroups = new Map();

  for (const config of configs) {
    if (!topicMap.has(config.topicId)) throw new Error(`Topic not found: ${config.topicId}`);
    const itemKey = `${config.topicId}\0${config.itemRef}`;
    if (seenItemRefs.has(itemKey)) throw new RangeError(`duplicate itemRef: ${config.itemRef}`);
    seenItemRefs.add(itemKey);
    if (!topicGroups.has(config.topicId)) topicGroups.set(config.topicId, []);
    topicGroups.get(config.topicId).push(config);
  }

  const states = [];
  for (const [topicId, groupItems] of topicGroups) {
    const topic = topicMap.get(topicId);
    const defaults = createInitialTopicLearningState({ done: topic.done === true });
    const currentMistakes = topic.mistakes || defaults.mistakes;
    const evidence = groupItems.map(config => createMasteryEvidence({
      source,
      attemptRef: normalizedAttemptRef,
      sourceRef: `${normalizedAttemptRef}:${config.itemRef}`,
      observedAt: now,
      score: config.score,
      quality: config.quality,
      confidence: config.confidence,
      conceptTags: normalizeConceptTags(config.conceptTags),
    }));
    const protectedEvidenceIds = [
      ...getActiveMistakeEvidenceIds(currentMistakes),
      ...evidence.filter(item => item.quality < 3).map(item => item.id),
    ];
    const result = applyMasteryEvidenceAttempt({
      currentEvidence: topic.masteryEvidence || defaults.masteryEvidence,
      reviewSchedule: topic.reviewSchedule || defaults.reviewSchedule,
      evidence,
      done: topic.done === true,
      protectedEvidenceIds: [...new Set(protectedEvidenceIds)],
      now,
    });
    const ledger = applyEvidenceToMistakeLedger(currentMistakes, result.insertedEvidence, {
      topicTitle: topic.title,
    });
    states.push({ topicId, ...result, mistakes: ledger.mistakes });
  }

  return {
    source,
    attemptRef: normalizedAttemptRef,
    observedAt: now,
    inserted: states.some(state => state.inserted),
    states,
  };
}

function applyComputedMasteryOutcome(plan, outcome) {
  const topicMap = new Map(plan.topics.map(topic => [topic.id, topic]));
  for (const state of outcome.states) {
    const topic = topicMap.get(state.topicId);
    topic.masteryEvidence = state.masteryEvidence;
    topic.mastery = state.mastery;
    topic.reviewSchedule = state.reviewSchedule;
    topic.mistakes = state.mistakes;
  }
}

function replacePlanContents(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

async function commitAssessmentTransaction(planId, buildTransaction) {
  let summary;
  await writePlan(planId, persistedPlan => {
    const workingPlan = structuredClone(persistedPlan);
    const transaction = buildTransaction(workingPlan);
    const outcome = transaction.outcome
      ? computeMasteryOutcome(workingPlan, transaction.outcome)
      : { inserted: false, states: [] };

    transaction.applyResult?.(workingPlan, outcome);
    applyComputedMasteryOutcome(workingPlan, outcome);
    replacePlanContents(persistedPlan, workingPlan);
    summary = outcome;
  });

  const plan = getPlan(planId);
  return {
    inserted: summary.inserted,
    results: summary.states.map(state => ({
      topicId: state.topicId,
      inserted: state.inserted,
      insertedCount: state.insertedEvidence.length,
      aggregateQuality: state.aggregateQuality,
      mastery: state.mastery,
      reviewSchedule: state.reviewSchedule,
      evidenceCount: state.masteryEvidence.length,
    })),
    plan,
  };
}

function validateIndexedResults(questions, results) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new RangeError('questions must be a non-empty array');
  }
  if (!Array.isArray(results) || results.length !== questions.length) {
    throw new RangeError('results length must match questions length');
  }
  const seen = new Set();
  return results.map((result, position) => {
    if (!result || typeof result !== 'object') {
      throw new TypeError(`results[${position}] must be an object`);
    }
    const index = result.exerciseIndex;
    if (!Number.isInteger(index) || index < 0 || index >= questions.length) {
      throw new RangeError(`results[${position}].exerciseIndex is out of range`);
    }
    if (seen.has(index)) throw new RangeError(`duplicate exerciseIndex: ${index}`);
    if (typeof result.correct !== 'boolean') {
      throw new TypeError(`results[${position}].correct must be a boolean`);
    }
    seen.add(index);
    return { result, question: questions[index], index };
  });
}

function questionItemRef(question, index) {
  const value = question?.id ?? question?.questionId ?? index;
  return `item-${String(value).trim()}`;
}

function assessmentContractError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeReviewSession(session, { now, sessionId }) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new TypeError('ReviewSession must be an object');
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative epoch millisecond integer');
  }
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id.length < 8 || id.length > 128) {
    throw new RangeError('sessionId must contain 8..128 characters');
  }
  if (session.kind !== 'review' && session.kind !== 'repair') {
    throw new TypeError('ReviewSession kind must be review or repair');
  }
  const content = typeof session.content === 'string' ? session.content.trim() : '';
  if (!content) throw assessmentContractError('复习内容为空，请重新生成', 422, 'EMPTY_REVIEW_CONTENT');
  if (!Array.isArray(session.exercises) || session.exercises.length === 0) {
    throw assessmentContractError('复习未生成可评分练习，请重新生成', 422, 'EMPTY_REVIEW_EXERCISES');
  }
  for (const [index, exercise] of session.exercises.entries()) {
    if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) {
      throw new TypeError(`ReviewSession exercises[${index}] must be an object`);
    }
  }

  const mistakeId = session.mistakeId == null ? null : String(session.mistakeId).trim();
  if (session.kind === 'review' && mistakeId !== null) {
    throw new TypeError('ReviewSession review kind cannot reference a mistake');
  }
  if (session.kind === 'repair' && !mistakeId) {
    throw new TypeError('ReviewSession repair kind requires mistakeId');
  }

  return {
    id,
    version: 1,
    kind: session.kind,
    mistakeId,
    createdAt: now,
    content,
    exercises: structuredClone(session.exercises),
  };
}

function requireAssessmentSession(topic, { sessionId, kind }) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const session = topic.reviewSession;
  if (!session || session.id !== normalizedSessionId || session.kind !== kind) {
    throw assessmentContractError('复习会话已过期，请重新生成', 409, 'STALE_REVIEW_SESSION');
  }
  if (!Array.isArray(session.exercises) || session.exercises.length === 0) {
    throw assessmentContractError('复习会话没有可评分练习，请重新生成', 422, 'EMPTY_REVIEW_EXERCISES');
  }
  return session;
}

export async function saveReviewSession(planId, topicId, session, {
  now = Date.now(),
  sessionId = uuidv4(),
} = {}) {
  const normalized = normalizeReviewSession(session, { now, sessionId });
  await writePlan(planId, persistedPlan => {
    const workingPlan = structuredClone(persistedPlan);
    const topic = workingPlan.topics.find(candidate => candidate.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    if (normalized.kind === 'repair') {
      topic.mistakes = startMistakeRepair(topic.mistakes || [], normalized.mistakeId, {
        now: normalized.createdAt,
      }).mistakes;
    }
    topic.reviewSession = normalized;
    topic.reviewGenerated = normalized.content;
    topic.reviewUpdatedAt = normalized.createdAt;
    replacePlanContents(persistedPlan, workingPlan);
  });
  return structuredClone(normalized);
}

export async function dismissTopicMistake(planId, topicId, mistakeId, reason, {
  now = Date.now(),
} = {}) {
  let dismissed;
  await writePlan(planId, persistedPlan => {
    const workingPlan = structuredClone(persistedPlan);
    const topic = workingPlan.topics.find(candidate => candidate.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const transition = dismissMistake(topic.mistakes || [], mistakeId, reason, { now });
    topic.mistakes = transition.mistakes;
    if (topic.reviewSession?.kind === 'repair' && topic.reviewSession.mistakeId === transition.mistake.id) {
      topic.reviewSession = null;
    }
    dismissed = transition.mistake;
    replacePlanContents(persistedPlan, workingPlan);
  });
  return structuredClone(dismissed);
}

export function applyMasteryOutcome(planId, options) {
  return commitAssessmentTransaction(planId, () => ({ outcome: options }));
}

export function saveExerciseResults(planId, topicId, exercises, results, options = {}) {
  return commitAssessmentTransaction(planId, plan => {
    const topic = plan.topics.find(candidate => candidate.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const indexed = validateIndexedResults(exercises, results);
    const outcomeItems = indexed.map(({ result, question, index }) => ({
      topicId,
      itemRef: questionItemRef(question, index),
      correct: result.correct,
      conceptTags: [question?.conceptTag || topic.title],
    }));
    return {
      outcome: { source: 'exercise', items: outcomeItems, ...options },
      applyResult(workingPlan, outcome) {
        const workingTopic = workingPlan.topics.find(candidate => candidate.id === topicId);
        workingTopic.exercises = structuredClone(exercises);
        // Store the full grading payload keyed by attemptRef so that a retry
        // with the same attemptRef can return the identical response without
        // re-calling the AI provider.
        workingTopic.lastExerciseGrading = {
          attemptRef: outcome.attemptRef,
          results: structuredClone(results),
        };
      },
    };
  });
}

export function saveReviewResults(planId, topicId, results, options = {}) {
  const context = options.context;
  const kind = context === 'repair' ? 'repair' : 'review';
  const source = kind;
  return commitAssessmentTransaction(planId, plan => {
    const topic = plan.topics.find(candidate => candidate.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const session = requireAssessmentSession(topic, { sessionId: options.sessionId, kind });
    if (kind === 'repair') {
      const mistakeId = typeof options.mistakeId === 'string' ? options.mistakeId.trim() : '';
      const mistake = (topic.mistakes || []).find(candidate => candidate.id === mistakeId);
      if (session.mistakeId !== mistakeId || !mistake || !['open', 'repairing'].includes(mistake.status)) {
        throw assessmentContractError(
          '错题修复会话已失效，请重新开始修复',
          409,
          'STALE_REPAIR_MISTAKE'
        );
      }
    }
    const indexed = validateIndexedResults(session.exercises, results);
    const outcomeItems = indexed.map(({ result, question, index }) => ({
      topicId,
      itemRef: questionItemRef(question, index),
      correct: result.correct,
      conceptTags: [question?.conceptTag || topic.title],
    }));
    return {
      outcome: {
        source,
        items: outcomeItems,
        attemptRef: options.attemptRef,
        observedAt: options.observedAt,
      },
    };
  });
}

function commitExamAssessment(planId, examId, results, options) {
  return commitAssessmentTransaction(planId, plan => {
    const exam = plan.examPapers?.find(candidate => candidate.id === examId);
    if (!exam) throw new Error('试卷不存在');
    const indexed = validateIndexedResults(exam.questions, results);
    const outcomeItems = indexed.map(({ result, question, index }) => {
      if (!question?.topicId) throw new Error(`Topic not found for exam question ${index}`);
      return {
        topicId: question.topicId,
        itemRef: questionItemRef(question, index),
        correct: result.correct,
        conceptTags: [question.conceptTag || question.topicTitle || ''].filter(Boolean),
      };
    });
    return {
      outcome: { source: 'exam', items: outcomeItems, ...options },
      applyResult(workingPlan, outcome) {
        const workingExam = workingPlan.examPapers.find(candidate => candidate.id === examId);
        workingExam.results = structuredClone(results);
        workingExam.gradedAt = outcome.observedAt;
        workingExam.gradedAttemptRef = outcome.attemptRef;
        for (const { result, question } of indexed) {
          if (result.correct || !question.conceptTag) continue;
          const topic = workingPlan.topics.find(candidate => candidate.id === question.topicId);
          if (!topic) throw new Error(`Topic not found: ${question.topicId}`);
          topic.weakPoints = [...new Set([...(topic.weakPoints || []), question.conceptTag])];
        }
      },
    };
  });
}

function commitQuickQuizAssessment(planId, quizData, options) {
  return commitAssessmentTransaction(planId, plan => {
    const indexed = validateIndexedResults(quizData?.questions, quizData?.results);
    const outcomeItems = indexed.map(({ result, question, index }) => {
      const topic = question?.topicId
        ? plan.topics.find(candidate => candidate.id === question.topicId)
        : plan.topics.find(candidate => candidate.title === question?.topicTitle);
      if (!topic) throw new Error(`Topic not found for quick quiz question ${index}`);
      return {
        topicId: topic.id,
        itemRef: questionItemRef(question, index),
        correct: result.correct,
        conceptTags: [question.conceptTag || question.topicTitle || topic.title],
      };
    });
    return {
      outcome: { source: 'quickQuiz', items: outcomeItems, ...options },
      applyResult(workingPlan, outcome) {
        if (!outcome.inserted) return;
        if (!workingPlan.quickQuizHistory) workingPlan.quickQuizHistory = [];
        workingPlan.quickQuizHistory.push({
          id: quizData.id || outcome.attemptRef,
          attemptRef: outcome.attemptRef,
          createdAt: outcome.observedAt,
          questions: structuredClone(quizData.questions),
          results: structuredClone(quizData.results),
        });
        workingPlan.quickQuizHistory = workingPlan.quickQuizHistory.slice(-20);
      },
    };
  });
}

export function saveFeynmanResults(planId, topicId, insights, options = {}) {
  return commitAssessmentTransaction(planId, plan => {
    const topic = plan.topics.find(candidate => candidate.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const teachingQuality = insights?.teachingQuality;
    const outcome = Object.hasOwn(FEYNMAN_QUALITY_MAP, teachingQuality)
      ? {
          source: 'feynman',
          items: [{
            topicId,
            itemRef: 'transcript',
            teachingQuality,
            conceptTags: [topic.title],
          }],
          ...options,
        }
      : null;
    return {
      outcome,
      applyResult(workingPlan) {
        workingPlan.topics.find(candidate => candidate.id === topicId).feynmanInsights = structuredClone(insights);
      },
    };
  });
}
