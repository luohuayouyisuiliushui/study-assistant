/**
 * Adaptive Learning Engine — Error State Machine + Personalized Prompt Injection.
 *
 * === DESIGN ===
 *
 * Three sub-modules:
 * 1. ErrorStateMachine — tracks per-concept error frequency across exercises,
 *    exams, and weak-point analyses; triggers intervention when threshold crossed.
 * 2. AdaptivePromptInjector — takes the user profile and injects personalized
 *    teaching adjustments into the standard prompt context.
 * 3. InterventionRecommender — given a plan, identifies which topics need
 *    attention and what kind (review, reteach, simplify, challenge).
 *
 * === DATA FLYWHEEL ===
 *
 * The key insight from [[strategic-moat-analysis]]: user profile data must
 * feed back into the prompt strategy. Without this, the AI treats every user
 * identically — a generic ChatGPT wrapper. With it, the system learns the
 * === DATA FLYWHEEL (v1.6.1) ===
 *
 *   generateDetail() → injects adaptive context from AdaptivePromptInjector
 *          ↓
 *   User completes exercises / asks questions
 *          ↓
 *   profileUpdater() incremental-updates the profile from behavior data
 *          ↓
 *   Next generateDetail() → uses updated profile → better personalization
 *
 * This is what turns the system from a generic AI wrapper into a learning
 * system that actually adapts to the individual user over time.
 */

import { getUserProfile, profileUpdater, writeUserProfile } from './user-profile.js';

// ─── Constants ───

/** Number of same-concept errors before triggering intervention */
const ERROR_THRESHOLD = 3;

/** Maximum number of intervention suggestions per topic */
const MAX_INTERVENTIONS = 4;

/** Error types we track */
const ERROR_SOURCES = {
  EXERCISE: 'exercise',
  EXAM: 'exam',
  WEAK_POINT: 'weakPoint',
  FEYNMAN_GAP: 'feynmanGap',
  TEACHING_ERROR_UNRECOGNIZED: 'teachingErrorUnrecognized',
};

// ═══════════════════════════════════════════════════════
//  PART 1: ERROR STATE MACHINE
// ═══════════════════════════════════════════════════════

/**
 * ErrorStateMachine — tracks error frequency per concept and triggers
 * state transitions when thresholds are crossed.
 *
 * States per concept:
 *   IDLE → WATCHING (1-2 errors) → INTERVENTION_NEEDED (3+ errors) → RESOLVED (corrected)
 */
export class ErrorStateMachine {
  constructor(plan) {
    this._planId = plan?.id || '';
    this._conceptErrors = new Map(); // conceptTag → { count, sources, lastErrorAt, state }
    this._stateTransitions = [];      // [{ concept, from, to, at }]
  }

  /**
   * Record an error for a concept and check if threshold is crossed.
   * @param {string} conceptTag - The concept/topic this error relates to
   * @param {string} source - One of ERROR_SOURCES
   * @param {string} [detail] - What the user got wrong
   * @returns {{ state: string, thresholdCrossed: boolean, count: number }}
   */
  recordError(conceptTag, source, detail = '') {
    if (!conceptTag) return { state: 'IDLE', thresholdCrossed: false, count: 0 };

    const key = conceptTag.trim().toLowerCase();
    let entry = this._conceptErrors.get(key);

    if (!entry) {
      entry = {
        concept: conceptTag,
        count: 0,
        sources: [],
        detail,
        firstErrorAt: Date.now(),
        lastErrorAt: Date.now(),
        state: 'IDLE',
      };
    }

    const prevState = entry.state;
    entry.count++;
    entry.sources.push(source);
    entry.lastErrorAt = Date.now();
    entry.detail = detail || entry.detail;

    // State transitions
    if (entry.count === 1) {
      entry.state = 'WATCHING';
    } else if (entry.count === 2) {
      entry.state = 'WATCHING'; // still watching, but getting closer
    } else if (entry.count >= ERROR_THRESHOLD) {
      entry.state = 'INTERVENTION_NEEDED';
    }

    if (entry.state !== prevState) {
      this._stateTransitions.push({
        concept: conceptTag,
        from: prevState,
        to: entry.state,
        at: Date.now(),
      });
    }

    this._conceptErrors.set(key, entry);

    return {
      state: entry.state,
      thresholdCrossed: entry.count >= ERROR_THRESHOLD && prevState !== 'INTERVENTION_NEEDED',
      count: entry.count,
    };
  }

