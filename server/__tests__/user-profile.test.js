/**
 * Unit tests for user-profile module.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { aggregatePlans, profileUpdater, getProfileSummary, getUserProfile, generateUserProfile, mergeGeneratedProfile } from '../engine/user-profile.js';

const PROFILE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'learn', 'user-profile.json');
const PROFILE_BAK_FILE = PROFILE_FILE + '.bak';
const PROFILE_V2_BAK_FILE = path.join(path.dirname(PROFILE_FILE), '.backups-v2', 'user-profile.json');
let originalProfileBuffer = null, profileExisted = false;

function snapshotProfileFile(filePath = PROFILE_FILE) {
  return fs.existsSync(filePath) ? { exists: true, bytes: fs.readFileSync(filePath) } : { exists: false, bytes: null };
}
const snapshotProfileFileAt = snapshotProfileFile;
function restoreProfileFile(filePath, snapshot) {
  if (snapshot.exists) fs.writeFileSync(filePath, snapshot.bytes);
  else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
function assertProfileUnchanged(snap) {
  assert.equal(fs.existsSync(PROFILE_FILE), snap.exists);
  if (snap.exists) assert.ok(fs.readFileSync(PROFILE_FILE).equals(snap.bytes));
}

function makeTopic(t, o) { return { id: o?.id || 't-'+t, title: t, detail: 'd', done: true, exercises: o?.exercises || [], weakPoints: o?.weakPoints || [], timeSpent: o?.timeSpent || 0, timeLog: o?.timeLog || [], interactiveModeUsage: o?.interactiveModeUsage || {}, feynmanInsights: o?.feynmanInsights || null }; }

before(() => { profileExisted = fs.existsSync(PROFILE_FILE); if (profileExisted) originalProfileBuffer = fs.readFileSync(PROFILE_FILE); });
after(() => { if (profileExisted && originalProfileBuffer) fs.writeFileSync(PROFILE_FILE, originalProfileBuffer); else if (fs.existsSync(PROFILE_FILE)) fs.unlinkSync(PROFILE_FILE); });

describe('aggregatePlans feynman', () => {
  it('sparkling/lingering counts', () => {
    const plan = { id:'p', name:'P', topics:[{ id:'t', title:'A', detail:'d', done:true, exercises:[], timeSpent:0, timeLog:[], interactiveModeUsage:{}, feynmanInsights:{teachingQuality:'good', gaps:[], strengths:[], sparklingExplanations:[{c:1},{c:2}], lingeringQuestions:[{q:1},{q:2},{q:3}]} }], examPapers:[], quickQuizHistory:[], history:[] };
    const r = aggregatePlans([plan]);
    assert.equal(r.feynmanData.sparklingCount, 2);
    assert.equal(r.feynmanData.lingeringCount, 3);
  });
});

describe('profileUpdater', () => {
  it('strength from correct', () => { const r = profileUpdater(null, [{ id:'p', name:'P', topics:[makeTopic('TCP',{exercises:[{correct:true},{correct:true}]})], examPapers:[], quickQuizHistory:[], history:[] }]); assert.ok(r.strengths.some(s => s.masteryLevel >= 0.7)); });
  it('weakness from incorrect', () => { const r = profileUpdater(null, [{ id:'p', name:'P', topics:[makeTopic('UDP',{exercises:[{correct:false},{correct:false}]})], examPapers:[], quickQuizHistory:[], history:[] }]); assert.ok(r.weaknesses.some(w => w.masteryLevel < 0.7)); });
  it('learnerPersona from Q&A', () => { const p = { id:'p', name:'P', topics:[makeTopic('A')], examPapers:[], quickQuizHistory:[], history:[{role:'user',content:'为什么？'},{role:'user',content:'原理？'},{role:'user',content:'原因？'}] }; const r = profileUpdater(null, [p]); assert.ok(r.learnerPersona.type.includes('深度思考型')); });
  it('crossPlan from multi-plan', () => { const ps = [{ id:'p1', name:'P1', topics:[makeTopic('A',{exercises:[{correct:false},{correct:false}]})], examPapers:[], quickQuizHistory:[], history:[] }, { id:'p2', name:'P2', topics:[makeTopic('B',{exercises:[{correct:false},{correct:false}]})], examPapers:[], quickQuizHistory:[], history:[] }]; assert.equal(profileUpdater(null, ps).crossPlanWeakPoints.length, 2); });
  it('empty returns skeleton', () => { const r = profileUpdater(null, []); assert.ok(r.learnerPersona); assert.equal(r.strengths.length, 0); });
  it('marker isolation', () => { const m = Object.assign({ id:'m', name:'M', topics:[makeTopic('MARKER')], examPapers:[], quickQuizHistory:[], history:[] }, {__testPlan:{marker:'study-assistant/node-test/v1'}}); const r = profileUpdater(null, [{ id:'r', name:'R', topics:[makeTopic('A')], examPapers:[], quickQuizHistory:[], history:[] }, m]); assert.ok(!r.crossPlanWeakPoints.includes('MARKER')); });
});

describe('getProfileSummary shape', () => { it('has expected fields', () => { const r = getProfileSummary(); assert.ok('hasData' in r); assert.ok('hasAIAnalysis' in r); }); });

describe('getUserProfile', () => {
  it('no file -> null', () => { if (fs.existsSync(PROFILE_FILE)) { const b = fs.readFileSync(PROFILE_FILE); fs.unlinkSync(PROFILE_FILE); try { assert.equal(getUserProfile(), null); } finally { fs.writeFileSync(PROFILE_FILE, b); } } else assert.equal(getUserProfile(), null); });
  it('valid JSON parsed', () => { fs.writeFileSync(PROFILE_FILE, JSON.stringify({test:true})); try { assert.ok(getUserProfile().test); } finally { if (originalProfileBuffer) fs.writeFileSync(PROFILE_FILE, originalProfileBuffer); else if (fs.existsSync(PROFILE_FILE)) fs.unlinkSync(PROFILE_FILE); } });
  it('corrupt JSON without backups -> null', () => {
    const profile = snapshotProfileFile();
    const bak = snapshotProfileFileAt(PROFILE_BAK_FILE);
    const v2Bak = snapshotProfileFileAt(PROFILE_V2_BAK_FILE);
    if (bak.exists) fs.unlinkSync(PROFILE_BAK_FILE);
    if (v2Bak.exists) fs.unlinkSync(PROFILE_V2_BAK_FILE);
    fs.writeFileSync(PROFILE_FILE, '{bad');
    try { assert.equal(getUserProfile(), null); }
    finally {
      restoreProfileFile(PROFILE_FILE, profile);
      restoreProfileFile(PROFILE_BAK_FILE, bak);
      restoreProfileFile(PROFILE_V2_BAK_FILE, v2Bak);
    }
  });
  it('corrupt JSON recovers from backup', () => {
    const profile = snapshotProfileFile();
    const bak = snapshotProfileFileAt(PROFILE_BAK_FILE);
    const v2Bak = snapshotProfileFileAt(PROFILE_V2_BAK_FILE);
    fs.writeFileSync(PROFILE_BAK_FILE, JSON.stringify({ restored: true }));
    fs.writeFileSync(PROFILE_FILE, '{bad');
    try { assert.deepEqual(getUserProfile(), { restored: true }); }
    finally {
      restoreProfileFile(PROFILE_FILE, profile);
      restoreProfileFile(PROFILE_BAK_FILE, bak);
      restoreProfileFile(PROFILE_V2_BAK_FILE, v2Bak);
    }
  });
});

describe('generateUserProfile', () => {
  it('empty plans rejects', async () => {
    await assert.rejects(() => generateUserProfile(null, 'mock', { plans: [] }), /没有学习计划/);
  });
  it('marker-only rejects', async () => {
    const m = Object.assign({ id:'m', name:'M', topics:[], examPapers:[], quickQuizHistory:[], history:[] }, {__testPlan:{marker:'study-assistant/node-test/v1'}});
    await assert.rejects(() => generateUserProfile(null, 'mock', { plans: [m] }), /没有学习计划/);
  });
  it('valid JSON returns AI fields', async () => {
    const ps = [{ id:'r', name:'R', topics:[{ id:'t', title:'A', detail:'d', exercises:[] }], examPapers:[], quickQuizHistory:[], history:[] }];
    const prov = { async complete() { return { content: JSON.stringify({learnerPersona:{type:['深度思考型'], summary:'S', confidence:0.8}, strengths:[], weaknesses:[], crossPlanWeakPoints:[], crossPlanWeakEvidence:[], learningPatterns:{preferredModes:{}, avgQuestionsPerTopic:0, timeStats:{}}, recommendations:['R'], aiAnalysis:'A'}) }; } };
    const r = await generateUserProfile(prov, 'mock', { plans: ps });
    assert.equal(r.profileSource, 'ai+behavior');
    assert.equal(r.learnerPersona.summary, 'S');
  });
  it('fenced JSON parses', async () => {
    const ps = [{ id:'r', name:'R', topics:[{ id:'t', title:'A', detail:'d', exercises:[] }], examPapers:[], quickQuizHistory:[], history:[] }];
    const fenced = '```json\n{"learnerPersona":{"type":[],"summary":"","confidence":0},"strengths":[],"weaknesses":[],"crossPlanWeakPoints":[],"crossPlanWeakEvidence":[],"learningPatterns":{"preferredModes":{},"avgQuestionsPerTopic":0,"timeStats":{}},"recommendations":[],"aiAnalysis":""}\n```';
    const prov = { async complete() { return { content: fenced }; } };
    const r = await generateUserProfile(prov, 'mock', { plans: ps });
    assert.equal(r.profileSource, 'ai+behavior');
  });
  it('invalid JSON + no profile write', async () => {
    const ps = [{ id:'r', name:'R', topics:[{ id:'t', title:'A', detail:'d', exercises:[] }], examPapers:[], quickQuizHistory:[], history:[] }];
    const snap = snapshotProfileFile();
    await assert.rejects(() => generateUserProfile({ async complete() { return { content: 'not json' }; } }, 'mock', { plans: ps }), /JSON/);
    assertProfileUnchanged(snap);
  });
  it('empty content + no profile write', async () => {
    const ps = [{ id:'r', name:'R', topics:[{ id:'t', title:'A', detail:'d', exercises:[] }], examPapers:[], quickQuizHistory:[], history:[] }];
    const snap = snapshotProfileFile();
    await assert.rejects(() => generateUserProfile({ async complete() { return { content: '' }; } }, 'mock', { plans: ps }), /为空/);
    assertProfileUnchanged(snap);
  });
  it('provider error + no profile write', async () => {
    const ps = [{ id:'r', name:'R', topics:[{ id:'t', title:'A', detail:'d', exercises:[] }], examPapers:[], quickQuizHistory:[], history:[] }];
    const snap = snapshotProfileFile();
    await assert.rejects(() => generateUserProfile({ async complete() { throw new Error('API error'); } }, 'mock', { plans: ps }), /API error/);
    assertProfileUnchanged(snap);
  });
});

describe('mergeGeneratedProfile edge cases', () => {
  it('marker-only returns default arrays', () => {
    const real = { id:'r', name:'R', topics:[{ id:'t', title:'A', detail:'d', exercises:[] }], examPapers:[], quickQuizHistory:[], history:[] };
    const marker = Object.assign({ id:'m', name:'M', topics:[{ id:'x', title:'MARKER_ONLY', detail:'d', exercises:[] }], examPapers:[], quickQuizHistory:[], history:[] }, {__testPlan:{marker:'study-assistant/node-test/v1'}});
    const agg = aggregatePlans([real, marker]);
    const ai = {learnerPersona:{type:[], summary:'', confidence:0}, strengths:[], weaknesses:[], crossPlanWeakPoints:[], crossPlanWeakEvidence:[], learningPatterns:{preferredModes:{}, avgQuestionsPerTopic:0, timeStats:{}}, recommendations:[], aiAnalysis:''};
    const r = mergeGeneratedProfile(ai, agg, [real, marker]);
    assert.ok(Array.isArray(r.strengths));
    assert.ok(Array.isArray(r.weaknesses));
    assert.ok(Array.isArray(r.crossPlanWeakPoints));
    assert.ok(Array.isArray(r.crossPlanWeakEvidence));
    assert.equal(r.profileSource, 'ai+behavior');
    assert.ok(!r.crossPlanWeakPoints.includes('MARKER_ONLY'));
  });
});

describe('merge deep immutability', () => {
  it('inputs not mutated', () => {
    const aiData = { learnerPersona:{type:['深度思考型'], summary:'S', confidence:0.8}, strengths:[{domain:'D', masteryLevel:0.9, topics:['A'], evidence:'E'}], weaknesses:[], crossPlanWeakPoints:[], crossPlanWeakEvidence:[{label:'x', source:'weakPoint', sampleSize:1, supportingSources:['a']}], learningPatterns:{preferredModes:{}, avgQuestionsPerTopic:0, timeStats:{}}, recommendations:['R'], aiAnalysis:'A' };
    const plans = [{ id:'r', name:'R', topics:[{ id:'t', title:'A', detail:'d', exercises:[], weakPoints:['w'] }], examPapers:[{ title:'e', questions:[{topicTitle:'A'}], results:[{correct:true,exerciseIndex:0}] }], quickQuizHistory:[], history:[] }];
    const agg = aggregatePlans(plans);
    const snap = JSON.parse(JSON.stringify({aiData, agg, plans}));
    mergeGeneratedProfile(aiData, agg, plans);
    assert.deepStrictEqual(JSON.parse(JSON.stringify({aiData, agg, plans})), snap);
  });
});
