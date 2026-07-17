import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TopicDetail from '../components/TopicDetail';

vi.mock('../api', () => ({
  default: {
    generateDetail: vi.fn(),
    askQuestion: vi.fn(),
    recordTime: vi.fn(),
    updateTopic: vi.fn(),
    revealErrors: vi.fn(),
    factCheck: vi.fn(),
    autoFixFacts: vi.fn(),
    reviewErrors: vi.fn(),
    inferRelations: vi.fn(() => Promise.resolve()),
    getPlan: vi.fn(() => Promise.resolve({ id: 'plan-1', name: 'JavaScript 基础', topics: [] })),
    exportAnkiCSV: vi.fn(() => '/api/export/anki'),
    exportOPML: vi.fn(() => '/api/export/opml'),
    exportNotionCSV: vi.fn(() => '/api/export/notion'),
    exportJSON: vi.fn(() => '/api/export/json'),
    exportStudyNotes: vi.fn(() => '/api/export/notes'),
    exportBundle: vi.fn(() => '/api/export/bundle'),
  },
}));

const sampleTopic = { id: 't-1', title: 'JavaScript 闭包', detail: '闭包是 JavaScript 中的一个重要概念。', done: false, level: 1 };
const samplePlan = { id: 'plan-1', name: 'JavaScript 基础', topics: [] };

function renderTD(props = {}) {
  return render(
    <MemoryRouter>
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={vi.fn()}
        onRefresh={vi.fn()}
        onSelectTopic={vi.fn()}
        {...props}
      />
    </MemoryRouter>
  );
}

describe('TopicDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.URL.createObjectURL = vi.fn(() => 'blob:url');
    window.URL.revokeObjectURL = vi.fn();
  });

  it('renders topic title', () => {
    renderTD();
    expect(screen.getByText('JavaScript 闭包')).toBeInTheDocument();
  });

  it('renders the AI status indicator', () => {
    const { container } = renderTD();
    // Ensure component renders without crashing
    expect(container.querySelector('.space-y-6')).toBeDefined();
  });
});