  /**
   * Mark a concept as resolved (user demonstrated understanding).
   */
  resolveConcept(conceptTag) {
    const key = conceptTag.trim().toLowerCase();
    const entry = this._conceptErrors.get(key);
    if (entry) {
      const prev = entry.state;
      entry.state = 'RESOLVED';
      entry.resolvedAt = Date.now();
      this._stateTransitions.push({ concept: conceptTag, from: prev, to: 'RESOLVED', at: Date.now() });
    }
  }

  /**
   * Get all concepts currently in INTERVENTION_NEEDED state.
   */
  get interventionNeeded() {
    const results = [];
    for (const [, entry] of this._conceptErrors) {
      if (entry.state === 'INTERVENTION_NEEDED') {
        results.push({ ...entry });
      }
    }
    return results.sort((a, b) => b.count - a.count); // most errors first
  }

  /**
   * Get all concepts being watched.
   */
  get watching() {
    const results = [];
    for (const [, entry] of this._conceptErrors) {
      if (entry.state === 'WATCHING') {
        results.push({ ...entry });
      }
    }
    return results.sort((a, b) => b.count - a.count);
  }

  /**
   * Get full state summary.
   */
  get summary() {
    const all = [...this._conceptErrors.values()];
    return {
      totalConcepts: all.length,
      interventionNeeded: all.filter(e => e.state === 'INTERVENTION_NEEDED').length,
      watching: all.filter(e => e.state === 'WATCHING').length,
      resolved: all.filter(e => e.state === 'RESOLVED').length,
      transitions: this._stateTransitions.length,
    };
  }

  /**
   * Build the error state machine from a plan's existing data.
   * Scans exercises, exam results, weak points, and teaching errors.
   */
  static fromPlan(plan) {
    const sm = new ErrorStateMachine(plan);

    if (!plan || !plan.topics) return sm;

    for (const topic of plan.topics) {
      // Exercise errors
      if (topic.exercises) {
        for (const ex of topic.exercises) {
          if (ex.correct === false && ex.conceptTag) {
            sm.recordError(ex.conceptTag, ERROR_SOURCES.EXERCISE, ex.question);
          }
        }
      }

      // Weak points (AI-identified)
      if (topic.weakPoints) {
        for (const wp of topic.weakPoints) {
          sm.recordError(wp, ERROR_SOURCES.WEAK_POINT, topic.title);
        }
      }

      // Unrecognized teaching errors
      if (topic.teachingErrors) {
        for (const te of topic.teachingErrors) {
          if (te && te.recognized === false) {
            sm.recordError(
              te.misconception || te.description || topic.title,
              ERROR_SOURCES.TEACHING_ERROR_UNRECOGNIZED,
              te.description || ''
            );
          }
        }
      }

      // Feynman gaps — knowledge gaps identified during Feynman teaching sessions
      if (topic.feynmanInsights && topic.feynmanInsights.gaps) {
        for (const gap of topic.feynmanInsights.gaps) {
          if (gap) {
            sm.recordError(gap, ERROR_SOURCES.FEYNMAN_GAP, topic.title);
          }
        }
      }
    }

    // Exam errors
    if (plan.examPapers) {
      for (const exam of plan.examPapers) {
        if (!exam.results || !exam.questions) continue;
        for (const result of exam.results) {
          if (result.correct === false) {
            const q = exam.questions[result.exerciseIndex];
            if (q?.conceptTag) {
              sm.recordError(q.conceptTag, ERROR_SOURCES.EXAM, q.question);
            }
          }
        }
      }
    }

    return sm;
  }
}

