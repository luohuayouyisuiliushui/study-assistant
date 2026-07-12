import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ExercisePanel from '../components/ExercisePanel';

const exercises = [
  {
    type: 'choice',
    question: '1 + 1 = ?',
    options: ['A. 1', 'B. 2', 'C. 3', 'D. 4'],
    conceptTag: '数学',
  },
  {
    type: 'open',
    question: '请解释闭包是什么？',
    options: [],
    conceptTag: 'JavaScript',
  },
];

const defaultProps = {
  exercises,
  answers: {},
  onAnswer: vi.fn(),
  onSubmit: vi.fn(),
  loading: false,
  submitted: false,
  results: null,
};

describe('ExercisePanel', () => {
  it('renders questions', () => {
    render(<ExercisePanel {...defaultProps} />);
    expect(screen.getByText('1 + 1 = ?')).toBeDefined();
    expect(screen.getByText('请解释闭包是什么？')).toBeDefined();
  });

  it('renders choice labels', () => {
    render(<ExercisePanel {...defaultProps} />);
    expect(screen.getByText('选择题')).toBeDefined();
    expect(screen.getByText('简答题')).toBeDefined();
  });

  it('renders concept tags', () => {
    render(<ExercisePanel {...defaultProps} />);
    expect(screen.getByText('数学')).toBeDefined();
    expect(screen.getByText('JavaScript')).toBeDefined();
  });

  it('shows submit button disabled when no answers', () => {
    render(<ExercisePanel {...defaultProps} />);
    const btn = screen.getByText('提交答案');
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(true);
  });

  it('shows loading state on submit button', () => {
    render(<ExercisePanel {...defaultProps} loading={true} answers={{ 0: 'B' }} />);
    expect(screen.getByText('批改中...')).toBeDefined();
  });

  it('shows results when submitted', () => {
    render(<ExercisePanel {...defaultProps}
      submitted={true}
      results={[{ correct: true, explanation: '正确！' }, { correct: false, explanation: '请复习闭包概念' }]}
    />);
    expect(screen.getByText('✅')).toBeDefined();
    expect(screen.getByText('❌')).toBeDefined();
    expect(screen.getByText('正确！')).toBeDefined();
    expect(screen.getByText('练习结果')).toBeDefined();
  });

  it('calls onAnswer when selecting a choice', () => {
    const onAnswer = vi.fn();
    render(<ExercisePanel {...defaultProps} onAnswer={onAnswer} />);
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);
    expect(onAnswer).toHaveBeenCalledWith(0, 'A');
  });

  it('renders nothing with empty exercises', () => {
    const { container } = render(<ExercisePanel {...defaultProps} exercises={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
