import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import InteractivePanel from '../components/InteractivePanel';

const defaultProps = {
  interactiveMode: 'stepwise',
  interactiveSections: [{ content: '第一部分的讲解内容' }],
  streamingContent: '',
  interactiveLoading: false,
  interactiveFinished: false,
  interactiveInput: '',
  interactiveStateMachine: null,
  isRecording: false,
  voiceSupported: true,
  onInputChange: vi.fn(),
  onQuickAction: vi.fn(),
  onSendFeedback: vi.fn(),
  onVoiceInput: vi.fn(),
  onExit: vi.fn(),
  onRegenerate: vi.fn(),
};

describe('InteractivePanel', () => {
  it('renders the mode label for stepwise', () => {
    render(<InteractivePanel {...defaultProps} />);
    expect(screen.getByText('分段讲解')).toBeDefined();
  });

  it('renders the mode label for feynman', () => {
    render(<InteractivePanel {...defaultProps} interactiveMode="feynman" />);
    expect(screen.getByText('费曼学习法')).toBeDefined();
  });

  it('renders sections with content', () => {
    render(<InteractivePanel {...defaultProps} />);
    expect(screen.getByText('第一部分的讲解内容')).toBeDefined();
  });

  it('shows loading state', () => {
    render(<InteractivePanel {...defaultProps} interactiveLoading={true} interactiveSections={[]} />);
    const elements = screen.getAllByText('导师正在思考...');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows finished state', () => {
    render(<InteractivePanel {...defaultProps} interactiveFinished={true} />);
    expect(screen.getByText('讲解完成')).toBeDefined();
  });

  it('renders quick action buttons', () => {
    render(<InteractivePanel {...defaultProps} interactiveMode="realtime" />);
    expect(screen.getByText('继续')).toBeDefined();
    expect(screen.getByText('不太懂')).toBeDefined();
  });

  it('renders step counter for stepwise mode with state machine', () => {
    render(<InteractivePanel {...defaultProps} interactiveStateMachine={{ completedSteps: 3 }} />);
    expect(screen.getByText('已完成 3 部分')).toBeDefined();
  });

  it('renders streaming content', () => {
    render(<InteractivePanel {...defaultProps} interactiveSections={[]} streamingContent="正在流式输出的内容" />);
    expect(screen.getByText('正在流式输出的内容')).toBeDefined();
  });
});
