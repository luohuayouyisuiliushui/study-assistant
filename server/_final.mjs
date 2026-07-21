import { readFileSync, writeFileSync } from 'fs';
const file = './engine/user-profile.js';
let c = readFileSync(file, 'utf-8');
c = c.replace(/\r\n/g, '\n');

// ── 1. Import ──
c = c.replace(
  "import { fileURLToPath } from 'url';",
  "import { fileURLToPath } from 'url';\nimport { hasTestPlanMarker } from './store/test-plan-marker.js';"
);

// ── 2. Strict helpers (AFTER imports, BEFORE loadAllPlans) ──
const helpers = `
// ─── Strict helpers ───
const INTERACTIVE_MODES = new Set(['stepwise','challenge','scaffold','realtime','debate','socratic','analogy']);
function toFinite(v) { return typeof v === 'number' && Number.isFinite(v); }
function toNN(v) { return toFinite(v) && v >= 0 ? v : 0; }
function toNNInt(v) { return toFinite(v) && Number.isInteger(v) && v >= 0 ? Math.floor(v) : 0; }
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1]-1, p[2]));
  if (isNaN(d.getTime())) return false;
  if (d.getUTCFullYear() !== p[0] || d.getUTCMonth()+1 !== p[1] || d.getUTCDate() !== p[2]) return false;
  const n = new Date();
  const t = n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
  return s <= t;
}
function sanitize(s, maxLen) {
  maxLen = maxLen || 120;
  if (typeof s !== 'string') return '';
  let r = '';
  for (let i = 0; i < s.length; i++) { const cc = s.charCodeAt(i); if (cc < 32 && cc !== 9 && cc !== 10) continue; r += s[i]; }
  return r.replace(/\r?\n/g,' ').replace(/\s+/g,' ').trim().slice(0, maxLen);
}
`;

c = c.replace('function loadAllPlans()', helpers + '\nfunction loadAllPlans()');

// ── 3. aggregateAllPlans + aggregatePlans + _aggregateBody ──
const oldAggStart = 'export function aggregateAllPlans() {\n  const plans = loadAllPlans();\n  if (plans.length === 0) {\n    return null;\n  }';
c = c.replace(oldAggStart,
  'export function aggregateAllPlans() {\n  return aggregatePlans(loadAllPlans());\n}\n\nexport function aggregatePlans(plans) {\n  const real = (plans || []).filter(p => !hasTestPlanMarker(p));\n  if (real.length === 0) return null;\n  return _agg(real);\n}\n\nfunction _agg(plans) {'
);

// ── 4. hasBehaviorEvidence, hasAIProfile before profileUpdater ──
c = c.replace(
  'export function profileUpdater(currentProfile, allPlans) {',
  'export function hasBehavior(p) {\n  if (!p) return false;\n  if (p.profileSource === \'behavior\' || p.profileSource === \'ai+behavior\') return true;\n  if (typeof p._lastIncrementalUpdate === \'number\' && Number.isFinite(p._lastIncrementalUpdate) && p._lastIncrementalUpdate > 0) return true;\n  if ((p.strengths || []).some(s => s.source === \'behavior\')) return true;\n  if ((p.weaknesses || []).some(w => w.source === \'behavior\')) return true;\n  if ((p.crossPlanWeakEvidence || []).some(e => e.source === \'behavior\')) return true;\n  return false;\n}\n\nexport function hasAI(p) {\n  if (!p) return false;\n  return typeof p.lastAnalyzedAt === \'number\' && Number.isFinite(p.lastAnalyzedAt) && p.lastAnalyzedAt > 0;\n}\n\nexport function profileUpdater(currentProfile, allPlans) {'
);

// ── 5. buildProfileSummary + getProfileSummary wrapper ──
c = c.replace(
  'export function getProfileSummary() {\n  const aggregated = aggregateAllPlans();\n  if (!aggregated) {\n    return { hasData: false, message: \'还没有学习计划数据\' };\n  }\n\n  const stored = getUserProfile();\n\n  return {',
  'export function buildSummary(aggregated, stored) {\n  if (!aggregated) {\n    return { hasData: false, message: \'还没有学习计划数据\' };\n  }\n  return {'
);
c = c.replace(
  '  };\n}\n\n/**\n * Get a lightweight summary',
  '  };\n}\n\nexport function getProfileSummary() {\n  return buildSummary(aggregateAllPlans(), getUserProfile());\n}\n\n/**\n * Get a lightweight summary'
);

