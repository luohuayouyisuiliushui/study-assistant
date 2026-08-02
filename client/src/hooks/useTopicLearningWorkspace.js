import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];
const INACTIVITY_THRESHOLD_MS = 30_000;
const HEARTBEAT_MS = 30_000;
const MINIMUM_REPORT_SECONDS = 5;
const GENERATION_POLL_MS = 2_000;

function createInteractiveEventReducer({
  appendSection,
  setStreamingContent,
  setStateMachine,
  setFinished,
}) {
  let fullContent = '';

  const flushContent = event => {
    if (fullContent) appendSection(fullContent);
    fullContent = '';
    setStreamingContent('');
    if (event.session?.stateMachine) setStateMachine(event.session.stateMachine);
  };

  return event => {
    if (event.type === 'chunk') {
      fullContent += event.content;
      setStreamingContent(fullContent);
    } else if (event.type === 'reset') {
      fullContent = '';
      setStreamingContent('');
    } else if (event.type === 'pause') {
      flushContent(event);
    } else if (event.type === 'done') {
      flushContent(event);
      if (event.finished) setFinished(true);
    } else if (event.type === 'error') {
      appendSection(`❌ ${event.data}`);
    }
  };
}

function parseExercisesFromMarkdown(detail) {
  if (!detail) return [];
  const exercises = [];
  const lines = detail.split('\n');
  let current = null;
  let inSection = false;
  for (const line of lines) {
    const text = line.trim();
    if (text.includes('📝 练习题') || /^#{1,3}\s*练习题/.test(text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const heading = text.match(/^>\s*\*\*练习题\s*(\d+)\*\*\s*[（(]([^)）]+)[)）]/);
    if (heading) {
      if (current) exercises.push(current);
      current = {
        index: Number.parseInt(heading[1]),
        type: heading[2] === '选择题' ? 'choice' : 'open',
        question: '',
        options: [],
        answer: '',
        explanation: '',
        conceptTag: '',
        userAnswer: null,
        correct: null,
      };
      const end = text.search(/[)）]/);
      if (end >= 0 && end + 1 < text.length) {
        current.question = text.slice(end + 1).replace(/^[）)]\s*/, '').trim();
      }
      continue;
    }
    if (!current) continue;
    const option = text.match(/^>\s*-\s*([A-D])[.．、]\s*(.+)/);
    if (option) {
      current.options.push(`${option[1]}. ${option[2]}`);
      continue;
    }
    const answer = text.match(/^>\s*>\s*(?:正确答案|参考答案)[：:]\s*(.+)/);
    if (answer) {
      current.answer = answer[1].trim();
      continue;
    }
    const explanation = text.match(/^>\s*>\s*解析[：:]\s*(.+)/);
    if (explanation) {
      current.explanation = explanation[1].trim();
      continue;
    }
    const concept = text.match(/^>\s*>\s*关联概念[：:]\s*(.+)/);
    if (concept) {
      current.conceptTag = concept[1].trim();
      continue;
    }
    if (text.startsWith('> ') && !text.startsWith('> -') && !text.startsWith('> >')) {
      const continuation = text.slice(2).trim();
      if (continuation && !current.answer) {
        current.question += `${current.question ? ' ' : ''}${continuation}`;
      }
    }
  }
  if (current) exercises.push(current);
  return exercises;
}

