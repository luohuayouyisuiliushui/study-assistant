import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlanList from '../components/PlanList';

vi.mock('../components/TodayReview', () => ({ default: () => null }));
vi.mock('../api', () => ({
  default: {
    listTrash: vi.fn().mockResolvedValue({ plans: [] }),
  },
}));

describe('PlanList', () => {
  it('imports an exported JSON bundle from the file picker', async () => {
    const onImportBundle = vi.fn().mockResolvedValue({ success: true });
    const user = userEvent.setup();
    const { container } = render(
      <PlanList
        plans={[]}
        onCreate={vi.fn()}
        onImport={vi.fn()}
        onImportBundle={onImportBundle}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    await user.click(screen.getByRole('tab', { name: 'AI 导入' }));
    const input = container.querySelector('input[accept=".json,application/json"]');
    const file = new File([JSON.stringify({ plan: { name: '恢复的计划' }, topics: [] })], 'bundle.json', {
      type: 'application/json',
    });
    await user.upload(input, file);

    await waitFor(() => expect(onImportBundle).toHaveBeenCalledWith({ plan: { name: '恢复的计划' }, topics: [] }));
  });
});
