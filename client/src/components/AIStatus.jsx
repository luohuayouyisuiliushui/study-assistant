import { useState, useEffect, useRef } from 'react';

const API_BASE = '/api/learn';

/**
 * Hook that periodically checks AI service availability.
 * Returns { connected, model, checking, error }.
 */
export function useAIStatus() {
  const [connected, setConnected] = useState(null);
  const [model, setModel] = useState('');
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  const check = async () => {
    setChecking(true);
    try {
      const settings = (() => {
        try { return JSON.parse(localStorage.getItem('textbook-maker-settings') || '{}'); } catch { return {}; }
      })();
      if (!settings.apiKey) { setConnected(false); setError('未配置 API Key'); setModel(''); return; }

      const res = await fetch(`${API_BASE}/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: settings.apiKey,
          baseURL: settings.baseURL,
          model: settings.model,
        }),
      });
      const data = await res.json();
      if (mountedRef.current) {
        setConnected(data.ok === true);
        setModel(data.model || settings.model || '');
        setError(data.ok ? null : (data.error || '连接失败'));
      }
    } catch (err) {
      if (mountedRef.current) { setConnected(false); setError(err.message); }
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    check();
    timerRef.current = setInterval(check, 30_000);
    return () => { mountedRef.current = false; clearInterval(timerRef.current); };
  }, []);

  return { connected, model, checking, error, recheck: check };
}

/**
 * Small AI connection status indicator.
 * Green dot = connected, red dot = disconnected.
 */
export default function AIStatusIndicator() {
  const { connected, checking } = useAIStatus();

  if (checking && connected === null) return null;

  const color = connected ? 'bg-green-500' : 'bg-red-500';
  const title = connected ? 'AI 服务已连接' : 'AI 服务未连接';

  return (
    <span className='flex items-center gap-1.5 text-xs text-muted-foreground' title={title}>
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      AI
    </span>
  );
}
