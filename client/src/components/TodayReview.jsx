import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CalendarCheck2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  RefreshCw,
  RotateCcw,
  Wrench,
} from 'lucide-react';
import api from '../api';

const COLLAPSED_LIMIT = 5;
const SEVERITY_LABELS = {
  low: '低',
  medium: '中',
  high: '高',
};
const MISTAKE_STATUS_LABELS = {
  open: '待修复',
};

function formatDueLabel(dueAt) {
  if (!Number.isFinite(dueAt)) return '今日到期';
  const overdueDays = Math.floor((Date.now() - dueAt) / 86_400_000);
  return overdueDays > 0 ? `逾期 ${overdueDays} 天` : '今日到期';
}

function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function itemPresentation(item) {
  if (item?.kind === 'review') {
    return {
      Icon: RotateCcw,
      ariaLabel: `复习 ${item.topicTitle}，学习计划 ${item.planName}`,
      title: `开始复习：${item.topicTitle}`,
      due: formatDueLabel(item.dueAt),
      invalid: false,
    };
  }
  if (item?.kind === 'mistake') {
    const recurrence = Math.max(0, Number(item.occurrenceCount || 1) - 1);
    const severity = SEVERITY_LABELS[item.severity] || '未知';
    const verificationTime = formatDateTime(item.verificationDueAt);
    const status = item.status === 'repairing'
      ? (verificationTime ? '验证到期' : '修复中')
      : (MISTAKE_STATUS_LABELS[item.status] || '状态异常');
    return {
      Icon: Wrench,
      ariaLabel: `修复 ${item.conceptLabel || item.topicTitle}，知识点 ${item.topicTitle}`,
      title: `开始错题修复：${item.conceptLabel || item.topicTitle}`,
      detail: `${severity}优先级 · 复发 ${recurrence} 次 · ${status}`,
      due: verificationTime ? `验证到期：${verificationTime}` : '现在修复',
      invalid: false,
    };
  }
  return {
    Icon: AlertCircle,
    ariaLabel: `无法打开的未知任务 ${item?.topicTitle || ''}`.trim(),
    title: '任务类型异常，请刷新后重试',
    detail: '任务类型异常，请刷新后重试',
    due: '无法处理',
    invalid: true,
  };
}

export default function TodayReview({ onOpen }) {
  const [queue, setQueue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextQueue = await api.getTodayReviews(100);
      setQueue({
        ...nextQueue,
        items: Array.isArray(nextQueue?.items) ? nextQueue.items : [],
      });
    } catch (err) {
      setError(err?.message || '无法加载今日复习');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
    window.addEventListener('today-review-refresh', loadQueue);
    return () => window.removeEventListener('today-review-refresh', loadQueue);
  }, [loadQueue]);

  const items = queue?.items || [];
  const total = Number.isFinite(queue?.counts?.total) ? queue.counts.total : items.length;
  const waitingVerification = Number.isFinite(queue?.counts?.waitingVerification)
    ? queue.counts.waitingVerification
    : 0;
  const visibleItems = expanded ? items : items.slice(0, COLLAPSED_LIMIT);

  return (
    <section className="today-review-band" aria-labelledby="today-review-title" aria-busy={loading}>
      <header className="today-review-header">
        <span className="today-review-heading-icon" aria-hidden="true"><CalendarCheck2 /></span>
        <div className="today-review-heading-copy">
          <span className="ui-kicker">今日安排</span>
          <h3 id="today-review-title">今日复习</h3>
        </div>
        {!loading && !error && total > 0 && (
          <span className="today-review-count" aria-label={`${total} 个学习任务待处理`}>{total}</span>
        )}
      </header>

      {loading && (
        <div className="today-review-status" role="status">
          <RefreshCw className="today-review-spin" aria-hidden="true" />
          <span>正在读取复习安排...</span>
        </div>
      )}

      {!loading && error && (
        <div className="today-review-status today-review-status--error" role="alert" title={error}>
          <span>今日复习加载失败</span>
          <button type="button" onClick={loadQueue} aria-label="重试今日复习" title="重试今日复习">
            <RefreshCw aria-hidden="true" />
            <span>重试</span>
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && waitingVerification === 0 && (
        <div className="today-review-status today-review-status--complete" role="status">
          <CalendarCheck2 aria-hidden="true" />
          <strong>今日已完成</strong>
        </div>
      )}

      {!loading && !error && items.length === 0 && waitingVerification > 0 && (
        <div className="today-review-status today-review-status--waiting" role="status">
          <Wrench aria-hidden="true" />
          <span><strong>{waitingVerification} 个错题等待延迟验证</strong>，到期后会重新出现在这里</span>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <>
          <ul className="today-review-list" aria-label="今日复习队列">
            {visibleItems.map(item => {
              const presentation = itemPresentation(item);
              const ItemIcon = presentation.Icon;
              return (
                <li key={item.queueItemId || `${item.planId}:${item.topicId}`}>
                  <button
                    type="button"
                    className={`today-review-item today-review-item--${item.kind || 'unknown'}`}
                    onClick={() => onOpen?.(item)}
                    aria-label={presentation.ariaLabel}
                    title={presentation.title}
                    disabled={presentation.invalid}
                  >
                    <span className="today-review-item-icon" aria-hidden="true"><ItemIcon /></span>
                    <span className="today-review-item-copy">
                      <strong>{item.kind === 'mistake' ? (item.conceptLabel || item.topicTitle) : item.topicTitle}</strong>
                      <small>{item.topicTitle} · {item.planName}</small>
                      {presentation.detail && <small className="today-review-item-detail">{presentation.detail}</small>}
                    </span>
                    <span className="today-review-item-due">{presentation.due}</span>
                    <ChevronRight className="today-review-item-arrow" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>

          {waitingVerification > 0 && (
            <div className="today-review-waiting-summary" role="status">
              另有 {waitingVerification} 个错题等待延迟验证
            </div>
          )}

          {items.length > COLLAPSED_LIMIT && (
            <button
              type="button"
              className="today-review-toggle"
              onClick={() => setExpanded(value => !value)}
              aria-expanded={expanded}
              aria-label={expanded ? '收起今日复习' : `查看全部 ${items.length} 项`}
              title={expanded ? '收起今日复习' : '查看全部今日复习'}
            >
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              <span>{expanded ? '收起' : `查看全部 ${items.length} 项`}</span>
            </button>
          )}
        </>
      )}
    </section>
  );
}
