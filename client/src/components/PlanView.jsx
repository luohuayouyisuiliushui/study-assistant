import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../api';
import KnowledgeGraphModal from './KnowledgeGraphModal';
import { detectEncoding } from '../utils/encoding';

export default function PlanView({ plan, onAddTopics, onRemoveTopic, onSelectTopic, onGenerate }) {
  const [bulkInput, setBulkInput] = useState('');
  const fileInputRef = useRef(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisData, setAnalysisData] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisChat, setAnalysisChat] = useState([]);
  const [analysisChatInput, setAnalysisChatInput] = useState('');
  const [analysisChatLoading, setAnalysisChatLoading] = useState(false);
  const analysisChatRef = useRef(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [expandedTopics, setExpandedTopics] = useState({});

  // Toggle expand/collapse for a parent topic
  const toggleExpand = (topicId) => {
    setExpandedTopics(prev => ({ ...prev, [topicId]: !prev[topicId] }));
  };

  // Scroll analysis chat to bottom
  useEffect(() => {
    if (analysisChatRef.current) {
      analysisChatRef.current.scrollTop = analysisChatRef.current.scrollHeight;
    }
  }, [analysisChat.length]);

  if (!plan) return <div className="loading">加载中...</div>;

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
      setAnalysisChat([]); // clear old chat when regenerating
    } catch (err) {
      setAnalysisData({ analysis: '❌ 分析失败: ' + err.message });
    } finally {
      setAnalysisLoading(false);
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
      analysisChat.forEach((msg, i) => {
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

  const handleAdd = () => {
    const lines = bulkInput.split('\n').map(s => s.trim()).filter(Boolean);
    // Detect format: if most lines start with -/*/numbered, strip those prefixes
    const bulletCount = lines.filter(l => /^[-*]\s/.test(l) || /^\d+[\.\)]\s/.test(l)).length;
    const isBulleted = bulletCount > lines.length * 0.5;

    const clean = lines
      .filter(l => !l.startsWith('#'))  // skip markdown headers
      .map(l => isBulleted ? l.replace(/^[-*]\s*/, '').replace(/^\d+[\.\)]\s*/, '') : l)
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
    // Reset file input so the same file can be re-selected
    e.target.value = '';
  };

  const doneTopics = plan.topics.filter(t => t.done);
  const inProgressTopics = plan.topics.filter(t => !t.done && t.detail && t.detail.length > 0);
  const notStartedTopics = plan.topics.filter(t => !t.done && (!t.detail || t.detail.length === 0));

  // Group topics by phase (only if plan has phases)
  const phases = plan.phases || [];
  const hasPhases = phases.length > 0;
  const getPhaseName = (phaseId) => {
    const p = phases.find(p => p.id === phaseId);
    return p ? p.name : null;
  };

  // Group topics by phase
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

  // Compute learning stats
  const totalTime = plan.topics.reduce((s, t) => s + (t.timeSpent || 0), 0);
  const diffCounts = { easy: 0, medium: 0, hard: 0 };
  for (const t of plan.topics) {
    if (t.difficulty && diffCounts[t.difficulty] !== undefined) diffCounts[t.difficulty]++;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayLearned = plan.topics.filter(t => t.lastAccessed && t.lastAccessed >= today.getTime()).length;
  const needReview = plan.topics.filter(t =>
    t.done && (t.difficulty === 'hard' || (plan.history || []).filter(h => h.topicId === t.id && h.role === 'user').length >= 2)
  );

  function fmtTime(sec) {
    if (sec < 60) return sec + '秒';
    if (sec < 3600) return Math.round(sec / 60) + '分钟';
    return Math.round(sec / 360) / 10 + '小时';
  }

  // Render topic tree for a set of topics (grouped by phase if applicable)
  const renderPhaseTopics = (grouped, topics, hasPhases) => {
    const renderTree = (items, depth) => items.map(t => {
      const children = topics.filter(c => c.parentId === t.id).sort((a, b) => a.order - b.order);
      const hasChildren = children.length > 0;
      const isExpanded = expandedTopics[t.id] !== false;
      const levelIcon = t.level === 1 ? '📘' : t.level === 2 ? '📗' : t.level === 3 ? '📙' : '📄';

      return (
        <div key={t.id}>
          <div className="topic-item pending" style={{ paddingLeft: (depth * 20 + 8) + 'px' }}>
            {hasChildren && (
              <span className="topic-expand" onClick={() => toggleExpand(t.id)}>
                {isExpanded ? '▼' : '▶'}
              </span>
            )}
            {!hasChildren && <span className="topic-expand-placeholder"> </span>}
            <span className="topic-level-badge" title={'Lv.' + (t.level || 1)}>{levelIcon}</span>
            <span className="topic-title">{t.title}</span>
            <div className="topic-actions">
              <button className="btn-tiny primary" onClick={() => onGenerate(t.id)}>
                生成讲解
              </button>
              <button className="btn-tiny danger" onClick={() => { if (confirm('确定要删除这个知识点吗？')) onRemoveTopic(t.id); }}>✕</button>
            </div>
          </div>
          {hasChildren && isExpanded && renderTree(children, depth + 1)}
        </div>
      );
    });

    if (hasPhases && Object.keys(grouped).length > 0) {
      return Object.entries(grouped).map(([phaseName, phaseTopics]) => {
        const topLevel = phaseTopics.filter(t => t.parentId === null || t.parentId === undefined).sort((a, b) => a.order - b.order);
        return (
          <div key={phaseName} className="phase-group">
            <div className="phase-title">{phaseName}</div>
            {renderTree(topLevel, 0)}
          </div>
        );
      });
    }

    // Flat list (no phases)
    return renderTree(topics, 0);
  };

  return (
    <div className="plan-view">
      <div className="plan-view-header">
        <h2>📋 {plan.name}</h2>
        <div className="plan-view-actions">
          <span className="plan-progress">{doneTopics.length}/{plan.topics.length} 已完成</span>
          <button className="btn btn-sm" onClick={handleAnalysis} disabled={analysisLoading}>
            {analysisLoading ? '⏳' : '📊'} 学习分析
          </button>
          <button className="btn btn-sm" onClick={() => setGraphOpen(true)} title="知识图谱">
            🕸️ 知识图谱
          </button>
        </div>
      </div>

      {/* Learning Analysis Panel */}
      {analysisOpen && (
        <div className="analysis-panel">
          {analysisLoading ? (
            <div className="analysis-loading">
              <div className="spinner-sm" />
              <span>AI 正在分析你的学习数据...</span>
            </div>
          ) : (
            <div className="analysis-content">
              <div className="analysis-header">
                <span>📊 学习分析报告</span>
                <div className="analysis-header-actions">
                  {analysisData?.analysis && (
                    <>
                      <button className="btn-tiny" onClick={() => handleAnalysis(true)} title="重新分析（含对话上下文）">🔄</button>
                      <button className="btn-tiny" onClick={handleAnalysisExport} title="导出为 Markdown">⬇️</button>
                    </>
                  )}
                  <button className="btn-tiny" onClick={() => setAnalysisOpen(false)}>✕</button>
                </div>
              </div>
              <div className="analysis-body markdown-body">
                {analysisData?.analysis ? (
                  analysisData.analysis.split('\n').map((line, i) => {
                    if (line.startsWith('### ')) return <h3 key={i}>{line.slice(4)}</h3>;
                    if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>;
                    if (line.startsWith('- ')) return <li key={i} className="analysis-li">{line.slice(2)}</li>;
                    if (line.trim() === '') return <br key={i} />;
                    return <p key={i}>{line}</p>;
                  })
                ) : (
                  <p className="analysis-error">{analysisData?.analysis || '暂无数据'}</p>
                )}
              </div>

              {/* Analysis chat panel */}
              <div className="analysis-chat">
                <div className="analysis-chat-messages" ref={analysisChatRef}>
                  {analysisChat.length === 0 ? (
                    <div className="analysis-chat-empty">对报告有疑问？在下方输入问题继续探讨</div>
                  ) : (
                    analysisChat.map((msg, i) => (
                      <div key={i} className={"analysis-chat-msg " + msg.role}>
                        {msg.role === 'ai' && <div className="analysis-chat-avatar">🤖</div>}
                        <div className={"analysis-chat-bubble " + msg.role + "-bubble"}>
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
                <div className="analysis-chat-input">
                  <form onSubmit={e => { e.preventDefault(); handleAnalysisAsk(); }}>
                    <input
                      value={analysisChatInput}
                      onChange={e => setAnalysisChatInput(e.target.value)}
                      placeholder="追问关于分析报告的问题..."
                      disabled={analysisChatLoading}
                    />
                    <button type="submit" disabled={!analysisChatInput.trim() || analysisChatLoading}>
                      {analysisChatLoading ? '思考中...' : '发送'}
                    </button>
                  </form>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Learning Stats Dashboard */}
      <div className="plan-stats">
        <div className="stat-item">
          <span className="stat-icon">⏱️</span>
          <span className="stat-value">{fmtTime(totalTime)}</span>
          <span className="stat-label">学习时间</span>
        </div>
        <div className="stat-item">
          <span className="stat-icon">📅</span>
          <span className="stat-value">{todayLearned}</span>
          <span className="stat-label">今日学习</span>
        </div>
        <div className="stat-item">
          <span className="stat-icon">
            {diffCounts.easy > diffCounts.hard ? '🟢' : diffCounts.hard > diffCounts.easy ? '🔴' : '🟡'}
          </span>
          <span className="stat-value">{diffCounts.easy + diffCounts.medium + diffCounts.hard || '-'}</span>
          <span className="stat-label">已评价</span>
        </div>
        {needReview.length > 0 && (
          <div className="stat-item review-warn" title={needReview.map(t => t.title).join('、')}>
            <span className="stat-icon">📌</span>
            <span className="stat-value">{needReview.length}</span>
            <span className="stat-label">待复习</span>
          </div>
        )}
      </div>

      <div className="plan-topics">
        <div className="section-title">知识点列表</div>
        {notStartedTopics.length === 0 && inProgressTopics.length === 0 && doneTopics.length === 0 && (
          <div className="plan-empty-tip">还没有知识点，从下方添加或导入文件</div>
        )}

        {/* Not Started section */}
        {notStartedTopics.length > 0 && (
          <>
            <div className="phase-title" style={{ fontSize: '13px', color: '#94a3b8', marginTop: '8px' }}>
              ⏸️ 未开始（{notStartedTopics.length}）
            </div>
            {renderPhaseTopics(notStartedGrouped, notStartedTopics, hasPhases)}
          </>
        )}

        {/* In Progress section */}
        {inProgressTopics.length > 0 && (
          <>
            <div className="phase-title" style={{ fontSize: '13px', color: '#f59e0b', marginTop: '12px' }}>
              🔄 学习中（{inProgressTopics.length}）
            </div>
            {renderPhaseTopics(inProgressGrouped, inProgressTopics, hasPhases)}
          </>
        )}

        {/* Done section */}
        {doneTopics.length > 0 && (
          <>
            <div className="section-title" style={{ marginTop: '16px' }}>✅ 已学习</div>
            {doneTopics.map((t) => (
              <div key={t.id} className="topic-item done" onClick={() => onSelectTopic(t.id)}>
                <span className="topic-order">✓</span>
                <span className="topic-level-badge">
                  {t.level === 1 ? '📘' : t.level === 2 ? '📗' : t.level === 3 ? '📙' : '📄'}
                </span>
                <span className="topic-title">{t.title}</span>
                <span className="topic-done-label">已学习</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="plan-add">
        <div className="section-title">添加知识点</div>
        <textarea
          value={bulkInput}
          onChange={e => setBulkInput(e.target.value)}
          placeholder={`每行一个知识点，例如：\n- 装饰器\n- 生成器\n- 上下文管理器\n\n也支持从文件导入（.txt / .md）`}
          rows={4}
        />
        <div className="plan-add-actions">
          <button className="btn btn-primary" onClick={handleAdd} disabled={!bulkInput.trim()}>
            添加
          </button>
          <button className="btn btn-sm" onClick={() => fileInputRef.current?.click()}>
            📂 从文件导入
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.csv"
            onChange={handleFileImport}
            style={{ display: 'none' }}
          />
        </div>
      </div>
      {graphOpen && (
        <KnowledgeGraphModal
          plan={plan}
          onClose={() => setGraphOpen(false)}
          onSelectTopic={onSelectTopic}
          onGenerate={onGenerate}
        />
      )}
    </div>
  );
}
