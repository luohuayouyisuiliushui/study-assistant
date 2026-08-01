/**
 * Exam engine: blueprint generation, single-question generation,
 * self-correction, quality evaluation, revision, full exam generation,
 * streaming exam generation, grading, and practice generation.
 */

import { addExamPaper, getExamPapers, saveExamAssessment, updateTopic } from './learn-store.js';
import {
  STABLE_EXAM_GENERATION_PROMPT, STABLE_EXAM_GRADING_PROMPT,
  STABLE_EXAM_BLUEPRINT_PROMPT, STABLE_EXAM_SINGLE_QUESTION_PROMPT,
  STABLE_EXAM_SELF_CORRECT_PROMPT, STABLE_EXAM_QUALITY_EVAL_PROMPT,
} from './learn-prompts.js';
import { resolveProvider } from './ai-runtime.js';

const _resolveProvider = resolveProvider;

function validateQuestionOutput(data) {
  if (!data || typeof data !== 'object') return '输出不是有效对象';
  if (!data.question || typeof data.question !== 'string') return 'question 字段缺失或非字符串';
  if (!Array.isArray(data.options)) return 'options 必须是数组';
  if (!data.answer || typeof data.answer !== 'string') return 'answer 字段缺失或非字符串';
  if (!data.explanation || typeof data.explanation !== 'string') return 'explanation 字段缺失或非字符串';
  if (!data.conceptTag || typeof data.conceptTag !== 'string') return 'conceptTag 字段缺失或非字符串';
  for (let i = 0; i < data.options.length; i++) {
    if (!data.options[i] || typeof data.options[i] !== 'string') return `options[${i}] 不是有效字符串`;
  }
  return null;
}

//  EXAM PAPER ENGINE
// ═══════════════════════════════════════════════════════


/**
 * Step 1: Generate blueprint — detailed order list.
 */
