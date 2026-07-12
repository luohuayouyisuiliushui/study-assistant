/**
 * Learning analyzer: Q&A, progress analysis, review generation, exercises grading,
 * weak point detection, quick quiz, and Feynman session analysis.
 */

import { Provider } from './provider.js';
import { AdaptivePromptInjector } from './adaptive-engine.js';
import { buildLearningProfile, parseExercisesFromDetail, getTopicHistory } from './learn-store.js';
import {
  STABLE_REVIEW_SYSTEM_PROMPT, STABLE_EXERCISE_GRADING_PROMPT,
  STABLE_WEAK_POINT_PROMPT, FEYNMAN_ANALYSIS_PROMPT,
  ANALYSIS_SYSTEM_PROMPT, ANALYSIS_FOLLOWUP_PROMPT,
  CORE_TOPIC_SYSTEM_PROMPT, QUICK_QUIZ_PROMPT,
  buildFollowUpMessages, buildDeterministicContext,
} from './learn-prompts.js';
import { getUserProfile } from './user-profile.js';
import { resolveProvider } from './learn-engine.js';

export async function answerFollowUp(providerOrConfig, plan, topicId, question, model = 'gpt-4o-mini') {
  if (!question || !question.trim()) throw new Error('问题不能为空');
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  await addHistory(plan.id, topicId, 'user', question);

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  try {
    const messages = buildFollowUpMessages(plan, topicId, question);

    engineCacheMonitor.recordShape(messages, 'answerFollowUp:' + topicId.slice(0, 8));

    const result = await provider.complete(messages, {
      maxTokens: 4096,
    });

    engineCacheMonitor.recordUsage(result.usage, 'answerFollowUp:' + topicId.slice(0, 8));

    const answer = result.content || '（无法生成回复）';
    await addHistory(plan.id, topicId, 'ai', answer);
    return answer;
  } catch (err) {
    console.error('[answerFollowUp]', err);
    const errMsg = '回答失败: ' + err.message;
    await addHistory(plan.id, topicId, 'ai', errMsg);
    throw err;
  }
}

/**
 * Analyze learning progress and generate personalized insights using AI.
 * Combines structured learning profile + Q&A history for deep analysis.
 */
