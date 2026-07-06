import { useState, useRef } from 'react';
import { detectEncoding } from '../utils/encoding';
import api from '../api';

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
    } finally {
      setImporting(false);
    }
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

  // ─── Recycle Bin ───

  const openTrash = async () => {
    setTrashOpen(true);
    setTrashLoading(true);
    try {
      const d = await api.listTrash();
      setTrashPlans(d.plans || []);
    } catch (err) {
      alert('加载回收站失败: ' + err.message);
    } finally {
      setTrashLoading(false);
    }
  };

  const handleRestore = async (id) => {
    try {
      await api.restorePlan(id);
      // Refresh both trash list and active plans
      const d = await api.listTrash();
      setTrashPlans(d.plans || []);
      // Trigger parent to refresh plans
      const plansRes = await api.listPlans();
      // Update plans via the parent's state — pass through a callback
      window.dispatchEvent(new CustomEvent('plan-restored'));
      alert('计划已恢复');
    } catch (err) {
      alert('恢复失败: ' + err.message);
    }
  };

  const handlePermanentDelete = async (id, name) => {
    if (!confirm(`确定要永久删除计划「${name}」吗？此操作不可撤销。`)) return;
    try {
      await api.permanentlyDeleteTrash(id);
      setTrashPlans(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
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
    <div className="plan-list">
      <div className="plan-list-header">
        <h2>我的学习计划</h2>
        <button className="btn-trash" onClick={openTrash} title="回收站">
          🗑️ {trashPlans.length > 0 && <span className="trash-badge">{trashPlans.length}</span>}
        </button>
      </div>

      {plans.length > 0 && (
        <div className="plan-search">
          <input
            type="text"
            className="search-input"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="🔍 搜索计划..."
          />
          {searchQuery.trim() && (
            <span className="search-count">{filteredPlans.length} / {plans.length}</span>
          )}
        </div>
      )}

      <div className="plan-create-tabs">
        <button
          className={`tab-btn ${mode === 'manual' ? 'active' : ''}`}
          onClick={() => setMode('manual')}
        >手动创建</button>
        <button
          className={`tab-btn ${mode === 'import' ? 'active' : ''}`}
          onClick={() => setMode('import')}
        >🤖 AI 导入</button>
      </div>

      {mode === 'manual' ? (
        <form className="plan-create-form" onSubmit={handleSubmit}>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="输入学习计划名称..."
            autoFocus
          />
          <button type="submit" disabled={!newName.trim()}>创建</button>
        </form>
      ) : (
        <div className="plan-import-section">
          <textarea
            value={importText}
            onChange={e => setImportText(e.target.value)}
            placeholder={`粘贴整份文档内容，AI 会自动分析结构并生成学习计划。

支持文章、教程、笔记、大纲等。例如：

Python 基础教程
第一章：数据类型
- 整数和浮点数
- 字符串操作
- 布尔类型

第二章：控制流
- if/else 条件判断
- for 循环`}
            rows={8}
          />
          <div className="plan-import-actions">
            <button
              className="btn btn-primary"
              onClick={handleImport}
              disabled={!importText.trim() || importing}
            >
              {importing ? '⏳ AI 解析中...' : '🤖 AI 解析并创建'}
            </button>
            <button className="btn btn-sm" onClick={() => fileInputRef.current?.click()}>
              📂 选择文件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md"
              onChange={handleFile}
              style={{ display: 'none' }}
            />
          </div>
        </div>
      )}

      <div className="plan-cards">
        {plans.length === 0 && !searchQuery.trim() && (
          <div className="plan-empty">
            <p>还没有学习计划</p>
            <p className="hint">粘贴或导入文件，AI 自动识别阶段和知识点</p>
          </div>
        )}
        {searchQuery.trim() && filteredPlans.length === 0 && (
          <div className="plan-empty">
            <p>没有找到匹配的计划</p>
          </div>
        )}
        {filteredPlans.map(plan => (
          <div key={plan.id} className="plan-card" onClick={() => onSelect(plan.id)}>
            <div className="plan-card-body">
              <strong>{plan.name}</strong>
              <span className="plan-meta">
                {(plan.topicCount || 0) + ' 个知识点'} · {plan.updatedAt ? new Date(plan.updatedAt).toLocaleDateString() : ''}
              </span>
            </div>
            <button
              className="btn-delete"
              onClick={e => { e.stopPropagation(); if (confirm('确定将计划「' + plan.name + '」移入回收站吗？可在30天内恢复。')) onDelete(plan.id); }}}
              title="删除"
            >✕</button>
          </div>
        ))}
      </div>

      {/* ─── Recycle Bin Modal ─── */}
      {trashOpen && (
        <div className="trash-overlay" onClick={() => setTrashOpen(false)}>
          <div className="trash-modal" onClick={e => e.stopPropagation()}>
            <div className="trash-header">
              <h3>🗑️ 回收站</h3>
              <span className="trash-hint">计划在 30 天后自动清除{trashPlans.some(p => p.hasData) ? '（有学习数据的计划会保留数据文件）' : ''}</span>
              <button className="btn-close" onClick={() => setTrashOpen(false)}>✕</button>
            </div>
            <div className="trash-body">
              {trashLoading ? (
                <div className="trash-loading">加载中...</div>
              ) : trashPlans.length === 0 ? (
                <div className="trash-empty">回收站是空的</div>
              ) : (
                trashPlans.map(tp => (
                  <div key={tp.id} className="trash-item">
                    <div className="trash-item-info">
                      <strong>{tp.name}</strong>
                      <span className="trash-meta">
                        {tp.topicCount || 0} 个知识点 · 删除于 {formatDeletedTime(tp.deletedAt)}
                      </span>
                      <span className="trash-expiry">{formatExpiry(tp.expiresAt)}</span>
                    </div>
                    <div className="trash-item-actions">
                      <button className="btn btn-sm" onClick={() => handleRestore(tp.id)}>↩ 恢复</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handlePermanentDelete(tp.id, tp.name)}>永久删除</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
