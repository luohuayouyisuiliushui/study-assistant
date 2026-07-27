import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserProfile from '../pages/UserProfile';

vi.mock('../api', () => ({
  default: {
    getUserProfileSummary: vi.fn(),
    getUserProfile: vi.fn(),
    analyzeUserProfile: vi.fn(),
  },
}));

import api from '../api';

const mockSummary = {
  hasData: true,
  hasAIAnalysis: true,
  lastAnalyzedAt: Date.now(),
  stats: {
    totalPlans: 3,
    totalTopics: 42,
    overallCompletionRate: 65,
    totalTimeSeconds: 12893,
    totalQuestions: 128,
  },
  exerciseStats: { total: 20, rate: 75 },
  planSummaries: [
    { id: 'p1', name: 'JavaScript', completionRate: 80, doneCount: 10, topicCount: 12 },
    { id: 'p2', name: 'Python', completionRate: 50, doneCount: 5, topicCount: 10 },
  ],
  weakPointsSummary: [
    { name: '闭包', count: 2 },
    { name: '异步', count: 1 },
  ],
  modeCounts: { stepwise: 5, challenge: 3, scaffold: 2 },
  feynmanStats: {
    sessionCount: 4,
    teachingQualities: ['excellent', 'good', 'fair', 'excellent'],
    sparklingCount: 2,
    lingeringCount: 1,
  },
  timeDistribution: {
    last7Days: [
      { date: '2026-07-21', seconds: 1720 },
      { date: '2026-07-22', seconds: 0 },
    ],
    summary: {
      totalTimeSeconds: 12893,
      timeLast7Days: 1720,
      timeLast30Days: 12773,
      activeDays: 7,
      avgPerDaySeconds: 1842,
      peakDay: { date: '2026-07-12', seconds: 8652 },
    },
  },
};

const mockProfile = {
  learnerPersona: {
    type: ['分析型', '视觉型'],
    summary: '你是一个喜欢深入理解原理的学习者。',
    confidence: 0.78,
    evidenceFromBehavior: '在 12 个问题中，有 6 次属于原理探究型提问',
  },
  strengths: [
    { domain: '编程基础', masteryLevel: 0.85, topics: ['变量', '函数'] },
  ],
  weaknesses: [
    {
      domain: '高级概念', masteryLevel: 0.35, topics: ['闭包', '原型链'],
      suggestedAction: '多做一些实际项目练习',
    },
  ],
  learningPatterns: {
    questionStyle: '深入型',
    avgQuestionsPerTopic: 3.2,
    timeDistribution: '晚间活跃',
  },
  recommendations: ['建议每天固定时间学习', '多使用费曼学习法'],
  aiAnalysis: '## 分析报告\n\n这是一个全面的分析。',
};

describe('UserProfile', () => {
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    api.getUserProfileSummary.mockReturnValue(new Promise(() => {}));
    render(<UserProfile onBack={onBack} />);
    expect(screen.getByText('加载画像数据...')).toBeInTheDocument();
  });

  it('shows empty state when no data', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: { hasData: false } });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText(/还没有学习计划数据/)).toBeInTheDocument();
    });
  });

  it('renders cross-plan overview stats', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('65%')).toBeInTheDocument();
    });
  });

  it('renders empty state when fetch fails', async () => {
    api.getUserProfileSummary.mockRejectedValue(new Error('网络错误'));
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText(/还没有学习计划数据/)).toBeInTheDocument();
    });
  });

  it('renders learner persona section', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('分析型')).toBeInTheDocument();
      expect(screen.getByText('视觉型')).toBeInTheDocument();
    });
  });

  it('renders strengths and weaknesses', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('强项')).toBeInTheDocument();
      expect(screen.getByText('编程基础')).toBeInTheDocument();
    });
  });

  it('renders weak points summary tags', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('闭包')).toBeInTheDocument();
      expect(screen.getByText('异步')).toBeInTheDocument();
    });
  });

  it('renders learning patterns', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('深入型')).toBeInTheDocument();
      expect(screen.getByText(/7 个活跃日/)).toBeInTheDocument();
    });
  });

  it('uses readable Chinese durations without exposing raw seconds', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('3 小时 35 分钟')).toBeInTheDocument();
      expect(screen.getByText('29 分钟')).toBeInTheDocument();
    });
    expect(screen.queryByText(/12893 秒|1720 秒|8652 秒/)).not.toBeInTheDocument();
  });

  it('replaces model diagnostics and unsupported time-of-day claims with evidence-based copy', async () => {
    const placeholderProfile = {
      ...mockProfile,
      learningPatterns: {
        ...mockProfile.learningPatterns,
        questionStyle: '未提供可用于识别具体提问风格的文本或分类数据。',
        timeDistribution: '累计学习 12893 秒，晚间更活跃。',
      },
    };
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: placeholderProfile });
    render(<UserProfile onBack={onBack} />);

    await waitFor(() => expect(screen.getByText('提问样本不足')).toBeInTheDocument());
    expect(screen.queryByText(/未提供可用于识别/)).not.toBeInTheDocument();
    expect(screen.queryByText(/晚间更活跃/)).not.toBeInTheDocument();
    expect(screen.getByText(/7 个活跃日/)).toBeInTheDocument();
  });

  it('shows persona confidence and behavioral evidence', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('画像可信度 78%')).toBeInTheDocument();
      expect(screen.getByText(/在 12 个问题中/)).toBeInTheDocument();
    });
  });

  it('renders feynman stats', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('4 次')).toBeInTheDocument();
    });
  });

  it('renders recommendations list', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText(/建议每天固定时间学习/)).toBeInTheDocument();
    });
  });

  it('toggle full analysis report on click', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText('完整分析报告')).toBeInTheDocument();
    });
    const toggle = screen.getByText('完整分析报告');
    await userEvent.click(toggle);
    expect(screen.getAllByText(/分析报告/).length).toBeGreaterThanOrEqual(2);
  });

  it('calls onBack when back button clicked', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText(/返回/)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText(/返回/));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('render analyzing loading state', async () => {
    api.getUserProfileSummary.mockResolvedValue({ summary: mockSummary });
    api.getUserProfile.mockResolvedValue({ profile: mockProfile });
    api.analyzeUserProfile.mockReturnValue(new Promise(() => {}));
    render(<UserProfile onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByText(/重新分析/)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText(/重新分析/));
    expect(screen.getByText(/AI 正在跨计划分析/)).toBeInTheDocument();
  });
});