export async function analyzeLearning(provider, plan, model = 'gpt-4o-mini', analysisChat = []) {
  const profile = buildLearningProfile(plan);

  // Collect recent Q&A per topic (up to 3 most recent questions each)
  const topicQAs = [];
  for (const topic of plan.topics) {
    const history = (plan.history || []).filter(h => h.topicId === topic.id);
    const pairs = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
        pairs.push({ q: history[i].content.slice(0, 300), a: '...' });
        i++;
      }
    }
    if (pairs.length > 0) {
      topicQAs.push({
        topic: topic.title,
        done: topic.done,
        questionCount: pairs.length,
        recentQuestions: pairs.slice(-3).map(p => p.q),
      });
    }
  }

  const analysisData = JSON.stringify({ profile, topicQAs }, null, 2);
  let userContent = '以下是我的学习数据，请进行分析：\n\n```json\n' + analysisData + '\n```';

  // Include previous analysis chat as subjective data context
  if (analysisChat && analysisChat.length > 0) {
    const chatLog = analysisChat
      .filter(m => m.role && m.content)
      .map(m => (m.role === 'user' ? '用户: ' : '助手: ') + m.content.slice(0, 500))
      .join('\n');
    userContent += '\n\n## 之前的分析追问记录（主观数据）\n\n' + chatLog;
    userContent += '\n\n（注：以上是用户对上一次分析报告的追问记录，属于主观数据，请按分析原则区分对待）';
  }

  const messages = [
    { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const result = await provider.complete(messages, { maxTokens: 6144, temperature: 0.7 });

  return {
    analysis: result.content,
    usage: result.usage,
    analyzedAt: Date.now(),
    topicCount: plan.topics.length,
    doneCount: plan.topics.filter(t => t.done).length,
    totalQuestions: plan.history.filter(h => h.role === 'user').length,
  };
}

/**
 * Answer a follow-up question about a learning analysis.
 */
export async function answerAnalysisFollowUp(provider, plan, analysis, question, model) {
  const analysisData = JSON.stringify({
    profile: buildLearningProfile(plan),
    planName: plan.name,
    topicCount: plan.topics.length,
    doneCount: plan.topics.filter(t => t.done).length,
  }, null, 2);

  const messages = [
    { role: 'system', content: ANALYSIS_FOLLOWUP_PROMPT },
    { role: 'user', content: '## 学习分析报告\n\n' + analysis },
    { role: 'user', content: '## 学习数据\n\n```json\n' + analysisData + '\n```' },
    { role: 'user', content: '## 我的追问\n\n' + question },
  ];

  return provider.complete(messages, { maxTokens: 2048, temperature: 0.7, model });
}

/**
 * Analyze a plan's topics to identify the core ~20% using the Pareto principle.
 * Uses AI to determine which topics are most important.
 * Results are cached on the plan for reuse.
 */
export async function analyzeCoreTopics(provider, plan, model = 'gpt-4o-mini', { force = false } = {}) {
  if (!force && plan.coreAnalysis && plan.coreAnalysis.analyzedAt) {
    return {
      coreTopics: plan.coreAnalysis.coreTopics || [],
      summary: plan.coreAnalysis.summary || '',
      corePrinciple: plan.coreAnalysis.corePrinciple || '',
      analyzedAt: plan.coreAnalysis.analyzedAt,
    };
  }

  // Short-circuit for empty plans — no need to call AI
  if (!plan.topics || plan.topics.length < 2) {
    const emptyResult = { coreTopics: [], summary: plan.topics.length === 0 ? '暂无知识点，请先添加' : '知识点太少，至少需要 2 个才能分析核心 20%', corePrinciple: '', analyzedAt: Date.now() };
    try { await saveCoreAnalysis(plan.id, emptyResult); } catch {}
    return emptyResult;
  }

  const context = {
    planName: plan.name,
    phases: (plan.phases || []).map(p => ({ name: p.name })),
    topics: plan.topics.map(t => ({
      id: t.id, title: t.title, phaseId: t.phaseId,
      parentId: t.parentId, done: t.done, hasDetail: !!t.detail,
    })),
  };

  const messages = [
    { role: 'system', content: CORE_TOPIC_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(context, null, 2) },
  ];

  try {
    const result = await provider.complete(messages, {
      maxTokens: 8192,
      temperature: 0.3,
      responseFormat: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(result.content || '{}');
    } catch (parseErr) {
      // Try to recover truncated JSON by extracting the coreTopics array
      const content = result.content || '';
      console.warn('[analyzeCoreTopics] JSON parse failed, content length:', content.length, 'finishReason:', result.finishReason);
      console.warn('[analyzeCoreTopics] Content preview:', content.substring(0, 200));
      const match = content.match(/"coreTopics"\s*:\s*\[([\s\S]*)/);
      if (match) {
        try {
          parsed = { coreTopics: JSON.parse('[' + match[1].replace(/,\s*$/, '') + ']') };
        } catch {
          parsed = {};
        }
      } else {
        parsed = {};
      }
      // Also try to extract summary from the truncated content
      if (!parsed.summary) {
        const summaryMatch = content.match(/"summary"\s*:\s*"([^"]*)/);
        if (summaryMatch) parsed.summary = summaryMatch[1];
      }
    }
    const aiTopics = (parsed.coreTopics || []).filter(t => t.title);

    const coreTopics = aiTopics.map(aiTopic => {
      // Exact match first, then trimmed/normalized fallback
      let matched = plan.topics.find(t => t.title === aiTopic.title);
      if (!matched) {
        const normalized = aiTopic.title.trim().replace(/[，。、；：]/g, '').replace(/\s+/g, ' ');
        matched = plan.topics.find(t => t.title.trim().replace(/[，。、；：]/g, '').replace(/\s+/g, ' ') === normalized);
      }
      if (!matched) {
        console.warn('[analyzeCoreTopics] No match for AI-suggested topic: "' + aiTopic.title + '"');
      }
      return {
        topicId: matched ? matched.id : '',
        title: aiTopic.title,
        reasons: aiTopic.reasons || [],
        importance: aiTopic.importance || 'medium',
        coverage: aiTopic.coverage || '',
      };
    });

    const analysis = {
      coreTopics,
      summary: parsed.summary || '分析完成',
      corePrinciple: parsed.corePrinciple || '',
      analyzedAt: Date.now(),
    };

    // Only cache results with actual core topics — empty results may be transient AI failures
    if (coreTopics.length > 0) {
      try {
        await saveCoreAnalysis(plan.id, analysis);
        plan.coreAnalysis = analysis;
      } catch (storeErr) {
        console.warn('[analyzeCoreTopics] Failed to persist:', storeErr.message);
      }
    }

    return analysis;
  } catch (err) {
    console.warn('[analyzeCoreTopics] AI analysis failed:', err.message || err);
    console.warn('[analyzeCoreTopics] Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    return { coreTopics: [], summary: '核心分析暂不可用（' + (err.message || '未知错误') + '）', corePrinciple: '', analyzedAt: Date.now() };
  }
}

// ═══════════════════════════════════════════════════════
//  EXERCISE & REVIEW FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Generate a concise review for an already-learned knowledge point.
 * Focuses on weak points and provides targeted practice.
 */
export async function generateReview(providerOrConfig, plan, topicId, model = 'gpt-4o-mini') {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');
  if (!topic.detail) throw new Error('该知识点还没有讲解内容，无法生成复习');

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  // Build review context
  const weakPointsList = (topic.weakPoints && topic.weakPoints.length > 0)
    ? topic.weakPoints.join('、')
    : '无明确薄弱点（进行全面回顾）';

  // Collect exam errors for this topic
  let examErrorsText = '';
  if (plan.examPapers) {
    const examErrors = [];
    for (const exam of plan.examPapers) {
      if (!exam.results || !exam.questions) continue;
      for (const result of exam.results) {
        if (result.correct === false) {
          const q = exam.questions[result.exerciseIndex];
          if (q && q.topicId === topicId) {
            examErrors.push(`【${exam.title}】${q.question}（你的答案：${result.userAnswer}，正确答案：${result.correctAnswer}）`);
          }
        }
      }
    }
    if (examErrors.length > 0) {
      examErrorsText = '\n\n=== 试卷错题 ===\n' + examErrors.join('\n');
    }
  }


  // Collect recent Q&A for this topic (last 5 pairs)
  const history = getTopicHistory(plan, topicId);
  const pairs = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
      pairs.push({ q: history[i].content, a: history[i + 1].content });
      i++;
    }
  }
  const recentQa = pairs.slice(-5).map(p => `用户问: ${p.q}\n助手答: ${p.a.slice(0, 200)}`).join('\n\n');

  const context = [
    '=== 复习上下文 ===',
    examErrorsText,
    '知识点: ' + topic.title,
    '薄弱点: ' + weakPointsList,
    '',
    '=== 原讲解内容 ===',
    topic.detail.slice(0, 8000), // trim to fit context window
    '',
    '=== 近期追问记录 ===',
    recentQa || '无追问记录',
  ].join('\n');

  const messages = [
    { role: 'system', content: STABLE_REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: context },
  ];

  const result = await provider.complete(messages, { maxTokens: 4096, temperature: 0.5 });
  const reviewContent = result.content || '';

  // Save review to topic
  await updateTopic(plan.id, topicId, {
    reviewGenerated: reviewContent,
    reviewUpdatedAt: Date.now(),
  });
  topic.reviewGenerated = reviewContent;
  topic.reviewUpdatedAt = Date.now();

  return reviewContent;
}

