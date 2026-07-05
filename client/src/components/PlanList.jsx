import { useState, useRef } from 'react';

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

      // 用两种编码解码，选中文更多的那个
      const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      let gbk = utf8;
      try { gbk = new TextDecoder('gbk').decode(buffer); } catch {}

      // 统计中文字符数
      const cjkCount = (s) => (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
      const utf8Cjk = cjkCount(utf8);
      const gbkCjk = cjkCount(gbk);

      const text = gbkCjk > utf8Cjk ? gbk : utf8;
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
            placeholder={`粘贴你的学习计划，或点击下方按钮导入文件。例如：

第一阶段：Python 基础
- 变量与数据类型
- 控制流
- 函数

第二阶段：Python 进阶
- 装饰器
- 生成器`}
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
