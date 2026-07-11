/**
 * User Profile — cross-plan learning analysis and learner persona builder.
 *
 * Aggregates data from all learning plans, then uses AI to generate a
 * structured user profile (learner type, strengths, weaknesses, trends,
 * recommendations) persisted to a single JSON file.
 *
 * Data file: server/data/learn/user-profile.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'learn');
const PROFILE_FILE = path.join(DATA_DIR, 'user-profile.json');

// ─── Prompt ───

const USER_PROFILE_PROMPT = `你是一位资深学习分析顾问，擅长构建学习者画像。
你需要根据用户所有学习计划的聚合数据，构建一个结构化的用户画像。

## 输入数据结构说明

输入数据包含用户所有学习计划的聚合信息，分为以下几个部分：

### 1. 跨计划概览
- 计划数量、知识点总数、完成总数、总体完成率
- 每个计划的名称、完成率、知识点数
- 总学习时长、总提问数

### 2. 薄弱点聚合（来自所有计划）
- 所有被 AI 标记为薄弱的知识点列表
- 每个薄弱点来自哪个计划

### 3. 练习与考试统计
- 各计划的练习题正确率
- 各计划的考试成绩分布

### 4. 提问模式分析
- 每个知识点的问题数量
- 问题内容样本

### 5. 费曼学习法数据
- 费曼学习法使用次数
- 各次的教学质量评级（excellent/good/fair/needsWork）
- 常见遗漏内容（作为教材缺了什么）
- 常见讲解亮点
- 学生遗留问题的数量

## 输出格式

请严格按照以下 JSON 结构输出（不要添加额外说明文字，直接输出 JSON）：

\`\`\`json
{
  "learnerPersona": {
    "type": ["深度思考型", "实践应用型"],
    "summary": "用一段话总结用户的学习者画像，结合具体数据佐证",
    "confidence": 0.85
  },
  "strengths": [
    {
      "domain": "领域名称",
      "topics": ["知识点1", "知识点2"],
      "evidence": "具体数据证据",
      "masteryLevel": 0.9
    }
  ],
  "weaknesses": [
    {
      "domain": "领域名称",
      "topics": ["知识点1", "知识点2"],
      "evidence": "具体数据证据",
      "masteryLevel": 0.3,
      "frequency": "high|medium|low",
      "suggestedAction": "建议的学习方法"
    }
  ],
  "crossPlanWeakPoints": ["在所有计划中反复出现的薄弱概念"],
  "learningPatterns": {
    "preferredModes": { "stepwise": 0, "challenge": 0, "scaffold": 0 },
    "questionStyle": "描述用户的提问风格",
    "avgQuestionsPerTopic": 0,
    "timeDistribution": "分散/集中学习",
    "completionTrend": "描述完成趋势"
  },
  "recommendations": [
    "第1条具体建议",
    "第2条具体建议",
    "第3条具体建议"
  ],
  "aiAnalysis": "## 📊 跨计划整体进度\\n...（完整 Markdown 分析报告）"
}
\`\`\`

## 学习者类型说明（可多类型组合）
- **深度思考型**：喜欢问"为什么"，追根溯源，不满足于表面答案
- **实践应用型**：关注"怎么用"，频繁要求代码示例和实际场景
- **类比联想型**：喜欢找关联，问"这和XX有什么区别"
- **谨慎确认型**：需要反复确认理解是否正确
- **目标驱动型**：直奔主题，问"核心是什么"
- **视觉感知型**：偏好图表和可视化展示

## 注意事项
- 所有结论必须有具体数据支撑，不要空洞描述
- masteryLevel 0~1 之间，基于完成率、练习正确率、提问质量综合判断
- frequency 表示薄弱点出现的频繁程度
- recommendations 要具体可执行，引用教育心理学原则
- aiAnalysis 是用 Markdown 格式写的完整分析报告，包含：整体进度、掌握较好领域、需要加强领域、学习行为分析、学习者画像总结、个性化建议`;
// ─── Data aggregation ───

/**
 * Load all plans from the store index.
 */