// ═══════════════════════════════════════════════════════
//  PART 2: ADAPTIVE PROMPT INJECTOR
// ═══════════════════════════════════════════════════════

/**
 * AdaptivePromptInjector — enriches the deterministic context digest with
 * personalized teaching adjustments derived from the user profile.
 *
 * This is the DATA FLYWHEEL: profile data → injected into prompt → better
 * personalization → more data → better profile.
 */
export class AdaptivePromptInjector {
  /**
   * @param {object|null} userProfile - From getUserProfile() or null
   */
  constructor(userProfile) {
    this._profile = userProfile;
  }

  /**
   * Build an "adaptive preamble" string to inject into the context digest.
   * This tells the AI tutor: "this is who you're teaching, adjust accordingly."
   *
   * @returns {string} Adaptive context block (Markdown), or empty string if no profile
   */
  buildAdaptiveContext() {
    if (!this._profile) return '';

    const persona = this._profile.learnerPersona;
    if (!persona || !persona.type || persona.type.length === 0) return '';

    const lines = ['', '=== 学习者自适应指导（根据用户画像自动生成）==='];

    // Learner type → teaching strategy hints
    lines.push('学习者类型: ' + persona.type.join('、'));
    lines.push('画像摘要: ' + (persona.summary || '未知'));

    // Map learner types to teaching hints
    const hints = [];
    for (const t of persona.type) {
      if (t.includes('深度思考')) hints.push('- 多讲解"为什么"，展示因果推导链，不要停留在操作层面');
      if (t.includes('实践应用')) hints.push('- 多提供可运行的代码示例和实际应用场景');
      if (t.includes('类比联想')) hints.push('- 多用类比和对比，主动关联已学知识点');
      if (t.includes('谨慎确认')) hints.push('- 每讲完一个子概念后主动确认理解，提供"我理解得对吗？"式的检查点');
      if (t.includes('目标驱动')) hints.push('- 先给出核心结论再展开细节，避免冗长的背景铺垫');
      if (t.includes('视觉感知')) hints.push('- 优先使用Mermaid图表、流程图、时序图来展示概念');
    }
    if (hints.length > 0) {
      lines.push('教学策略调整:');
      lines.push(hints.join('\n'));
    }

    // Strengths → skip or accelerate these
    if (this._profile.strengths && this._profile.strengths.length > 0) {
      const strongDomains = this._profile.strengths
        .filter(s => s.masteryLevel >= 0.8)
        .map(s => s.domain);
      if (strongDomains.length > 0) {
        lines.push('已掌握领域: ' + strongDomains.join('、') + ' — 对这些领域的知识点可以简要提及，不需要详细展开');
      }
    }

    // Weaknesses → spend more time here
    if (this._profile.weaknesses && this._profile.weaknesses.length > 0) {
      const weakDomains = this._profile.weaknesses
        .filter(w => w.masteryLevel < 0.6)
        .map(w => w.domain + (w.suggestedAction ? '（建议：' + w.suggestedAction + '）' : ''));
      if (weakDomains.length > 0) {
        lines.push('薄弱领域: ' + weakDomains.join('、') + ' — 这些概念需要更详细的讲解和更多的练习');
      }
    }

    // Cross-plan weak points
    if (this._profile.crossPlanWeakPoints && this._profile.crossPlanWeakPoints.length > 0) {
      const top = this._profile.crossPlanWeakPoints.slice(0, 5);
      lines.push('跨计划反复薄弱点: ' + top.join('、') + ' — 当前知识点如果与这些薄弱点相关，注意加强讲解');
    }

    // Learning pattern hints
    const patterns = this._profile.learningPatterns;
    if (patterns) {
      if (patterns.questionStyle) {
        lines.push('用户提问风格: ' + patterns.questionStyle);
      }
      if (patterns.avgQuestionsPerTopic > 0) {
        lines.push(`用户平均每个知识点提问 ${patterns.avgQuestionsPerTopic} 次 — ${patterns.avgQuestionsPerTopic > 3 ? '喜欢深入追问，可以准备更多细节' : '倾向于被动接受，可以多引导提问'}`);
      }
    }

    // Recommendations from previous analysis
    if (this._profile.recommendations && this._profile.recommendations.length > 0) {
      lines.push('历史学习建议:');
      for (const rec of this._profile.recommendations.slice(0, 3)) {
        lines.push('- ' + rec);
      }
    }

    return lines.join('\n');
  }

