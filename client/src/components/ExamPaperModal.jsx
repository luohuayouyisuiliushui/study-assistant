import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, FileText, RotateCcw, Send, Plus, ChevronRight, ChevronLeft, BarChart3, History, Trash2, AlertCircle, Sparkles, CheckCheck } from 'lucide-react';
import { Button } from '#/components/ui/button';
import api from '../api';
import ConfirmDialog from './ConfirmDialog';
import { useModalAccessibility } from './ui/use-modal-accessibility';

export default function ExamPaperModal({ plan, onClose }) {
  const [view, setView] = useState('select');
  const [selectedIds, setSelectedIds] = useState(() => {
    return plan.topics.filter(t => t.detail).map(t => t.id);
  });
  const [questionCount, setQuestionCount] = useState(10);
  const [choiceRatio, setChoiceRatio] = useState(60);
  const [difficulty, setDifficulty] = useState('balanced');
  const [currentExam, setCurrentExam] = useState(null);
  const [examPapers, setExamPapers] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const examAttemptRef = useRef(null);
  const [results, setResults] = useState(null);
  const [practiceQuestions, setPracticeQuestions] = useState(null);
  const [practiceAnswers, setPracticeAnswers] = useState({});
  const [practiceLoading, setPracticeLoading] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(null); // { unanswered: number }
  const [confirmDelete, setConfirmDelete] = useState(null); // { examId, e }
  const dialogRef = useModalAccessibility(onClose);

  useEffect(() => {
    api.listExams(plan.id).then(data => {
      if (data.exams) setExamPapers(data.exams);
    }).catch(() => {});
  }, [plan.id]);

  const toggleTopic = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const selectAll = () => setSelectedIds(plan.topics.filter(t => t.detail).map(t => t.id));
  const selectNone = () => setSelectedIds([]);

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

  const handleGenerate = async () => {
    if (selectedIds.length === 0) {
      setError('请至少选择一个知识点');
      return;
    }
    setGenerating(true);
    setError(null);
    setView('generating');

    const receivedQuestions = [];
    setCurrentExam(null);

    try {
      const tempExam = { title: '正在生成...', questions: [], paper: '' };
      setCurrentExam(tempExam);

      await api.generateExamStream(plan.id, selectedIds, {
        questionCount,
        choiceRatio: choiceRatio / 100,
      }, (event) => {
        if (event.type === 'blueprint') {
          setCurrentExam(prev => ({ ...prev, title: event.data.title, totalExpected: event.data.total }));
        } else if (event.type === 'question') {
          receivedQuestions.push(event.data);
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

      const listData = await api.listExams(plan.id);
      if (listData.exams) setExamPapers(listData.exams);
      setView('take');
    } catch (err) {
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

  const handleAnswerChange = (index, value) => {
    examAttemptRef.current = null;
    setAnswers(prev => ({ ...prev, [index]: value }));
  };

  const handleSubmit = async () => {
    if (!currentExam) return;
    const unanswered = currentExam.questions.filter(q => !answers[q.index]);
    if (unanswered.length > 0) {
      setConfirmSubmit({ unanswered: unanswered.length });
      return;
    }
    await doSubmit();
  };

  const doSubmit = async () => {
    setSubmitting(true);
    try {
      const answerList = currentExam.questions.map(q => ({
        exerciseIndex: q.index,
        userAnswer: answers[q.index] || '',
      }));
      const attemptRef = examAttemptRef.current || api.createAttemptRef('exam');
      examAttemptRef.current = attemptRef;
      const data = await api.submitExam(plan.id, currentExam.id, answerList, attemptRef);
      examAttemptRef.current = null;
      setResults(data.results);
      setView('results');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const viewPastExam = (exam, e) => {
    e.stopPropagation();
    examAttemptRef.current = null;
    setCurrentExam(exam);
    if (exam.results) {
      setResults(exam.results);
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

  const handleDeleteExam = async (examId, e) => {
    e.stopPropagation();
    setConfirmDelete({ examId, e });
  };

  const doDeleteExam = async (examId) => {
    try {
      await api.deleteExam(plan.id, examId);
      const data = await api.listExams(plan.id);
      if (data.exams) setExamPapers(data.exams);
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  };

  const handleNewExam = () => {
    examAttemptRef.current = null;
    setCurrentExam(null);
    setAnswers({});
    setResults(null);
    setError(null);
    setPracticeQuestions(null);
    setPracticeAnswers({});
    setView('select');
  };

  const handleStartPractice = async () => {
    if (!currentExam) return;
    setPracticeLoading(true);
    try {
      const data = await api.practiceExam(plan.id, currentExam.id, results.length);
      setPracticeQuestions(data.questions);
      setPracticeAnswers({});
    } catch (err) {
      alert('生成练习失败: ' + err.message);
    } finally {
      setPracticeLoading(false);
    }
  };

  const renderSelection = () => (
    <div className='space-y-4'>
      <div>
        <h3 className='text-base font-medium'>选择考察范围</h3>
        <p className='text-xs text-muted-foreground mt-1'>勾选你想要纳入试卷的知识点（仅显示已有讲解内容的知识点）</p>
      </div>

      <div className='flex items-center gap-2 text-sm'>
        <Button variant='outline' size='sm' onClick={selectAll}>全选</Button>
        <Button variant='outline' size='sm' onClick={selectNone}>取消全选</Button>
        <span className='text-xs text-muted-foreground'>已选 {selectedIds.length} 个知识点</span>
      </div>

      <div className='max-h-[40vh] overflow-y-auto space-y-3 border rounded-md p-3'>
        {Object.entries(topicsByPhase).map(([phaseName, topics]) => (
          <div key={phaseName}>
            <div className='text-xs font-medium text-muted-foreground mb-1'>{phaseName}</div>
            {topics.map(t => {
              const hasDetail = !!t.detail;
              return (
                <label key={t.id} className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors ${!hasDetail ? 'opacity-40 cursor-not-allowed' : 'hover:bg-accent'}`}>
                  <input type='checkbox' checked={selectedIds.includes(t.id)} onChange={() => hasDetail && toggleTopic(t.id)} disabled={!hasDetail} className='rounded' />
                  <span className='flex-1'>{t.title}</span>
                  {!hasDetail && <span className='text-xs text-muted-foreground'>（尚未生成讲解）</span>}
                  {t.done && <span className='text-xs text-muted-foreground'>已学习</span>}
                </label>
              );
            })}
          </div>
        ))}
      </div>

      <div className='flex items-center justify-end gap-2'>
        <Button variant='outline' onClick={onClose}>取消</Button>
        <Button onClick={() => { setError(null); setView('config'); }} disabled={selectedIds.length === 0}>
          <ChevronRight className='h-4 w-4 mr-1' />下一步：配置试卷
        </Button>
      </div>
    </div>
  );

  const renderConfig = () => (
    <div className='space-y-4'>
      <h3 className='text-base font-medium'>试卷配置</h3>

      <div className='space-y-4'>
        <div className='space-y-1.5'>
          <div className='flex items-center justify-between text-sm'>
            <span>题目总数</span>
            <span className='text-muted-foreground'>{questionCount} 题</span>
          </div>
          <input type='range' min='5' max='50' value={questionCount} onChange={e => setQuestionCount(parseInt(e.target.value))} className='w-full' />
        </div>

        <div className='space-y-1.5'>
          <div className='flex items-center justify-between text-sm'>
            <span>选择题占比</span>
            <span className='text-muted-foreground'>{choiceRatio}% 选择题 / {100 - choiceRatio}% 简答题</span>
          </div>
          <input type='range' min='0' max='100' step='10' value={choiceRatio} onChange={e => setChoiceRatio(parseInt(e.target.value))} className='w-full' />
        </div>

        <div className='space-y-1.5'>
          <label className='text-sm'>难度偏好</label>
          <select value={difficulty} onChange={e => setDifficulty(e.target.value)} className='flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm'>
            <option value='easy'>基础为主（简单50% 中等40% 较难10%）</option>
            <option value='balanced'>标准（简单30% 中等50% 较难20%）</option>
            <option value='hard'>困难为主（简单10% 中等40% 较难50%）</option>
          </select>
        </div>

        <div className='text-xs text-muted-foreground'>选定了 <strong>{selectedIds.length}</strong> 个知识点</div>
      </div>

      {error && <div className='flex items-center gap-1.5 text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2'><AlertCircle className='h-4 w-4' />{error}</div>}

      <div className='flex items-center justify-between gap-2'>
        <Button variant='outline' onClick={() => setView('select')}><ChevronLeft className='h-4 w-4 mr-1' />上一步</Button>
        <Button onClick={handleGenerate} disabled={generating}>
          {generating ? <RotateCcw className='h-4 w-4 mr-1 animate-spin' /> : <Sparkles className='h-4 w-4 mr-1' />}
          {generating ? '生成中...' : '生成试卷'}
        </Button>
      </div>
    </div>
  );

  const renderGenerating = () => (
    <div className='flex flex-col items-center justify-center py-16 gap-3'>
      <div className='animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent' />
      <h3 className='text-base font-medium'>AI 正在生成试卷...</h3>
      <p className='text-sm text-muted-foreground'>正在为 {selectedIds.length} 个知识点出题，请稍候</p>
    </div>
  );

  const renderTakeExam = () => {
    if (!currentExam) return null;
    const choiceQs = currentExam.questions.filter(q => q.type === 'choice');
    const openQs = currentExam.questions.filter(q => q.type === 'open');

    return (
      <div className='space-y-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <h3 className='text-base font-medium'>{currentExam.title}</h3>
            <span className='text-xs text-muted-foreground'>{currentExam.questions.length} 题{results && ` · ${results.filter(r => r.correct).length}/${results.length} 正确`}</span>
          </div>
        </div>

        {view !== 'results' && (
          <details className='text-sm'>
            <summary className='cursor-pointer text-muted-foreground hover:text-foreground transition-colors'>预览整卷</summary>
            <div className='mt-2 p-3 border rounded-md bg-muted/30 text-sm markdown-body max-h-[30vh] overflow-y-auto'>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentExam.paper}</ReactMarkdown>
            </div>
          </details>
        )}

        {view === 'results' && results && (
          <div className='flex flex-col items-center py-4'>
            <div className={`text-3xl font-bold ${results.filter(r => r.correct).length / results.length >= 0.6 ? 'text-green-600' : 'text-orange-600'}`}>
              {results.filter(r => r.correct).length} / {results.length}
            </div>
            <div className='text-sm text-muted-foreground'>
              {results.filter(r => r.correct).length / results.length >= 0.6 ? '通过！' : '需要继续巩固'}
            </div>
          </div>
        )}

        {choiceQs.length > 0 && (
          <div className='space-y-3'>
            <h4 className='text-sm font-medium'>一、选择题（共 {choiceQs.length} 题）</h4>
            {choiceQs.map(q => {
              const result = results?.find(r => r.exerciseIndex === q.index);
              return (
                <div key={q.index} className={`border rounded-md p-3 text-sm transition-colors ${result ? (result.correct ? 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30' : 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30') : 'border-border bg-card'}`}>
                  <div className='flex items-center gap-1.5 mb-1.5'>
                    <span className='text-muted-foreground'>{q.index + 1}.</span>
                    <span className='text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary'>选择题</span>
                    <span className='text-[10px] text-muted-foreground'>{q.difficulty === 'easy' ? '简单' : q.difficulty === 'hard' ? '较难' : '中等'}</span>
                    {q.conceptTag && <span className='text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground'>{q.conceptTag}</span>}
                  </div>
                  <div className='mb-2'>{q.question}</div>
                  <div className='space-y-1'>
                    {q.options.map(opt => {
                      const letter = opt.charAt(0);
                      const isSelected = answers[q.index] === letter;
                      const isCorrect = result?.correctAnswer === letter;
                      const isWrong = result && isSelected && !result.correct;
                      return (
                        <label key={letter}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer transition-colors ${isSelected ? 'bg-primary/10 border border-primary/30' : 'border border-transparent hover:bg-accent'} ${isCorrect && results ? 'bg-green-100 dark:bg-green-900/40 border-green-300 dark:border-green-700' : ''} ${isWrong ? 'bg-red-100 dark:bg-red-900/40 border-red-300 dark:border-red-700' : ''}`}
                          onClick={() => results ? null : handleAnswerChange(q.index, letter)}
                        >
                          <input type='radio' name={`q_${q.index}`} value={letter} checked={isSelected} onChange={() => results ? null : handleAnswerChange(q.index, letter)} disabled={!!results} className='accent-primary' />
                          <span className='flex-1'>{opt}</span>
                          {results && isCorrect && <span className='text-green-600'>✓</span>}
                          {isWrong && <span className='text-red-600'>✗</span>}
                        </label>
                      );
                    })}
                  </div>
                  {result && (
                    <div className='mt-2 pt-2 border-t space-y-1 text-xs'>
                      <div className='text-green-600'>✅ 正确答案：{result.correctAnswer}</div>
                      <div className='text-muted-foreground'>{result.explanation}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {openQs.length > 0 && (
          <div className='space-y-3'>
            <h4 className='text-sm font-medium'>二、简答题（共 {openQs.length} 题）</h4>
            {openQs.map(q => {
              const result = results?.find(r => r.exerciseIndex === q.index);
              return (
                <div key={q.index} className={`border rounded-md p-3 text-sm transition-colors ${result ? (result.correct ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50') : 'border-border bg-card'}`}>
                  <div className='flex items-center gap-1.5 mb-1.5'>
                    <span className='text-muted-foreground'>{q.index + 1}.</span>
                    <span className='text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300'>简答题</span>
                    <span className='text-[10px] text-muted-foreground'>{q.difficulty === 'easy' ? '简单' : q.difficulty === 'hard' ? '较难' : '中等'}</span>
                    {q.conceptTag && <span className='text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground'>{q.conceptTag}</span>}
                  </div>
                  <div className='mb-2'>{q.question}</div>
                  {!results ? (
                    <textarea className='w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' rows={3} value={answers[q.index] || ''} onChange={e => handleAnswerChange(q.index, e.target.value)} placeholder='请输入你的答案...' />
                  ) : (
                    <div className='space-y-1.5 text-xs'>
                      <div><strong>你的答案：</strong><span className={result?.correct ? 'text-green-600' : 'text-red-600'}>{answers[q.index] || '（未作答）'}{result?.correct ? ' ✓' : ' ✗'}</span></div>
                      <div><strong>参考答案：</strong><span className='text-muted-foreground'>{result?.correctAnswer}</span></div>
                      <div className='text-muted-foreground'>{result?.explanation}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className='flex items-center justify-end gap-2 pt-2'>
          {results ? (
            <>
              <Button variant='outline' onClick={handleNewExam}><RotateCcw className='h-4 w-4 mr-1' />出新的试卷</Button>
              <Button variant='secondary' onClick={handleStartPractice} disabled={practiceLoading}>
                {practiceLoading ? <RotateCcw className='h-4 w-4 mr-1 animate-spin' /> : <FileText className='h-4 w-4 mr-1' />}
                {practiceLoading ? '生成中...' : '错题练习'}
              </Button>
              <Button onClick={onClose}>关闭</Button>
              {practiceQuestions && renderPractice()}
            </>
          ) : (
            <>
              <Button variant='outline' onClick={() => setView('history')}>返回</Button>
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? <RotateCcw className='h-4 w-4 mr-1 animate-spin' /> : <Send className='h-4 w-4 mr-1' />}
                {submitting ? '批改中...' : '提交批改'}
              </Button>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderResults = () => renderTakeExam();

  const renderPractice = () => (
    <div className='mt-4 border-t pt-4 space-y-3'>
      <h4 className='text-sm font-medium'>针对性练习</h4>
      {practiceQuestions.map(q => (
        <div key={q.index} className='border rounded-md p-3 text-sm'>
          <div className='flex items-center gap-1.5 mb-1.5'>
            <span className='text-muted-foreground'>{q.index + 1}.</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${q.type === 'choice' ? 'bg-primary/10 text-primary' : 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300'}`}>{q.type === 'choice' ? '选择题' : '简答题'}</span>
            {q.conceptTag && <span className='text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground'>{q.conceptTag}</span>}
          </div>
          <div className='mb-2'>{q.question}</div>
          {q.type === 'choice' && q.options && (
            <div className='space-y-1'>
              {q.options.map(opt => (
                <label key={opt.charAt(0)} className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer transition-colors ${practiceAnswers[q.index] === opt.charAt(0) ? 'bg-primary/10 border border-primary/30' : 'border border-transparent hover:bg-accent'}`}
                  onClick={() => setPracticeAnswers(prev => ({ ...prev, [q.index]: opt.charAt(0) }))}
                >
                  <input type='radio' name={`practice_${q.index}`} value={opt.charAt(0)} checked={practiceAnswers[q.index] === opt.charAt(0)} onChange={() => setPracticeAnswers(prev => ({ ...prev, [q.index]: opt.charAt(0) }))} className='accent-primary' />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          )}
          {q.type === 'open' && (
            <textarea className='w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' rows={3} value={practiceAnswers[q.index] || ''} onChange={e => setPracticeAnswers(prev => ({ ...prev, [q.index]: e.target.value }))} placeholder='请输入你的答案...' />
          )}
        </div>
      ))}
    </div>
  );

  const renderHistory = () => (
    <div className='space-y-4'>
      <h3 className='text-base font-medium'>已保存的试卷</h3>

      {examPapers.length === 0 ? (
        <div className='text-center py-12 text-muted-foreground text-sm'>还没有生成过试卷</div>
      ) : (
        <div className='space-y-2 max-h-[40vh] overflow-y-auto'>
          {examPapers.slice().reverse().map(exam => {
            const correctCount = exam.results ? exam.results.filter(r => r.correct).length : null;
            const totalCount = exam.results ? exam.results.length : exam.questions.length;
            return (
              <div key={exam.id} className='flex items-center justify-between border rounded-md px-4 py-3 cursor-pointer hover:bg-accent transition-colors' onClick={(e) => viewPastExam(exam, e)}>
                <div className='min-w-0'>
                  <div className='text-sm font-medium truncate'>{exam.title}</div>
                  <div className='text-xs text-muted-foreground'>
                    {exam.questions.length} 题 · {new Date(exam.createdAt).toLocaleDateString('zh-CN')}
                    {exam.config?.topicIds && ` · ${exam.config.topicIds.length} 个知识点`}
                  </div>
                  {correctCount !== null && (
                    <div className={`text-xs mt-0.5 ${correctCount / totalCount >= 0.6 ? 'text-green-600' : 'text-orange-600'}`}>
                      {correctCount}/{totalCount} 正确
                    </div>
                  )}
                  {!exam.results && <div className='text-xs text-muted-foreground mt-0.5'>⏳ 待作答</div>}
                </div>
                <div className='flex items-center gap-1 shrink-0'>
                  {exam.results ? (
                    <Button variant='ghost' size='sm' onClick={(e) => viewPastExam(exam, e)} title='查看结果'><BarChart3 className='h-3.5 w-3.5' /></Button>
                  ) : (
                    <Button variant='ghost' size='sm' onClick={(e) => viewPastExam(exam, e)} title='继续作答'><FileText className='h-3.5 w-3.5' /></Button>
                  )}
                  <Button variant='ghost' size='sm' onClick={(e) => handleDeleteExam(exam.id, e)} title='删除'><Trash2 className='h-3.5 w-3.5 text-muted-foreground hover:text-destructive' /></Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className='flex items-center justify-between gap-2'>
        <Button onClick={handleNewExam}><Plus className='h-4 w-4 mr-1' />出新的试卷</Button>
        <Button variant='outline' onClick={onClose}>关闭</Button>
      </div>
    </div>
  );

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} data-dialog-root role='dialog' aria-modal='true' aria-label={`组卷：${plan.name}`} tabIndex={-1} className='flex flex-col w-[90vw] h-[85vh] max-w-3xl rounded-lg border bg-card shadow-lg' onClick={e => e.stopPropagation()}>
        <div className='flex items-center justify-between border-b px-4 py-2.5'>
          <h2 className='text-sm font-medium flex items-center gap-1.5'><FileText className='h-4 w-4 text-primary' />组卷</h2>
          <div className='flex items-center gap-1'>
            <Button variant='ghost' size='sm' onClick={() => setView('history')} title='历史试卷'><History className='h-3.5 w-3.5' /></Button>
            <Button variant='ghost' size='icon' onClick={onClose} aria-label='关闭组卷'><X className='h-4 w-4' /></Button>
          </div>
        </div>

        <div className='flex-1 overflow-auto p-4'>
          {view === 'select' && renderSelection()}
          {view === 'config' && renderConfig()}
          {view === 'generating' && renderGenerating()}
          {view === 'take' && renderTakeExam()}
          {view === 'results' && renderResults()}
          {view === 'history' && renderHistory()}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmSubmit}
        onClose={() => setConfirmSubmit(null)}
        onConfirm={() => { setConfirmSubmit(null); doSubmit(); }}
        title='还有未作答的题目'
        description={`还有 ${confirmSubmit?.unanswered ?? 0} 道题未作答，确定要提交吗？未作答的题目将被视为错误。`}
        confirmLabel='仍然提交'
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => { const id = confirmDelete?.examId; setConfirmDelete(null); if (id) doDeleteExam(id); }}
        title='删除试卷'
        description='确定要删除这张试卷吗？此操作不可撤销。'
        confirmLabel='删除'
        destructive
      />
    </div>
  );
}
