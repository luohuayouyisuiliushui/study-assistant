import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, RotateCcw, Sparkles, CheckCheck, AlertTriangle, ChevronDown, ChevronRight, MessageSquare, SendHorizonal, Image, Wrench, Mic, X, Lightbulb, Brain, CheckCircle, AlertCircle, List, MoreHorizontal, Undo2 } from 'lucide-react';
import { Button } from '#/components/ui/button';
import api from '../api';
import RegenerateDialog from './RegenerateDialog';
import { ContentArea, QaMessages } from './TopicDetailShared.jsx';
import AIStatusIndicator from './AIStatus.jsx';
import InteractivePanel from './InteractivePanel.jsx';
import ExercisePanel from './ExercisePanel.jsx';
import MistakePanel from './MistakePanel.jsx';
import QAPanel from './QAPanel.jsx';
import ActionMenu from './ActionMenu.jsx';
import { loadSettings } from '#/lib/settings-storage';

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

function getUsableReviewSession(topic, { kind = 'review', mistakeId = null } = {}) {
  const session = topic?.reviewSession;
  const mistakeMatches = kind !== 'repair' || session?.mistakeId === mistakeId;
  return session?.kind === kind
    && mistakeMatches
    && Array.isArray(session.exercises)
    && session.exercises.length > 0
    ? session
    : null;
}

