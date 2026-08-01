import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, ExternalLink, RotateCcw, XCircle } from 'lucide-react';
import api from '../api';
import { Button } from '../components/ui/button';
import { readReviewBudget, writeReviewBudget } from '../lib/review-settings';

const REASON_LABELS = {
  'open-mistake': '待修复错题',
  'repairing-due': '到期验证',
  'overdue-review': '逾期复习',
  'due-review': '今日到期',
};

export default function TodayReviewPage({ autoStart = false, onOpenTopic }) {
  const [budgetMinutes, setBudgetMinutes] = useState(readReviewBudget);
  const [queue, setQueue] = useState(null);
  const [session, setSession] = useState(null);
  const [activeItem, setActiveItem] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submission, setSubmission] = useState(null);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const autoStarted = useRef(false);

  const loadQueue = useCallback(async () => {
    try {
      setError('');
      const data = await api.getTodayReview(budgetMinutes);
      setQueue(data.queue);
      return data.queue;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [budgetMinutes]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const startItem = useCallback(async item => {
    if (!item) return;
    setBusyKey(`start:${item.planId}:${item.topicId}`);
    setError('');
    try {
      const data = item.activeSession
        ? await api.createReviewSession(item.planId, item.topicId)
        : item.mistake
        ? await api.createMistakeRepairSession(item.planId, item.topicId, item.mistake.conceptKey)
        : await api.createReviewSession(item.planId, item.topicId);
      setActiveItem(item);
      setSession(data.session);
      setAnswers({});
      setSubmission(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey('');
    }
  }, []);

  useEffect(() => {
    if (autoStart && queue?.items?.length > 0 && !autoStarted.current) {
      autoStarted.current = true;
      startItem(queue.items[0]);
    }
  }, [autoStart, queue, startItem]);

  const closeSession = async () => {
    setSession(null);
    setActiveItem(null);
    setAnswers({});
    setSubmission(null);
    await loadQueue();
  };

  const submit = async () => {
    if (!session || !activeItem) return;
    setBusyKey('submit');
    setError('');
    try {
      const data = await api.submitReviewSession(activeItem.planId, activeItem.topicId, {
        sessionId: session.id,
        answers: session.questions.map(question => ({ questionId: question.id, answer: answers[question.id] })),
      });
      setSubmission(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey('');
    }
  };

  const deferItem = async item => {
    setBusyKey(`defer:${item.planId}:${item.topicId}`);
    try {
      await api.deferReview(item.planId, item.topicId, Date.now() + 24 * 60 * 60 * 1000);
      if (activeItem?.planId === item.planId && activeItem?.topicId === item.topicId) {
        setSession(null);
        setActiveItem(null);
        setAnswers({});
        setSubmission(null);
      }
      await loadQueue();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey('');
    }
  };

  const dismissItem = async item => {
    if (!item.mistake) return;
    setBusyKey(`dismiss:${item.planId}:${item.topicId}`);
    try {
      await api.dismissMistake(item.planId, item.topicId, item.mistake.conceptKey);
      await loadQueue();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey('');
    }
  };

  const allAnswered = session?.questions?.every(question => String(answers[question.id] ?? '').trim()) || false;

  if (session && activeItem) {
    return (
      <div className="w-full max-w-3xl px-5 py-8 sm:px-8">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-3 border-b pb-5">
          <div>
            <span className="text-xs font-medium text-muted-foreground">{activeItem.planName} · {REASON_LABELS[activeItem.reason]}</span>
            <h2 className="mt-1 text-xl font-semibold">{activeItem.topicTitle}</h2>
          </div>
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><Clock3 className="h-4 w-4" />{session.estimatedMinutes} 分钟</span>
        </div>

        <div className="space-y-7">
          {session.questions.map((question, index) => {
            const result = submission?.results?.find(item => item.questionId === question.id);
            return (
              <fieldset key={question.id} className="border-b pb-7 last:border-0">
                <legend className="mb-3 text-sm font-semibold">{index + 1}. {question.prompt}</legend>
                {question.options?.length > 0 ? (
                  <div className="grid gap-2">
                    {question.options.map(option => (
                      <label key={option} className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm hover:bg-accent">
                        <input
                          type="radio"
                          name={question.id}
                          value={option}
                          checked={answers[question.id] === option}
                          onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                          disabled={Boolean(submission)}
                        />
                        {option}
                      </label>
                    ))}
                  </div>
                ) : (
                  <textarea
                    aria-label={question.prompt}
                    value={answers[question.id] || ''}
                    onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                    disabled={Boolean(submission)}
                    rows={3}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                )}
                {result && (
                  <div className={`mt-3 border-l-2 pl-3 text-sm ${result.correct ? 'border-emerald-500' : 'border-destructive'}`}>
                    <p className="flex items-center gap-1.5 font-medium">
                      {result.correct ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-destructive" />}
                      {result.correct ? '回答正确' : '需要再巩固'}
                    </p>
                    <p className="mt-1 text-muted-foreground">参考答案：{result.expectedAnswer}</p>
                    {result.explanation && <p className="mt-1 text-muted-foreground">{result.explanation}</p>}
                  </div>
                )}
              </fieldset>
            );
          })}
        </div>

        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2 border-t pt-5">
          {!submission && <Button variant="outline" onClick={() => deferItem(activeItem)}>延后 1 天</Button>}
          {!submission ? (
            <Button onClick={submit} disabled={!allAnswered || busyKey === 'submit'}>提交答案</Button>
          ) : (
            <Button onClick={closeSession}>继续队列<ArrowRight className="ml-1.5 h-4 w-4" /></Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl px-5 py-8 sm:px-8">
      <div className="flex flex-col gap-5 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2"><RotateCcw className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">今日复习</h2></div>
          {queue && <p className="mt-2 text-sm text-muted-foreground">{queue.scheduledMinutes} / {queue.budgetMinutes} 分钟 · {queue.items.length} 个已安排 · {queue.remainingCount} 个顺延</p>}
        </div>
        <label className="w-full max-w-xs text-xs font-medium text-muted-foreground">
          每日预算：{budgetMinutes} 分钟
          <input
            type="range" min="10" max="120" step="5" value={budgetMinutes}
            onChange={event => setBudgetMinutes(writeReviewBudget(event.target.value))}
            className="mt-2 w-full accent-primary"
          />
        </label>
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      {!queue && !error && <div className="py-16 text-center text-sm text-muted-foreground">加载中...</div>}
      {queue?.totalCount === 0 && (
        <div className="py-16 text-center"><CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" /><h3 className="mt-3 font-semibold">今日复习已完成</h3></div>
      )}
      {queue?.totalCount > 0 && queue.items.length === 0 && (
        <div className="py-16 text-center"><Clock3 className="mx-auto h-8 w-8 text-muted-foreground" /><h3 className="mt-3 font-semibold">{queue.remainingCount} 个知识点超出当前预算</h3></div>
      )}
      <div className="divide-y">
        {queue?.items.map(item => {
          const key = `${item.planId}:${item.topicId}`;
          return (
            <article key={key} className="grid gap-4 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{item.topicTitle}</h3>
                  <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">{REASON_LABELS[item.reason]}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{item.planName} · {item.estimatedMinutes} 分钟{item.overdueDays > 0 ? ` · 逾期 ${item.overdueDays} 天` : ''}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {onOpenTopic && <Button size="icon" variant="ghost" title="打开知识点" onClick={() => onOpenTopic(item)}><ExternalLink className="h-4 w-4" /></Button>}
                {item.mistake && <Button size="sm" variant="ghost" aria-label={`忽略 ${item.topicTitle} 错题`} onClick={() => dismissItem(item)} disabled={busyKey === `dismiss:${key}`}>忽略错题</Button>}
                <Button size="sm" variant="outline" aria-label={`延后 ${item.topicTitle} 1 天`} onClick={() => deferItem(item)} disabled={busyKey === `defer:${key}`}>延后 1 天</Button>
                <Button size="sm" aria-label={`${item.activeSession ? '继续复习' : '开始复习'} ${item.topicTitle}`} onClick={() => startItem(item)} disabled={busyKey === `start:${key}`}>
                  {item.activeSession ? '继续' : '开始'}<ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
