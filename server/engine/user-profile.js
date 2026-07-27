/**
 * User Profile — cross-plan learning analysis and learner persona builder.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasTestPlanMarker } from './store/test-plan-marker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'learn');
const PROFILE_FILE = path.join(DATA_DIR, 'user-profile.json');

const ALLOWED_MODES = new Set(['stepwise','challenge','scaffold','realtime','debate','socratic','analogy']);

function loadAllPlans() {
  const indexFile = path.join(DATA_DIR, 'plans.json');
  if (!fs.existsSync(indexFile)) return [];
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    const entries = Array.isArray(idx) ? idx : Object.values(idx);
    const plans = [];
    for (const entry of entries) {
      const id = entry.id || entry;
      const planDir = path.join(DATA_DIR, 'plans');
      const planFile = path.join(planDir, id + '.json');
      if (fs.existsSync(planFile)) plans.push(JSON.parse(fs.readFileSync(planFile, 'utf-8')));
    }
    return plans;
  } catch { return []; }
}

// ─── aggregateAllPlans / aggregatePlans ───
export function aggregateAllPlans() { return aggregatePlans(loadAllPlans()); }
export function aggregatePlans(plans) {
  const real = (plans || []).filter(p => !hasTestPlanMarker(p));
  if (real.length === 0) return null;
  return _aggregate(real);
}
function _aggregate(plans) {
  let totalTopics = 0, totalDone = 0, totalQuestions = 0, totalTime = 0;
  let allWeakPoints = [], allExercises = [], allExamResults = [], allQuizResults = [];
  let modeCounts = {};
  let feynmanData = { sessionCount: 0, teachingQualities: [], commonGaps: [], commonStrengths: [], sparklingCount: 0, lingeringCount: 0 };
  let allTimeLogs = [];

  const planSummaries = plans.map(plan => {
    const topics = Array.isArray(plan.topics) ? plan.topics : [];
    const doneCount = topics.filter(t => t.done && !t.lastError).length;
    totalTopics += topics.length; totalDone += doneCount;
    totalQuestions += (Array.isArray(plan.history) ? plan.history.filter(h => h && h.role === 'user') : []).length;

    for (const t of topics) {
      const ts = t.timeSpent;
      if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) totalTime += ts;
      if (Array.isArray(t.timeLog)) {
        for (const e of t.timeLog) {
          if (_validDate(e && e.date) && _validSec(e && e.seconds)) allTimeLogs.push({ date: e.date, seconds: e.seconds, plan: plan.name, topic: t.title });
        }
      }
      if (t.feynmanInsights) {
        feynmanData.sessionCount++;
        if (t.feynmanInsights.teachingQuality) feynmanData.teachingQualities.push(t.feynmanInsights.teachingQuality);
        if (Array.isArray(t.feynmanInsights.gaps)) feynmanData.commonGaps.push(...t.feynmanInsights.gaps.filter(Boolean));
        if (Array.isArray(t.feynmanInsights.strengths)) feynmanData.commonStrengths.push(...t.feynmanInsights.strengths.filter(Boolean));
        if (Array.isArray(t.feynmanInsights.sparklingExplanations)) feynmanData.sparklingCount += t.feynmanInsights.sparklingExplanations.length;
        if (Array.isArray(t.feynmanInsights.lingeringQuestions)) feynmanData.lingeringCount += t.feynmanInsights.lingeringQuestions.length;
      }
    }
    for (const t of topics) {
      if (Array.isArray(t.weakPoints) && t.weakPoints.length > 0) allWeakPoints.push({ topic: t.title, plan: plan.name, weakPoints: t.weakPoints.filter(Boolean) });
      if (Array.isArray(t.exercises) && t.exercises.length > 0) allExercises.push({ topic: t.title, plan: plan.name, exercises: t.exercises });
    }
    if (Array.isArray(plan.examPapers)) {
      for (const exam of plan.examPapers) {
        if (Array.isArray(exam.results) && exam.results.length > 0) allExamResults.push({ plan: plan.name, exam: exam.title || exam.id, results: exam.results, gradedAt: exam.gradedAt || exam.createdAt });
      }
    }
    if (Array.isArray(plan.quickQuizHistory)) {
      for (const qr of plan.quickQuizHistory) {
        if (Array.isArray(qr.results)) allQuizResults.push({ results: qr.results, createdAt: qr.createdAt });
      }
    }
    for (const t of topics) {
      const usage = t.interactiveModeUsage || {};
      let hasValid = false;
      for (const [m, d] of Object.entries(usage)) {
        if (!ALLOWED_MODES.has(m)) continue;
        const cnt = (typeof d?.count === 'number' && Number.isFinite(d.count) && d.count >= 0) ? Math.floor(d.count) : 0;
        if (cnt > 0) { modeCounts[m] = (modeCounts[m] || 0) + cnt; hasValid = true; }
      }
      if (!hasValid && t.interactiveSession && ALLOWED_MODES.has(t.interactiveSession.mode)) {
        modeCounts[t.interactiveSession.mode] = (modeCounts[t.interactiveSession.mode] || 0) + 1;
      }
    }
    return { id: plan.id, name: plan.name, topicCount: topics.length, doneCount, completionRate: topics.length > 0 ? Math.round((doneCount / topics.length) * 100) : 0, createdAt: plan.createdAt, updatedAt: plan.updatedAt };
  });

  let tEx = 0, cEx = 0;
  for (const e of allExercises) { for (const x of (e.exercises || [])) { if (x.correct === true || x.correct === false) { tEx++; if (x.correct) cEx++; } } }
  let tExm = 0, cExm = 0;
  for (const e of allExamResults) { for (const r of (e.results || [])) { if (r.correct === true || r.correct === false) { tExm++; if (r.correct) cExm++; } } }
  let tQz = 0, cQz = 0;
  for (const q of allQuizResults) { for (const r of (q.results || [])) { if (r.correct === true || r.correct === false) { tQz++; if (r.correct) cQz++; } } }

  // ── Today / This week stats ──
  const _nowTs = Date.now();
  const _todayStart = new Date(); _todayStart.setHours(0,0,0,0);
  const _todayMs = _todayStart.getTime();
  const _weekStart = new Date(_todayStart); _weekStart.setDate(_weekStart.getDate() - 6);
  const _weekMs = _weekStart.getTime();
  let tdEx = 0, tdCEx = 0, wkEx = 0, wkCEx = 0;
  let tdExm = 0, tdCExm = 0, wkExm = 0, wkCExm = 0;
  let tdQz = 0, tdCQz = 0, wkQz = 0, wkCQz = 0;
  for (const e of allExercises) {
    for (const x of (e.exercises || [])) {
      if (x.correct !== true && x.correct !== false) continue;
      const gt = x.gradedAt;
      if (gt && gt >= _todayMs) { tdEx++; if (x.correct) tdCEx++; }
      if (gt && gt >= _weekMs) { wkEx++; if (x.correct) wkCEx++; }
    }
  }
  for (const e of allExamResults) {
    for (const r of (e.results || [])) {
      if (r.correct !== true && r.correct !== false) continue;
      const gt = e.gradedAt;
      if (gt && gt >= _todayMs) { tdExm++; if (r.correct) tdCExm++; }
      if (gt && gt >= _weekMs) { wkExm++; if (r.correct) wkCExm++; }
    }
  }
  for (const q of allQuizResults) {
    for (const r of (q.results || [])) {
      if (r.correct !== true && r.correct !== false) continue;
      const ct = q.createdAt;
      if (ct && ct >= _todayMs) { tdQz++; if (r.correct) tdCQz++; }
      if (ct && ct >= _weekMs) { wkQz++; if (r.correct) wkCQz++; }
    }
  }
  const todayCombined = { total: tdEx + tdExm + tdQz, correct: tdCEx + tdCExm + tdCQz };
  const weekCombined = { total: wkEx + wkExm + wkQz, correct: wkCEx + wkCExm + wkCQz };

  const wpFreq = {};
  for (const w of allWeakPoints) { for (const wp of (w.weakPoints || [])) { if (typeof wp === 'string') wpFreq[wp] = (wpFreq[wp] || 0) + 1; } }
  const sortedWp = Object.entries(wpFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n, c]) => ({ name: n, count: c }));

  const dailyMap = {};
  for (const l of allTimeLogs) dailyMap[l.date] = (dailyMap[l.date] || 0) + l.seconds;
  const sortedDays = Object.entries(dailyMap).sort((a, b) => a[0].localeCompare(b[0])).map(([d, s]) => ({ date: d, seconds: s, hours: Math.round(s / 3600 * 10) / 10 }));
  const today = _dateString();
  const d30S = _dateStringOffset(-30);
  let t7 = 0, t30 = 0;
  const l7 = [];
  for (let i=6; i>=0; i--) { const ds = _dateStringOffset(-i); const s=dailyMap[ds]||0; l7.push({date:ds,seconds:s,hours:Math.round(s/3600*10)/10}); t7+=s; }
  for (const [d,s] of Object.entries(dailyMap)) { if (d>=d30S && d<=today) t30+=s; }
  const activeDays = sortedDays.filter(d => d.seconds>0).length;
  const avgDay = activeDays>0 ? Math.round(totalTime/activeDays) : 0;
  const peak = sortedDays.reduce((m,d) => d.seconds > ((m&&m.seconds)||0) ? d : m, null);

  return { planSummaries,
    stats: { totalPlans: plans.length, totalTopics, totalDone, totalQuestions, totalTimeSeconds: totalTime, totalTimeHours: Math.round(totalTime/3600*10)/10, overallCompletionRate: totalTopics>0 ? Math.round((totalDone/totalTopics)*100) : 0 },
    exerciseStats: { total: tEx, correct: cEx, rate: tEx>0 ? Math.round((cEx/tEx)*100) : 0 },
    examStats: { total: tExm, correct: cExm, rate: tExm>0 ? Math.round((cExm/tExm)*100) : 0 },
    quickQuizStats: { total: tQz, correct: cQz, rate: tQz>0 ? Math.round((cQz/tQz)*100) : 0 },
    todayStats: { total: todayCombined.total, correct: todayCombined.correct, rate: todayCombined.total > 0 ? Math.round((todayCombined.correct / todayCombined.total) * 100) : 0, exercises: { total: tdEx, correct: tdCEx }, exams: { total: tdExm, correct: tdCExm }, quizzes: { total: tdQz, correct: tdCQz } },
    weekStats: { total: weekCombined.total, correct: weekCombined.correct, rate: weekCombined.total > 0 ? Math.round((weekCombined.correct / weekCombined.total) * 100) : 0, exercises: { total: wkEx, correct: wkCEx }, exams: { total: wkExm, correct: wkCExm }, quizzes: { total: wkQz, correct: wkCQz } },
    weakPoints: allWeakPoints, weakPointsSummary: sortedWp, modeCounts, feynmanData,
    timeDistribution: { daily: sortedDays, last7Days: l7, summary: { totalTimeSeconds: totalTime, timeLast7Days: t7, timeLast30Days: t30, activeDays, avgPerDaySeconds: avgDay, avgPerDayHours: Math.round(avgDay/3600*10)/10, peakDay: peak ? { date: peak.date, seconds: peak.seconds, hours: peak.hours } : null } },
  };
}
function _gd(title, planName) {
  const lower = title.toLowerCase();
  if (/协议|tcp|http|网络|socket|dns/.test(lower)) return '网络协议';
  if (/算法|排序|搜索|数据结构|tree|graph/.test(lower)) return '算法与数据结构';
  if (/线程|进程|并发|锁|同步|异步/.test(lower)) return '并发编程';
  if (/编译|链接|汇编|寄存器|指令/.test(lower)) return '系统底层';
  if (/数据库|sql|索引|事务|nosql/.test(lower)) return '数据库';
  if (/设计模式|架构|框架|模式/.test(lower)) return '软件设计';
  return planName || '通用';
}
function _san(s, maxLen) {
  maxLen = maxLen || 120;
  if (typeof s !== "string") return "";
  s = s.replace(/```/g, "");
  let r = "";
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc < 32 && cc !== 9 && cc !== 10) continue;
    if (cc === 10) { r += " "; continue; }
    r += s[i];
  }
  r = r.trim();
  while (r.indexOf("  ") >= 0) r = r.replace("  ", " ");
  return r.slice(0, maxLen);
}
function _dateString(date = new Date()) { return date.toISOString().slice(0, 10); }
function _dateStringOffset(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return _dateString(date);
}
function _validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  if (isNaN(d.getTime())) return false;
  if (d.getUTCFullYear() !== p[0] || d.getUTCMonth() + 1 !== p[1] || d.getUTCDate() !== p[2]) return false;
  return s <= _dateString();
}
function _validSec(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0; }

// ─── Profile read/write ───
export function getUserProfile() {
  if (!fs.existsSync(PROFILE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8')); } catch { return null; }
}
export function writeUserProfile(data) {
  const tmp = PROFILE_FILE + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try { fs.renameSync(tmp, PROFILE_FILE); } catch { fs.copyFileSync(tmp, PROFILE_FILE); fs.unlinkSync(tmp); }
  } catch { fs.writeFileSync(PROFILE_FILE, JSON.stringify(data, null, 2), 'utf-8'); try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} }
}

export function getUserProfileForDisplay() {
  const stored = getUserProfile();
  return stored ? profileUpdater(stored, loadAllPlans()) : null;
}

// ─── hasBehaviorEvidence / hasAIProfile ───
export function hasBehaviorEvidence(profile) {
  if (!profile) return false;
  if (profile.profileSource === 'behavior' || profile.profileSource === 'ai+behavior') return true;
  if (typeof profile._lastIncrementalUpdate === 'number' && Number.isFinite(profile._lastIncrementalUpdate) && profile._lastIncrementalUpdate > 0) return true;
  if ((profile.strengths || []).some(s => s.source === 'behavior')) return true;
  if ((profile.weaknesses || []).some(w => w.source === 'behavior')) return true;
  if ((profile.crossPlanWeakEvidence || []).some(e => e.source === 'behavior')) return true;
  return false;
}
export function hasAIProfile(profile) {
  if (!profile) return false;
  return typeof profile.lastAnalyzedAt === 'number' && Number.isFinite(profile.lastAnalyzedAt) && profile.lastAnalyzedAt > 0;
}

export function profileUpdater(currentProfile, allPlans) {
  const profile = currentProfile || { learnerPersona: { type: [], summary: '', confidence: 0.5 }, strengths: [], weaknesses: [], crossPlanWeakPoints: [], crossPlanWeakEvidence: [], learningPatterns: { preferredModes: {}, avgQuestionsPerTopic: 0, timeStats: {}, questionStyle: '', timeDistribution: '', completionTrend: '' }, recommendations: [], aiAnalysis: '' };
  const now = Date.now();
  const realPlans = (allPlans || []).filter(p => !hasTestPlanMarker(p));
  if (realPlans.length === 0) { profile._lastIncrementalUpdate = now; profile._totalIncrementalUpdates = (profile._totalIncrementalUpdates || 0) + 1; return profile; }

  // ── 1. Evidence collection ──
  const topicEv = {};
  const addEv = (title, ok) => { const k = (typeof title === 'string' ? title.trim() : ''); if (!k) return; if (!topicEv[k]) topicEv[k] = { correct: 0, attempts: 0 }; topicEv[k].attempts++; if (ok) topicEv[k].correct++; };

  for (const plan of realPlans) {
    const idMap = {};
    for (const t of (plan.topics || [])) { if (t.id && t.title) idMap[t.id] = t.title; }
    for (const t of (plan.topics || [])) {
      for (const e of (t.exercises || [])) { if (e.correct === true || e.correct === false) addEv(t.title, e.correct === true); }
    }
    for (const exam of (plan.examPapers || [])) {
      if (!Array.isArray(exam.results) || !Array.isArray(exam.questions)) continue;
      for (const r of exam.results) {
        if (r.correct !== true && r.correct !== false) continue;
        const q = exam.questions[r.exerciseIndex];
        let t = '';
        if (q && q.topicId && idMap[q.topicId]) t = idMap[q.topicId]; else if (q && q.topicTitle) t = q.topicTitle; else if (q && q.conceptTag) t = q.conceptTag; else t = r.topicTitle || '';
        addEv(t, r.correct === true);
      }
    }
    for (const qr of (plan.quickQuizHistory || [])) {
      if (!Array.isArray(qr.results) || !Array.isArray(qr.questions)) continue;
      for (const r of qr.results) {
        if (r.correct !== true && r.correct !== false) continue;
        const q = qr.questions[r.exerciseIndex];
        addEv((q && q.topicTitle) || (q && q.conceptTag) || '', r.correct === true);
      }
    }
  }

  // ── 2. Domain ──
  const titlePlans = {};
  for (const plan of realPlans) { const s = new Set(); for (const t of (plan.topics || [])) { if (t.title && !s.has(t.title)) { s.add(t.title); titlePlans[t.title] = (titlePlans[t.title] || 0) + 1; } } }
  const td = {};
  for (const plan of realPlans) { for (const t of (plan.topics || [])) { if (t.title && !td[t.title]) td[t.title] = _gd(t.title, plan.name); } }
  for (const [ti, c] of Object.entries(titlePlans)) { if (c > 1) td[ti] = '通用'; }
  const db = {};
  for (const [ti, ev] of Object.entries(topicEv)) { const d = td[ti] || '通用'; if (!db[d]) db[d] = { correct: 0, attempts: 0, topics: [] }; db[d].correct += ev.correct; db[d].attempts += ev.attempts; db[d].topics.push(ti); }

  // ── 3. Strength/weakness ──
  const nb = [];
  for (const [d, b] of Object.entries(db)) { const m = b.attempts > 0 ? Math.round((b.correct / b.attempts) * 100) / 100 : 0; nb.push({ domain: d, topics: b.topics, evidence: '练习/测验正确率 ' + Math.round(m * 100) + '%（' + b.attempts + '题）', masteryLevel: m, sampleSize: b.attempts, lastUpdated: now, source: 'behavior' }); }
  profile.strengths = [...(profile.strengths || []).filter(s => s.source !== 'behavior'), ...nb.filter(b => b.masteryLevel >= 0.7)];
  profile.weaknesses = [...(profile.weaknesses || []).filter(w => w.source !== 'behavior'), ...nb.filter(b => b.masteryLevel < 0.7)];

  // ── 4. learningPatterns ──
  const mc = {}; let tt = 0, tq = 0, tts = 0; const ds = {};
  for (const plan of realPlans) {
    tt += (plan.topics || []).length; tq += (Array.isArray(plan.history) ? plan.history.filter(h => h && h.role === 'user') : []).length;
    for (const t of (plan.topics || [])) {
      const ts = t.timeSpent; if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) tts += ts;
      const usage = t.interactiveModeUsage || {}; let hv = false;
      for (const [m, d] of Object.entries(usage)) { if (!ALLOWED_MODES.has(m)) continue; const cnt = (typeof d?.count === 'number' && Number.isFinite(d.count) && d.count >= 0) ? Math.floor(d.count) : 0; if (cnt > 0) { mc[m] = (mc[m] || 0) + cnt; hv = true; } }
      if (!hv && t.interactiveSession && ALLOWED_MODES.has(t.interactiveSession.mode)) mc[t.interactiveSession.mode] = (mc[t.interactiveSession.mode] || 0) + 1;
      if (Array.isArray(t.timeLog)) { for (const e of t.timeLog) { if (_validDate(e && e.date) && _validSec(e && e.seconds)) ds[e.date] = (ds[e.date] || 0) + e.seconds; } }
    }
  }
  const ad = Object.values(ds).filter(v => v > 0).length;
  const avgD = ad > 0 ? Math.round(tts / ad) : 0;
  const nms = Date.now(); const S7 = 7 * 86400000, S30 = 30 * 86400000; let l7 = 0, l30 = 0;
  for (const [d, s] of Object.entries(ds)) { const age = nms - new Date(d).getTime(); if (age >= 0 && age <= S7) l7 += s; if (age >= 0 && age <= S30) l30 += s; }
  const sm = Object.entries(mc).sort((a, b) => b[1] - a[1]); const pm = {}; for (const [m, c] of sm) pm[m] = c;
  profile.learningPatterns = {
    preferredModes: pm,
    avgQuestionsPerTopic: tt > 0 ? Math.round((tq / tt) * 10) / 10 : 0,
    timeStats: { totalSeconds: tts, activeDays: ad, avgSecondsPerActiveDay: avgD, last7DaysSeconds: l7, last30DaysSeconds: l30 },
    questionStyle: '',
    questionStyleEvidence: { sampleSize: tq, matchedCount: 0, category: null },
    studyRhythm: { activeDays: ad, avgSecondsPerActiveDay: avgD, last7DaysSeconds: l7, last30DaysSeconds: l30 },
    completionTrend: profile.learningPatterns?.completionTrend || '',
  };

  // ── 5. Structured evidence ──
  const acc = new Map();
  for (const [ti, ev] of Object.entries(topicEv)) { const r = ev.correct / ev.attempts; if (r < 0.6) { const l = _san(ti); if (l) { if (!acc.has(l)) acc.set(l, { bh: null, wp: 0, fg: 0 }); acc.get(l).bh = { sampleSize: ev.attempts, masteryLevel: Math.round(r * 100) / 100 }; } } }
  for (const plan of realPlans) { for (const t of (plan.topics || [])) { if (!Array.isArray(t.weakPoints)) continue; const te = topicEv[t.title]; if (!te || (te.correct / te.attempts) >= 0.7) continue; const seen = new Set(); for (const w of t.weakPoints) { const l = _san(w); if (!l || seen.has(l)) continue; seen.add(l); if (!acc.has(l)) acc.set(l, { bh: null, wp: 0, fg: 0 }); acc.get(l).wp++; } } }
  for (const plan of realPlans) { for (const t of (plan.topics || [])) { const fi = t.feynmanInsights; if (!fi || (fi.teachingQuality !== 'fair' && fi.teachingQuality !== 'needsWork')) continue; const seen = new Set(); if (Array.isArray(fi.gaps) && fi.gaps.length > 0) { for (const g of fi.gaps) { const l = _san(g); if (!l || seen.has(l)) continue; seen.add(l); if (!acc.has(l)) acc.set(l, { bh: null, wp: 0, fg: 0 }); acc.get(l).fg++; } } else { const l = _san(t.title); if (l && !seen.has(l)) { seen.add(l); if (!acc.has(l)) acc.set(l, { bh: null, wp: 0, fg: 0 }); acc.get(l).fg++; } } } }
  const mat = [];
  for (const [label, entry] of acc) {
    if (entry.bh) { const o = { label, source: 'behavior', sampleSize: entry.bh.sampleSize, masteryLevel: entry.bh.masteryLevel }; if (entry.wp > 0 || entry.fg > 0) { o.supportingSources = []; if (entry.wp > 0) o.supportingSources.push('weakPoint'); if (entry.fg > 0) o.supportingSources.push('feynmanGap'); } mat.push(o); }
    else if (entry.wp > 0 || entry.fg > 0) { if (entry.wp >= entry.fg) mat.push({ label, source: 'weakPoint', sampleSize: entry.wp }); else mat.push({ label, source: 'feynmanGap', sampleSize: entry.fg }); }
  }
  mat.sort((a, b) => a.label.localeCompare(b.label));
  const lim = mat.slice(0, 50);
  profile.crossPlanWeakEvidence = lim;
  profile.crossPlanWeakPoints = lim.map(e => e.label);

  // ── 6. Persona ──
  const M3 = 3, MR = 0.3; let tqa = 0; const qt = { why: 0, how: 0, compare: 0, confirm: 0, apply: 0, deep: 0 };
  for (const plan of realPlans) { for (const h of (plan.history || [])) { if (!h || h.role !== 'user') continue; tqa++; const q = (h.content || '').toLowerCase(); if (/为什么|why|原因|原因是|原理|底层|背后/.test(q)) qt.why++; if (/怎么用|如何|怎么|示例|例子|代码|example|实践/.test(q)) qt.how++; if (/区别|对比|vs|versus|不同|比较|还是|差异/.test(q)) qt.compare++; if (/对吗|是不是|对吗|对吧|我的理解|确认/.test(q)) qt.confirm++; if (/应用|场景|实际|项目|生产|工作中/.test(q)) qt.apply++; if (/深入|追问|进一步|再问|还是不懂|换个角度/.test(q)) qt.deep++; } }
  const dt = Object.entries(qt).sort((a, b) => b[1] - a[1])[0];
  profile.learningPatterns.questionStyleEvidence = {
    sampleSize: tqa,
    matchedCount: dt?.[1] || 0,
    category: dt?.[1] > 0 ? dt[0] : null,
  };
  if (dt && dt[1] >= M3 && tqa > 0 && (dt[1] / tqa) >= MR) {
    const tmap = { why: '深度思考型', how: '实践应用型', compare: '类比联想型', confirm: '谨慎确认型', apply: '目标驱动型', deep: '深度思考型' };
    const styleMap = { why: '原理探究型', how: '实践示例型', compare: '对比辨析型', confirm: '验证确认型', apply: '场景应用型', deep: '持续追问型' };
    const lt = tmap[dt[0]];
    profile.learningPatterns.questionStyle = styleMap[dt[0]] || '';
    if (lt && profile.learnerPersona) { const existingTypes = Array.isArray(profile.learnerPersona.type) ? profile.learnerPersona.type : []; if (!existingTypes.includes(lt)) profile.learnerPersona.type = [...new Set([...existingTypes, lt])]; const bonus = Math.min(tqa / 50, 0.1); profile.learnerPersona.confidence = Math.min(1, Math.round((0.5 + bonus) * 100) / 100); profile.learnerPersona.evidenceFromBehavior = '在 ' + tqa + ' 个问题中，有 ' + dt[1] + ' 次属于' + profile.learningPatterns.questionStyle + '提问'; }
  }

  profile._lastIncrementalUpdate = now;
  profile._totalIncrementalUpdates = (profile._totalIncrementalUpdates || 0) + 1;
  return profile;
}

export async function generateUserProfile(provider, model = 'gpt-4o-mini', { plans: extPlans } = {}) {
  const raw = extPlans !== undefined ? (Array.isArray(extPlans) ? extPlans : []) : loadAllPlans();
  const realPlans = raw.filter(p => !hasTestPlanMarker(p));
  const aggregated = aggregatePlans(realPlans);
  if (!aggregated) throw new Error('没有学习计划数据，无法生成画像');

  const inputData = {
    planSummaries: aggregated.planSummaries,
    stats: aggregated.stats,
    exerciseStats: aggregated.exerciseStats,
    examStats: aggregated.examStats,
    quickQuizStats: aggregated.quickQuizStats,
    weakPointsSummary: aggregated.weakPointsSummary,
    modeCounts: aggregated.modeCounts,
    feynmanStats: aggregated.feynmanData,
    weakPointsByPlan: aggregated.weakPoints.map(w => ({ plan: w.plan, topic: w.topic, weakPoints: w.weakPoints })),
  };

  const systemPrompt = '你是一个学习分析专家。请根据以下学习计划聚合数据，生成用户画像。只输出 JSON，不要其他文字。聚合数据不包含具体提问文本或一天内的学习时刻，因此不得推断提问风格或早晚学习偏好。\n\nJSON 结构：{\n  "learnerPersona": { "type": ["类型1", "类型2"], "summary": "一句话总结", "confidence": 0.85 },\n  "strengths": [{ "domain": "领域", "topics": ["知识点"], "evidence": "数据证据", "masteryLevel": 0.9 }],\n  "weaknesses": [{ "domain": "领域", "topics": ["知识点"], "evidence": "数据证据", "masteryLevel": 0.3, "frequency": "high", "suggestedAction": "建议" }],\n  "crossPlanWeakPoints": ["薄弱概念"],\n  "learningPatterns": { "preferredModes": {}, "avgQuestionsPerTopic": 0, "completionTrend": "" },\n  "recommendations": ["建议"],\n  "aiAnalysis": "Markdown 分析报告"\n}';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '以下是我的所有学习计划聚合数据，请构建用户画像：\n\n```json\n' + JSON.stringify(inputData, null, 2) + '\n```' },
  ];

  const result = await provider.complete(messages, { maxTokens: 16384, temperature: 0.7, responseFormat: { type: 'json_object' }, model });
  if (!result || typeof result.content !== 'string' || !result.content.trim()) throw new Error('AI 返回内容为空');

  let profileData;
  try {
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : result.content.trim();
    profileData = JSON.parse(jsonStr);
  } catch (parseErr) {
    throw new Error('AI 返回 JSON 解析失败，请重试: ' + parseErr.message + '\n回复前 200 字符: ' + result.content.slice(0, 200));
  }

  const analyzedAt = Date.now();
  const finalProfile = mergeGeneratedProfile(profileData, aggregated, realPlans, analyzedAt);
  writeUserProfile(finalProfile);
  return finalProfile;
}

export function buildProfileSummary(aggregated, stored) {
  if (!aggregated) return { hasData: false, message: '还没有学习计划数据' };
  return { hasData: true, hasAIAnalysis: hasAIProfile(stored), hasBehaviorProfile: hasBehaviorEvidence(stored), lastAnalyzedAt: stored?.lastAnalyzedAt || null, stats: aggregated.stats, exerciseStats: aggregated.exerciseStats, examStats: aggregated.examStats, quickQuizStats: aggregated.quickQuizStats, todayStats: aggregated.todayStats, weekStats: aggregated.weekStats, weakPointsSummary: aggregated.weakPointsSummary, feynmanStats: aggregated.feynmanData, planSummaries: aggregated.planSummaries, modeCounts: aggregated.modeCounts, timeDistribution: aggregated.timeDistribution, learnerPersona: stored?.learnerPersona || null, strengths: stored?.strengths || null, weaknesses: stored?.weaknesses || null, recommendations: stored?.recommendations || null };
}

export function getProfileSummary() { return buildProfileSummary(aggregateAllPlans(), getUserProfile()); }

export function mergeGeneratedProfile(profileData, aggregated, plans, analyzedAt) {
  analyzedAt = (analyzedAt === undefined) ? Date.now() : analyzedAt;
  const ca = (a) => Array.isArray(a) ? a.map(x => (x && typeof x === 'object' ? (Array.isArray(x) ? [...x] : { ...x }) : x)) : [];
  const co = (o) => (o && typeof o === 'object' && !Array.isArray(o)) ? { ...o } : o;
  const base = {
    learnerPersona: co(profileData?.learnerPersona) || { type: [], summary: '', confidence: 0 },
    strengths: ca(profileData?.strengths).map(s => ({ ...s, topics: [...(s.topics || [])] })),
    weaknesses: ca(profileData?.weaknesses).map(w => ({ ...w, topics: [...(w.topics || [])] })),
    crossPlanWeakPoints: ca(profileData?.crossPlanWeakPoints),
    crossPlanWeakEvidence: ca(profileData?.crossPlanWeakEvidence).map(e => ({ ...e, supportingSources: [...(e.supportingSources || [])] })),
    learningPatterns: co(profileData?.learningPatterns) || { preferredModes: {}, avgQuestionsPerTopic: 0, timeStats: {}, questionStyle: '', timeDistribution: '', completionTrend: '' },
    recommendations: ca(profileData?.recommendations),
    aiAnalysis: (typeof profileData?.aiAnalysis === 'string') ? profileData.aiAnalysis : '',
    planSummary: aggregated ? { totalPlans: aggregated.stats.totalPlans, totalTopics: aggregated.stats.totalTopics, completedTopics: aggregated.stats.totalDone, overallCompletionRate: aggregated.stats.overallCompletionRate, totalLearningTime: aggregated.stats.totalTimeSeconds, totalQuestions: aggregated.stats.totalQuestions, plans: aggregated.planSummaries } : {},
    exerciseRate: aggregated?.exerciseStats?.rate || 0, examRate: aggregated?.examStats?.rate || 0, quickQuizRate: aggregated?.quickQuizStats?.rate || 0, _rawWeakPoints: ca(aggregated?.weakPoints),
  };
  const updated = profileUpdater(base, plans);
  updated.lastAnalyzedAt = analyzedAt; updated.updatedAt = analyzedAt;
  updated.profileSource = 'ai+behavior';
  updated.planSummary = base.planSummary; updated.exerciseRate = base.exerciseRate; updated.examRate = base.examRate;
  updated.quickQuizRate = base.quickQuizRate; updated._rawWeakPoints = base._rawWeakPoints;
  if (base.aiAnalysis) updated.aiAnalysis = base.aiAnalysis;
  if (base.recommendations.length > 0) updated.recommendations = base.recommendations;
  return updated;
}