  /**
   * Quick check: do we have enough profile data for meaningful personalization?
   */
  get hasMeaningfulProfile() {
    if (!this._profile) return false;
    const persona = this._profile.learnerPersona;
    return !!(persona && persona.type && persona.type.length > 0);
  }

  /**
   * Get a compact (1-line) hint for light-weight personalization.
   * Suitable for use in quick prompts where the full context would be too large.
   */
  get compactHint() {
    if (!this._profile?.learnerPersona?.type) return '';
    const types = this._profile.learnerPersona.type.join('、');
    return `[学习者类型: ${types}]`;
  }
}

// ═══════════════════════════════════════════════════════
//  PART 3: INTERVENTION RECOMMENDER
// ═══════════════════════════════════════════════════════

/**
 * InterventionRecommender — given a plan and its error state machine,
 * recommend specific interventions for topics that need attention.
 *
 * Intervention types:
 *   - 'review'       — Generate a targeted review (use generateReview)
 *   - 'reteach'      — Re-generate the detail with a different angle
 *   - 'simplify'     — Decompose into smaller sub-topics
 *   - 'challenge'    — Generate harder practice questions
 *   - 'feynman'      — Suggest the user teach this concept back
 */
export class InterventionRecommender {
  /**
   * @param {object} plan - The learning plan
   * @param {ErrorStateMachine} stateMachine - Error state machine for this plan
   * @param {AdaptivePromptInjector} [injector] - Adaptive prompt hints
   */
  constructor(plan, stateMachine, injector) {
    this._plan = plan;
    this._sm = stateMachine;
    this._injector = injector || null;
  }

  /**
   * Analyze the plan and recommend interventions.
   * @returns {Array} Sorted intervention recommendations (most urgent first)
   */
  recommend() {
    const recommendations = [];

    if (!this._plan || !this._plan.topics) return recommendations;

    const interventionConcepts = new Map();
    for (const entry of this._sm.interventionNeeded) {
      interventionConcepts.set(entry.concept.trim().toLowerCase(), entry);
    }

    for (const topic of this._plan.topics) {
      if (!topic.done) continue;

      const recs = this._recommendForTopic(topic, interventionConcepts);
      recommendations.push(...recs);
    }

    // Sort: intervention_needed first, then by error count desc
    recommendations.sort((a, b) => {
      if (a.urgency !== b.urgency) {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        return order[a.urgency] - order[b.urgency];
      }
      return (b.errorCount || 0) - (a.errorCount || 0);
    });

    // Limit to avoid overwhelming
    return recommendations.slice(0, MAX_INTERVENTIONS * 3);
  }