export function generateBlueprint(providerOrConfig, plan, topicIds, config = {}) {
  const selectedTopics = plan.topics.filter(t => topicIds.includes(t.id));
  if (selectedTopics.length === 0) throw new Error('未选择任何知识点');
  const topicCount = selectedTopics.length;
  const totalQuestions = config.questionCount || Math.max(10, topicCount * 3);
  const choiceRatio = config.choiceRatio !== undefined ? config.choiceRatio : 0.6;
  const diffRatios = config.difficulty === 'easy' ? { easy:0.5, medium:0.4, hard:0.1 }
    : config.difficulty === 'balanced' ? { easy:0.3, medium:0.5, hard:0.2 }
    : config.difficulty === 'hard' ? { easy:0.1, medium:0.4, hard:0.5 }
    : { easy:0.3, medium:0.5, hard:0.2 };

  // Step 1: Calculate exact counts per cell (difficulty × type)
  const choiceCount = Math.round(totalQuestions * choiceRatio);
  const openCount = totalQuestions - choiceCount;
  const easyCount = Math.round(totalQuestions * diffRatios.easy);
  const hardCount = Math.round(totalQuestions * diffRatios.hard);
  const mediumCount = totalQuestions - easyCount - hardCount;

  const difficultyTotals = [
    { diff: 'easy', count: Math.max(easyCount, 0) },
    { diff: 'medium', count: Math.max(mediumCount, 0) },
    { diff: 'hard', count: Math.max(hardCount, 0) },
  ];

  // Distribute type counts across difficulty levels proportionally
  const orders = [];
  let remainingChoice = choiceCount;
  let remainingOpen = openCount;

  for (const { diff, count } of difficultyTotals) {
    if (count <= 0) continue;
    // Proportional split: this difficulty's share of total questions
    const share = count / totalQuestions;
    const choiceForDiff = Math.min(Math.round(choiceCount * share), remainingChoice, count);
    const openForDiff = count - choiceForDiff;
    remainingChoice -= choiceForDiff;
    remainingOpen -= openForDiff;

    for (let i = 0; i < choiceForDiff; i++) orders.push({ type: 'choice', difficulty: diff });
    for (let i = 0; i < openForDiff; i++) orders.push({ type: 'open', difficulty: diff });
  }

  // Handle any rounding leftovers
  while (remainingChoice > 0) { orders.push({ type: 'choice', difficulty: 'medium' }); remainingChoice--; }
  while (remainingOpen > 0) { orders.push({ type: 'open', difficulty: 'medium' }); remainingOpen--; }

  // Shuffle orders to mix difficulty/types
  for (let i = orders.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [orders[i], orders[j]] = [orders[j], orders[i]];
  }

  // ── Weak-point weighted distribution ──
  // Topics with more weakPoints get proportionally more questions.
  // Weight = base 1 + weakPointCount (min 1 question per topic guaranteed later).
  const topicWeights = selectedTopics.map(t => ({
    title: t.title,
    weight: 1 + (t.weakPoints || []).length,
  }));
  const totalWeight = topicWeights.reduce((s, t) => s + t.weight, 0);

  // Assign questions weighted by weakPoints, ensure each topic gets at least 1
  const assignments = [];
  const topicAssignCounts = topicWeights.map(t => {
    const raw = (orders.length * t.weight) / totalWeight;
    return { title: t.title, count: Math.max(1, Math.round(raw)) };
  });

  // Normalize to exact total (adjust largest group down if over)
  let assigned = topicAssignCounts.reduce((s, t) => s + t.count, 0);
  while (assigned > orders.length) {
    const largest = topicAssignCounts.reduce((max, t) => t.count > max.count ? t : max);
    if (largest.count > 1) { largest.count--; assigned--; }
    else break;
  }
  while (assigned < orders.length) {
    const mostWeak = topicAssignCounts.reduce((max, t, i) => {
      const wp = (selectedTopics.find(st => st.title === t.title)?.weakPoints || []).length;
      const mwp = (selectedTopics.find(st => st.title === max.title)?.weakPoints || []).length;
      return wp > mwp ? t : max;
    });
    mostWeak.count++; assigned++;
  }

  let orderIdx = 0;
  for (const ta of topicAssignCounts) {
    for (let i = 0; i < ta.count && orderIdx < orders.length; i++) {
      assignments.push({ ...orders[orderIdx], topicTitle: ta.title, index: assignments.length });
      orderIdx++;
    }
  }

  // Build title
  const diffLabel = config.difficulty === 'easy' ? '基础' : config.difficulty === 'hard' ? '困难' : '标准';
  const title = `${plan.name} — ${diffLabel}测验（${assignments.length}题）`;

  return {
    title,
    orders: assignments,
    topicTitleToId: Object.fromEntries(selectedTopics.map(t => [t.title, t.id])),
    topicDetailMap: Object.fromEntries(selectedTopics.map(t => [t.title, t.detail || ''])),
  };
}


/**
 * Step 2: Generate a single question from one blueprint order.
 */
export async function generateSingleQuestion(providerOrConfig, order, topicDetail, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const { v4: uuidv4 } = await import('uuid');
  const detailSnippet = (topicDetail||'').slice(0,2000)||'（暂无详细讲解）';
  // Map difficulty to Bloom's taxonomy levels
  const bloomMap = { easy: ['记住','理解'], medium: ['理解','应用','分析'], hard: ['分析','评价','创造'] };
  const bloomPool = bloomMap[order.difficulty] || ['理解','应用'];
  const bloomLevel = bloomPool[Math.floor(Math.random() * bloomPool.length)];
  const prompt = STABLE_EXAM_SINGLE_QUESTION_PROMPT
    .replace('{topicTitle}',order.topicTitle).replace('{topicDetail}',detailSnippet)
    .replace('{difficulty}',order.difficulty).replace('{questionType}',order.type);
  const messages = [{role:'system',content:prompt},{role:'user',content:'请为知识点「'+order.topicTitle+'」生成一道'+(order.difficulty==='easy'?'基础':order.difficulty==='hard'?'较难':'中等')+(order.type==='choice'?'选择题':'简答题')}];
  const result = await provider.complete(messages,{maxTokens:2048,temperature:0.7,responseFormat:{type:'json_object'}});
  let qData, qErr;
  try { qData = JSON.parse(result.content||'{}'); qErr = validateQuestionOutput(qData); } catch { qErr = 'JSON 解析失败'; }
  if (qErr) return null;
  return { id: uuidv4().slice(0,8), index: order.index, type: order.type, question: qData.question||'', options: qData.options||[], answer: qData.answer||'', explanation: qData.explanation||'', conceptTag: qData.conceptTag||order.topicTitle, topicId: null, difficulty: order.difficulty, validated: false };
}