function useActiveTopicTime(planId, topicId) {
  useEffect(() => {
    if (!planId || !topicId) return undefined;

    let active = !document.hidden;
    let activeStartedAt = Date.now();
    let activeElapsedMs = 0;
    let lastReportedSeconds = 0;
    let reportInFlight = false;
    let inactivityTimer;

    const stopActive = () => {
      if (!active) return;
      activeElapsedMs += Date.now() - activeStartedAt;
      active = false;
    };
    const scheduleInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(stopActive, INACTIVITY_THRESHOLD_MS);
    };
    const markActive = () => {
      if (document.hidden) return;
      if (!active) {
        active = true;
        activeStartedAt = Date.now();
      }
      scheduleInactivity();
    };
    const elapsedSeconds = () => Math.round(
      (activeElapsedMs + (active ? Date.now() - activeStartedAt : 0)) / 1000,
    );
    const report = () => {
      const total = elapsedSeconds();
      const unreported = total - lastReportedSeconds;
      if (unreported < MINIMUM_REPORT_SECONDS || reportInFlight) return;
      reportInFlight = true;
      api.recordTime(planId, topicId, unreported)
        .then(() => { lastReportedSeconds = total; })
        .catch(() => {})
        .finally(() => { reportInFlight = false; });
    };
    const onVisibility = () => {
      if (document.hidden) {
        stopActive();
        clearTimeout(inactivityTimer);
      } else {
        markActive();
      }
    };
    const onBlur = () => {
      stopActive();
      clearTimeout(inactivityTimer);
    };

    ACTIVITY_EVENTS.forEach(event => {
      document.addEventListener(event, markActive, { passive: true });
    });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', markActive);
    scheduleInactivity();
    const heartbeat = setInterval(report, HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      clearTimeout(inactivityTimer);
      ACTIVITY_EVENTS.forEach(event => document.removeEventListener(event, markActive));
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', markActive);
      stopActive();
      report();
    };
  }, [planId, topicId]);
}

