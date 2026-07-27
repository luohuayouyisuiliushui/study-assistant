import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MermaidDiagram from '../components/MermaidDiagram.jsx';

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

  it('normalizes quoted state names before rendering', async () => {
    const source = [
      'stateDiagram-v2',
      '    [*] --> "运行中"',
      '    "运行中" --> "可连接线程已结束": "线程函数 return 或 pthread_exit()"',
      '    "运行中" --> "分离线程已结束": "线程函数 return 或 pthread_exit()"',
      '    "可连接线程已结束" --> [*]: "pthread_join() 回收"',
      '    "分离线程已结束" --> [*]: "内核自动回收"',
    ].join('\n');
    mermaidMocks.render.mockResolvedValue({ svg: '<svg aria-label="state diagram"></svg>' });

    const { container } = render(<MermaidDiagram code={source} />);

    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument());
    const normalizedSource = mermaidMocks.render.mock.calls[0][1];
    expect(normalizedSource).toContain('state "运行中" as mermaid_state_1');
    expect(normalizedSource).toContain('[*] --> mermaid_state_1');
    expect(normalizedSource).not.toContain('--> "运行中"');
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(expect.objectContaining({
      state: { nodeSpacing: 70, rankSpacing: 70 },
    }));
  });

  it('allows a failed diagram to be retried', async () => {
    mermaidMocks.render
      .mockRejectedValueOnce(new Error('Parse error on line 6'))
      .mockResolvedValueOnce({ svg: '<svg aria-label="diagram"></svg>' });

    const { container } = render(<MermaidDiagram code={'flowchart TD\nA --> B'} />);

    expect(await screen.findByText('图表渲染失败')).toBeInTheDocument();
    await screen.getByRole('button', { name: '重试' }).click();
    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument());
    expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
  });

  it('opens the rendered diagram in the full-screen viewer', async () => {
    mermaidMocks.render.mockResolvedValue({ svg: '<svg aria-label="diagram"></svg>' });
    render(<MermaidDiagram code={'flowchart TD\nA --> B'} />);

    await screen.findByRole('button', { name: '全屏查看：Mermaid 图表' });
    await screen.getByRole('button', { name: '全屏查看：Mermaid 图表' }).click();

    expect(screen.getByRole('dialog', { name: 'Mermaid 图表 全屏预览' })).toBeInTheDocument();
  });

  it('renders updated source only after the manual rerender button is clicked', async () => {
    const user = userEvent.setup();
    mermaidMocks.render.mockResolvedValue({ svg: '<svg aria-label="diagram"></svg>' });
    const { rerender } = render(<MermaidDiagram code={'flowchart TD\nA --> B'} />);

    await screen.findByRole('button', { name: '全屏查看：Mermaid 图表' });
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);

    rerender(<MermaidDiagram code={'flowchart TD\nA --> C'} />);

    const rerenderButton = await screen.findByRole('button', {
      name: '重新渲染图表（内容已更新）',
    });
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '全屏查看：Mermaid 图表' }));
    await user.click(screen.getByRole('button', { name: '编辑图表源码' }));
    expect(screen.getByRole('textbox', { name: 'Mermaid 源代码' })).toHaveValue('flowchart TD\nA --> B');
    await user.click(screen.getByRole('button', { name: '关闭' }));

    await user.click(rerenderButton);
    await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledTimes(2));
    expect(mermaidMocks.render.mock.calls[1][1]).toContain('A --> C');
  });

  it('renders only once when mounted under StrictMode', async () => {
    mermaidMocks.render.mockResolvedValue({ svg: '<svg aria-label="strict diagram"></svg>' });

    render(
      <StrictMode>
        <MermaidDiagram code={'flowchart TD\nA --> B'} />
      </StrictMode>
    );

    await screen.findByLabelText('strict diagram');
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
  });
});