  _recommendForTopic(topic, interventionConcepts) {
    const recs = [];

    // Check if any of this topic's conceptTags are in intervention
    const exerciseConcepts = (topic.exercises || [])
      .filter(e => e.correct === false)
      .map(e => e.conceptTag);

    const allConcepts = new Set([
      ...exerciseConcepts,
      ...(topic.weakPoints || []),
      ...((topic.teachingErrors || []).filter(e => e?.recognized === false).map(e => e.misconception || '')),
      ...((topic.feynmanInsights?.gaps || []).filter(Boolean)),
    ]);

    let maxErrorCount = 0;
    let needsReview = false;
    let needsReteach = false;
    let needsSimplify = false;

    for (const concept of allConcepts) {
      const key = concept.trim().toLowerCase();
      const entry = interventionConcepts.get(key);
      if (entry) {
        maxErrorCount = Math.max(maxErrorCount, entry.count);
        if (entry.count >= ERROR_THRESHOLD) {
          needsReview = true;
          if (entry.count >= ERROR_THRESHOLD + 2) {
            needsReteach = true;
          }
          if (entry.count >= ERROR_THRESHOLD + 3) {
            needsSimplify = true;
          }
        }
      }
    }

    // Also check weakPoints + exercise errors independent of intervention state
    const exerciseErrorCount = (topic.exercises || []).filter(e => e.correct === false).length;
    const weakPointCount = (topic.weakPoints || []).length;
    const unrecognizedErrors = (topic.teachingErrors || []).filter(e => e?.recognized === false).length;
    const feynmanGapCount = (topic.feynmanInsights?.gaps || []).length;

    const totalErrors = exerciseErrorCount + weakPointCount + unrecognizedErrors + feynmanGapCount;

    if (totalErrors > 0) {
      recs.push({
        topicId: topic.id,
        topicTitle: topic.title,
        errorCount: totalErrors,
        exerciseErrors: exerciseErrorCount,
        weakPoints: weakPointCount,
        unrecognizedErrors,
        feynmanGaps: feynmanGapCount,
        urgency: totalErrors >= 5 ? 'critical' : totalErrors >= 3 ? 'high' : totalErrors >= 1 ? 'medium' : 'low',
        interventions: [],
      });

      const rec = recs[recs.length - 1]; // last pushed

      // Review: always recommended when there are errors
      if (needsReview || exerciseErrorCount > 0 || weakPointCount > 0) {
        rec.interventions.push({
          type: 'review',
          priority: 'high',
          description: '针对性复习：重点回顾薄弱概念',
          action: 'POST /api/learn/plans/:id/review/:topicId',
        });
      }

      // Reteach: when same concept has many errors
      if (needsReteach) {
        rec.interventions.push({
          type: 'reteach',
          priority: 'high',
          description: '重新生成讲解内容（使用不同角度/更简单的语言）',
          action: 'POST /api/learn/plans/:id/generate/:topicId (with adaptive hints)',
        });
      }

      // Simplify: when user is really stuck
      if (needsSimplify) {
        rec.interventions.push({
          type: 'simplify',
          priority: 'medium',
          description: '将知识点拆分为更小的子知识点逐步学习',
          action: 'POST /api/learn/plans/:id/decompose/:topicId',
        });
      }

      // Challenge: for concepts with mild errors (apply testing effect)
      if (exerciseErrorCount > 0 && exerciseErrorCount < 3) {
        rec.interventions.push({
          type: 'challenge',
          priority: 'low',
          description: '额外针对性练习（基于错题生成）',
          action: 'POST /api/learn/plans/:id/exam/:examId/practice',
        });
      }

      // Feynman: for teaching errors the student didn't catch
      if (unrecognizedErrors > 0) {
        rec.interventions.push({
          type: 'feynman',
          priority: 'medium',
          description: '费曼学习法：尝试向AI讲解这个知识点来检验理解',
          action: 'POST /api/learn/plans/:id/interactive-start/:topicId (mode=feynman)',
        });
      }

      // Feynman gaps: knowledge gaps identified during Feynman sessions
      if (feynmanGapCount > 0) {
        rec.interventions.push({
          type: 'reteach',
          priority: 'medium',
          description: `费曼教学法发现了 ${feynmanGapCount} 个知识缺口，建议重新学习这些部分`,
          action: 'POST /api/learn/plans/:id/review/:topicId',
        });
      }

      // Prune to max interventions per topic
      if (rec.interventions.length > MAX_INTERVENTIONS) {
        rec.interventions = rec.interventions
          .sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return order[a.priority] - order[b.priority];
          })
          .slice(0, MAX_INTERVENTIONS);
      }
    }

    return recs;
  }

  /**
   * Build a one-line summary for the UI.
   */
  buildSummary(recommendations) {
    if (!recommendations || recommendations.length === 0) {
      return '✅ 当前没有需要特别关注的知识点';
    }

    const criticalCount = recommendations.filter(r => r.urgency === 'critical').length;
    const highCount = recommendations.filter(r => r.urgency === 'high').length;
    const totalRecs = recommendations.reduce((sum, r) => sum + r.interventions.length, 0);

    const parts = [];
    if (criticalCount > 0) parts.push(`${criticalCount} 个知识点需要紧急关注`);
    if (highCount > 0) parts.push(`${highCount} 个知识点建议复习`);
    parts.push(`共 ${totalRecs} 个推荐操作`);

    return '🟡 ' + parts.join('，');
  }
}