function loadAllPlans() {
  const indexFile = path.join(DATA_DIR, 'plans.json');
  if (!fs.existsSync(indexFile)) return [];
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    const plans = [];
    for (const entry of (idx || [])) {
      const planFile = path.join(DATA_DIR, 'plans', `${entry.id}.json`);
      if (fs.existsSync(planFile)) {
        try {
          const plan = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
          plans.push(plan);
        } catch { console.warn('[user-profile] 跳过损坏的计划文件:', planFile); }
      }
    }
    return plans;
  } catch {
    return [];
  }
}

/**
 * Aggregate cross-plan data into a structured summary.
 * No AI calls — pure computation.
 */
export function aggregateAllPlans() {
  const plans = loadAllPlans();
  if (plans.length === 0) {
    return null;
  }

  let totalTopics = 0;
  let totalDone = 0;
  let totalQuestions = 0;
  let totalTime = 0;
  let allWeakPoints = []; // { topic, plan, weakPoints[] }
  let allExercises = [];  // { topic, plan, exercises[] }
  let allExamResults = []; // { plan, exam, results[] }
  let modeCounts = { stepwise: 0, challenge: 0, scaffold: 0 };
  let feynmanData = { sessionCount: 0, teachingQualities: [], commonGaps: [], commonStrengths: [], sparklingCount: 0, lingeringCount: 0 };
  let allTimeLogs = []; // { date, seconds, plan, topic }

  const planSummaries = plans.map(plan => {
    const doneCount = plan.topics.filter(t => t.done && !t.lastError).length;
    totalTopics += plan.topics.length;
    totalDone += doneCount;
    totalQuestions += (plan.history || []).filter(h => h.role === 'user').length;

    // Time tracking
    for (const t of plan.topics) {
      totalTime += t.timeSpent || 0;
      // Collect daily time logs
      if (t.timeLog && t.timeLog.length > 0) {
        for (const entry of t.timeLog) {
          allTimeLogs.push({ date: entry.date, seconds: entry.seconds, plan: plan.name, topic: t.title });
        }
      }
      // Feynman data
      if (t.feynmanInsights) {
        feynmanData.sessionCount++;
        if (t.feynmanInsights.teachingQuality) feynmanData.teachingQualities.push(t.feynmanInsights.teachingQuality);
        if (t.feynmanInsights.gaps) feynmanData.commonGaps.push(...t.feynmanInsights.gaps);
        if (t.feynmanInsights.strengths) feynmanData.commonStrengths.push(...t.feynmanInsights.strengths);
        if (t.feynmanInsights.sparklingExplanations) feynmanData.sparklingCount += t.feynmanInsights.sparklingExplanations.length;
        if (t.feynmanInsights.lingeringQuestions) feynmanData.lingeringCount += t.feynmanInsights.lingeringQuestions.length;
      }
    }

    // Weak points
    for (const t of plan.topics) {
      if (t.weakPoints && t.weakPoints.length > 0) {
        allWeakPoints.push({
          topic: t.title,
          plan: plan.name,
          weakPoints: t.weakPoints,
        });
      }
      if (t.exercises && t.exercises.length > 0) {
        allExercises.push({
          topic: t.title,
          plan: plan.name,
          exercises: t.exercises,
        });
      }
    }

    // Exam results
    for (const exam of (plan.examPapers || [])) {
      if (exam.results && exam.results.length > 0) {
        allExamResults.push({
          plan: plan.name,
          exam: exam.title || exam.id,
          results: exam.results,
        });
      }
    }

    // Interactive mode preferences (inferred from history — heuristic, may overcount
    // as mode keywords like '分段'/'挑战'/'脚手架' can appear in explanations too)
    const history = plan.history || [];
    for (const h of history) {
      if (h.role === 'ai' && h.content) {
        if (h.content.includes('stepwise') || h.content.includes('分段')) modeCounts.stepwise++;
        if (h.content.includes('challenge') || h.content.includes('挑战')) modeCounts.challenge++;
        if (h.content.includes('scaffold') || h.content.includes('脚手架')) modeCounts.scaffold++;
      }
    }

    return {
      id: plan.id,
      name: plan.name,
      topicCount: plan.topics.length,
      doneCount,
      completionRate: plan.topics.length > 0
        ? Math.round((doneCount / plan.topics.length) * 100)
        : 0,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  });

  // Exercise statistics
  let totalExercises = 0;
  let correctExercises = 0;
  for (const e of allExercises) {
    for (const ex of (e.exercises || [])) {
      totalExercises++;
      if (ex.correct) correctExercises++;
    }
  }

  // Exam statistics
  let totalExamQuestions = 0;
  let correctExamQuestions = 0;
  for (const e of allExamResults) {
    for (const r of (e.results || [])) {
      totalExamQuestions++;
      if (r.correct) correctExamQuestions++;
    }
  }

  // Most frequent weak topics (cross-plan)
  const weakTopicFreq = {};
  for (const w of allWeakPoints) {
    for (const wp of (w.weakPoints || [])) {
      weakTopicFreq[wp] = (weakTopicFreq[wp] || 0) + 1;
    }
  }
  const sortedWeakPoints = Object.entries(weakTopicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  // Time distribution aggregation
  const dailyTimeMap = {};
  for (const log of allTimeLogs) {
    dailyTimeMap[log.date] = (dailyTimeMap[log.date] || 0) + log.seconds;
  }
  const sortedDays = Object.entries(dailyTimeMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, seconds]) => ({ date, seconds, hours: Math.round(seconds / 3600 * 10) / 10 }));

  // Compute summary stats for different periods
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
  const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
  const d7Str = d7.toISOString().slice(0, 10);
  const d30Str = d30.toISOString().slice(0, 10);

  let timeLast7Days = 0, timeLast30Days = 0;
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const secs = dailyTimeMap[ds] || 0;
    last7Days.push({ date: ds, seconds: secs, hours: Math.round(secs / 3600 * 10) / 10 });
    timeLast7Days += secs;
  }
  for (const [date, secs] of Object.entries(dailyTimeMap)) {
    if (date >= d30Str) timeLast30Days += secs;
  }

  const activeDays = sortedDays.length;
  const avgPerDay = activeDays > 0 ? Math.round(totalTime / activeDays) : 0;
  const peakDay = sortedDays.reduce((max, d) => d.seconds > (max?.seconds || 0) ? d : max, null);

  return {
    planSummaries,
    stats: {
      totalPlans: plans.length,
      totalTopics,
      totalDone,
      totalQuestions,
      totalTimeSeconds: totalTime,
      totalTimeHours: Math.round(totalTime / 3600 * 10) / 10,
      overallCompletionRate: totalTopics > 0
        ? Math.round((totalDone / totalTopics) * 100)
        : 0,
    },
    exerciseStats: {
      total: totalExercises,
      correct: correctExercises,
      rate: totalExercises > 0 ? Math.round((correctExercises / totalExercises) * 100) : 0,
    },
    examStats: {
      total: totalExamQuestions,
      correct: correctExamQuestions,
      rate: totalExamQuestions > 0 ? Math.round((correctExamQuestions / totalExamQuestions) * 100) : 0,
    },
    weakPoints: allWeakPoints,
    weakPointsSummary: sortedWeakPoints,
    modeCounts,
    feynmanData,
    timeDistribution: {
      daily: sortedDays,
      last7Days,
      summary: {
        totalTimeSeconds: totalTime,
        timeLast7Days,
        timeLast30Days,
        activeDays,
        avgPerDaySeconds: avgPerDay,
        avgPerDayHours: Math.round(avgPerDay / 3600 * 10) / 10,
        peakDay: peakDay ? { date: peakDay.date, seconds: peakDay.seconds, hours: peakDay.hours } : null,
      },
    },
  };
}

