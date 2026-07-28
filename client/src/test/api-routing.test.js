import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '../api';
import { loadSettings, selectTextProvider, selectTextFallbackProvider, ROUTING_MODES } from '../lib/settings-storage';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock settings-storage so tests control what's in localStorage
vi.mock('../lib/settings-storage', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    selectTextProvider: vi.fn(),
    selectTextFallbackProvider: vi.fn(),
  };
});

describe('API routing — fetch integration', () => {
  const qualityProvider = { apiKey: 'sk-quality', baseURL: 'https://quality.test/v1', model: 'gpt-4o', tier: 'quality' };
  const economyProvider = { apiKey: 'sk-economy', baseURL: 'https://economy.test/v1', model: 'gpt-4o-mini', tier: 'economy' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
  });

  describe('balanced mode routing', () => {
    it('sends quality credentials for high-value task (generate-detail)', async () => {
      selectTextProvider.mockImplementation((settings, taskType) => {
        expect(taskType).toBe('generate-detail');
        return qualityProvider;
      });
      loadSettings.mockReturnValue({ routingMode: ROUTING_MODES.BALANCED });

      await api.generateDetail('plan-1', 'topic-1');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.apiKey).toBe('sk-quality');
      expect(body.baseURL).toBe('https://quality.test/v1');
      expect(body.model).toBe('gpt-4o');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('sends economy credentials for economy task (ask-question)', async () => {
      selectTextProvider.mockImplementation((settings, taskType) => {
        expect(taskType).toBe('ask-question');
        return economyProvider;
      });
      loadSettings.mockReturnValue({ routingMode: ROUTING_MODES.BALANCED });

      await api.askQuestion('plan-1', 'topic-1', '什么是闭包？');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.apiKey).toBe('sk-economy');
      expect(body.baseURL).toBe('https://economy.test/v1');
    });

    it('retries a blocked question through the other text channel', async () => {
      selectTextProvider.mockReturnValue(economyProvider);
      selectTextFallbackProvider.mockReturnValue(qualityProvider);
      loadSettings.mockReturnValue({ routingMode: ROUTING_MODES.BALANCED });
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: 'AI 服务的内容安全策略拦截了请求。' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ answer: '已通过备用通道回答。' }),
        });

      await expect(api.askQuestion('plan-1', 'topic-1', '什么是闭包？')).resolves.toEqual({ answer: '已通过备用通道回答。' });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).apiKey).toBe('sk-economy');
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).apiKey).toBe('sk-quality');
    });

    it('does not send text credentials for image generation', async () => {
      loadSettings.mockReturnValue({
        imageApiKey: 'sk-image',
        imageModel: 'FLUX.1-dev',
        imageFallbackModel: 'FLUX.1-schnell',
      });

      await api.generateTopicImage('plan-1', 'topic-1');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      // Should only contain image credentials
      expect(body.imageApiKey).toBe('sk-image');
      expect(body.imageModel).toBe('FLUX.1-dev');
      expect(body.imageFallbackModel).toBe('FLUX.1-schnell');
      // Should NOT contain text channel credentials
      expect(body.apiKey).toBeUndefined();
      expect(body.baseURL).toBeUndefined();
      expect(body.model).toBeUndefined();
    });

    it('does not send any credentials for pure logic request (getAgentUsage)', async () => {
      loadSettings.mockReturnValue({ apiKey: 'sk-quality' });

      await api.getAgentUsage();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      // No body or no credentials in body for pure logic requests
      if (opts.body) {
        const body = JSON.parse(opts.body);
        expect(body.apiKey).toBeUndefined();
      }
    });
  });

  describe('body and header handling', () => {
    it('accepts plain object body (getCoreTopics)', async () => {
      selectTextProvider.mockReturnValue(qualityProvider);
      loadSettings.mockReturnValue({ apiKey: 'sk-quality' });

      await api.getCoreTopics('plan-1', true);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.force).toBe(true);
      expect(body.apiKey).toBe('sk-quality');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('economy fallback', () => {
    it('falls back to quality when economy channel is configured but key is empty', async () => {
      selectTextProvider.mockImplementation((settings, taskType) => {
        expect(taskType).toBe('ask-question');
        return qualityProvider; // economy not configured → selectTextProvider returns quality
      });
      loadSettings.mockReturnValue({ apiKey: 'sk-quality' });

      await api.askQuestion('plan-1', 'topic-1', 'test');

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.apiKey).toBe('sk-quality');
      expect(body.baseURL).toBe('https://quality.test/v1');
    });
  });

  describe('submitFeedback and getAgentUsage (pure logic, no credentials)', () => {
    it('submitFeedback does not inject text credentials', async () => {
      loadSettings.mockReturnValue({ apiKey: 'sk-quality' });

      await api.submitFeedback('plan-1', 'topic-1', '内容有误', 'feynman');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.reason).toBe('内容有误');
      expect(body.mode).toBe('feynman');
      // Should NOT have apiKey/baseURL/model injected
      expect(body.apiKey).toBeUndefined();
    });
  });
});
