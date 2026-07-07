/**
 * Data-layer — barrel re-export (v1.5.0 modular split).
 *
 * Originally a 51 KB monolith. Internal helpers preserved in store/core.js
 * for reference. All functionality lives in store/crud.js.
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
  recordTeachingErrors,
} from './store/crud.js';
