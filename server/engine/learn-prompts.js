/**
 * Prompt templates for the knowledge-point learning assistant.
 *
 * === CACHE-OPTIMIZED DESIGN ===
 *
 * Instead of injecting variable context into the system prompt
 * (which makes EVERY call have a different cache prefix), we split into:
 *
 *   [STABLE_SYSTEM_PROMPT] + [DETERMINISTIC_CONTEXT] + [USER_MESSAGE]
 *
 * - STABLE_SYSTEM_PROMPT: perfectly fixed string, never changes
 * - DETERMINISTIC_CONTEXT: formatted deterministically — same state → same output
 * - USER_MESSAGE: the variable part (question), which is at the END of prefix
 *
 * This way, as long as the plan structure hasn't changed, the FIRST 2 messages
 * are IDENTICAL across calls → high cache hit rate.
 *
 * === MODULAR STRUCTURE (v1.5.0) ===
 *
 * Originally a single 65 KB file, now split into focused modules under prompts/:
 *   prompts/detail.js      — STABLE_DETAIL, STABLE_FOLLOWUP, STABLE_REVIEW, exercises, exams
 *   prompts/common.js      — buildDeterministicContext, buildDetailMessages, buildFollowUpMessages
 *   prompts/import.js      — IMPORT_PLAN_PROMPT
 *   prompts/analysis.js    — ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT
 *   prompts/interactive.js — STABLE_INTERACTIVE_STEPWISE, STABLE_INTERACTIVE_REALTIME
 *   prompts/teaching.js    — MISCONCEPTION_TAXONOMY, teaching errors, challenge/scaffold
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
  buildDeterministicContext,
  buildDetailMessages,
  buildFollowUpMessages,
  getDetailSystemPrompt,
  getFollowUpSystemPrompt,
  IMPORT_PLAN_PROMPT,
  ANALYSIS_SYSTEM_PROMPT,
  ANALYSIS_FOLLOWUP_PROMPT,
  STABLE_INTERACTIVE_STEPWISE_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_REALTIME_SYSTEM_PROMPT,
  MISCONCEPTION_TAXONOMY,
  buildTeachingErrorSpec,
  STABLE_TEACHING_ERROR_EXAM_PROMPT,
  STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT,
  STABLE_INTERACTIVE_SCAFFOLD_SYSTEM_PROMPT,
} from './prompts/index.js';
