/**
 * Data-layer — barrel re-export.
 *
 * Persistence primitives live in store/storage.js.
 * CRUD operations live in store/crud.js.
 */

export {
  listPlans, scanStoredPlans, pruneMissingPlanIndexEntries,
  getPlan, createPlan, createPlanWithPhases,
  deletePlan, permanentlyDeletePlan, deletePlansByIds,
  trashPlan, listTrash, restorePlan, permanentlyDeleteTrash, emptyTrash, cleanExpiredTrash,
  getTopicChildren, getTopicPrerequisites, getTopicDescendants,
  buildKnowledgeGraph, extractRelationsFromDetail, buildInferredEdges, buildEnhancedKnowledgeGraph,
  addTopics, updateTopic, updateTopicTime, undoneTopic, reorderTopics, removeTopic,
  writePlan,
  addHistory, getTopicHistory,
  parseExercisesFromDetail, extractWeakPoints, getTopicsNeedingReview, buildLearningProfile,
  addExamPaper, getExamPapers, updateExamResults, deleteExamPaper,
  recordTeachingErrors, saveCoreAnalysis, writeFlag, readFlags, clearFlag,
  saveQuickQuizResults,
  appendGenerationFeedback,
  applyMasteryOutcome, saveExerciseResults, saveFeynmanResults,
  getTodayReviewQueue, saveReviewSession, saveReviewResults, dismissTopicMistake,
} from './store/crud.js';
