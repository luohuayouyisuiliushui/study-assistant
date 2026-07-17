import { useState, useRef, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { detectEncoding } from '../utils/encoding';
import api from '../api';
import { Button } from '#/components/ui/button';
import { Card, CardContent } from '#/components/ui/card';
import { Badge } from '#/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '#/components/ui/dialog';
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Clock3,
  FileText,
  Layers3,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';

const getTopicCount = (plan) => plan.topicCount ?? plan.topics?.length ?? 0;

function formatPlanDate(timestamp) {
  if (!timestamp) return '刚刚更新';
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
  } catch {
    return '最近更新';
  }
}

export default function PlanList({ plans, onCreate, onImport, onSelect, onDelete }) {
  const [mode, setMode] = useState('manual');
  const [newName, setNewName] = useState('');
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashPlans, setTrashPlans] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    api.listTrash().then(d => setTrashPlans(d.plans || [])).catch(() => {});
  }, []);

  const filteredPlans = searchQuery.trim()
    ? plans.filter(p => p.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : plans;
  const totalTopics = plans.reduce((sum, plan) => sum + getTopicCount(plan), 0);
  const latestPlan = plans.reduce((latest, plan) => {
    if (!latest) return plan;
    return (plan.updatedAt || plan.createdAt || 0) > (latest.updatedAt || latest.createdAt || 0) ? plan : latest;
  }, null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreate(newName.trim());
    setNewName('');
  };

  const doImport = async (text) => {
    if (!text.trim() || importing) return;
    setImporting(true);
    try {
      await onImport(text.trim());
      setImportText('');
    } catch (err) {
      alert('导入失败: ' + err.message);
    } finally { setImporting(false); }
  };

  const handleImport = () => doImport(importText);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target?.result;
      if (!buffer) return;
      const text = detectEncoding(buffer);
      setImportText(text);
      doImport(text);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const openTrash = async () => {
    setTrashOpen(true);
    setTrashLoading(true);
    try {
      const d = await api.listTrash();
      setTrashPlans(d.plans || []);
    } catch (err) {
      alert('加载回收站失败: ' + err.message);
    } finally { setTrashLoading(false); }
  };

  const handleRestore = async (id) => {
    try {
      await api.restorePlan(id);
      const d = await api.listTrash();
      setTrashPlans(d.plans || []);
      window.dispatchEvent(new CustomEvent('plan-restored'));
      alert('计划已恢复');
    } catch (err) { alert('恢复失败: ' + err.message); }
  };

  const handlePermanentDelete = async (id, name) => {
    if (!confirm(`确定要永久删除计划「${name}」吗？此操作不可撤销。`)) return;
    try {
      await api.permanentlyDeleteTrash(id);
      setTrashPlans(prev => prev.filter(p => p.id !== id));
    } catch (err) { alert('删除失败: ' + err.message); }
  };

  const handleEmptyTrash = async () => {
    if (trashPlans.length === 0) return;
    if (!confirm(`确定要一键清空回收站吗？（共 ${trashPlans.length} 个计划，此操作不可撤销）`)) return;
    try {
      await api.emptyTrash();
      setTrashPlans([]);
      alert('回收站已清空');
    } catch (err) { alert('清空失败: ' + err.message); }
  };

  const formatExpiry = (expiresAt) => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return '即将到期';
    const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
    return `${days} 天后自动清除`;
  };

  const formatDeletedTime = (ts) => {
    try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
  };

  return (
    <div className="home-shell">
      <Helmet><title>study-assistant - 学习计划</title></Helmet>

      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__copy">
          <div className="ui-eyebrow"><Sparkles className="h-3.5 w-3.5" />AI 学习工作台</div>
          <h2 id="home-title">把复杂知识，整理成一条清晰的学习路径</h2>
          <p>从资料导入、知识拆解到讲解与复习，在同一个空间持续推进你的学习计划。</p>
          <div className="home-hero__chips" aria-label="核心能力">
            <span><Layers3 className="h-3.5 w-3.5" />结构化拆解</span>
            <span><Sparkles className="h-3.5 w-3.5" />AI 自适应讲解</span>
            <span><Clock3 className="h-3.5 w-3.5" />学习进度沉淀</span>
          </div>
        </div>
        <div className="home-hero__stats" aria-label="学习计划概览">
          <div>
            <span className="home-hero__stat-icon"><BookOpen className="h-4 w-4" /></span>
            <strong>{plans.length}</strong>
            <small>学习计划</small>
          </div>
          <div>
            <span className="home-hero__stat-icon"><Layers3 className="h-4 w-4" /></span>
            <strong>{totalTopics}</strong>
            <small>知识点</small>
          </div>
          <div className="home-hero__latest">
            <span className="home-hero__stat-icon"><Clock3 className="h-4 w-4" /></span>
            <strong title={latestPlan?.name || ''}>{latestPlan?.name || '准备开始'}</strong>
            <small>{latestPlan ? '最近更新' : '创建第一份计划'}</small>
          </div>
        </div>
      </section>

      <section className="creation-panel" aria-labelledby="create-plan-title">
        <div className="creation-panel__heading">
          <div>
            <span className="ui-kicker">快速开始</span>
            <h3 id="create-plan-title">创建新的学习计划</h3>
            <p>从一个主题开始，或让 AI 直接把整份资料整理成路径。</p>
          </div>
          <div className="creation-tabs" role="tablist" aria-label="创建方式">
            <button type="button" role="tab" aria-selected={mode === 'manual'} onClick={() => setMode('manual')} className={mode === 'manual' ? 'is-active' : ''}>
              <Plus className="h-4 w-4" />手动创建
            </button>
            <button type="button" role="tab" aria-selected={mode === 'import'} onClick={() => setMode('import')} className={mode === 'import' ? 'is-active' : ''}>
              <Sparkles className="h-4 w-4" />AI 导入
            </button>
          </div>
        </div>

        <div className="creation-panel__body">
          {mode === 'manual' ? (
            <form onSubmit={handleSubmit} className="manual-create-form">
              <div className="manual-create-form__field">
                <BookOpen className="h-5 w-5" />
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="例如：操作系统、线性代数、产品设计方法"
                  autoFocus
                  aria-label="学习计划名称"
                />
              </div>
              <Button type="submit" size="lg" disabled={!newName.trim()}><Plus className="h-4 w-4 mr-1.5" />创建计划</Button>
            </form>
          ) : (
            <div className="import-create-form">
              <textarea
                value={importText}
                onChange={e => setImportText(e.target.value)}
                placeholder={`粘贴文章、教程、笔记或课程大纲。\n\nAI 会识别章节结构、提取知识点并生成学习路径。`}
                rows={7}
                aria-label="待导入的资料内容"
              />
              <div className="import-create-form__actions">
                <Button onClick={handleImport} disabled={!importText.trim() || importing}>
                  {importing ? <RotateCcw className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
                  {importing ? 'AI 正在整理...' : 'AI 解析并创建'}
                </Button>
                <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-1.5" />选择 TXT / Markdown
                </Button>
                <input ref={fileInputRef} type="file" accept=".txt,.md" onChange={handleFile} hidden />
                <span className="import-create-form__hint"><FileText className="h-3.5 w-3.5" />文件仅在本地读取后发送给当前服务</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="plans-section" aria-labelledby="plan-library-title">
        <div className="plans-toolbar">
          <div>
            <span className="ui-kicker">学习空间</span>
            <h3 id="plan-library-title">我的计划</h3>
            <p>{plans.length > 0 ? `共 ${plans.length} 份计划，继续上次的学习节奏。` : '创建第一份计划，开始积累你的知识地图。'}</p>
          </div>
          <div className="plans-toolbar__actions">
            {plans.length > 0 && (
              <label className="plan-search">
                <Search className="h-4 w-4" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索计划"
                  aria-label="搜索学习计划"
                />
                {searchQuery.trim() && <span>{filteredPlans.length}/{plans.length}</span>}
              </label>
            )}
            <Button variant="outline" onClick={openTrash} className="trash-button">
              <Trash2 className="h-4 w-4 mr-1.5" />回收站
              {trashPlans.length > 0 && <span className="trash-button__count">{trashPlans.length}</span>}
            </Button>
          </div>
        </div>

        {plans.length === 0 && !searchQuery.trim() && (
          <div className="plans-empty-state">
            <span><BookOpen className="h-7 w-7" /></span>
            <h4>还没有学习计划</h4>
            <p>在上方输入一个主题，或粘贴资料让 AI 帮你完成第一次拆解。</p>
          </div>
        )}
        {searchQuery.trim() && filteredPlans.length === 0 && (
          <div className="plans-empty-state">
            <span><Search className="h-7 w-7" /></span>
            <h4>没有找到匹配的计划</h4>
            <p>换一个关键词试试，或者清空搜索查看全部内容。</p>
          </div>
        )}

        {filteredPlans.length > 0 && (
          <div className="plan-grid">
            {filteredPlans.map((plan, index) => {
              const topicCount = getTopicCount(plan);
              return (
                <Card key={plan.id} className="plan-card">
                  <button
                    type="button"
                    className="plan-card__open-button"
                    aria-label={`打开学习计划 ${plan.name}`}
                    onClick={() => onSelect(plan.id)}
                  />
                  <CardContent className="plan-card__content">
                    <div className="plan-card__topline">
                      <span className="plan-card__icon"><BookOpen className="h-5 w-5" /></span>
                      <div className="plan-card__badges">
                        {index < 2 && <Badge variant="secondary">最近更新</Badge>}
                        <button
                          type="button"
                          className="plan-card__delete"
                          aria-label={`将计划 ${plan.name} 移入回收站`}
                          title="移入回收站"
                          onClick={e => {
                            e.stopPropagation();
                            if (confirm('确定将计划「' + plan.name + '」移入回收站吗？可在30天内恢复。')) onDelete(plan.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className="plan-card__title">
                      <h4>{plan.name}</h4>
                      <p>{topicCount > 0 ? '继续构建这份知识地图' : '等待添加第一个知识点'}</p>
                    </div>
                    <div className="plan-card__footer">
                      <div>
                        <span><Layers3 className="h-3.5 w-3.5" />{topicCount} 个知识点</span>
                        <span><Clock3 className="h-3.5 w-3.5" />{formatPlanDate(plan.updatedAt || plan.createdAt)}</span>
                      </div>
                      <span className="plan-card__open"><ArrowUpRight className="h-4 w-4" /></span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {trashOpen && (
        <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><span className="dialog-icon"><Trash2 className="h-5 w-5" /></span>回收站</DialogTitle>
              <p className="text-sm text-muted-foreground">计划在 30 天后自动清除{trashPlans.some(p => p.hasData) ? '（有学习数据的计划会保留数据文件）' : ''}</p>
            </DialogHeader>
            <DialogClose onClick={() => setTrashOpen(false)} />
            <div className="flex justify-end -mt-2 mb-3">
              {trashPlans.length > 0 && (
                <Button variant="destructive" size="sm" onClick={handleEmptyTrash}><AlertTriangle className="h-3.5 w-3.5 mr-1" />一键清空</Button>
              )}
            </div>
            <div className="max-h-[52vh] overflow-auto space-y-2 pr-1">
              {trashLoading ? (
                <div className="text-center py-10 text-muted-foreground text-sm">加载中...</div>
              ) : trashPlans.length === 0 ? (
                <div className="plans-empty-state compact">
                  <span><Trash2 className="h-6 w-6" /></span>
                  <h4>回收站是空的</h4>
                </div>
              ) : (
                trashPlans.map(tp => (
                  <Card key={tp.id} className="trash-plan-card">
                    <CardContent className="px-4 py-3.5 flex items-center justify-between gap-3">
                      <div className="flex flex-col gap-1 min-w-0">
                        <span className="font-semibold text-sm truncate">{tp.name}</span>
                        <span className="text-xs text-muted-foreground">{tp.topicCount || 0} 个知识点 · 删除于 {formatDeletedTime(tp.deletedAt)}</span>
                        <Badge variant="outline" className="w-fit text-[10px] px-1.5 py-0">{formatExpiry(tp.expiresAt)}</Badge>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <Button size="sm" variant="outline" onClick={() => handleRestore(tp.id)}><RotateCcw className="h-3.5 w-3.5 mr-1" />恢复</Button>
                        <Button size="sm" variant="destructive" onClick={() => handlePermanentDelete(tp.id, tp.name)}>删除</Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}