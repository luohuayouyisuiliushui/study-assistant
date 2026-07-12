/**
 * Data-layer — barrel re-export.
 *
 * Persistence primitives live in store/storage.js.
 * CRUD operations live in store/crud.js.
 */

export {
  listPlans, getPlan, createPlan, createPlanWithPhases,
  deletePlan, permanentlyDeletePlan, deletePlansByIds,
  trashPlan, listTrash, restorePlan, permanentlyDeleteTrash, emptyTrash, cleanExpiredTrash,
  getTopicChildren, getTopicPrerequisites, getTopicDescendants,
  buildKnowledgeGraph, extractRelationsFromDetail, buildInferredEdges, buildEnhancedKnowledgeGraph,
  addTopics, updateTopic, updateTopicTime, reorderTopics, removeTopic,
  addHistory, getTopicHistory,
  parseExercisesFromDetail, extractWeakPoints, getTopicsNeedingReview, buildLearningProfile,
  addExamPaper, getExamPapers, updateExamResults, deleteExamPaper,
  recordTeachingErrors, saveCoreAnalysis, writeFlag, readFlags, clearFlag,
  saveQuickQuizResults,
} from './store/crud.js';
