import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MermaidDiagram from '../components/MermaidDiagram';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}));

describe('MermaidDiagram', () => {
  beforeEach(() => {
    mermaidMocks.initialize.mockReset();
    mermaidMocks.render.mockReset();
    vi.stubGlobal('IntersectionObserver', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders again after the user retries a failed diagram', async () => {
    mermaidMocks.render
      .mockRejectedValueOnce(new Error('Parse error on line 6'))
      .mockResolvedValueOnce({ svg: '<svg aria-label="diagram"></svg>' });

    const user = userEvent.setup();
    const { container } = render(
      <MermaidDiagram code={'flowchart TD\nA --> B'} />
    );

    expect(await screen.findByText('图表渲染失败')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument());
  });
});