/**
 * Step 3: Self-correction — AI answers as student to validate question.
 */
export async function selfCorrectQuestion(providerOrConfig, question, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const optionsText = question.options&&question.options.length>0 ? question.options.join('\n') : '';
  const prompt = STABLE_EXAM_SELF_CORRECT_PROMPT.replace('{questionText}',question.question).replace('{optionsText}',optionsText ? `## 选项\n${optionsText}` : '');
  const messages = [{role:'system',content:prompt},{role:'user',content:`请解答此题：${question.question}`}];
  const result = await provider.complete(messages,{maxTokens:1024,temperature:0.3,responseFormat:{type:'json_object'}});
  let studentData;
  try { studentData = JSON.parse(result.content||'{}'); } catch { return false; }
  const studentAnswer = (studentData.studentAnswer||'').trim().toUpperCase();
  const expected = (question.answer||'').trim().toUpperCase();
  if (question.type==='choice') return studentAnswer===expected;
  const jp = `你是一位公正的阅卷老师。判断学生的答案是否与标准答案在核心要点上一致。\n\n题目：${question.question}\n\n标准答案：${expected}\n\n学生答案：${studentAnswer}\n\n输出JSON：{"equivalent": true/false}\n只输出 JSON。`;
  try { const r=await provider.complete([{role:'user',content:jp}],{maxTokens:512,temperature:0.2,responseFormat:{type:'json_object'}}); return (JSON.parse(r.content||'{}')).equivalent===true; } catch { return true; }
}


/**
 * Evaluate question quality (OpenAI Evals-style).
 * Returns { overall, scores, recommendation } or null on failure.
 */
