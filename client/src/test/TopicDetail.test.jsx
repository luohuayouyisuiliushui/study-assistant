import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import TopicDetail from '../components/TopicDetail';

vi.mock('../api', () => ({
  default: {
    generateDetail: vi.fn(() => Promise.resolve()),
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
    recommendResources: vi.fn(),
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

  it('keeps explanation and assessment primary in study_trace practice mode', () => {
    const practiceTopic = {
      ...sampleTopic,
      detail: [
        '闭包讲解正文。',
        '',
        '## 练习题',
        '> **练习题 1**（选择题）哪个说法正确？',
        '> - A. 保留词法作用域',
        '> - B. 删除所有变量',
        '> > 正确答案：A',
      ].join('\n'),
    };

    renderTD({ topic: practiceTopic, practiceMode: true });

    expect(screen.getByRole('status')).toHaveTextContent('study_trace');
    expect(screen.getByText('闭包讲解正文。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '练习题' })).toBeInTheDocument();
    expect(screen.getByText('哪个说法正确？')).toBeInTheDocument();
    expect(screen.queryAllByTitle('标记为已学完并返回列表')).toHaveLength(0);
    expect(screen.queryByText('暂无关联知识点')).not.toBeInTheDocument();
    expect(screen.queryByText('推荐学习资源')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/你在讲解中发现了哪些错误/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('更多操作'));
    expect(screen.getByText('Markdown (.md)')).toBeInTheDocument();
    expect(screen.getByText('推荐学习资源')).toBeInTheDocument();
  });

  it('threads the practice query through the existing topic route wrapper', () => {
    const appPath = path.resolve(process.cwd(), 'src/App.jsx');
    const source = readFileSync(appPath, 'utf8');
    expect(source).toContain('useSearchParams');
    expect(source).toContain("searchParams.get('practice') === '1'");
    expect(source).toContain('practiceMode={practiceMode}');
  });

  it('delegates session timing and generation orchestration to the workspace hook', () => {
    const componentPath = path.resolve(process.cwd(), 'src/components/TopicDetail.jsx');
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain('useTopicLearningWorkspace');
    expect(source).not.toContain('api.recordTime');
    expect(source).not.toContain('setInterval(async () =>');
    for (const method of [
      'generateDetail',
      'generateReview',
      'submitExercises',
      'startInteractiveSSE',
      'continueInteractiveSSE',
      'clearInteractiveSession',
      'analyzeFeynmanSession',
      'revealErrors',
      'updateTopic',
      'askQuestion',
      'factCheck',
      'autoFixFacts',
      'adaptiveAnalysis',
      'recommendResources',
      'generateTopicImage',
      'inferRelations',
    ]) {
      expect(source).not.toContain(`api.${method}`);
    }
  });

  describe('interactive stream retries', () => {
    it('discards partial content when a new start attempt resets the stream', async () => {
      const apiModule = await import('../api');
      apiModule.default.startInteractiveSSE.mockImplementation(async (_planId, _topicId, _mode, onEvent) => {
        onEvent({ type: 'chunk', content: 'discarded partial' });
        onEvent({ type: 'reset' });
        onEvent({ type: 'chunk', content: 'replacement' });
        onEvent({ type: 'done', session: { mode: 'stepwise' }, finished: false });
      });

      renderTD();
      fireEvent.click(screen.getByTitle('更多操作'));
      fireEvent.click(screen.getByText('分段讲解'));

      expect(await screen.findByText('replacement')).toBeInTheDocument();
      expect(screen.queryByText(/discarded partial/)).not.toBeInTheDocument();
    });

    it('discards partial content when a continuation attempt resets the stream', async () => {
      const apiModule = await import('../api');
      apiModule.default.continueInteractiveSSE.mockImplementation(async (_planId, _topicId, _mode, _feedback, onEvent) => {
        onEvent({ type: 'chunk', content: 'discarded continuation' });
        onEvent({ type: 'reset' });
        onEvent({ type: 'chunk', content: 'replacement continuation' });
        onEvent({ type: 'done', session: { mode: 'stepwise' }, finished: false });
      });
      const topic = {
        ...sampleTopic,
        interactiveSession: {
          mode: 'stepwise', finished: false,
          transcript: [{ role: 'assistant', content: 'first section' }],
        },
      };

      renderTD({ topic });
      fireEvent.click(screen.getByTitle('更多操作'));
      fireEvent.click(screen.getByText('分段讲解'));
      fireEvent.click(await screen.findByRole('button', { name: '继续' }));

      expect(await screen.findByText('replacement continuation')).toBeInTheDocument();
      expect(screen.queryByText(/discarded continuation/)).not.toBeInTheDocument();
    });
  });

  describe('failed generation', () => {
    it('shows the error and starts generation again when retried', async () => {
      const apiModule = await import('../api');
      apiModule.default.generateDetail.mockResolvedValue({ status: 'generating' });

      renderTD({
        topic: {
          ...sampleTopic,
          detail: '半截讲解',
          lastError: '生成失败: Upstream HTTP/2 stream failed',
        },
      });

      expect(screen.getByRole('alert')).toHaveTextContent('讲解生成失败');
      fireEvent.click(screen.getByRole('button', { name: '重新生成' }));

      expect(apiModule.default.generateDetail).toHaveBeenCalledWith('plan-1', 't-1');
      expect(screen.getByText('生成中...')).toBeInTheDocument();
    });
  });

  describe('related topic navigation', () => {
    it('selects the related topic, generates its missing detail, and does not navigate back', async () => {
      const onBack = vi.fn();
      const relatedTopic = { id: 't-2', title: 'JavaScript 原型链', detail: '', done: false, level: 1 };
      const sourceTopic = { ...sampleTopic, relatedTopics: [relatedTopic.id] };
      const plan = { ...samplePlan, topics: [sourceTopic, relatedTopic] };

      function RelatedTopicNavigation() {
        const [selectedTopicId, setSelectedTopicId] = useState(sampleTopic.id);
        const selectedTopic = plan.topics.find(t => t.id === selectedTopicId);

        return (
          <MemoryRouter>
            <TopicDetail
              plan={plan}
              topic={selectedTopic}
              onBack={onBack}
              onRefresh={vi.fn()}
              onSelectTopic={setSelectedTopicId}
            />
          </MemoryRouter>
        );
      }

      render(<RelatedTopicNavigation />);

      fireEvent.click(screen.getByRole('button', { name: relatedTopic.title }));

      expect(onBack).not.toHaveBeenCalled();
      const apiModule = await import('../api');
      await waitFor(() => {
        expect(apiModule.default.generateDetail).toHaveBeenCalledWith(plan.id, relatedTopic.id);
      });
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

    it('opens an existing topic image in the full-screen viewer', () => {
      renderTD({ topic: { ...sampleTopic, imageUrl: '/images/test.png' } });

      fireEvent.click(screen.getByRole('button', { name: '全屏查看：JavaScript 闭包 知识点配图' }));

      expect(screen.getByRole('dialog', { name: 'JavaScript 闭包 知识点配图 全屏预览' })).toBeInTheDocument();
    });
  });

  describe('sticky navigation', () => {
    it('stays hidden after the title scrolls away until the pointer reaches the top edge', async () => {
      let observerCallback;
      const originalIntersectionObserver = global.IntersectionObserver;
      const originalMatchMedia = global.matchMedia;

      global.IntersectionObserver = class IntersectionObserver {
        constructor(callback) { observerCallback = callback; }
        observe() {}
        disconnect() {}
      };
      global.matchMedia = vi.fn(() => ({
        matches: true,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }));

      const { container, unmount } = renderTD();
      try {
        await act(async () => {
          observerCallback([{ isIntersecting: false }]);
        });

        const stickyNav = container.querySelector('nav[aria-label="悬浮知识点导航"]');
        expect(stickyNav).toBeInTheDocument();
        expect(stickyNav).toHaveClass('opacity-0');

        fireEvent.mouseMove(document, { clientY: 8 });

        await waitFor(() => expect(stickyNav).toHaveClass('opacity-100'));
      } finally {
        unmount();
        global.IntersectionObserver = originalIntersectionObserver;
        global.matchMedia = originalMatchMedia;
      }
    });
  });

  describe('resource recommendations', () => {
    it('treats an empty cached list as not yet recommended', () => {
      renderTD({ topic: { ...sampleTopic, resources: [] } });

      expect(screen.getByRole('button', { name: '推荐资源' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '重新推荐' })).not.toBeInTheDocument();
    });
  });
});
