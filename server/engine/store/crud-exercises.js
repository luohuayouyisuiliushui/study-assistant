/**
 * Exercises, exam papers, and review management.
 *
 * Contains parsing of exercises from AI-generated detail, weak-point
 * extraction, exam paper CRUD, and quick-quiz history. Exam paper writes
 * go directly through writeAtomic (bypassing writePlan) to preserve the
 * exact exam-data shape, while topic-scoped mutations use writePlan.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  writeAtomic,
  updateIndex, planPath,
  invalidatePlanCache,
} from './storage.js';
import { getPlan } from './crud-plans.js';
import { writePlan } from './crud-content.js';
import { writeFlag } from './crud-flags.js';

// ─── Exercise parsing ───

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

// ─── Weak points & review ───

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
  if (!plan || !plan.topics) return [];

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
export async function updateExamResults(planId, examId, results) {
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

// ─── Teaching errors & quick quiz ───

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
export function saveQuickQuizResults(planId, quizData) {
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
