import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, Download, RotateCcw, Sparkles, CheckCheck, AlertTriangle, ChevronDown, ChevronRight, MessageSquare, SendHorizonal, Image, Search, Wrench, FileText, BarChart3, BookOpen, Play, Mic, X, Lightbulb, Target, Zap, Swords, Layers, Brain, CheckCircle, AlertCircle, List, ThumbsUp, ThumbsDown, Meh, MoreHorizontal } from 'lucide-react';
import { Button } from '#/components/ui/button';
import api from '../api';
import RegenerateDialog from './RegenerateDialog';
import { ContentArea, QaMessages } from './TopicDetailShared.jsx';
import AIStatusIndicator from './AIStatus.jsx';
import InteractivePanel from './InteractivePanel.jsx';

const ERROR_TYPE_LABELS = {
  boundary: '边界条件偏差',
  'concept-approx': '概念近似但不精确',
  'concept-confusion': '概念混淆',
  'causal-fallacy': '因果谬误',
  overgeneralization: '过度概括',
  'code-bug': '代码错误',
  'symbol-slip': '符号/计算错误',
  procedural: '步骤缺失/顺序错误',
};

function stripExerciseSection(detail) {
  if (!detail) return '';
  const lines = detail.split('\n');
  const startIdx = lines.findIndex(l => {
    const t = l.trim();
    return t.includes('📝 练习题') || /^#{1,3}\s*练习题/.test(t);
  });
  if (startIdx === -1) return detail;
  return lines.slice(0, startIdx).join('\n').trimEnd();
}

function parseExercisesFromMarkdown(detail) {
  if (!detail) return [];
  const exercises = [];
  const lines = detail.split('\n');
  let current = null;
  let inSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.includes('📝 练习题') || /^#{1,3}\s*练习题/.test(t)) { inSection = true; continue; }
    if (!inSection) continue;
    const m = t.match(/^>\s*\*\*练习题\s*(\d+)\*\*\s*[（(]([^)）]+)[)）]/);
    if (m) {
      if (current) exercises.push(current);
      current = { index: parseInt(m[1]), type: m[2] === '选择题' ? 'choice' : 'open', question: '', options: [], answer: '', explanation: '', conceptTag: '', userAnswer: null, correct: null };
      const parenEnd = t.search(/[)）]/);
      if (parenEnd >= 0 && parenEnd + 1 < t.length) current.question = t.slice(parenEnd + 1).replace(/^[）)]\s*/, '').trim();
      continue;
    }
    if (!current) continue;
    const opt = t.match(/^>\s*-\s*([A-D])[.．、]\s*(.+)/);
    if (opt) { current.options.push(opt[1] + '. ' + opt[2]); continue; }
    const ans = t.match(/^>\s*>\s*(?:正确答案|参考答案)[：:]\s*(.+)/);
    if (ans) { current.answer = ans[1].trim(); continue; }
    const exp = t.match(/^>\s*>\s*解析[：:]\s*(.+)/);
    if (exp) { current.explanation = exp[1].trim(); continue; }
    const conc = t.match(/^>\s*>\s*关联概念[：:]\s*(.+)/);
    if (conc) { current.conceptTag = conc[1].trim(); continue; }
    if (t.startsWith('> ') && !t.startsWith('> -') && !t.startsWith('> >') && !t.startsWith('> **练习题')) {
      const txt = t.slice(2).trim();
      if (txt && !current.answer) current.question += (current.question ? ' ' : '') + txt;
    }
  }
  if (current) exercises.push(current);
  return exercises;
}

