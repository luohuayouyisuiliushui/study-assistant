import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../api';
import { useTopicLearningWorkspace } from '../hooks/useTopicLearningWorkspace.js';

vi.mock('../api', () => ({
  default: {
    generateDetail: vi.fn(() => Promise.resolve({ status: 'generating' })),
    getPlan: vi.fn(),
    recordTime: vi.fn(() => Promise.resolve()),
    generateReview: vi.fn(),
    submitExercises: vi.fn(),
    startInteractiveSSE: vi.fn(),
    continueInteractiveSSE: vi.fn(),
    clearInteractiveSession: vi.fn(() => Promise.resolve()),
    analyzeFeynmanSession: vi.fn(),
    revealErrors: vi.fn(),
    updateTopic: vi.fn(),
    submitFeedback: vi.fn(() => Promise.resolve()),
    askQuestion: vi.fn(),
    factCheck: vi.fn(),
    autoFixFacts: vi.fn(),
    adaptiveAnalysis: vi.fn(),
    recommendResources: vi.fn(),
    generateTopicImage: vi.fn(),
    inferRelations: vi.fn(() => Promise.resolve()),
  },
}));

function readyPlan(topicOverrides = {}) {
  const topic = {
    id: 'topic-1',
    title: 'TCP',
    detail: 'ready detail',
    done: true,
    ...topicOverrides,
  };
  return {
    topic,
    plan: { id: 'plan-1', relationsInferredAt: 1, topics: [topic] },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('useTopicLearningWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('owns detail generation and polling until the topic completes', async () => {
    const topic = { id: 'topic-1', title: 'TCP', detail: '', done: false };
    const completed = { ...topic, detail: 'generated detail', done: true };
    const plan = { id: 'plan-1', topics: [topic] };
    const onRefresh = vi.fn();
    api.getPlan.mockResolvedValue({ plan: { ...plan, topics: [completed] } });

    const { result } = renderHook(() =>
      useTopicLearningWorkspace({ plan, topic, onRefresh })
    );

    await act(async () => { await Promise.resolve(); });
    expect(api.generateDetail).toHaveBeenCalledWith('plan-1', 'topic-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(result.current.content.detail).toBe('generated detail');
    expect(result.current.content.generating).toBe(false);
    expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan-1' }));
  });

  it('exposes one grouped learning workspace interface', () => {
    const { plan, topic } = readyPlan();
    const { result } = renderHook(() =>
      useTopicLearningWorkspace({ plan, topic, onRefresh: vi.fn() })
    );

    expect(Object.keys(result.current)).toEqual([
      'content',
      'review',
      'assessment',
      'interaction',
      'insights',
      'completion',
    ]);
  });

  it('activates review from the URL and refreshes generated review content', async () => {
    const { plan, topic } = readyPlan({ reviewGenerated: null });
    const freshPlan = {
      ...plan,
      topics: [{ ...topic, reviewGenerated: 'targeted review' }],
    };
    const onRefresh = vi.fn();
    api.generateReview.mockResolvedValue({ review: 'targeted review' });
    api.getPlan.mockResolvedValue({ plan: freshPlan });

    const { result } = renderHook(() => useTopicLearningWorkspace({
      plan,
      topic,
      onRefresh,
      urlReview: true,
      setSearchParams: vi.fn(),
    }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(api.generateReview).toHaveBeenCalledWith('plan-1', 'topic-1');
    expect(result.current.review.active).toBe(true);
    expect(result.current.review.content).toBe('targeted review');
    expect(onRefresh).toHaveBeenCalledWith(freshPlan);
  });

  it('does not retry a failed URL-triggered review until the URL is reactivated', async () => {
    const { plan, topic } = readyPlan({ reviewGenerated: null });
    const setSearchParams = vi.fn();
    api.generateReview.mockRejectedValue(new Error('review unavailable'));

    const { result, rerender } = renderHook(
      ({ urlReview }) => useTopicLearningWorkspace({
        plan,
        topic,
        onRefresh: vi.fn(),
        urlReview,
        setSearchParams,
      }),
      { initialProps: { urlReview: true } },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.generateReview).toHaveBeenCalledTimes(1);
    expect(result.current.review.active).toBe(false);
    expect(setSearchParams).toHaveBeenCalledWith({}, { replace: true });

    rerender({ urlReview: false });
    rerender({ urlReview: true });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.generateReview).toHaveBeenCalledTimes(2);
  });

  it('allows a manual retry after a URL-triggered review fails', async () => {
    const { plan, topic } = readyPlan({ reviewGenerated: null });
    const freshPlan = {
      ...plan,
      topics: [{ ...topic, reviewGenerated: 'manual retry review' }],
    };
    api.generateReview
      .mockRejectedValueOnce(new Error('review unavailable'))
      .mockResolvedValueOnce({ review: 'manual retry review' });
    api.getPlan.mockResolvedValue({ plan: freshPlan });

    const { result } = renderHook(() => useTopicLearningWorkspace({
      plan,
      topic,
      onRefresh: vi.fn(),
      urlReview: true,
      setSearchParams: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.review.active).toBe(false);

    await act(async () => {
      await result.current.review.toggle();
    });

    expect(api.generateReview).toHaveBeenCalledTimes(2);
    expect(result.current.review.active).toBe(true);
    expect(result.current.review.content).toBe('manual retry review');
  });

  it('coalesces review requests fired before React commits the loading state', () => {
    const { plan, topic } = readyPlan({ reviewGenerated: null });
    api.generateReview.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useTopicLearningWorkspace({
      plan,
      topic,
      onRefresh: vi.fn(),
      setSearchParams: vi.fn(),
    }));

    act(() => {
      void result.current.review.toggle();
      void result.current.review.toggle();
    });

    expect(api.generateReview).toHaveBeenCalledTimes(1);
  });

  it('keeps in-flight review results scoped to the topic that requested them', async () => {
    const topicA = {
      id: 'topic-a',
      title: 'TCP',
      detail: 'ready detail',
      done: true,
      reviewGenerated: null,
    };
    const topicB = {
      id: 'topic-b',
      title: 'UDP',
      detail: 'ready detail',
      done: true,
      reviewGenerated: null,
    };
    const plan = { id: 'plan-1', relationsInferredAt: 1, topics: [topicA, topicB] };
    const reviewA = deferred();
    const reviewB = deferred();
    const onRefresh = vi.fn();
    api.generateReview.mockImplementation((_planId, topicId) => (
      topicId === 'topic-a' ? reviewA.promise : reviewB.promise
    ));
    api.getPlan.mockResolvedValue({
      plan: {
        ...plan,
        topics: [{ ...topicA, reviewGenerated: 'review A' }, { ...topicB, reviewGenerated: 'review B' }],
      },
    });

    const { result, rerender } = renderHook(
      ({ topic }) => useTopicLearningWorkspace({
        plan,
        topic,
        onRefresh,
        urlReview: true,
        setSearchParams: vi.fn(),
      }),
      { initialProps: { topic: topicA } },
    );

    expect(api.generateReview).toHaveBeenCalledWith('plan-1', 'topic-a');

    rerender({ topic: topicB });

    expect(api.generateReview).toHaveBeenCalledWith('plan-1', 'topic-b');
    expect(api.generateReview).toHaveBeenCalledTimes(2);

    await act(async () => {
      reviewB.resolve({ review: 'review B' });
      await reviewB.promise;
      await Promise.resolve();
    });
    expect(result.current.review.content).toBe('review B');

    await act(async () => {
      reviewA.resolve({ review: 'review A' });
      await reviewA.promise;
      await Promise.resolve();
    });
    expect(result.current.review.content).toBe('review B');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('reuses an in-flight review when returning to the same topic', async () => {
    const topicA = {
      id: 'topic-a',
      title: 'TCP',
      detail: 'ready detail',
      done: true,
      reviewGenerated: null,
    };
    const topicB = {
      id: 'topic-b',
      title: 'UDP',
      detail: 'ready detail',
      done: true,
      reviewGenerated: null,
    };
    const plan = { id: 'plan-1', relationsInferredAt: 1, topics: [topicA, topicB] };
    const reviewA = deferred();
    const reviewB = deferred();
    api.generateReview.mockImplementation((_planId, topicId) => (
      topicId === 'topic-a' ? reviewA.promise : reviewB.promise
    ));
    api.getPlan.mockResolvedValue({
      plan: {
        ...plan,
        topics: [{ ...topicA, reviewGenerated: 'review A' }, topicB],
      },
    });

    const { result, rerender } = renderHook(
      ({ topic }) => useTopicLearningWorkspace({
        plan,
        topic,
        onRefresh: vi.fn(),
        urlReview: true,
        setSearchParams: vi.fn(),
      }),
      { initialProps: { topic: topicA } },
    );

    rerender({ topic: topicB });
    rerender({ topic: topicA });

    expect(api.generateReview).toHaveBeenCalledTimes(2);
    expect(api.generateReview.mock.calls).toEqual([
      ['plan-1', 'topic-a'],
      ['plan-1', 'topic-b'],
    ]);

    await act(async () => {
      reviewA.resolve({ review: 'review A' });
      await reviewA.promise;
      await Promise.resolve();
    });

    expect(result.current.review.content).toBe('review A');
    expect(result.current.review.loading).toBe(false);

    await act(async () => {
      reviewB.resolve({ review: 'review B' });
      await reviewB.promise;
      await Promise.resolve();
    });
    expect(result.current.review.content).toBe('review A');
  });

  it('ignores a stale review failure after the user switches topics', async () => {
    const topicA = {
      id: 'topic-a',
      title: 'TCP',
      detail: 'ready detail',
      done: true,
      reviewGenerated: null,
    };
    const topicB = {
      id: 'topic-b',
      title: 'UDP',
      detail: 'ready detail',
      done: true,
      reviewGenerated: null,
    };
    const plan = { id: 'plan-1', relationsInferredAt: 1, topics: [topicA, topicB] };
    const reviewA = deferred();
    const reviewB = deferred();
    const setSearchParams = vi.fn();
    api.generateReview.mockImplementation((_planId, topicId) => (
      topicId === 'topic-a' ? reviewA.promise : reviewB.promise
    ));
    api.getPlan.mockResolvedValue({
      plan: { ...plan, topics: [topicA, { ...topicB, reviewGenerated: 'review B' }] },
    });

    const { result, rerender } = renderHook(
      ({ topic }) => useTopicLearningWorkspace({
        plan,
        topic,
        onRefresh: vi.fn(),
        urlReview: true,
        setSearchParams,
      }),
      { initialProps: { topic: topicA } },
    );

    rerender({ topic: topicB });
    await act(async () => {
      reviewB.resolve({ review: 'review B' });
      await reviewB.promise;
      await Promise.resolve();
    });

    await act(async () => {
      reviewA.reject(new Error('stale failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.review.active).toBe(true);
    expect(result.current.review.content).toBe('review B');
    expect(setSearchParams).not.toHaveBeenCalled();
  });

  it('submits exercise answers and refreshes the authoritative plan', async () => {
    const exercises = [{ index: 1, question: 'Why?', correct: null }];
    const { plan, topic } = readyPlan({ exercises });
    const freshPlan = { ...plan, topics: [{ ...topic, exercises }] };
    const onRefresh = vi.fn();
    api.submitExercises.mockResolvedValue({
      results: [{ exerciseIndex: 0, correct: true, userAnswer: 'Because' }],
    });
    api.getPlan.mockResolvedValue({ plan: freshPlan });
    const { result } = renderHook(() =>
      useTopicLearningWorkspace({ plan, topic, onRefresh })
    );

    act(() => result.current.assessment.answer(0, 'Because'));
    await act(async () => { await result.current.assessment.submit(); });

    expect(api.submitExercises).toHaveBeenCalledWith('plan-1', 'topic-1', [
      { exerciseIndex: 0, userAnswer: 'Because' },
    ]);
    expect(result.current.assessment.submitted).toBe(true);
    expect(result.current.assessment.results[0].correct).toBe(true);
    expect(onRefresh).toHaveBeenCalledWith(freshPlan);
  });

  it('resets a restarted interactive stream and exits through URL synchronization', async () => {
    const { plan, topic } = readyPlan();
    const setSearchParams = vi.fn();
    api.startInteractiveSSE.mockImplementation(async (_planId, _topicId, _mode, onEvent) => {
      onEvent({ type: 'chunk', content: 'discard me' });
      onEvent({ type: 'reset' });
      onEvent({ type: 'chunk', content: 'fresh explanation' });
      onEvent({ type: 'done', finished: true, session: {} });
    });
    const { result } = renderHook(() => useTopicLearningWorkspace({
      plan,
      topic,
      onRefresh: vi.fn(),
      setSearchParams,
    }));

    await act(async () => { await result.current.interaction.start('stepwise'); });

    expect(result.current.interaction.sections).toEqual([
      { content: 'fresh explanation' },
    ]);
    expect(result.current.interaction.finished).toBe(true);

    act(() => result.current.interaction.exit());
    expect(result.current.interaction.mode).toBe(null);
    expect(result.current.interaction.sections).toEqual([]);
    expect(setSearchParams).toHaveBeenLastCalledWith({}, { replace: false });
  });

  it('checks embedded errors then marks the topic studied and refreshes', async () => {
    const { plan, topic } = readyPlan({ done: false });
    const freshPlan = { ...plan, topics: [{ ...topic, done: true }] };
    const onRefresh = vi.fn();
    const onBack = vi.fn();
    api.revealErrors.mockResolvedValue({ hasErrors: false, errors: [] });
    api.updateTopic.mockResolvedValue({});
    api.getPlan.mockResolvedValue({ plan: freshPlan });
    const { result } = renderHook(() => useTopicLearningWorkspace({
      plan,
      topic,
      onRefresh,
      onBack,
    }));

    act(() => result.current.completion.setFoundErrors('first issue; second issue'));
    await act(async () => { await result.current.completion.complete(); });

    expect(api.revealErrors).toHaveBeenCalledWith(
      'plan-1',
      'topic-1',
      ['first issue', 'second issue'],
    );
    expect(api.updateTopic).toHaveBeenCalledWith('plan-1', 'topic-1', { done: true });
    expect(onRefresh).toHaveBeenCalledWith(freshPlan);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('flushes active time through the workspace when the topic unmounts', async () => {
    const topic = { id: 'topic-1', title: 'TCP', detail: 'ready', done: true };
    const plan = { id: 'plan-1', topics: [topic] };
    const { unmount } = renderHook(() =>
      useTopicLearningWorkspace({ plan, topic, onRefresh: vi.fn() })
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    unmount();

    expect(api.recordTime).toHaveBeenCalledWith('plan-1', 'topic-1', 6);
  });

  it('excludes time while the window is unfocused', async () => {
    const topic = { id: 'topic-1', title: 'TCP', detail: 'ready', done: true };
    const plan = { id: 'plan-1', topics: [topic] };
    const { unmount } = renderHook(() =>
      useTopicLearningWorkspace({ plan, topic, onRefresh: vi.fn() })
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    act(() => window.dispatchEvent(new Event('blur')));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    unmount();

    expect(api.recordTime).toHaveBeenCalledWith('plan-1', 'topic-1', 6);
  });
});
