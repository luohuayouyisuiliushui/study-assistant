import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TopicDetail from '../components/TopicDetail';

vi.mock('../api', () => ({
  default: {
    generateDetail: vi.fn(),
    generateTopicImage: vi.fn(() => Promise.resolve({ imageUrl: '/images/test.png' })),
    askQuestion: vi.fn(),
    recordTime: vi.fn(),
    updateTopic: vi.fn(),
    revealErrors: vi.fn(),
    factCheck: vi.fn(),
    autoFixFacts: vi.fn(),
    reviewErrors: vi.fn(),
    inferRelations: vi.fn(() => Promise.resolve()),
    getPlan: vi.fn(() => Promise.resolve({ plan: { id: 'plan-1', name: 'JavaScript 基础', topics: [{ id: 't-1', title: 'JavaScript 闭包', detail: '闭包是 JavaScript 中的一个重要概念。', done: false, level: 1, imageUrl: '/images/test.png' }] } })),
    exportAnkiCSV: vi.fn(() => '/api/export/anki'),
    exportOPML: vi.fn(() => '/api/export/opml'),
    exportNotionCSV: vi.fn(() => '/api/export/notion'),
    exportJSON: vi.fn(() => '/api/export/json'),
    exportStudyNotes: vi.fn(() => '/api/export/notes'),
    exportBundle: vi.fn(() => '/api/export/bundle'),
    startInteractiveSSE: vi.fn(() => Promise.resolve()),
    continueInteractiveSSE: vi.fn(() => Promise.resolve()),
    generateReview: vi.fn(() => Promise.resolve({ review: '复习内容' })),
  },
}));

// Mock settings-storage to provide imageApiKey for image generation tests
vi.mock('#/lib/settings-storage', () => ({
  loadSettings: vi.fn(() => ({
    apiKey: 'test-key',
    imageApiKey: 'test-image-key',
    imageModel: 'FLUX.1-dev',
  })),
}));

// Mock AIStatusIndicator to avoid fetch dependency in tests
vi.mock('../components/AIStatus', () => ({
  default: () => null,
  useAIStatus: () => ({ connected: null, checking: true }),
}));

const sampleTopic = { id: 't-1', title: 'JavaScript 闭包', detail: '闭包是 JavaScript 中的一个重要概念。', done: false, level: 1 };
const samplePlan = { id: 'plan-1', name: 'JavaScript 基础', topics: [] };

function renderTD(props = {}) {
  return render(
    <MemoryRouter>
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={vi.fn()}
        onRefresh={vi.fn()}
        onSelectTopic={vi.fn()}
        {...props}
      />
    </MemoryRouter>
  );
}

describe('TopicDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.URL.createObjectURL = vi.fn(() => 'blob:url');
    window.URL.revokeObjectURL = vi.fn();
  });

  it('renders topic title', () => {
    renderTD();
    expect(screen.getByText('JavaScript 闭包')).toBeInTheDocument();
  });

  it('renders without crashing', () => {
    const { container } = renderTD();
    expect(container.querySelector('.space-y-6')).toBeDefined();
  });

  describe('action menu', () => {
    it('shows teaching mode entries when "更多操作" is clicked', () => {
      renderTD();
      fireEvent.click(screen.getByTitle('更多操作'));
      expect(screen.getByText('分段讲解')).toBeInTheDocument();
      expect(screen.getByText('实时互动')).toBeInTheDocument();
      expect(screen.getByText('费曼学习法')).toBeInTheDocument();
      expect(screen.getByText('支架教学')).toBeInTheDocument();
    });

    it('shows export entries in action menu', () => {
      renderTD();
      fireEvent.click(screen.getByTitle('更多操作'));
      expect(screen.getByText('Markdown (.md)')).toBeInTheDocument();
      expect(screen.getByText('HTML (.html)')).toBeInTheDocument();
    });

    it('shows analysis tools in action menu', () => {
      renderTD();
      fireEvent.click(screen.getByTitle('更多操作'));
      expect(screen.getByText('事实核查')).toBeInTheDocument();
      expect(screen.getByText('自适应分析')).toBeInTheDocument();
    });
  });

  describe('review button', () => {
    it('shows review button when topic is done', () => {
      renderTD({ topic: { ...sampleTopic, done: true } });
      expect(screen.getByTitle('复习模式')).toBeInTheDocument();
    });

    it('does not show review button when topic is not done', () => {
      renderTD({ topic: { ...sampleTopic, done: false } });
      expect(screen.queryByTitle('复习模式')).not.toBeInTheDocument();
    });
  });

  describe('failed generation', () => {
    it('allows a failed topic to start generation again', async () => {
      const apiModule = await import('../api');
      const api = apiModule.default;
      api.generateDetail.mockResolvedValue({ status: 'generating' });

      renderTD({
        topic: {
          ...sampleTopic,
          detail: '半截讲解',
          done: false,
          lastError: '生成失败: Upstream HTTP/2 stream failed',
        },
      });

      fireEvent.click(screen.getByRole('button', { name: '重新生成' }));

      expect(api.generateDetail).toHaveBeenCalledWith('plan-1', 't-1');
      expect(screen.getByText('生成中...')).toBeInTheDocument();
    });
  });

  describe('topic relationship navigation', () => {
    it('opens the selected topic without navigating back first', () => {
      const onBack = vi.fn();
      const onSelectTopic = vi.fn();
      const prerequisite = { id: 't-prerequisite', title: '词法作用域', done: true };

      renderTD({
        plan: { ...samplePlan, topics: [prerequisite] },
        topic: { ...sampleTopic, prerequisites: [prerequisite.id] },
        onBack,
        onSelectTopic,
      });

      fireEvent.click(screen.getByRole('button', { name: prerequisite.title }));

      expect(onSelectTopic).toHaveBeenCalledWith(prerequisite.id);
      expect(onBack).not.toHaveBeenCalled();
    });
  });

  describe('image generation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('shows "生成配图" button when topic has detail and imageApiKey is set', () => {
      renderTD({ topic: { ...sampleTopic, detail: '闭包是 JavaScript 中的重要概念。', imageUrl: null } });
      expect(screen.getByText('生成配图')).toBeInTheDocument();
    });

    it('calls generateTopicImage (not generateDetail) when "生成配图" is clicked', async () => {
      const apiModule = await import('../api');
      const api = apiModule.default;
      renderTD({ topic: { ...sampleTopic, detail: '闭包是 JavaScript 中的重要概念。', imageUrl: null } });
      fireEvent.click(screen.getByText('生成配图'));
      await vi.waitFor(() => {
        expect(api.generateTopicImage).toHaveBeenCalledWith('plan-1', 't-1');
        expect(api.generateDetail).not.toHaveBeenCalled();
      });
    });
  });
});