export default function TopicDetail({ plan, topic, onBack, onRefresh, onSelectTopic }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlMode = searchParams.get('mode');
  const urlReview = searchParams.get('review') === '1';
  const [qaInput, setQaInput] = useState('');
  const [qaList, setQaList] = useState([]);
  const [qaLoading, setQaLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [localDetail, setLocalDetail] = useState(topic?.detail || '');
  const qaInputRef = useRef(null);
  const chatPanelRef = useRef(null);
  const genTriggered = useRef(false);
  const startTimeRef = useRef(Date.now());
  const hiddenDurationRef = useRef(0);
  const hiddenStartRef = useRef(null);
  const [difficulty, setDifficulty] = useState(topic?.difficulty || null);
  const headerSentinelRef = useRef(null);
  const [headerStuck, setHeaderStuck] = useState(false);
  const [difficultySaving, setDifficultySaving] = useState(false);
  const [hoveredRound, setHoveredRound] = useState(null);
  const [revealErrors, setRevealErrors] = useState(null);
  const [revealLoading, setRevealLoading] = useState(false);
  const [foundErrorsInput, setFoundErrorsInput] = useState('');
  const lastReportedRef = useRef(0);
  const settings = (() => { try { return JSON.parse(localStorage.getItem('textbook-maker-settings') || '{}'); } catch { return {}; } })();

  const [exercises, setExercises] = useState([]);
  const [exerciseAnswers, setExerciseAnswers] = useState({});
  const [exerciseResults, setExerciseResults] = useState(null);
  const [exerciseLoading, setExerciseLoading] = useState(false);
  const [submittedExercises, setSubmittedExercises] = useState(false);

  const [reviewMode, setReviewMode] = useState(false);
  const [reviewContent, setReviewContent] = useState(topic?.reviewGenerated || null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false);

  const [interactiveMode, setInteractiveMode] = useState(null);
  const [interactiveSections, setInteractiveSections] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [interactiveLoading, setInteractiveLoading] = useState(false);
  const [interactiveFinished, setInteractiveFinished] = useState(false);
  const [interactiveInput, setInteractiveInput] = useState('');
  const [interactiveStateMachine, setInteractiveStateMachine] = useState(null);
  const interactiveInputRef = useRef(null);
  const interactiveBusyRef = useRef(false);

  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef(null);
  const [voiceSupported, setVoiceSupported] = useState(true);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const fixedMenuRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (!menuRef.current?.contains(e.target) && !fixedMenuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const [factCheckData, setFactCheckData] = useState(topic?.factCheck || null);
  const [factCheckLoading, setFactCheckLoading] = useState(false);
  const [factCheckFixing, setFactCheckFixing] = useState(false);

  const [adaptiveData, setAdaptiveData] = useState(null);
  const [adaptiveLoading, setAdaptiveLoading] = useState(false);
  const [feynmanInsightsOpen, setFeynmanInsightsOpen] = useState(true);
  const [feynmanAnalyzing, setFeynmanAnalyzing] = useState(false);
  const [feynmanHistoryOpen, setFeynmanHistoryOpen] = useState(false);

  // AI request abort controller — cancels all pending AI calls on unmount / mode switch
  const abortRef = useRef(null);
  const getAbortSignal = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    return abortRef.current.signal;
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Memoize expensive computed values
  const strippedDetailMemo = useMemo(() => stripExerciseSection(localDetail), [localDetail]);
  const parsedExercisesMemo = useMemo(() => parseExercisesFromMarkdown(localDetail), [localDetail]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) setVoiceSupported(false);
  }, []);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) { try { recognitionRef.current.abort(); } catch {} }
    };
  }, []);

  // Load previous session history for display (don't auto-enter interactive mode)
  const [prevSessionData, setPrevSessionData] = useState(null);
  useEffect(() => {
    const session = topic?.interactiveSession;
    if (!session || !session.transcript || session.transcript.length === 0) { setPrevSessionData(null); return; }
    setPrevSessionData({ mode: session.mode, sections: session.transcript.map(e => ({ content: e.content || '' })), finished: !!session.finished });
  }, [topic?.id]);

  // Sync URL params with interactive mode and review mode
  useEffect(() => {
    if (urlMode && !interactiveMode) {
      // URL has mode but state doesn't — restore from URL (e.g., page refresh)
      setInteractiveMode(urlMode);
      setInteractiveFinished(false);
    } else if (!urlMode && interactiveMode) {
      // State has mode but URL doesn't — user pressed back, exit mode
      setInteractiveMode(null);
      setInteractiveSections([]);
      setInteractiveFinished(false);
      setInteractiveInput('');
      setInteractiveStateMachine(null);
    }
  }, [urlMode]);

  useEffect(() => {
    if (urlReview && !reviewMode) {
      setReviewMode(true);
      // If no review content yet, generate it
      if (!reviewContent && !reviewLoading) {
        setReviewLoading(true);
        api.generateReview(plan.id, topic.id).then(d => {
          setReviewContent(d.review);
          api.getPlan(plan.id).then(fresh => onRefresh(fresh.plan));
        }).catch(() => {}).finally(() => setReviewLoading(false));
      }
    } else if (!urlReview && reviewMode) {
      setReviewMode(false);
    }
  }, [urlReview]);

  // Sticky header: detect when sentinel scrolls out of view
  useEffect(() => {
    const sentinel = headerSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setHeaderStuck(!entry.isIntersecting),
      { threshold: 0, rootMargin: '-1px 0px 0px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const pid = plan?.id;
    const tid = topic?.id;
    startTimeRef.current = Date.now();
    lastReportedRef.current = 0;
    hiddenDurationRef.current = 0;
    hiddenStartRef.current = null;

    let activeStart = Date.now();
    let isActive = true;
    let inactivityTimeout = null;
    const INACTIVITY_THRESHOLD = 30000;

    const markActive = () => {
      if (!isActive) {
        hiddenDurationRef.current += Date.now() - activeStart;
        isActive = true;
        activeStart = Date.now();
      }
      clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(() => {
        if (isActive) { isActive = false; activeStart = Date.now(); }
      }, INACTIVITY_THRESHOLD);
    };

    const activityEvents = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];
    activityEvents.forEach(e => document.addEventListener(e, markActive, { passive: true }));

    inactivityTimeout = setTimeout(() => {
      if (isActive) { isActive = false; activeStart = Date.now(); }
    }, INACTIVITY_THRESHOLD);

    const onVisibility = () => {
      if (document.hidden) {
        if (isActive) { isActive = false; activeStart = Date.now(); }
        hiddenStartRef.current = Date.now();
      } else if (hiddenStartRef.current) {
        hiddenDurationRef.current += Date.now() - hiddenStartRef.current;
        hiddenStartRef.current = null;
        markActive();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Detect window blur (user switches to another window on any screen)
    const onBlur = () => { if (isActive) { isActive = false; activeStart = Date.now(); } };
    const onFocus = () => { if (!document.hidden) markActive(); };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);

    const effectiveElapsed = () => {
      const totalMs = Date.now() - startTimeRef.current;
      let hiddenExtra = hiddenDurationRef.current;
      if (hiddenStartRef.current) hiddenExtra += Date.now() - hiddenStartRef.current;
      if (!isActive) hiddenExtra += Date.now() - activeStart;
      return Math.round((totalMs - hiddenExtra) / 1000);
    };

    const heartbeat = setInterval(async () => {
      const total = effectiveElapsed();
      const unreported = total - lastReportedRef.current;
      if (unreported >= 5 && pid && tid) {
        try { await api.recordTime(pid, tid, unreported); lastReportedRef.current = total; } catch {}
      }
    }, 30000);

    return () => {
      clearInterval(heartbeat);
      clearTimeout(inactivityTimeout);
      activityEvents.forEach(e => document.removeEventListener(e, markActive));
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      if (hiddenStartRef.current) hiddenDurationRef.current += Date.now() - hiddenStartRef.current;
      const elapsed = effectiveElapsed();
      const unreported = elapsed - lastReportedRef.current;
      if (unreported >= 5 && pid && tid) { api.recordTime(pid, tid, unreported).catch(() => {}); }
    };
  }, [topic?.id]);

  useEffect(() => {
    setLocalDetail(topic?.detail || '');
    setError(topic?.lastError || null);
    const history = plan.history?.filter(h => h.topicId === topic?.id) || [];
    const pairs = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
        pairs.push({ question: history[i].content, answer: history[i + 1].content });
        i++;
      }
    }
    setQaList(prev => {
      const hasPending = prev.some(q => q.answer === '...');
      if (hasPending) return prev;
      return pairs;
    });
  }, [topic?.id]);

  useEffect(() => {
    if (!localDetail || generating) return;
    if (topic?.exercises && topic.exercises.length > 0) {
      setExercises(topic.exercises);
      if (topic.exercises.every(e => e.correct !== null)) {
        setSubmittedExercises(true);
        setExerciseResults(topic.exercises.map((e, idx) => ({
          exerciseIndex: idx, correct: e.correct, userAnswer: e.userAnswer,
          correctAnswer: e.answer, explanation: e.explanation,
        })));
      }
      return;
    }
    const parsed = parsedExercisesMemo;
    if (parsed.length > 0) setExercises(parsed);
  }, [localDetail, generating, topic?.exercises]);

  useEffect(() => {
    if (chatPanelRef.current) chatPanelRef.current.scrollTop = chatPanelRef.current.scrollHeight;
  }, [qaList.length]);

  const scrollToRound = (index) => {
    const container = chatPanelRef.current;
    if (!container) return;
    const target = container.querySelector(`[data-round="${index}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    if (!topic || genTriggered.current) return;
    if (topic.detail && topic.done) { setGenerating(false); return; }
    if (topic.lastError) { setError(topic.lastError); return; }
    if (!topic.detail && !topic.done && !topic.lastError) {
      genTriggered.current = true;
      setGenerating(true);
      api.generateDetail(plan.id, topic.id).catch(err => {
        console.error('[TopicDetail] generateDetail failed:', err);
        setGenerating(false);
        setError(err.message || '加载失败');
      });
    }
  }, [topic?.id]);

  const handleGenerateImage = async (topicId) => {
    setGenerating(true);
    try {
      await api.generateDetail(plan.id, topicId);
      setTimeout(async () => {
        const fresh = await api.getPlan(plan.id);
        if (fresh.plan) { setTopic(fresh.plan.topics.find(t => t.id === topicId)); }
        setGenerating(false);
      }, 5000);
    } catch { setGenerating(false); }
  };

  useEffect(() => {
    if (!generating && localDetail && !error) qaInputRef.current?.focus();
  }, [generating, localDetail, error]);

  useEffect(() => {
    if (!generating || !plan) return;
    const timer = setInterval(async () => {
      try {
        const d = await api.getPlan(plan.id);
        const t = d.plan.topics.find(t => t.id === topic?.id);
        if (!t) { clearInterval(timer); return; }
        if (t.detail && t.detail !== localDetail) { setLocalDetail(t.detail); onRefresh(d.plan); }
        if (t.lastError) { setError(t.lastError); setGenerating(false); clearInterval(timer); }
        if (t.done && !t.lastError) { setLocalDetail(t.detail || localDetail); setGenerating(false); clearInterval(timer); }
      } catch { clearInterval(timer); }
    }, 2000);
    return () => clearInterval(timer);
  }, [generating, plan?.id, topic?.id]);

  useEffect(() => {
    if (!showExportMenu) return;
    const handler = (e) => { if (!e.target.closest('.export-menu-container')) setShowExportMenu(false); };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showExportMenu]);

  if (!topic) return null;

  const handleAsk = async () => {
    if (!qaInput.trim() || qaLoading) return;
    const question = qaInput.trim();
    setQaInput('');
    setQaLoading(true);
    setQaList(prev => [...prev, { question, answer: '...' }]);
    try {
      const d = await api.askQuestion(plan.id, topic.id, question);
      setQaList(prev => { const list = [...prev]; list[list.length - 1] = { question, answer: d.answer }; return list; });
      requestAnimationFrame(() => { if (chatPanelRef.current) chatPanelRef.current.scrollTop = chatPanelRef.current.scrollHeight; });
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
      setTimeout(() => qaInputRef.current?.focus(), 100);
    } catch (err) {
      setQaList(prev => { const list = [...prev]; list[list.length - 1] = { question, answer: `❌ 请求失败: ${err.message}` }; return list; });
    } finally { setQaLoading(false); }
  };

  const handleExport = () => {
    if (!localDetail) return;
    let md = `# ${topic.title}\n\n`;
    md += topic.detail + '\n\n';
    if (qaList.length > 0) {
      md += `---\n\n## 📎 扩展讨论\n\n`;
      qaList.forEach((qa, i) => { md += `### 追问 ${i + 1}\n\n${qa.question}\n\n`; md += `> ${qa.answer}\n\n`; });
    }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${topic.title}.md`.replace(/[/\\?%*:|"<>]/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportHtml = async () => {
    if (!localDetail) return;
    let md = `# ${topic.title}\n\n`;
    md += topic.detail + '\n\n';
    if (qaList.length > 0) {
      md += `---\n\n## 📎 扩展讨论\n\n`;
      qaList.forEach((qa, i) => { md += `### 追问 ${i + 1}\n\n${qa.question}\n\n`; md += `> ${qa.answer}\n\n`; });
    }
    const segments = [];
    const mermaidRe = /```mermaid\s*\n([\s\S]*?)```/g;
    let lastIdx = 0, match;
    while ((match = mermaidRe.exec(md)) !== null) {
      if (match.index > lastIdx) segments.push({ type: 'markdown', content: md.slice(lastIdx, match.index) });
      segments.push({ type: 'mermaid', content: match[1].trim() });
      lastIdx = mermaidRe.lastIndex;
    }
    if (lastIdx < md.length) segments.push({ type: 'markdown', content: md.slice(lastIdx) });
    const mdToHtml = (text) => {
      let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      h = h.replace(/^##### (.*$)/gm, '<h5>$1</h5>');
      h = h.replace(/^#### (.*$)/gm, '<h4>$1</h4>');
      h = h.replace(/^### (.*$)/gm, '<h3>$1</h3>');
      h = h.replace(/^## (.*$)/gm, '<h2>$1</h2>');
      h = h.replace(/^# (.*$)/gm, '<h1>$1</h1>');
      h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
      h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      h = h.replace(/^---$/gm, '<hr>');
      h = h.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');
      h = h.replace(/^- (.*$)/gm, '<li>$1</li>');
      h = h.replace(/^\d+\. (.*$)/gm, '<li>$1</li>');
      h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
      h = h.replace(/\n\n/g, '</p><p>');
      if (!h.startsWith('<h') && !h.startsWith('<p>') && !h.startsWith('<ul') && !h.startsWith('<blockquote') && !h.startsWith('<hr')) h = '<p>' + h;
      if (!h.endsWith('>')) h = h + '</p>';
      h = h.replace(/<p><\/p>/g, '');
      return h;
    };
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' });
    let bodyHtml = '';
    for (const seg of segments) {
      if (seg.type === 'mermaid') {
        try { const id = 'm-export-' + Math.random().toString(36).slice(2, 9); const { svg: svgText } = await mermaid.render(id, seg.content); bodyHtml += `<div class="mermaid-svg">${svgText}</div>`; } catch { bodyHtml += `<pre class="mermaid-fallback">${seg.content}</pre>`; }
      } else { bodyHtml += mdToHtml(seg.content); }
    }
    const title = topic.title.replace(/[/\\?%*:|"<>]/g, '_');
    const html = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>${title}</title>\n<style>\n  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px 20px; line-height: 1.8; color: #1e293b; background: #fff; }\n  h1 { font-size: 24px; margin: 20px 0 10px; } h2 { font-size: 20px; margin: 16px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; } h3 { font-size: 17px; margin: 12px 0 6px; } h4, h5 { font-size: 15px; margin: 10px 0 5px; } p { margin: 8px 0; } ul, ol { padding-left: 20px; margin: 8px 0; } li { margin: 3px 0; } code { padding: 2px 5px; background: #f1f5f9; border-radius: 3px; font-size: .9em; } pre { padding: 12px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; overflow-x: auto; font-size: 13px; } pre.mermaid-fallback { background: #fef2f2; border-color: #fca5a5; color: #dc2626; } blockquote { margin: 10px 0; padding: 8px 14px; border-left: 3px solid #60a5fa; background: #f1f5f9; border-radius: 0 6px 6px 0; } table { width: 100%; border-collapse: collapse; margin: 10px 0; } th, td { padding: 6px 10px; border: 1px solid #e2e8f0; } th { background: #f1f5f9; } hr { margin: 20px 0; border: none; border-top: 1px solid #e2e8f0; } a { color: #2563eb; } .mermaid-svg { margin: 16px 0; display: flex; justify-content: center; overflow-x: auto; padding: 16px 8px; background: #fafafa; border: 1px solid #e2e8f0; border-radius: 6px; } .mermaid-svg svg { max-width: 100%; height: auto; } .qa-section { margin-top: 32px; border-top: 2px solid #e2e8f0; padding-top: 16px; } .qa-section h2 { color: #2563eb; } .qa-item { margin: 16px 0; } .qa-question { font-weight: 600; color: #1e293b; padding: 8px 12px; background: #eff6ff; border-radius: 6px; } .qa-answer { padding: 8px 12px 8px 16px; border-left: 3px solid #e2e8f0; margin-left: 4px; } .footer { margin-top: 32px; font-size: 12px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 16px; }\n</style>\n</head>\n<body>\n${bodyHtml}\n<div class="footer">由 Study Assistant 生成</div>\n</body>\n</html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRetry = () => {
    setError(null); setLocalDetail(''); genTriggered.current = false; setGenerating(true);
    api.generateDetail(plan.id, topic.id).catch(() => {});
  };

  const handleRegenerate = async (reason) => {
    setRegenerateDialogOpen(false);
    const currentMode = interactiveMode || 'detail';
    await api.submitFeedback(plan.id, topic.id, reason, currentMode).catch(() => {});
    if (interactiveMode) {
      handleRestartInteractive();
    } else {
      handleRetry();
    }
  };

  const handleDifficulty = async (level) => {
    if (difficultySaving) return;
    setDifficulty(level); setDifficultySaving(true);
    try { await api.updateTopic(plan.id, topic.id, { difficulty: level }); const fresh = await api.getPlan(plan.id); onRefresh(fresh.plan); } catch {}
    setDifficultySaving(false);
  };

  const handleComplete = async () => {
    setRevealLoading(true);
    try {
      const recognized = foundErrorsInput.split(/[\n;；,，]+/).map(s => s.trim()).filter(Boolean);
      const result = await api.revealErrors(plan.id, topic.id, recognized);
      if (result.hasErrors && result.errors?.length > 0) { setRevealErrors(result); setRevealLoading(false); return; }
    } catch {}
    setRevealLoading(false);
    await doComplete();
  };

  const doComplete = async () => {
    try { await api.updateTopic(plan.id, topic.id, { done: true }); const fresh = await api.getPlan(plan.id); onRefresh(fresh.plan); onBack(); } catch { onBack(); }
  };

  const handleDismissReveal = async () => { setRevealErrors(null); await doComplete(); };

  const handleExerciseAnswer = (exerciseIndex, answer) => { setExerciseAnswers(prev => ({ ...prev, [exerciseIndex]: answer })); };

  const handleSubmitExercises = async () => {
    if (exerciseLoading || exercises.length === 0) return;
    setExerciseLoading(true);
    try {
      const answers = Object.entries(exerciseAnswers).map(([idx, answer]) => ({ exerciseIndex: parseInt(idx), userAnswer: answer }));
      const d = await api.submitExercises(plan.id, topic.id, answers);
      setExerciseResults(d.results); setSubmittedExercises(true);
      const fresh = await api.getPlan(plan.id); onRefresh(fresh.plan);
    } catch (err) { alert('提交失败: ' + err.message); } finally { setExerciseLoading(false); }
  };

  const handleToggleReview = async () => {
    if (reviewContent) { const next = !reviewMode; setReviewMode(next); if (next) { setSearchParams({ review: '1' }, { replace: false }); } else { setSearchParams({}, { replace: false }); } return; }
    setReviewLoading(true); setReviewMode(true); setSearchParams({ review: '1' }, { replace: false });
    try {
      const d = await api.generateReview(plan.id, topic.id);
      setReviewContent(d.review);
      const fresh = await api.getPlan(plan.id); onRefresh(fresh.plan);
    } catch (err) { setReviewError(err.message); setReviewMode(false); } finally { setReviewLoading(false); }
  };

  const prerequisites = topic?.prerequisites?.length ? topic.prerequisites.map(id => plan.topics.find(t => t.id === id)).filter(Boolean) : [];
  const childrenTopics = plan.topics.filter(t => t.parentId === topic?.id).sort((a, b) => a.order - b.order);
  const nextTopics = plan.topics.filter(t => t.prerequisites?.includes(topic?.id)).sort((a, b) => a.order - b.order);
  const relatedTopics = topic?.relatedTopics?.length ? topic.relatedTopics.map(id => plan.topics.find(t => t.id === id)).filter(Boolean) : [];

  const handleNavigateToTopic = (targetTopicId) => { onBack(); if (onSelectTopic) onSelectTopic(targetTopicId); };

  const handleFactCheck = async () => {
    if (factCheckLoading || !localDetail) return;
    setFactCheckLoading(true);
    try {
      const d = await api.factCheck(plan.id, topic.id);
      setFactCheckData(d.factCheck || d);
      const fresh = await api.getPlan(plan.id);
      const freshTopic = fresh.plan.topics.find(t => t.id === topic.id);
      if (freshTopic?.factCheck) setFactCheckData(freshTopic.factCheck);
      onRefresh(fresh.plan);
    } catch (err) { alert('事实核查失败: ' + err.message); } finally { setFactCheckLoading(false); }
  };

  const handleFactCheckFix = async () => {
    if (factCheckFixing || !factCheckData?.findings) return;
    const uncertainFindings = factCheckData.findings.filter(f => f.verdict === 'uncertain' || f.verdict === 'likely_wrong' || f.verdict === 'hallucination');
    if (uncertainFindings.length === 0) { alert('没有需要修正的存疑陈述'); return; }
    setFactCheckFixing(true);
    try {
      const d = await api.autoFixFacts(plan.id, topic.id, uncertainFindings);
      if (d.corrected) { setLocalDetail(d.detail); alert(`已修正 ${d.fixedCount} 处内容`); } else { alert('无需修正: ' + (d.message || '修正未能匹配到原文')); }
      const fresh = await api.getPlan(plan.id); onRefresh(fresh.plan);
    } catch (err) { alert('自动修正失败: ' + err.message); } finally { setFactCheckFixing(false); }
  };

  const handleAdaptiveAnalysis = async () => {
    if (adaptiveLoading) return;
    setAdaptiveLoading(true);
    try { const d = await api.adaptiveAnalysis(plan.id); setAdaptiveData(d); } catch (err) { alert('自适应分析失败: ' + err.message); } finally { setAdaptiveLoading(false); }
  };

  const handleExportFormat = (format) => {
    if (!localDetail) return; setShowExportMenu(false);
    const urls = { anki: api.exportAnkiCSV(plan.id, topic.id), opml: api.exportOPML(plan.id, topic.id), notas: api.exportNotionCSV(plan.id), json: api.exportJSON(plan.id, topic.id), notes: api.exportStudyNotes(plan.id, topic.id), bundle: api.exportBundle(plan.id) };
    const url = urls[format]; if (!url) return; window.open(url, '_blank');
  };

  const handleStartInteractive = async (mode) => {
    if (interactiveBusyRef.current) return;
    setSearchParams({ mode }, { replace: false });

    // Check if there's an existing session to resume
    const existingSession = topic?.interactiveSession;
    if (existingSession && existingSession.mode === mode && existingSession.transcript && existingSession.transcript.length > 0 && !existingSession.finished) {
      // Resume existing session
      interactiveBusyRef.current = true;
      setInteractiveMode(mode); setStreamingContent(''); setInteractiveFinished(false); setInteractiveLoading(false);
      const sections = existingSession.transcript.map(entry => ({ content: entry.content || '' }));
      setInteractiveSections(sections);
      if (existingSession.stateMachine) setInteractiveStateMachine(existingSession.stateMachine);
      interactiveBusyRef.current = false;
      return;
    }

    // Start new session
    interactiveBusyRef.current = true;
    setInteractiveMode(mode); setInteractiveSections([]); setStreamingContent(''); setInteractiveFinished(false); setInteractiveLoading(true);
    try {
      let fullContent = ''; let sessionData = null;
      const signal = getAbortSignal();
      await api.startInteractiveSSE(plan.id, topic.id, mode, (event) => {
        if (event.type === 'chunk') { fullContent += event.content; setStreamingContent(fullContent); }
        else if (event.type === 'pause') { setInteractiveSections(prev => [...prev, { content: fullContent }]); setStreamingContent(''); fullContent = ''; }
        else if (event.type === 'done') { if (fullContent && !sessionData) setInteractiveSections(prev => [...prev, { content: fullContent }]); setStreamingContent(''); sessionData = event.session; if (event.session?.stateMachine) setInteractiveStateMachine(event.session.stateMachine); if (event.finished) setInteractiveFinished(true); }
        else if (event.type === 'error') { setInteractiveSections(prev => [...prev, { content: '❌ ' + event.data }]); }
      });
    } catch (err) { setInteractiveSections([{ content: '❌ 启动失败: ' + err.message }]); } finally { setInteractiveLoading(false); interactiveBusyRef.current = false; }
  };

  const handleSendInteractiveFeedback = async () => {
    const feedback = interactiveInput.trim();
    if (!feedback || interactiveBusyRef.current) return;
    await handleContinueInteractive(feedback);
  };

  const handleQuickAction = async (action) => {
    if (interactiveBusyRef.current) return;
    await handleContinueInteractive(action);
  };

  const handleContinueInteractive = async (feedback) => {
    if (!interactiveMode || interactiveBusyRef.current) return;
    interactiveBusyRef.current = true; setInteractiveLoading(true); setInteractiveInput(''); setStreamingContent('');
    try {
      let fullContent = '';
      const signal = getAbortSignal();
      await api.continueInteractiveSSE(plan.id, topic.id, interactiveMode, feedback, (event) => {
        if (event.type === 'chunk') { fullContent += event.content; setStreamingContent(fullContent); }
        else if (event.type === 'pause') { setInteractiveSections(prev => [...prev, { content: fullContent }]); setStreamingContent(''); fullContent = ''; if (event.session?.stateMachine) setInteractiveStateMachine(event.session.stateMachine); }
        else if (event.type === 'done') { if (fullContent) setInteractiveSections(prev => [...prev, { content: fullContent }]); setStreamingContent(''); if (event.session?.stateMachine) setInteractiveStateMachine(event.session.stateMachine); if (event.finished) setInteractiveFinished(true); }
        else if (event.type === 'error') { setInteractiveSections(prev => [...prev, { content: '❌ ' + event.data }]); }
      });
    } catch (err) { setInteractiveSections([{ content: '❌ 响应失败: ' + err.message }]); } finally { setInteractiveLoading(false); interactiveBusyRef.current = false; }
  };

  const handleExitInteractive = () => {
    const wasFeynman = interactiveMode === 'feynman';
    const currentPlanId = plan?.id; const currentTopicId = topic?.id;
    // Check if user actually explained something (more than just the AI's initial greeting)
    const hasUserContent = interactiveSections.length > 1 || (interactiveSections.length === 1 && interactiveSections[0]?.content?.length > 200);
    setInteractiveMode(null); setInteractiveSections([]); setInteractiveFinished(false); setInteractiveInput(''); setInteractiveStateMachine(null);
    setSearchParams({}, { replace: false });
    if (wasFeynman && currentPlanId && currentTopicId && hasUserContent) {
      setFeynmanAnalyzing(true);
      api.analyzeFeynmanSession(currentPlanId, currentTopicId).then(insights => {
        // Only update if the new analysis has real content (not an empty "no content" result)
        if (insights && insights.summary && insights.strengths?.length > 0) {
          setTopic(prev => prev ? { ...prev, feynmanInsights: insights } : prev);
          setTimeout(() => {
            const el = document.getElementById('feynman-insights-section');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 100);
        }
      }).catch(() => {}).finally(() => setFeynmanAnalyzing(false));
    }
  };

  const handleRestartInteractive = async () => {
    const currentPlanId = plan?.id; const currentTopicId = topic?.id;
    const mode = interactiveMode;
    if (!currentPlanId || !currentTopicId || !mode) return;
    try { await api.clearInteractiveSession(currentPlanId, currentTopicId); } catch {}
    // Clear old feynman insights if restarting feynman mode
    if (mode === 'feynman') setTopic(prev => prev ? { ...prev, feynmanInsights: null } : prev);
    setInteractiveSections([]); setInteractiveFinished(false); setInteractiveInput(''); setInteractiveStateMachine(null);
    handleStartInteractive(mode);
  };

  const handleVoiceInput = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { alert('您的浏览器不支持语音输入，请使用 Chrome 或 Edge'); return; }
    if (isRecording) { if (recognitionRef.current) { try { recognitionRef.current.stop(); } catch {} } setIsRecording(false); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN'; recognition.continuous = false; recognition.interimResults = true; recognition.maxAlternatives = 1;
    let finalTranscript = '';
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) { if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript; }
      const latestTranscript = Array.from(event.results).map(r => r[0].transcript).join('');
      setQaInput(latestTranscript);
    };
    recognition.onend = () => { setIsRecording(false); if (finalTranscript.trim()) { setQaInput(finalTranscript.trim()); setTimeout(() => handleAsk(), 50); } };
    recognition.onerror = (event) => { console.error('Speech recognition error:', event.error); setIsRecording(false); if (event.error === 'not-allowed') alert('语音输入需要麦克风权限，请在浏览器设置中允许'); };
    recognitionRef.current = recognition; recognition.start(); setIsRecording(true);
  };

  return (
    <div className='w-full max-w-4xl px-10 py-8 space-y-6'>
      <Helmet><title>study-assistant - {topic.title}</title></Helmet>

      {/* Sentinel: original header position for IntersectionObserver */}
      <div ref={headerSentinelRef} className={headerStuck ? 'h-0 overflow-hidden' : ''}>
        <div className='flex items-center flex-wrap gap-2'>
        <Button variant='ghost' size='sm' onClick={onBack}><ArrowLeft className='h-4 w-4 mr-1' />返回列表</Button>
        <h2 className='text-lg font-semibold flex-1 min-w-0 truncate'>{topic.title}</h2>
        {generating && <span className='inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full'><RotateCcw className='h-3 w-3 animate-spin' />生成中...</span>}
        {error && <span className='inline-flex items-center gap-1 text-xs text-destructive bg-destructive/10 px-2 py-0.5 rounded-full'><AlertCircle className='h-3 w-3' />生成失败</span>}
        {localDetail && !error && !generating && topic.done === false && (
          <Button size='sm' className='bg-green-600 hover:bg-green-700 text-white' onClick={handleComplete} disabled={revealLoading} title='标记为已学完并返回列表'>
            {revealLoading ? <RotateCcw className='h-3.5 w-3.5 mr-1 animate-spin' /> : <CheckCheck className='h-3.5 w-3.5 mr-1' />}
            {revealLoading ? '检查中...' : '学完了'}
          </Button>
        )}
        {localDetail && !error && !generating && topic.done && (
          <Button size='sm' className='bg-indigo-500 hover:opacity-90 text-white' onClick={handleToggleReview} title='复习模式'>
            {reviewLoading ? <RotateCcw className='h-3.5 w-3.5 mr-1 animate-spin' /> : <RotateCcw className='h-3.5 w-3.5 mr-1' />}
            {reviewMode ? '返回讲解' : '复习'}
          </Button>
        )}
        <InteractivePanel
        interactiveMode={interactiveMode}
        interactiveSections={interactiveSections}
        streamingContent={streamingContent}
        interactiveLoading={interactiveLoading}
        interactiveFinished={interactiveFinished}
        interactiveInput={interactiveInput}
        interactiveStateMachine={interactiveStateMachine}
        isRecording={isRecording}
        voiceSupported={voiceSupported}
        onInputChange={setInteractiveInput}
        onQuickAction={handleQuickAction}
        onSendFeedback={handleSendInteractiveFeedback}
        onVoiceInput={handleVoiceInput}
        onExit={handleExitInteractive}
        onRegenerate={() => setRegenerateDialogOpen(true)}
      />

        {localDetail && !error && !interactiveMode && !reviewMode && (
          <div className='flex flex-col' style={{ gap: '144px' }}>
            {topic.imageUrl ? (
            <div className='rounded-lg bg-muted/20 overflow-hidden'>
              <div className='flex items-center justify-between px-4 py-2 bg-muted/50 text-xs text-muted-foreground'>
                  <span>知识点配图</span>
                  <Button variant='ghost' size='sm' className='h-6 px-1.5 text-xs' onClick={() => handleGenerateImage(topic.id)} disabled={generating} title='重新生成配图'><RotateCcw className='h-3 w-3' /></Button>
                </div>
                <img src={topic.imageUrl} alt={topic.title} className='w-full' />
              </div>
            ) : localDetail && !generating && settings.imageApiKey && (
              <div className='flex items-center gap-2'>
                <Button variant='outline' size='sm' onClick={() => handleGenerateImage(topic.id)}><Image className='h-3.5 w-3.5 mr-1' />生成配图</Button>
                <span className='text-xs text-muted-foreground'>使用硅基流动 AI 为知识点生成插图</span>
              </div>
            )}

            <div className='rounded-lg bg-muted/20 px-8 py-6'>
              <div className='reading-content text-sm leading-7'>
                <ContentArea content={strippedDetailMemo} />
              </div>
            </div>
            {!generating && localDetail && (
              <div className='flex justify-end'>
                <Button variant='ghost' size='sm' className='text-xs text-muted-foreground hover:text-foreground' onClick={() => setRegenerateDialogOpen(true)}>
                  <RotateCcw className='h-3 w-3 mr-1' />重新生成
                </Button>
              </div>
            )}
            {generating && <div className='flex items-center gap-1.5 text-xs text-muted-foreground'><RotateCcw className='h-3 w-3 animate-spin' />继续生成中...</div>}

            <div className='rounded-lg bg-muted/20'>
              <div className='flex items-center justify-between px-4 py-3'>
                <h2 className='text-sm font-medium'>扩展讨论</h2>
                {qaList.length > 0 && <span className='text-xs text-muted-foreground'>{qaList.length} 轮</span>}
              </div>
              {qaList.length >= 2 && (
                <div className='flex gap-1.5 px-4 py-2 overflow-x-auto'>
                  {qaList.map((qa, i) => (
                    <div key={i} className='relative'>
                      <button className='text-xs w-6 h-6 rounded-full bg-muted hover:bg-accent transition-colors' onClick={() => scrollToRound(i)} onMouseEnter={() => setHoveredRound(i)} onMouseLeave={() => setHoveredRound(null)} title={qa.question}>
                        {i + 1}
                      </button>
                      {hoveredRound === i && (
                        <div className='absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 p-2 rounded-md border bg-popover text-xs shadow-md z-10'>
                          <div className='font-medium mb-0.5'>追问 {i + 1}</div>
                          <div className='text-muted-foreground truncate'>{qa.question}</div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className='max-h-80 overflow-y-auto p-4 mx-auto max-w-4xl' ref={chatPanelRef}>
                <QaMessages qaList={qaList} />
              </div>
              <div className='p-4'>
                <form onSubmit={e => { e.preventDefault(); }} className='flex gap-2'>
                  <textarea ref={qaInputRef} value={qaInput} onChange={e => setQaInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(); } }} placeholder='输入你的追问...（Shift+Enter 换行，Enter 发送）' disabled={qaLoading} rows={1} onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }} className='flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none' />
                  <Button type='button' onClick={handleAsk} disabled={!qaInput.trim() || qaLoading} size='icon'>
                    {qaLoading ? <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' /> : <SendHorizonal className='h-4 w-4' />}
                  </Button>
                </form>
              </div>
            </div>

            {!generating && !reviewMode && exercises.length > 0 && !submittedExercises && (
              <div className='pt-4 space-y-6'>
                <h3 className='text-sm font-medium'>练习题</h3>
                {exercises.map((ex, i) => (
                  <div key={i} className='rounded-md bg-muted/20 p-4 space-y-3'>
                    <div className='flex items-center gap-1.5 text-xs'>
                      <span className='font-medium'>练习题 {i + 1}</span>
                      <span className={`px-1.5 py-0.5 rounded ${ex.type === 'choice' ? 'bg-primary/10 text-primary' : 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300'}`}>{ex.type === 'choice' ? '选择题' : '简答题'}</span>
                      {ex.conceptTag && <span className='px-1.5 py-0.5 rounded bg-muted text-muted-foreground'>{ex.conceptTag}</span>}
                    </div>
                    <p className='text-sm'>{ex.question}</p>
                    {ex.type === 'choice' && ex.options && ex.options.length > 0 ? (
                      <div className='space-y-1'>
                        {ex.options.map((opt, oi) => (
                          <label key={oi} className={`flex items-center gap-2 px-2.5 py-1.5 rounded text-sm cursor-pointer transition-colors ${exerciseAnswers[i] === opt.charAt(0) ? 'bg-primary/10 border border-primary/30' : 'border border-transparent hover:bg-accent'}`}>
                            <input type='radio' name={'ex-' + i} value={opt.charAt(0)} checked={exerciseAnswers[i] === opt.charAt(0)} onChange={() => handleExerciseAnswer(i, opt.charAt(0))} className='accent-primary' />
                            <span>{opt}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <textarea className='w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' placeholder='输入你的答案...' value={exerciseAnswers[i] || ''} onChange={e => handleExerciseAnswer(i, e.target.value)} rows={3} />
                    )}
                  </div>
                ))}
                <Button onClick={handleSubmitExercises} disabled={exerciseLoading || Object.keys(exerciseAnswers).length === 0}>
                  {exerciseLoading ? <RotateCcw className='h-4 w-4 mr-1 animate-spin' /> : <SendHorizonal className='h-4 w-4 mr-1' />}
                  {exerciseLoading ? '批改中...' : '提交答案'}
                </Button>
              </div>
            )}

            {!generating && !reviewMode && submittedExercises && exerciseResults && (
              <div className='pt-4 space-y-3'>
                <h3 className='text-sm font-medium'>练习结果</h3>
                {exerciseResults.map((res, i) => (
                  <div key={i} className={`border rounded-md p-3 text-sm ${res.correct ? 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30' : 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30'}`}>
                    <div className='flex items-center gap-1.5 mb-1'>
                      <span>{res.correct ? '✅' : '❌'}</span>
                      <span className='font-medium'>练习题 {i + 1}</span>
                    </div>
                    <p className='text-xs text-muted-foreground'><strong>你的答案：</strong>{res.userAnswer || '未作答'}{!res.correct && <><br /><strong>正确答案：</strong>{res.correctAnswer}</>}</p>
                    {res.explanation && <p className='text-xs text-muted-foreground mt-1'>{res.explanation}</p>}
                  </div>
                ))}
              </div>
            )}

            {feynmanAnalyzing && (!topic?.feynmanInsights || !topic.feynmanInsights.summary) && (
              <div id='feynman-insights-section' className='pt-4 flex items-center gap-2 text-sm text-muted-foreground'>
                <div className='animate-spin rounded-full h-4 w-4 border-2 border-purple-500 border-t-transparent' />
                <span>AI 正在分析你的费曼讲解...</span>
              </div>
            )}

            {topic?.feynmanInsights && topic.feynmanInsights.summary && topic.feynmanInsights.strengths?.length > 0 ? (
              <div id='feynman-insights-section' className='pt-4'>
                <button onClick={() => setFeynmanInsightsOpen(!feynmanInsightsOpen)} className='flex items-center gap-2 w-full text-left'>
                  <Brain className='h-4 w-4 text-purple-500' />
                  <h3 className='text-sm font-medium'>费曼教学评估报告</h3>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    topic.feynmanInsights.teachingQuality === 'excellent' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' :
                    topic.feynmanInsights.teachingQuality === 'good' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' :
                    topic.feynmanInsights.teachingQuality === 'fair' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' :
                    'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                  }`}>
                    {topic.feynmanInsights.teachingQuality === 'excellent' ? '优秀' : topic.feynmanInsights.teachingQuality === 'good' ? '良好' : topic.feynmanInsights.teachingQuality === 'fair' ? '一般' : topic.feynmanInsights.teachingQuality === 'needsWork' ? '需改进' : '未评估'}
                  </span>
                  {feynmanInsightsOpen ? <ChevronDown className='h-4 w-4 text-muted-foreground' /> : <ChevronRight className='h-4 w-4 text-muted-foreground' />}
                </button>
                {feynmanInsightsOpen && (
                  <div className='mt-3 space-y-4 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20 p-4'>
                    <p className='text-sm text-muted-foreground'>{topic.feynmanInsights.summary}</p>
                    {topic.feynmanInsights.strengths?.length > 0 && (
                      <div className='space-y-1'>
                        <h4 className='text-xs font-medium text-green-600 flex items-center gap-1'><CheckCircle className='h-3 w-3' />讲得好的地方</h4>
                        <ul className='text-sm text-muted-foreground list-disc pl-4 space-y-1'>{topic.feynmanInsights.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                      </div>
                    )}
                    {topic.feynmanInsights.gaps?.length > 0 && (
                      <div className='space-y-1'>
                        <h4 className='text-xs font-medium text-orange-600 flex items-center gap-1'><AlertTriangle className='h-3 w-3' />教材遗漏的重要内容</h4>
                        <ul className='text-sm text-muted-foreground list-disc pl-4 space-y-1'>{topic.feynmanInsights.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
                      </div>
                    )}
                    {topic.feynmanInsights.lingeringQuestions?.length > 0 && (
                      <div className='space-y-2'>
                        <h4 className='text-xs font-medium flex items-center gap-1'><Lightbulb className='h-3 w-3' />学生听完后还会问的问题</h4>
                        <p className='text-xs text-muted-foreground'>试试看你能不能回答这些问题——这才是费曼学习法的核心</p>
                        <div className='space-y-2'>{topic.feynmanInsights.lingeringQuestions.map((q, i) => (
                          <div key={i} className='rounded-md bg-background/80 border p-3 text-sm space-y-1'>
                            <div>❓ {q.question}</div>
                            {q.whyThisMatters && <div className='text-xs text-muted-foreground'>为什么重要：{q.whyThisMatters}</div>}
                            {q.relatedTopic && <div className='text-xs text-muted-foreground'>关联：{q.relatedTopic}</div>}
                          </div>
                        ))}</div>
                      </div>
                    )}
                    {topic.feynmanInsights.sparklingExplanations?.length > 0 && (
                      <div className='space-y-2'>
                        <h4 className='text-xs font-medium flex items-center gap-1'><Sparkles className='h-3 w-3' />可以直接当作教材的精彩讲解</h4>
                        {topic.feynmanInsights.sparklingExplanations.map((note, i) => (
                          <blockquote key={i} className='border-l-2 border-purple-400 pl-3 text-sm text-muted-foreground italic bg-background/60 rounded-r p-2'>{note.content}</blockquote>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null}

            {topic?.feynmanHistory && topic.feynmanHistory.length > 0 && (
              <div className='pt-2'>
                <button onClick={() => setFeynmanHistoryOpen(!feynmanHistoryOpen)} className='flex items-center gap-2 w-full text-left text-sm text-muted-foreground hover:text-foreground transition-colors'>
                  <List className='h-3.5 w-3.5' />
                  <span>历史记录（{topic.feynmanHistory.length} 次）</span>
                  {feynmanHistoryOpen ? <ChevronDown className='h-3.5 w-3.5 ml-auto' /> : <ChevronRight className='h-3.5 w-3.5 ml-auto' />}
                </button>
                {feynmanHistoryOpen && (
                  <div className='mt-2 space-y-2'>
                    {topic.feynmanHistory.slice().reverse().map((entry, i) => (
                      <div key={i} className='rounded-md border p-3 text-sm space-y-1'>
                        <div className='flex items-center justify-between'>
                          <span className='text-xs text-muted-foreground'>{new Date(entry.timestamp).toLocaleString('zh-CN')}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            entry.insights?.teachingQuality === 'excellent' ? 'bg-green-100 text-green-700' :
                            entry.insights?.teachingQuality === 'good' ? 'bg-blue-100 text-blue-700' :
                            entry.insights?.teachingQuality === 'fair' ? 'bg-yellow-100 text-yellow-700' :
                            'bg-red-100 text-red-700'
                          }`}>
                            {entry.insights?.teachingQuality === 'excellent' ? '优秀' : entry.insights?.teachingQuality === 'good' ? '良好' : entry.insights?.teachingQuality === 'fair' ? '一般' : '需改进'}
                          </span>
                        </div>
                        <p className='text-muted-foreground text-xs'>{entry.insights?.summary}</p>
                        {entry.insights?.strengths?.length > 0 && (
                          <p className='text-xs'><span className='text-green-600'>亮点：</span>{entry.insights.strengths[0]}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!generating && (
              <div className='pt-4 space-y-2'>
                <p className='text-sm text-muted-foreground'>这个知识点对你来说？</p>
                <div className='flex gap-2'>
                  {['easy', 'medium', 'hard'].map(level => {
                    const labels = { easy: '简单', medium: '适中', hard: '困难' };
                    return (
                      <Button key={level} variant={difficulty === level ? 'default' : 'outline'} size='sm' onClick={() => handleDifficulty(level)} disabled={difficultySaving}>
                        {labels[level]}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className='space-y-1.5'>
              <label className='text-sm text-muted-foreground' htmlFor='found-errors-input'>你在讲解中发现了哪些错误？（选填，每行一条，点"学完了"后会核对）</label>
              <textarea id='found-errors-input' className='w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' rows={2} placeholder='例如：边界条件应该是 <= 而不是 <' value={foundErrorsInput} onChange={e => setFoundErrorsInput(e.target.value)} />
            </div>

            {factCheckData && (
              <div className='pt-4 space-y-3'>
                <div className='flex items-center justify-between'>
                  <h3 className='text-sm font-medium'>事实核查结果</h3>
                  <Button variant='ghost' size='sm' onClick={() => setFactCheckData(null)}><X className='h-3.5 w-3.5' /></Button>
                </div>
                {factCheckData.overallScore !== undefined && (
                  <p className='text-sm'>可信度评分：<strong>{Math.round(factCheckData.overallScore * 100)}%</strong> · <span className={`font-semibold ${factCheckData.verdict === 'trusted' ? 'text-green-600' : factCheckData.verdict === 'caution' ? 'text-amber-500' : 'text-red-600'}`}>{factCheckData.verdict === 'trusted' ? '可信' : factCheckData.verdict === 'caution' ? '需注意' : factCheckData.verdict === 'unreliable' ? '不可靠' : '有误'}</span></p>
                )}
                {factCheckData.summary && <p className='text-sm text-muted-foreground'>{typeof factCheckData.summary === 'string' ? factCheckData.summary : ''}</p>}
                {factCheckData.findings && factCheckData.findings.length > 0 && (
                  <div className='space-y-2'>
                    {factCheckData.findings.map((f, i) => (
                      <div key={i} className='border-l-4 rounded-md border p-3 text-sm' style={{ borderLeftColor: f.verdict === 'confirmed' || f.verdict === 'likely_correct' ? '#22c55e' : f.verdict === 'uncertain' ? '#f59e0b' : '#ef4444' }}>
                        <strong>陈述 {i + 1}：</strong>{f.claim || f.location}
                        <span className='ml-2 text-xs text-muted-foreground'>[{f.dimension}] 置信度: {Math.round((f.confidence || 0.5) * 100)}%</span>
                        {f.explanation && <p className='mt-1 text-xs text-muted-foreground'>{f.explanation}</p>}
                        {f.correction && <p className='mt-1 text-xs text-green-600'>修正建议: {f.correction}</p>}
                      </div>
                    ))}
                  </div>
                )}
                {factCheckData.findings && factCheckData.findings.some(f => f.verdict === 'uncertain' || f.verdict === 'likely_wrong' || f.verdict === 'hallucination') && (
                  <Button size='sm' className='bg-amber-500 hover:bg-amber-600 text-white' onClick={handleFactCheckFix} disabled={factCheckFixing}>
                    {factCheckFixing ? <RotateCcw className='h-3.5 w-3.5 mr-1 animate-spin' /> : <Wrench className='h-3.5 w-3.5 mr-1' />}
                    {factCheckFixing ? '修正中...' : '自动修正存疑内容'}
                  </Button>
                )}
              </div>
            )}

            {adaptiveData && (
              <div className='pt-4 space-y-3'>
                <div className='flex items-center justify-between'>
                  <h3 className='text-sm font-medium'>自适应学习分析</h3>
                  <Button variant='ghost' size='sm' onClick={() => setAdaptiveData(null)}><X className='h-3.5 w-3.5' /></Button>
                </div>
                {adaptiveData.summary && (
                  <div className='bg-muted/50 rounded-md p-3 space-y-1'>
                    {adaptiveData.summary.stateMachine && (
                      <div className='flex flex-wrap gap-2 text-sm'>
                        <span><strong>错误状态机：</strong>总概念 {adaptiveData.summary.stateMachine.totalConcepts} 个</span>
                        <span className='text-red-500'>需干预 {adaptiveData.summary.stateMachine.interventionNeeded} 个</span>
                        <span className='text-amber-500'>观察中 {adaptiveData.summary.stateMachine.watching} 个</span>
                        <span className='text-green-500'>已解决 {adaptiveData.summary.stateMachine.resolved} 个</span>
                      </div>
                    )}
                    {adaptiveData.summary.interventionCount !== undefined && <p className='text-xs text-muted-foreground'>推荐操作数：{adaptiveData.summary.interventionCount}</p>}
                  </div>
                )}
                {adaptiveData.recommendations && adaptiveData.recommendations.length > 0 && (
                  <div className='space-y-2'>
                    <h4 className='text-xs font-medium'>学习建议</h4>
                    {adaptiveData.recommendations.map((rec, i) => (
                      <div key={i} className='border-l-4 rounded-md border p-3 text-sm' style={{ borderLeftColor: rec.urgency === 'critical' ? '#ef4444' : rec.urgency === 'high' ? '#f59e0b' : rec.urgency === 'medium' ? '#3b82f6' : '#22c55e' }}>
                        <strong>{rec.topicTitle}</strong> <span className={`text-xs ${rec.urgency === 'critical' ? 'text-red-500' : rec.urgency === 'high' ? 'text-amber-500' : 'text-muted-foreground'}`}>[{rec.urgency}] {rec.errorCount} 个错误</span>
                        {rec.suggestions && rec.suggestions.length > 0 && (
                          <div className='flex flex-wrap gap-1 mt-1'>
                            {rec.suggestions.map((s, j) => <span key={j} className='text-xs px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'>{s}</span>)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className='flex justify-center pt-2'>
              <Button size='lg' className='bg-green-600 hover:bg-green-700 text-white min-w-[200px]' onClick={handleComplete} disabled={revealLoading} title='标记为已学完并返回列表'>
                {revealLoading ? <RotateCcw className='h-4 w-4 mr-2 animate-spin' /> : <CheckCheck className='h-4 w-4 mr-2' />}
                {revealLoading ? '检查错误中...' : '学完了，返回列表'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Review mode content — rendered outside the main content block so it's visible when reviewMode=true */}
      {reviewMode && (
        <div className='px-8 pt-4'>
          {reviewLoading && (
            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
              <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' />
              <span>AI 正在生成复习内容，针对你的薄弱点进行巩固...</span>
            </div>
          )}
          {!generating && reviewContent && !reviewLoading && (
            <div>
              <ContentArea content={reviewContent} />
            </div>
          )}
        </div>
      )}
      </div>

      <RegenerateDialog open={regenerateDialogOpen} onClose={() => setRegenerateDialogOpen(false)} onSubmit={handleRegenerate} />
    </div>
  );
}
