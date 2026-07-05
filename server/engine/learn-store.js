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

function ensureDir() {
  fs.mkdirSync(path.join(DATA, 'plans'), { recursive: true });
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

// ─── JSON safe read ───

function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

export function deletePlan(planId) {
  writeQueues.delete(planId); // discard pending writes for deleted plan
  const p = planPath(planId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  // Also delete .tmp files if any
  try {
    const dir = path.dirname(p);
    const prefix = path.basename(p);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix + '.tmp')) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}
  const index = readIndex().filter(e => e.id !== planId);
  writeIndex(index);
}

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

export default {
  listPlans, getPlan, createPlan, createPlanWithPhases, deletePlan, removeTopic,
  addTopics, updateTopic, updateTopicTime, reorderTopics, addHistory, getTopicHistory, buildLearningProfile,
  getTopicChildren, getTopicPrerequisites, getTopicDescendants, buildKnowledgeGraph,
  writeFlag, readFlags, clearFlag,
};