/**
 * Grade user's exercise answers using AI.
 * @param {object} providerOrConfig - Provider or config
 * @param {object} plan - Plan object
 * @param {string} topicId - Topic ID
 * @param {Array} userAnswers - [{ exerciseIndex, userAnswer }, ...]
 * @returns {Array} Graded results
 */
export async function gradeExercises(providerOrConfig, plan, topicId, userAnswers) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const provider = resolveProvider(providerOrConfig);

  // Get exercises from topic or parse from detail
  let exercises = topic.exercises || [];
  if (exercises.length === 0 && topic.detail) {
    exercises = parseExercisesFromDetail(topic.detail);
  }
  // Merge any existing persisted user answers back (defensive: handles edge case
  // where topic.exercises was empty but user had prior partial submissions)
  if (topic.exercises && topic.exercises.length > 0) {
    for (const existing of topic.exercises) {
      if (existing.userAnswer !== null || existing.correct !== null) {
        const match = exercises.find(e => e.id === existing.id);
        if (match) {
          if (existing.userAnswer !== null) match.userAnswer = existing.userAnswer;
          if (existing.correct !== null) match.correct = existing.correct;
        }
      }
    }
  }

  // Prepare grading context
  const exerciseContext = {
    topicTitle: topic.title,
    exercises: exercises.map((ex, i) => ({
      index: i,
      type: ex.type,
      question: ex.question,
      options: ex.options,
      correctAnswer: ex.answer,
      userAnswer: (userAnswers.find(a => a.exerciseIndex === i) || {}).userAnswer || '',
    })),
  };

  const messages = [
    { role: 'system', content: STABLE_EXERCISE_GRADING_PROMPT },
    { role: 'user', content: JSON.stringify(exerciseContext, null, 2) },
  ];

  const result = await provider.complete(messages, {
    maxTokens: 4096,
    temperature: 0.3,
    responseFormat: { type: 'json_object' },
  });

  let gradingResults;
  try {
    gradingResults = JSON.parse(result.content || '{}');
  } catch {
    throw new Error('AI 评分结果格式错误');
  }

  // Update topic exercises with user answers and grading
  if (gradingResults.results && Array.isArray(gradingResults.results)) {
    for (const grade of gradingResults.results) {
      const idx = grade.exerciseIndex;
      if (idx >= 0 && idx < exercises.length) {
        exercises[idx].userAnswer = grade.userAnswer || exercises[idx].userAnswer;
        exercises[idx].correct = grade.correct;
      }
    }
    await updateTopic(plan.id, topicId, { exercises });
    topic.exercises = exercises;
  }

  return gradingResults.results || [];
}

