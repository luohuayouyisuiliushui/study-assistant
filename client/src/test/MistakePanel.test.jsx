import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MistakePanel from '../components/MistakePanel';

vi.mock('../api', () => ({
  default: {
    dismissMistake: vi.fn(),
  },
}));

import api from '../api';

const NOW = Date.UTC(2026, 6, 22, 12, 34);

function mistake(id, overrides = {}) {
  return {
    id,
    conceptLabel: `Concept ${id}`,
    status: 'open',
    severity: 'medium',
    occurrenceCount: 1,
    lastSeenAt: NOW,
    verificationDueAt: null,
    evidenceIds: [`internal-evidence-${id}`],
    ...overrides,
  };
}

function renderPanel(props = {}) {
  return render(
    <MistakePanel
      planId="plan-1"
      topicId="topic-1"
      mistakes={[mistake('one')]}
      now={NOW}
      {...props}
    />
  );
}

describe('MistakePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders long concepts, recurrence, severity, exact waiting time, and safe unknown states', () => {
    const verificationDueAt = NOW + 86_400_000;
    const expectedAbsoluteTime = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(verificationDueAt));
    const longLabel = '一个需要在窄屏完整换行且不能覆盖操作按钮的 VeryLongMistakeConceptLabel';

    renderPanel({
      mistakes: [
        mistake('open', {
          conceptLabel: longLabel,
          severity: 'high',
          occurrenceCount: 3,
        }),
        mistake('waiting', {
          status: 'repairing',
          verificationDueAt,
        }),
        mistake('verified', { status: 'verified', severity: 'low' }),
        mistake('unknown', { status: 'future-status', severity: 'future-severity' }),
      ],
    });

    expect(screen.getByText(longLabel)).toBeInTheDocument();
    expect(screen.getByText('复发 2 次')).toBeInTheDocument();
    expect(screen.getByText('高优先级')).toBeInTheDocument();
    // Relative countdown is shown as main label; absolute time is in the tooltip
    expect(screen.getByText('还需 24h 0m')).toBeInTheDocument();
    expect(screen.getByTitle(`验证时间：${expectedAbsoluteTime}`)).toBeInTheDocument();
    expect(screen.getByText('已通过延迟验证')).toBeInTheDocument();
    expect(screen.getByText('记录状态异常，请刷新后重试')).toBeInTheDocument();
    expect(screen.queryByText(/internal-evidence/)).not.toBeInTheDocument();
  });

  it('starts repair at open and exact due boundaries but disables future verification', () => {
    const onRepair = vi.fn();
    renderPanel({
      onRepair,
      mistakes: [
        mistake('open'),
        mistake('due', { status: 'repairing', verificationDueAt: NOW }),
        mistake('future', { status: 'repairing', verificationDueAt: NOW + 1 }),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '修复' }));
    fireEvent.click(screen.getByRole('button', { name: '开始验证' }));
    expect(onRepair).toHaveBeenNthCalledWith(1, 'open');
    expect(onRepair).toHaveBeenNthCalledWith(2, 'due');
    expect(screen.getByRole('button', { name: '等待验证' })).toBeDisabled();
  });

  it('requires confirmation and accepts trimmed 1 and 200 character reasons', async () => {
    const onChanged = vi.fn();
    api.dismissMistake.mockImplementation(async (_planId, _topicId, id, reason) => ({
      mistake: { id, status: 'dismissed', dismissReason: reason },
    }));
    renderPanel({
      onChanged,
      mistakes: [mistake('one'), mistake('two', { lastSeenAt: NOW - 1 })],
    });

    const list = screen.getByRole('list', { name: '错题修复列表' });
    fireEvent.click(within(list).getAllByRole('button', { name: '忽略' })[0]);
    expect(screen.getByRole('dialog', { name: '确认忽略错题' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认忽略' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(api.dismissMistake).not.toHaveBeenCalled();

    fireEvent.click(within(list).getAllByRole('button', { name: '忽略' })[0]);
    fireEvent.change(screen.getByLabelText('忽略原因'), { target: { value: ' x ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认忽略' }));
    await waitFor(() => expect(api.dismissMistake).toHaveBeenCalledWith(
      'plan-1', 'topic-1', 'one', 'x'
    ));

    const remainingList = screen.getByRole('list', { name: '错题修复列表' });
    fireEvent.click(within(remainingList).getByRole('button', { name: '忽略' }));
    const maxReason = 'a'.repeat(200);
    fireEvent.change(screen.getByLabelText('忽略原因'), { target: { value: maxReason } });
    expect(screen.getByText('200/200')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认忽略' }));
    await waitFor(() => expect(api.dismissMistake).toHaveBeenLastCalledWith(
      'plan-1', 'topic-1', 'two', maxReason
    ));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('keeps the reason and dialog available after a dismiss failure', async () => {
    api.dismissMistake.mockRejectedValue(new Error('conflict'));
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    fireEvent.change(screen.getByLabelText('忽略原因'), { target: { value: '保留这个输入' } });
    fireEvent.click(screen.getByRole('button', { name: '确认忽略' }));

    expect(await screen.findByText('conflict')).toBeInTheDocument();
    expect(screen.getByLabelText('忽略原因')).toHaveValue('保留这个输入');
    expect(screen.getByRole('dialog', { name: '确认忽略错题' })).toBeInTheDocument();
  });
});
