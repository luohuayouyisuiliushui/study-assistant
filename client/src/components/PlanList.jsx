import { useState, useRef, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { detectEncoding } from '../utils/encoding';
import api from '../api';
import { Button } from '#/components/ui/button';
import { Card, CardContent, CardHeader } from '#/components/ui/card';
import { Badge } from '#/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '#/components/ui/dialog';
import { Trash2, Search, Plus, Upload, FileText, RotateCcw, AlertTriangle } from 'lucide-react';

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
    <div className="w-full max-w-5xl px-8 py-8 space-y-6">
      <Helmet><title>study-assistant - 学习计划</title></Helmet>
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={openTrash} className="relative">
          <Trash2 className="h-4 w-4 mr-1" />
          回收站
          {trashPlans.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-destructive rounded-full">{trashPlans.length}</span>
          )}
        </Button>
      </div>

      {plans.length > 0 && (
        <div className="relative mb-8">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full h-9 pl-9 pr-4 rounded-md border border-input bg-background text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {searchQuery.trim() && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{filteredPlans.length}/{plans.length}</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '4px', borderRadius: '8px', padding: '4px', marginTop: '24px', marginBottom: '24px', background: 'var(--muted)' }}>
        <button onClick={() => setMode('manual')} className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${mode === 'manual' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>手动创建</button>
        <button onClick={() => setMode('import')} className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${mode === 'import' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>AI 导入</button>
      </div>

      <div className="flex flex-col gap-6">
        {mode === 'manual' ? (
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="输入学习计划名称..."
              autoFocus
              className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button type="submit" disabled={!newName.trim()}><Plus className="h-4 w-4 mr-1" />创建</Button>
          </form>
        ) : (
        <div className="space-y-6">
            <textarea
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder={`粘贴整份文档内容，AI 会自动分析结构并生成学习计划。\n\n支持文章、教程、笔记、大纲等。例如：\n\nPython 基础教程\n第一章：数据类型\n- 整数和浮点数\n- 字符串操作\n- 布尔类型\n\n第二章：控制流\n- if/else 条件判断\n- for 循环`}
              rows={8}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex gap-2">
              <Button onClick={handleImport} disabled={!importText.trim() || importing}>
                {importing ? <RotateCcw className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
                {importing ? 'AI 解析中...' : 'AI 解析并创建'}
              </Button>
              <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                <FileText className="h-4 w-4 mr-1" />选择文件
              </Button>
              <input ref={fileInputRef} type="file" accept=".txt,.md" onChange={handleFile} style={{ display: 'none' }} />
            </div>
          </div>
        )}

        {plans.length === 0 && !searchQuery.trim() && (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-base">还没有学习计划</p>
            <p className="text-sm mt-2">粘贴或导入文件，AI 自动识别阶段和知识点</p>
          </div>
        )}
        {searchQuery.trim() && filteredPlans.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <p>没有找到匹配的计划</p>
          </div>
        )}
        {filteredPlans.map(plan => (
          <Card key={plan.id} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => onSelect(plan.id)}>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: '24px' }}>
              <span className="font-medium text-base">{plan.name}</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={e => { e.stopPropagation(); if (confirm('确定将计划「' + plan.name + '」移入回收站吗？可在30天内恢复。')) onDelete(plan.id); }}
              >
                <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
              </Button>
            </div>
            <div style={{ paddingLeft: '24px', paddingRight: '24px', paddingBottom: '24px' }}>
              <span className="text-sm text-muted-foreground">
                {(plan.topicCount || 0) + ' 个知识点'} · {plan.updatedAt ? new Date(plan.updatedAt).toLocaleDateString() : ''}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {trashOpen && (
        <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5" />回收站</DialogTitle>
              <p className="text-xs text-muted-foreground">计划在 30 天后自动清除{trashPlans.some(p => p.hasData) ? '（有学习数据的计划会保留数据文件）' : ''}</p>
            </DialogHeader>
            <DialogClose onClick={() => setTrashOpen(false)} />
            <div className="flex justify-end -mt-2 mb-2">
              {trashPlans.length > 0 && (
                <Button variant="destructive" size="sm" onClick={handleEmptyTrash}><AlertTriangle className="h-3.5 w-3.5 mr-1" />一键清空</Button>
              )}
            </div>
            <div className="max-h-[50vh] overflow-auto space-y-2">
              {trashLoading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">加载中...</div>
              ) : trashPlans.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">回收站是空的</div>
              ) : (
                trashPlans.map(tp => (
                  <Card key={tp.id}>
                    <CardContent className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex flex-col gap-1 min-w-0">
                        <span className="font-medium text-sm truncate">{tp.name}</span>
                        <span className="text-xs text-muted-foreground">{tp.topicCount || 0} 个知识点 · 删除于 {formatDeletedTime(tp.deletedAt)}</span>
                        <Badge variant="outline" className="w-fit text-[10px] px-1.5 py-0">{formatExpiry(tp.expiresAt)}</Badge>
                      </div>
                      <div className="flex gap-1 shrink-0">
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
