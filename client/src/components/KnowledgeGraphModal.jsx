import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../api';

// Phase colors for Mermaid graph nodes
const PHASE_COLORS = ['#e0f2fe', '#dcfce7', '#fef3c7', '#fce7f3', '#e0e7ff', '#f3e8ff', '#ffedd5', '#d1fae5'];

export default function KnowledgeGraphModal({ plan, onClose, onSelectTopic, onGenerate }) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [graphSvg, setGraphSvg] = useState('');
  const graphContainerRef = useRef(null);

  useEffect(() => {
    if (!plan) return;
    loadGraph();
  }, [plan?.id]);

  const loadGraph = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.getKnowledgeGraph(plan.id);
      setGraphData(d.graph);
      // Build Mermaid graph definition
      const mermaidDef = buildMermaidGraph(plan, d.graph.nodes, d.graph.edges);
      // Render with Mermaid
      await renderMermaid(mermaidDef);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const buildMermaidGraph = (plan, nodes, edges) => {
    const phaseNames = {};
    for (const p of plan.phases || []) {
      phaseNames[p.id] = p.name;
    }

    const phaseIndex = {};
    for (const p of plan.phases || []) {
      phaseIndex[p.id] = plan.phases.indexOf(p) % PHASE_COLORS.length;
    }

    // Use graph LR for left-to-right layout
    let def = 'graph LR;\n';

    // Add nodes with styling based on level and done status
    for (const n of nodes) {
      const colorIdx = phaseIndex[n.phaseId] || 0;
      const fillColor = n.done ? '#bbf7d0' : PHASE_COLORS[colorIdx];
      const nodeId = 'n' + n.id.replace(/-/g, '_');
      const label = n.title
        .replace(/"/g, '\u0027')
        .replace(/[\[\]]/g, '')
        .substring(0, 25) + (n.title.length > 25 ? '...' : '');
      def += '    ' + nodeId + '["' + label + '"];\n';
      def += `    style ${nodeId} fill:${fillColor},stroke:#94a3b8,stroke-width:1px;\n`;
    }

    // Add edges
    for (const e of edges) {
      const fromId = 'n' + e.from.replace(/-/g, '_');
      const toId = 'n' + e.to.replace(/-/g, '_');
      if (e.type === 'parentOf') {
        def += `    ${fromId} -->|包含| ${toId};\n`;
      } else if (e.type === 'prerequisite') {
        def += `    ${fromId} -.->|前置| ${toId};\n`;
      } else if (e.type === 'related') {
        def += `    ${fromId} <-->|相关| ${toId};\n`;
      }
    }

    return def;
  };

  const renderMermaid = async (mermaidDef) => {
    try {
      const mermaid = await import('mermaid');
      mermaid.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });
      const id = 'kg-' + Math.random().toString(36).slice(2, 9);
      const { svg } = await mermaid.default.render(id, mermaidDef);
      setGraphSvg(svg);
    } catch (err) {
      setError('图谱渲染失败: ' + err.message);
      // Fallback: show raw mermaid text as a code block
      setGraphSvg('<pre style="background:#f8fafc;padding:16px;border-radius:6px;overflow:auto;font-size:12px;">' +
        mermaidDef.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>');
    }
  };

  return (
    <div className="kg-modal-overlay" onClick={onClose}>
      <div className="kg-modal" onClick={e => e.stopPropagation()}>
        <div className="kg-modal-header">
          <span>🕸️ 知识图谱 — {plan.name}</span>
          <div className="kg-modal-actions">
            <button className="btn-tiny" onClick={loadGraph} title="重新加载">🔄</button>
            <button className="btn-tiny" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="kg-modal-body" ref={graphContainerRef}>
          {loading ? (
            <div className="kg-loading">
              <div className="spinner" />
              <p>生成知识图谱...</p>
            </div>
          ) : error ? (
            <div className="kg-error">
              <p>❌ {error}</p>
              <button className="btn btn-sm" onClick={loadGraph}>重试</button>
            </div>
          ) : graphSvg ? (
            <div className="kg-svg-container" dangerouslySetInnerHTML={{ __html: graphSvg }} />
          ) : (
            <p className="kg-empty">暂无知识图谱数据</p>
          )}
        </div>
        <div className="kg-modal-footer">
          <span className="kg-legend">
            <span className="kg-legend-item">📘 一级(章)</span>
            <span className="kg-legend-item">📗 二级(节)</span>
            <span className="kg-legend-item">📙 三级(子节)</span>
            <span className="kg-legend-item" style={{ borderLeft: '2px solid #d1d5db', paddingLeft: '10px', marginLeft: '2px' }}>
              <span style={{ fontWeight: 600 }}>→</span> 包含
            </span>
            <span className="kg-legend-item">
              <span style={{ color: '#64748b', fontWeight: 600 }}>- - →</span> 前置依赖
            </span>
            <span className="kg-legend-item">
              <span style={{ fontWeight: 600 }}>↔</span> 相关
            </span>
            <span className="kg-legend-item" style={{ borderLeft: '2px solid #d1d5db', paddingLeft: '10px' }}>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#bbf7d0', borderRadius: 2, verticalAlign: 'middle', marginRight: 3 }}></span> 已学习
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
