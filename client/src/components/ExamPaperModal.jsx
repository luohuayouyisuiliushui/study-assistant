import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../api';

/**
 * ExamPaperModal — generates, displays, and grades cross-topic exam papers.
 * Steps: topic selection → config → generation → taking → results → review integration
 */
export default function ExamPaperModal({ plan, onClose }) {
  // ─── View State ───
  // 'select' | 'config' | 'generating' | 'take' | 'results' | 'history'
  const [view, setView] = useState('select');

  // ─── Topic Selection ───
  const [selectedIds, setSelectedIds] = useState(() => {
    // Default: select all topics that have been generated (have detail)
    return plan.topics.filter(t => t.detail).map(t => t.id);
  });

  // ─── Exam Config ───
  const [questionCount, setQuestionCount] = useState(10);
  const [choiceRatio, setChoiceRatio] = useState(60); // percentage
  const [difficulty, setDifficulty] = useState('balanced'); // 'easy' | 'balanced' | 'hard'

  // ─── Exam Data ───
  const [currentExam, setCurrentExam] = useState(null); // { id, title, paper, questions }
  const [examPapers, setExamPapers] = useState([]); // history
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  // ─── Answer State ───
  const [answers, setAnswers] = useState({}); // { [index]: userAnswer }
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);

  // Load exam history on mount
  useEffect(() => {
    api.listExams(plan.id).then(data => {
      if (data.exams) setExamPapers(data.exams);
    }).catch(() => {});
  }, [plan.id]);

  // Toggle topic selection
  const toggleTopic = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  // Select all / deselect all generated topics
  const selectAll = () => setSelectedIds(plan.topics.filter(t => t.detail).map(t => t.id));
  const selectNone = () => setSelectedIds([]);

  // Group topics by phase for selection UI
  const phases = plan.phases || [];
  const hasPhases = phases.length > 0;

  const getPhaseName = (phaseId) => {
    const p = phases.find(p => p.id === phaseId);
    return p ? p.name : null;
  };

  const topicsByPhase = {};
  for (const t of plan.topics) {
    const phaseName = getPhaseName(t.phaseId) || '其他';
    if (!topicsByPhase[phaseName]) topicsByPhase[phaseName] = [];
    topicsByPhase[phaseName].push(t);
  }

  // Generate exam (streaming)
  const handleGenerate = async () => {
    if (selectedIds.length === 0) {
      setError('请至少选择一个知识点');
      return;
    }
    setGenerating(true);
    setError(null);
    setView('generating');

    // Use new approach: show questions as they arrive via SSE
    const receivedQuestions = [];
    setCurrentExam(null);

    try {
      // Set up initial exam state for progressive rendering
      const tempExam = { title: '正在生成...', questions: [], paper: '' };
      setCurrentExam(tempExam);

      await api.generateExamStream(plan.id, selectedIds, {
        questionCount,
        choiceRatio: choiceRatio / 100,
      }, (event) => {
        if (event.type === 'status') {
          // Update status message
        } else if (event.type === 'blueprint') {
          setCurrentExam(prev => ({ ...prev, title: event.data.title, totalExpected: event.data.total }));
        } else if (event.type === 'question') {
          receivedQuestions.push(event.data);
          // Re-sort by index
          receivedQuestions.sort((a, b) => a.index - b.index);
          setCurrentExam(prev => ({
            ...prev,
            questions: [...receivedQuestions],
            progress: `${receivedQuestions.length}/${prev.totalExpected || '?'}`,
          }));
        } else if (event.type === 'done') {
          receivedQuestions.sort((a, b) => a.index - b.index);
          const finalExam = {
            id: event.data.examId,
            title: currentExam?.title || '综合测验',
            questions: receivedQuestions,
            paper: '',
            totalExpected: receivedQuestions.length,
          };
          setCurrentExam(finalExam);
          setExamPapers(prev => [finalExam, ...prev]);
        }
      });

      // Refresh exam list
      const listData = await api.listExams(plan.id);
      if (listData.exams) setExamPapers(listData.exams);
      setView('take');
    } catch (err) {
      // Fallback to non-streaming if SSE fails
      if (receivedQuestions.length === 0) {
        try {
          const data = await api.generateExam(plan.id, selectedIds, {
            questionCount,
            choiceRatio: choiceRatio / 100,
            difficulty,
          });
          setCurrentExam(data.exam);
          const listData = await api.listExams(plan.id);
          if (listData.exams) setExamPapers(listData.exams);
          setView('take');
        } catch (err2) {
          setError(err2.message);
          setView('config');
        }
      }
    } finally {
      setGenerating(false);
    }
  };

  // Handle answer change
  const handleAnswerChange = (index, value) => {
    setAnswers(prev => ({ ...prev, [index]: value }));
  };

  // Submit exam
  const handleSubmit = async () => {
    if (!currentExam) return;
    // Check all questions answered
    const unanswered = currentExam.questions.filter(q => !answers[q.index]);
    if (unanswered.length > 0) {
      if (!confirm(`还有 ${unanswered.length} 道题未作答，确定要提交吗？`)) return;
    }

    setSubmitting(true);
    try {
      const answerList = currentExam.questions.map(q => ({
        exerciseIndex: q.index,
        userAnswer: answers[q.index] || '',
      }));
      const data = await api.submitExam(plan.id, currentExam.id, answerList);
      setResults(data.results);
      setView('results');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // View a past exam
  const viewPastExam = (exam, e) => {
    e.stopPropagation();
    setCurrentExam(exam);
    if (exam.results) {
      setResults(exam.results);
      // Pre-fill answers from results
      const restored = {};
      for (const r of exam.results) {
        restored[r.exerciseIndex] = r.userAnswer;
      }
      setAnswers(restored);
      setView('results');
    } else {
      setAnswers({});
      setResults(null);
      setView('take');
    }
  };

  // Delete exam
  const handleDeleteExam = async (examId, e) => {
    e.stopPropagation();
    if (!confirm('确定要删除这张试卷吗？')) return;
    try {
      await api.deleteExam(plan.id, examId);
      const data = await api.listExams(plan.id);
      if (data.exams) setExamPapers(data.exams);
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  };

  // Reset to config step (generate new exam)
  const handleNewExam = () => {
    setCurrentExam(null);
    setAnswers({});
    setResults(null);
    setError(null);
    setView('select');
  };

  // ─── Render: Topic Selection ───
  const renderSelection = () => (
    <div className="exam-step">
      <h3>📚 选择考察范围</h3>
      <p className="exam-hint">勾选你想要纳入试卷的知识点（仅显示已有讲解内容的知识点）</p>

      <div className="exam-select-actions">
        <button className="btn btn-xs" onClick={selectAll}>全选</button>
        <button className="btn btn-xs" onClick={selectNone}>取消全选</button>
        <span className="exam-count">已选 {selectedIds.length} 个知识点</span>
      </div>

      <div className="exam-topic-list">
        {Object.entries(topicsByPhase).map(([phaseName, topics]) => (
          <div key={phaseName} className="exam-phase-group">
            <div className="exam-phase-title">{phaseName}</div>
            {topics.map(t => {
              const hasDetail = !!t.detail;
              return (
                <label key={t.id} className={`exam-topic-item ${!hasDetail ? 'disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(t.id)}
                    onChange={() => hasDetail && toggleTopic(t.id)}
                    disabled={!hasDetail}
                  />
                  <span className="exam-topic-level">
                    {t.level === 1 ? '📘' : t.level === 2 ? '📗' : t.level === 3 ? '📙' : '📄'}
                  </span>
                  <span className="exam-topic-title">{t.title}</span>
                  {!hasDetail && <span className="exam-no-detail">（尚未生成讲解）</span>}
                  {t.done && <span className="exam-done-badge">✅</span>}
                </label>
              );
            })}
          </div>
        ))}
      </div>

      <div className="exam-nav-buttons">
        <button className="btn btn-sm" onClick={onClose}>取消</button>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => { setError(null); setView('config'); }}
          disabled={selectedIds.length === 0}
        >
          下一步：配置试卷
        </button>
      </div>
    </div>
  );

  // ─── Render: Config ───
  const renderConfig = () => (
    <div className="exam-step">
      <h3>⚙️ 试卷配置</h3>

      <div className="exam-config-group">
        <label className="exam-config-item">
          <span>题目总数</span>
          <input
            type="range"
            min="5"
            max="50"
            value={questionCount}
            onChange={e => setQuestionCount(parseInt(e.target.value))}
          />
          <span className="exam-config-value">{questionCount} 题</span>
        </label>

        <label className="exam-config-item">
          <span>选择题占比</span>
          <input
            type="range"
            min="0"
            max="100"
            step="10"
            value={choiceRatio}
            onChange={e => setChoiceRatio(parseInt(e.target.value))}
          />
          <span className="exam-config-value">{choiceRatio}% 选择题 / {100 - choiceRatio}% 简答题</span>
        </label>

        <label className="exam-config-item">
          <span>难度偏好</span>
          <select value={difficulty} onChange={e => setDifficulty(e.target.value)} className="exam-select">
            <option value="easy">🌱 基础为主（简单50% 中等40% 较难10%）</option>
            <option value="balanced">⚖️ 标准（简单30% 中等50% 较难20%）</option>
            <option value="hard">🔥 困难为主（简单10% 中等40% 较难50%）</option>
          </select>
        </label>

        <div className="exam-config-info">
          📌 选定了 <strong>{selectedIds.length}</strong> 个知识点
        </div>
      </div>

      {error && <div className="exam-error">❌ {error}</div>}

      <div className="exam-nav-buttons">
        <button className="btn btn-sm" onClick={() => setView('select')}>上一步</button>
        <button className="btn btn-primary btn-sm" onClick={handleGenerate} disabled={generating}>
          {generating ? '⏳ 生成中...' : '🚀 生成试卷'}
        </button>
      </div>
    </div>
  );

  // ─── Render: Generating ───
  const renderGenerating = () => (
    <div className="exam-step exam-loading">
      <div className="spinner" />
      <h3>🤖 AI 正在生成试卷...</h3>
      <p>正在为 {selectedIds.length} 个知识点出题，请稍候</p>
    </div>
  );

  // ─── Render: Take Exam ───
  const renderTakeExam = () => {
    if (!currentExam) return null;
    const choiceQs = currentExam.questions.filter(q => q.type === 'choice');
    const openQs = currentExam.questions.filter(q => q.type === 'open');

    return (
      <div className="exam-step">
        <div className="exam-header">
          <h3>📝 {currentExam.title}</h3>
          <span className="exam-question-count">
            {currentExam.questions.length} 题
            {results && ` · ${results.filter(r => r.correct).length}/${results.length} 正确`}
          </span>
        </div>

        {view !== 'results' && (
          <div className="exam-paper-preview">
            <details>
              <summary>📄 预览整卷</summary>
              <div className="exam-paper-markdown markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {currentExam.paper}
                </ReactMarkdown>
              </div>
            </details>
          </div>
        )}

        {view === 'results' && results && (
          <div className="exam-score-summary">
            <div className={`exam-score ${results.filter(r => r.correct).length / results.length >= 0.6 ? 'pass' : 'fail'}`}>
              {results.filter(r => r.correct).length} / {results.length}
            </div>
            <div className="exam-score-label">
              {results.filter(r => r.correct).length / results.length >= 0.6 ? '🎉 通过！' : '📚 需要继续巩固'}
            </div>
          </div>
        )}

        {/* Choice Questions */}
        {choiceQs.length > 0 && (
          <div className="exam-section">
            <h4>一、选择题（共 {choiceQs.length} 题）</h4>
            {choiceQs.map(q => {
              const result = results?.find(r => r.exerciseIndex === q.index);
              return (
                <div key={q.index} className={`exam-question ${result ? (result.correct ? 'correct' : 'wrong') : ''}`}>
                  <div className="exam-question-header">
                    <span className="exam-q-number">{q.index + 1}.</span>
                    <span className="exam-q-type-badge choice">选择题</span>
                    <span className="exam-q-diff {q.difficulty}">{q.difficulty === 'easy' ? '简单' : q.difficulty === 'hard' ? '较难' : '中等'}</span>
                    {q.conceptTag && <span className="exam-q-tag">{q.conceptTag}</span>}
                  </div>
                  <div className="exam-q-text">{q.question}</div>
                  <div className="exam-options">
                    {q.options.map(opt => {
                      const letter = opt.charAt(0);
                      const isSelected = answers[q.index] === letter;
                      const isCorrect = result?.correctAnswer === letter;
                      const isWrong = result && isSelected && !result.correct;
                      return (
                        <label key={letter}
                          className={`exam-option ${isSelected ? 'selected' : ''} ${isCorrect && results ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
                          onClick={() => results ? null : handleAnswerChange(q.index, letter)}
                        >
                          <input
                            type="radio"
                            name={`q_${q.index}`}
                            value={letter}
                            checked={isSelected}
                            onChange={() => results ? null : handleAnswerChange(q.index, letter)}
                            disabled={!!results}
                          />
                          <span className="exam-option-text">{opt}</span>
                          {results && isCorrect && <span className="exam-mark correct-mark">✓</span>}
                          {isWrong && <span className="exam-mark wrong-mark">✗</span>}
                        </label>
                      );
                    })}
                  </div>
                  {result && (
                    <div className="exam-feedback">
                      <div className="exam-feedback-answer">✅ 正确答案：{result.correctAnswer}</div>
                      <div className="exam-feedback-explain">💡 {result.explanation}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Open Questions */}
        {openQs.length > 0 && (
          <div className="exam-section">
            <h4>二、简答题（共 {openQs.length} 题）</h4>
            {openQs.map(q => {
              const result = results?.find(r => r.exerciseIndex === q.index);
              return (
                <div key={q.index} className={`exam-question ${result ? (result.correct ? 'correct' : 'wrong') : ''}`}>
                  <div className="exam-question-header">
                    <span className="exam-q-number">{q.index + 1}.</span>
                    <span className="exam-q-type-badge open">简答题</span>
                    <span className="exam-q-diff">{q.difficulty === 'easy' ? '简单' : q.difficulty === 'hard' ? '较难' : '中等'}</span>
                    {q.conceptTag && <span className="exam-q-tag">{q.conceptTag}</span>}
                  </div>
                  <div className="exam-q-text">{q.question}</div>
                  {!results ? (
                    <textarea
                      className="exam-textarea"
                      rows={3}
                      value={answers[q.index] || ''}
                      onChange={e => handleAnswerChange(q.index, e.target.value)}
                      placeholder="请输入你的答案..."
                    />
                  ) : (
                    <div className="exam-answer-review">
                      <div className="exam-user-answer">
                        <strong>你的答案：</strong>
                        <span className={result?.correct ? 'correct-text' : 'wrong-text'}>
                          {answers[q.index] || '（未作答）'}
                        </span>
                        {result?.correct ? ' ✓' : ' ✗'}
                      </div>
                      <div className="exam-correct-answer">
                        <strong>参考答案：</strong>
                        <span>{result?.correctAnswer}</span>
                      </div>
                      <div className="exam-feedback-explain">💡 {result?.explanation}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="exam-nav-buttons">
          {results ? (
            <>
              <button className="btn btn-sm" onClick={handleNewExam}>🔄 出新的试卷</button>
              <button className="btn btn-sm" onClick={onClose}>关闭</button>
            </>
          ) : (
            <>
              <button className="btn btn-sm" onClick={() => setView('history')}>返回</button>
              <button className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={submitting}>
                {submitting ? '⏳ 批改中...' : '📮 提交批改'}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  // ─── Render: Results (same as take with results shown) ───
  const renderResults = () => renderTakeExam();

  // ─── Render: History ───
  const renderHistory = () => (
    <div className="exam-step">
      <h3>📋 已保存的试卷</h3>

      {examPapers.length === 0 ? (
        <div className="exam-empty">
          <p>还没有生成过试卷</p>
        </div>
      ) : (
        <div className="exam-history-list">
          {examPapers.slice().reverse().map(exam => {
            const correctCount = exam.results ? exam.results.filter(r => r.correct).length : null;
            const totalCount = exam.results ? exam.results.length : exam.questions.length;
            return (
              <div key={exam.id} className="exam-history-item" onClick={(e) => viewPastExam(exam, e)}>
                <div className="exam-history-info">
                  <div className="exam-history-title">{exam.title}</div>
                  <div className="exam-history-meta">
                    {exam.questions.length} 题 · {new Date(exam.createdAt).toLocaleDateString('zh-CN')}
                    {exam.config?.topicIds && ` · ${exam.config.topicIds.length} 个知识点`}
                  </div>
                  {correctCount !== null && (
                    <div className={`exam-history-score ${correctCount / totalCount >= 0.6 ? 'pass' : 'fail'}`}>
                      {correctCount}/{totalCount} 正确
                    </div>
                  )}
                  {!exam.results && <div className="exam-history-status">⏳ 待作答</div>}
                </div>
                <div className="exam-history-actions">
                  {exam.results ? (
                    <button className="btn-tiny" onClick={(e) => viewPastExam(exam, e)} title="查看结果">📊</button>
                  ) : (
                    <button className="btn-tiny" onClick={(e) => viewPastExam(exam, e)} title="继续作答">✏️</button>
                  )}
                  <button className="btn-tiny danger" onClick={(e) => handleDeleteExam(exam.id, e)} title="删除">🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="exam-nav-buttons">
        <button className="btn btn-primary btn-sm" onClick={handleNewExam}>📝 出新的试卷</button>
        <button className="btn btn-sm" onClick={onClose}>关闭</button>
      </div>
    </div>
  );

  // ─── Main Render ───
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal exam-modal">
        <div className="modal-header">
          <h2>📝 组卷</h2>
          <div className="modal-header-actions">
            <button
              className={`btn-tiny ${view === 'history' ? 'active' : ''}`}
              onClick={() => setView('history')}
              title="历史试卷"
            >
              📋
            </button>
            <button className="btn-tiny" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="modal-body">
          {view === 'select' && renderSelection()}
          {view === 'config' && renderConfig()}
          {view === 'generating' && renderGenerating()}
          {view === 'take' && renderTakeExam()}
          {view === 'results' && renderResults()}
          {view === 'history' && renderHistory()}
        </div>
      </div>
    </div>
  );
}
