/**
 * Plan content operations — topics, history, and learning profile.
 *
 * Mutates plans through the serialized writePlan() wrapper to guarantee
 * atomic writes and index consistency. The writeFlag() side-effect keeps
 * the study-trace notification pattern working.
 */

import { v4 as uuidv4 } from 'uuid';
import { markPlanForTestCleanup } from './test-plan-marker.js';
import { createPlanRecord, writePlan } from './write-plan.js';

// ─── Phase / topic flattening (AI import) ───

/**
 * Flatten a nested phase/topics structure into a flat topics array
 * with level, parentId, prerequisites, and relatedTopics.
 *
 * Input format (from AI import):
 *   phases: [{ name, topics: [{
 *     title, level, prerequisites?: [],
 *     subtopics: [{ title, level, prerequisites?: [], subtopics?: [...] }]
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
 * Create a plan with pre-structured phases and topics (from AI import).
 * phases: [{ name, topics: [title, ...] }]
 */
export async function createPlanWithPhases(name, phases, relations, options = {}) {
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

  const initial = {
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phases: sortedPhases,
    topics,
    history: [],
  };
  markPlanForTestCleanup(initial, options);

  return createPlanRecord(id, initial, {
    indexEntry: (meta) => ({
      id,
      name,
      createdAt: initial.createdAt,
      updatedAt: meta.updatedAt,
      topicCount: initial.topics.length,
    }),
  });
}

// ─── Topic operations ───

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

export function markRelationsInferred(planId, inferredAt = Date.now()) {
  return writePlan(planId, (plan) => {
    plan.relationsInferredAt = inferredAt;
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

export async function appendWeakPoint(planId, topicId, point) {
  const normalized = typeof point === 'string' ? point.trim() : '';
  if (!normalized) throw new Error('Weak point must be a non-empty string');

  let changed = false;
  const plan = await writePlan(planId, current => {
    const topic = current.topics.find(item => item.id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    const weakPoints = Array.isArray(topic.weakPoints) ? topic.weakPoints : [];
    if (!weakPoints.includes(normalized)) {
      topic.weakPoints = [...weakPoints, normalized];
      changed = true;
    }
  });
  return { plan, changed };
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

// ─── History ───

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

// ─── Learning profile ───

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
