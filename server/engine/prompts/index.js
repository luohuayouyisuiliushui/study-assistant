/**
 * Prompt templates — barrel re-export.
 * 
 * Originally a single 65 KB file (learn-prompts.js), now split into focused modules:
 *   detail.js     — STABLE_DETAIL, STABLE_FOLLOWUP, STABLE_REVIEW, exercises, exams
 *   common.js     — buildDeterministicContext, buildDetailMessages, buildFollowUpMessages
 *   import.js     — IMPORT_PLAN_PROMPT
 *   analysis.js   — ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT
 *   interactive.js— STABLE_INTERACTIVE_STEPWISE, STABLE_INTERACTIVE_REALTIME
 *   teaching.js   — MISCONCEPTION_TAXONOMY, teaching errors, challenge/scaffold
 */

export {
  STABLE_DETAIL_SYSTEM_PROMPT,
  STABLE_FOLLOWUP_SYSTEM_PROMPT,
  STABLE_REVIEW_SYSTEM_PROMPT,
  STABLE_EXERCISE_GRADING_PROMPT,
  STABLE_WEAK_POINT_PROMPT,
  STABLE_EXAM_GENERATION_PROMPT,
  STABLE_EXAM_GRADING_PROMPT,
  STABLE_EXAM_BLUEPRINT_PROMPT,
  STABLE_EXAM_SINGLE_QUESTION_PROMPT,
  STABLE_EXAM_SELF_CORRECT_PROMPT,
  STABLE_EXAM_QUALITY_EVAL_PROMPT,
} from './detail.js';

export {
  buildDeterministicContext,
  buildDetailMessages,
  buildFollowUpMessages,
  getDetailSystemPrompt,
  getFollowUpSystemPrompt,
} from './common.js';

export { IMPORT_PLAN_PROMPT } from './import.js';
export { ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT } from './analysis.js';

export {
  STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT,
} from './interactive.js';

export {
  MISCONCEPTION_TAXONOMY,
  buildTeachingErrorSpec,
  STABLE_TEACHING_ERROR_EXAM_PROMPT,
  STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT,
} from './teaching.js';
