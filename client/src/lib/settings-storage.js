export const SETTINGS_STORAGE_KEY = 'study-assistant-settings';
export const LEGACY_SETTINGS_STORAGE_KEY = 'textbook-maker-settings';

// ─── Routing task types ───

/** High-value tasks that should use the quality channel */
export const HIGH_VALUE_TASKS = [
  'import-plan',
  'generate-detail',
  'infer-relations',
  'decompose-topic',
  'reveal-errors',
  'analyze-learning',
  'weak-points',
  'user-profile-analyze',
  'feynman-analyze',
  'fact-check',
  'auto-fix-facts',
  'get-core-topics',
  'generate-exam',
  'analyze-adaptive',
];

/** High-frequency or structure-known tasks that can use the economy channel */
export const ECONOMY_TASKS = [
  'ask-question',
  'interactive-start',
  'interactive-continue',
  'interactive-start-sse',
  'interactive-continue-sse',
  'generate-review',
  'submit-exercises',
  'submit-exam',
  'quick-quiz',
  'exam-practice',
  'analysis-ask',
];

/** Available routing modes */
export const ROUTING_MODES = {
  BALANCED: 'balanced',
  QUALITY: 'quality',
  ECONOMY: 'economy',
};

/**
 * Select which text AI provider configuration to use for a given task.
 *
 * @param {object} settings — full settings object from loadSettings()
 * @param {string} taskType — one of the HIGH_VALUE_TASKS or ECONOMY_TASKS
 * @returns {{ apiKey: string, baseURL: string, model: string, tier: string }}
 *          Returns empty object if no usable key is found.
 */
export function selectTextProvider(settings, taskType) {
  if (!settings || !taskType) {
    return fallbackToQuality(settings);
  }

  const mode = settings.routingMode || ROUTING_MODES.BALANCED;

  // quality mode — always use primary channel
  if (mode === ROUTING_MODES.QUALITY) {
    return pickQuality(settings);
  }

  // economy mode — prefer economy, fall back to quality
  if (mode === ROUTING_MODES.ECONOMY) {
    const economy = pickEconomy(settings);
    if (economy.apiKey) return economy;
    return pickQuality(settings);
  }

  // balanced mode — route by task type
  if (mode === ROUTING_MODES.BALANCED) {
    // High-value task → quality channel
    if (HIGH_VALUE_TASKS.includes(taskType)) {
      return pickQuality(settings);
    }
    // Economy-eligible task → economy channel (with fallback)
    if (ECONOMY_TASKS.includes(taskType)) {
      const economy = pickEconomy(settings);
      if (economy.apiKey) return economy;
      return pickQuality(settings);
    }
  }

  // Unknown task type or mode — safe fallback to quality
  return pickQuality(settings);
}

/**
 * Return the other configured text channel for a single retry.
 * This is intentionally separate from regular task routing so normal requests
 * continue to follow the user's selected cost/quality mode.
 */
export function selectTextFallbackProvider(settings, taskType) {
  const primary = selectTextProvider(settings, taskType);
  const fallback = primary.tier === 'economy'
    ? pickQuality(settings)
    : pickEconomy(settings);

  if (!fallback.apiKey || isSameTextProvider(primary, fallback)) return null;
  return fallback;
}

function pickQuality(settings) {
  if (!settings) {
    return { apiKey: '', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', tier: 'quality' };
  }
  return {
    apiKey: settings.apiKey || '',
    baseURL: settings.baseURL || 'https://api.openai.com/v1',
    model: settings.model || 'gpt-4o-mini',
    tier: 'quality',
  };
}

function pickEconomy(settings) {
  if (!settings) {
    return { apiKey: '', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', tier: 'economy' };
  }
  return {
    apiKey: settings.economyApiKey || '',
    baseURL: settings.economyBaseURL || settings.baseURL || 'https://api.openai.com/v1',
    model: settings.economyModel || settings.model || 'gpt-4o-mini',
    tier: 'economy',
  };
}

function fallbackToQuality(settings) {
  return pickQuality(settings);
}

function isSameTextProvider(a, b) {
  return a.apiKey === b.apiKey && a.baseURL === b.baseURL && a.model === b.model;
}

// ─── Settings persistence ───

export function loadSettings() {
  try {
    const current = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (current) return JSON.parse(current);

    const legacy = localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
    if (!legacy) return {};

    const settings = JSON.parse(legacy);
    localStorage.setItem(SETTINGS_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
    return settings;
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
}
