import { useState, useRef } from 'react';
import { detectEncoding } from '../utils/encoding';

export default function PlanList({ plans, onCreate, onImport, onSelect, onDelete }) {
  const [mode, setMode] = useState('manual');
  const [newName, setNewName] = useState('');
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

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

  return (
    <div className="plan-list">
      <div className="plan-list-header">
        <h2>我的学习计划</h2>
      </div>

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
        {plans.length === 0 && (
          <div className="plan-empty">
            <p>还没有学习计划</p>
            <p className="hint">粘贴或导入文件，AI 自动识别阶段和知识点</p>
          </div>
        )}
        {plans.map(plan => (
          <div key={plan.id} className="plan-card" onClick={() => onSelect(plan.id)}>
            <div className="plan-card-body">
              <strong>{plan.name}</strong>
              <span className="plan-meta">
                {(plan.topicCount || 0) + ' 个知识点'} · {plan.updatedAt ? new Date(plan.updatedAt).toLocaleDateString() : ''}
              </span>
            </div>
            <button
              className="btn-delete"
              onClick={e => { e.stopPropagation(); if (confirm('确定要删除计划「' + plan.name + '」吗？所有知识点和学习记录将永久丢失。')) onDelete(plan.id); }}
              title="删除"
            >✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
