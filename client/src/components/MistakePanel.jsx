import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  RotateCcw,
  Trash2,
  Wrench,
} from 'lucide-react';
import api from '../api';
import { Button } from '#/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog';

const STATUS_LABELS = {
  open: '待修复',
  repairing: '修复中',
  verified: '已验证',
};

const SEVERITY_LABELS = {
  low: '低',
  medium: '中',
  high: '高',
};

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

/**
 * Return a human-friendly relative-time string for a future timestamp.
 * Examples: "还需 23h 45m"  "还需 2h 3m"  "还需 45m"  "验证到期"
 */
function formatRelativeCountdown(timestamp, now) {
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = timestamp - now;
  if (diffMs <= 0) return '验证到期';
  const totalMin = Math.ceil(diffMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `还需 ${hours}h ${mins}m`;
  return `还需 ${mins}m`;
}

function getStatus(record, now) {
  if (record.status === 'repairing' && Number.isFinite(record.verificationDueAt)) {
    return record.verificationDueAt > now ? '待验证' : '验证到期';
  }
  return STATUS_LABELS[record.status] || '未知状态';
}

export default function MistakePanel({
  planId,
  topicId,
  mistakes = [],
  activeMistakeId = null,
  onRepair,
  onChanged,
  now = Date.now(),
}) {
  const [dismissTarget, setDismissTarget] = useState(null);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissError, setDismissError] = useState(null);
  const [dismissBusy, setDismissBusy] = useState(false);
  const [hiddenIds, setHiddenIds] = useState(() => new Set());

  useEffect(() => {
    setHiddenIds(current => {
      const next = new Set(current);
      let changed = false;
      for (const id of current) {
        const persisted = Array.isArray(mistakes)
          ? mistakes.find(record => record?.id === id)
          : null;
        if (!persisted || persisted.status === 'dismissed') {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [mistakes]);

  const records = useMemo(() => (
    (Array.isArray(mistakes) ? mistakes : [])
      .filter(record => record && typeof record === 'object')
      .filter(record => record.status !== 'dismissed' && !hiddenIds.has(record.id))
      .sort((left, right) => (
        (right.lastSeenAt || 0) - (left.lastSeenAt || 0)
        || String(left.id || '').localeCompare(String(right.id || ''))
      ))
  ), [hiddenIds, mistakes]);

  const closeDismiss = () => {
    if (dismissBusy) return;
    setDismissTarget(null);
    setDismissReason('');
    setDismissError(null);
  };

  const openDismiss = (record) => {
    setDismissTarget(record);
    setDismissReason('');
    setDismissError(null);
  };

  const normalizedReason = dismissReason.trim();
  const canDismiss = normalizedReason.length >= 1 && normalizedReason.length <= 200;

  const confirmDismiss = async () => {
    if (!dismissTarget || !canDismiss || dismissBusy) return;
    setDismissBusy(true);
    setDismissError(null);
    try {
      const response = await api.dismissMistake(
        planId,
        topicId,
        dismissTarget.id,
        normalizedReason
      );
      setHiddenIds(current => new Set(current).add(dismissTarget.id));
      setDismissTarget(null);
      setDismissReason('');
      onChanged?.(response?.mistake || null);
      window.dispatchEvent(new CustomEvent('today-review-refresh'));
    } catch (error) {
      setDismissError(error?.message || '暂时无法忽略该错题');
    } finally {
      setDismissBusy(false);
    }
  };

  if (records.length === 0) return null;

  return (
    <section className="mistake-panel" aria-labelledby="mistake-panel-title">
      <header className="mistake-panel__header">
        <span className="mistake-panel__heading-icon" aria-hidden="true"><Wrench /></span>
        <div>
          <span className="ui-kicker">纠错闭环</span>
          <h3 id="mistake-panel-title">错题修复</h3>
        </div>
        <span className="mistake-panel__count" aria-label={`${records.length} 个错题记录`}>
          {records.length}
        </span>
      </header>

      <ul className="mistake-panel__list" aria-label="错题修复列表">
        {records.map(record => {
          const verificationTime = formatRelativeCountdown(record.verificationDueAt, now);
          const verificationAbsolute = formatDateTime(record.verificationDueAt);
          const waiting = record.status === 'repairing'
            && Number.isFinite(record.verificationDueAt)
            && record.verificationDueAt > now;
          const actionable = ['open', 'repairing'].includes(record.status) && !waiting;
          const conceptLabel = typeof record.conceptLabel === 'string' && record.conceptLabel.trim()
            ? record.conceptLabel
            : '未命名概念';
          const recurrence = Math.max(0, Number(record.occurrenceCount || 1) - 1);
          return (
            <li className="mistake-panel__item" key={record.id || conceptLabel}>
              <div className="mistake-panel__item-copy">
                <strong>{conceptLabel}</strong>
                <div className="mistake-panel__meta">
                  <span className={`mistake-panel__severity mistake-panel__severity--${record.severity || 'unknown'}`}>
                    {SEVERITY_LABELS[record.severity] || '未知'}优先级
                  </span>
                  <span>复发 {recurrence} 次</span>
                  <span>{getStatus(record, now)}</span>
                </div>
                {record.status === 'repairing' && verificationTime && (
                  <span className="mistake-panel__verification" title={verificationAbsolute ? `验证时间：${verificationAbsolute}` : undefined}>
                    <Clock3 aria-hidden="true" />
                    {verificationTime}
                  </span>
                )}
                {record.status === 'verified' && (
                  <span className="mistake-panel__verified">
                    <CheckCircle2 aria-hidden="true" />已通过延迟验证
                  </span>
                )}
                {!STATUS_LABELS[record.status] && record.status !== 'repairing' && (
                  <span className="mistake-panel__invalid" role="status">
                    <AlertCircle aria-hidden="true" />记录状态异常，请刷新后重试
                  </span>
                )}
              </div>

              <div className="mistake-panel__actions">
                {actionable && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onRepair?.(record.id)}
                    title={record.verificationDueAt ? '开始延迟验证' : '开始错题修复'}
                  >
                    <Wrench className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                    {activeMistakeId === record.id
                      ? '继续修复'
                      : (record.verificationDueAt ? '开始验证' : '修复')}
                  </Button>
                )}
                {waiting && (
                  <Button type="button" size="sm" variant="outline" disabled title="尚未到验证时间">
                    <Clock3 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />等待验证
                  </Button>
                )}
                {['open', 'repairing'].includes(record.status) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => openDismiss(record)}
                    title="忽略该错题"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />忽略
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog open={Boolean(dismissTarget)} onOpenChange={open => { if (!open) closeDismiss(); }}>
        <DialogContent
          className="mistake-dismiss-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mistake-dismiss-title"
        >
          <DialogClose type="button" onClick={closeDismiss} aria-label="关闭忽略确认" />
          <DialogHeader>
            <DialogTitle id="mistake-dismiss-title">确认忽略错题</DialogTitle>
            <DialogDescription>
              忽略后不再进入今日纠错；后续再次答错时会自动重新打开。
            </DialogDescription>
          </DialogHeader>
          <label className="mistake-dismiss-dialog__label" htmlFor="mistake-dismiss-reason">
            忽略原因
          </label>
          <textarea
            id="mistake-dismiss-reason"
            value={dismissReason}
            onChange={event => {
              setDismissReason(event.target.value);
              setDismissError(null);
            }}
            maxLength={200}
            rows={4}
            autoFocus
            placeholder="说明为什么这条记录不需要继续修复"
            aria-describedby="mistake-dismiss-count"
          />
          <div id="mistake-dismiss-count" className="mistake-dismiss-dialog__count">
            {dismissReason.length}/200
          </div>
          {dismissError && (
            <div className="mistake-dismiss-dialog__error" role="alert">
              <AlertCircle aria-hidden="true" />{dismissError}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDismiss} disabled={dismissBusy}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDismiss}
              disabled={!canDismiss || dismissBusy}
            >
              {dismissBusy
                ? <RotateCcw className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
                : <Trash2 className="h-4 w-4 mr-1" aria-hidden="true" />}
              {dismissBusy ? '正在忽略...' : '确认忽略'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
