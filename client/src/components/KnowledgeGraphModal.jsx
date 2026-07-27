import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Download, RefreshCw, Filter, Eye, Lightbulb, AlertCircle, CheckCircle, Network, ZoomIn, ZoomOut, Maximize2, Move } from 'lucide-react';
import { Button } from '#/components/ui/button';
import { collapseGraphToOverview } from '#/lib/knowledge-graph-layout';
import api from '../api';

const PHASE_COLORS = ['#e0f2fe', '#dcfce7', '#fef3c7', '#fce7f3', '#e0e7ff', '#f3e8ff', '#ffedd5', '#d1fae5'];

const RELATION_TYPES = {
  parentOf:               { label: '包含',          style: 'solid',    color: '#475569',  group: 'structure' },
  prerequisite:           { label: '前置依赖',       style: 'dashed',  color: '#dc2626',  group: 'dependency' },
  related:                { label: '相关',           style: 'dotted',  color: '#2563eb',  group: 'association' },
  extends:                { label: '扩展延伸',       style: 'dashed',  color: '#7c3aed',  group: 'association' },
  exampleOf:              { label: '示例',           style: 'dotted',  color: '#059669',  group: 'association' },
  contrasts:              { label: '对比',           style: 'dashed',  color: '#ea580c',  group: 'association' },
  buildsOn:               { label: '构建于',         style: 'dashed',  color: '#0891b2',  group: 'dependency' },
  references:             { label: '参考',           style: 'dotted',  color: '#78716c',  group: 'association' },
  transitivePrerequisite: { label: '间接前置依赖',   style: 'dotted',  color: '#f87171',  group: 'dependency' },
  inheritedPrerequisite:  { label: '继承前置依赖',   style: 'dotted',  color: '#fb923c',  group: 'dependency' },
};

const FILTER_GROUPS = [
  { key: 'structure',   label: '结构关系',   types: ['parentOf'] },
  { key: 'dependency',  label: '依赖关系',   types: ['prerequisite', 'buildsOn', 'transitivePrerequisite', 'inheritedPrerequisite'] },
  { key: 'association', label: '关联关系',   types: ['related', 'extends', 'exampleOf', 'contrasts', 'references'] },
];

const toMermaidNodeId = (nodeId) => 'n' + String(nodeId).replace(/-/g, '_');

