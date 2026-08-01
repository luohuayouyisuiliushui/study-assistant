import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, RotateCcw } from 'lucide-react';
import api from '../api';
import { Button } from './ui/button';
import { readReviewBudget } from '../lib/review-settings';

export default function TodayReviewSummary({ onStart }) {
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.getTodayReview(readReviewBudget())
      .then(data => { if (active) setQueue(data.queue); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  if (error) {
    return (
      <section className="mx-auto w-full max-w-6xl border-b px-5 py-4 sm:px-8" aria-label="今日复习">
        <p className="text-sm text-muted-foreground">今日复习暂时无法加载</p>
      </section>
    );
  }
  if (!queue) {
    return <section className="mx-auto h-24 w-full max-w-6xl animate-pulse border-b" aria-label="正在加载今日复习" />;
  }

  const unfinished = queue.items.filter(item => item.activeSession).length;
  const empty = queue.totalCount === 0;
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 border-b px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8" aria-labelledby="today-review-title">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {empty ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <RotateCcw className="h-5 w-5 text-primary" />}
          <h2 id="today-review-title" className="text-base font-semibold">今日复习</h2>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{queue.totalCount} 个知识点</span>
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{queue.scheduledMinutes} / {queue.budgetMinutes} 分钟</span>
          {unfinished > 0 && <span>{unfinished} 个未完成会话</span>}
          {queue.remainingCount > 0 && <span>{queue.remainingCount} 个顺延</span>}
        </div>
      </div>
      <Button onClick={onStart} disabled={empty} className="shrink-0">
        {unfinished > 0 ? '继续今日复习' : empty ? '今日已完成' : '开始今日复习'}
        {!empty && <ArrowRight className="ml-1.5 h-4 w-4" />}
      </Button>
    </section>
  );
}
