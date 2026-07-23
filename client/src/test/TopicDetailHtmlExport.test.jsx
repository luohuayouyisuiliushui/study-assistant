import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TopicDetail from '../components/TopicDetail';

vi.mock('../api', () => ({
  default: {
    generateDetail: vi.fn(() => Promise.resolve()),
    generateTopicImage: vi.fn(() => Promise.resolve({ imageUrl: '/images/test.png' })),
    askQuestion: vi.fn(),
    recordTime: vi.fn(),
    updateTopic: vi.fn(),
    revealErrors: vi.fn(),
    factCheck: vi.fn(),
    autoFixFacts: vi.fn(),
    reviewErrors: vi.fn(),
    inferRelations: vi.fn(() => Promise.resolve()),
    getPlan: vi.fn(() => Promise.resolve({ plan: { id: 'plan-1', name: 'JavaScript 基础', topics: [] } })),
    exportAnkiCSV: vi.fn(),
    exportOPML: vi.fn(),
    exportNotionCSV: vi.fn(),
    exportJSON: vi.fn(),
    exportStudyNotes: vi.fn(),
    exportHTML: vi.fn(() => '/api/export/plans/plan-1/export/html/t-1'),
    exportBundle: vi.fn(),
    startInteractiveSSE: vi.fn(() => Promise.resolve()),
    continueInteractiveSSE: vi.fn(() => Promise.resolve()),
    generateReview: vi.fn(() => Promise.resolve({ review: '复习内容' })),
    submitFeedback: vi.fn(() => Promise.resolve()),
    submitExercises: vi.fn(),
    adaptiveAnalysis: vi.fn(),
    recommendResources: vi.fn(),
    analyzeFeynmanSession: vi.fn(),
    clearInteractiveSession: vi.fn(),
  },
}));

vi.mock('#/lib/settings-storage', () => ({
  loadSettings: vi.fn(() => ({ apiKey: 'test-key', imageApiKey: 'test-image-key' })),
}));

vi.mock('../components/AIStatus', () => ({
  default: () => null,
  useAIStatus: () => ({ connected: null, checking: true }),
}));

const topic = {
  id: 't-1',
  title: 'JavaScript 闭包',
  detail: '闭包是 JavaScript 中的一个重要概念。',
  done: false,
  level: 1,
};
const plan = { id: 'plan-1', name: 'JavaScript 基础', topics: [topic] };

function renderTopicDetail() {
  return render(
    <MemoryRouter>
      <TopicDetail
        plan={plan}
        topic={topic}
        onBack={vi.fn()}
        onRefresh={vi.fn()}
        onSelectTopic={vi.fn()}
      />
    </MemoryRouter>
  );
}

describe('TopicDetail HTML export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the canonical server-side HTML download URL', async () => {
    renderTopicDetail();
    fireEvent.click(screen.getByTitle('更多操作'));
    fireEvent.click(screen.getByRole('menuitem', { name: /HTML \(.html\)/ }));

    const { default: api } = await import('../api');
    expect(api.exportHTML).toHaveBeenCalledWith('plan-1', 't-1');
    expect(window.open).toHaveBeenCalledWith('/api/export/plans/plan-1/export/html/t-1', '_blank');
  });
});
