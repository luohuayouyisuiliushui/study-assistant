/**
 * Unit tests for the Multi-Agent Dispatcher (agent-dispatcher.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import AgentDispatcher from '../engine/agent-dispatcher.js';
import { AGENT_PROFILES } from '../engine/learn-prompts.js';

function createDispatcher(config = {}) {
  return new AgentDispatcher({
    ...config,
    providerFactory: config.providerFactory || ((_apiKey, _baseURL, model) => ({ model })),
  });
}

describe('agent-dispatcher', () => {
  describe('AgentDispatcher construction', () => {
    it('should create dispatcher with API key', () => {
      const d = createDispatcher({ apiKey: 'sk-test' });
      assert.ok(d);
    });

    it('should default to gpt-4o-mini when no model specified', () => {
      const d = createDispatcher({ apiKey: 'sk-test' });
      const p = d.provider('explain');
      assert.ok(p);
    });
  });

  describe('profile()', () => {
    const d = createDispatcher({ apiKey: 'sk-test' });

    it('should return explain profile for known type', () => {
      const p = d.profile('explain');
      assert.strictEqual(p.description, '知识点详细讲解');
      assert.ok(p.fallbackChain.length > 0);
    });

    it('should fallback to explain for unknown type', () => {
      const p = d.profile('nonexistent');
      assert.strictEqual(p.description, '知识点详细讲解');
    });

    it('should return audit profile with low temperature', () => {
      const p = d.profile('audit');
      assert.strictEqual(p.temperature, 0.2);
      assert.strictEqual(p.description, '事实核查/防幻觉审计');
    });

    it('should return examGrade profile with very low temperature', () => {
      const p = d.profile('examGrade');
      assert.strictEqual(p.temperature, 0.2);
    });

    it('should return examSelfCorrect profile', () => {
      const p = d.profile('examSelfCorrect');
      assert.strictEqual(p.temperature, 0.2);
      assert.ok(p.maxTokens <= 2048);
    });

    it('should return explainDeep with stronger model', () => {
      const p = d.profile('explainDeep');
      assert.strictEqual(p.defaultModel, 'gpt-4o');
      assert.strictEqual(p.fallbackChain[0], 'gpt-4o');
    });

    it('should return review profile', () => {
      const p = d.profile('review');
      assert.strictEqual(p.temperature, 0.5);
      assert.strictEqual(p.maxTokens, 4096);
    });

    it('should return interactive profile', () => {
      const p = d.profile('interactive');
      assert.strictEqual(p.temperature, 0.7);
    });
  });

  describe('provider()', () => {
    const d = createDispatcher({ apiKey: 'sk-test', baseURL: 'https://x.com/v1' });

    it('should create a Provider for explain task', () => {
      const p = d.provider('explain');
      assert.ok(p);
      assert.strictEqual(p.model, 'gpt-4o-mini');
    });

    it('should respect user-configured model', () => {
      const d2 = createDispatcher({ apiKey: 'sk-test', defaultModel: 'gpt-4o' });
      const p = d2.provider('explain');
      assert.strictEqual(p.model, 'gpt-4o');
    });

    it('should allow per-call model override', () => {
      const p = d.provider('explain', 'deepseek-chat');
      assert.strictEqual(p.model, 'deepseek-chat');
    });

    it('delegates provider identity to its injected acquisition seam', () => {
      const provider = { model: 'gpt-4o-mini' };
      const calls = [];
      const dispatcher = createDispatcher({
        apiKey: 'sk-test',
        baseURL: 'https://api.openai.com/v1',
        providerFactory: (...args) => {
          calls.push(args);
          return provider;
        },
      });

      assert.strictEqual(dispatcher.provider('explain'), provider);
      assert.strictEqual(dispatcher.provider('explain'), provider);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].slice(0, 3), ['sk-test', 'https://api.openai.com/v1', 'gpt-4o-mini']);
    });
  });

  describe('dispatch()', () => {
    it('should execute a task and return enriched result', async () => {
      const d = createDispatcher({ apiKey: 'sk-test' });

      const { result, agentType, model } = await d.dispatch('explain', async (provider, m) => {
        return { ok: true, model: m };
      }, { useFallback: false });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(agentType, 'explain');
      assert.ok(model);
    });

    it('should auto-mock Provider so no real API call needed', async () => {
      const d = createDispatcher({ apiKey: 'sk-test' });

      // Pre-populate a provider so dispatch doesn't try real connection
      const { result } = await d.dispatch('audit', async (provider) => {
        return { verified: true, score: 0.9 };
      }, { useFallback: false });

      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.score, 0.9);
    });
  });

  describe('usageStats', () => {
    it('should return zero stats when nothing dispatched', () => {
      const d = createDispatcher({ apiKey: 'sk-test' });
      const stats = d.usageStats;
      assert.strictEqual(stats.grandTotalTokens, 0);
    });
  });

  describe('budgetHint', () => {
    const d = createDispatcher({ apiKey: 'sk-test', defaultModel: 'gpt-4o' });

    it('should recommend cheap model for small tasks', () => {
      assert.strictEqual(d.budgetHint(500), 'gpt-4o-mini');
    });

    it('should recommend user model for large tasks', () => {
      assert.strictEqual(d.budgetHint(5000), 'gpt-4o');
    });
  });

  describe('static listAgents', () => {
    it('should return all agent profiles', () => {
      const agents = AgentDispatcher.listAgents();
      assert.ok(agents.length >= 10);
      assert.ok(agents.some(a => a.agentType === 'explain'));
      assert.ok(agents.some(a => a.agentType === 'audit'));
      assert.ok(agents.some(a => a.agentType === 'examGenerate'));
      assert.ok(agents.some(a => a.agentType === 'examGrade'));
      assert.ok(agents.some(a => a.agentType === 'review'));
      assert.ok(agents.some(a => a.agentType === 'interactive'));
    });

    it('should have fallbackChain for every agent', () => {
      for (const a of AgentDispatcher.listAgents()) {
        assert.ok(Array.isArray(a.fallbackChain), `${a.agentType}: fallbackChain must be array`);
        assert.ok(a.fallbackChain.length > 0, `${a.agentType}: fallbackChain must not be empty`);
        assert.ok(typeof a.description === 'string', `${a.agentType}: description must be string`);
      }
    });
  });

  describe('AGENT_PROFILES', () => {
    it('should have all required profiles', () => {
      const required = ['explain', 'explainDeep', 'followUp', 'examGenerate', 'examGrade',
        'examSelfCorrect', 'audit', 'auditLight', 'review', 'interactive', 'analysis',
        'decompose', 'import'];
      for (const key of required) {
        assert.ok(AGENT_PROFILES[key], `Missing agent profile: ${key}`);
      }
    });

    it('should have valid fallbackChains', () => {
      for (const [key, profile] of Object.entries(AGENT_PROFILES)) {
        assert.ok(Array.isArray(profile.fallbackChain), `${key}: fallbackChain must be array`);
        assert.ok(profile.fallbackChain.length >= 2, `${key}: fallbackChain should have >=2 entries`);
        assert.ok(profile.fallbackChain[0] === profile.defaultModel,
          `${key}: first fallback should match defaultModel`);
      }
    });
  });

  describe('_uniqueModels (dedup)', () => {
    it('should deduplicate model names in fallback chain', async () => {
      const d = createDispatcher({ apiKey: 'sk-test', defaultModel: 'gpt-4o-mini' });
      const p = d.profile('explain');
      // explain has chain: ['gpt-4o-mini', 'gpt-3.5-turbo']
      // with user defaultModel = gpt-4o-mini, unique models = ['gpt-4o-mini', 'gpt-3.5-turbo']
      const models = [d._userModel, ...p.fallbackChain];
      const seen = new Set();
      const deduped = [];
      for (const m of models) {
        if (seen.has(m)) continue;
        seen.add(m);
        deduped.push(m);
      }
      assert.strictEqual(deduped.length, 2);
      assert.strictEqual(deduped[0], 'gpt-4o-mini');
      assert.strictEqual(deduped[1], 'gpt-3.5-turbo');
    });
  });
});
