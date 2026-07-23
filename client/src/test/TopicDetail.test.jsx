import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    generateMistakeRepair: vi.fn(),
    dismissMistake: vi.fn(),
    createAttemptRef: vi.fn(() => 'exercise-attempt-fixed'),
    submitExercises: vi.fn(),
    submitReviewExercises: vi.fn(),
    submitRepairExercises: vi.fn(),
  },
}));

import api from '../api';

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

function mistake(overrides = {}) {
  return {
    id: 'mistake-1',
    version: 1,
    conceptKey: '词法作用域',
    conceptLabel: '词法作用域',
    status: 'open',
    severity: 'medium',
    evidenceIds: ['internal-evidence-1'],
    occurrenceCount: 1,
    firstSeenAt: Date.UTC(2026, 6, 21),
    lastSeenAt: Date.UTC(2026, 6, 21),
    verificationDueAt: null,
    verifiedAt: null,
    verificationEvidenceId: null,
    dismissedAt: null,
    dismissReason: null,
    ...overrides,
  };
}

function repairSession(overrides = {}) {
  return {
    id: 'repair-session-1',
    version: 1,
    kind: 'repair',
    mistakeId: 'mistake-1',
    createdAt: Date.UTC(2026, 6, 22),
    content: '持久化修复内容',
    exercises: [{ id: 'repair-ex-1', type: 'open', question: '解释词法作用域', conceptTag: '词法作用域' }],
    ...overrides,
  };
}