/**
 * Analyze weak points across all done topics.
 * Uses exercise errors + Q&A history to identify specific weak sub-concepts.
 */
export async function analyzeWeakPoints(providerOrConfig, plan, model = 'gpt-4o-mini') {
  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  const doneTopics = plan.topics.filter(t => t.done && t.detail);
  const results = [];

  // Collect exam errors per topic
  const examErrorsByTopic = {};
  if (plan.examPapers) {
    for (const exam of plan.examPapers) {
      if (!exam.results || !exam.questions) continue;
      for (const result of exam.results) {
        if (result.correct === false) {
          const q = exam.questions[result.exerciseIndex];
          if (q?.topicId) {
            if (!examErrorsByTopic[q.topicId]) examErrorsByTopic[q.topicId] = [];
            examErrorsByTopic[q.topicId].push({
              question: q.question,
              type: q.type,
              userAnswer: result.userAnswer,
              correctAnswer: result.correctAnswer,
              examTitle: exam.title,
              conceptTag: q.conceptTag,
            });
          }
        }
      }
    }
  }

  for (const topic of doneTopics) {
    const hasExercises = (topic.exercises && topic.exercises.length > 0);
    const history = getTopicHistory(plan, topic.id);
    const hasQA = history.some(h => h.role === 'user');
    const hasExamErrors = examErrorsByTopic[topic.id] && examErrorsByTopic[topic.id].length > 0;
    const unrecognizedTeachingErrors = (topic.teachingErrors || []).filter(e => e && e.recognized === false);
    const hasTeachingErrors = unrecognizedTeachingErrors.length > 0;
    if (!hasExercises && !hasQA && !hasExamErrors && !hasTeachingErrors) continue;

    // Build analysis context
    const exerciseData = (topic.exercises || []).map(e => ({
      question: e.question,
      type: e.type,
      conceptTag: e.conceptTag,
      userAnswer: e.userAnswer,
      correct: e.correct,
      correctAnswer: e.answer,
    }));

    const examData = examErrorsByTopic[topic.id] || [];

    const qaData = history
      .filter(h => h.role === 'user')
      .slice(-10)
      .map(h => h.content.slice(0, 300));

    const context = {
      topicTitle: topic.title,
      detailExcerpt: topic.detail.slice(0, 3000),
      exercises: exerciseData,
      examErrors: examData,
      recentQuestions: qaData,
      unrecognizedTeachingErrors: unrecognizedTeachingErrors.map(e => ({ description: e.description, misconception: e.misconception, errorType: e.errorType, bloomLevel: e.bloomLevel })),
    };

    const messages = [
      { role: 'system', content: STABLE_WEAK_POINT_PROMPT },
      { role: 'user', content: JSON.stringify(context, null, 2) },
    ];

    try {
      const result = await provider.complete(messages, {
        maxTokens: 2048,
        temperature: 0.3,
        responseFormat: { type: 'json_object' },
      });

      const analysis = JSON.parse(result.content || '{}');
      const weakPointNames = (analysis.weakPoints || [])
        .filter(wp => wp.concept)
        .map(wp => wp.concept);

      if (weakPointNames.length > 0) {
        await updateTopic(plan.id, topic.id, { weakPoints: weakPointNames });
        topic.weakPoints = weakPointNames;
        results.push({ topicTitle: topic.title, weakPoints: weakPointNames });
      }
    } catch (err) {
      console.warn(`[analyzeWeakPoints] Failed for ${topic.title}: ${err.message}`);
    }
  }

  return results;
}
export async function generateQuickQuiz(provider, plan, model = 'gpt-4o-mini') {
  const doneTopics = plan.topics.filter(t => t.done && t.detail);
  const available = doneTopics.length > 0 ? doneTopics : plan.topics;

  if (available.length === 0) {
    return { questions: [], topicCount: 0, message: '暂无知识点' };
  }

  // Build a compact context with topic titles + detail excerpts
  const context = {
    planName: plan.name,
    topics: available.slice(0, 15).map(t => ({
      title: t.title,
      detailExcerpt: (t.detail || '').slice(0, 500),
    })),
  };

  const messages = [
    { role: 'system', content: QUICK_QUIZ_PROMPT },
    { role: 'user', content: JSON.stringify(context, null, 2) },
  ];

  try {
    const result = await provider.complete(messages, {
      maxTokens: 2048,
      temperature: 0.7,
      responseFormat: { type: 'json_object' },
    });

    const parsed = JSON.parse(result.content || '{}');
    return {
      questions: parsed.questions || [],
      topicCount: available.length,
    };
  } catch (err) {
    console.warn('[generateQuickQuiz] AI failed:', err.message);
    return { questions: [], topicCount: available.length, error: err.message };
  }
}

