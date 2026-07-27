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

  it('normalizes quoted state names before rendering a state diagram', async () => {
    const source = [
      'stateDiagram-v2',
      '    [*] --> "运行中"',
      '    "运行中" --> "可连接线程已结束": "线程函数 return 或 pthread_exit()"',
      '    "运行中" --> "分离线程已结束": "线程函数 return 或 pthread_exit()"',
      '    "可连接线程已结束" --> [*]: "pthread_join() 回收"',
      '    "分离线程已结束" --> [*]: "内核自动回收"',
    ].join('\n');

    mermaidMocks.render.mockImplementation(async (_id, normalizedSource) => {
      if (/^\s*\[\*\]\s*-->\s*"/m.test(normalizedSource)) {
        throw new Error('Parse error on line 2: Expecting ID, got STRING');
      }
      return { svg: '<svg aria-label="state diagram"></svg>' };
    });

    const { container } = render(<MermaidDiagram code={source} />);

    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument());
    const normalizedSource = mermaidMocks.render.mock.calls[0][1];
    expect(normalizedSource).toContain('state "运行中" as mermaid_state_1');
    expect(normalizedSource).toContain('state "可连接线程已结束" as mermaid_state_2');
    expect(normalizedSource).toContain('state "分离线程已结束" as mermaid_state_3');
    expect(normalizedSource).toContain('[*] --> mermaid_state_1');
    expect(normalizedSource).not.toContain('--> "运行中"');
  });
});