function renderTD(props = {}, { route = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
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
    api.generateReview.mockResolvedValue({ review: '复习内容' });
    api.generateMistakeRepair.mockReset();
    api.dismissMistake.mockReset();
    api.submitRepairExercises.mockReset();
    api.createAttemptRef.mockReturnValue('exercise-attempt-fixed');
    api.getPlan.mockResolvedValue({
      plan: {
        id: 'plan-1',
        name: 'JavaScript 基础',
        topics: [{ ...sampleTopic, imageUrl: '/images/test.png' }],
      },
    });
    vi.stubGlobal('alert', vi.fn());
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

    it('restores a persisted ReviewSession without generating or submitting on open', async () => {
      const reviewSession = {
        id: 'review-session-restored',
        version: 1,
        kind: 'review',
        mistakeId: null,
        createdAt: Date.UTC(2026, 6, 22),
        content: '持久化复习内容',
        exercises: [{ id: 'review-ex-1', type: 'open', question: '解释闭包', conceptTag: '闭包' }],
      };

      renderTD({ topic: { ...sampleTopic, done: true, reviewSession } }, { route: '/?review=1' });

      expect(await screen.findByText('持久化复习内容')).toBeInTheDocument();
      expect(screen.getByText('解释闭包')).toBeInTheDocument();
      expect(api.generateReview).not.toHaveBeenCalled();
      expect(api.submitReviewExercises).not.toHaveBeenCalled();
    });

    it('generates a ReviewSession on open but waits for an explicit answer submission', async () => {
      api.generateReview.mockResolvedValue({
        review: '新复习内容',
        reviewSession: {
          id: 'review-session-generated',
          version: 1,
          kind: 'review',
          mistakeId: null,
          createdAt: Date.UTC(2026, 6, 22),
          content: '新复习内容',
          exercises: [{ id: 'review-ex-1', type: 'open', question: '什么是词法作用域？', conceptTag: '词法作用域' }],
        },
      });

      renderTD({ topic: { ...sampleTopic, done: true } }, { route: '/?review=1' });

      expect(await screen.findByText('什么是词法作用域？')).toBeInTheDocument();
      expect(api.generateReview).toHaveBeenCalledWith('plan-1', 't-1');
      expect(api.submitReviewExercises).not.toHaveBeenCalled();
    });

    it('submits the persisted session once and shows results with the exact next date', async () => {
      const nextReviewAt = Date.UTC(2026, 6, 24, 12);
      let resolveSubmission;
      api.createAttemptRef.mockReturnValue('review-attempt-fixed');
      api.submitReviewExercises.mockImplementation(() => new Promise(resolve => { resolveSubmission = resolve; }));
      const reviewSession = {
        id: 'review-session-submit',
        version: 1,
        kind: 'review',
        mistakeId: null,
        createdAt: Date.UTC(2026, 6, 22),
        content: '提交复习内容',
        exercises: [{ id: 'review-ex-1', type: 'open', question: '解释闭包', conceptTag: '闭包' }],
      };

      renderTD({ topic: { ...sampleTopic, done: true, reviewSession } }, { route: '/?review=1' });
      fireEvent.change(await screen.findByPlaceholderText('输入你的答案...'), { target: { value: '闭包保留词法环境' } });
      const submit = screen.getByRole('button', { name: '提交答案' });
      fireEvent.click(submit);
      fireEvent.click(submit);

      expect(api.submitReviewExercises).toHaveBeenCalledTimes(1);
      expect(api.submitReviewExercises).toHaveBeenCalledWith(
        'plan-1',
        't-1',
        [{ exerciseIndex: 0, userAnswer: '闭包保留词法环境' }],
        'review-session-submit',
        'review-attempt-fixed'
      );

      resolveSubmission({
        results: [{ exerciseIndex: 0, correct: true, explanation: '回答正确' }],
        nextReviewAt,
      });

      expect(await screen.findByText('回答正确')).toBeInTheDocument();
      expect(screen.getByText('下次复习：2026-07-24')).toBeInTheDocument();
    });

    it('reuses the review attemptRef after a failed submission retry', async () => {
      api.createAttemptRef.mockReturnValue('review-attempt-retry');
      api.submitReviewExercises
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce({
          results: [{ exerciseIndex: 0, correct: true, explanation: '回答正确' }],
          nextReviewAt: Date.UTC(2026, 6, 24, 12),
        });
      const reviewSession = {
        id: 'review-session-retry',
        version: 1,
        kind: 'review',
        mistakeId: null,
        createdAt: Date.UTC(2026, 6, 22),
        content: '重试复习内容',
        exercises: [{ id: 'review-ex-1', type: 'open', question: '解释作用域', conceptTag: '作用域' }],
      };

      renderTD({ topic: { ...sampleTopic, done: true, reviewSession } }, { route: '/?review=1' });
      fireEvent.change(await screen.findByPlaceholderText('输入你的答案...'), { target: { value: '词法规则' } });
      fireEvent.click(screen.getByRole('button', { name: '提交答案' }));
      expect(await screen.findByText('提交失败：temporary failure')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '提交答案' }));
      await waitFor(() => expect(api.submitReviewExercises).toHaveBeenCalledTimes(2));
      expect(api.createAttemptRef).toHaveBeenCalledTimes(1);
      expect(api.submitReviewExercises.mock.calls[0][4]).toBe('review-attempt-retry');
      expect(api.submitReviewExercises.mock.calls[1][4]).toBe('review-attempt-retry');
    });
  });

  describe('mistake repair', () => {
    it('restores the matching persisted repair session after restart without regenerating', async () => {
      const persistedMistake = mistake({ status: 'repairing' });
      const session = repairSession();

      renderTD({
        topic: {
          ...sampleTopic,
          done: true,
          mistakes: [persistedMistake],
          reviewSession: session,
        },
      }, { route: '/?repair=mistake-1' });

      expect(await screen.findByText('持久化修复内容')).toBeInTheDocument();
      expect(screen.getByText('解释词法作用域')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '错题修复' })).toBeInTheDocument();
      expect(api.generateMistakeRepair).not.toHaveBeenCalled();
      expect(api.submitRepairExercises).not.toHaveBeenCalled();
      expect(screen.queryByText(/internal-evidence/)).not.toBeInTheDocument();
    });

    it('generates a repair session only for the mistake named in the URL and retries failures', async () => {
      const generatedSession = repairSession({
        id: 'repair-session-generated',
        content: '定向修复内容',
        exercises: [{ id: 'repair-ex-2', type: 'open', question: '定向解释词法环境', conceptTag: '词法作用域' }],
      });
      api.generateMistakeRepair
        .mockRejectedValueOnce(new Error('generation unavailable'))
        .mockResolvedValueOnce({
          review: '定向修复内容',
          reviewSession: generatedSession,
          mistake: mistake({ status: 'repairing' }),
        });

      renderTD({
        topic: { ...sampleTopic, done: true, mistakes: [mistake()] },
      }, { route: '/?repair=mistake-1' });

      expect(await screen.findByText('生成失败：generation unavailable')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '重试生成' }));
      expect(await screen.findByText('定向解释词法环境')).toBeInTheDocument();
      expect(api.generateMistakeRepair).toHaveBeenCalledTimes(2);
      expect(api.generateMistakeRepair).toHaveBeenNthCalledWith(1, 'plan-1', 't-1', 'mistake-1');
      expect(api.generateMistakeRepair).toHaveBeenNthCalledWith(2, 'plan-1', 't-1', 'mistake-1');
      expect(api.generateReview).not.toHaveBeenCalled();
    });

    it('submits once, keeps an immediate correction waiting, and shows the exact verification time', async () => {
      const verificationDueAt = Date.UTC(2026, 6, 23, 12, 34);
      const expectedTime = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(verificationDueAt));
      let resolveSubmission;
      api.createAttemptRef.mockReturnValue('repair-attempt-fixed');
      api.submitRepairExercises.mockImplementation(() => new Promise(resolve => { resolveSubmission = resolve; }));

      renderTD({
        topic: {
          ...sampleTopic,
          done: true,
          mistakes: [mistake({ status: 'repairing' })],
          reviewSession: repairSession(),
        },
      }, { route: '/?repair=mistake-1' });

      fireEvent.change(await screen.findByPlaceholderText('输入你的答案...'), {
        target: { value: '作用域由代码定义位置决定' },
      });
      const submit = screen.getByRole('button', { name: '提交答案' });
      fireEvent.click(submit);
      fireEvent.click(submit);

      expect(api.submitRepairExercises).toHaveBeenCalledTimes(1);
      expect(api.submitRepairExercises).toHaveBeenCalledWith(
        'plan-1',
        't-1',
        'mistake-1',
        [{ exerciseIndex: 0, userAnswer: '作用域由代码定义位置决定' }],
        'repair-session-1',
        'repair-attempt-fixed'
      );
      expect(api.createAttemptRef).toHaveBeenCalledWith('repair');

      resolveSubmission({
        results: [{ exerciseIndex: 0, correct: true, explanation: '即时纠正正确' }],
        mistake: mistake({ status: 'repairing', verificationDueAt }),
      });

      expect(await screen.findByText(`本次已修复，等待延迟验证：${expectedTime}`)).toBeInTheDocument();
      expect(screen.getByText('即时纠正正确')).toBeInTheDocument();
      expect(screen.queryByText(/已掌握|已通过延迟验证/)).not.toBeInTheDocument();
    });

    it('preserves the repair attempt and context after failure, then reports a reopened mistake', async () => {
      api.createAttemptRef.mockReturnValue('repair-attempt-retry');
      api.submitRepairExercises
        .mockRejectedValueOnce(new Error('stale response'))
        .mockResolvedValueOnce({
          results: [{ exerciseIndex: 0, correct: false, explanation: '仍需纠正' }],
          mistake: mistake({ status: 'open', occurrenceCount: 2, severity: 'high' }),
        });

      renderTD({
        topic: {
          ...sampleTopic,
          done: true,
          mistakes: [mistake({ status: 'repairing' })],
          reviewSession: repairSession(),
        },
      }, { route: '/?repair=mistake-1' });

      fireEvent.change(await screen.findByPlaceholderText('输入你的答案...'), {
        target: { value: '错误答案' },
      });
      fireEvent.click(screen.getByRole('button', { name: '提交答案' }));
      expect(await screen.findByText('提交失败：stale response')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '提交答案' }));
      await waitFor(() => expect(api.submitRepairExercises).toHaveBeenCalledTimes(2));
      expect(api.createAttemptRef).toHaveBeenCalledTimes(1);
      expect(api.submitRepairExercises.mock.calls[0][2]).toBe('mistake-1');
      expect(api.submitRepairExercises.mock.calls[1][2]).toBe('mistake-1');
      expect(api.submitRepairExercises.mock.calls[0][4]).toBe('repair-session-1');
      expect(api.submitRepairExercises.mock.calls[1][4]).toBe('repair-session-1');
      expect(api.submitRepairExercises.mock.calls[0][5]).toBe('repair-attempt-retry');
      expect(api.submitRepairExercises.mock.calls[1][5]).toBe('repair-attempt-retry');
      expect(await screen.findByText(/错题已重新打开/)).toBeInTheDocument();
      expect(screen.getByText('仍需纠正')).toBeInTheDocument();
    });

    it('labels a due repair as verified only after the server confirms delayed verification', async () => {
      const dueAt = Date.UTC(2026, 6, 22, 12);
      api.submitRepairExercises.mockResolvedValue({
        results: [{ exerciseIndex: 0, correct: true, explanation: '延迟验证正确' }],
        mistake: mistake({ status: 'verified', verificationDueAt: dueAt, verifiedAt: dueAt }),
      });

      renderTD({
        topic: {
          ...sampleTopic,
          done: true,
          mistakes: [mistake({ status: 'repairing', verificationDueAt: dueAt })],
          reviewSession: repairSession(),
        },
      }, { route: '/?repair=mistake-1' });

      fireEvent.change(await screen.findByPlaceholderText('输入你的答案...'), {
        target: { value: '延迟后再次正确' },
      });
      fireEvent.click(screen.getByRole('button', { name: '提交答案' }));

      expect(await screen.findByText('已通过延迟验证')).toBeInTheDocument();
      expect(screen.getByText('延迟验证正确')).toBeInTheDocument();
      expect(screen.queryByText('已掌握')).not.toBeInTheDocument();
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

    it('settles the refreshed image-generation state without calling generateDetail', async () => {
      const apiModule = await import('../api');
      const api = apiModule.default;
      const onRefresh = vi.fn();
      renderTD({
        topic: { ...sampleTopic, detail: '闭包是 JavaScript 中的重要概念。', imageUrl: null },
        onRefresh,
      });

      const button = screen.getByRole('button', { name: '生成配图' });
      fireEvent.click(button);
      expect(button).toHaveTextContent('生成中...');

      await waitFor(() => {
        expect(api.generateTopicImage).toHaveBeenCalledWith('plan-1', 't-1');
        expect(api.getPlan).toHaveBeenCalledWith('plan-1');
        expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1' }));
        expect(button).toHaveTextContent('生成配图');
      });
      expect(api.generateDetail).not.toHaveBeenCalled();
    });
  });

  describe('Markdown exercise fallback', () => {
    it('renders parsed selection and open exercises when stored exercises are absent', async () => {
      const detail = `## 闭包

闭包将函数和其词法环境组合在一起。

## 📝 练习题

> **练习题 1**（选择题）：闭包的关键特性是什么？
> - A. 只能访问全局变量
> - B. 可以访问其词法作用域
> - C. 必须使用 class
> - D. 只能同步执行
> > 正确答案：B
> > 解析：闭包保留了词法环境。
> > 关联概念：词法作用域

> **练习题 2**（开放题）：解释闭包为何能保存状态。
> > 参考答案：函数继续引用外层变量。
> > 解析：引用在函数返回后仍然存在。
> > 关联概念：作用域链`;

      renderTD({ topic: { ...sampleTopic, detail, exercises: [] } });

      await waitFor(() => {
        expect(screen.getByText(/闭包的关键特性是什么/)).toBeInTheDocument();
        expect(screen.getByText('A. 只能访问全局变量')).toBeInTheDocument();
        expect(screen.getByText('B. 可以访问其词法作用域')).toBeInTheDocument();
        expect(screen.getByText(/解释闭包为何能保存状态/)).toBeInTheDocument();
        expect(screen.getByText('选择题')).toBeInTheDocument();
        expect(screen.getByText('简答题')).toBeInTheDocument();
      });
    });

    it('does not invent exercises when Markdown has no exercise section', async () => {
      renderTD({
        topic: {
          ...sampleTopic,
          detail: '## 闭包\n\n这里只是正文，没有练习段落。',
          exercises: [],
        },
      });

      await waitFor(() => {
        expect(screen.queryByText('A. 不应显示的选项')).not.toBeInTheDocument();
        expect(screen.queryByText('练习题 1')).not.toBeInTheDocument();
      });
    });

    it('ignores malformed exercise Markdown without throwing or rendering invented questions', async () => {
      renderTD({
        topic: {
          ...sampleTopic,
          detail: `## 📝 练习题

> **练习题**（选择题）：缺少题号
> - A. 不应显示的选项
> > 正确答案：A`,
          exercises: [],
        },
      });

      await waitFor(() => {
        expect(screen.queryByText('A. 不应显示的选项')).not.toBeInTheDocument();
        expect(screen.queryByText('缺少题号')).not.toBeInTheDocument();
      });
    });
  });

  it('reuses the same attemptRef when an exercise submission is retried', async () => {
    api.submitExercises
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        results: [{ exerciseIndex: 0, correct: true, userAnswer: 'closure' }],
      });
    const topic = {
      ...sampleTopic,
      exercises: [{
        id: 'ex-1',
        type: 'open',
        question: 'What is retained?',
        answer: 'closure',
        userAnswer: null,
        correct: null,
      }],
    };
    renderTD({ topic });

    fireEvent.change(screen.getByPlaceholderText('输入你的答案...'), {
      target: { value: 'closure' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交答案' }));
    await waitFor(() => expect(api.submitExercises).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '提交答案' }));

    await waitFor(() => expect(api.submitExercises).toHaveBeenCalledTimes(2));
    expect(api.createAttemptRef).toHaveBeenCalledTimes(1);
    expect(api.submitExercises.mock.calls[0][3]).toBe('exercise-attempt-fixed');
    expect(api.submitExercises.mock.calls[1][3]).toBe('exercise-attempt-fixed');
  });
});