// ═══════════════════════════════════════════════════════
//  PART 4: CONVENIENCE FACTORY
// ═══════════════════════════════════════════════════════

/**
 * Build a complete adaptive analysis for a plan.
 * One call does: error state machine + adaptive context + intervention recommendations.
 *
 * @param {object} plan - The learning plan
 * @param {string} [profilePath] - Path to user profile file (default: auto-detect)
 * @returns {{ stateMachine: ErrorStateMachine, injector: AdaptivePromptInjector, recommender: InterventionRecommender, recommendations: Array, adaptiveContext: string }}
 */
export function analyzePlanAdaptive(plan) {
  const stateMachine = ErrorStateMachine.fromPlan(plan);
  const userProfile = getUserProfile();
  const injector = new AdaptivePromptInjector(userProfile);
  const recommender = new InterventionRecommender(plan, stateMachine, injector);
  const recommendations = recommender.recommend();
  const adaptiveContext = injector.buildAdaptiveContext();

  return {
    stateMachine,
    injector,
    recommender,
    recommendations,
    adaptiveContext,
    summary: {
      stateMachine: stateMachine.summary,
      interventionCount: recommendations.length,
      topRecommendations: recommendations.slice(0, 5).map(r => ({
        topicTitle: r.topicTitle,
        urgency: r.urgency,
        errorCount: r.errorCount,
        suggestions: r.interventions.map(i => i.type),
      })),
    },
  };
}

// ═══════════════════════════════════════════════════════
//  PART 5: DATA FLYWHEEL — CLOSE THE LOOP
// ═══════════════════════════════════════════════════════

/**
 * Run the data flywheel after a user has completed exercises or taken an exam.
 *
 * This is the KEY function that closes the loop:
 *   1. Load the current user profile (or create one from aggregated plan data)
 *   2. Apply profileUpdater to incorporate the latest exercise + question data
 *   3. Build a new AdaptivePromptInjector with the updated profile
 *   4. Return the updated injector so the next generateDetail() gets
 *      personalized hints that reflect the user's latest behavior patterns
 *
 * Call sites:
 *   - After gradeExercises() returns
 *   - After gradeExam() returns
 *   - After analyzeWeakPoints() returns
 *
 * This is a PURE computation (no AI call) — it updates the profile structure
 * in memory so the next AI call can benefit from the behavioral feedback.
 *
 * @param {Array} allPlans - All learning plans (from store.listPlans())
 * @returns {AdaptivePromptInjector} An injector with freshly-updated profile
 */
export function dataFlywheelUpdate(allPlans) {
  const currentProfile = getUserProfile();
  const updatedProfile = profileUpdater(currentProfile, allPlans);
  if (currentProfile) {
    writeUserProfile(updatedProfile);
  }
  return new AdaptivePromptInjector(updatedProfile);
}

/**
 * Get a profile-aware AdaptivePromptInjector for the current session.
 * Uses the stored profile if available, otherwise falls back to a skeleton.
 * This should be called BEFORE every generateDetail() to pick up the latest
 * flywheel-updated profile.
 *
 * @returns {AdaptivePromptInjector}
 */
export function getCurrentInjector() {
  const profile = getUserProfile();
  return new AdaptivePromptInjector(profile || null);
}

export default {
  ErrorStateMachine,
  AdaptivePromptInjector,
  InterventionRecommender,
  analyzePlanAdaptive,
  dataFlywheelUpdate,
  getCurrentInjector,
  ERROR_SOURCES,
};