export async function evaluateQuestionQuality(providerOrConfig, question, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const optionsText = question.options && question.options.length > 0 
    ? '\n选项：\n' + question.options.join('\n') : '';
  const context = `知识点：${question.conceptTag || '未知'}
要求难度：${question.difficulty || '未指定'}
题型：${question.type === 'choice' ? '选择题' : '简答题'}

题目：${question.question}${optionsText}

答案：${question.answer}
解析：${question.explanation}`;

  const result = await provider.complete(
    [{ role: 'system', content: STABLE_EXAM_QUALITY_EVAL_PROMPT },
     { role: 'user', content: context }],
    { maxTokens: 1024, temperature: 0.2, responseFormat: { type: 'json_object' } }
  );

  try {
    const data = JSON.parse(result.content || '{}');
    if (data.overall && data.recommendation) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Revise a question based on quality evaluation feedback.
 * Implements "generate -> judge -> revise" iterative improvement.
 */
export async function reviseQuestion(providerOrConfig, question, qualityFeedback, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const optionsText = question.options && question.options.length > 0
    ? '\n选项：\n' + question.options.join('\n') : '';
  const revisePrompt = '你是一位试题修订专家。下面是一道AI生成的试题，请根据质量评估反馈进行修订。\n\n' +
    '## 原始题目\n' +
    '知识点：' + (question.conceptTag || '未知') + '\n' +
    '难度：' + (question.difficulty || '未指定') + '\n' +
    '题型：' + (question.type === 'choice' ? '选择题' : '简答题') + '\n\n' +
    '题目：' + question.question + '\n' +
    (optionsText ? optionsText + '\n' : '') +
    '答案：' + (question.answer || '') + '\n' +
    '解析：' + (question.explanation || '') + '\n\n' +
    '## 质量评估反馈\n' +
    '评分：' + (qualityFeedback.overall || '?') + '/10\n' +
    '问题：' + ((qualityFeedback.issues || []).join('；') || '无具体问题') + '\n\n' +
    '## 修订要求\n' +
    '1. 保留考察的知识点不变\n' +
    '2. 针对反馈的问题逐条修正\n' +
    '3. 保持JSON格式\n\n' +
    '## 输出格式\n' +
    '{"question":"修订后的题干","options":["A.","B.","C.","D."],"answer":"正确答案","explanation":"解析","conceptTag":"知识点"}\n' +
    '只输出JSON，不要其他文字';
  try {
    const result = await provider.complete(
      [{role:'system',content:'你是一位专业的试题修订专家。'},{role:'user',content:revisePrompt}],
      {maxTokens:2048,temperature:0.4,responseFormat:{type:'json_object'}}
    );
    const data = JSON.parse(result.content || '{}');
    if (!data.question) return null;
    return { ...question, question: data.question, options: data.options || question.options, answer: data.answer || question.answer, explanation: data.explanation || question.explanation, revised: true };
  } catch { return null; }
}


/**
 * Generate exam: blueprint → parallel gen → self-correction.
 */
export async function generateExam(providerOrConfig, plan, topicIds, config = {}, model) {
  const provider = _resolveProvider(providerOrConfig, model);
  const blueprint = await generateBlueprint(provider, plan, topicIds, config, model);
  const {title, orders, topicTitleToId, topicDetailMap} = blueprint;
  const MAX_RETRIES=2, CONCURRENCY=5;
  const validatedQ = [];
  for (let i=0; i<orders.length; i+=CONCURRENCY) {
    const batch = orders.slice(i, i+CONCURRENCY);
    const results = await Promise.all(batch.map(async order=>{
      for (let a=0; a<=MAX_RETRIES; a++) {
        const q = await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
        if (!q) continue;
        q.topicId = topicTitleToId[order.topicTitle]||null;
        if (await selfCorrectQuestion(provider, q, model)) {
          let quality;
          try { quality = await evaluateQuestionQuality(provider, q, model); } catch { quality = null; }
          if (quality && quality.recommendation === 'revise') {
            const revised = await reviseQuestion(provider, q, quality, model);
            if (revised) { revised.validated=true; revised.qualityScore=quality.overall; return revised; }
          }
        }
      }
      const fb = await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
      if (fb) { fb.topicId=topicTitleToId[order.topicTitle]||null; fb.validated=false; }
      return fb;
    }));
    for (const q of results) { if (q) validatedQ.push(q); }
  }
  validatedQ.forEach((q,i)=>{q.index=i;});
  const {v4:uuidv4}=await import('uuid');
  const examId=uuidv4().slice(0,8);
  const choiceQs=validatedQ.filter(q=>q.type==='choice');
  const openQs=validatedQ.filter(q=>q.type==='open');
  let md=`# ${title}\n\n**总分**：${validatedQ.length*5} 分（每题 5 分）\n\n---\n\n`;
  if (choiceQs.length>0) { md+=`## 一、选择题（共 ${choiceQs.length} 题，每题 5 分）\n\n`; choiceQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n`; for (const o of q.options) md+=`${o}\n\n`; md+='\n';}); }
  if (openQs.length>0) { md+=`## ${choiceQs.length>0?'二':'一'}、简答题（共 ${openQs.length} 题，每题 5 分）\n\n`; openQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n\n`;}); }
  const examPaper = {id:examId, title, config:{topicIds, questionCount:validatedQ.length, choiceRatio:config.choiceRatio||0.6}, paper:md, questions:validatedQ};
  await addExamPaper(plan.id, examPaper);
  return examPaper;
}

export async function generateExamStream(providerOrConfig, plan, topicIds, config = {}, writeCallback, model, signal) {
  const provider = _resolveProvider(providerOrConfig, model);
  const blueprint = await generateBlueprint(provider, plan, topicIds, config, model);
  const {title, orders, topicTitleToId, topicDetailMap} = blueprint;
  writeCallback({type:'blueprint', data:{total:orders.length, title}});
  const MAX_RETRIES=2, CONCURRENCY=5;
  const validatedQ = [];
  for (let i=0; i<orders.length; i+=CONCURRENCY) {
    // Stop generating further batches if the SSE client has disconnected.
    if (signal?.aborted) break;
    const batch = orders.slice(i, i+CONCURRENCY);
    const results = await Promise.all(batch.map(async order=>{
      for (let a=0; a<=MAX_RETRIES; a++) {
        const q = await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
        if (!q) continue;
        q.topicId=topicTitleToId[order.topicTitle]||null;
        if (await selfCorrectQuestion(provider, q, model)) {
          let quality;
          try { quality = await evaluateQuestionQuality(provider, q, model); } catch { quality = null; }
          if (quality && quality.recommendation === 'revise') {
            const revised = await reviseQuestion(provider, q, quality, model);
            if (revised) { revised.validated=true; revised.qualityScore=quality.overall; return revised; }
          }
        }
      }
      const fb=await generateSingleQuestion(provider, order, topicDetailMap[order.topicTitle]||'', model);
      if (fb) { fb.topicId=topicTitleToId[order.topicTitle]||null; fb.validated=false; }
      return fb;
    }));
    for (const q of results) { if (q) { q.index=validatedQ.length; validatedQ.push(q); writeCallback({type:'question', data:q}); } }
  }
  const choiceQs=validatedQ.filter(q=>q.type==='choice'); const openQs=validatedQ.filter(q=>q.type==='open');
  let md=`# ${title}\n\n**总分**：${validatedQ.length*5} 分（每题 5 分）\n\n---\n\n`;
  if (choiceQs.length>0) { md+=`## 一、选择题（共 ${choiceQs.length} 题，每题 5 分）\n\n`; choiceQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n`; for (const o of q.options) md+=`${o}\n\n`; md+='\n';}); }
  if (openQs.length>0) { md+=`## ${choiceQs.length>0?'二':'一'}、简答题（共 ${openQs.length} 题，每题 5 分）\n\n`; openQs.forEach(q=>{md+=`**${q.index+1}.** ${q.question}\n\n\n`;}); }
  const {v4:uuidv4}=await import('uuid'); const examId=uuidv4().slice(0,8);
  const examPaper = {id:examId, title, config:{topicIds, questionCount:validatedQ.length, choiceRatio:config.choiceRatio||0.6}, paper:md, questions:validatedQ};
  await addExamPaper(plan.id, examPaper);
  writeCallback({type:'done', data:{examId, totalQuestions:validatedQ.length}});
}


/**
 * Grade submitted exam answers using AI.
 * @param {object} providerOrConfig - Provider instance or config
 * @param {object} plan - The plan object
 * @param {string} examId - The exam paper ID
 * @param {Array} answers - User's answers [{ exerciseIndex, userAnswer }]
 * @returns {Promise<Array>} Grading results
 */
export async function gradeExam(providerOrConfig, plan, examId, answers) {
  const provider = _resolveProvider(providerOrConfig);

  const examPapers = getExamPapers(plan.id);
  const exam = examPapers.find(e => e.id === examId);
  if (!exam) throw new Error('试卷不存在');

  // Prepare grading context
  const gradingContext = {
    title: exam.title,
    questions: exam.questions.map((q, i) => ({
      index: i,
      type: q.type,
      question: q.question,
      options: q.options,
      correctAnswer: q.answer,
      userAnswer: (answers.find(a => a.exerciseIndex === i) || {}).userAnswer || '',
    })),
  };

  const messages = [
    { role: 'system', content: STABLE_EXAM_GRADING_PROMPT },
    { role: 'user', content: JSON.stringify(gradingContext, null, 2) },
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

  let results = gradingResults.results || [];

  // Save exam results to store
  const savedPlan = await saveExamAssessment(plan.id, examId, {
    attemptId: crypto.randomUUID(),
    occurredAt: Date.now(),
    results,
  });
  results = savedPlan.examPapers.find(paper => paper.id === examId)?.results || results;

  // ── Weak point feedback: update topic.weakPoints from wrong answers ──
  const wrongByTopic = {}; // topicId → Set of conceptTags
  for (const r of results) {
    if (r.correct === false) {
      const q = exam.questions[r.exerciseIndex];
      if (q && q.topicId) {
        if (!wrongByTopic[q.topicId]) wrongByTopic[q.topicId] = new Set();
        if (q.conceptTag) wrongByTopic[q.topicId].add(q.conceptTag);
      }
    }
  }
  for (const [topicId, wrongTags] of Object.entries(wrongByTopic)) {
    const topic = plan.topics.find(t => t.id === topicId);
    if (!topic) continue;
    const existing = new Set(topic.weakPoints || []);
    let changed = false;
    for (const tag of wrongTags) {
      if (!existing.has(tag)) { existing.add(tag); changed = true; }
    }
    if (changed) {
      await updateTopic(plan.id, topicId, { weakPoints: [...existing] });
    }
  }

  return results;
}

/**
 * Generate targeted practice questions based on exam paper mistakes.
 * Uses wrong answers from a specific exam to create focused practice.
 */
export async function generateExamPractice(providerOrConfig, plan, examId, count = 5, model) {
  const exam = (plan.examPapers || []).find(e => e.id === examId);
  if (!exam || !exam.results) throw new Error('试卷不存在或尚未批改');

  // Collect wrong answers with topic info
  const wrongItems = [];
  for (const result of exam.results) {
    if (result.correct === false) {
      const q = exam.questions[result.exerciseIndex];
      if (q) {
        const topic = plan.topics.find(t => t.id === q.topicId);
        wrongItems.push({
          question: q.question,
          type: q.type,
          difficulty: q.difficulty,
          conceptTag: q.conceptTag,
          topicTitle: topic ? topic.title : q.conceptTag,
          topicDetail: topic ? (topic.detail || '').slice(0, 1000) : '',
          userAnswer: result.userAnswer,
          correctAnswer: result.correctAnswer,
        });
      }
    }
  }

  if (wrongItems.length === 0) throw new Error('该试卷没有错题，无需针对性练习');

  const provider = _resolveProvider(providerOrConfig, model);
  const practicePrompt = '你是一位学习辅导老师。用户在做完试卷后有一些题目答错了，请根据这些错题生成针对性的练习题，帮助用户巩固薄弱知识点。\n\n' +
    '## 用户的错题\n' +
    wrongItems.map((w, i) =>
      `错题 ${i+1}：${w.question}\n知识点：${w.conceptTag}\n难度：${w.difficulty}\n你的答案：${w.userAnswer}\n正确答案：${w.correctAnswer}`
    ).join('\n\n---\n\n') +
    `\n\n## 要求\n` +
    `请生成 ${count} 道针对性练习题，重点考察用户答错的知识点。\n` +
    `- 每道题至少覆盖一个错题涉及的知识点\n` +
    `- 题型可以混合选择题和简答题\n` +
    `- 难度与原始题目相当\n\n` +
    `## 输出格式（JSON）\n` +
    `{\n` +
    `  "questions": [\n` +
    `    {\n` +
    `      "index": 0,\n` +
    `      "type": "choice" 或 "open",\n` +
    `      "question": "题干",\n` +
    `      "options": ["A.", "B.", "C.", "D."],\n` +
    `      "answer": "正确答案",\n` +
    `      "explanation": "解析",\n` +
    `      "conceptTag": "覆盖的知识点"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n` +
    `只输出 JSON，不要其他文字`;

  const result = await provider.complete(
    [{ role: 'system', content: '你是一位学习辅导老师，擅长根据学生的错题生成针对性练习题。' },
     { role: 'user', content: practicePrompt }],
    { maxTokens: 4096, temperature: 0.6, responseFormat: { type: 'json_object' } }
  );

  let data;
  try { data = JSON.parse(result.content || '{}'); } catch { throw new Error('AI 生成的练习格式错误'); }
  return data.questions || [];
}


