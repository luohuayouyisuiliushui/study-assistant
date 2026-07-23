import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ExamPaperModal from '../components/ExamPaperModal';

vi.mock('../api', () => ({
  default: {
    listExams: vi.fn(),
    createAttemptRef: vi.fn(() => 'exam-attempt-fixed'),
    submitExam: vi.fn(),
    deleteExam: vi.fn(),
    generateExam: vi.fn(),
    generateExamStream: vi.fn(),
    practiceExam: vi.fn(),
  },
}));

import api from '../api';

const exam = {
  id: 'exam-1',
  title: 'Retry Exam',
  createdAt: 1_700_000_000_000,
  config: { topicIds: ['topic-1'] },
  paper: '',
  results: null,
  questions: [{
    id: 'question-1',
    index: 0,
    type: 'choice',
    question: 'Pick one',
    options: ['A. One', 'B. Two'],
    answer: 'A',
    difficulty: 'easy',
    conceptTag: 'Basics',
  }],
};

const plan = {
  id: 'plan-1',
  phases: [],
  topics: [{ id: 'topic-1', title: 'Basics', detail: 'Detail', done: true }],
};

describe('ExamPaperModal mastery attempts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listExams.mockResolvedValue({ exams: [exam] });
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('reuses the same attemptRef after a failed exam submission', async () => {
    api.submitExam
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        results: [{ exerciseIndex: 0, correct: true, correctAnswer: 'A', userAnswer: 'A' }],
      });
    render(<ExamPaperModal plan={plan} onClose={vi.fn()} />);

    await userEvent.click(screen.getByTitle('历史试卷'));
    await waitFor(() => expect(screen.getByText('Retry Exam')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Retry Exam'));
    await userEvent.click(screen.getByText('A. One'));
    await userEvent.click(screen.getByRole('button', { name: '提交批改' }));
    await waitFor(() => expect(api.submitExam).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: '提交批改' }));

    await waitFor(() => expect(api.submitExam).toHaveBeenCalledTimes(2));
    expect(api.createAttemptRef).toHaveBeenCalledTimes(1);
    expect(api.submitExam.mock.calls[0][3]).toBe('exam-attempt-fixed');
    expect(api.submitExam.mock.calls[1][3]).toBe('exam-attempt-fixed');
  });
});