// ── 6. mergeGeneratedProfile before getUserProfile ──
c = c.replace(
  'export function getUserProfile() {',
  'export function mergeGP(pd, agg, plans, at) {\n  at = at || Date.now();\n  const ca = (a) => Array.isArray(a) ? [...a] : [];\n  const co = (o) => o && typeof o === \'object\' ? {...o} : o;\n  const base = {\n    learnerPersona: co(pd.learnerPersona) || {type:[], summary:\'\', confidence:0},\n    strengths: ca(pd.strengths).map(s => ({...s})),\n    weaknesses: ca(pd.weaknesses).map(w => ({...w})),\n    recommendations: ca(pd.recommendations),\n    aiAnalysis: typeof pd.aiAnalysis === \'string\' ? pd.aiAnalysis : \'\',\n    crossPlanWeakPoints: ca(pd.crossPlanWeakPoints),\n    crossPlanWeakEvidence: ca(pd.crossPlanWeakEvidence).map(e => ({...e})),\n    learningPatterns: {\n      preferredModes: {...((pd.learningPatterns||{}).preferredModes||{})},\n      avgQuestionsPerTopic: (pd.learningPatterns||{}).avgQuestionsPerTopic || 0,\n      timeStats: {...((pd.learningPatterns||{}).timeStats||{})},\n      questionStyle: (pd.learningPatterns||{}).questionStyle || \'\',\n      timeDistribution: (pd.learningPatterns||{}).timeDistribution || \'\',\n      completionTrend: (pd.learningPatterns||{}).completionTrend || \'\',\n    },\n    planSummary: {totalPlans: agg.stats.totalPlans, totalTopics: agg.stats.totalTopics, completedTopics: agg.stats.totalDone, overallCompletionRate: agg.stats.overallCompletionRate, totalLearningTime: agg.stats.totalTimeSeconds, totalQuestions: agg.stats.totalQuestions, plans: agg.planSummaries},\n    exerciseRate: (agg.exerciseStats||{}).rate || 0,\n    examRate: (agg.examStats||{}).rate || 0,\n    quickQuizRate: (agg.quickQuizStats||{}).rate || 0,\n    _rawWeakPoints: ca(agg.weakPoints),\n  };\n  const u = profileUpdater(base, plans);\n  u.lastAnalyzedAt = at; u.updatedAt = at; u.profileSource = \'ai+behavior\';\n  u.planSummary = base.planSummary; u.exerciseRate = base.exerciseRate; u.examRate = base.examRate;\n  u.quickQuizRate = base.quickQuizRate; u._rawWeakPoints = base._rawWeakPoints;\n  if (base.aiAnalysis) u.aiAnalysis = base.aiAnalysis;\n  if (base.recommendations.length > 0) u.recommendations = base.recommendations;\n  return u;\n}\n\nexport function getUserProfile() {'
);

// ── 7. generateUserProfile third param ──
c = c.replace(
  'export async function generateUserProfile(provider, model) {',
  'export async function generateUserProfile(provider, model = \'gpt-4o-mini\', { plans: extPlans } = {}) {'
);
c = c.replace(
  "  const realPlans = loadAllPlans().filter(p => !hasTestPlanMarker(p));",
  "  const raw = extPlans !== undefined ? extPlans : loadAllPlans();\n  const realPlans = raw.filter(p => !hasTestPlanMarker(p));"
);

// ── 8. Update buildSummary/getProfileSummary reference: hasBehaviorEvidence -> hasBehavior, hasAIProfile -> hasAI ──
// Since we renamed them, update the calls
c = c.replace(/\bhasBehaviorEvidence\b/g, 'hasBehavior');
c = c.replace(/\bhasAIProfile\b/g, 'hasAI');

writeFileSync(file, c, 'utf-8');
console.log('ALL changes applied');
