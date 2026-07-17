export const SETTINGS_STORAGE_KEY = 'study-assistant-settings';
export const LEGACY_SETTINGS_STORAGE_KEY = 'textbook-maker-settings';

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