/**
 * Analyze a Feynman interactive session transcript and extract insights.
 */
export async function analyzeFeynmanSession(provider, transcript, topicTitle) {
  const transcriptText = transcript
    .map(msg => {
      const role = msg.role === 'ai' ? '【AI学生】' : '【用户老师】';
      return role + '\n' + msg.content;
    })
    .join('\n\n---\n\n');

  const messages = [
    { role: 'system', content: FEYNMAN_ANALYSIS_PROMPT },
    { role: 'user', content: '知识点：' + topicTitle + '\n\n对话记录：\n' + transcriptText },
  ];

  try {
    const result = await provider.complete(messages, {
      maxTokens: 2048,
      temperature: 0.3,
      responseFormat: { type: 'json_object' },
    });
    const parsed = JSON.parse(result.content || '{}');
    return {
      lingeringQuestions: parsed.lingeringQuestions || [],
      teachingQuality: parsed.teachingQuality || 'unknown',
      strengths: parsed.strengths || [],
      gaps: parsed.gaps || [],
      sparklingExplanations: parsed.sparklingExplanations || [],
      summary: parsed.summary || '',
    };
  } catch (err) {
    console.warn('[analyzeFeynmanSession] AI failed:', err.message);
    return { lingeringQuestions: [], teachingQuality: 'unknown', strengths: [], gaps: [], sparklingExplanations: [], summary: '' };
  }
}
