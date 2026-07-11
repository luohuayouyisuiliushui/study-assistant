/**
 * Multi-Agent Dispatcher — Orchestration Layer for task-to-model routing.
 *
 * === DESIGN (v1.7.0) ===
 *
 * This is the "管理 AI 的管理系统" layer from [[strategic-moat-analysis]]:
 * instead of a single model for everything, each task type (explain, audit,
 * generate exam, grade, etc.) routes through a specific agent profile with
 * its own system prompt, temperature, model tier, and fallback chain.
 *
 * Each agent profile lives in learn-prompts.js under AGENT_PROFILES.
 *
 * Dispatcher responsibilities:
 * 1. Select the right agent profile for a given task type
 * 2. Resolve provider / model from user config + profile defaults
 * 3. Track per-agent usage for cost monitoring
 * 4. Fallback: if the primary model returns a retryable error, try the
 *    next model in the fallback chain before giving up
 *
 * The ORCHESTRATION LAYER concept:
 *   "用户 → 你的编排层 → 多个垂直小模型/API"
 * Not yet implemented: cost-per-model accounting, but the infrastructure
 * is here now.
 */

import { Provider } from './provider.js';
import { AGENT_PROFILES } from './learn-prompts.js';

// ─── Per-agent usage tracking ───

const _agentUsage = new Map(); // agentType → { calls, totalTokens, errors }

function _recordUsage(agentType, usage) {
  if (!_agentUsage.has(agentType)) {
    _agentUsage.set(agentType, { calls: 0, totalTokens: 0, errors: 0 });
  }
  const entry = _agentUsage.get(agentType);
  entry.calls++;
  entry.totalTokens += (usage?.totalTokens || 0);
}

function _recordError(agentType) {
  if (!_agentUsage.has(agentType)) {
    _agentUsage.set(agentType, { calls: 0, totalTokens: 0, errors: 0 });
  }
  _agentUsage.get(agentType).errors++;
}

// ═══════════════════════════════════════════════════════
//  AGENT DISPATCHER
// ═══════════════════════════════════════════════════════

export class AgentDispatcher {
  /**
   * @param {object} config
   * @param {string} config.apiKey    - API key
   * @param {string} [config.baseURL] - API base URL
   * @param {string} [config.defaultModel] - Default model (user-configured)
   */
  constructor(config = {}) {
    this._apiKey = config.apiKey || '';
    this._baseURL = config.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this._userModel = config.defaultModel || config.model || 'gpt-4o-mini';
    this._debug = config.debug || false;

    // Provider cache: compositeKey → Provider instance
    this._providers = new Map();
  }

  // ─── Public API ───

  /**
   * Get the agent profile for a given task type.
   * Falls back to 'explain' if unknown.
   */
  profile(taskType) {
    return AGENT_PROFILES[taskType] || AGENT_PROFILES.explain;
  }

  /**
   * Get or create a Provider for a specific agent task.
   * Uses the user's model as default, but allows per-task overrides.
   *
   * @param {string} taskType - One of AGENT_PROFILES keys
   * @param {string} [overrideModel] - Override the profile's default model
   * @returns {Provider}
   */
  provider(taskType, overrideModel) {
    const profile = this.profile(taskType);
    const model = overrideModel || this._userModel || profile.defaultModel;
    const key = `${this._apiKey}::${this._baseURL}::${model}`;

    if (!this._providers.has(key)) {
      const provider = new Provider({
        apiKey: this._apiKey,
        baseURL: this._baseURL,
        model,
        debugCache: this._debug,
      });
      this._providers.set(key, provider);
    }
    return this._providers.get(key);
  }

  /**
   * Execute a task through the appropriate agent.
   *
   * This is the MAIN entry point. It:
   * 1. Resolves the agent profile for the task type
   * 2. Resolves the Provider (with model from profile + user config)
   * 3. Optionally tries fallback models on retryable errors
   * 4. Tracks usage
   *
   * @param {string} taskType - Key in AGENT_PROFILES
   * @param {Function} execute - fn(provider, model) → Promise<result>
   * @param {object} [opts]
   * @param {boolean} [opts.useFallback=true] - Whether to try fallback chain
   * @param {string} [opts.overrideModel] - Override the model for this call
   * @returns {Promise<{result: *, agentType: string, model: string, usage: object}>}
   */
  async dispatch(taskType, execute, opts = {}) {
    const profile = this.profile(taskType);
    const useFallback = opts.useFallback !== false;
    const primaryModel = opts.overrideModel || this._userModel || profile.defaultModel;

    let lastError = null;
    const modelsToTry = useFallback
      ? _uniqueModels([primaryModel, ...profile.fallbackChain])
      : [primaryModel];

    for (const model of modelsToTry) {
      try {
        const provider = this.provider(taskType, model);
        // Inject agent-specific system prompt into the provider.
        // The provider will MERGE this with the original messages[0].content
        // (not replace it), preserving format constraints and knowledge boundaries.
        provider._agentSystemPrompt = profile.systemPrompt;
        provider._agentTemperature = profile.temperature;
        provider._agentMaxTokens = profile.maxTokens;
        const result = await execute(provider, model);
        _recordUsage(taskType, result?.usage || result?.diagnostics);
        return {
          result,
          agentType: taskType,
          model,
          profileName: profile.description,
        };
      } catch (err) {
        _recordError(taskType);
        lastError = err;

        // Only continue fallback for retryable errors
        const isRetryable = _isRetryable(err);
        if (!isRetryable || model === modelsToTry[modelsToTry.length - 1]) {
          throw err;
        }
        if (this._debug) {
          console.warn(`[AgentDispatcher] ${taskType} failed on ${model}, trying fallback: ${err.message}`);
        }
      }
    }

    throw lastError || new Error(`All models exhausted for task: ${taskType}`);
  }

  /**
   * Get aggregate usage statistics across all agents.
   */
  get usageStats() {
    const stats = {};
    let grandTotal = 0;
    for (const [agent, entry] of _agentUsage.entries()) {
      stats[agent] = {
        profile: AGENT_PROFILES[agent]?.description || 'unknown',
        calls: entry.calls,
        totalTokens: entry.totalTokens,
        errors: entry.errors,
      };
      grandTotal += entry.totalTokens;
    }
    return { agents: stats, grandTotalTokens: grandTotal };
  }

  /**
   * Get a quick budget recommendation (which model to use given remaining quota).
   */
  budgetHint(estimatedTokens) {
    // If estimated tokens < 1000 → use the cheapest available model
    if (estimatedTokens < 1000) return 'gpt-4o-mini';
    // For larger tasks use the user's default
    return this._userModel;
  }

  // ─── Static convenience ───

  /**
   * List all known agent types and their descriptions.
   */
  static listAgents() {
    return Object.entries(AGENT_PROFILES).map(([key, p]) => ({
      agentType: key,
      description: p.description,
      defaultModel: p.defaultModel,
      fallbackChain: p.fallbackChain,
    }));
  }
}

// ─── Helpers ───

function _isRetryable(err) {
  const status = err?.status;
  if (status === 429 || (status && status >= 500)) return true;
  const msg = (err?.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit')
  );
}

function _uniqueModels(models) {
  const seen = new Set();
  return models.filter(m => {
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

export default AgentDispatcher;
