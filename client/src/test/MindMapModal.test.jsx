import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MindMapModal from '../components/MindMapModal';
import { buildTree, treeToJson, treeToMarkdown, treeToOpml } from '../lib/mind-map-export';

const markmap = {
  destroy: vi.fn(),
  fit: vi.fn(),
};

vi.mock('markmap-lib', () => ({
  Transformer: class Transformer {
    transform() {
      return { root: { content: 'root', children: [] } };
    }
  },
}));

vi.mock('markmap-view', () => ({
  Markmap: { create: vi.fn(() => markmap) },
}));

const plan = {
  id: 'plan-1',
  name: '前端 / 基础',
  phases: [{ id: 'phase-1', name: '入门', order: 0 }],
  topics: [
    { id: 'topic-1', title: 'HTML', phaseId: 'phase-1', order: 0, done: true },
    { id: 'topic-2', title: 'CSS & 布局', parentId: 'topic-1', order: 1, done: false },
  ],
};

describe('MindMapModal', () => {
  let originalCreateObjectURL;
  let originalRevokeObjectURL;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mind-map');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it('builds truthful Markdown and OPML exports', () => {
    const tree = buildTree(plan);
    expect(treeToMarkdown(tree)).toContain('CSS & 布局');
    const opml = treeToOpml(plan.name, tree);
    expect(opml).toContain('<opml version="2.0">');
    expect(opml).toContain('CSS &amp; 布局');
    expect(treeToJson(tree)[0]).not.toHaveProperty('detail');
  });

  it('offers Markdown, SVG, PNG, JSON and OPML formats', async () => {
    render(<MindMapModal plan={plan} onClose={vi.fn()} onSelectTopic={vi.fn()} />);
    const format = screen.getByLabelText('导出格式');
    expect([...format.options].map(option => option.textContent)).toEqual([
      'Markdown', 'SVG', 'PNG', 'JSON', 'OPML',
    ]);
    expect(screen.queryByText(/XMind/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '适应视图' })).toBeInTheDocument());
  });

  it('downloads the selected structured format with the right name and MIME type', async () => {
    render(<MindMapModal plan={plan} onClose={vi.fn()} onSelectTopic={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('导出格式'), 'opml');
    await userEvent.click(screen.getByRole('button', { name: '导出思维导图' }));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL.mock.calls[0][0].type).toBe('text/x-opml;charset=utf-8');
    const anchor = HTMLAnchorElement.prototype.click.mock.instances[0];
    expect(anchor.download).toBe('前端___基础.思维导图.opml');
  });
});
