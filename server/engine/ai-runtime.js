/**
 * Shared AI runtime: Provider lifetime and cache diagnostics.
 * Learning engines depend on this module instead of depending on each other.
 */

import { CacheMonitor } from './cache-diagnostics.js';
import AgentDispatcher from './agent-dispatcher.js';
import { getKeyPool } from './key-pool.js';
import { Provider } from './provider.js';

export const engineCacheMonitor = new CacheMonitor();

const providerCache = new Map();
const dispatcherCache = new Map();

function providerKey(apiKey, baseURL, model) {
  return `${apiKey || ''}::${baseURL || ''}::${model || ''}`;
}

export function createProviderFromConfig(apiKey, baseURL, model) {
  const key = providerKey(apiKey, baseURL, model);
  if (!providerCache.has(key)) {
    providerCache.set(key, new Provider({
      apiKey,
      baseURL,
      model,
      debugCache: process.env.DEBUG_CACHE === 'true',
    }));
  }
  return providerCache.get(key);
}

function createDispatcherFromConfig(apiKey, baseURL, model) {
  const key = providerKey(apiKey, baseURL, model);
  if (!dispatcherCache.has(key)) {
    dispatcherCache.set(key, new AgentDispatcher({
      apiKey,
      baseURL,
      defaultModel: model,
      debug: process.env.DEBUG_CACHE === 'true',
    }));
  }
  return dispatcherCache.get(key);
}

function requestSetting(req, header, bodyField, environment, environmentField, fallback = '') {
  return req?.headers?.[header]
    || req?.body?.[bodyField]
    || environment?.[environmentField]
    || fallback;
}

/**
 * Resolve everything needed for one route-level AI operation.
 * Routes receive one stable context instead of composing configuration helpers.
 */
export function createAIInvocationFromRequest(req, options = {}) {
  const environment = options.environment || process.env;
  const rawKey = requestSetting(
    req,
    'x-api-key',
    'apiKey',
    environment,
    'OPENAI_API_KEY',
  );
  const keyPoolFactory = options.keyPoolFactory || getKeyPool;
  const apiKey = keyPoolFactory(rawKey).next();
  const baseURL = requestSetting(
    req,
    'x-api-base',
    'baseURL',
    environment,
    'OPENAI_BASE_URL',
    'https://api.openai.com/v1',
  );
  const model = requestSetting(
    req,
    'x-api-model',
    'model',
    environment,
    'OPENAI_MODEL',
    'gpt-4o-mini',
  );
  const providerFactory = options.providerFactory || createProviderFromConfig;
  const dispatcherFactory = options.dispatcherFactory || createDispatcherFromConfig;
  const provider = providerFactory(apiKey, baseURL, model);
  const dispatcher = dispatcherFactory(apiKey, baseURL, model);
  const dispatched = (
    req?.headers?.['x-use-agent-dispatch'] === 'true'
    || req?.body?.useAgentDispatch === true
  );

  return {
    model,
    provider,
    dispatcher,
    dispatched,
    async run(kind, operation) {
      if (typeof operation !== 'function') {
        throw new TypeError('AI invocation operation must be a function');
      }
      if (!dispatched) return operation(provider, model);
      const dispatchedResult = await dispatcher.dispatch(kind, operation);
      return dispatchedResult.result;
    },
  };
}

export function resolveProvider(providerOrConfig, model) {
  if (providerOrConfig instanceof Provider) return providerOrConfig;
  return createProviderFromConfig(
    providerOrConfig?.apiKey,
    providerOrConfig?.baseURL,
    model,
  );
}
