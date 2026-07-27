import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KnowledgeGraphModal from '../components/KnowledgeGraphModal';

vi.mock('../api', () => ({
  default: {
    getKnowledgeGraph: vi.fn(),
    extractRelations: vi.fn(),
  },
}));

import api from '../api';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg viewBox="0 0 1200 800" width="1200" height="800"></svg>',
    }),
  },
}));

import mermaid from 'mermaid';

const samplePlan = {
  id: 'plan-1',
  name: 'JavaScript 基础',
  phases: [
    { id: 'ph-1', name: '入门', order: 0 },
  ],
  topics: [
    { id: 't-1', title: '变量', level: 1, done: true, phaseId: 'ph-1' },
    { id: 't-2', title: '函数', level: 1, done: false, phaseId: 'ph-1' },
  ],
};

const mockGraphData = {
  nodes: [
    { id: 't-1', title: '变量', phaseId: 'ph-1', done: true },
    { id: 't-2', title: '函数', phaseId: 'ph-1', done: false },
  ],
  edges: [
    { from: 't-1', to: 't-2', type: 'prerequisite', weight: 0.8, source: 'manual' },
  ],
  baseEdgeCount: 1,
  inferredCount: 0,
};

describe('KnowledgeGraphModal', () => {
  const onClose = vi.fn();
  const onSelectTopic = vi.fn();
  const onGenerate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state', () => {
    api.getKnowledgeGraph.mockReturnValue(new Promise(() => {}));
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    expect(screen.getByText('生成知识图谱...')).toBeInTheDocument();
  });

  it('shows error state', async () => {
    api.getKnowledgeGraph.mockRejectedValue(new Error('API 错误'));
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    await waitFor(() => {
      expect(screen.getByText(/API 错误/)).toBeInTheDocument();
    });
  });

  it('renders legend items', async () => {
    api.getKnowledgeGraph.mockResolvedValue({ graph: mockGraphData });
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    await waitFor(() => {
      expect(screen.getAllByText('包含').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('前置依赖').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders modal header with plan name', () => {
    api.getKnowledgeGraph.mockReturnValue(new Promise(() => {}));
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    expect(screen.getByText(/JavaScript 基础/)).toBeInTheDocument();
  });

  it('calls onClose when overlay clicked', async () => {
    api.getKnowledgeGraph.mockReturnValue(new Promise(() => {}));
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    const overlay = document.querySelector('[class*="inset-0"]');
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when modal content clicked', async () => {
    api.getKnowledgeGraph.mockReturnValue(new Promise(() => {}));
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    const modal = screen.getByRole('dialog', { name: /知识图谱/ });
    await userEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses the available viewport and fits the rendered SVG', async () => {
    api.getKnowledgeGraph.mockResolvedValue({ graph: mockGraphData });
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );

    const modal = screen.getByRole('dialog', { name: /知识图谱/ });
    expect(modal).toHaveClass('max-w-none');
    expect(modal.className).toContain('100vw');
    expect(modal.className).toContain('100vh');

    await waitFor(() => {
      const svg = screen.getByTestId('knowledge-graph-canvas').querySelector('svg');
      expect(svg).toHaveAttribute('width', '100%');
      expect(svg).toHaveAttribute('height', '100%');
      expect(svg).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet');
    });
  });

  it('renders Mermaid once after the graph data loads', async () => {
    api.getKnowledgeGraph.mockResolvedValue({ graph: mockGraphData });
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    await waitFor(() => expect(screen.getByTestId('knowledge-graph-canvas')).toBeInTheDocument());
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('offers fit, zoom, pan and layout controls', async () => {
    api.getKnowledgeGraph.mockResolvedValue({ graph: mockGraphData });
    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '适应视图' })).toBeInTheDocument());
    expect(screen.getByLabelText('图谱布局')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '放大' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '缩小' })).toBeInTheDocument();
    expect(screen.getByTestId('knowledge-graph-viewport')).toHaveClass('cursor-grab');

    await userEvent.selectOptions(screen.getByLabelText('图谱布局'), 'TB');
    await waitFor(() => {
      const definitions = mermaid.render.mock.calls.map(call => call[1]);
      expect(definitions.some(definition => definition.startsWith('flowchart TB'))).toBe(true);
    });

    await userEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByLabelText('缩放比例')).toHaveTextContent('125%');
    await userEvent.click(screen.getByRole('button', { name: '适应视图' }));
    expect(screen.getByLabelText('缩放比例')).toHaveTextContent('100%');
  });

  it('maps Mermaid node ids back to topic ids when highlighting', async () => {
    mermaid.render.mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 400 300"><g class="node" id="kg-test-flowchart-nt_1-0"><rect /></g></svg>',
    });
    api.getKnowledgeGraph.mockResolvedValue({ graph: mockGraphData });

    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );

    const node = await waitFor(() => {
      const element = screen.getByTestId('knowledge-graph-canvas').querySelector('g.node');
      expect(element).toHaveAttribute('data-topic-id', 't-1');
      return element;
    });
    await userEvent.click(node);

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(mermaid.render.mock.calls[1][1]).toContain('style nt_1 fill:#fde68a');
  });

  it('switches between the topic skeleton and all knowledge points', async () => {
    const hierarchicalGraph = {
      ...mockGraphData,
      nodes: [
        { id: 't-1', title: '变量', level: 1, phaseId: 'ph-1', done: true },
        { id: 't-2', title: '函数', level: 2, phaseId: 'ph-1', done: false },
      ],
      edges: [
        { from: 't-1', to: 't-2', type: 'parentOf', weight: 1, source: 'manual' },
      ],
    };
    api.getKnowledgeGraph.mockResolvedValue({ graph: hierarchicalGraph });

    render(
      <KnowledgeGraphModal
        plan={samplePlan}
        onClose={onClose}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    expect(mermaid.render.mock.calls[0][1]).toContain('nt_2["函数"]');

    await userEvent.selectOptions(screen.getByLabelText('图谱视图'), 'overview');
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(mermaid.render.mock.calls[1][1]).not.toContain('nt_2["函数"]');
    expect(screen.getByText('主题骨架 1/2')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('图谱视图'), 'full');
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(3));
    expect(mermaid.render.mock.calls[2][1]).toContain('nt_2["函数"]');
    expect(screen.getByText('全部 2 个知识点')).toBeInTheDocument();
  });
});
