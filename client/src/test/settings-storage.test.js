import { beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
  selectTextProvider,
  selectTextFallbackProvider,
  ROUTING_MODES,
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

describe('selectTextProvider', () => {
  const qualitySettings = {
    apiKey: 'sk-quality',
    baseURL: 'https://quality.test/v1',
    model: 'gpt-4o',
    routingMode: ROUTING_MODES.BALANCED,
  };

  const dualSettings = {
    ...qualitySettings,
    economyApiKey: 'sk-economy',
    economyBaseURL: 'https://economy.test/v1',
    economyModel: 'gpt-4o-mini',
    routingMode: ROUTING_MODES.BALANCED,
  };

  it('returns quality channel for null settings', () => {
    const result = selectTextProvider(null, 'ask-question');
    expect(result.tier).toBe('quality');
    expect(result.apiKey).toBe('');
  });

  it('returns quality channel for unknown task type', () => {
    const result = selectTextProvider(qualitySettings, 'unknown-task');
    expect(result.tier).toBe('quality');
    expect(result.apiKey).toBe('sk-quality');
  });

  describe('balanced mode', () => {
    it('routes high-value tasks to quality channel', () => {
      const result = selectTextProvider(dualSettings, 'generate-detail');
      expect(result.tier).toBe('quality');
      expect(result.apiKey).toBe('sk-quality');
    });

    it('routes economy tasks to economy channel when available', () => {
      const result = selectTextProvider(dualSettings, 'ask-question');
      expect(result.tier).toBe('economy');
      expect(result.apiKey).toBe('sk-economy');
    });

    it('falls back to quality for economy tasks when economy channel is missing', () => {
      const result = selectTextProvider(qualitySettings, 'ask-question');
      expect(result.tier).toBe('quality');
      expect(result.apiKey).toBe('sk-quality');
    });
  });

  describe('quality mode', () => {
    it('always uses quality channel', () => {
      const settings = { ...dualSettings, routingMode: ROUTING_MODES.QUALITY };
      const economyResult = selectTextProvider(settings, 'ask-question');
      expect(economyResult.tier).toBe('quality');
      expect(economyResult.apiKey).toBe('sk-quality');

      const highResult = selectTextProvider(settings, 'generate-detail');
      expect(highResult.tier).toBe('quality');
    });
  });

  describe('economy mode', () => {
    it('uses economy channel when available', () => {
      const settings = { ...dualSettings, routingMode: ROUTING_MODES.ECONOMY };
      const result = selectTextProvider(settings, 'generate-detail');
      expect(result.tier).toBe('economy');
      expect(result.apiKey).toBe('sk-economy');
    });

    it('falls back to quality when economy channel is missing', () => {
      const settings = { ...qualitySettings, routingMode: ROUTING_MODES.ECONOMY };
      const result = selectTextProvider(settings, 'generate-detail');
      expect(result.tier).toBe('quality');
      expect(result.apiKey).toBe('sk-quality');
    });
  });

  describe('backward compatibility', () => {
    it('works with old settings that only have apiKey/baseURL/model', () => {
      const oldSettings = { apiKey: 'sk-old', baseURL: 'https://old.test/v1', model: 'gpt-3.5' };
      const result = selectTextProvider(oldSettings, 'generate-detail');
      expect(result.tier).toBe('quality');
      expect(result.apiKey).toBe('sk-old');
      expect(result.baseURL).toBe('https://old.test/v1');
    });
  });
});

describe('selectTextFallbackProvider', () => {
  const dualSettings = {
    apiKey: 'sk-quality',
    baseURL: 'https://quality.test/v1',
    model: 'gpt-4o',
    economyApiKey: 'sk-economy',
    economyBaseURL: 'https://economy.test/v1',
    economyModel: 'gpt-4o-mini',
    routingMode: ROUTING_MODES.BALANCED,
  };

  it('returns the quality channel after an economy task is blocked', () => {
    const fallback = selectTextFallbackProvider(dualSettings, 'ask-question');
    expect(fallback).toMatchObject({ apiKey: 'sk-quality', tier: 'quality' });
  });

  it('returns the economy channel after a quality task is blocked', () => {
    const fallback = selectTextFallbackProvider(dualSettings, 'generate-detail');
    expect(fallback).toMatchObject({ apiKey: 'sk-economy', tier: 'economy' });
  });

  it('returns null when there is no other text channel', () => {
    const fallback = selectTextFallbackProvider({ apiKey: 'sk-quality' }, 'ask-question');
    expect(fallback).toBeNull();
  });
});
