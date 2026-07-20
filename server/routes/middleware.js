/**
 * Shared middleware helpers for all route modules.
 */

import { createProviderFromConfig } from '../engine/learn-engine.js';
import AgentDispatcher from '../engine/agent-dispatcher.js';
import { getKeyPool } from '../engine/key-pool.js';

function resolveApiKey(rawKey) {
  const pool = getKeyPool(rawKey);
  return pool.next();
}

function getProvider(req) {
  const rawKey = req.headers['x-api-key'] || req.body?.apiKey || process.env.OPENAI_API_KEY;
  const apiKey = resolveApiKey(rawKey);
  const baseURL = req.headers['x-api-base'] || req.body?.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = req.headers['x-api-model'] || req.body?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return createProviderFromConfig(apiKey, baseURL, model);
}

function getModel(req) {
  return req.headers['x-api-model'] || req.body?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function getDispatcher(req) {
  const rawKey = req.headers['x-api-key'] || req.body?.apiKey || process.env.OPENAI_API_KEY;
  const apiKey = resolveApiKey(rawKey);
  const baseURL = req.headers['x-api-base'] || req.body?.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = req.headers['x-api-model'] || req.body?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return new AgentDispatcher({ apiKey, baseURL, defaultModel: model });
}

function wantsAgentDispatch(req) {
  return (
    req.headers['x-use-agent-dispatch'] === 'true' ||
    (req.body && req.body.useAgentDispatch === true)
  );
}

export { getProvider, getModel, getDispatcher, wantsAgentDispatch };
