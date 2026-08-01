import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TodayReviewSummary from '../components/TodayReviewSummary';
import TodayReviewPage from '../pages/TodayReview';

vi.mock('../api', () => ({
  default: {
    getTodayReview: vi.fn(),
    createReviewSession: vi.fn(),
    createMistakeRepairSession: vi.fn(),
    submitReviewSession: vi.fn(),
    deferReview: vi.fn(),
    dismissMistake: vi.fn(),
  },
}));

import api from '../api';

const activeSession = {
  id: 'session-1', planId: 'p1', topicId: 't1', topicTitle: 'TCP',
  kind: 'review', status: 'active', estimatedMinutes: 10,
  questions: [{ id: 'q1', prompt: 'TCP 是什么？', conceptKey: 'tcp', options: [] }],
};

const queue = {
  budgetMinutes: 30,
  scheduledMinutes: 25,
  totalCount: 2,
  remainingCount: 0,
  items: [
    {
      planId: 'p1', planName: '网络', topicId: 't1', topicTitle: 'TCP',
      reason: 'open-mistake', estimatedMinutes: 10,
      activeSession,
      mistake: { conceptKey: 'tcp', status: 'open' },
    },
    {
      planId: 'p2', planName: '系统', topicId: 't2', topicTitle: '进程',
      reason: 'overdue-review', estimatedMinutes: 15, overdueDays: 3,
      activeSession: null, mistake: null,
    },
  ],
};

describe('Today Review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.getTodayReview.mockResolvedValue({ queue });
  });

  it('shows a home summary with budget and unfinished-session recovery', async () => {
    const onStart = vi.fn();
    render(<TodayReviewSummary onStart={onStart} />);

    expect(await screen.findByText('今日复习')).toBeInTheDocument();
    expect(screen.getByText('2 个知识点')).toBeInTheDocument();
    expect(screen.getByText('25 / 30 分钟')).toBeInTheDocument();
    expect(screen.getByText('1 个未完成会话')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '继续今日复习' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('resumes a fixed session, hides answers, and reveals grading after submission', async () => {
    api.createReviewSession.mockResolvedValue({ resumed: true, session: activeSession });
    api.submitReviewSession.mockResolvedValue({
      results: [{
        questionId: 'q1', userAnswer: '传输控制协议', correct: true,
        expectedAnswer: '传输控制协议', explanation: '提供可靠的字节流传输。',
      }],
      state: { topic: { mastery: { status: 'learning', level: 0.33 } } },
    });
    render(<TodayReviewPage />);

    await userEvent.click(await screen.findByRole('button', { name: '继续复习 TCP' }));
    expect(screen.queryByText('传输控制协议')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('TCP 是什么？'), '传输控制协议');
    await userEvent.click(screen.getByRole('button', { name: '提交答案' }));

    expect(await screen.findByText('回答正确')).toBeInTheDocument();
    expect(screen.getByText('传输控制协议')).toBeInTheDocument();
    expect(screen.getByText('提供可靠的字节流传输。')).toBeInTheDocument();
    expect(api.submitReviewSession).toHaveBeenCalledWith('p1', 't1', {
      sessionId: 'session-1',
      answers: [{ questionId: 'q1', answer: '传输控制协议' }],
    });
    expect(api.createReviewSession).toHaveBeenCalledWith('p1', 't1');
    expect(api.createMistakeRepairSession).not.toHaveBeenCalled();
  });

  it('supports explicit defer and dismiss actions without producing answers', async () => {
    api.deferReview.mockResolvedValue({ state: {} });
    api.dismissMistake.mockResolvedValue({ state: {} });
    api.getTodayReview
      .mockResolvedValueOnce({ queue })
      .mockResolvedValueOnce({ queue })
      .mockResolvedValue({ queue: { ...queue, items: [], totalCount: 0, scheduledMinutes: 0 } });
    render(<TodayReviewPage />);

    await userEvent.click(await screen.findByRole('button', { name: '延后 TCP 1 天' }));
    await waitFor(() => expect(api.deferReview).toHaveBeenCalledWith('p1', 't1', expect.any(Number)));

    await userEvent.click(screen.getByRole('button', { name: '忽略 TCP 错题' }));
    await waitFor(() => expect(api.dismissMistake).toHaveBeenCalledWith('p1', 't1', 'tcp'));
    expect(api.submitReviewSession).not.toHaveBeenCalled();
  });

  it('closes a persisted session locally after deferring it', async () => {
    api.createReviewSession.mockResolvedValue({ resumed: true, session: activeSession });
    api.deferReview.mockResolvedValue({ state: { topic: { reviewSession: { status: 'deferred' } } } });
    api.getTodayReview
      .mockResolvedValueOnce({ queue })
      .mockResolvedValue({ queue: { ...queue, items: [], totalCount: 0, scheduledMinutes: 0 } });
    render(<TodayReviewPage />);

    await userEvent.click(await screen.findByRole('button', { name: '继续复习 TCP' }));
    expect(screen.getByLabelText('TCP 是什么？')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '延后 1 天' }));

    await waitFor(() => expect(screen.queryByLabelText('TCP 是什么？')).not.toBeInTheDocument());
    expect(api.submitReviewSession).not.toHaveBeenCalled();
  });

  it('does not call over-budget remaining work completed', async () => {
    api.getTodayReview.mockResolvedValue({
      queue: { ...queue, items: [], totalCount: 1, remainingCount: 1, scheduledMinutes: 0 },
    });

    render(<TodayReviewPage />);

    expect(await screen.findByText('1 个知识点超出当前预算')).toBeInTheDocument();
    expect(screen.queryByText('今日复习已完成')).not.toBeInTheDocument();
  });

  it('persists a configurable daily budget between views', async () => {
    render(<TodayReviewPage />);
    const slider = await screen.findByRole('slider');

    fireEvent.change(slider, { target: { value: '45' } });

    await waitFor(() => expect(api.getTodayReview).toHaveBeenCalledWith(45));
    expect(localStorage.getItem('study-assistant.review-budget-minutes')).toBe('45');
  });
});
