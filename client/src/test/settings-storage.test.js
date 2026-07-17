import { beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
} from '../lib/settings-storage';

describe('settings storage', () => {
  beforeEach(() => localStorage.clear());

  it('loads settings from the current key', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ model: 'gpt-test' }));
    expect(loadSettings()).toEqual({ model: 'gpt-test' });
  });

  it('migrates the legacy textbook-maker key without losing settings', () => {
    localStorage.setItem(LEGACY_SETTINGS_STORAGE_KEY, JSON.stringify({ apiKey: 'local-test-key' }));

    expect(loadSettings()).toEqual({ apiKey: 'local-test-key' });
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(JSON.stringify({ apiKey: 'local-test-key' }));
    expect(localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('saves only under the Study Assistant key', () => {
    localStorage.setItem(LEGACY_SETTINGS_STORAGE_KEY, '{}');
    saveSettings({ baseURL: 'https://example.test/v1' });

    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY))).toEqual({ baseURL: 'https://example.test/v1' });
    expect(localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('returns an empty object for malformed data', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{bad json');
    expect(loadSettings()).toEqual({});
  });
});
