import { useState, useEffect, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, RefreshCw, Sparkles, AlertCircle, ChevronDown, ChevronUp, TrendingUp, BookOpen, Target, Clock, FileQuestion, CalendarDays, CheckCircle2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card';
import { Progress } from '#/components/ui/progress';
import api from '../api';

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(seconds) {
  const totalMinutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}

function formatMinutes(v) {
  const minutes = Math.max(0, Math.round(Number(v) || 0));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} 小时` : `${hours} 小时 ${remainder} 分钟`;
}

function readableQuestionStyle(value) {
  if (typeof value !== 'string' || !value.trim()) return '提问样本不足';
  if (/未提供|无法识别|无法判断|没有.*(?:文本|数据)|不足以|暂无.*(?:文本|数据)/.test(value)) return '提问样本不足';
  return value.trim();
}

function renderMarkdown(text) {
  if (!text) return null;
  return text.split('\n').map((line, i) => {
    if (line.startsWith('### ')) return <h3 key={i} className="text-sm font-medium mt-3 mb-1.5">{line.slice(4)}</h3>;
    if (line.startsWith('## ')) return <h2 key={i} className="text-base font-semibold mt-4 mb-2">{line.slice(3)}</h2>;
    if (line.startsWith('- ')) return <li key={i} className="ml-4 mb-0.5 text-sm">{line.slice(2)}</li>;
    if (line.trim() === '') return <br key={i} />;
    return <p key={i} className="text-sm mb-1">{line}</p>;
  });
}

function StatCard({ value, label, icon: Icon }) {
  return (
    <div className="flex flex-col items-start gap-1 p-3 rounded-lg bg-muted/50">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <div className="text-3xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function UserProfile({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [summary, setSummary] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [showReport, setShowReport] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const d = await api.getUserProfileSummary();
      setSummary(d.summary);
      if (d.summary.hasAIAnalysis) {
        const pd = await api.getUserProfile();
        setProfile(pd.profile);
      } else {
        setProfile(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const d = await api.analyzeUserProfile();
      setProfile(d.profile);
      const sd = await api.getUserProfileSummary();
      setSummary(sd.summary);
    } catch (err) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return (
      <div className="w-full max-w-6xl px-4 sm:px-8 py-8">
        <Helmet><title>study-assistant - 我的学习画像</title></Helmet>
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground text-sm">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
          <span>加载画像数据...</span>
        </div>
      </div>
    );
  }

  if (!summary || !summary.hasData) {
    return (
      <div className="w-full max-w-6xl px-4 sm:px-8 py-8 space-y-6">
        <Helmet><title>study-assistant - 我的学习画像</title></Helmet>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4 mr-1" />返回</Button>
          <h2 className="text-xl font-bold">我的学习画像</h2>
        </div>
        <div className="text-center py-12 text-muted-foreground text-sm">
          还没有学习计划数据。请先创建学习计划并学习知识点，系统将自动生成你的学习画像。
        </div>
      </div>
    );
  }

  const hasFull = profile && summary.hasAIAnalysis;

  return (
    <div className="w-full max-w-6xl px-4 sm:px-8 py-8 pb-10 flex flex-col gap-8">
      <Helmet><title>study-assistant - 我的学习画像</title></Helmet>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4 mr-1" />返回</Button>
          <h2 className="text-xl font-bold">我的学习画像</h2>
        </div>
        <div className="flex items-center gap-2">
          {summary.lastAnalyzedAt && (
            <span className="text-xs text-muted-foreground">最近分析: {formatDate(summary.lastAnalyzedAt)}</span>
          )}
          <Button size="sm" onClick={handleAnalyze} disabled={analyzing}>
            {analyzing ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            {analyzing ? '分析中...' : hasFull ? '重新分析' : '生成画像'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-2.5">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {analyzing && (
        <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground text-sm">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
          <span>AI 正在跨计划分析你的学习数据...</span>
        </div>
      )}

      <Card className="shadow-sm border-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />跨计划概览
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            <StatCard value={summary.stats.totalPlans} label="学习计划" icon={BookOpen} />
            <StatCard value={summary.stats.totalTopics} label="知识点" icon={Target} />
            <StatCard value={summary.stats.overallCompletionRate + '%'} label="完成率" icon={TrendingUp} />
            <StatCard value={formatDuration(summary.stats.totalTimeSeconds)} label="学习时长" icon={Clock} />
            <StatCard value={summary.stats.totalQuestions} label="提问数" icon={FileQuestion} />
            <StatCard
              value={summary.exerciseStats.total > 0 ? summary.exerciseStats.rate + '%' : '-'}
              label="练习正确率"
              icon={TrendingUp}
            />
          </div>

          {summary.planSummaries.length > 0 && (
            <div className="space-y-4">
              <div className="text-xs text-muted-foreground font-medium">各计划完成情况</div>
              {summary.planSummaries.map(p => (
                <div key={p.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm truncate">{p.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{p.doneCount}/{p.topicCount}</span>
                  </div>
                  <Progress value={p.completionRate} className="h-2" />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {summary.todayStats && (
        <Card className="shadow-sm border-0">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />今日答题情况
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
              <StatCard value={summary.todayStats.total} label="答题数" icon={FileQuestion} />
              <StatCard value={summary.todayStats.correct} label="正确数" icon={CheckCircle2} />
              <StatCard value={summary.todayStats.total > 0 ? summary.todayStats.rate + '%' : '-'} label="正确率" icon={TrendingUp} />
            </div>
            {summary.todayStats.total > 0 && (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="p-2.5 rounded-lg bg-muted/40">
                  <div className="text-lg font-semibold">{summary.todayStats.exercises.total}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    练习 ({summary.todayStats.exercises.total > 0 ? Math.round((summary.todayStats.exercises.correct / summary.todayStats.exercises.total) * 100) + '%' : '-'})
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40">
                  <div className="text-lg font-semibold">{summary.todayStats.exams.total}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    试卷 ({summary.todayStats.exams.total > 0 ? Math.round((summary.todayStats.exams.correct / summary.todayStats.exams.total) * 100) + '%' : '-'})
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40">
                  <div className="text-lg font-semibold">{summary.todayStats.quizzes.total}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    快问 ({summary.todayStats.quizzes.total > 0 ? Math.round((summary.todayStats.quizzes.correct / summary.todayStats.quizzes.total) * 100) + '%' : '-'})
                  </div>
                </div>
              </div>
            )}
            {summary.weekStats && summary.weekStats.total > 0 && (
              <div className="text-xs text-muted-foreground pt-1 border-t">
                本周累计答题 <span className="font-medium text-foreground">{summary.weekStats.total}</span> 题，正确率 <span className="font-medium text-foreground">{summary.weekStats.rate}%</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {summary.timeDistribution && summary.timeDistribution.last7Days && (
        <Card className="shadow-sm border-0">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />学习时长分布
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
              <div className="p-3 rounded-lg bg-muted/50">
                <div className="text-2xl font-semibold">{formatDuration(summary.timeDistribution.summary.timeLast7Days)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">近 7 天</div>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <div className="text-2xl font-semibold">{formatDuration(summary.timeDistribution.summary.timeLast30Days)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">近 30 天</div>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <div className="text-2xl font-semibold">{summary.timeDistribution.summary.activeDays}</div>
                <div className="text-[10px] text-muted-foreground mt-1">活跃天数</div>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <div className="text-2xl font-semibold">{formatDuration(summary.timeDistribution.summary.avgPerDaySeconds)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">日均学习</div>
              </div>
            </div>

            <div className="pt-4">
              <div className="text-xs text-muted-foreground mb-3 font-medium">近 7 天每日学习时长</div>
              <div className="h-[220px]">
                {(() => {
                  const dataMax = Math.max(...summary.timeDistribution.last7Days.map(d => Math.round(d.seconds / 60)), 0);
                  const step = dataMax <= 30 ? 5 : dataMax <= 120 ? 20 : 60;
                  const maxVal = Math.ceil(dataMax / step) * step;
                  const chartData = summary.timeDistribution.last7Days.map(d => ({
                    date: d.date,
                    label: new Date(d.date + 'T00:00:00').toLocaleDateString('zh-CN', { weekday: 'short' }),
                    mins: Math.round(d.seconds / 60),
                    seconds: d.seconds,
                  }));
                  return (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 10, left: 20 }}>
                        <XAxis
                          dataKey="label"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fontSize: 11, fill: 'oklch(0.556 0 0)' }}
                        />
                        <YAxis
                          axisLine={false}
                          tickLine={false}
                          tick={{ fontSize: 10, fill: 'oklch(0.556 0 0)' }}
                          tickFormatter={formatMinutes}
                          domain={[0, maxVal]}
                          tickCount={maxVal / step + 1}
                        />
                        <Tooltip
                          formatter={(v) => [formatMinutes(v), '学习时长']}
                          labelFormatter={(l) => l}
                          contentStyle={{ fontSize: 12, borderRadius: 8 }}
                        />
                        <Bar dataKey="mins" radius={[4, 4, 0, 0]} barSize={32}>
                          {chartData.map((d, i) => (
                            <Cell
                              key={i}
                              fill={d.seconds > 0 ? 'oklch(0.546 0.245 262.88 / 0.8)' : 'oklch(0.546 0.245 262.88 / 0.12)'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  );
                })()}
              </div>
            </div>

            {summary.timeDistribution.summary.peakDay && (
              <div className="text-xs text-muted-foreground">
                学习高峰：<span className="font-medium text-foreground">{summary.timeDistribution.summary.peakDay.date}</span>，共 {formatDuration(summary.timeDistribution.summary.peakDay.seconds)}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {hasFull && profile.learnerPersona && (
        <Card className="shadow-sm border-0">
          <CardContent className="pt-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">学习者画像</h3>
              {Number.isFinite(profile.learnerPersona.confidence) && (
                <span className="text-xs text-muted-foreground">
                  画像可信度 {Math.round(Math.max(0, Math.min(1, profile.learnerPersona.confidence)) * 100)}%
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(profile.learnerPersona.type || []).map(t => (
                <span key={t} className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary font-medium">{t}</span>
              ))}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">{profile.learnerPersona.summary}</p>
            {Number.isFinite(profile.learnerPersona.confidence) && (
              <Progress value={Math.max(0, Math.min(1, profile.learnerPersona.confidence)) * 100} className="h-1.5" />
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-y-4 border-y py-4">
              <div className="md:border-r md:pr-4">
                <div className="text-lg font-semibold">{summary.stats.totalQuestions || 0}</div>
                <div className="text-[11px] text-muted-foreground">提问样本</div>
              </div>
              <div className="md:border-r md:px-4">
                <div className="text-lg font-semibold">{summary.timeDistribution?.summary?.activeDays || 0}</div>
                <div className="text-[11px] text-muted-foreground">学习活跃日</div>
              </div>
              <div className="md:border-r md:px-4">
                <div className="text-lg font-semibold">{(summary.exerciseStats?.total || 0) + (summary.examStats?.total || 0) + (summary.quickQuizStats?.total || 0)}</div>
                <div className="text-[11px] text-muted-foreground">答题样本</div>
              </div>
              <div className="md:pl-4">
                <div className="text-lg font-semibold">{summary.stats.totalPlans || 0}</div>
                <div className="text-[11px] text-muted-foreground">覆盖计划</div>
              </div>
            </div>
            {profile.learnerPersona.evidenceFromBehavior && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground leading-relaxed">
                <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{profile.learnerPersona.evidenceFromBehavior}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {hasFull && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="shadow-sm border-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-green-600">强项</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {profile.strengths && profile.strengths.length > 0 ? (
                profile.strengths.map((s, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-sm text-muted-foreground truncate">{s.domain}</span>
                      <Progress value={(s.masteryLevel || 0) * 100} className="flex-1 h-1.5" />
                      <span className="w-8 text-right text-xs text-muted-foreground">{Math.round((s.masteryLevel || 0) * 100)}%</span>
                    </div>
                    <div className="text-xs text-muted-foreground pl-[88px] leading-relaxed">{s.topics?.join('、')}</div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">暂无数据</p>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm border-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-orange-600">待加强</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {profile.weaknesses && profile.weaknesses.length > 0 ? (
                profile.weaknesses.map((w, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-sm text-muted-foreground truncate">{w.domain}</span>
                      <Progress value={(w.masteryLevel || 0) * 100} className="flex-1 h-1.5" />
                      <span className="w-8 text-right text-xs text-muted-foreground">{Math.round((w.masteryLevel || 0) * 100)}%</span>
                    </div>
                    <div className="text-xs text-muted-foreground pl-[88px] leading-relaxed">{w.topics?.join('、')}</div>
                    {w.suggestedAction && (
                      <div className="text-xs text-primary pl-[88px] leading-relaxed">{w.suggestedAction}</div>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">暂无数据</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {summary.weakPointsSummary && summary.weakPointsSummary.length > 0 && (
        <Card className="shadow-sm border-0">
          <CardContent className="pt-6 space-y-3">
            <h3 className="text-sm font-semibold">跨计划薄弱知识点</h3>
            <div className="flex flex-wrap gap-1.5">
              {summary.weakPointsSummary.map((wp, i) => (
                <span key={i} className="inline-flex items-center gap-0.5 text-xs px-2.5 py-1 rounded-full bg-destructive/10 text-destructive font-medium">
                  {wp.name}
                  {wp.count > 1 && <span className="opacity-60">×{wp.count}</span>}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {hasFull && profile.learningPatterns && (
        <Card className="shadow-sm border-0">
          <CardContent className="pt-6">
            <h3 className="text-sm font-semibold mb-3">学习模式</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">提问风格</div>
                <div className="text-sm font-medium">{readableQuestionStyle(profile.learningPatterns.questionStyle)}</div>
                <div className="text-[11px] text-muted-foreground">
                  已分析 {profile.learningPatterns.questionStyleEvidence?.sampleSize ?? summary.stats.totalQuestions ?? 0} 个问题
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">平均提问/知识点</div>
                <div className="text-sm font-medium">{profile.learningPatterns.avgQuestionsPerTopic || 0}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">学习节奏</div>
                <div className="text-sm font-medium">
                  {summary.timeDistribution?.summary?.activeDays > 0
                    ? `${summary.timeDistribution.summary.activeDays} 个活跃日 · 日均 ${formatDuration(summary.timeDistribution.summary.avgPerDaySeconds)}`
                    : '学习记录不足'}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">互动模式偏好</div>
                <div className="text-sm font-medium">
                  分段{summary.modeCounts?.stepwise || 0} · 挑战{summary.modeCounts?.challenge || 0} · 脚手架{summary.modeCounts?.scaffold || 0} · 费曼{summary.feynmanStats?.sessionCount || 0}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {summary.feynmanStats?.sessionCount > 0 && (
        <Card className="shadow-sm border-0">
          <CardContent className="pt-6">
            <h3 className="text-sm font-semibold mb-3">费曼教学法统计</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">使用次数</div>
                <div className="text-sm font-medium">{summary.feynmanStats.sessionCount} 次</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">教学质量分布</div>
                <div className="text-sm font-medium">
                  {(() => {
                    const q = summary.feynmanStats.teachingQualities || [];
                    const counts = { excellent: 0, good: 0, fair: 0, needsWork: 0 };
                    q.forEach(x => { if (counts[x] !== undefined) counts[x]++; });
                    return `优秀 ${counts.excellent} · 良好 ${counts.good} · 一般 ${counts.fair} · 待改进 ${counts.needsWork}`;
                  })()}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">精彩讲解摘录</div>
                <div className="text-sm font-medium">{summary.feynmanStats.sparklingCount} 条</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">学生遗留问题</div>
                <div className="text-sm font-medium">{summary.feynmanStats.lingeringCount} 个</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {hasFull && profile.recommendations && profile.recommendations.length > 0 && (
        <div className="bg-muted/60 p-4 rounded-lg space-y-2">
          <h3 className="text-sm font-semibold text-primary">个性化建议</h3>
          <ol className="list-decimal pl-4 space-y-1 text-sm text-muted-foreground">
            {profile.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
        </div>
      )}

      {hasFull && profile.aiAnalysis && (
        <Card className="shadow-sm border-0">
          <CardContent className="pt-6">
            <div
              className="flex items-center justify-between cursor-pointer select-none"
              onClick={() => setShowReport(!showReport)}
            >
              <h3 className="text-sm font-semibold">完整分析报告</h3>
              <span className="text-xs text-muted-foreground">
                {showReport ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </span>
            </div>
            {showReport && (
              <div className="text-sm text-muted-foreground border-t mt-3 pt-3 leading-relaxed">
                {renderMarkdown(profile.aiAnalysis)}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
