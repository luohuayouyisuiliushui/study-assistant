import { useState, useRef, useEffect, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BarChart3, Network, Brain, FileText, Target, Search, RotateCcw, Sparkles, Plus, ChevronRight, ChevronDown, X, Download, MessageSquare, BookOpen, MoreHorizontal, Clock, CalendarDays, List, Upload } from 'lucide-react';
import { Button } from '#/components/ui/button';
import api from '../api';
import KnowledgeGraphModal from './KnowledgeGraphModal';
import MindMapModal from './MindMapModal';
import ExamPaperModal from './ExamPaperModal';
import ConfirmDialog from './ConfirmDialog';
import { detectEncoding } from '../utils/encoding';

export default function PlanView({ plan, onAddTopics, onRemoveTopic, onSelectTopic, onGenerate }) {
  const [bulkInput, setBulkInput] = useState('');
  const fileInputRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortMode, setSortMode] = useState('order');
  const scrollKeyRef = useRef(`planview-scroll-${plan?.id}`);
  const planContainerRef = useRef(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisData, setAnalysisData] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisChat, setAnalysisChat] = useState([]);
  const [analysisChatInput, setAnalysisChatInput] = useState('');
  const [analysisChatLoading, setAnalysisChatLoading] = useState(false);
  const analysisChatRef = useRef(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [mindMapOpen, setMindMapOpen] = useState(false);
  const [examOpen, setExamOpen] = useState(false);
  const [decomposingId, setDecomposingId] = useState(null);
  const [expandedTopics, setExpandedTopics] = useState({});
  const [quizOpen, setQuizOpen] = useState(false);
  const [quizData, setQuizData] = useState(null);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const quizAttemptRef = useRef(null);
  const [coreOpen, setCoreOpen] = useState(false);
  const [coreData, setCoreData] = useState(null);
  const [coreLoading, setCoreLoading] = useState(false);
  const [weakAnalysisLoading, setWeakAnalysisLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const [confirmBulkAdd, setConfirmBulkAdd] = useState(null); // { lines, clean, msg }
  const [confirmDeleteTopic, setConfirmDeleteTopic] = useState(null); // { id, title }

  useEffect(() => {
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Restore scroll position when returning from TopicDetail
  useEffect(() => {
    const key = scrollKeyRef.current;
    const saved = sessionStorage.getItem(key);
    if (saved) {
      const y = parseInt(saved, 10);
      if (!isNaN(y)) requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' }));
      sessionStorage.removeItem(key);
    }
  }, []);

  const handleSelectTopicWithScroll = useCallback((topicId) => {
    sessionStorage.setItem(scrollKeyRef.current, String(Math.round(window.scrollY)));
    onSelectTopic(topicId);
  }, [onSelectTopic]);

  const toggleExpand = (topicId) => {
    setExpandedTopics(prev => ({ ...prev, [topicId]: !prev[topicId] }));
  };

  useEffect(() => {
    if (analysisChatRef.current) {
      analysisChatRef.current.scrollTop = analysisChatRef.current.scrollHeight;
    }
  }, [analysisChat.length]);

  if (!plan) return <div className='flex items-center justify-center py-16 text-muted-foreground text-sm'>加载中...</div>;

  const handleAnalysis = async (regenerate = false) => {
    if (analysisData && !regenerate) {
      setAnalysisOpen(!analysisOpen);
      return;
    }
    setAnalysisLoading(true);
    setAnalysisOpen(true);
    try {
      const d = await api.analyzePlan(plan.id, analysisChat);
      setAnalysisData(d.analysis);
      setAnalysisChat([]);
    } catch (err) {
      setAnalysisData({ analysis: '❌ 分析失败: ' + err.message });
    } finally {
      setAnalysisLoading(false);
    }
  };

  const handleCoreAnalysis = async (force = false) => {
    if (!force && coreData) {
      setCoreOpen(!coreOpen);
      return;
    }
    setCoreLoading(true);
    setCoreOpen(true);
    try {
      const d = await api.getCoreTopics(plan.id, force);
      setCoreData(d);
    } catch (err) {
      setCoreData(null);
      setCoreOpen(false);
      alert('核心20%分析失败: ' + err.message);
    } finally {
      setCoreLoading(false);
    }
  };

  const handleAnalysisAsk = async () => {
    if (!analysisChatInput.trim() || analysisChatLoading || !analysisData?.analysis) return;
    const question = analysisChatInput.trim();
    setAnalysisChatInput('');
    setAnalysisChatLoading(true);
    setAnalysisChat(prev => [...prev, { role: 'user', content: question }]);

    try {
      const d = await api.askAnalysisQuestion(plan.id, question, analysisData.analysis);
      setAnalysisChat(prev => [...prev, { role: 'ai', content: d.answer }]);
    } catch (err) {
      setAnalysisChat(prev => [...prev, { role: 'ai', content: '❌ ' + err.message }]);
    } finally {
      setAnalysisChatLoading(false);
    }
  };

  const handleAnalysisExport = () => {
    if (!analysisData?.analysis) return;
    let md = `# 📊 学习分析报告 — ${plan.name}\n\n`;
    md += analysisData.analysis + '\n\n';
    if (analysisChat.length > 0) {
      md += `---\n\n## 💬 追问记录\n\n`;
      analysisChat.forEach((msg) => {
        if (msg.role === 'user') {
          md += `### 追问\n\n${msg.content}\n\n`;
        } else {
          md += `> ${msg.content}\n\n`;
        }
      });
    }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `学习分析报告-${plan.name}.md`.replace(/[/\\?%*:|"<>]/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleQuickQuiz = async () => {
    if (quizData) {
      setQuizOpen(!quizOpen);
      return;
    }
    setQuizLoading(true);
    setQuizOpen(true);
    try {
      const d = await api.generateQuickQuiz(plan.id);
      setQuizData(d);
      setQuizAnswers({});
      setQuizSubmitted(false);
      quizAttemptRef.current = null;
    } catch (err) {
      alert('测验生成失败: ' + err.message);
      setQuizOpen(false);
    } finally {
      setQuizLoading(false);
    }
  };

  const handleQuizAnswer = (qIdx, answer) => {
    quizAttemptRef.current = null;
    setQuizAnswers(prev => ({ ...prev, [qIdx]: answer }));
  };

  const handleQuizReveal = (qIdx) => {
    if (!quizData?.questions?.[qIdx]) return;
    setQuizAnswers(prev => ({ ...prev, [qIdx]: quizData.questions[qIdx].answer }));
  };

  const handleQuizSubmit = async () => {
    if (!quizData?.questions || quizSubmitted) return;
    const results = quizData.questions.map((q, i) => {
      const userAnswer = quizAnswers[i] || '';
      const correct = q.type === 'choice'
        ? userAnswer === q.answer
        : userAnswer.trim().toLowerCase() === q.answer.trim().toLowerCase();
      return { exerciseIndex: i, userAnswer, correct };
    });
    try {
      const attemptRef = quizAttemptRef.current || api.createAttemptRef('quick-quiz');
      quizAttemptRef.current = attemptRef;
      await api.submitQuickQuiz(plan.id, quizData.questions, results, attemptRef);
      quizAttemptRef.current = null;
      setQuizSubmitted(true);
    } catch {
      // Silently fail — quiz results are non-critical
    }
  };

  const handleAdd = () => {
    const lines = bulkInput.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const longLines = lines.filter(l => l.length > 80);
    const isLikelyDocument = lines.length > 20 || longLines.length > lines.length * 0.3;
    if (isLikelyDocument) {
      const bulletCount2 = lines.filter(l => /^[-*]\s/.test(l) || /^\d+[.)]\s/.test(l)).length;
      const isBulleted2 = bulletCount2 > lines.length * 0.5;
      const clean2 = lines
        .filter(l => !l.startsWith('#'))
        .map(l => isBulleted2 ? l.replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, '') : l)
        .filter(Boolean);
      if (clean2.length === 0) return;
      setConfirmBulkAdd({
        clean: clean2,
        msg: `检测到您粘贴的内容看起来像是一整份文档（${lines.length} 行，其中 ${longLines.length} 行较长）。\n当前操作会将每一行文字作为一个独立知识点添加，但这份内容更适合用「AI 导入」功能来自动分析文档结构。`,
      });
      return;
    }
    const bulletCount = lines.filter(l => /^[-*]\s/.test(l) || /^\d+[.)]\s/.test(l)).length;
    const isBulleted = bulletCount > lines.length * 0.5;
    const clean = lines
      .filter(l => !l.startsWith('#'))
      .map(l => isBulleted ? l.replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, '') : l)
      .filter(Boolean);
    if (clean.length === 0) return;
    onAddTopics(clean);
    setBulkInput('');
  };

  const handleFileImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target?.result;
      if (!buffer) return;
      const text = detectEncoding(buffer);
      setBulkInput(prev => (prev ? prev + '\n' : '') + text);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const handleWeakAnalysis = async () => {
    setWeakAnalysisLoading(true);
    try {
      const d = await api.analyzeWeakPoints(plan.id);
      const fresh = await api.getPlan(plan.id);
      if (fresh.plan) {
        plan.topics.length = 0;
        plan.topics.push(...fresh.plan.topics);
      }
      if (d.weakPoints && d.weakPoints.length > 0) {
        alert(`AI 分析完成，在 ${d.weakPoints.length} 个知识点中检测到薄弱环节`);
      } else {
        alert('AI 分析完成，未发现明显的薄弱知识点');
      }
    } catch (err) {
      alert('薄弱分析失败: ' + err.message);
    } finally {
      setWeakAnalysisLoading(false);
    }
  };

  const handleDecompose = async (topicId) => {
    setDecomposingId(topicId);
    try {
      await api.decomposeTopic(plan.id, topicId);
      const fresh = await api.getPlan(plan.id);
      if (fresh.plan) {
        plan.topics.length = 0;
        plan.topics.push(...fresh.plan.topics);
        setDecomposingId(null);
      }
    } catch (err) {
      alert('分解失败: ' + err.message);
    } finally {
      setDecomposingId(null);
    }
  };

  // Search + status filter
  const applyFilter = (topics) => {
    let filtered = topics;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(t => t.title.toLowerCase().includes(q));
    }
    return filtered;
  };

  const reviewNowLocal = Date.now();
  const sortTopics = (topics) => [...topics].sort((left, right) => {
    if (sortMode === 'mastery') {
      const leftMastery = Number.isFinite(left.mastery?.level) ? left.mastery.level : Infinity;
      const rightMastery = Number.isFinite(right.mastery?.level) ? right.mastery.level : Infinity;
      return leftMastery - rightMastery || (left.order ?? 0) - (right.order ?? 0);
    }
    if (sortMode === 'recent') {
      return (right.lastAccessed || 0) - (left.lastAccessed || 0) || (left.order ?? 0) - (right.order ?? 0);
    }
    if (sortMode === 'reviewDue') {
      const dueAt = (topic) => (
        topic.done && !topic.reviewSchedule?.paused && Number.isFinite(topic.reviewSchedule?.dueAt)
          ? topic.reviewSchedule.dueAt
          : Infinity
      );
      return dueAt(left) - dueAt(right) || (left.order ?? 0) - (right.order ?? 0);
    }
    return (left.order ?? 0) - (right.order ?? 0);
  });
  const doneTopics = sortTopics(plan.topics.filter(t => t.done === true));
  const inProgressTopics = sortTopics(plan.topics.filter(t => !t.done && t.detail && t.detail.length > 0));
  const notStartedTopics = sortTopics(plan.topics.filter(t => !t.done && (!t.detail || t.detail.length === 0)));
  const filterByStatus = (list) => {
    if (statusFilter === 'all') return list;
    if (statusFilter === 'needsReview') return list.filter(t =>
      t.done && t.reviewSchedule && !t.reviewSchedule.paused &&
      Number.isFinite(t.reviewSchedule.dueAt) && t.reviewSchedule.dueAt <= reviewNowLocal
    );
    if (statusFilter === 'hasMistakes') return list.filter(t =>
      (t.mistakes || []).some(m => m.status === 'open' || m.status === 'repairing')
    );
    if (statusFilter === 'done') return list.filter(t => t.done);
    if (statusFilter === 'inProgress') return list.filter(t => !t.done && t.detail && t.detail.length > 0);
    if (statusFilter === 'notStarted') return list.filter(t => !t.done && (!t.detail || t.detail.length === 0));
    return list;
  };

  const filteredAll = sortTopics(filterByStatus(applyFilter(plan.topics)));
  // Non-default sort modes intentionally use the flat result view so priority is
  // applied across the entire plan instead of being obscured by status sections.
  const isFiltering = searchQuery.trim() !== '' || statusFilter !== 'all' || sortMode !== 'order';

  const phases = plan.phases || [];
  const hasPhases = phases.length > 0;
  const getPhaseName = (phaseId) => {
    const p = phases.find(p => p.id === phaseId);
    return p ? p.name : null;
  };

  const groupByPhase = (topics) => {
    const grouped = {};
    if (hasPhases) {
      for (const t of topics) {
        const phaseName = getPhaseName(t.phaseId);
        if (phaseName) {
          if (!grouped[phaseName]) grouped[phaseName] = [];
          grouped[phaseName].push(t);
        }
      }
    }
    return grouped;
  };
  const inProgressGrouped = groupByPhase(inProgressTopics);
  const notStartedGrouped = groupByPhase(notStartedTopics);

  const totalTime = plan.topics.reduce((s, t) => s + (t.timeSpent || 0), 0);
  const diffCounts = { easy: 0, medium: 0, hard: 0 };
  for (const t of plan.topics) {
    if (t.difficulty && diffCounts[t.difficulty] !== undefined) diffCounts[t.difficulty]++;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayLearned = plan.topics.filter(t => t.lastAccessed && t.lastAccessed >= today.getTime()).length;
  const reviewNow = Date.now();
  const needReview = plan.topics.filter(t => (
    t.done === true
    && t.reviewSchedule
    && t.reviewSchedule.paused !== true
    && Number.isFinite(t.reviewSchedule.dueAt)
    && t.reviewSchedule.dueAt <= reviewNow
  ));

  // Calculate average mastery level across done topics with mastery data
  const topicsWithMastery = doneTopics.filter(t => t.mastery?.level != null);
  const avgMastery = topicsWithMastery.length > 0
    ? topicsWithMastery.reduce((sum, t) => sum + (t.mastery.level || 0), 0) / topicsWithMastery.length
    : null;

  function fmtTime(sec) {
    if (sec < 60) return sec + '秒';
    if (sec < 3600) return Math.round(sec / 60) + '分钟';
    return Math.round(sec / 360) / 10 + '小时';
  }

  const progressPercent = plan.topics.length > 0
    ? Math.round((doneTopics.length / plan.topics.length) * 100)
    : 0;

  const renderPhaseTopics = (grouped, topics, hasPhases, status = 'pending') => {
    const renderTree = (items, depth) => items.map(t => {
      const children = sortTopics(topics.filter(c => c.parentId === t.id));
      const hasChildren = children.length > 0;
      const isExpanded = expandedTopics[t.id] !== false;

      return (
        <div key={t.id}>
          <div className={`topic-row group ${status === 'progress' ? 'is-progress' : ''}`} style={{ paddingLeft: (depth * 24 + 16) + 'px', paddingRight: '12px' }}>
            {hasChildren ? (
              <button type='button' onClick={() => toggleExpand(t.id)} className='p-0.5 text-muted-foreground hover:text-foreground transition-colors' aria-label={`${isExpanded ? '收起' : '展开'} ${t.title}`}>
                {isExpanded ? <ChevronDown className='h-3 w-3' /> : <ChevronRight className='h-3 w-3' />}
              </button>
            ) : <span className='w-4' />}
            <span className='topic-row__dot' />
            <button type='button' className='flex-1 truncate text-left' onClick={() => handleSelectTopicWithScroll(t.id)}>{t.title}</button>

            {/* Generating / error state badge (visible from PlanView without entering TopicDetail) */}
            {t.generatingAt && !t.done && (
              <span className='flex items-center gap-1 text-[10px] text-blue-500 bg-blue-50 dark:bg-blue-950 px-1.5 py-0.5 rounded' title='AI 正在生成讲解内容…'>
                <RotateCcw className='h-3 w-3 animate-spin' />生成中
              </span>
            )}
            {t.lastError && !t.generatingAt && (
              <span className='text-[10px] text-destructive bg-destructive/10 px-1.5 py-0.5 rounded cursor-pointer' title={t.lastError} onClick={() => handleSelectTopicWithScroll(t.id)}>
                ⚠ 生成失败
              </span>
            )}

            <div className='topic-row__actions'>
              <Button variant='ghost' size='sm' className='h-6 px-2 text-xs' onClick={() => onGenerate(t.id)} disabled={!!t.generatingAt}>生成讲解</Button>
              <Button variant='ghost' size='sm' className='h-6 px-1.5 text-xs' onClick={() => handleDecompose(t.id)} disabled={decomposingId === t.id} title='分解为子知识点'>
                {decomposingId === t.id ? <RotateCcw className='h-3 w-3 animate-spin' /> : <ChevronRight className='h-3 w-3' />}
              </Button>
              <Button variant='ghost' size='sm' className='h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive' title='删除知识点' aria-label={`删除知识点 ${t.title}`} onClick={() => { setConfirmDeleteTopic({ id: t.id, title: t.title }); }}>
                <X className='h-3 w-3' />
              </Button>
            </div>
          </div>
          {hasChildren && isExpanded && renderTree(children, depth + 1)}
        </div>
      );
    });

    if (hasPhases && Object.keys(grouped).length > 0) {
      return Object.entries(grouped).map(([phaseName, phaseTopics]) => {
        const topLevel = sortTopics(phaseTopics.filter(t => t.parentId === null || t.parentId === undefined));
        return (
          <div key={phaseName}>
            <div className='phase-label'>{phaseName}</div>
            {renderTree(topLevel, 0)}
          </div>
        );
      });
    }
    return renderTree(sortTopics(topics.filter(t => t.parentId === null || t.parentId === undefined)), 0);
  };

  return (
    <div className='plan-workspace'>
      <Helmet><title>study-assistant - {plan.name}</title></Helmet>
      <section className='plan-overview'>
        <div className='plan-overview__top'>
          <div>
            <div className='ui-eyebrow'><Sparkles className='h-3.5 w-3.5' />学习计划</div>
            <h2>{plan.name}</h2>
            <p className='plan-overview__summary'>
              {hasPhases ? `${phases.length} 个学习阶段` : '自由学习路径'} · {plan.topics.length} 个知识点 · {doneTopics.length} 个已学习
            </p>
          </div>
          <div className='plan-overview__actions'>
            <Button onClick={handleAnalysis} disabled={analysisLoading}>
              {analysisLoading ? <RotateCcw className='h-4 w-4 mr-1.5 animate-spin' /> : <BarChart3 className='h-4 w-4 mr-1.5' />}
              学习分析
            </Button>
            <div className='relative' ref={menuRef}>
              <Button variant='outline' size='icon' onClick={() => setMenuOpen(!menuOpen)} title='更多操作' aria-expanded={menuOpen}>
                <MoreHorizontal className='h-4 w-4' />
              </Button>
              {menuOpen && (
                <div className='floating-menu'>
                  <button className='flex items-center gap-2 hover:bg-accent transition-colors' onClick={() => { setGraphOpen(true); setMenuOpen(false); }}>
                    <Network className='h-3.5 w-3.5 text-primary' />知识图谱
                  </button>
                  <button className='flex items-center gap-2 hover:bg-accent transition-colors' onClick={() => { setMindMapOpen(true); setMenuOpen(false); }}>
                    <Brain className='h-3.5 w-3.5 text-primary' />思维导图
                  </button>
                  <button className='flex items-center gap-2 hover:bg-accent transition-colors' onClick={() => { setExamOpen(true); setMenuOpen(false); }}>
                    <FileText className='h-3.5 w-3.5 text-primary' />智能组卷
                  </button>
                  <button className='flex items-center gap-2 hover:bg-accent transition-colors' onClick={() => { handleQuickQuiz(); setMenuOpen(false); }} disabled={quizLoading}>
                    <FileText className='h-3.5 w-3.5 text-primary' />快速测验
                  </button>
                  <button className='flex items-center gap-2 hover:bg-accent transition-colors' onClick={() => { handleCoreAnalysis(); setMenuOpen(false); }} disabled={coreLoading}>
                    <Target className='h-3.5 w-3.5 text-primary' />核心20%
                  </button>
                  <button className='flex items-center gap-2 hover:bg-accent transition-colors' onClick={() => { handleWeakAnalysis(); setMenuOpen(false); }} disabled={weakAnalysisLoading}>
                    <Search className='h-3.5 w-3.5 text-primary' />薄弱分析
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className='plan-progress' aria-label={`学习进度 ${progressPercent}%`}>
          <div className='plan-progress__track'><div className='plan-progress__bar' style={{ width: `${progressPercent}%` }} /></div>
          <span><span className='sr-only'>{doneTopics.length}/{plan.topics.length} 已完成</span><span aria-hidden='true'>{progressPercent}% · {doneTopics.length}/{plan.topics.length} 已完成</span></span>
        </div>
      </section>

      {coreOpen && (
        <div className='insight-panel'>
          <div className='insight-panel__header'>
            <span className='text-sm font-medium flex items-center gap-1.5'><Target className='h-4 w-4 text-primary' />核心 20% 分析</span>
            <div className='flex items-center gap-1'>
              {coreData && (
                <Button variant='ghost' size='sm' onClick={() => handleCoreAnalysis(true)} disabled={coreLoading} title='重新分析'>
                  <RotateCcw className='h-3.5 w-3.5' />
                </Button>
              )}
              <Button variant='ghost' size='sm' onClick={() => setCoreOpen(false)} title='关闭'><X className='h-3.5 w-3.5' /></Button>
            </div>
          </div>
          <div className='insight-panel__body space-y-3 max-h-[50vh] overflow-y-auto'>
            {coreLoading ? (
              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' />
                <span>AI 正在分析核心知识点...</span>
              </div>
            ) : coreData ? (
              <>
                <div className='text-sm text-muted-foreground'>{coreData.corePrinciple}</div>
                <div className='text-sm text-muted-foreground'>{coreData.summary}</div>
                <div className='space-y-2'>
                  <h4 className='text-sm font-medium'>核心知识点（{coreData.coreTopics.length} 个）</h4>
                  {coreData.coreTopics.map((ct, i) => (
                    <div key={i} className='rounded-md bg-muted/20 p-3 space-y-1.5'>
                      <div className='flex items-center gap-1.5'>
                        <span className='text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 font-medium'>⭐ 核心</span>
                        <span className='text-sm font-medium'>{ct.title}</span>
                      </div>
                      <div className='text-xs text-muted-foreground space-y-1'>
                        {ct.reasons.map((r, j) => <div key={j}>• {r}</div>)}
                      </div>
                      {ct.coverage && <div className='text-xs text-muted-foreground'>覆盖领域：{ct.coverage}</div>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className='text-sm text-muted-foreground'>暂无数据</p>
            )}
          </div>
        </div>
      )}

      {analysisOpen && (
        <div className='insight-panel'>
          {analysisLoading ? (
            <div className='flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground justify-center'>
              <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' />
              <span>AI 正在分析你的学习数据...</span>
            </div>
          ) : (
            <div>
              <div className='insight-panel__header'>
                <span className='text-sm font-medium flex items-center gap-1.5'><BarChart3 className='h-4 w-4 text-primary' />学习分析报告</span>
                <div className='flex items-center gap-1'>
                  {analysisData?.analysis && (
                    <>
                      <Button variant='ghost' size='sm' onClick={() => handleAnalysis(true)} title='重新分析（含对话上下文）'><RotateCcw className='h-3.5 w-3.5' /></Button>
                      <Button variant='ghost' size='sm' onClick={handleAnalysisExport} title='导出为 Markdown'><Download className='h-3.5 w-3.5' /></Button>
                    </>
                  )}
                  <Button variant='ghost' size='sm' onClick={() => setAnalysisOpen(false)}><X className='h-3.5 w-3.5' /></Button>
                </div>
              </div>
              <div className='insight-panel__body space-y-3 max-h-[50vh] overflow-y-auto'>
                <div className='text-sm text-muted-foreground'>
                  {analysisData?.analysis ? (
                    analysisData.analysis.split('\n').map((line, i) => {
                      if (line.startsWith('### ')) return <h3 key={i} className='text-sm font-medium mt-2'>{line.slice(4)}</h3>;
                      if (line.startsWith('## ')) return <h2 key={i} className='text-base font-semibold mt-3'>{line.slice(3)}</h2>;
                      if (line.startsWith('- ')) return <li key={i} className='ml-4'>{line.slice(2)}</li>;
                      if (line.trim() === '') return <br key={i} />;
                      return <p key={i}>{line}</p>;
                    })
                  ) : (
                    <p className='text-sm text-muted-foreground'>{analysisData?.analysis || '暂无数据'}</p>
                  )}
                </div>
                <div className='pt-3 space-y-2'>
                  <div className='max-h-48 overflow-y-auto space-y-2' ref={analysisChatRef}>
                    {analysisChat.length === 0 ? (
                      <div className='text-xs text-muted-foreground text-center'>对报告有疑问？在下方输入问题继续探讨</div>
                    ) : (
                      analysisChat.map((msg, i) => (
                        <div key={i} className='flex gap-2'>
                          {msg.role === 'ai' && <span className='text-xs shrink-0 mt-1'>🤖</span>}
                          <div className={`text-xs rounded-lg px-3 py-1.5 max-w-[80%] ${msg.role === 'ai' ? 'bg-muted text-foreground' : 'bg-primary/10 text-foreground ml-auto'}`}>
                            {msg.role === 'ai' ? (
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                            ) : (
                              msg.content
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <form onSubmit={e => { e.preventDefault(); handleAnalysisAsk(); }} className='flex gap-2'>
                    <input
                      value={analysisChatInput}
                      onChange={e => setAnalysisChatInput(e.target.value)}
                      placeholder='追问关于分析报告的问题...'
                      disabled={analysisChatLoading}
                      className='flex-1 h-8 rounded-md border border-input bg-background px-3 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                    />
                    <Button type='submit' size='sm' disabled={!analysisChatInput.trim() || analysisChatLoading}>
                      {analysisChatLoading ? <RotateCcw className='h-3 w-3 mr-1 animate-spin' /> : <MessageSquare className='h-3 w-3 mr-1' />}
                      发送
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {quizOpen && (
        <div className='insight-panel'>
          <div className='insight-panel__header'>
            <span className='text-sm font-medium flex items-center gap-1.5'><FileText className='h-4 w-4 text-primary' />快速测验</span>
            <div className='flex items-center gap-1'>
              {quizData && <Button variant='ghost' size='sm' onClick={() => { setQuizData(null); handleQuickQuiz(); }} title='重新出题'><RotateCcw className='h-3.5 w-3.5' /></Button>}
              <Button variant='ghost' size='sm' onClick={() => setQuizOpen(false)}><X className='h-3.5 w-3.5' /></Button>
            </div>
          </div>
          <div className='insight-panel__body space-y-3 max-h-[50vh] overflow-y-auto'>
            {quizLoading ? (
              <div className='flex items-center gap-2 text-sm text-muted-foreground'>
                <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' />
                <span>AI 正在出题...</span>
              </div>
            ) : quizData?.questions?.length > 0 ? (
              quizData.questions.map((q, i) => (
                <div key={i} className='rounded-md bg-muted/20 p-3 space-y-2'>
                  <div className='flex items-center gap-1.5 text-xs'>
                    <span className='text-muted-foreground'>第{i + 1}题</span>
                    <span className={`px-1.5 py-0.5 rounded ${q.type === 'choice' ? 'bg-primary/10 text-primary' : 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300'}`}>{q.type === 'choice' ? '选择题' : '简答题'}</span>
                    <span className='text-muted-foreground'>{q.topicTitle}</span>
                  </div>
                  <div className='text-sm'>{q.question}</div>
                  {q.type === 'choice' && q.options && (
                    <div className='space-y-1'>
                      {q.options.map((opt, j) => (
                        <div key={j} className={`text-sm px-2.5 py-1.5 rounded cursor-pointer border transition-colors ${quizAnswers[i] === opt ? 'bg-primary/10 border-primary/30' : 'border-transparent hover:bg-accent'}`} onClick={() => handleQuizAnswer(i, opt)}>
                          {opt}
                        </div>
                      ))}
                    </div>
                  )}
                  {q.type === 'open' && (
                    <textarea rows={2} placeholder='输入你的答案...' value={quizAnswers[i] || ''} onChange={e => handleQuizAnswer(i, e.target.value)} className='w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' />
                  )}
                  {quizAnswers[i] && (
                    <div className='pt-2 text-xs space-y-1'>
                      <div className='font-medium'>参考答案：</div>
                      <div className='text-muted-foreground'>{q.answer}</div>
                      {q.explanation && <div className='text-muted-foreground'>{q.explanation}</div>}
                    </div>
                  )}
                  {!quizAnswers[i] && (
                    <Button variant='ghost' size='sm' className='text-xs h-6' onClick={() => handleQuizReveal(i)}>查看答案</Button>
                  )}
                </div>
              ))
            ) : (
              <p className='text-sm text-muted-foreground'>{quizData?.message || '暂无数据'}</p>
            )}
            {quizData?.questions?.length > 0 && !quizSubmitted && (
              <div className='pt-2 border-t'>
                <Button size='sm' variant='outline' onClick={handleQuizSubmit}>保存测验结果</Button>
              </div>
            )}
            {quizSubmitted && (
              <div className='pt-2 text-xs text-muted-foreground'>测验结果已保存</div>
            )}
          </div>
        </div>
      )}

      <div className='metrics-grid'>
        {[
          { icon: Clock, value: fmtTime(totalTime), label: '累计学习时间' },
          { icon: CalendarDays, value: todayLearned, label: '今日学习' },
          { icon: Brain, value: avgMastery !== null ? Math.round(avgMastery * 100) + '%' : '-', label: '平均掌握度' },
          { icon: BookOpen, value: needReview.length, label: '待复习', warm: true },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className={`metric-card ${item.warm ? 'is-warm' : ''}`}>
              <span className='metric-card__icon'><Icon className='h-5 w-5' /></span>
              <div>
                <strong>{item.value}</strong>
                <small>{item.label}</small>
              </div>
              {item.warm && needReview.length > 0 && (
                <div className='metric-card__tooltip'>
                  {needReview.slice(0, 4).map(topic => (
                    <div key={topic.id} className='truncate'>{topic.title}{topic.weakPoints?.length ? ` · ${topic.weakPoints.slice(0, 2).join('/')}` : ''}</div>
                  ))}
                  {needReview.length > 4 && <div className='mt-1 text-muted-foreground'>还有 {needReview.length - 4} 个知识点</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <section className='section-card topic-library'>
        <div className='section-card__header'>
          <div className='section-card__heading'>
            <span><List className='h-4 w-4' /></span>
            <div>
              <h3>知识点路径</h3>
              <p>按阶段推进，悬停知识点可快速生成讲解或进一步拆解。</p>
            </div>
          </div>
          <span className='text-xs text-muted-foreground'>{plan.topics.length} 个知识点</span>
        </div>

        {/* Search + filter bar */}
        {plan.topics.length > 0 && (
          <div className='flex flex-wrap gap-2 px-4 pb-2 pt-1'>
            <div className='relative flex-1 min-w-[160px]'>
              <Search className='absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none' />
              <input
                type='text'
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder='搜索知识点...'
                className='w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring'
                aria-label='搜索知识点'
              />
              {searchQuery && (
                <button type='button' onClick={() => setSearchQuery('')} className='absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground'>
                  <X className='h-3 w-3' />
                </button>
              )}
            </div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className='rounded-md border border-input bg-background px-2 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring'
              aria-label='按状态筛选'
            >
              <option value='all'>全部状态</option>
              <option value='notStarted'>未开始</option>
              <option value='inProgress'>学习中</option>
              <option value='done'>已学习</option>
              <option value='needsReview'>待复习</option>
              <option value='hasMistakes'>有错题</option>
            </select>
            <select
              value={sortMode}
              onChange={e => setSortMode(e.target.value)}
              className='rounded-md border border-input bg-background px-2 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring'
              aria-label='知识点排序'
            >
              <option value='order'>计划顺序</option>
              <option value='reviewDue'>待复习优先</option>
              <option value='mastery'>掌握度从低到高</option>
              <option value='recent'>最近访问</option>
            </select>
          </div>
        )}

        {/* Filtered view */}
        {isFiltering && (
          <div className='topic-section'>
            {filteredAll.length === 0 ? (
              <div className='px-4 py-6 text-center text-sm text-muted-foreground'>没有符合条件的知识点</div>
            ) : (
              <>
                <div className='topic-section__label'>{searchQuery.trim() || statusFilter !== 'all' ? '筛选结果' : '排序结果'}（{filteredAll.length} 个）</div>
                {filteredAll.map(t => (
                  <div key={t.id} className={`topic-row group ${t.done ? 'is-done' : ''}`} style={{ paddingLeft: '16px', paddingRight: '12px' }}>
                    <span className='w-4' />
                    <span className='topic-row__dot' />
                    <button type='button' className={`flex-1 truncate text-left ${t.done ? 'text-muted-foreground' : ''}`} onClick={() => handleSelectTopicWithScroll(t.id)}>{t.title}</button>
                    {t.done && <span className='text-[10px] text-green-600 dark:text-green-400 shrink-0'>✓ 已学习</span>}
                    {!t.done && t.detail && <span className='text-[10px] text-blue-500 shrink-0'>学习中</span>}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {!isFiltering && notStartedTopics.length === 0 && inProgressTopics.length === 0 && doneTopics.length === 0 && (
          <div className='plans-empty-state compact'>
            <span><BookOpen className='h-6 w-6' /></span>
            <h4>这份计划还没有知识点</h4>
            <p>从下方快速添加，或回到首页使用 AI 导入整份资料。</p>
          </div>
        )}

        {!isFiltering && notStartedTopics.length > 0 && (
          <div className='topic-section'>
            <div className='topic-section__label'>未开始（{notStartedTopics.length}）</div>
            {renderPhaseTopics(notStartedGrouped, notStartedTopics, hasPhases, 'pending')}
          </div>
        )}

        {!isFiltering && inProgressTopics.length > 0 && (
          <div className='topic-section'>
            <div className='topic-section__label'>学习中（{inProgressTopics.length}）</div>
            {renderPhaseTopics(inProgressGrouped, inProgressTopics, hasPhases, 'progress')}
          </div>
        )}

        {!isFiltering && doneTopics.length > 0 && (
          <div className='topic-section'>
            <div className='topic-section__label'>已学习（{doneTopics.length}）</div>
            {doneTopics.map((topic) => {
              const hasWeakPoints = topic.weakPoints && topic.weakPoints.length > 0;
              const masteryLevel = topic.mastery?.level ?? null;
              const masteryStatus = topic.mastery?.status;
              const activeMistakes = (topic.mistakes || []).filter(m => m.status === 'open' || m.status === 'repairing');
              const activeMistakeCount = activeMistakes.length;

              return (
                <div key={topic.id} className={`topic-row is-done group ${hasWeakPoints || activeMistakeCount > 0 ? 'bg-orange-50/50 dark:bg-orange-950/20' : ''}`} style={{ paddingLeft: '16px', paddingRight: '12px' }}>
                  <span className='w-4' />
                  <span className='topic-row__dot' />
                  <button type='button' className='flex-1 truncate text-left text-muted-foreground' onClick={() => handleSelectTopicWithScroll(topic.id)}>
                    {topic.title}
                  </button>

                  {/* Mastery status badge + level indicator */}
                  {masteryStatus && masteryStatus !== 'unassessed' && (
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                        masteryStatus === 'mastered'   ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400' :
                        masteryStatus === 'developing' ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400' :
                        masteryStatus === 'needsWork'  ? 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400' :
                        masteryStatus === 'learning'   ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400' :
                        'bg-muted text-muted-foreground'
                      }`}
                      title={`掌握状态: ${
                        masteryStatus === 'mastered'   ? '已掌握' :
                        masteryStatus === 'developing' ? '进步中' :
                        masteryStatus === 'needsWork'  ? '待改进' :
                        masteryStatus === 'learning'   ? '学习中' : masteryStatus
                      }`}
                    >
                      {masteryStatus === 'mastered'   ? '✓ 已掌握' :
                       masteryStatus === 'developing' ? '↗ 进步中' :
                       masteryStatus === 'needsWork'  ? '↓ 待改进' :
                       masteryStatus === 'learning'   ? '学习中'   : masteryStatus}
                    </span>
                  )}
                  {masteryStatus === 'unassessed' && (
                    <span className='text-[10px] text-muted-foreground/60 shrink-0' title='尚未通过练习评估掌握程度'>未评估</span>
                  )}
                  {masteryLevel !== null && (
                    <div className='flex items-center gap-1.5' title={`掌握度 ${Math.round(masteryLevel * 100)}%`}>
                      <div className='w-16 h-1.5 bg-muted rounded-full overflow-hidden'>
                        <div
                          className={`h-full transition-all ${
                            masteryLevel >= 0.8 ? 'bg-green-500' :
                            masteryLevel >= 0.6 ? 'bg-blue-500' :
                            masteryLevel >= 0.4 ? 'bg-yellow-500' :
                            'bg-orange-500'
                          }`}
                          style={{ width: `${Math.round(masteryLevel * 100)}%` }}
                        />
                      </div>
                      <span className='text-[10px] text-muted-foreground tabular-nums'>{Math.round(masteryLevel * 100)}%</span>
                    </div>
                  )}

                  {/* Active mistakes badge */}
                  {activeMistakeCount > 0 && (
                    <span
                      className='text-[11px] font-medium text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-950 px-1.5 py-0.5 rounded'
                      title={`${activeMistakeCount} 个活跃错题：\n${activeMistakes.slice(0, 3).map(m => m.conceptLabel).join('\n')}${activeMistakeCount > 3 ? '\n...' : ''}`}
                    >
                      {activeMistakeCount} 错题
                    </span>
                  )}

                  {/* Legacy weak points (fallback if no mistake data) */}
                  {hasWeakPoints && activeMistakeCount === 0 && (
                    <span className='text-[11px] font-medium text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-950 px-1.5 py-0.5 rounded' title={'薄弱: ' + topic.weakPoints.join(', ')}>{topic.weakPoints.length} 个薄弱点</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className='section-card add-topics-card'>
        <div className='section-card__header'>
          <div className='section-card__heading'>
            <span><Plus className='h-4 w-4' /></span>
            <div>
              <h3>快速添加知识点</h3>
              <p>每行列一个知识点名称；整份长文档建议在首页使用 AI 导入。</p>
            </div>
          </div>
        </div>
        <div className='add-topics-card__body space-y-3'>
          <textarea
            value={bulkInput}
            onChange={e => setBulkInput(e.target.value)}
            placeholder={'逐条输入知识点，每行一个：\n变量与数据类型\n控制流（if/else）\n循环结构（for/while）\n函数定义与调用'}
            rows={4}
            aria-label='批量添加知识点'
          />
          <div className='flex flex-wrap gap-2'>
            <Button onClick={handleAdd} disabled={!bulkInput.trim()}><Plus className='h-4 w-4 mr-1.5' />添加</Button>
            <Button variant='outline' onClick={() => fileInputRef.current?.click()}>
              <Upload className='h-4 w-4 mr-1.5' />从文件读取
            </Button>
            <input ref={fileInputRef} type='file' accept='.txt,.md,.csv' onChange={handleFileImport} hidden />
          </div>
        </div>
      </section>

      {graphOpen && (
        <KnowledgeGraphModal
          plan={plan}
          onClose={() => setGraphOpen(false)}
          onSelectTopic={onSelectTopic}
          onGenerate={onGenerate}
        />
      )}
      {mindMapOpen && (
        <MindMapModal
          plan={plan}
          onClose={() => setMindMapOpen(false)}
          onSelectTopic={onSelectTopic}
        />
      )}
      {examOpen && (
        <ExamPaperModal
          plan={plan}
          onClose={() => setExamOpen(false)}
        />
      )}

      {/* Confirm: bulk add looks like a document */}
      <ConfirmDialog
        open={!!confirmBulkAdd}
        onClose={() => setConfirmBulkAdd(null)}
        onConfirm={() => {
          if (!confirmBulkAdd) return;
          onAddTopics(confirmBulkAdd.clean);
          setBulkInput('');
          setConfirmBulkAdd(null);
        }}
        title='按行拆分添加知识点？'
        description={confirmBulkAdd?.msg + '\n\n确定要继续按行拆分添加吗？（取消后可回到首页使用 AI 导入）'}
        confirmLabel='继续拆分添加'
      />

      {/* Confirm: delete topic */}
      <ConfirmDialog
        open={!!confirmDeleteTopic}
        onClose={() => setConfirmDeleteTopic(null)}
        onConfirm={() => {
          if (!confirmDeleteTopic) return;
          onRemoveTopic(confirmDeleteTopic.id);
          setConfirmDeleteTopic(null);
        }}
        title='删除知识点'
        description={`确定要删除「${confirmDeleteTopic?.title || ''}」吗？此操作不可撤销。`}
        confirmLabel='删除'
        destructive
      />
    </div>
  );
}
