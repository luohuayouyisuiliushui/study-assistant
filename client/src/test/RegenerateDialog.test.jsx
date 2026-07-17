import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RegenerateDialog from '../components/RegenerateDialog';

describe('RegenerateDialog', () => {
  it('does not render while closed', () => {
    render(<RegenerateDialog open={false} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByText('重新生成讲解')).not.toBeInTheDocument();
  });

  it('submits a predefined reason', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<RegenerateDialog open onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.click(screen.getByLabelText('内容太浅，需要更深入'));
    await user.click(screen.getByRole('button', { name: '重新生成' }));

    expect(onSubmit).toHaveBeenCalledWith('内容太浅，需要更深入');
  });

  it('requires text for a custom reason and supports cancel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    render(<RegenerateDialog open onClose={onClose} onSubmit={onSubmit} />);

    await user.click(screen.getByLabelText('其他'));
    const submit = screen.getByRole('button', { name: '重新生成' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByPlaceholderText('请描述具体问题...'), '需要更多图示');
    expect(submit).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
