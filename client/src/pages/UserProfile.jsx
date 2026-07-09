import { useState, useEffect, useCallback } from 'react';
import api from '../api';

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(seconds) {
  if (!seconds) return '0h';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function renderMarkdown(text) {
  if (!text) return null;
  return text.split('\n').map((line, i) => {
    if (line.startsWith('### ')) return <h3 key={i} style={{ marginTop: 12, marginBottom: 6 }}>{line.slice(4)}</h3>;
    if (line.startsWith('## ')) return <h2 key={i} style={{ marginTop: 16, marginBottom: 8 }}>{line.slice(3)}</h2>;
    if (line.startsWith('- ')) return <li key={i} style={{ marginLeft: 16, marginBottom: 2 }}>{line.slice(2)}</li>;
    if (line.trim() === '') return <br key={i} />;
    return <p key={i} style={{ marginBottom: 4 }}>{line}</p>;
  });
}

function MasteryBar({ level, label }) {
  const pct = Math.round((level || 0) * 100);
  const color = pct >= 70 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444';
  return (
    <div className="profile-bar-row">
      <span className="profile-bar-label">{label}</span>
      <div className="profile-bar-track">
        <div className="profile-bar-fill" style={{ width: pct + '%', background: color }} />
      </div>
      <span className="profile-bar-value">{pct}%</span>
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
      // Reload summary to reflect new state
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
      <div className="plan-list">
        <div className="analysis-loading">
          <div className="spinner-sm" />
          <span>加载画像数据...</span>
        </div>
      </div>
    );
  }

  // No data state
  if (!summary || !summary.hasData) {
    return (
      <div className="plan-list">
        <div className="profile-header">
          <button className="btn btn-sm" onClick={onBack}>← 返回</button>
          <h2>👤 我的学习画像</h2>
        </div>
        <div className="profile-empty">
          <p style={{ fontSize: 16, color: '#64748b', textAlign: 'center', padding: 40 }}>
            还没有学习计划数据。请先创建学习计划并学习知识点，系统将自动生成你的学习画像。
          </p>
        </div>
      </div>
    );
  }

  const hasFull = profile && summary.hasAIAnalysis;

  return (
    <div className="plan-list" style={{ maxWidth: 720 }}>
      {/* Header */}
      <div className="profile-header">
        <button className="btn btn-sm" onClick={onBack}>← 返回</button>
        <h2>👤 我的学习画像</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {summary.lastAnalyzedAt && (
            <span style={{ fontSize: 11, color: '#94a3b8', alignSelf: 'center' }}>
              最近分析: {formatDate(summary.lastAnalyzedAt)}
            </span>
          )}
          <button
            className="btn btn-sm btn-primary"
            onClick={handleAnalyze}
            disabled={analyzing}
          >
            {analyzing ? '⏳' : '🔄'} {hasFull ? '重新分析' : '生成画像'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          ❌ {error}
        </div>
      )}

      {analyzing && (
        <div className="analysis-loading" style={{ marginBottom: 16 }}>
          <div className="spinner-sm" />
          <span>AI 正在跨计划分析你的学习数据...</span>
        </div>
      )}

      {/* Cross-Plan Overview */}
      <div className="profile-card">
        <h3 className="profile-card-title">📊 跨计划概览</h3>
        <div className="profile-stats-grid">
          <div className="profile-stat">
            <div className="profile-stat-value">{summary.stats.totalPlans}</div>
            <div className="profile-stat-label">学习计划</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{summary.stats.totalTopics}</div>
            <div className="profile-stat-label">知识点</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{summary.stats.overallCompletionRate}%</div>
            <div className="profile-stat-label">完成率</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{formatDuration(summary.stats.totalLearningTime)}</div>
            <div className="profile-stat-label">学习时长</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{summary.stats.totalQuestions}</div>
            <div className="profile-stat-label">提问数</div>
          </div>
          <div className="profile-stat">
            <div className="profile-stat-value">{summary.exerciseStats.total > 0 ? summary.exerciseStats.rate + '%' : '-'}</div>
            <div className="profile-stat-label">练习正确率</div>
          </div>
        </div>

        {/* Plan breakdown */}
        {summary.planSummaries.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>各计划完成情况</div>
            {summary.planSummaries.map(p => (
              <div key={p.id} className="profile-plan-row">
                <span className="profile-plan-name">{p.name}</span>
                <div className="profile-bar-track" style={{ flex: 1 }}>
                  <div
                    className="profile-bar-fill"
                    style={{ width: p.completionRate + '%', background: p.completionRate >= 70 ? '#22c55e' : '#60a5fa' }}
                  />
                </div>
                <span className="profile-plan-stat">{p.doneCount}/{p.topicCount}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Learner Persona (AI generated) */}
      {hasFull && profile.learnerPersona && (
        <div className="profile-card">
          <h3 className="profile-card-title">🧑‍🎓 学习者画像</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {(profile.learnerPersona.type || []).map(t => (
              <span key={t} className="profile-badge">{t}</span>
            ))}
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: '#334155' }}>
            {profile.learnerPersona.summary}
          </p>
        </div>
      )}

      {/* Strengths & Weaknesses side by side */}
      {hasFull && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {/* Strengths */}
          <div className="profile-card" style={{ flex: 1, minWidth: 200 }}>
            <h3 className="profile-card-title" style={{ color: '#16a34a' }}>💪 强项</h3>
            {profile.strengths && profile.strengths.length > 0 ? (
              profile.strengths.map((s, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <MasteryBar level={s.masteryLevel} label={s.domain} />
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    {s.topics?.join('、')}
                  </div>
                </div>
              ))
            ) : (
              <p style={{ color: '#94a3b8', fontSize: 13 }}>暂无数据</p>
            )}
          </div>

          {/* Weaknesses */}
          <div className="profile-card" style={{ flex: 1, minWidth: 200 }}>
            <h3 className="profile-card-title" style={{ color: '#dc2626' }}>⚠️ 待加强</h3>
            {profile.weaknesses && profile.weaknesses.length > 0 ? (
              profile.weaknesses.map((w, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <MasteryBar level={w.masteryLevel} label={w.domain} />
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    {w.topics?.join('、')}
                  </div>
                  {w.suggestedAction && (
                    <div style={{ fontSize: 11, color: '#2563eb', marginTop: 1, fontStyle: 'italic' }}>
                      💡 {w.suggestedAction}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p style={{ color: '#94a3b8', fontSize: 13 }}>暂无数据</p>
            )}
          </div>
        </div>
      )}

      {/* Cross-plan weak points summary (computed, no AI needed) */}
      {summary.weakPointsSummary && summary.weakPointsSummary.length > 0 && (
        <div className="profile-card">
          <h3 className="profile-card-title">📋 跨计划薄弱知识点</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {summary.weakPointsSummary.map((wp, i) => (
              <span key={i} className="profile-tag">
                {wp.name}
                {wp.count > 1 && <span style={{ color: '#94a3b8', marginLeft: 4 }}>×{wp.count}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Learning Patterns */}
      {hasFull && profile.learningPatterns && (
        <div className="profile-card">
          <h3 className="profile-card-title">📈 学习模式</h3>
          <div className="profile-patterns-grid">
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">提问风格</span>
              <span className="profile-pattern-value">{profile.learningPatterns.questionStyle || '-'}</span>
            </div>
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">平均提问/知识点</span>
              <span className="profile-pattern-value">{profile.learningPatterns.avgQuestionsPerTopic || 0}</span>
            </div>
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">时间分布</span>
              <span className="profile-pattern-value">{profile.learningPatterns.timeDistribution || '-'}</span>
            </div>
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">互动模式偏好</span>
              <span className="profile-pattern-value">
                分段{summary.modeCounts?.stepwise || 0} · 
                挑战{summary.modeCounts?.challenge || 0} · 
                脚手架{summary.modeCounts?.scaffold || 0} · 
                费曼{summary.feynmanStats?.sessionCount || 0}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Feynman Stats */}
      {summary.feynmanStats?.sessionCount > 0 && (
        <div className="profile-card">
          <h3 className="profile-card-title">🧑\u200d\ud83c\udfeb 费曼教学法统计</h3>
          <div className="profile-pattern-grid">
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">使用次数</span>
              <span className="profile-pattern-value">{summary.feynmanStats.sessionCount} 次</span>
            </div>
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">教学质量分布</span>
              <span className="profile-pattern-value">
                {(() => {
                  const q = summary.feynmanStats.teachingQualities || [];
                  const ex = q.filter(x => x === 'excellent').length;
                  const gd = q.filter(x => x === 'good').length;
                  const fa = q.filter(x => x === 'fair').length;
                  const nw = q.filter(x => x === 'needsWork').length;
                  return ' Excellent ' + ex + ' \u2022 Good ' + gd + ' \u2022 Fair ' + fa + ' \u2022 NeedsWork ' + nw;
                })()}
              </span>
            </div>
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">精彩讲解摘录</span>
              <span className="profile-pattern-value">{summary.feynmanStats.sparklingCount} 条</span>
            </div>
            <div className="profile-pattern-item">
              <span className="profile-pattern-label">学生遗留问题</span>
              <span className="profile-pattern-value">{summary.feynmanStats.lingeringCount} 个</span>
            </div>
          </div>
        </div>
      )}

      {/* AI Recommendations */}
      {hasFull && profile.recommendations && profile.recommendations.length > 0 && (
        <div className="profile-card" style={{ borderLeft: '3px solid #2563eb' }}>
          <h3 className="profile-card-title">📌 个性化建议</h3>
          <ol style={{ paddingLeft: 20, margin: 0 }}>
            {profile.recommendations.map((r, i) => (
              <li key={i} style={{ marginBottom: 8, fontSize: 14, lineHeight: 1.6 }}>{r}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Full AI Analysis Report (expandable) */}
      {hasFull && profile.aiAnalysis && (
        <div className="profile-card">
          <div
            className="profile-collapse-header"
            onClick={() => setShowReport(!showReport)}
          >
            <h3 className="profile-card-title" style={{ margin: 0 }}>📄 完整分析报告</h3>
            <span style={{ color: '#64748b', fontSize: 12 }}>{showReport ? '收起 ▲' : '展开 ▼'}</span>
          </div>
          {showReport && (
            <div className="analysis-body" style={{ marginTop: 10, maxHeight: 500, overflowY: 'auto' }}>
              {renderMarkdown(profile.aiAnalysis)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
