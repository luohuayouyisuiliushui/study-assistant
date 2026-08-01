/**
 * Data-layer — barrel re-export.
 *
 * Persistence primitives live in store/storage.js.
 * CRUD operations are grouped by domain in store/crud-*.js.
 */

export { isValidPlanId } from './store/storage.js';

export {
  listPlans, scanStoredPlans, pruneMissingPlanIndexEntries,
  getPlan, createPlan,
  deletePlan, permanentlyDeletePlan, deletePlansByIds,
} from './store/crud-plans.js';

export {
  trashPlan, listTrash, restorePlan, permanentlyDeleteTrash, emptyTrash, cleanExpiredTrash,
} from './store/crud-trash.js';

export {
  getTopicChildren, getTopicPrerequisites, getTopicDescendants,
  buildKnowledgeGraph, extractRelationsFromDetail, buildInferredEdges, buildEnhancedKnowledgeGraph, computeGraphCentrality,
} from './store/crud-graph.js';

export {
  addTopics, updateTopic, updateTopicTime, appendWeakPoint, reorderTopics, removeTopic,
  createPlanWithPhases,
  writePlan,
  addHistory, getTopicHistory,
  buildLearningProfile,
  saveCoreAnalysis,
} from './store/crud-content.js';

export {
  parseExercisesFromDetail, extractWeakPoints, getTopicsNeedingReview,
  addExamPaper, getExamPapers, updateExamResults, deleteExamPaper,
  recordTeachingErrors,
  saveQuickQuizResults,
  appendGenerationFeedback,
} from './store/crud-exercises.js';

export { writeFlag, readFlags, clearFlag } from './store/crud-flags.js';

export {
  MASTERY_BACKUP_SCHEMA_VERSION,
  getMasteryState,
  appendTopicMasteryEvidence,
  saveExerciseAssessment,
  saveExamAssessment,
  saveQuickQuizAssessment,
  saveFeynmanAssessment,
  createOrResumeReviewSession,
  createOrResumeMistakeRepairSession,
  submitTopicReviewSession,
  deferTopicReview,
  dismissTopicMistake,
  getTodayReview,
  getMasteryMetrics,
  createMasteryBackup,
  previewMasteryRestore,
  restoreMasteryBackup,
} from './store/crud-mastery.js';