export default function KnowledgeGraphModal({ plan, onClose, onSelectTopic: _onSelectTopic, onGenerate: _onGenerate }) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [graphSvg, setGraphSvg] = useState('');
  const [inferEnabled, setInferEnabled] = useState(false);
  const [activeFilters, setActiveFilters] = useState(() => {
    const f = {};
    for (const [key, type] of Object.entries(RELATION_TYPES)) f[key] = type.group !== 'association';
    return f;
  });
  const [highlightedNode, setHighlightedNode] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState(null);
  const [layoutDirection, setLayoutDirection] = useState('auto');
  const [viewMode, setViewMode] = useState('auto');
  const [exportFormat, setExportFormat] = useState('json');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const graphContainerRef = useRef(null);
  const graphViewportRef = useRef(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const renderSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const planIdRef = useRef(plan?.id);
  planIdRef.current = plan?.id;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadGraph = useCallback(async () => {
    const pid = planIdRef.current;
    if (!pid) return;
    setLoading(true);
    setError(null);
    setExtractResult(null);
    setGraphData(null);
    setGraphSvg('');
    try {
      const d = await api.getKnowledgeGraph(pid, inferEnabled);
      setGraphData(d.graph);
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

  const filteredGraphEdges = useMemo(() => {
    if (!graphData) return [];
    return graphData.edges.filter(edge => {
      if (!inferEnabled && (edge.source === 'transitive' || edge.source === 'inherited')) return false;
      return Boolean(activeFilters[edge.type]);
    });
  }, [graphData, inferEnabled, activeFilters]);

  const resolvedViewMode = viewMode === 'auto'
    ? ((graphData?.nodes?.length || 0) > 24 ? 'overview' : 'full')
    : viewMode;

  const renderedGraph = useMemo(() => {
    if (!graphData) return null;
    if (resolvedViewMode === 'overview') {
      return collapseGraphToOverview(graphData.nodes, filteredGraphEdges, graphData.edges);
    }
    return { nodes: graphData.nodes, edges: filteredGraphEdges };
  }, [graphData, filteredGraphEdges, resolvedViewMode]);

  useEffect(() => {
    if (!renderedGraph) return;
    const direction = layoutDirection === 'auto'
      ? (resolvedViewMode === 'overview' ? 'LR' : ((renderedGraph.nodes.length > 10 || renderedGraph.edges.length > 14 || (plan.phases?.length || 0) > 4) ? 'TB' : 'LR'))
      : layoutDirection;
    const mermaidDef = buildMermaidGraph(plan, renderedGraph.nodes, renderedGraph.edges, direction);
    renderMermaid(mermaidDef);
  }, [renderedGraph, highlightedNode, layoutDirection, resolvedViewMode, plan]);

  useEffect(() => {
    if (!graphSvg || !graphContainerRef.current) return;
    const container = graphContainerRef.current;
    const raf = requestAnimationFrame(() => {
      const svgEl = container.querySelector('svg');
      if (svgEl) {
        svgRef.current = svgEl;
        svgEl.setAttribute('width', '100%');
        svgEl.setAttribute('height', '100%');
        svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svgEl.style.width = '100%';
        svgEl.style.height = '100%';
        svgEl.style.maxWidth = 'none';
        svgEl.style.display = 'block';
        attachNodeClickHandlers(svgEl, renderedGraph?.nodes || []);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [graphSvg, renderedGraph]);

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
      setHighlightedNode(null);
    } else {
      setHighlightedNode(nodeId);
    }
  };

  const fitView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const changeZoom = (delta) => {
    setZoom(current => Math.min(3, Math.max(0.5, Math.round((current + delta) * 100) / 100)));
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0 || event.target.closest?.('g.node')) return;
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setIsPanning(true);
    graphViewportRef.current?.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event) => {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.panX + event.clientX - dragRef.current.x,
      y: dragRef.current.panY + event.clientY - dragRef.current.y,
    });
  };

  const handlePointerUp = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsPanning(false);
    graphViewportRef.current?.releasePointerCapture?.(event.pointerId);
  };

  const handleWheel = (event) => {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 0.15 : -0.15);
  };

  const handleExtractRelations = async () => {
    if (!plan) return;
    setExtracting(true);
    setExtractResult(null);
    try {
      const result = await api.extractRelations(plan.id);
      setExtractResult(result);
      if (!inferEnabled) {
        setInferEnabled(true);
      } else {
        await loadGraph();
      }
    } catch (err) {
      setExtractResult({ error: err.message });
    } finally {
      setExtracting(false);
    }
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sanitizeFilename = (name) => name.replace(/[/\\?%*:|"<>]/g, '_');

  const handleExportJSON = () => {
    if (!graphData) return;
    const json = JSON.stringify(graphData, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `${sanitizeFilename(plan.name)}.知识图谱.json`);
  };

  const handleExportSVG = () => {
    if (!graphContainerRef.current) return;
    const svgEl = graphContainerRef.current.querySelector('svg');
    if (!svgEl) return;
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', 'white');
    clone.insertBefore(bg, clone.firstChild);
    const svgData = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(blob, `${sanitizeFilename(plan.name)}.知识图谱.svg`);
  };

  const handleExportPNG = () => {
    if (!graphContainerRef.current) return;
    const svgEl = graphContainerRef.current.querySelector('svg');
    if (!svgEl) return;
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const viewBox = clone.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.split(/\s+/).map(Number);
      if (parts.length === 4) {
        clone.setAttribute('width', parts[2]);
        clone.setAttribute('height', parts[3]);
      }
    }
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', 'white');
    clone.insertBefore(bg, clone.firstChild);
    const svgData = new XMLSerializer().serializeToString(clone);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, img.width, img.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${sanitizeFilename(plan.name)}.知识图谱.png`);
      }, 'image/png');
    };
    img.src = dataUrl;
  };

  const handleExportMarkdown = () => {
    if (!graphData || !plan) return;
    const nodes = graphData.nodes || [];
    const edges = graphData.edges || [];
    const phaseNames = {};
    for (const p of plan.phases || []) phaseNames[p.id] = p.name;

    let md = `# 知识图谱 — ${plan.name}\n\n`;
    md += `## 知识点（${nodes.length} 个）\n\n`;

    const byPhase = {};
    const ungrouped = [];
    for (const n of nodes) {
      if (n.phaseId && phaseNames[n.phaseId]) {
        if (!byPhase[n.phaseId]) byPhase[n.phaseId] = [];
        byPhase[n.phaseId].push(n);
      } else {
        ungrouped.push(n);
      }
    }
    const sortedPhaseIds = Object.keys(byPhase).sort((a, b) => {
      const pa = (plan.phases || []).find(p => p.id === a);
      const pb = (plan.phases || []).find(p => p.id === b);
      return (pa?.order || 0) - (pb?.order || 0);
    });
    for (const pid of sortedPhaseIds) {
      md += `### ${phaseNames[pid]}\n`;
      for (const n of byPhase[pid]) {
        md += `- ${n.title}${n.done ? ' ✅' : ''}\n`;
      }
      md += '\n';
    }
    if (ungrouped.length > 0) {
      md += `### 未分组\n`;
      for (const n of ungrouped) md += `- ${n.title}${n.done ? ' ✅' : ''}\n`;
      md += '\n';
    }

    md += `## 关系（${edges.length} 条）\n\n`;
    const byType = {};
    for (const e of edges) {
      if (!byType[e.type]) byType[e.type] = [];
      byType[e.type].push(e);
    }
    const typeLabels = {
      parentOf: '包含', prerequisite: '前置依赖', related: '相关',
      extends: '扩展延伸', exampleOf: '示例', contrasts: '对比',
      buildsOn: '构建于', references: '参考',
      transitivePrerequisite: '间接前置依赖', inheritedPrerequisite: '继承前置依赖',
    };
    for (const [type, typeEdges] of Object.entries(byType)) {
      md += `### ${typeLabels[type] || type}\n`;
      for (const e of typeEdges) {
        const fromTitle = nodes.find(n => n.id === e.from)?.title || e.from;
        const toTitle = nodes.find(n => n.id === e.to)?.title || e.to;
        md += `- ${fromTitle} → ${toTitle}`;
        if (e.source === 'detail' || e.source === 'transitive' || e.source === 'inherited') md += '（推断）';
        md += '\n';
      }
      md += '\n';
    }

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, `${sanitizeFilename(plan.name)}.知识图谱.md`);
  };

  const handleExport = () => {
    if (exportFormat === 'json') handleExportJSON();
    else if (exportFormat === 'svg') handleExportSVG();
    else if (exportFormat === 'png') handleExportPNG();
    else if (exportFormat === 'markdown') handleExportMarkdown();
  };

  const attachNodeClickHandlers = (svgEl, nodes) => {
    const nodeIds = nodes.map(node => ({
      raw: String(node.id),
      mermaid: toMermaidNodeId(node.id),
    }));
    const nodeGroups = svgEl.querySelectorAll('g.node');
    for (const g of nodeGroups) {
      const anchorHref = g.querySelector('a')?.getAttribute('href');
      const anchorNodeId = anchorHref?.startsWith('#') ? anchorHref.slice(1) : null;
      const titleNodeId = g.querySelector('title')?.textContent?.trim();
      const groupId = g.getAttribute('id') || '';
      const matchedNode = nodeIds.find(node =>
        anchorNodeId === node.raw ||
        anchorNodeId === node.mermaid ||
        titleNodeId === node.raw ||
        titleNodeId === node.mermaid ||
        groupId.includes(`-flowchart-${node.mermaid}-`)
      );

      if (!matchedNode) continue;
      g.dataset.topicId = matchedNode.raw;
      g.style.cursor = 'pointer';
      g.onclick = (e) => {
        e.stopPropagation();
        handleNodeClick(matchedNode.raw);
      };
    }
    svgEl.onclick = (e) => {
      if (e.target === svgEl || e.target.tagName === 'svg') {
        setHighlightedNode(null);
      }
    };
  };

  const buildMermaidGraph = (plan, nodes, edges, direction = 'LR') => {
    const phaseNames = {};
    const phaseOrder = {};
    for (const p of plan.phases || []) {
      phaseNames[p.id] = p.name;
      phaseOrder[p.id] = p.order || 0;
    }

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

    const phaseIndex = {};
    for (const p of plan.phases || []) {
      phaseIndex[p.id] = plan.phases.indexOf(p) % PHASE_COLORS.length;
    }

    let def = `flowchart ${direction};\n`;

    const nodeLabel = (node) => {
      const rawTitle = String(node.title || '')
        .replace(/"/g, '\u0027')
        .replace(/[[\]]/g, '')
        .replace(/\(/g, '&#40;').replace(/\)/g, '&#41;');
      const title = rawTitle.substring(0, 30) + (rawTitle.length > 30 ? '...' : '');
      if (!node.totalCount || node.totalCount <= 1) return title;
      return `${title}<br/><small>${node.doneCount}/${node.totalCount} 已学习</small>`;
    };

    for (const n of ungroupedNodes) {
      const nodeId = toMermaidNodeId(n.id);
      const label = nodeLabel(n);
      def += `    ${nodeId}["${label}"];\n`;
    }

    for (const phaseId of sortedPhaseIds) {
      const phaseNodes = nodesByPhase[phaseId];
      const phaseName = phaseNames[phaseId] || `阶段 ${phaseId}`;

      def += `\n    subgraph sg_${phaseId}["${phaseName}"]\n`;

      for (const n of phaseNodes) {
        const nodeId = toMermaidNodeId(n.id);
        const label = nodeLabel(n);
        def += `        ${nodeId}["${label}"];\n`;
      }
      def += '    end\n';
    }

    for (const n of nodes) {
      const nodeId = toMermaidNodeId(n.id);
      const colorIdx = phaseIndex[n.phaseId] || 0;
      let fillColor = (n.totalCount ? n.doneCount === n.totalCount : n.done) ? '#bbf7d0' : PHASE_COLORS[colorIdx];

      if (highlightedNode) {
        if (n.id === highlightedNode) {
          fillColor = '#fde68a';
          def += `    style ${nodeId} fill:${fillColor},stroke:#f59e0b,stroke-width:3px;\n`;
          continue;
        }
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

    for (const e of edges) {
      const fromId = toMermaidNodeId(e.from);
      const toId = toMermaidNodeId(e.to);
      const typeInfo = RELATION_TYPES[e.type] || RELATION_TYPES.related;
      const edgeLabel = e.count > 1 ? `${typeInfo.label} ×${e.count}` : typeInfo.label;
      const _isInferred = e.source === 'detail' || e.source === 'transitive' || e.source === 'inherited';

      const isBidirectional = e.type === 'related' || e.type === 'contrasts' ||
        (typeInfo.group === 'association' && e.type !== 'buildsOn');
      const isDashed = typeInfo.style === 'dashed' || typeInfo.style === 'dotted' || _isInferred;

      let connector;
      if (isBidirectional && isDashed) connector = '<-.->';
      else if (isBidirectional) connector = '<-->';
      else if (isDashed) connector = '-.->';
      else connector = '-->';

      def += `    ${fromId} ${connector}|${edgeLabel}| ${toId};\n`;
    }

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const typeInfo = RELATION_TYPES[e.type] || RELATION_TYPES.related;
      const _isInferred = e.source === 'detail' || e.source === 'transitive' || e.source === 'inherited';
      const dashPattern = typeInfo.style === 'dashed' ? '8,4' :
                          typeInfo.style === 'dotted' ? '4,4' : '0,0';
      const weight = e.weight != null ? e.weight : 0.5;
      const strokeWidth = weight >= 0.8 ? 2.5 : weight >= 0.5 ? 2 : 1.5;
      def += `\nlinkStyle ${i} stroke:${typeInfo.color},stroke-width:${strokeWidth},stroke-dasharray:${dashPattern},opacity:${Math.min(0.4 + weight * 0.6, 1)};`;
    }

    return def;
  };

  const renderMermaid = async (mermaidDef) => {
    const sequence = ++renderSequenceRef.current;
    try {
      const mermaid = await import('mermaid');
      mermaid.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        flowchart: {
          useMaxWidth: false,
          htmlLabels: true,
          curve: 'basis',
          padding: 16,
        },
      });
      const id = 'kg-' + Math.random().toString(36).slice(2, 9);
      const { svg } = await mermaid.default.render(id, mermaidDef);
      if (mountedRef.current && sequence === renderSequenceRef.current) setGraphSvg(svg);
    } catch (err) {
      if (!mountedRef.current || sequence !== renderSequenceRef.current) return;
      setError('图谱渲染失败: ' + err.message);
      setGraphSvg('<pre class="kg-error-pre">' +
        mermaidDef.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>');
    }
  };

  const edgeTypeCounts = {};
  if (graphData) {
    for (const e of graphData.edges) {
      edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
    }
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={onClose}>
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='knowledge-graph-title'
        className='flex flex-col w-[calc(100vw-1rem)] h-[calc(100vh-1rem)] sm:w-[calc(100vw-2rem)] sm:h-[calc(100vh-2rem)] max-w-none rounded-lg border bg-card shadow-lg'
        onClick={e => e.stopPropagation()}
      >
        <div className='flex items-center justify-between border-b px-4 py-2.5'>
          <span id='knowledge-graph-title' className='flex min-w-0 items-center gap-2 text-sm font-medium'>
            <Network className='h-4 w-4 text-primary' />
            <span className='truncate'>知识图谱 — {plan.name}</span>
          </span>
          <div className='flex items-center gap-1'>
            {graphData && (
              <div className='flex items-center gap-1'>
                <select
                  aria-label='知识图谱导出格式'
                  value={exportFormat}
                  onChange={event => setExportFormat(event.target.value)}
                  className='h-8 rounded-md border bg-background px-2 text-xs'
                >
                  <option value='json'>JSON</option>
                  <option value='svg'>SVG</option>
                  <option value='png'>PNG</option>
                  <option value='markdown'>Markdown</option>
                </select>
                <Button variant='ghost' size='icon' className='h-8 w-8' onClick={handleExport} aria-label='导出知识图谱' title='导出知识图谱'>
                  <Download className='h-4 w-4' />
                </Button>
              </div>
            )}
            <Button variant='ghost' size='sm' onClick={loadGraph} title='重新加载'><RefreshCw className='h-3.5 w-3.5' /></Button>
            <Button variant='ghost' size='icon' onClick={onClose} aria-label='关闭知识图谱'><X className='h-4 w-4' /></Button>
          </div>
        </div>
        <div className='flex-1 flex flex-col overflow-hidden'>
          <div className='flex items-center gap-2 border-b px-4 py-2 flex-wrap'>
            <label className='flex items-center gap-1.5 text-xs'>
              <span className='text-muted-foreground'>视图</span>
              <select
                aria-label='图谱视图'
                value={viewMode}
                onChange={(event) => { setViewMode(event.target.value); setHighlightedNode(null); fitView(); }}
                className='h-8 rounded-md border bg-background px-2 text-xs'
              >
                <option value='auto'>自动聚合</option>
                <option value='overview'>主题骨架</option>
                <option value='full'>全部知识点</option>
              </select>
            </label>

            <label className='flex items-center gap-1.5 text-xs'>
              <span className='text-muted-foreground'>布局</span>
              <select
                aria-label='图谱布局'
                value={layoutDirection}
                onChange={(event) => { setLayoutDirection(event.target.value); fitView(); }}
                className='h-8 rounded-md border bg-background px-2 text-xs'
              >
                <option value='auto'>自动</option>
                <option value='LR'>横向</option>
                <option value='TB'>纵向</option>
              </select>
            </label>

            <label className='flex items-center gap-1.5 text-xs cursor-pointer select-none' title='启用 AI 文本提取 + 传递性依赖推导 + 继承依赖'>
              <input type='checkbox' checked={inferEnabled} onChange={() => { setInferEnabled(!inferEnabled); setHighlightedNode(null); }} className='rounded' />
              <Lightbulb className='h-3 w-3 text-muted-foreground' />
              <span>智能推断关系</span>
            </label>

            <Button variant='outline' size='sm' onClick={handleExtractRelations} disabled={extracting} title='从 AI 生成的讲解文本中提取知识点关系'>
              {extracting ? <RefreshCw className='h-3 w-3 mr-1 animate-spin' /> : <Eye className='h-3 w-3 mr-1' />}
              {extracting ? '提取中...' : '从文本提取关系'}
            </Button>

            <Button variant='ghost' size='sm' onClick={() => setFiltersExpanded(value => !value)} aria-expanded={filtersExpanded}>
              <Filter className='h-3 w-3 mr-1' />关系筛选
            </Button>

            {highlightedNode && (
              <Button variant='ghost' size='sm' onClick={() => setHighlightedNode(null)}>
                <X className='h-3 w-3 mr-1' />取消高亮
              </Button>
            )}
          </div>

          {extractResult && !extractResult.error && (
            <div className='flex items-center justify-between gap-2 border-b bg-green-50 dark:bg-green-950 px-4 py-1.5 text-xs'>
              <span className='flex items-center gap-1 text-green-700 dark:text-green-300'>
                <CheckCircle className='h-3 w-3' />
                从讲解文本中提取了 <strong>{extractResult.detailCount || 0}</strong> 条直接关系、
                <strong>{extractResult.transitiveCount || 0}</strong> 条传递依赖、
                <strong>{extractResult.inheritedCount || 0}</strong> 条继承依赖
                （共 {extractResult.totalCount || 0} 条推断边）
              </span>
              <Button variant='ghost' size='sm' onClick={() => setExtractResult(null)}><X className='h-3 w-3' /></Button>
            </div>
          )}
          {extractResult && extractResult.error && (
            <div className='flex items-center justify-between gap-2 border-b bg-red-50 dark:bg-red-950 px-4 py-1.5 text-xs'>
              <span className='flex items-center gap-1 text-red-600 dark:text-red-400'>
                <AlertCircle className='h-3 w-3' />
                {extractResult.error}
              </span>
              <Button variant='ghost' size='sm' onClick={() => setExtractResult(null)}><X className='h-3 w-3' /></Button>
            </div>
          )}

          {filtersExpanded && <div className='flex items-center gap-3 border-b px-4 py-1.5 flex-wrap'>
            {FILTER_GROUPS.map(group => {
              const allActive = group.types.every(t => activeFilters[t]);
              const someActive = group.types.some(t => activeFilters[t]);
              return (
                <div key={group.key} className='flex items-center gap-1'>
                  <button
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${allActive ? 'bg-primary/10 border-primary/30 text-primary' : someActive ? 'bg-accent border-border text-muted-foreground' : 'bg-muted border-border text-muted-foreground'}`}
                    onClick={() => toggleFilterGroup(group.types, !allActive)}
                    title={`${allActive ? '隐藏' : '显示'} ${group.label}`}
                  >
                    <Filter className='h-2.5 w-2.5 inline mr-0.5' />
                    {group.label}
                    <span className='ml-0.5 opacity-60'>
                      ({group.types.reduce((s, t) => s + (edgeTypeCounts[t] || 0), 0)})
                    </span>
                  </button>
                  <div className='flex items-center gap-0.5'>
                    {group.types.map(type => (
                      <label key={type} className='flex items-center gap-0.5 text-[10px] cursor-pointer select-none px-1 py-0.5 rounded hover:bg-accent transition-colors' style={{ borderColor: RELATION_TYPES[type]?.color }}>
                        <input type='checkbox' checked={activeFilters[type] || false} onChange={() => toggleFilter(type)} className='w-2.5 h-2.5' />
                        <span style={{ color: RELATION_TYPES[type]?.color }}>{RELATION_TYPES[type]?.label}</span>
                        <span className='opacity-50 ml-0.5'>{edgeTypeCounts[type] || 0}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>}

          <div className='relative flex-1 min-h-0 overflow-hidden bg-muted/15'>
            {loading ? (
              <div className='flex flex-col items-center justify-center h-full gap-3 text-muted-foreground'>
                <div className='animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent' />
                <p className='text-sm'>生成知识图谱...</p>
              </div>
            ) : error ? (
              <div className='flex flex-col items-center justify-center h-full gap-3'>
                <AlertCircle className='h-8 w-8 text-destructive' />
                <p className='text-sm text-destructive'>{error}</p>
                <Button variant='outline' size='sm' onClick={loadGraph}>重试</Button>
              </div>
            ) : graphSvg ? (
              <>
                <div className='absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border bg-background/95 p-1 shadow-sm'>
                  <Button variant='ghost' size='icon' className='h-8 w-8' onClick={() => changeZoom(-0.25)} aria-label='缩小' title='缩小'>
                    <ZoomOut className='h-4 w-4' />
                  </Button>
                  <output aria-label='缩放比例' className='w-12 text-center text-xs tabular-nums'>{Math.round(zoom * 100)}%</output>
                  <Button variant='ghost' size='icon' className='h-8 w-8' onClick={() => changeZoom(0.25)} aria-label='放大' title='放大'>
                    <ZoomIn className='h-4 w-4' />
                  </Button>
                  <Button variant='ghost' size='icon' className='h-8 w-8' onClick={fitView} aria-label='适应视图' title='适应视图'>
                    <Maximize2 className='h-4 w-4' />
                  </Button>
                </div>
                <div
                  ref={graphViewportRef}
                  data-testid='knowledge-graph-viewport'
                  className={`absolute inset-0 touch-none select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onWheel={handleWheel}
                >
                  <div
                    ref={graphContainerRef}
                    data-testid='knowledge-graph-canvas'
                    className={`absolute inset-4 origin-center ${isPanning ? '' : 'transition-transform duration-100'}`}
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                    dangerouslySetInnerHTML={{ __html: graphSvg }}
                  />
                </div>
              </>
            ) : (
              <div className='flex items-center justify-center h-full text-muted-foreground text-sm'>
                暂无知识图谱数据
              </div>
            )}
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-t px-4 py-1.5 text-[11px] text-muted-foreground'>
          <span>📘 一级(章)</span>
          <span>📗 二级(节)</span>
          <span>📙 三级(子节)</span>
          <span className='text-border'>|</span>
          <span className='flex items-center gap-1'><Move className='h-3 w-3' />拖拽平移 · 滚轮缩放</span>
          <span className='text-border'>|</span>
          {graphData && renderedGraph && (
            <span>{resolvedViewMode === 'overview' ? `主题骨架 ${renderedGraph.nodes.length}/${graphData.nodes.length}` : `全部 ${graphData.nodes.length} 个知识点`}</span>
          )}
          <span className='text-border'>|</span>
          <span><span className='font-mono'>&rarr;</span> 包含</span>
          <span><span className='font-mono'>- - &rarr;</span> 前置依赖</span>
          <span><span className='font-mono'>- - &rarr;</span> 扩展延伸</span>
          <span><span className='font-mono'>···&rarr;</span> 示例</span>
          <span><span className='font-mono'>&#8596;</span> 相关</span>
          <span className='text-border'>|</span>
          <span className='flex items-center gap-1'><span className='inline-block w-3 h-3 rounded-sm bg-green-200' /> 已学习</span>
          <span className='flex items-center gap-1'><span className='inline-block w-3 h-3 rounded-sm bg-yellow-200 border border-yellow-500' /> 选中</span>
          <span>⬜ 未关联</span>
          {inferEnabled && graphData?.inferredCount > 0 && (
            <span className='text-primary'>推断边 {graphData.baseEdgeCount} 基础 + {graphData.inferredCount} 推断</span>
          )}
          {highlightedNode && (
            <span className='text-muted-foreground'>点击空白取消高亮 | 点击节点查看关联</span>
          )}
        </div>
      </div>
    </div>
  );
}
