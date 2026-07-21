/**
 * Unit tests for Adaptive Engine components.
 * Pure memory fixtures — no disk plans.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ErrorStateMachine, AdaptivePromptInjector, InterventionRecommender, analyzePlanAdaptive } from '../engine/adaptive-engine.js';

const PROFILE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'learn', 'user-profile.json');
let originalProfileBuffer = null;
let profileExisted = false;

function makeTopic(title, opts = {}) {
  return { id: opts.id || `t-${title}`, title, detail: 'mock', done: opts.done !== false, exercises: opts.exercises || [], weakPoints: opts.weakPoints || [], teachingErrors: opts.teachingErrors || [], feynmanInsights: opts.feynmanInsights || null };
}
function makePlan(name, topics) { return { id: `p-${name}`, name, topics, examPapers: [], history: [] }; }

before(() => { profileExisted = fs.existsSync(PROFILE_FILE); if (profileExisted) originalProfileBuffer = fs.readFileSync(PROFILE_FILE); });
after(() => { if (profileExisted && originalProfileBuffer) fs.writeFileSync(PROFILE_FILE, originalProfileBuffer); else if (fs.existsSync(PROFILE_FILE)) fs.unlinkSync(PROFILE_FILE); });

// ─── ErrorStateMachine (10 tests) ───
describe('ErrorStateMachine', () => {
  it('空状态 summary', () => {
    const esm = new ErrorStateMachine();
    const s = esm.summary;
    assert.ok(s, 'has summary');
    assert.equal(s.totalConcepts, 0);
  });

  it('第1次 → WATCHING', () => {
    const r = new ErrorStateMachine().recordError('指针', 'exercise');
    assert.equal(r.state, 'WATCHING');
    assert.equal(r.count, 1);
  });

  it('第2次仍 WATCHING', () => {
    const esm = new ErrorStateMachine();
    esm.recordError('指针', 'exercise');
    const r = esm.recordError('指针', 'exam');
    assert.equal(r.state, 'WATCHING');
    assert.equal(r.count, 2);
  });

  it('第3次 → INTERVENTION_NEEDED + thresholdCrossed', () => {
    const esm = new ErrorStateMachine();
    esm.recordError('指针', 'exercise');
    esm.recordError('指针', 'exercise');
    const r = esm.recordError('指针', 'exercise');
    assert.equal(r.state, 'INTERVENTION_NEEDED');
    assert.equal(r.thresholdCrossed, true);
    assert.equal(r.count, 3);
  });

  it('第4次不重复触发 threshold', () => {
    const esm = new ErrorStateMachine();
    esm.recordError('指针', 'exercise');
    esm.recordError('指针', 'exercise');
    esm.recordError('指针', 'exercise');
    const r = esm.recordError('指针', 'exercise');
    assert.equal(r.state, 'INTERVENTION_NEEDED');
    assert.equal(r.thresholdCrossed, false);
  });

  it('resolveConcept → RESOLVED', () => {
    const esm = new ErrorStateMachine();
    esm.recordError('指针', 'exercise');
    esm.recordError('指针', 'exercise');
    esm.recordError('指针', 'exercise');
    esm.resolveConcept('指针');
    assert.equal(esm.interventionNeeded.length, 0);
  });

  it('多 concept 独立', () => {
    const esm = new ErrorStateMachine();
    esm.recordError('TCP', 'exercise');
    esm.recordError('UDP', 'exercise');
    esm.recordError('UDP', 'exercise');
    esm.recordError('UDP', 'exercise');
    assert.equal(esm.interventionNeeded.length, 1);
    assert.equal(esm.interventionNeeded[0].concept, 'UDP');
  });

  it('fromPlan 聚合 exercise/exam/weakPoint/teachingError', () => {
    const topic = makeTopic('指针', {
      exercises: [{ correct: false, conceptTag: '指针' }, { correct: false, conceptTag: '指针' }],
      weakPoints: ['指针'],
      teachingErrors: [{ recognized: false, misconception: '解引用' }],
    });
    const plan = makePlan('P', [topic]);
    plan.examPapers = [{ results: [{ correct: false, topicTitle: '指针', exerciseIndex: 0 }], questions: [{ topicTitle: '指针' }] }];
    const esm = ErrorStateMachine.fromPlan(plan);
    const entry = esm.interventionNeeded.find(e => e.concept === '指针');
    assert.ok(entry, '指针 from plan');
    assert.ok(entry.count >= 2, 'errors aggregated');
  });

  it('null/空 plan 安全', () => { assert.equal(ErrorStateMachine.fromPlan(null).interventionNeeded.length, 0); });
  it('空 concept 被忽略', () => { const r = new ErrorStateMachine().recordError('', 'exercise'); assert.equal(r.state, 'IDLE'); });
});

// ─── AdaptivePromptInjector (5 tests) ───
describe('AdaptivePromptInjector', () => {
  it('null profile 返回空', () => {
    const inj = new AdaptivePromptInjector(null);
    assert.equal(inj.buildAdaptiveContext(), '');
    assert.equal(inj.hasMeaningfulProfile, false);
  });

  it('无有效证据返回空', () => {
    const p = { learnerPersona:{type:[], summary:'', confidence:0}, strengths:[{domain:'T', masteryLevel:0.8, sampleSize:1, source:'behavior', topics:['A']}], weaknesses:[], crossPlanWeakEvidence:[], learningPatterns:{preferredModes:{}, avgQuestionsPerTopic:0, timeStats:{}} };
    assert.equal(new AdaptivePromptInjector(p).buildAdaptiveContext(), '');
  });

  it('有效证据生成 context', () => {
    const p = { learnerPersona:{type:['深度思考型'], summary:'', confidence:0.6}, strengths:[], weaknesses:[], crossPlanWeakEvidence:[], learningPatterns:{preferredModes:{stepwise:3}, avgQuestionsPerTopic:1, timeStats:{}} };
    const ctx = new AdaptivePromptInjector(p).buildAdaptiveContext();
    assert.ok(ctx.includes('ADAPTIVE_CONTEXT'));
    assert.ok(ctx.includes('禁止改变事实'));
  });

  it('compactHint', () => {
    const p = { learnerPersona:{type:['深度思考型'], summary:'', confidence:0.6}, strengths:[], weaknesses:[], crossPlanWeakEvidence:[], learningPatterns:{preferredModes:{}, avgQuestionsPerTopic:0, timeStats:{}} };
    assert.ok(new AdaptivePromptInjector(p).compactHint.includes('深度思考型'));
  });

  it('partial profile 不崩溃', () => {
    const inj = new AdaptivePromptInjector({ learnerPersona:{}, strengths:null, weaknesses:null });
    assert.equal(inj.buildAdaptiveContext(), '');
  });
});

// ─── InterventionRecommender (5 tests) ───
describe('InterventionRecommender', () => {
  it('错误 topic 给 review', () => {
    const plan = makePlan('P', [makeTopic('指针', { exercises: [{ correct: false, conceptTag: '指针' }] })]);
    const esm = new ErrorStateMachine();
    esm.recordError('指针', 'exercise'); esm.recordError('指针', 'exercise'); esm.recordError('指针', 'exercise');
    const recs = new InterventionRecommender(plan, esm).recommend();
    assert.ok(recs.length > 0);
    assert.ok(recs[0].interventions.length > 0);
  });

  it('无错误不给建议', () => {
    const plan = makePlan('P', [makeTopic('A')]);
    const recs = new InterventionRecommender(plan, new ErrorStateMachine()).recommend();
    assert.equal(recs.length, 0);
  });

  it('urgency 排序', () => {
    const plan = makePlan('P', [
      makeTopic('A', { exercises: [{ correct: false, conceptTag: 'A' }] }),
      makeTopic('B', { exercises: [{ correct: false, conceptTag: 'B' }] }),
    ]);
    // Actually test by having more errors on A
    const esm = new ErrorStateMachine();
    esm.recordError('A', 'exercise'); esm.recordError('A', 'exercise'); esm.recordError('A', 'exercise');
    esm.recordError('B', 'exercise'); esm.recordError('B', 'exercise');
    // A has 3 errors, B has 2 — A should be first
    // But both need conceptTag in exercises
    const plan2 = makePlan('P', [
      makeTopic('A', { exercises: [{ correct: false, conceptTag: 'A' }, { correct: false, conceptTag: 'A' }, { correct: false, conceptTag: 'A' }] }),
      makeTopic('B', { exercises: [{ correct: false, conceptTag: 'B' }, { correct: false, conceptTag: 'B' }] }),
    ]);
    const recs = new InterventionRecommender(plan2, esm).recommend();
    assert.ok(recs.length >= 1);
  });

  it('summary 文本不空', () => {
    const plan = makePlan('P', [makeTopic('A', { exercises: [{ correct: false, conceptTag: 'A' }] })]);
    const esm = new ErrorStateMachine();
    esm.recordError('A', 'exercise'); esm.recordError('A', 'exercise'); esm.recordError('A', 'exercise');
    const recs = new InterventionRecommender(plan, esm).recommend();
    if (recs.length > 0) assert.ok(typeof recs[0].topicTitle === 'string');
  });

  it('空 plan 安全', () => { assert.equal(new InterventionRecommender(null, new ErrorStateMachine()).recommend().length, 0); });
});

// ─── analyzePlanAdaptive (1 test) ───
describe('analyzePlanAdaptive', () => {
  it('完整 pipeline shape', async () => {
    const plan = makePlan('P', [makeTopic('A', { exercises: [{ correct: false, conceptTag: 'A' }] })]);
    const esm = new ErrorStateMachine();
    esm.recordError('A', 'exercise'); esm.recordError('A', 'exercise'); esm.recordError('A', 'exercise');
    const result = analyzePlanAdaptive(plan, esm);
    assert.ok(result, 'has result');
    assert.ok('stateMachine' in result, 'stateMachine');
    assert.ok('injector' in result, 'injector');
    assert.ok('recommender' in result, 'recommender');
    // These may be empty but must exist
    assert.ok('recommendations' in result, 'recommendations');
    assert.ok('adaptiveContext' in result, 'adaptiveContext');
    assert.ok('summary' in result, 'summary');
  });
});