function formatReviewDate(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatReviewDateTime(timestamp) {
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

export default function TopicDetail({ plan, topic, onBack, onRefresh, onSelectTopic }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlMode = searchParams.get('mode');
  const urlReview = searchParams.get('review') === '1';
  const urlRepair = searchParams.get('repair');
  const practiceKind = urlRepair ? 'repair' : 'review';
  const practiceMistakeId = urlRepair || null;
  const practiceContextKey = `${topic?.id || ''}:${practiceKind}:${practiceMistakeId || ''}`;
  const [qaList, setQaList] = useState([]);
  const [qaLoading, setQaLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [localDetail, setLocalDetail] = useState(topic?.detail || '');
  const chatPanelRef = useRef(null);
  const genTriggered = useRef(false);
  const startTimeRef = useRef(Date.now());
  const hiddenDurationRef = useRef(0);
  const hiddenStartRef = useRef(null);
  const [difficulty, setDifficulty] = useState(topic?.difficulty || null);
  const headerSentinelRef = useRef(null);
  const [headerStuck, setHeaderStuck] = useState(false);
  const [headerStuckVisible, setHeaderStuckVisible] = useState(false);
  const relationsInferredRef = useRef(false);
  const [difficultySaving, setDifficultySaving] = useState(false);
  const [hoveredRound, setHoveredRound] = useState(null);
  const [revealErrors, setRevealErrors] = useState(null);
  const [revealLoading, setRevealLoading] = useState(false);
  const [foundErrorsInput, setFoundErrorsInput] = useState('');
  const lastReportedRef = useRef(0);
  const settings = loadSettings();

  const [exercises, setExercises] = useState([]);
  const [exerciseAnswers, setExerciseAnswers] = useState({});
  const [exerciseResults, setExerciseResults] = useState(null);
  const [exerciseLoading, setExerciseLoading] = useState(false);
  const [submittedExercises, setSubmittedExercises] = useState(false);
  const exerciseAttemptRef = useRef(null);

  const initialReviewSession = getUsableReviewSession(topic, {
    kind: practiceKind,
    mistakeId: practiceMistakeId,
  });
  const reviewSessionContextRef = useRef(practiceContextKey);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewSession, setReviewSession] = useState(initialReviewSession);
  const [reviewContent, setReviewContent] = useState(initialReviewSession?.content || topic?.reviewGenerated || null);
  const [reviewAnswers, setReviewAnswers] = useState({});
  const [reviewResults, setReviewResults] = useState(null);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [reviewQuality, setReviewQuality] = useState(null);
  const [reviewScheduleDetails, setReviewScheduleDetails] = useState(null); // {intervalDays, easeFactor, repetitions}
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const [nextReviewAt, setNextReviewAt] = useState(null);
  const [repairMistake, setRepairMistake] = useState(() => (
    practiceMistakeId
      ? topic?.mistakes?.find(mistake => mistake.id === practiceMistakeId) || null
      : null
  ));
  const reviewLoadBusyRef = useRef(false);
  const reviewSubmitBusyRef = useRef(false);
  const reviewAttemptRef = useRef(null);
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false);

  const [interactiveMode, setInteractiveMode] = useState(null);
  const [interactiveSections, setInteractiveSections] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [interactiveLoading, setInteractiveLoading] = useState(false);
  const [interactiveFinished, setInteractiveFinished] = useState(false);
  const [interactiveInput, setInteractiveInput] = useState('');
  const [interactiveStateMachine, setInteractiveStateMachine] = useState(null);
  const interactiveBusyRef = useRef(false);

  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef(null);
  const [voiceSupported, setVoiceSupported] = useState(true);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const fixedMenuRef = useRef(null);
  const menuTriggerRef = useRef(null);
  const actionMenuId = `topic-action-menu-${topic?.id || 'current'}`;

  const closeActionMenu = () => {
    setMenuOpen(false);
    requestAnimationFrame(() => menuTriggerRef.current?.focus());
  };

  const toggleActionMenu = (event) => {
    menuTriggerRef.current = event.currentTarget;
    setMenuOpen(open => !open);
  };

  const handleActionMenuTriggerKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      menuTriggerRef.current = event.currentTarget;
      setMenuOpen(true);
    }
  };

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

  const [resources, setResources] = useState(topic?.resources || null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourceRatings, setResourceRatings] = useState(() => {
    // Pre-populate from persisted userRating on resources
    const initial = {};
    (topic?.resources || []).forEach((r, i) => {
      if (r.userRating === 1 || r.userRating === 'up') initial[i] = 1;
      if (r.userRating === -1 || r.userRating === 'down') initial[i] = -1;
    });
    return initial;
  });
  const [resourceRatingError, setResourceRatingError] = useState(null);
  const [feedbackHistoryOpen, setFeedbackHistoryOpen] = useState(false);
  const [feynmanInsights, setFeynmanInsights] = useState(topic?.feynmanInsights || null);
  const [feynmanInsightsOpen, setFeynmanInsightsOpen] = useState(true);
  const [feynmanAnalyzing, setFeynmanAnalyzing] = useState(false);
  const [feynmanHistoryOpen, setFeynmanHistoryOpen] = useState(false);

  const [imageGenerating, setImageGenerating] = useState(false);
  const [imageError, setImageError] = useState(null);

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

  useEffect(() => {
    if (reviewSessionContextRef.current === practiceContextKey) return;
    const session = getUsableReviewSession(topic, {
      kind: practiceKind,
      mistakeId: practiceMistakeId,
    });
    reviewSessionContextRef.current = practiceContextKey;
    setReviewSession(session);
    setReviewContent(session?.content || (practiceKind === 'review' ? topic?.reviewGenerated : null) || null);
    setReviewAnswers({});
    setReviewResults(null);
    setReviewSubmitted(false);
    setReviewQuality(null);
    setReviewScheduleDetails(null);
    setReviewError(null);
    setNextReviewAt(null);
    setRepairMistake(practiceMistakeId
      ? topic?.mistakes?.find(mistake => mistake.id === practiceMistakeId) || null
      : null);
    reviewLoadBusyRef.current = false;
    reviewSubmitBusyRef.current = false;
    reviewAttemptRef.current = null;
  }, [practiceContextKey, practiceKind, practiceMistakeId, topic, topic?.mistakes, topic?.reviewGenerated]);

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

  const activeReviewSession = reviewSessionContextRef.current === practiceContextKey ? reviewSession : null;
  const activeReviewContent = reviewSessionContextRef.current === practiceContextKey ? reviewContent : null;
  const activeRepairMistake = practiceKind === 'repair'
    ? repairMistake || topic?.mistakes?.find(mistake => mistake.id === practiceMistakeId) || null
    : null;

  const applyReviewSession = useCallback((session, fallbackContent = '') => {
    const mistakeMatches = practiceKind !== 'repair' || session?.mistakeId === practiceMistakeId;
    if (session?.kind !== practiceKind
      || !mistakeMatches
      || !Array.isArray(session.exercises)
      || session.exercises.length === 0) {
      throw new Error(practiceKind === 'repair' ? '错题修复会话无效' : '复习会话缺少可作答练习');
    }
    reviewSessionContextRef.current = practiceContextKey;
    setReviewSession(session);
    setReviewContent(session.content || fallbackContent);
    setReviewAnswers({});
    setReviewResults(null);
    setReviewSubmitted(false);
    setReviewQuality(null);
    setReviewScheduleDetails(null);
    setNextReviewAt(null);
    reviewAttemptRef.current = null;
  }, [practiceContextKey, practiceKind, practiceMistakeId]);

  const ensureReviewSession = useCallback(async () => {
    const persistedSession = getUsableReviewSession(topic, {
      kind: practiceKind,
      mistakeId: practiceMistakeId,
    });
    const availableSession = activeReviewSession || persistedSession;
    if (availableSession) {
      if (activeReviewSession?.id !== availableSession.id) {
        applyReviewSession(
          availableSession,
          availableSession.content || (practiceKind === 'review' ? topic?.reviewGenerated : '') || ''
        );
      }
      setReviewError(null);
      return availableSession;
    }
    if (reviewLoadBusyRef.current) return null;

    reviewLoadBusyRef.current = true;
    setReviewLoading(true);
    setReviewError(null);
    try {
      const response = practiceKind === 'repair'
        ? await api.generateMistakeRepair(plan.id, topic.id, practiceMistakeId)
        : await api.generateReview(plan.id, topic.id);
      applyReviewSession(response.reviewSession, response.review || '');
      if (practiceKind === 'repair') setRepairMistake(response.mistake || null);
      try {
        const fresh = await api.getPlan(plan.id);
        onRefresh(fresh.plan);
      } catch {}
      return response.reviewSession;
    } catch (err) {
      const fallback = practiceKind === 'repair' ? '无法生成错题修复' : '无法生成复习';
      setReviewError(`生成失败：${err?.message || fallback}`);
      return null;
    } finally {
      setReviewLoading(false);
      reviewLoadBusyRef.current = false;
    }
  }, [
    activeReviewSession,
    applyReviewSession,
    onRefresh,
    plan.id,
    practiceKind,
    practiceMistakeId,
    topic,
  ]);

  useEffect(() => {
    if (urlReview || urlRepair) {
      setReviewMode(true);
      ensureReviewSession();
    } else {
      setReviewMode(false);
    }
  }, [ensureReviewSession, urlRepair, urlReview]);

  // Sticky header: detect when sentinel scrolls out of view
  useEffect(() => {
    const sentinel = headerSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setHeaderStuck(!entry.isIntersecting);
        // Add a small delay for the fade-in animation
        if (!entry.isIntersecting) {
          requestAnimationFrame(() => setHeaderStuckVisible(true));
        } else {
          setHeaderStuckVisible(false);
        }
      },
      { threshold: 0, rootMargin: '-1px 0px 0px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Auto-infer topic relationships when viewing a topic with no relationship data
  useEffect(() => {
    if (!plan || !topic || relationsInferredRef.current) return;
    if (plan.relationsInferredAt) { relationsInferredRef.current = true; return; }

    // Skip if any topic already has relationship data (e.g. from AI import)
    const hasAnyRelations = plan.topics.some(t =>
      (t.prerequisites && t.prerequisites.length > 0) ||
      (t.relatedTopics && t.relatedTopics.length > 0) ||
      t.parentId
    );
    if (hasAnyRelations) { relationsInferredRef.current = true; return; }

    // Fire inference — don't await, don't block UI
    relationsInferredRef.current = true;
    api.inferRelations(plan.id).then(() => {
      // Refresh plan data after inference completes
      api.getPlan(plan.id).then(fresh => {
        if (fresh.plan) onRefresh(fresh.plan);
      }).catch(() => {});
    }).catch(() => {
      // Silent failure — allow retry on next mount
      relationsInferredRef.current = false;
    });
  }, [plan?.id, topic?.id]);

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
    exerciseAttemptRef.current = null;
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
    setImageGenerating(true);
    setImageError(null);
    try {
      await api.generateTopicImage(plan.id, topicId);
      const fresh = await api.getPlan(plan.id);
      if (fresh.plan) {
        onRefresh(fresh.plan);
        const t = fresh.plan.topics.find(t => t.id === topicId);
        if (t?.imageUrl) setLocalDetail(t.detail || localDetail);
      }
    } catch (err) {
      setImageError(err.message || '生成配图失败');
    } finally {
      setImageGenerating(false);
    }
  };

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

  if (!topic) return null;

  const handleAsk = async (question) => {
    if (!question || qaLoading) return;
    setQaLoading(true);
    setQaList(prev => [...prev, { question, answer: '...' }]);
    try {
      const d = await api.askQuestion(plan.id, topic.id, question);
      setQaList(prev => { const list = [...prev]; list[list.length - 1] = { question, answer: d.answer }; return list; });
      requestAnimationFrame(() => { if (chatPanelRef.current) chatPanelRef.current.scrollTop = chatPanelRef.current.scrollHeight; });
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
      setTimeout(() => 0, 100);
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

  const handleExportHtml = () => {
    if (!localDetail) return;
    window.open(api.exportHTML(plan.id, topic.id), '_blank');
  };

  const handleRetry = () => {
    setError(null); setLocalDetail(''); genTriggered.current = false; setGenerating(true);
    api.generateDetail(plan.id, topic.id).catch(() => {});
  };

  // Stop waiting for generation (server-side generation continues in background;
  // the completed content will appear automatically on next visit / refresh).
  const handleCancelGenerate = () => {
    setGenerating(false);
    genTriggered.current = false;
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

  const handleUndone = async () => {
    try {
      const result = await api.undoneTopic(plan.id, topic.id);
      onRefresh(result.plan);
    } catch (err) { alert('撤销失败: ' + err.message); }
  };

  const handleExerciseAnswer = (exerciseIndex, answer) => {
    exerciseAttemptRef.current = null;
    setExerciseAnswers(prev => ({ ...prev, [exerciseIndex]: answer }));
  };

  const handleSubmitExercises = async () => {
    if (exerciseLoading || exercises.length === 0) return;
    setExerciseLoading(true);
    try {
      const answers = Object.entries(exerciseAnswers).map(([idx, answer]) => ({ exerciseIndex: parseInt(idx), userAnswer: answer }));
      const attemptRef = exerciseAttemptRef.current || api.createAttemptRef('exercise');
      exerciseAttemptRef.current = attemptRef;
      const d = await api.submitExercises(plan.id, topic.id, answers, attemptRef);
      setExerciseResults(d.results); setSubmittedExercises(true);
      const fresh = await api.getPlan(plan.id); onRefresh(fresh.plan);
      exerciseAttemptRef.current = null;
    } catch (err) { alert('提交失败: ' + err.message); } finally { setExerciseLoading(false); }
  };

  const handleReviewAnswer = (exerciseIndex, answer) => {
    reviewAttemptRef.current = null;
    setReviewError(null);
    setReviewAnswers(prev => ({ ...prev, [exerciseIndex]: answer }));
  };

  const handleSubmitReview = async () => {
    if (reviewSubmitBusyRef.current || !activeReviewSession?.exercises?.length) return;
    const answers = Object.entries(reviewAnswers).map(([idx, answer]) => ({
      exerciseIndex: parseInt(idx),
      userAnswer: answer,
    }));
    if (answers.length === 0) return;

    reviewSubmitBusyRef.current = true;
    setReviewSubmitting(true);
    setReviewError(null);
    const attemptRef = reviewAttemptRef.current || api.createAttemptRef(practiceKind);
    reviewAttemptRef.current = attemptRef;
    try {
      const response = practiceKind === 'repair'
        ? await api.submitRepairExercises(
          plan.id,
          topic.id,
          practiceMistakeId,
          answers,
          activeReviewSession.id,
          attemptRef
        )
        : await api.submitReviewExercises(
          plan.id,
          topic.id,
          answers,
          activeReviewSession.id,
          attemptRef
        );
      setReviewResults(response.results || []);
      setReviewSubmitted(true);
      setReviewQuality(response.reviewSchedule?.lastQuality ?? null);
      setReviewScheduleDetails(response.reviewSchedule ? {
        intervalDays: response.reviewSchedule.intervalDays ?? null,
        easeFactor: response.reviewSchedule.easeFactor ?? null,
        repetitions: response.reviewSchedule.repetitions ?? null,
      } : null);
      setNextReviewAt(response.nextReviewAt ?? response.reviewSchedule?.dueAt ?? null);
      if (practiceKind === 'repair') setRepairMistake(response.mistake || null);
      reviewAttemptRef.current = null;
      window.dispatchEvent(new CustomEvent('today-review-refresh'));
      // P2-4: auto-run adaptive analysis after review so recommendations surface immediately
      if (practiceKind === 'review') {
        api.adaptiveAnalysis(plan.id).then(d => setAdaptiveData(d)).catch(() => {});
      }
      try {
        const fresh = await api.getPlan(plan.id);
        onRefresh(fresh.plan);
      } catch {}
    } catch (err) {
      const fallback = practiceKind === 'repair' ? '无法提交错题修复' : '无法提交复习';
      setReviewError(`提交失败：${err?.message || fallback}`);
    } finally {
      reviewSubmitBusyRef.current = false;
      setReviewSubmitting(false);
    }
  };

  const handleRetryRepairAnswers = () => {
    setReviewAnswers({});
    setReviewResults(null);
    setReviewSubmitted(false);
    setReviewQuality(null);
    setReviewScheduleDetails(null);
    setReviewError(null);
    reviewAttemptRef.current = null;
  };

  const handleToggleReview = () => {
    const nextParams = new URLSearchParams(searchParams);
    if (reviewMode) {
      nextParams.delete('review');
      nextParams.delete('repair');
    } else {
      nextParams.delete('repair');
      nextParams.set('review', '1');
    }
    setSearchParams(nextParams, { replace: false });
  };

  const handleStartMistakeRepair = (mistakeId) => {
    if (!mistakeId) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('mode');
    nextParams.delete('review');
    nextParams.set('repair', mistakeId);
    setSearchParams(nextParams, { replace: false });
  };

  const handleMistakeChanged = async () => {
    try {
      const fresh = await api.getPlan(plan.id);
      onRefresh(fresh.plan);
    } catch {}
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

  const handleRecommendResources = async () => {
    if (resourcesLoading || !localDetail) return;
    setResourcesLoading(true);
    try {
      const d = await api.recommendResources(plan.id, topic.id);
      setResources(d.resources || []);
      setResourceRatings({});
      const fresh = await api.getPlan(plan.id); onRefresh(fresh.plan);
    } catch (err) { alert('资源推荐失败: ' + err.message); } finally { setResourcesLoading(false); }
  };

  const handleRateResource = async (idx, rating) => {
    const prev = resourceRatings[idx];
    const newRating = prev === rating ? null : rating; // toggle off if same
    setResourceRatingError(null);
    setResourceRatings(r => ({ ...r, [idx]: newRating }));
    try {
      await api.rateResource(plan.id, topic.id, idx, newRating);
    } catch (err) {
      setResourceRatings(r => ({ ...r, [idx]: prev })); // rollback on error
      setResourceRatingError(err?.message || '资源评分保存失败，请稍后重试');
    }
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
          setFeynmanInsights(insights);
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
    if (mode === 'feynman') setFeynmanInsights(null);
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
      setInteractiveInput(latestTranscript);
    };
    recognition.onend = () => {
      setIsRecording(false);
      if (finalTranscript.trim()) setInteractiveInput(finalTranscript.trim());
    };
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
        {generating && (
          <span className='inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full'>
            <RotateCcw className='h-3 w-3 animate-spin' />生成中...
            <button type='button' onClick={handleCancelGenerate} className='ml-1 text-muted-foreground hover:text-foreground underline underline-offset-2' title='停止等待（后台继续生成）'>取消</button>
          </span>
        )}
        {error && (
          <div className='inline-flex items-center gap-1.5'>
            <span className='inline-flex items-center gap-1 text-xs text-destructive bg-destructive/10 px-2 py-0.5 rounded-full' title={error}>
              <AlertCircle className='h-3 w-3' />
              生成失败：{error.length > 30 ? error.slice(0, 30) + '...' : error}
            </span>
            <Button
              variant='ghost'
              size='sm'
              className='h-6 px-2 text-xs'
              onClick={() => handleRegenerate('错误重试')}
              title='重新生成'
            >
              <RotateCcw className='h-3 w-3 mr-1' />
              重试
            </Button>
          </div>
        )}
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
        {!generating && topic.done && (
          <Button size='sm' variant='outline' className='text-muted-foreground hover:text-foreground' onClick={handleUndone} title='撤销"学完"标记，重新学习'>
            <Undo2 className='h-3.5 w-3.5 mr-1' />撤销完成
          </Button>
        )}
        {interactiveMode && (
          <Button size='sm' className='bg-red-500 hover:bg-red-600 text-white' onClick={handleExitInteractive}>
            <X className='h-3.5 w-3.5 mr-1' />退出互动
          </Button>
        )}
        <AIStatusIndicator />
        <div className='relative' ref={menuRef}>
          <Button variant='ghost' size='sm' onClick={toggleActionMenu} onKeyDown={handleActionMenuTriggerKeyDown} title='更多操作' aria-label='更多操作' aria-haspopup='menu' aria-expanded={menuOpen} aria-controls={actionMenuId}>
            <MoreHorizontal className='h-4 w-4' />
          </Button>
          {menuOpen && (
            <ActionMenu
              onStartInteractive={(mode) => { handleStartInteractive(mode); setMenuOpen(false); }}
              onExport={() => { handleExport(); setMenuOpen(false); }}
              onExportHtml={() => { handleExportHtml(); setMenuOpen(false); }}
              onExportFormat={(format) => { handleExportFormat(format); setMenuOpen(false); }}
              onFactCheck={() => { handleFactCheck(); setMenuOpen(false); }}
                     onAdaptiveAnalysis={() => { handleAdaptiveAnalysis(); setMenuOpen(false); }}
                     onRecommendResources={() => { handleRecommendResources(); setMenuOpen(false); }}
                     factCheckLoading={factCheckLoading}
                     adaptiveLoading={adaptiveLoading}
                     resourcesLoading={resourcesLoading}
                     showExport={!!(localDetail && !error && !generating)}
                      showTeaching={!generating && !!localDetail && !error && !interactiveMode}
                      showAnalysis={!generating && !!(localDetail && !error)}
                      id={actionMenuId}
                      onClose={closeActionMenu}
            />
          )}
        </div>
      </div>
      </div>

      {/* Topic navigation bar */}
      <div className='flex flex-wrap gap-3 text-sm py-3 px-4 rounded-lg bg-blue-200 dark:bg-blue-800/50 border-2 border-blue-400 dark:border-blue-600 shadow-sm font-medium'>
          {prerequisites.length === 0 && childrenTopics.length === 0 && nextTopics.length === 0 && relatedTopics.length === 0 && (
            <span className='text-muted-foreground italic'>暂无关联知识点</span>
          )}
          {prerequisites.length > 0 && (
            <div className='flex items-center gap-1.5'>
              <span className='text-muted-foreground'>前置：</span>
              {prerequisites.map(t => (
                <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
              ))}
            </div>
          )}
          {childrenTopics.length > 0 && (
            <div className='flex items-center gap-1.5'>
              <span className='text-muted-foreground'>子知识：</span>
              {childrenTopics.map(t => (
                <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
              ))}
            </div>
          )}
          {nextTopics.length > 0 && (
            <div className='flex items-center gap-1.5'>
              <span className='text-muted-foreground'>后续：</span>
              {nextTopics.map(t => (
                <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
              ))}
            </div>
          )}
          {relatedTopics.length > 0 && (
            <div className='flex items-center gap-1.5'>
              <span className='text-muted-foreground'>相关：</span>
              {relatedTopics.map(t => (
                <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
              ))}
            </div>
          )}
      </div>

      {/* Sticky navigation bar — appears when scrolling past the original header */}
      {headerStuckVisible && (
        <div className='sticky-nav-enter fixed top-[49px] left-0 right-0 z-40 bg-background border-b border-border/50 shadow-md'>
          <div className='w-full max-w-4xl mx-auto px-6 py-1.5'>
            {/* Action toolbar row */}
            <div className='flex items-center flex-wrap gap-2 mb-1'>
              <Button variant='ghost' size='sm' onClick={onBack}><ArrowLeft className='h-4 w-4 mr-1' />返回列表</Button>
              <span className='font-semibold text-foreground truncate text-sm flex-1 min-w-0'>{topic.title}</span>
              <AIStatusIndicator />
              {generating && (
                <span className='inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full'>
                  <RotateCcw className='h-3 w-3 animate-spin' />生成中...
                  <button type='button' onClick={handleCancelGenerate} className='ml-1 text-muted-foreground hover:text-foreground underline underline-offset-2' title='停止等待（后台继续生成）'>取消</button>
                </span>
              )}
              {error && (
                <div className='inline-flex items-center gap-1'>
                  <span className='inline-flex items-center gap-1 text-xs text-destructive bg-destructive/10 px-1.5 py-0.5 rounded-full' title={error}>
                    <AlertCircle className='h-3 w-3' />失败
                  </span>
                  <Button variant='ghost' size='sm' className='h-6 px-1.5 text-xs' onClick={() => handleRegenerate('错误重试')} title={error}>
                    <RotateCcw className='h-3 w-3' />
                  </Button>
                </div>
              )}
              {localDetail && !error && !generating && topic.done === false && (
                <Button size='sm' className='bg-green-600 hover:bg-green-700 text-white h-7 text-xs' onClick={handleComplete} disabled={revealLoading} title='标记为已学完并返回列表'>
                  {revealLoading ? <RotateCcw className='h-3 w-3 mr-1 animate-spin' /> : <CheckCheck className='h-3 w-3 mr-1' />}
                  {revealLoading ? '检查中...' : '学完了'}
                </Button>
              )}
              {localDetail && !error && !generating && topic.done && (
                <Button size='sm' className='bg-indigo-500 hover:opacity-90 text-white h-7 text-xs' onClick={handleToggleReview} title='复习模式'>
                  {reviewLoading ? <RotateCcw className='h-3 w-3 mr-1 animate-spin' /> : <RotateCcw className='h-3 w-3 mr-1' />}
                  {reviewMode ? '返回讲解' : '复习'}
                </Button>
              )}
              {!generating && topic.done && (
                <Button size='sm' variant='outline' className='h-7 text-xs text-muted-foreground hover:text-foreground' onClick={handleUndone} title='撤销"学完"标记，重新学习'>
                  <Undo2 className='h-3 w-3 mr-1' />撤销完成
                </Button>
              )}
              {interactiveMode && (
                <Button size='sm' className='bg-red-500 hover:bg-red-600 text-white h-7 text-xs' onClick={handleExitInteractive}>
                  <X className='h-3 w-3 mr-1' />退出互动
                </Button>
              )}
              <div className='relative' ref={fixedMenuRef}>
                <Button variant='ghost' size='sm' onClick={toggleActionMenu} onKeyDown={handleActionMenuTriggerKeyDown} title='更多操作' aria-label='更多操作' aria-haspopup='menu' aria-expanded={menuOpen} aria-controls={actionMenuId}>
                  <MoreHorizontal className='h-4 w-4' />
                </Button>
                {menuOpen && (
                  <ActionMenu
                    onStartInteractive={(mode) => { handleStartInteractive(mode); setMenuOpen(false); }}
                    onExport={() => { handleExport(); setMenuOpen(false); }}
                    onExportHtml={() => { handleExportHtml(); setMenuOpen(false); }}
                    onExportFormat={(format) => { handleExportFormat(format); setMenuOpen(false); }}
                    onFactCheck={() => { handleFactCheck(); setMenuOpen(false); }}
              onAdaptiveAnalysis={() => { handleAdaptiveAnalysis(); setMenuOpen(false); }}
              onRecommendResources={() => { handleRecommendResources(); setMenuOpen(false); }}
                    factCheckLoading={factCheckLoading}
                    adaptiveLoading={adaptiveLoading}
                    showExport={!!(localDetail && !error && !generating)}
                    showTeaching={!generating && !!localDetail && !error && !interactiveMode}
                    showAnalysis={!generating && !!(localDetail && !error)}
                    resourcesLoading={resourcesLoading}
                    id={actionMenuId}
                    onClose={closeActionMenu}
                  />
                )}
              </div>
            </div>
            {/* Relation navigation row */}
            <div className='flex flex-wrap gap-3 text-xs'>
              {prerequisites.length === 0 && childrenTopics.length === 0 && nextTopics.length === 0 && relatedTopics.length === 0 && (
                <span className='text-muted-foreground italic'>暂无关联知识点</span>
              )}
              {prerequisites.length > 0 && (
                <div className='flex items-center gap-1.5'>
                  <span className='text-muted-foreground'>前置：</span>
                  {prerequisites.map(t => (
                    <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
                  ))}
                </div>
              )}
              {childrenTopics.length > 0 && (
                <div className='flex items-center gap-1.5'>
                  <span className='text-muted-foreground'>子知识：</span>
                  {childrenTopics.map(t => (
                    <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
                  ))}
                </div>
              )}
              {nextTopics.length > 0 && (
                <div className='flex items-center gap-1.5'>
                  <span className='text-muted-foreground'>后续：</span>
                  {nextTopics.map(t => (
                    <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
                  ))}
                </div>
              )}
              {relatedTopics.length > 0 && (
                <div className='flex items-center gap-1.5'>
                  <span className='text-muted-foreground'>相关：</span>
                  {relatedTopics.map(t => (
                    <button key={t.id} className='text-blue-600 hover:underline dark:text-blue-400' onClick={() => handleNavigateToTopic(t.id)}>{t.title}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mastery & Mistake Overview */}
      {!interactiveMode && topic.done && (topic.mastery || (topic.mistakes && topic.mistakes.length > 0)) && (
        <div className='rounded-lg bg-gradient-to-br from-blue-50/50 to-purple-50/50 dark:from-blue-950/20 dark:to-purple-950/20 border border-blue-200/50 dark:border-blue-800/30 p-4 space-y-3'>
          {topic.mastery && (
            <div className='flex items-center gap-3'>
              <Brain className='h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0' />
              <div className='flex-1 space-y-1.5'>
                <div className='flex items-center justify-between text-sm'>
                  <span className='font-medium text-foreground'>掌握度</span>
                  <span
                    className='text-xs text-muted-foreground cursor-help'
                    title={`AI 根据 ${(topic.masteryEvidence || []).length} 条练习记录估算，非精确评分（evidence-v1 算法）`}
                  >
                    {Math.round((topic.mastery.level || 0) * 100)}%
                    {(topic.masteryEvidence || []).length > 0 && (
                      <span className='ml-1 opacity-60'>({(topic.masteryEvidence || []).length} 条记录)</span>
                    )}
                  </span>
                </div>
                <div className='w-full h-2 bg-muted rounded-full overflow-hidden'>
                  <div
                    className={`h-full transition-all ${
                      topic.mastery.level >= 0.8 ? 'bg-green-500' :
                      topic.mastery.level >= 0.6 ? 'bg-blue-500' :
                      topic.mastery.level >= 0.4 ? 'bg-yellow-500' : 'bg-orange-500'
                    }`}
                    style={{ width: `${Math.round((topic.mastery.level || 0) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          )}
          {topic.weakPoints && topic.weakPoints.length > 0 && (
            <div className='flex items-start gap-3 pt-2 border-t border-blue-200/30 dark:border-blue-800/30'>
              <AlertTriangle className='h-5 w-5 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5' />
              <div className='flex-1 space-y-1.5'>
                <div className='text-sm font-medium text-foreground'>AI 分析的薄弱点</div>
                <div className='flex flex-wrap gap-1.5'>
                  {topic.weakPoints.map((wp, i) => (
                    <span key={i} className='text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'>
                      {wp}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
          {(() => {
            const activeMistakes = (topic.mistakes || []).filter(m => m.status === 'open' || m.status === 'repairing');
            if (activeMistakes.length === 0) return null;

            const conceptFreq = {};
            activeMistakes.forEach(m => {
              if (m.conceptKey) {
                conceptFreq[m.conceptKey] = (conceptFreq[m.conceptKey] || 0) + (m.occurrenceCount || 1);
              }
            });

            const topConcepts = Object.entries(conceptFreq)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5);

            if (topConcepts.length === 0) return null;

            return (
              <div className='flex items-start gap-3 pt-2 border-t border-blue-200/30 dark:border-blue-800/30'>
                <AlertTriangle className='h-5 w-5 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5' />
                <div className='flex-1 space-y-1.5'>
                  <div className='text-sm font-medium text-foreground'>
                    活跃错题 {activeMistakes.length} 个
                  </div>
                  <div className='text-xs text-muted-foreground space-y-1'>
                    <div>高频薄弱概念：</div>
                    <div className='flex flex-wrap gap-1.5'>
                      {topConcepts.map(([key, count]) => {
                        const mistake = activeMistakes.find(m => m.conceptKey === key);
                        const label = mistake?.conceptLabel || key;
                        return (
                          <span
                            key={key}
                            className='inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
                          >
                            {label}
                            <span className='text-[10px] opacity-75'>×{count}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {!interactiveMode && (
        <MistakePanel
          planId={plan.id}
          topicId={topic.id}
          mistakes={topic.mistakes || []}
          activeMistakeId={practiceKind === 'repair' ? practiceMistakeId : null}
          onRepair={handleStartMistakeRepair}
          onChanged={handleMistakeChanged}
        />
      )}

      {interactiveMode && (
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
      )}

        {localDetail && !error && !interactiveMode && !reviewMode && (
          <div className='flex flex-col' style={{ gap: '144px' }}>
            {/* Image generation error */}
            {imageError && (
              <div className='rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-300'>
                {imageError}
              </div>
            )}
            {topic.imageUrl ? (
            <div className='rounded-lg bg-muted/20 overflow-hidden'>
              <div className='flex items-center justify-between px-4 py-2 bg-muted/50 text-xs text-muted-foreground'>
                  <span>知识点配图</span>
                  <Button variant='ghost' size='sm' className='h-6 px-1.5 text-xs' onClick={() => handleGenerateImage(topic.id)} disabled={imageGenerating} title='重新生成配图'>
                    {imageGenerating ? <RotateCcw className='h-3 w-3 animate-spin' /> : <RotateCcw className='h-3 w-3' />}
                  </Button>
                </div>
                <img src={topic.imageUrl} alt={topic.title} className='w-full' />
              </div>
            ) : localDetail && !generating && settings.imageApiKey && (
              <div className='flex items-center gap-2'>
                <Button variant='outline' size='sm' onClick={() => handleGenerateImage(topic.id)} disabled={imageGenerating}>
                  {imageGenerating ? <RotateCcw className='h-3.5 w-3.5 mr-1 animate-spin' /> : <Image className='h-3.5 w-3.5 mr-1' />}
                  {imageGenerating ? '生成中...' : '生成配图'}
                </Button>
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

            <QAPanel
              qaList={qaList}
              onAsk={handleAsk}
              loading={qaLoading}
              scrollToRound={scrollToRound}
              setHoveredRound={setHoveredRound}
              hoveredRound={hoveredRound}
            />

            
            <ExercisePanel
          exercises={exercises}
          answers={exerciseAnswers}
          onAnswer={handleExerciseAnswer}
          onSubmit={handleSubmitExercises}
          loading={exerciseLoading}
          submitted={submittedExercises}
          results={exerciseResults}
        />

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

            {feynmanAnalyzing && (!feynmanInsights || !feynmanInsights.summary) && (
              <div id='feynman-insights-section' className='pt-4 flex items-center gap-2 text-sm text-muted-foreground'>
                <div className='animate-spin rounded-full h-4 w-4 border-2 border-purple-500 border-t-transparent' />
                <span>AI 正在分析你的费曼讲解...</span>
              </div>
            )}

            {feynmanInsights && feynmanInsights.summary && feynmanInsights.strengths?.length > 0 ? (
              <div id='feynman-insights-section' className='pt-4'>
                <button onClick={() => setFeynmanInsightsOpen(!feynmanInsightsOpen)} className='flex items-center gap-2 w-full text-left'>
                  <Brain className='h-4 w-4 text-purple-500' />
                  <h3 className='text-sm font-medium'>费曼教学评估报告</h3>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    feynmanInsights.teachingQuality === 'excellent' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' :
                    feynmanInsights.teachingQuality === 'good' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' :
                    feynmanInsights.teachingQuality === 'fair' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' :
                    'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                  }`}>
                    {feynmanInsights.teachingQuality === 'excellent' ? '优秀' : feynmanInsights.teachingQuality === 'good' ? '良好' : feynmanInsights.teachingQuality === 'fair' ? '一般' : feynmanInsights.teachingQuality === 'needsWork' ? '需改进' : '未评估'}
                  </span>
                  {feynmanInsightsOpen ? <ChevronDown className='h-4 w-4 text-muted-foreground' /> : <ChevronRight className='h-4 w-4 text-muted-foreground' />}
                </button>
                {feynmanInsightsOpen && (
                  <div className='mt-3 space-y-4 rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20 p-4'>
                    <p className='text-sm text-muted-foreground'>{feynmanInsights.summary}</p>
                    {feynmanInsights.strengths?.length > 0 && (
                      <div className='space-y-1'>
                        <h4 className='text-xs font-medium text-green-600 flex items-center gap-1'><CheckCircle className='h-3 w-3' />讲得好的地方</h4>
                        <ul className='text-sm text-muted-foreground list-disc pl-4 space-y-1'>{feynmanInsights.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                      </div>
                    )}
                    {feynmanInsights.gaps?.length > 0 && (
                      <div className='space-y-1'>
                        <h4 className='text-xs font-medium text-orange-600 flex items-center gap-1'><AlertTriangle className='h-3 w-3' />教材遗漏的重要内容</h4>
                        <ul className='text-sm text-muted-foreground list-disc pl-4 space-y-1'>{feynmanInsights.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
                      </div>
                    )}
                    {feynmanInsights.lingeringQuestions?.length > 0 && (
                      <div className='space-y-2'>
                        <h4 className='text-xs font-medium flex items-center gap-1'><Lightbulb className='h-3 w-3' />学生听完后还会问的问题</h4>
                        <p className='text-xs text-muted-foreground'>试试看你能不能回答这些问题——这才是费曼学习法的核心</p>
                        <div className='space-y-2'>{feynmanInsights.lingeringQuestions.map((q, i) => (
                          <div key={i} className='rounded-md bg-background/80 border p-3 text-sm space-y-1'>
                            <div>❓ {q.question}</div>
                            {q.whyThisMatters && <div className='text-xs text-muted-foreground'>为什么重要：{q.whyThisMatters}</div>}
                            {q.relatedTopic && <div className='text-xs text-muted-foreground'>关联：{q.relatedTopic}</div>}
                          </div>
                        ))}</div>
                      </div>
                    )}
                    {feynmanInsights.sparklingExplanations?.length > 0 && (
                      <div className='space-y-2'>
                        <h4 className='text-xs font-medium flex items-center gap-1'><Sparkles className='h-3 w-3' />可以直接当作教材的精彩讲解</h4>
                        {feynmanInsights.sparklingExplanations.map((note, i) => (
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

            {!generating && localDetail && !interactiveMode && (
              <div className='pt-4 space-y-3'>
                <div className='flex items-center justify-between'>
                  <h3 className='text-sm font-medium'>推荐学习资源</h3>
                  <Button variant='ghost' size='sm' onClick={handleRecommendResources} disabled={resourcesLoading} title='基于本知识点推荐多形式、多渠道资源'>
                    {resourcesLoading ? <RotateCcw className='h-3.5 w-3.5 mr-1 animate-spin' /> : <Lightbulb className='h-3.5 w-3.5 mr-1' />}
                    {resourcesLoading ? '推荐中...' : (resources ? '重新推荐' : '推荐资源')}
                  </Button>
                </div>
                {resources && resources.length > 0 && (
                  <>
                    <div className='grid grid-cols-1 sm:grid-cols-2 gap-2'>
                      {resources.map((r, i) => (
                        <div key={i} className='rounded-md border p-3 text-sm space-y-1'>
                        <div className='flex items-center gap-2 flex-wrap'>
                          <span className='text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'>{r.type}</span>
                          <span className='font-medium flex-1'>{r.title}</span>
                          {r.paid && <span className='text-xs px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300'>付费</span>}
                        </div>
                        <div className='text-xs text-muted-foreground'>{r.source}{r.level ? ' · ' + ({ beginner: '入门', intermediate: '进阶', advanced: '深入' }[r.level] || r.level) : ''}</div>
                        {r.reason && <p className='text-xs text-muted-foreground'>{r.reason}</p>}
                        {r.url && (
                          <a href={r.url} target='_blank' rel='noreferrer' className='text-xs text-blue-600 hover:underline break-all'>{r.url}</a>
                        )}
                        <div className='flex items-center gap-1 pt-1'>
                          <span className='text-[10px] text-muted-foreground mr-1'>有帮助？</span>
                          <button
                            type='button'
                            onClick={() => handleRateResource(i, 1)}
                            className={`rounded px-1.5 py-0.5 text-xs transition-colors ${resourceRatings[i] === 1 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'text-muted-foreground hover:text-green-600'}`}
                            title='有帮助'
                            aria-pressed={resourceRatings[i] === 1}
                          >👍</button>
                          <button
                            type='button'
                            onClick={() => handleRateResource(i, -1)}
                            className={`rounded px-1.5 py-0.5 text-xs transition-colors ${resourceRatings[i] === -1 ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'text-muted-foreground hover:text-red-600'}`}
                            title='没帮助'
                            aria-pressed={resourceRatings[i] === -1}
                          >👎</button>
                        </div>
                        </div>
                      ))}
                    </div>
                    {resourceRatingError && <p className='text-xs text-destructive' role='alert'>{resourceRatingError}</p>}
                  </>
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

      {/* Persisted review/repair sessions share one focused exercise workspace. */}
      {reviewMode && (
        <div className='px-8 pt-4 space-y-4'>
          {practiceKind === 'repair' && (
            <div className='flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200'>
              <Wrench className='h-4 w-4' aria-hidden='true' />
              <strong>错题修复</strong>
              <span className='min-w-0 break-words'>{activeRepairMistake?.conceptLabel || '正在定位目标概念'}</span>
            </div>
          )}
          {reviewLoading && (
            <div className='flex items-center gap-2 text-sm text-muted-foreground' role='status'>
              <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' />
              <span>{practiceKind === 'repair'
                ? 'AI 正在生成针对该错题的修复练习...'
                : 'AI 正在生成复习内容，针对你的薄弱点进行巩固...'}</span>
            </div>
          )}
          {reviewError && (
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive' role='alert'>
              <span>{reviewError}</span>
              {!activeReviewSession && (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={ensureReviewSession}
                  title={practiceKind === 'repair' ? '重试生成错题修复' : '重试生成复习'}
                >
                  <RotateCcw className='h-3.5 w-3.5 mr-1' />重试生成
                </Button>
              )}
            </div>
          )}
          {!generating && activeReviewContent && !reviewLoading && (
            <div>
              <ContentArea content={activeReviewContent} />
            </div>
          )}
          {!reviewLoading && activeReviewSession && (
            <ExercisePanel
              exercises={activeReviewSession.exercises}
              answers={reviewAnswers}
              onAnswer={handleReviewAnswer}
              onSubmit={handleSubmitReview}
              loading={reviewSubmitting}
              submitted={reviewSubmitted}
              results={reviewResults}
            />
          )}
          {practiceKind === 'repair' && reviewSubmitted && activeRepairMistake?.status === 'open' && (
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50/50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300' role='status'>
              <span><strong>本次仍有错误</strong>，错题已重新打开。</span>
              <Button variant='outline' size='sm' onClick={handleRetryRepairAnswers}>
                <RotateCcw className='h-3.5 w-3.5 mr-1' />再次作答
              </Button>
            </div>
          )}
          {practiceKind === 'repair'
            && reviewSubmitted
            && activeRepairMistake?.status === 'repairing'
            && formatReviewDateTime(activeRepairMistake.verificationDueAt) && (
              <div className='rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200' role='status'>
                本次已修复，等待延迟验证：{formatReviewDateTime(activeRepairMistake.verificationDueAt)}
              </div>
          )}
          {practiceKind === 'repair' && reviewSubmitted && activeRepairMistake?.status === 'verified' && (
            <div className='rounded-md border border-green-200 bg-green-50/50 px-3 py-2 text-sm font-medium text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300' role='status'>
              已通过延迟验证
            </div>
          )}
          {practiceKind === 'repair'
            && reviewSubmitted
            && (!activeRepairMistake || !['open', 'repairing', 'verified'].includes(activeRepairMistake.status)) && (
              <div className='rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive' role='alert'>
                修复结果状态异常，请刷新后重试
              </div>
          )}
          {practiceKind === 'review' && reviewSubmitted && reviewQuality !== null && (
            <div className='rounded-md border px-3 py-2 text-sm' role='status'
              style={{ borderColor: reviewQuality >= 4 ? '#86efac' : reviewQuality >= 3 ? '#93c5fd' : reviewQuality >= 2 ? '#fde68a' : '#fca5a5',
                       backgroundColor: reviewQuality >= 4 ? 'rgb(240 253 244 / 0.5)' : reviewQuality >= 3 ? 'rgb(239 246 255 / 0.5)' : reviewQuality >= 2 ? 'rgb(255 251 235 / 0.5)' : 'rgb(254 242 242 / 0.5)' }}>
              <span className='font-medium'>记忆质量 {reviewQuality}/5：</span>
              {reviewQuality === 5 && <span className='text-green-700 dark:text-green-300'>完美记忆 — 间隔大幅延长</span>}
              {reviewQuality === 4 && <span className='text-green-700 dark:text-green-300'>良好 — 小有犹豫，间隔已延长</span>}
              {reviewQuality === 3 && <span className='text-blue-700 dark:text-blue-300'>及格 — 有些费力，间隔小幅延长</span>}
              {reviewQuality === 2 && <span className='text-amber-700 dark:text-amber-300'>错误但能想起 — 间隔将重置，需再复习</span>}
              {reviewQuality === 1 && <span className='text-red-700 dark:text-red-300'>严重遗忘 — 间隔重置为1天</span>}
              {reviewQuality === 0 && <span className='text-red-700 dark:text-red-300'>完全遗忘 — 从头开始</span>}
            </div>
          )}
          {practiceKind === 'review' && formatReviewDate(nextReviewAt) && (
            <div className='rounded-md border border-green-200 bg-green-50/50 px-3 py-2 text-sm font-medium text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300' role='status'>
              <div>下次复习：{formatReviewDate(nextReviewAt)}</div>
              {reviewScheduleDetails && (reviewScheduleDetails.intervalDays != null || reviewScheduleDetails.easeFactor != null) && (
                <div className='mt-1 text-xs font-normal opacity-75 flex flex-wrap gap-x-3 gap-y-0.5'>
                  {reviewScheduleDetails.intervalDays != null && <span>间隔 {reviewScheduleDetails.intervalDays} 天</span>}
                  {reviewScheduleDetails.easeFactor != null && <span>难度系数 {reviewScheduleDetails.easeFactor.toFixed(2)}</span>}
                  {reviewScheduleDetails.repetitions != null && <span>已复习 {reviewScheduleDetails.repetitions} 次</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {topic.generationFeedback && topic.generationFeedback.length > 0 && (
        <div className='px-8 py-2'>
          <button
            type='button'
            className='flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors'
            onClick={() => setFeedbackHistoryOpen(o => !o)}
          >
            <MessageSquare className='h-3 w-3' />
            已提交 {topic.generationFeedback.length} 条生成反馈
            {feedbackHistoryOpen ? <ChevronDown className='h-3 w-3' /> : <ChevronRight className='h-3 w-3' />}
          </button>
          {feedbackHistoryOpen && (
            <div className='mt-2 space-y-1.5 border-l-2 border-border pl-3'>
              {[...topic.generationFeedback].reverse().slice(0, 5).map((fb, i) => (
                <div key={i} className='text-xs text-muted-foreground'>
                  <span className='text-foreground/60'>[{fb.mode}]</span>{' '}
                  {fb.reason}
                  <span className='ml-2 opacity-50'>
                    {fb.timestamp ? new Date(fb.timestamp).toLocaleDateString('zh-CN') : ''}
                  </span>
                </div>
              ))}
              {topic.generationFeedback.length > 5 && (
                <div className='text-[10px] text-muted-foreground'>…共 {topic.generationFeedback.length} 条，仅显示最近 5 条</div>
              )}
            </div>
          )}
        </div>
      )}

      <RegenerateDialog open={regenerateDialogOpen} onClose={() => setRegenerateDialogOpen(false)} onSubmit={handleRegenerate} />
    </div>
  );
}
