import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../api';

// Phase colors for Mermaid graph nodes
const PHASE_COLORS = ['#e0f2fe', '#dcfce7', '#fef3c7', '#fce7f3', '#e0e7ff', '#f3e8ff', '#ffedd5', '#d1fae5'];

// All supported relationship types with display labels and visual style
const RELATION_TYPES = {
  parentOf:               { label: '包含',          style: 'solid',    color: '#475569',  group: 'structure' },
  prerequisite:           { label: '前置依赖',       style: 'dashed',  color: '#dc2626',  group: 'dependency' },
  related:                { label: '相关',           style: 'dotted',  color: '#2563eb',  group: 'association' },
  // Inferred types from detail text
  extends:                { label: '扩展延伸',       style: 'dashed',  color: '#7c3aed',  group: 'association' },
  exampleOf:              { label: '示例',           style: 'dotted',  color: '#059669',  group: 'association' },
  contrasts:              { label: '对比',           style: 'dashed',  color: '#ea580c',  group: 'association' },
  buildsOn:               { label: '构建于',         style: 'dashed',  color: '#0891b2',  group: 'dependency' },
  references:             { label: '参考',           style: 'dotted',  color: '#78716c',  group: 'association' },
  // Inferred from transitive/inherited
  transitivePrerequisite: { label: '间接前置依赖',   style: 'dotted',  color: '#f87171',  group: 'dependency' },
  inheritedPrerequisite:  { label: '继承前置依赖',   style: 'dotted',  color: '#fb923c',  group: 'dependency' },
};

const FILTER_GROUPS = [
  { key: 'structure',   label: '结构关系',   types: ['parentOf'] },
  { key: 'dependency',  label: '依赖关系',   types: ['prerequisite', 'buildsOn', 'transitivePrerequisite', 'inheritedPrerequisite'] },
  { key: 'association', label: '关联关系',   types: ['related', 'extends', 'exampleOf', 'contrasts', 'references'] },
];