// ─── Profile read / write ───

/**
 * Read the stored user profile, or null if not yet generated.
 */
export function getUserProfile() {
  if (!fs.existsSync(PROFILE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeUserProfile(data) {
  const tmp = PROFILE_FILE + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try {
      fs.renameSync(tmp, PROFILE_FILE);
    } catch (renameErr) {
      // Windows EPERM / cross-device link failure → fall back to copy + delete
      fs.copyFileSync(tmp, PROFILE_FILE);
      fs.unlinkSync(tmp);
    }
  } catch (writeErr) {
    // If even the temp write failed, try direct write as last resort
    console.error('[user-profile] Atomic write failed, attempting direct write:', writeErr.message);
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    // Clean up temp file if it was created
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * 规则驱动：根据练习+考试+问答模式反向更新画像的 masteryLevel 和 learnerPersona。
 * 这是数据飞轮的"回灌"环节：用户行为 → 画像数据 → 下次Prompt个性化。
 *
 * ⚠️ 未接入 AI——接入 AI 分析的是完整版 generateUserProfile()。
 * 但这个函数可以在用户每次做练习/答完题后增量更新画像，不需要AI调用。
 *
 * ⚠️ 这不会永久修改磁盘上的画像文件——只返回更新后的画像对象
 * 供 AdaptivePromptInjector 在下一次 generateDetail 中立即使用。
 *
 * @param {object|null} currentProfile - 当前画像 (或 null 表示基于活跃计划的初始画像)
 * @param {Array} allPlans - 所有学习计划 (来自 store)
 * @returns {object} 更新后的画像，下次生成时直接注入到提示中
 */
export function profileUpdater(currentProfile, allPlans) {
  const profile = currentProfile || _buildSkeletonProfile();
  const now = Date.now();

  // ── 1. 根据最新练习考试数据重新计算每种 masteryLevel ──
  // 遍历所有计划的每个知识点，每个知识点得分根据：练习正确率 + 考试正确率
  for (const plan of allPlans) {
    if (!plan.topics) continue;
    for (const t of plan.topics) {
      if (!t.detail) continue;
      const exercises = t.exercises || [];
      if (exercises.length === 0) continue;
      const correct = exercises.filter(e => e.correct === true).length;
      const accuracy = correct / exercises.length;

      // 将 accuracy 映射为 masteryLevel（0-1）
      const mastery = Math.round(accuracy * 100) / 100;

      // 找到画像中对应的 strength / weakness 条目
      const concept = t.title;
      const domain = _guessDomain(concept, plan.name);

      _upsertMastery(profile, domain, concept, mastery, exercises.length);
    }
  }

  // ── 2. 根据问答模式微调 personality 权重 ──
  // 统计所有计划中的问答类型（为什么/怎么用/区别/我理解得对吗）
  let totalQuestions = 0;
  const questionTypes = { why: 0, how: 0, compare: 0, confirm: 0, apply: 0, deep: 0 };
  for (const plan of allPlans) {
    for (const h of (plan.history || [])) {
      if (h.role !== 'user') continue;
      totalQuestions++;
      const q = (h.content || '').toLowerCase();
      if (/为什么|why|原因是|原理|底层|背后/.test(q)) questionTypes.why++;
      if (/怎么用|如何|怎么|示例|例子|代码|example|实践/.test(q)) questionTypes.how++;
      if (/区别|对比|vs|versus|不同|比较|还是|差异/.test(q)) questionTypes.compare++;
      if (/对吗|是不是|对吗|对吧|我的理解|确认/.test(q)) questionTypes.confirm++;
      if (/应用|场景|实际|项目|生产|工作中/.test(q)) questionTypes.apply++;
      if (/深入|追问|进一步|再问|还是不懂|换个角度/.test(q)) questionTypes.deep++;
    }
  }

  if (totalQuestions > 0) {
    const qt = questionTypes;
    // 判断主导类型
    const dominantType = Object.entries(qt).sort((a, b) => b[1] - a[1])[0][0];
    const typeMap = { why: '深度思考型', how: '实践应用型', compare: '类比联想型', confirm: '谨慎确认型', apply: '目标驱动型', deep: '深度思考型' };
    const learnedType = typeMap[dominantType];
    if (learnedType && profile.learnerPersona) {
      // 如果行为数据与历史画像类型冲突，更新置信度
      if (!profile.learnerPersona.type.includes(learnedType)) {
        profile.learnerPersona.type = [...new Set([...profile.learnerPersona.type, learnedType])];
        profile.learnerPersona.evidenceFromBehavior = `用户在 ${totalQuestions} 个问题中，${dominantType} 类型占比最高（${qt[dominantType]}次）`;
      }
      // 置信度从数据量直接重算（避免持久化后多次调用累加膨胀）
      const sampleBonus = Math.min(totalQuestions / 50, 0.1); // 最多加 0.1
      const baseConfidence = 0.5;
      profile.learnerPersona.confidence = Math.min(1, Math.round((baseConfidence + sampleBonus) * 100) / 100);
    }
  }

  // ── 3. 根据练习正确率更新跨计划薄弱点列表 ──
  const conceptAccuracies = {};
  for (const plan of allPlans) {
    for (const t of (plan.topics || [])) {
      const exercises = t.exercises || [];
      if (exercises.length === 0) continue;
      const correct = exercises.filter(e => e.correct === true).length;
      conceptAccuracies[t.title] = correct / exercises.length;
    }
  }
  // accuracy < 0.5 且不在当前列表中 → 推入跨计划薄弱点
  for (const [title, acc] of Object.entries(conceptAccuracies)) {
    if (acc < 0.5 && !(profile.crossPlanWeakPoints || []).includes(title)) {
      if (!profile.crossPlanWeakPoints) profile.crossPlanWeakPoints = [];
      profile.crossPlanWeakPoints.push(title);
    }
  }

  // ── 4. 打上时间戳 ──
  profile._lastIncrementalUpdate = now;
  if (!profile._totalIncrementalUpdates) profile._totalIncrementalUpdates = 0;
  profile._totalIncrementalUpdates++;

  return profile;
}

function _buildSkeletonProfile() {
  return {
    learnerPersona: { type: [], summary: '', confidence: 0.5 },
    strengths: [],
    weaknesses: [],
    crossPlanWeakPoints: [],
    learningPatterns: { preferredModes: { stepwise: 0, challenge: 0, scaffold: 0 }, questionStyle: '', avgQuestionsPerTopic: 0, timeDistribution: '', completionTrend: '' },
    recommendations: [],
    aiAnalysis: '',
  };
}

function _guessDomain(title, planName) {
  // 简短启发式——提取领域标签
  const lower = title.toLowerCase();
  if (/协议|tcp|http|网络|socket|dns/.test(lower)) return '网络协议';
  if (/算法|排序|搜索|数据结构|tree|graph/.test(lower)) return '算法与数据结构';
  if (/线程|进程|并发|锁|同步|异步/.test(lower)) return '并发编程';
  if (/编译|链接|汇编|寄存器|指令/.test(lower)) return '系统底层';
  if (/数据库|sql|索引|事务|nosql/.test(lower)) return '数据库';
  if (/设计模式|架构|框架|模式/.test(lower)) return '软件设计';
  return planName || '通用';
}

function _upsertMastery(profile, domain, topic, mastery, sampleSize) {
  if (!profile.strengths) profile.strengths = [];
  if (!profile.weaknesses) profile.weaknesses = [];

  // 检查 strengths 中是否已存在此 topic
  const allEntries = [...profile.strengths, ...profile.weaknesses];
  const existingDomain = allEntries.find(e => e.domain === domain);

  const entry = {
    domain,
    topics: existingDomain ? [...new Set([...existingDomain.topics, topic])] : [topic],
    evidence: `练习正确率 ${Math.round(mastery * 100)}%（${sampleSize}题）`,
    masteryLevel: mastery,
    lastUpdated: Date.now(),
  };

  if (mastery >= 0.7) {
    // 掌握好的 → strengths
    const idx = profile.strengths.findIndex(s => s.domain === domain);
    if (idx >= 0) profile.strengths[idx] = entry;
    else profile.strengths.push(entry);
    // 从 weaknesses 中移除
    profile.weaknesses = profile.weaknesses.filter(w => w.domain !== domain);
  } else {
    // 掌握不足 → weaknesses
    const idx = profile.weaknesses.findIndex(w => w.domain === domain);
    if (idx >= 0) profile.weaknesses[idx] = entry;
    else profile.weaknesses.push(entry);
  }
}

/**
 * Generate (or regenerate) the user profile using AI.
 *
 * @param {object} provider - Provider instance from createProviderFromConfig
 * @param {string} [model='gpt-4o-mini']
 * @returns {object} The newly generated user profile
 */
export async function generateUserProfile(provider, model = 'gpt-4o-mini') {
  const aggregated = aggregateAllPlans();
  if (!aggregated) {
    throw new Error('没有学习计划数据，无法生成画像');
  }

  // Build the input for AI
  const inputData = {
    planSummaries: aggregated.planSummaries,
    stats: aggregated.stats,
    exerciseStats: aggregated.exerciseStats,
    examStats: aggregated.examStats,
    weakPointsSummary: aggregated.weakPointsSummary,
    modeCounts: aggregated.modeCounts,
    feynmanStats: aggregated.feynmanData,
    // Include detailed weak points with plan context
    weakPointsByPlan: aggregated.weakPoints.map(w => ({
      plan: w.plan,
      topic: w.topic,
      weakPoints: w.weakPoints,
    })),
    // Include recent exercise samples
    exerciseSamples: aggregated.weakPoints.slice(0, 5).map(w => ({
      plan: w.plan,
      topic: w.topic,
      exerciseCount: w.weakPoints?.length || 0,
    })),
  };

  const messages = [
    { role: 'system', content: USER_PROFILE_PROMPT },
    { role: 'user', content: '以下是我的所有学习计划聚合数据，请构建用户画像：\n\n```json\n' + JSON.stringify(inputData, null, 2) + '\n```' },
  ];

  const result = await provider.complete(messages, {
    maxTokens: 8192,
    temperature: 0.7,
  });

  // Parse JSON from AI response
  let profileData;
  try {
    // Try to extract JSON from markdown code block
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : result.content.trim();
    profileData = JSON.parse(jsonStr);
  } catch (parseErr) {
    throw new Error('AI 返回 JSON 解析失败，请重试: ' + parseErr.message + '\n回复前 200 字符: ' + result.content.slice(0, 200));
  }

  // Merge with computed stats
  const profile = {
    updatedAt: Date.now(),
    lastAnalyzedAt: Date.now(),
    planSummary: {
      totalPlans: aggregated.stats.totalPlans,
      totalTopics: aggregated.stats.totalTopics,
      completedTopics: aggregated.stats.totalDone,
      overallCompletionRate: aggregated.stats.overallCompletionRate,
      totalLearningTime: aggregated.stats.totalTimeSeconds,
      totalQuestions: aggregated.stats.totalQuestions,
      plans: aggregated.planSummaries,
    },
    exerciseRate: aggregated.exerciseStats.rate,
    examRate: aggregated.examStats.rate,
    ...profileData,
    // Override learningPatterns with computed data merged with AI data
    learningPatterns: {
      ...(profileData.learningPatterns || {}),
      preferredModes: aggregated.modeCounts,
      avgQuestionsPerTopic: aggregated.stats.totalTopics > 0
        ? Math.round((aggregated.stats.totalQuestions / aggregated.stats.totalTopics) * 10) / 10
        : 0,
    },
    // Keep raw weak points for reference
    _rawWeakPoints: aggregated.weakPointsSummary,
  };

  writeUserProfile(profile);
  return profile;
}

/**
 * Get a lightweight summary without triggering AI analysis.
 */
export function getProfileSummary() {
  const aggregated = aggregateAllPlans();
  if (!aggregated) {
    return { hasData: false, message: '还没有学习计划数据' };
  }

  const stored = getUserProfile();

  return {
    hasData: true,
    hasAIAnalysis: !!stored,
    lastAnalyzedAt: stored?.lastAnalyzedAt || null,
    stats: aggregated.stats,
    exerciseStats: aggregated.exerciseStats,
    examStats: aggregated.examStats,
    weakPointsSummary: aggregated.weakPointsSummary,
    feynmanStats: aggregated.feynmanData,
    planSummaries: aggregated.planSummaries,
    modeCounts: aggregated.modeCounts,
    timeDistribution: aggregated.timeDistribution,
    // Include AI persona if available
    learnerPersona: stored?.learnerPersona || null,
    strengths: stored?.strengths || null,
    weaknesses: stored?.weaknesses || null,
    recommendations: stored?.recommendations || null,
  };
}
