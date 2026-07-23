import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type='button' onClick={() => setOpen(true)}>打开弹窗</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>测试弹窗</DialogTitle>
          <button type='button'>确认</button>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('uses modal semantics and restores trigger focus after Escape', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: '打开弹窗' });

    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: '测试弹窗' })).toHaveAttribute('aria-modal', 'true');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
