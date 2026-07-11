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
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

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
    const modal = document.querySelector('[class*="w-\\[90vw\\]"]');
    await userEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });
});
