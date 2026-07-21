/**
 * Unit tests for data-flywheel / profile-updater closed loop.
 * Pure memory fixtures — no disk plans.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { profileUpdater } from '../engine/user-profile.js';
import { AdaptivePromptInjector, dataFlywheelUpdate, getCurrentInjector } from '../engine/adaptive-engine.js';

const PROFILE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'learn', 'user-profile.json');
let originalProfileBuffer = null;
let profileExisted = false;

function makeTopic(title, opts = {}) {
  return { id: opts.id || `t-${title}`, title, detail: 'mock', done: opts.done !== false, exercises: opts.exercises || [], weakPoints: opts.weakPoints || [], timeSpent: opts.timeSpent || 0, timeLog: opts.timeLog || [], interactiveModeUsage: opts.interactiveModeUsage || {}, feynmanInsights: opts.feynmanInsights || null, interactiveSession: opts.interactiveSession || null };
}
function makePlan(name, topics) { return { id: `p-${name}`, name, topics, examPapers: [], quickQuizHistory: [], history: [] }; }

before(() => { profileExisted = fs.existsSync(PROFILE_FILE); if (profileExisted) originalProfileBuffer = fs.readFileSync(PROFILE_FILE); });
after(() => { if (profileExisted && originalProfileBuffer) fs.writeFileSync(PROFILE_FILE, originalProfileBuffer); else if (fs.existsSync(PROFILE_FILE)) fs.unlinkSync(PROFILE_FILE); });

describe('profileUpdater', () => {
  it('练习 → strength', () => {
    const plan = makePlan('P', [makeTopic('TCP', { exercises: [{ correct: true }, { correct: true }, { correct: true }] })]);
    assert.ok(profileUpdater(null, [plan]).strengths.some(s => s.masteryLevel >= 0.7));
  });

  it('低正确率 → weakness', () => {
    const plan = makePlan('P', [makeTopic('UDP', { exercises: [{ correct: false }, { correct: false }, { correct: true }] })]);
    assert.ok(profileUpdater(null, [plan]).weaknesses.some(w => w.masteryLevel < 0.7));
  });

  it('问答 → persona', () => {
    const plan = makePlan('P', [makeTopic('A')]);
    plan.history = [{ role:'user', content:'为什么？' }, { role:'user', content:'原理？' }, { role:'user', content:'原因？' }];
    assert.ok(profileUpdater(null, [plan]).learnerPersona.type.includes('深度思考型'));
  });

  it('多计划 → crossPlanWeakPoints', () => {
    const plans = [makePlan('P1', [makeTopic('TCP', { exercises: [{ correct: false }, { correct: false }, { correct: true }] })]), makePlan('P2', [makeTopic('UDP', { exercises: [{ correct: false }, { correct: false }, { correct: false }] })])];
    const r = profileUpdater(null, plans);
    assert.ok(r.crossPlanWeakPoints.includes('TCP'));
    assert.ok(r.crossPlanWeakPoints.includes('UDP'));
  });

  it('空 → 骨架', () => {
    const r = profileUpdater(null, []);
    assert.ok(r.learnerPersona);
    assert.equal(r.strengths.length, 0);
  });

  it('增量计数递增', () => {
    const plan = makePlan('P', [makeTopic('A', { exercises: [{ correct: true }] })]);
    const r1 = profileUpdater(null, [plan]);
    assert.equal(r1._totalIncrementalUpdates, 1);
    const r2 = profileUpdater(r1, [plan]);
    assert.equal(r2._totalIncrementalUpdates, 2);
  });

  it('marker 隔离', () => {
    const real = makePlan('R', [makeTopic('A')]);
    const marker = makePlan('M', [makeTopic('B')]);
    marker.__testPlan = { marker: 'study-assistant/node-test/v1' };
    const r = profileUpdater(null, [real, marker]);
    assert.ok(!r.crossPlanWeakPoints.includes('B'));
  });
});

describe('dataFlywheelUpdate / getCurrentInjector', () => {
  it('返回 AdaptivePromptInjector', () => {
    const plan = makePlan('P', [makeTopic('A', { exercises: [{ correct: true }] })]);
    assert.ok(dataFlywheelUpdate([plan]) instanceof AdaptivePromptInjector);
  });

  it('getCurrentInjector 不崩溃', () => {
    assert.ok(getCurrentInjector() instanceof AdaptivePromptInjector);
  });
});