export function useTopicLearningWorkspace({
  plan,
  topic,
  onRefresh,
  onBack,
  urlMode = null,
  urlReview = false,
  setSearchParams,
  practiceMode = false,
}) {
  const planId = plan?.id;
  const topicId = topic?.id;
  const topicDetail = topic?.detail || '';
  const topicDone = topic?.done === true;
  const topicError = topic?.lastError || null;
  const onRefreshRef = useRef(onRefresh);
  const onBackRef = useRef(onBack);
  const detailRef = useRef(topicDetail);
  const interactiveBusyRef = useRef(false);
  const relationsInferredPlanIdsRef = useRef(new Set());
  onRefreshRef.current = onRefresh;
  onBackRef.current = onBack;

  const [localDetail, setLocalDetail] = useState(topicDetail);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(topicError);
  detailRef.current = localDetail;
  useActiveTopicTime(planId, topicId);

  const refreshPlan = useCallback(async () => {
    if (!planId) return null;
    const fresh = await api.getPlan(planId);
    if (fresh?.plan) onRefreshRef.current?.(fresh.plan);
    return fresh?.plan || null;
  }, [planId]);

  useEffect(() => {
    let cancelled = false;
    setLocalDetail(topicDetail);
    setError(topicError);
    setGenerating(false);
    if (!topicId || topicDetail || topicDone || topicError || !planId) {
      return () => { cancelled = true; };
    }

    setGenerating(true);
    api.generateDetail(planId, topicId).catch(generationError => {
      if (cancelled) return;
      console.error('[TopicLearningWorkspace] generateDetail failed:', generationError);
      setGenerating(false);
      setError(generationError.message || '加载失败');
    });
    return () => { cancelled = true; };
  }, [planId, topicId, topicDetail, topicDone, topicError]);

  useEffect(() => {
    if (!generating || !planId || !topicId) return undefined;
    const timer = setInterval(async () => {
      try {
        const response = await api.getPlan(planId);
        const freshPlan = response.plan;
        const freshTopic = freshPlan?.topics?.find(item => item.id === topicId);
        if (!freshTopic) {
          setGenerating(false);
          clearInterval(timer);
          return;
        }
        if (freshTopic.detail && freshTopic.detail !== detailRef.current) {
          setLocalDetail(freshTopic.detail);
          onRefreshRef.current?.(freshPlan);
        }
        if (freshTopic.lastError) {
          setError(freshTopic.lastError);
          setGenerating(false);
          clearInterval(timer);
        } else if (freshTopic.done) {
          setLocalDetail(freshTopic.detail || detailRef.current);
          setGenerating(false);
          clearInterval(timer);
        }
      } catch (pollError) {
        setError(pollError.message || '无法刷新生成状态');
        setGenerating(false);
        clearInterval(timer);
      }
    }, GENERATION_POLL_MS);
    return () => clearInterval(timer);
  }, [generating, planId, topicId]);

  const retryGeneration = useCallback(() => {
    if (!planId || !topicId) return Promise.resolve();
    setError(null);
    setLocalDetail('');
    setGenerating(true);
    return api.generateDetail(planId, topicId).catch(generationError => {
      setGenerating(false);
      setError(generationError.message || '加载失败');
      throw generationError;
    });
  }, [planId, topicId]);

  const acceptDetail = useCallback(detail => setLocalDetail(detail || ''), []);

  const [reviewActive, setReviewActive] = useState(false);
  const [reviewContent, setReviewContent] = useState(topic?.reviewGenerated || null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const reviewRequestsRef = useRef(new Map());
  const reviewUrlAttemptRef = useRef(null);
  const reviewContextKey = planId && topicId ? `${planId}:${topicId}` : null;
  const reviewContextRef = useRef(reviewContextKey);
  reviewContextRef.current = reviewContextKey;

  useEffect(() => {
    setReviewActive(false);
    setReviewLoading(false);
  }, [topicId]);

  useEffect(() => {
    setReviewContent(topic?.reviewGenerated || null);
  }, [topicId, topic?.reviewGenerated]);

  const generateReview = useCallback(() => {
    const requestKey = planId && topicId ? `${planId}:${topicId}` : null;
    if (!requestKey) return Promise.resolve(null);

    const inFlight = reviewRequestsRef.current.get(requestKey);
    if (inFlight) {
      setReviewLoading(true);
      return inFlight.promise;
    }

    const request = { key: requestKey, promise: null };
    request.promise = (async () => {
      const isCurrent = () => (
        reviewContextRef.current === requestKey
        && reviewRequestsRef.current.get(requestKey) === request
      );
      setReviewLoading(true);
      try {
        const result = await api.generateReview(planId, topicId);
        if (!isCurrent()) return result.review;

        setReviewContent(result.review);
        const fresh = await api.getPlan(planId);
        if (isCurrent() && fresh?.plan) onRefreshRef.current?.(fresh.plan);
        return result.review;
      } catch (reviewError) {
        if (isCurrent()) throw reviewError;
        return null;
      } finally {
        if (reviewRequestsRef.current.get(requestKey) === request) {
          reviewRequestsRef.current.delete(requestKey);
          if (reviewContextRef.current === requestKey) setReviewLoading(false);
        }
      }
    })();
    reviewRequestsRef.current.set(requestKey, request);
    return request.promise;
  }, [planId, topicId]);

  useEffect(() => {
    if (urlReview) {
      if (reviewContent) {
        setReviewActive(true);
        return;
      }

      const attemptKey = planId && topicId ? `${planId}:${topicId}` : null;
      if (!attemptKey || reviewUrlAttemptRef.current === attemptKey) return;

      reviewUrlAttemptRef.current = attemptKey;
      setReviewActive(true);
      generateReview().catch(() => {
        setReviewActive(false);
        setSearchParams?.(
          practiceMode ? { practice: '1' } : {},
          { replace: true },
        );
      });
      return;
    }

    reviewUrlAttemptRef.current = null;
    setReviewActive(false);
  }, [
    urlReview,
    reviewContent,
    generateReview,
    planId,
    topicId,
    practiceMode,
    setSearchParams,
  ]);

  const toggleReview = useCallback(async () => {
    const next = !reviewActive;
    setReviewActive(next);
    setSearchParams?.(
      next
        ? (practiceMode ? { practice: '1', review: '1' } : { review: '1' })
        : (practiceMode ? { practice: '1' } : {}),
      { replace: false },
    );
    if (next && !reviewContent) {
      try {
        await generateReview();
      } catch {
        setReviewActive(false);
      }
    }
  }, [reviewActive, reviewContent, practiceMode, setSearchParams, generateReview]);

  const parsedExercises = useMemo(
    () => parseExercisesFromMarkdown(localDetail),
    [localDetail],
  );
  const [exercises, setExercises] = useState([]);
  const [exerciseAnswers, setExerciseAnswers] = useState({});
  const [exerciseResults, setExerciseResults] = useState(null);
  const [exerciseLoading, setExerciseLoading] = useState(false);
  const [submittedExercises, setSubmittedExercises] = useState(false);

  useEffect(() => {
    if (!localDetail || generating) return;
    const nextExercises = topic?.exercises?.length ? topic.exercises : parsedExercises;
    setExercises(nextExercises);
    if (nextExercises.length > 0 && nextExercises.every(item => item.correct !== null)) {
      setSubmittedExercises(true);
      setExerciseResults(nextExercises.map((item, index) => ({
        exerciseIndex: index,
        correct: item.correct,
        userAnswer: item.userAnswer,
        correctAnswer: item.answer,
        explanation: item.explanation,
      })));
    } else {
      setSubmittedExercises(false);
      setExerciseResults(null);
    }
  }, [localDetail, generating, parsedExercises, topic?.exercises]);

  useEffect(() => {
    setExerciseAnswers({});
  }, [topicId]);

  const answerExercise = useCallback((exerciseIndex, answer) => {
    setExerciseAnswers(previous => ({ ...previous, [exerciseIndex]: answer }));
  }, []);

  const submitExercises = useCallback(async () => {
    if (exerciseLoading || exercises.length === 0 || !planId || !topicId) return;
    setExerciseLoading(true);
    try {
      const answers = Object.entries(exerciseAnswers).map(([index, answer]) => ({
        exerciseIndex: Number.parseInt(index),
        userAnswer: answer,
      }));
      const result = await api.submitExercises(planId, topicId, answers);
      setExerciseResults(result.results);
      setSubmittedExercises(true);
      await refreshPlan();
    } finally {
      setExerciseLoading(false);
    }
  }, [exerciseLoading, exercises.length, exerciseAnswers, planId, topicId, refreshPlan]);

  const [qaList, setQaList] = useState([]);
  const [qaLoading, setQaLoading] = useState(false);
  useEffect(() => {
    const history = plan?.history?.filter(item => item.topicId === topicId) || [];
    const pairs = [];
    for (let index = 0; index < history.length; index += 1) {
      if (history[index].role === 'user' && history[index + 1]?.role === 'ai') {
        pairs.push({ question: history[index].content, answer: history[index + 1].content });
        index += 1;
      }
    }
    setQaList(previous => (
      previous.some(item => item.answer === '...') ? previous : pairs
    ));
  }, [plan?.history, topicId]);

  const askQuestion = useCallback(async question => {
    if (!question || qaLoading || !planId || !topicId) return;
    setQaLoading(true);
    setQaList(previous => [...previous, { question, answer: '...' }]);
    try {
      const result = await api.askQuestion(planId, topicId, question);
      setQaList(previous => {
        const next = [...previous];
        next[next.length - 1] = { question, answer: result.answer };
        return next;
      });
      await refreshPlan();
    } catch (requestError) {
      setQaList(previous => {
        const next = [...previous];
        next[next.length - 1] = {
          question,
          answer: `❌ 请求失败: ${requestError.message}`,
        };
        return next;
      });
    } finally {
      setQaLoading(false);
    }
  }, [qaLoading, planId, topicId, refreshPlan]);

  const [interactiveMode, setInteractiveMode] = useState(null);
  const [interactiveSections, setInteractiveSections] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [interactiveLoading, setInteractiveLoading] = useState(false);
  const [interactiveFinished, setInteractiveFinished] = useState(false);
  const [interactiveInput, setInteractiveInput] = useState('');
  const [interactiveStateMachine, setInteractiveStateMachine] = useState(null);
  const [feynmanInsights, setFeynmanInsights] = useState(topic?.feynmanInsights || null);
  const [feynmanAnalyzing, setFeynmanAnalyzing] = useState(false);
  const previousUrlModeRef = useRef(urlMode);

  useEffect(() => {
    setFeynmanInsights(topic?.feynmanInsights || null);
  }, [topicId, topic?.feynmanInsights]);

  useEffect(() => {
    const previousUrlMode = previousUrlModeRef.current;
    previousUrlModeRef.current = urlMode;
    if (urlMode && !interactiveMode) {
      setInteractiveMode(urlMode);
      setInteractiveFinished(false);
    } else if (previousUrlMode && !urlMode && interactiveMode) {
      setInteractiveMode(null);
      setInteractiveSections([]);
      setInteractiveFinished(false);
      setInteractiveInput('');
      setInteractiveStateMachine(null);
    }
  }, [urlMode, interactiveMode]);

  const startInteractive = useCallback(async (mode, forceNew = false) => {
    if (interactiveBusyRef.current || !planId || !topicId) return;
    setSearchParams?.(
      practiceMode ? { practice: '1', mode } : { mode },
      { replace: false },
    );
    const existing = topic?.interactiveSession;
    if (
      !forceNew
      && existing?.mode === mode
      && existing.transcript?.length > 0
      && !existing.finished
    ) {
      setInteractiveMode(mode);
      setStreamingContent('');
      setInteractiveFinished(false);
      setInteractiveLoading(false);
      setInteractiveSections(existing.transcript.map(item => ({ content: item.content || '' })));
      setInteractiveStateMachine(existing.stateMachine || null);
      return;
    }

    interactiveBusyRef.current = true;
    setInteractiveMode(mode);
    setInteractiveSections([]);
    setStreamingContent('');
    setInteractiveFinished(false);
    setInteractiveLoading(true);
    try {
      const onEvent = createInteractiveEventReducer({
        appendSection: content => {
          setInteractiveSections(previous => [...previous, { content }]);
        },
        setStreamingContent,
        setStateMachine: setInteractiveStateMachine,
        setFinished: setInteractiveFinished,
      });
      await api.startInteractiveSSE(planId, topicId, mode, onEvent);
    } catch (startError) {
      setInteractiveSections([{ content: `❌ 启动失败: ${startError.message}` }]);
    } finally {
      setInteractiveLoading(false);
      interactiveBusyRef.current = false;
    }
  }, [planId, topicId, topic?.interactiveSession, practiceMode, setSearchParams]);

  const continueInteractive = useCallback(async feedback => {
    if (!interactiveMode || interactiveBusyRef.current || !planId || !topicId) return;
    interactiveBusyRef.current = true;
    setInteractiveLoading(true);
    setInteractiveInput('');
    setStreamingContent('');
    try {
      const onEvent = createInteractiveEventReducer({
        appendSection: content => {
          setInteractiveSections(previous => [...previous, { content }]);
        },
        setStreamingContent,
        setStateMachine: setInteractiveStateMachine,
        setFinished: setInteractiveFinished,
      });
      await api.continueInteractiveSSE(
        planId,
        topicId,
        interactiveMode,
        feedback,
        onEvent,
      );
    } catch (continueError) {
      setInteractiveSections([{ content: `❌ 响应失败: ${continueError.message}` }]);
    } finally {
      setInteractiveLoading(false);
      interactiveBusyRef.current = false;
    }
  }, [interactiveMode, planId, topicId]);

  const sendInteractiveFeedback = useCallback(() => {
    const feedback = interactiveInput.trim();
    if (!feedback) return Promise.resolve();
    return continueInteractive(feedback);
  }, [interactiveInput, continueInteractive]);

  const exitInteractive = useCallback(() => {
    const wasFeynman = interactiveMode === 'feynman';
    const hasUserContent = interactiveSections.length > 1
      || (interactiveSections.length === 1 && interactiveSections[0]?.content?.length > 200);
    setInteractiveMode(null);
    setInteractiveSections([]);
    setInteractiveFinished(false);
    setInteractiveInput('');
    setInteractiveStateMachine(null);
    setSearchParams?.(practiceMode ? { practice: '1' } : {}, { replace: false });
    if (wasFeynman && planId && topicId && hasUserContent) {
      setFeynmanAnalyzing(true);
      api.analyzeFeynmanSession(planId, topicId)
        .then(insights => {
          if (insights?.summary && insights.strengths?.length > 0) {
            setFeynmanInsights(insights);
          }
        })
        .catch(() => {})
        .finally(() => setFeynmanAnalyzing(false));
    }
  }, [interactiveMode, interactiveSections, practiceMode, setSearchParams, planId, topicId]);

  const restartInteractive = useCallback(async () => {
    if (!planId || !topicId || !interactiveMode) return;
    try {
      await api.clearInteractiveSession(planId, topicId);
    } catch {}
    if (interactiveMode === 'feynman') setFeynmanInsights(null);
    setInteractiveSections([]);
    setInteractiveFinished(false);
    setInteractiveInput('');
    setInteractiveStateMachine(null);
    await startInteractive(interactiveMode, true);
  }, [planId, topicId, interactiveMode, startInteractive]);

  const regenerate = useCallback(async reason => {
    await api.submitFeedback(
      planId,
      topicId,
      reason,
      interactiveMode || 'detail',
    ).catch(() => {});
    if (interactiveMode) return restartInteractive();
    return retryGeneration();
  }, [planId, topicId, interactiveMode, restartInteractive, retryGeneration]);

  const [factCheckData, setFactCheckData] = useState(topic?.factCheck || null);
  const [factCheckLoading, setFactCheckLoading] = useState(false);
  const [factCheckFixing, setFactCheckFixing] = useState(false);
  const [adaptiveData, setAdaptiveData] = useState(null);
  const [adaptiveLoading, setAdaptiveLoading] = useState(false);
  const [resources, setResources] = useState(topic?.resources || null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [imageGenerating, setImageGenerating] = useState(false);
  const [imageError, setImageError] = useState(null);

  useEffect(() => {
    setFactCheckData(topic?.factCheck || null);
    setResources(topic?.resources || null);
    setAdaptiveData(null);
    setImageError(null);
  }, [topicId, topic?.factCheck, topic?.resources]);

  useEffect(() => {
    if (!plan || !topic || !planId || relationsInferredPlanIdsRef.current.has(planId)) return;
    if (plan.relationsInferredAt) {
      relationsInferredPlanIdsRef.current.add(planId);
      return;
    }
    const hasRelations = plan.topics.some(item => (
      item.prerequisites?.length > 0
      || item.relatedTopics?.length > 0
      || item.parentId
    ));
    if (hasRelations) {
      relationsInferredPlanIdsRef.current.add(planId);
      return;
    }
    relationsInferredPlanIdsRef.current.add(planId);
    api.inferRelations(planId)
      .then(refreshPlan)
      .catch(() => { relationsInferredPlanIdsRef.current.delete(planId); });
  }, [planId, topicId, plan, topic, refreshPlan]);

  const runFactCheck = useCallback(async () => {
    if (factCheckLoading || !localDetail || !planId || !topicId) return;
    setFactCheckLoading(true);
    try {
      const result = await api.factCheck(planId, topicId);
      setFactCheckData(result.factCheck || result);
      const freshPlan = await refreshPlan();
      const freshTopic = freshPlan?.topics?.find(item => item.id === topicId);
      if (freshTopic?.factCheck) setFactCheckData(freshTopic.factCheck);
    } finally {
      setFactCheckLoading(false);
    }
  }, [factCheckLoading, localDetail, planId, topicId, refreshPlan]);

  const fixFactCheck = useCallback(async () => {
    if (factCheckFixing || !factCheckData?.findings || !planId || !topicId) return;
    const findings = factCheckData.findings.filter(item => (
      item.verdict === 'uncertain'
      || item.verdict === 'likely_wrong'
      || item.verdict === 'hallucination'
    ));
    if (findings.length === 0) return;
    setFactCheckFixing(true);
    try {
      const result = await api.autoFixFacts(planId, topicId, findings);
      if (result.corrected) acceptDetail(result.detail);
      await refreshPlan();
      return result;
    } finally {
      setFactCheckFixing(false);
    }
  }, [factCheckFixing, factCheckData, planId, topicId, acceptDetail, refreshPlan]);

  const analyzeAdaptive = useCallback(async () => {
    if (adaptiveLoading || !planId) return;
    setAdaptiveLoading(true);
    try {
      const result = await api.adaptiveAnalysis(planId);
      setAdaptiveData(result);
    } finally {
      setAdaptiveLoading(false);
    }
  }, [adaptiveLoading, planId]);

  const recommendResources = useCallback(async () => {
    if (resourcesLoading || !localDetail || !planId || !topicId) return;
    setResourcesLoading(true);
    try {
      const result = await api.recommendResources(planId, topicId);
      setResources(result.resources || []);
      await refreshPlan();
    } finally {
      setResourcesLoading(false);
    }
  }, [resourcesLoading, localDetail, planId, topicId, refreshPlan]);

  const generateImage = useCallback(async targetTopicId => {
    if (!planId || !targetTopicId) return;
    setImageGenerating(true);
    setImageError(null);
    try {
      await api.generateTopicImage(planId, targetTopicId);
      const freshPlan = await refreshPlan();
      const freshTopic = freshPlan?.topics?.find(item => item.id === targetTopicId);
      if (freshTopic?.imageUrl) acceptDetail(freshTopic.detail || detailRef.current);
    } catch (generationError) {
      setImageError(generationError.message || '生成配图失败');
    } finally {
      setImageGenerating(false);
    }
  }, [planId, refreshPlan, acceptDetail]);

  const [difficulty, setDifficulty] = useState(topic?.difficulty || null);
  const [difficultySaving, setDifficultySaving] = useState(false);
  const [revealLoading, setRevealLoading] = useState(false);
  const [foundErrors, setFoundErrors] = useState('');

  useEffect(() => {
    setDifficulty(topic?.difficulty || null);
    setFoundErrors('');
  }, [topicId, topic?.difficulty]);

  const saveDifficulty = useCallback(async level => {
    if (difficultySaving || !planId || !topicId) return;
    setDifficulty(level);
    setDifficultySaving(true);
    try {
      await api.updateTopic(planId, topicId, { difficulty: level });
      await refreshPlan();
    } finally {
      setDifficultySaving(false);
    }
  }, [difficultySaving, planId, topicId, refreshPlan]);

  const complete = useCallback(async () => {
    if (!planId || !topicId || revealLoading) return false;
    setRevealLoading(true);
    try {
      const recognized = foundErrors
        .split(/[\n;；,，]+/)
        .map(item => item.trim())
        .filter(Boolean);
      try {
        const result = await api.revealErrors(planId, topicId, recognized);
        if (result.hasErrors && result.errors?.length > 0) return false;
      } catch {}
      try {
        await api.updateTopic(planId, topicId, { done: true });
        await refreshPlan();
      } finally {
        onBackRef.current?.();
      }
      return true;
    } finally {
      setRevealLoading(false);
    }
  }, [planId, topicId, revealLoading, foundErrors, refreshPlan]);

  return {
    content: {
      detail: localDetail,
      generating,
      error,
      retry: retryGeneration,
      accept: acceptDetail,
      regenerate,
    },
    review: {
      active: reviewActive,
      content: reviewContent,
      loading: reviewLoading,
      toggle: toggleReview,
    },
    assessment: {
      exercises,
      answers: exerciseAnswers,
      results: exerciseResults,
      loading: exerciseLoading,
      submitted: submittedExercises,
      answer: answerExercise,
      submit: submitExercises,
    },
    interaction: {
      mode: interactiveMode,
      sections: interactiveSections,
      streamingContent,
      loading: interactiveLoading,
      finished: interactiveFinished,
      input: interactiveInput,
      setInput: setInteractiveInput,
      stateMachine: interactiveStateMachine,
      qaList,
      qaLoading,
      ask: askQuestion,
      start: startInteractive,
      send: sendInteractiveFeedback,
      quickAction: continueInteractive,
      continue: continueInteractive,
      exit: exitInteractive,
      restart: restartInteractive,
    },
    insights: {
      factCheck: factCheckData,
      factCheckLoading,
      factCheckFixing,
      runFactCheck,
      fixFactCheck,
      dismissFactCheck: () => setFactCheckData(null),
      adaptive: adaptiveData,
      adaptiveLoading,
      analyzeAdaptive,
      dismissAdaptive: () => setAdaptiveData(null),
      resources,
      resourcesLoading,
      recommendResources,
      feynman: feynmanInsights,
      feynmanAnalyzing,
      imageGenerating,
      imageError,
      generateImage,
    },
    completion: {
      difficulty,
      difficultySaving,
      saveDifficulty,
      revealLoading,
      foundErrors,
      setFoundErrors,
      complete,
    },
  };
}
