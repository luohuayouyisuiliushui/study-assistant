import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlanView from '../components/PlanView';

vi.mock('../api', () => ({
  default: {
    analyzePlan: vi.fn(),
    askAnalysisQuestion: vi.fn(),
    getKnowledgeGraph: vi.fn(),
    generateQuickQuiz: vi.fn(),
    analyzeWeakPoints: vi.fn(),
    getPlan: vi.fn(),
    decomposeTopic: vi.fn(),
    getCoreTopics: vi.fn(),
  },
}));

import api from '../api';

const samplePlan = {
  id: 'plan-1',
  name: 'JavaScript 基础',
  phases: [
    { id: 'ph-1', name: '入门', order: 0 },
    { id: 'ph-2', name: '进阶', order: 1 },
  ],
  topics: [
    { id: 't-1', title: '变量', level: 1, done: true, difficulty: 'easy', timeSpent: 1200, lastAccessed: Date.now(), parentId: null, order: 0, phaseId: 'ph-1' },
    { id: 't-2', title: '函数', level: 1, done: true, difficulty: 'medium', timeSpent: 2400, lastAccessed: Date.now(), parentId: null, order: 1, phaseId: 'ph-1', weakPoints: ['作用域'] },
    { id: 't-3', title: '闭包', level: 2, done: false, detail: '一些内容', timeSpent: 600, lastAccessed: Date.now(), parentId: 't-2', order: 0, phaseId: 'ph-1' },
    { id: 't-4', title: '异步', level: 1, done: false, detail: '', timeSpent: 0, lastAccessed: null, parentId: null, order: 2, phaseId: 'ph-2' },
  ],
  history: [
    { topicId: 't-2', role: 'user', content: '问了一个问题' },
  ],
};

describe('PlanView', () => {
  const onAddTopics = vi.fn();
  const onRemoveTopic = vi.fn();
  const onSelectTopic = vi.fn();
  const onGenerate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders plan name and progress', () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    expect(screen.getByText(/JavaScript 基础/)).toBeInTheDocument();
    expect(screen.getByText('2/4 已完成')).toBeInTheDocument();
  });

  it('renders learning stats', () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    // totalTime = 1200+2400+600+0 = 4200s => 1.2小时
    expect(screen.getByText(/1\.2小时/)).toBeInTheDocument();
    expect(screen.getByText(/待复习/)).toBeInTheDocument();
  });

  it('renders topic sections', () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    // 未开始 section
    expect(screen.getByText(/未开始（1）/) || screen.getByText(/未开始（0）/)).toBeInTheDocument();
    // 学习中 section
    expect(screen.getByText(/学习中（1）/)).toBeInTheDocument();
    // 已学习 section (multiple elements match, use getAllByText)
    const doneLabels = screen.getAllByText(/已学习/);
    expect(doneLabels.length).toBeGreaterThanOrEqual(1);
  });

  it('renders action buttons', async () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    expect(screen.getByText(/学习分析/)).toBeInTheDocument();
    // remaining actions are in the "more" dropdown
    const moreBtn = screen.getByTitle('更多操作');
    await userEvent.click(moreBtn);
    expect(screen.getByText(/知识图谱/)).toBeInTheDocument();
    expect(screen.getByText(/快速测验/)).toBeInTheDocument();
    expect(screen.getByText(/核心20%/)).toBeInTheDocument();
    expect(screen.getByText(/薄弱分析/)).toBeInTheDocument();
  });

  it('renders phase group headers', () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    expect(screen.getByText('入门')).toBeInTheDocument();
    expect(screen.getByText('进阶')).toBeInTheDocument();
  });

  it('shows weak point badge on topics with weak points', () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    // t-2 (函数) has weak points and is done → should have weak badge
    const badge = screen.getByTitle(/薄弱.*作用域/);
    expect(badge).toBeInTheDocument();
    expect(badge.tagName).toBe('SPAN');
  });

  it('renders hint text in add section', () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    expect(screen.getByText(/每行列一个知识点名称/)).toBeInTheDocument();
  });

  it('opens and closes core analysis panel', async () => {
    api.getCoreTopics.mockResolvedValue({
      corePrinciple: '核心原则',
      summary: '总结',
      coreTopics: [{ title: '变量', reasons: ['基础'], coverage: '入门' }],
    });
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    const moreBtn = screen.getByTitle('更多操作');
    await userEvent.click(moreBtn);
    const coreBtn = screen.getByText(/核心20%/);
    await userEvent.click(coreBtn);
    await waitFor(() => {
      expect(screen.getByText(/核心 20% 分析/)).toBeInTheDocument();
    });
  });

  it('adds topics from bulk input', async () => {
    render(
      <PlanView
        plan={samplePlan}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    const textarea = screen.getByPlaceholderText(/逐条输入知识点/);
    await userEvent.type(textarea, '新知识点1\n新知识点2');
    const addBtn = screen.getByText('添加');
    await userEvent.click(addBtn);
    expect(onAddTopics).toHaveBeenCalledWith(['新知识点1', '新知识点2']);
  });

  it('shows loading when plan is null', () => {
    render(
      <PlanView
        plan={null}
        onAddTopics={onAddTopics}
        onRemoveTopic={onRemoveTopic}
        onSelectTopic={onSelectTopic}
        onGenerate={onGenerate}
      />
    );
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });
});
