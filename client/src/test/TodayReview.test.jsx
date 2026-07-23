import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TodayReview from '../components/TodayReview';

vi.mock('../api', () => ({
  default: {
    getTodayReviews: vi.fn(),
  },
}));

import api from '../api';

function reviewItem(index, overrides = {}) {
  return {
    queueItemId: `review:plan-${index}:topic-${index}`,
    kind: 'review',
    planId: `plan-${index}`,
    planName: `学习计划 ${index}`,
    topicId: `topic-${index}`,
    topicTitle: `知识点 ${index}`,
    dueAt: Date.UTC(2026, 6, index),
    priorityScore: 220 - index,
    mastery: { level: 0.5 },
    ...overrides,
  };
}

function mistakeItem(index, overrides = {}) {
  return {
    queueItemId: `mistake:plan-${index}:topic-${index}`,
    kind: 'mistake',
    planId: `plan-${index}`,
    planName: `学习计划 ${index}`,
    topicId: `topic-${index}`,
    topicTitle: `知识点 ${index}`,
    dueAt: Date.UTC(2026, 6, 22),
    priorityScore: 350,
    primaryMistakeId: `mistake-${index}`,
    conceptLabel: `易错概念 ${index}`,
    status: 'open',
    severity: 'high',
    occurrenceCount: 3,
    verificationDueAt: null,
    evidenceIds: [`internal-evidence-${index}`],
    ...overrides,
  };
}

function queue(items, counts = null) {
  const review = items.filter(item => item.kind === 'review').length;
  const mistake = items.filter(item => item.kind === 'mistake').length;
  return {
    generatedAt: Date.UTC(2026, 6, 22),
    counts: counts || { review, mistake, waitingVerification: 0, total: items.length },
    items,
  };
}

describe('TodayReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders reviews in API order and opens the selected Plan and Topic', async () => {
    const items = [reviewItem(1), reviewItem(2), reviewItem(3)];
    const onOpen = vi.fn();
    api.getTodayReviews.mockResolvedValue(queue(items));

    render(<TodayReview onOpen={onOpen} />);

    const list = await screen.findByRole('list', { name: '今日复习队列' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map(button => button.textContent)).toEqual([
      expect.stringContaining('知识点 1'),
      expect.stringContaining('知识点 2'),
      expect.stringContaining('知识点 3'),
    ]);

    fireEvent.click(buttons[1]);
    expect(onOpen).toHaveBeenCalledWith(items[1]);
  });

  it('shows a compact completed state when nothing is due', async () => {
    api.getTodayReviews.mockResolvedValue(queue([]));

    render(<TodayReview onOpen={vi.fn()} />);

    expect(await screen.findByText('今日已完成')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '今日复习队列' })).not.toBeInTheDocument();
  });

  it('renders a targeted mistake with concept, recurrence, severity, status, and exact due time', async () => {
    const verificationDueAt = Date.UTC(2026, 6, 22, 12, 34);
    const expectedTime = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(verificationDueAt));
    const item = mistakeItem(1, { status: 'repairing', verificationDueAt });
    const onOpen = vi.fn();
    api.getTodayReviews.mockResolvedValue(queue([item]));

    render(<TodayReview onOpen={onOpen} />);

    expect(await screen.findByText('易错概念 1')).toBeInTheDocument();
    expect(screen.getByText('高优先级 · 复发 2 次 · 验证到期')).toBeInTheDocument();
    expect(screen.getByText(`验证到期：${expectedTime}`)).toBeInTheDocument();
    expect(screen.queryByText(/internal-evidence/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '修复 易错概念 1，知识点 知识点 1' }));
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it('distinguishes waiting verification from a completed empty queue', async () => {
    api.getTodayReviews.mockResolvedValue(queue([], {
      review: 0,
      mistake: 0,
      waitingVerification: 2,
      total: 0,
    }));

    render(<TodayReview onOpen={vi.fn()} />);

    expect(await screen.findByText('2 个错题等待延迟验证')).toBeInTheDocument();
    expect(screen.queryByText('今日已完成')).not.toBeInTheDocument();
  });

  it('keeps unknown queue kinds readable and non-actionable', async () => {
    api.getTodayReviews.mockResolvedValue(queue([
      reviewItem(1, { kind: 'future-kind', queueItemId: 'unknown:1' }),
    ]));

    render(<TodayReview onOpen={vi.fn()} />);

    expect(await screen.findByText('任务类型异常，请刷新后重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '无法打开的未知任务 知识点 1' })).toBeDisabled();
  });

  it('shows five items initially and expands or collapses overflow without losing order', async () => {
    const items = Array.from({ length: 6 }, (_, index) => reviewItem(index + 1, {
      topicTitle: index === 5
        ? '一个需要在窄屏自然换行但不能遮挡其他控件的 VeryLongKnowledgePointTitle'
        : `知识点 ${index + 1}`,
    }));
    api.getTodayReviews.mockResolvedValue(queue(items));

    render(<TodayReview onOpen={vi.fn()} />);

    await screen.findByText('知识点 1');
    expect(screen.queryByText(items[5].topicTitle)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看全部 6 项' }));
    expect(screen.getByText(items[5].topicTitle)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '今日复习队列' })).getAllByRole('button')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: '收起今日复习' }));
    expect(screen.queryByText(items[5].topicTitle)).not.toBeInTheDocument();
  });

  it('keeps surrounding plan controls usable and retries after an API failure', async () => {
    api.getTodayReviews
      .mockRejectedValueOnce(new Error('服务暂时不可用'))
      .mockResolvedValueOnce(queue([reviewItem(1)]));
    const onPlanOpen = vi.fn();

    render(
      <>
        <TodayReview onOpen={vi.fn()} />
        <button type="button" onClick={onPlanOpen}>打开已有计划</button>
      </>
    );

    expect(await screen.findByText('今日复习加载失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开已有计划' }));
    expect(onPlanOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '重试今日复习' }));
    await waitFor(() => expect(screen.getByText('知识点 1')).toBeInTheDocument());
    expect(api.getTodayReviews).toHaveBeenCalledTimes(2);
  });
});