export default function KnowledgeGraphModal({ plan, onClose, onSelectTopic, onGenerate }) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [graphSvg, setGraphSvg] = useState('');
  const [inferEnabled, setInferEnabled] = useState(false);
  const [activeFilters, setActiveFilters] = useState(() => {
    const f = {};
    for (const key of Object.keys(RELATION_TYPES)) f[key] = true;
    return f;
  });
  const [highlightedNode, setHighlightedNode] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState(null);
  const graphContainerRef = useRef(null);
  const svgRef = useRef(null);
  const mountedRef = useRef(true);
  const planIdRef = useRef(plan?.id);
  planIdRef.current = plan?.id;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const planIdRef = useRef(plan?.id);
  planIdRef.current = plan?.id;

  const loadGraph = useCallback(async () => {
    const pid = planIdRef.current;
    if (!pid) return;
    setLoading(true);
    setError(null);
    setExtractResult(null);
    try {
      const d = await api.getKnowledgeGraph(pid, inferEnabled);
      setGraphData(d.graph);
      const mermaidDef = buildMermaidGraph(plan, d.graph.nodes, d.graph.edges);
      await renderMermaid(mermaidDef);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [inferEnabled]);

  useEffect(() => {
    if (!plan?.id) return;
    loadGraph();
  }, [plan?.id, loadGraph]);

  // Re-render when filters or highlighting change
  useEffect(() => {
    if (!graphData) return;
    const mermaidDef = buildMermaidGraph(plan, graphData.nodes, filteredEdges(graphData.edges));
    renderMermaid(mermaidDef);
  }, [activeFilters, highlightedNode, graphData]);

  // Attach click handlers to SVG after each render
  useEffect(() => {
    if (!graphSvg || !graphContainerRef.current) return;
    const container = graphContainerRef.current;
    // Use requestAnimationFrame for safer DOM timing
    const raf = requestAnimationFrame(() => {
      const svgEl = container.querySelector('svg');
      if (svgEl) {
        svgRef.current = svgEl;
        attachNodeClickHandlers(svgEl);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [graphSvg]);

  const filteredEdges = (edges) => {
    return edges.filter(e => {
      // Always hide transitive/inherited edges if infer is disabled
      if (!inferEnabled && (e.source === 'transitive' || e.source === 'inherited')) return false;
      // Apply type filter
      if (!activeFilters[e.type]) return false;
      return true;
    });
  };

  const toggleFilter = (type) => {
    setActiveFilters(prev => ({ ...prev, [type]: !prev[type] }));
  };

  const toggleFilterGroup = (types, show) => {
    setActiveFilters(prev => {
      const next = { ...prev };
      for (const t of types) next[t] = show;
      return next;
    });
  };

  const handleNodeClick = (nodeId) => {
    if (highlightedNode === nodeId) {
      setHighlightedNode(null); // deselect
    } else {
      setHighlightedNode(nodeId);
    }
  };

  const handleExtractRelations = async () => {
    if (!plan) return;
    setExtracting(true);
    setExtractResult(null);
    try {
      const result = await api.extractRelations(plan.id);
      setExtractResult(result);
      // Auto-enable infer mode
      if (!inferEnabled) {
        setInferEnabled(true);
      } else {
        // Reload to show extracted edges
        await loadGraph();
      }
    } catch (err) {
      setExtractResult({ error: err.message });
    } finally {
      setExtracting(false);
    }
  };

  // Attach click handlers to SVG node elements
  const attachNodeClickHandlers = (svgEl) => {
    // Find all node clusters (Mermaid renders nodes as <g class="node">)
    const nodeGroups = svgEl.querySelectorAll('g.node');
    for (const g of nodeGroups) {
      // Remove existing handlers
      g.style.cursor = 'pointer';
      g.onclick = null;
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        // Extract node ID from the anchor or text
        const anchor = g.querySelector('a');
        if (anchor) {
          const href = anchor.getAttribute('href');
          if (href && href.startsWith('#')) {
            handleNodeClick(href.slice(1));
            return;
          }
        }
        // Fallback: look for a title element
        const titleEl = g.querySelector('title');
        if (titleEl) {
          handleNodeClick(titleEl.textContent);
        }
      });
    }
    // Click on background to deselect
    svgEl.addEventListener('click', (e) => {
      if (e.target === svgEl || e.target.tagName === 'svg') {
        setHighlightedNode(null);
      }
    });
  };

  const buildMermaidGraph = (plan, nodes, edges) => {
    const phaseNames = {};
    const phaseOrder = {};
    for (const p of plan.phases || []) {
      phaseNames[p.id] = p.name;
      phaseOrder[p.id] = p.order || 0;
    }

    // Group nodes by phase
    const nodesByPhase = {};
    const ungroupedNodes = [];
    for (const n of nodes) {
      if (n.phaseId && phaseNames[n.phaseId]) {
        if (!nodesByPhase[n.phaseId]) nodesByPhase[n.phaseId] = [];
        nodesByPhase[n.phaseId].push(n);
      } else {
        ungroupedNodes.push(n);
      }
    }

    const sortedPhaseIds = Object.keys(nodesByPhase).sort((a, b) => (phaseOrder[a] || 0) - (phaseOrder[b] || 0));

    // Build phase color map
    const phaseIndex = {};
    for (const p of plan.phases || []) {
      phaseIndex[p.id] = plan.phases.indexOf(p) % PHASE_COLORS.length;
    }

    // Use flowchart for better layout control with subgraphs
    let def = 'flowchart LR;\n';

    // Add ungrouped nodes first (if any)
    for (const n of ungroupedNodes) {
      const nodeId = 'n' + n.id.replace(/-/g, '_');
      const label = n.title
        .replace(/"/g, '\u0027')
        .replace(/[\[\]]/g, '')
        .substring(0, 30) + (n.title.length > 30 ? '...' : '');
      def += `    ${nodeId}["${label}"];\n`;
    }

    // Add grouped nodes with subgraphs
    for (const phaseId of sortedPhaseIds) {
      const phaseNodes = nodesByPhase[phaseId];
      const phaseName = phaseNames[phaseId] || `阶段 ${phaseId}`;
      const colorIdx = phaseIndex[phaseId] || 0;

      def += `\n    subgraph sg_${phaseId}["${phaseName}"]\n`;

      for (const n of phaseNodes) {
        const nodeId = 'n' + n.id.replace(/-/g, '_');
        const label = n.title
          .replace(/"/g, '\u0027')
          .replace(/[\[\]]/g, '')
          .substring(0, 30) + (n.title.length > 30 ? '...' : '');
        def += `        ${nodeId}["${label}"];\n`;
      }
      def += '    end\n';
    }

    // Add node styling
    for (const n of nodes) {
      const nodeId = 'n' + n.id.replace(/-/g, '_');
      const colorIdx = phaseIndex[n.phaseId] || 0;
      let fillColor = n.done ? '#bbf7d0' : PHASE_COLORS[colorIdx];

      // Highlight styling
      if (highlightedNode) {
        if (n.id === highlightedNode) {
          fillColor = '#fde68a'; // highlighted node
          def += `    style ${nodeId} fill:${fillColor},stroke:#f59e0b,stroke-width:3px;\n`;
          continue;
        }
        // Check if this node is connected to the highlighted node
        const connected = edges.some(e =>
          (e.from === highlightedNode && e.to === n.id) ||
          (e.to === highlightedNode && e.from === n.id)
        );
        if (connected) {
          def += `    style ${nodeId} fill:${fillColor},stroke:#3b82f6,stroke-width:2px,opacity:1;\n`;
        } else {
          def += `    style ${nodeId} fill:${fillColor},stroke:#cbd5e1,stroke-width:1px,opacity:0.4;\n`;
        }
      } else {
        def += `    style ${nodeId} fill:${fillColor},stroke:#94a3b8,stroke-width:1px;\n`;
      }
    }

    // Add edges with type-specific styling
    for (const e of edges) {
      const fromId = 'n' + e.from.replace(/-/g, '_');
      const toId = 'n' + e.to.replace(/-/g, '_');
      const typeInfo = RELATION_TYPES[e.type] || RELATION_TYPES.related;
      const edgeLabel = typeInfo.label;
      const isInferred = e.source === 'detail' || e.source === 'transitive' || e.source === 'inherited';

      // Choose connector based on directionality and line style
      const isBidirectional = e.type === 'related' || e.type === 'contrasts' ||
        (typeInfo.group === 'association' && e.type !== 'buildsOn');
      const isDashed = typeInfo.style === 'dashed' || typeInfo.style === 'dotted' || isInferred;

      let connector;
      if (isBidirectional && isDashed) connector = '<-.->';
      else if (isBidirectional) connector = '<-->';
      else if (isDashed) connector = '-.->';
      else connector = '-->';

      def += `    ${fromId} ${connector}|${edgeLabel}| ${toId};\n`;
    }

    // Apply link styles post-definition (per-edge colors, dash styles, and weight thickness)
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const typeInfo = RELATION_TYPES[e.type] || RELATION_TYPES.related;
      const isInferred = e.source === 'detail' || e.source === 'transitive' || e.source === 'inherited';
      const dashPattern = typeInfo.style === 'dashed' ? '8,4' :
                          typeInfo.style === 'dotted' ? '4,4' : '0,0';
      // Use weight for stroke thickness (weight 0-1, default 0.5)
      const weight = e.weight != null ? e.weight : 0.5;
      const strokeWidth = weight >= 0.8 ? 2.5 : weight >= 0.5 ? 2 : 1.5;
      def += `\nlinkStyle ${i} stroke:${typeInfo.color},stroke-width:${strokeWidth},stroke-dasharray:${dashPattern},opacity:${Math.min(0.4 + weight * 0.6, 1)};`;
    }

    return def;
  };

  const renderMermaid = async (mermaidDef) => {
    try {
      const mermaid = await import('mermaid');
      mermaid.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        flowchart: {
          useMaxWidth: true,
          htmlLabels: true,
          curve: 'basis',
          padding: 16,
        },
      });
      const id = 'kg-' + Math.random().toString(36).slice(2, 9);
      const { svg } = await mermaid.default.render(id, mermaidDef);
      if (mountedRef.current) setGraphSvg(svg);
    } catch (err) {
      if (!mountedRef.current) return;
      setError('图谱渲染失败: ' + err.message);
      setGraphSvg('<pre style="background:#f8fafc;padding:16px;border-radius:6px;overflow:auto;font-size:12px;">' +
        mermaidDef.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>');
    }
  };

  // Count edge types for display
  const edgeTypeCounts = {};
  if (graphData) {
    for (const e of graphData.edges) {
      edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
    }
  }

  // Count nodes per phase
  const phaseNodeCounts = {};
  if (graphData && plan) {
    for (const n of graphData.nodes) {
      if (n.phaseId) {
        phaseNodeCounts[n.phaseId] = (phaseNodeCounts[n.phaseId] || 0) + 1;
      }
    }
  }

  return (
    <div className="kg-modal-overlay" onClick={onClose}>
      <div className="kg-modal kg-modal-wide" onClick={e => e.stopPropagation()}>
        <div className="kg-modal-header">
          <span>🕸️ 知识图谱 — {plan.name}</span>
          <div className="kg-modal-actions">
            <button className="btn-tiny" onClick={loadGraph} title="重新加载">🔄</button>
            <button className="btn-tiny" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="kg-modal-body">
          <div className="kg-toolbar">
            {/* Infer toggle */}
            <label className="kg-toggle" title="启用 AI 文本提取 + 传递性依赖推导 + 继承依赖">
              <input
                type="checkbox"
                checked={inferEnabled}
                onChange={() => {
                  setInferEnabled(!inferEnabled);
                  setHighlightedNode(null);
                }}
              />
              <span>智能推断关系</span>
            </label>

            {/* Extract button */}
            <button
              className="btn btn-sm"
              onClick={handleExtractRelations}
              disabled={extracting}
              title="从 AI 生成的讲解文本中提取知识点关系"
            >
              {extracting ? '⏳ 提取中...' : '🔍 从文本提取关系'}
            </button>

            {/* Clear highlight */}
            {highlightedNode && (
              <button className="btn btn-sm" onClick={() => setHighlightedNode(null)}>
                ✕ 取消高亮
              </button>
            )}
          </div>

          {/* Extract result banner */}
          {extractResult && !extractResult.error && (
            <div className="kg-extract-result">
              <span className="kg-extract-success">
                ✅ 从讲解文本中提取了 <strong>{extractResult.detailCount || 0}</strong> 条直接关系、
                <strong>{extractResult.transitiveCount || 0}</strong> 条传递依赖、
                <strong>{extractResult.inheritedCount || 0}</strong> 条继承依赖
                （共 {extractResult.totalCount || 0} 条推断边）
              </span>
              <button className="btn-tiny" onClick={() => setExtractResult(null)}>✕</button>
            </div>
          )}
          {extractResult && extractResult.error && (
            <div className="kg-extract-result kg-extract-error">
              ❌ {extractResult.error}
              <button className="btn-tiny" onClick={() => setExtractResult(null)}>✕</button>
            </div>
          )}

          {/* Filter toolbar */}
          <div className="kg-filters">
            {FILTER_GROUPS.map(group => {
              const allActive = group.types.every(t => activeFilters[t]);
              const someActive = group.types.some(t => activeFilters[t]);
              return (
                <span key={group.key} className="kg-filter-group">
                  <button
                    className={`kg-filter-btn ${allActive ? 'active' : someActive ? 'partial' : ''}`}
                    onClick={() => toggleFilterGroup(group.types, !allActive)}
                    title={`${allActive ? '隐藏' : '显示'} ${group.label}`}
                  >
                    {group.label}
                    <span className="kg-filter-count">
                      ({group.types.reduce((s, t) => s + (edgeTypeCounts[t] || 0), 0)})
                    </span>
                  </button>
                  <span className="kg-filter-detail">
                    {group.types.map(type => (
                      <label key={type} className="kg-filter-chip" style={{ borderColor: RELATION_TYPES[type]?.color }}>
                        <input
                          type="checkbox"
                          checked={activeFilters[type] || false}
                          onChange={() => toggleFilter(type)}
                        />
                        <span style={{ color: RELATION_TYPES[type]?.color }}>
                          {RELATION_TYPES[type]?.label}
                        </span>
                        <span className="kg-filter-chip-count">{edgeTypeCounts[type] || 0}</span>
                      </label>
                    ))}
                  </span>
                </span>
              );
            })}
          </div>

          {/* Graph area */}
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
            <div
              className="kg-svg-container"
              ref={graphContainerRef}
              dangerouslySetInnerHTML={{ __html: graphSvg }}
            />
          ) : (
            <p className="kg-empty">暂无知识图谱数据</p>
          )}
        </div>
        <div className="kg-modal-footer">
          <span className="kg-legend">
            <span className="kg-legend-item">📘 一级(章)</span>
            <span className="kg-legend-item">📗 二级(节)</span>
            <span className="kg-legend-item">📙 三级(子节)</span>
            <span className="kg-legend-sep">|</span>
            <span className="kg-legend-item" style={{ borderLeft: '2px solid #d1d5db', paddingLeft: '10px' }}>
              <span style={{ fontWeight: 600, color: '#475569' }}>→</span> 包含
            </span>
            <span className="kg-legend-item">
              <span style={{ color: '#dc2626', fontWeight: 600 }}>- - →</span> 前置依赖
            </span>
            <span className="kg-legend-item">
              <span style={{ color: '#7c3aed', fontWeight: 600 }}>- - →</span> 扩展延伸
            </span>
            <span className="kg-legend-item">
              <span style={{ color: '#059669', fontWeight: 600 }}>···→</span> 示例
            </span>
            <span className="kg-legend-item">
              <span style={{ color: '#2563eb', fontWeight: 600 }}>↔</span> 相关
            </span>
            <span className="kg-legend-sep">|</span>
            <span className="kg-legend-item">
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#bbf7d0', borderRadius: 2, verticalAlign: 'middle', marginRight: 3 }}></span> 已学习
            </span>
            <span className="kg-legend-item">
              <span style={{ display: 'inline-block', width: 12, height: 12, background: '#fde68a', borderRadius: 2, verticalAlign: 'middle', marginRight: 3 }}></span> 选中
            </span>
            <span className="kg-legend-item">
              <span style={{ opacity: 0.4 }}>⬜</span> 未关联
            </span>
            {inferEnabled && graphData?.inferredCount > 0 && (
              <span className="kg-legend-item kg-legend-inferred">
                💡 推断边 {graphData.baseEdgeCount} 基础 + {graphData.inferredCount} 推断
              </span>
            )}
            {highlightedNode && (
              <span className="kg-legend-item kg-legend-hint">
                💡 点击空白取消高亮 | 点击节点查看关联
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
