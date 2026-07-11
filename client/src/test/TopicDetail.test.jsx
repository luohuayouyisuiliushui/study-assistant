import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    exportAnkiCSV: vi.fn(() => '/api/export/anki'),
    exportOPML: vi.fn(() => '/api/export/opml'),
    exportNotionCSV: vi.fn(() => '/api/export/notion'),
    exportJSON: vi.fn(() => '/api/export/json'),
    exportStudyNotes: vi.fn(() => '/api/export/notes'),
    exportBundle: vi.fn(() => '/api/export/bundle'),
  },
}));

import api from '../api';

const sampleTopic = {
  id: 't-1',
  title: 'JavaScript 闭包',
  detail: '闭包是 JavaScript 中的一个重要概念。',
  done: false,
  level: 1,
};

const samplePlan = { id: 'plan-1', name: 'JavaScript 基础', topics: [] };

describe('TopicDetail', () => {
  const onBack = vi.fn();
  const onRefresh = vi.fn();
  const onSelectTopic = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.URL.createObjectURL = vi.fn(() => 'blob:url');
    window.URL.revokeObjectURL = vi.fn();
  });

  it('renders topic title', () => {
    render(
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={onBack}
        onRefresh={onRefresh}
        onSelectTopic={onSelectTopic}
      />
    );
    expect(screen.getByText('JavaScript 闭包')).toBeInTheDocument();
  });

  it('shows more menu with export options when detail exists', async () => {
    render(
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={onBack}
        onRefresh={onRefresh}
        onSelectTopic={onSelectTopic}
      />
    );
    const moreBtn = screen.getByTitle('更多操作');
    await userEvent.click(moreBtn);
    expect(screen.getByText('导出')).toBeInTheDocument();
    expect(screen.getByText(/Markdown/)).toBeInTheDocument();
    expect(screen.getByText(/HTML/)).toBeInTheDocument();
  });

  it('more menu renders all format options', async () => {
    render(
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={onBack}
        onRefresh={onRefresh}
        onSelectTopic={onSelectTopic}
      />
    );
    await userEvent.click(screen.getByTitle('更多操作'));
    expect(screen.getByText(/Anki CSV/)).toBeInTheDocument();
    expect(screen.getByText(/OPML 大纲/)).toBeInTheDocument();
    expect(screen.getByText(/结构化 JSON/)).toBeInTheDocument();
    expect(screen.getByText(/学习笔记/)).toBeInTheDocument();
    expect(screen.getByText(/计划数据包/)).toBeInTheDocument();
  });

  it('calls back button', async () => {
    render(
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={onBack}
        onRefresh={onRefresh}
        onSelectTopic={onSelectTopic}
      />
    );
    await userEvent.click(screen.getAllByText(/返回列表/)[0]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders interactive mode options in more menu', async () => {
    render(
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={onBack}
        onRefresh={onRefresh}
        onSelectTopic={onSelectTopic}
      />
    );
    await userEvent.click(screen.getByTitle('更多操作'));
    expect(screen.getByText(/分段讲解/)).toBeInTheDocument();
    expect(screen.getByText(/实时互动/)).toBeInTheDocument();
    expect(screen.getByText(/费曼学习法/)).toBeInTheDocument();
    expect(screen.getByText(/挑战模式/)).toBeInTheDocument();
  });

  it('renders menu groups with proper sections', async () => {
    render(
      <TopicDetail
        plan={samplePlan}
        topic={sampleTopic}
        onBack={onBack}
        onRefresh={onRefresh}
        onSelectTopic={onSelectTopic}
      />
    );
    await userEvent.click(screen.getByTitle('更多操作'));
    
    // Check group headers exist
    expect(screen.getByText('导出')).toBeInTheDocument();
    expect(screen.getByText('教学模式')).toBeInTheDocument();
    expect(screen.getByText('分析工具')).toBeInTheDocument();
    
    // Check items under export group
    expect(screen.getByText(/Markdown/)).toBeInTheDocument();
    expect(screen.getByText(/HTML/)).toBeInTheDocument();
    
    // Check items under teaching mode group
    expect(screen.getByText(/分段讲解/)).toBeInTheDocument();
    expect(screen.getByText(/实时互动/)).toBeInTheDocument();
    
    // Check items under analysis tools group
    expect(screen.getByText(/事实核查/)).toBeInTheDocument();
    expect(screen.getByText(/自适应分析/)).toBeInTheDocument();
  });
});
