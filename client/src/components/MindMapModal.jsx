import { useState, useEffect, useRef } from 'react';

/**
 * Build a tree structure from the flat topics and phases.
 * Returns an array of root nodes (phase-level grouping).
 */
function buildTree(plan) {
  const phaseMap = {};
  for (const p of plan.phases || []) {
    phaseMap[p.id] = { id: p.id, name: p.name, order: p.order || 0, children: [] };
  }

  // Build parent map
  const topicMap = {};
  for (const t of plan.topics) {
    topicMap[t.id] = { ...t, children: [] };
  }

  // Attach children to parents or to phases
  const roots = [];
  for (const t of plan.topics) {
    const node = topicMap[t.id];
    if (t.parentId && topicMap[t.parentId]) {
      topicMap[t.parentId].children.push(node);
    } else if (t.phaseId && phaseMap[t.phaseId]) {
      phaseMap[t.phaseId].children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort phases and their children
  for (const phaseId of Object.keys(phaseMap)) {
    const phase = phaseMap[phaseId];
    phase.children.sort((a, b) => a.order - b.order);
    roots.push(phase);
  }

  // Sort root-level items
  roots.sort((a, b) => (a.order || 0) - (b.order || 0));

  return roots;
}

/**
 * Convert tree to Markdown (for markmap).
 * Appends status badges for done topics.
 */
function treeToMarkdown(nodes, depth = 1) {
  let md = '';
  for (const n of nodes) {
    if (n.name !== undefined) {
      // Phase node
      const done = n.children.every(c => c.done);
      md += `${'#'.repeat(depth)} ${n.name}${done ? ' ✅' : ''}\n`;
      if (n.children.length > 0) {
        // Sort children by order
        n.children.sort((a, b) => a.order - b.order);
        md += treeToMarkdown(n.children, depth + 1);
      }
    } else {
      // Topic node
      const doneMark = n.done ? ' ✅' : n.difficulty === 'hard' ? ' ⚠️' : '';
      md += `${'#'.repeat(depth)} ${n.title}${doneMark}\n`;
      if (n.children.length > 0) {
        n.children.sort((a, b) => a.order - b.order);
        md += treeToMarkdown(n.children, depth + 1);
      }
    }
  }
  return md;
}

export default function MindMapModal({ plan, onClose, onSelectTopic }) {
  const svgRef = useRef(null);
  const mmRef = useRef(null);
  const [error, setError] = useState(null);
  const [topicIdMap, setTopicIdMap] = useState({});

  useEffect(() => {
    if (!plan || !svgRef.current) return;
    renderMindMap();
  }, [plan?.id]);

  const renderMindMap = async () => {
    setError(null);
    try {
      // Build topic ID map from tree nodes
      const idMap = {};
      function collectIds(nodes) {
        for (const n of nodes) {
          if (n.id) idMap[n.title] = n.id;
          if (n.children) collectIds(n.children);
        }
      }
      const tree = buildTree(plan);
      collectIds(tree);
      setTopicIdMap(idMap);

      // Convert tree to Markdown
      const md = treeToMarkdown(tree);
      if (!md.trim()) {
        setError('暂无知识点数据');
        return;
      }

      // Dynamically import markmap
      const { Transformer } = await import('markmap-lib');
      const { Markmap } = await import('markmap-view');

      // Transform markdown to mind map data
      const transformer = new Transformer();
      const { root } = transformer.transform(md);

      // Get extra dataset for click handling
      // markmap doesn't natively store IDs, so we attach to node payload
      function attachIds(node, parentTitle) {
        // We'll handle via SVG click instead
        if (node.children) {
          for (const child of node.children) {
            attachIds(child, node.content);
          }
        }
      }
      attachIds(root, '');

      // Create markmap
      if (mmRef.current) {
        mmRef.current.destroy();
        mmRef.current = null;
      }

      const mm = Markmap.create(svgRef.current, {
        zoom: true,
        pan: true,
        fitView: true,
        duration: 500,
        maxWidth: 300,
        nodeMinHeight: 28,
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      }, root);

      mmRef.current = mm;

      // Attach click handlers to SVG for topic navigation
      setTimeout(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const textEls = svg.querySelectorAll('text');
        for (const el of textEls) {
          el.style.cursor = 'pointer';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const title = el.textContent
              .replace(/ ✅$/, '')
              .replace(/ ⚠️$/, '')
              .trim();
            const tid = idMap[title];
            if (tid && onSelectTopic) {
              onSelectTopic(tid);
              onClose();
            }
          });
        }
      }, 300);

    } catch (err) {
      setError('思维导图渲染失败: ' + err.message);
    }
  };

  const handleExportXMind = async () => {
    // XMind 2024 supports Markdown import directly
    const md = treeToMarkdown(buildTree(plan));
    const markdown = `# ${plan.name}\n${md}`;
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${plan.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="kg-modal-overlay" onClick={onClose}>
      <div className="kg-modal kg-modal-wide" onClick={e => e.stopPropagation()}>
        <div className="kg-modal-header">
          <span>🧠 思维导图 — {plan.name}</span>
          <div className="kg-modal-actions">
            <button className="btn-tiny" onClick={handleExportXMind} title="导出 XMind 兼容格式">📥 导出</button>
            <button className="btn-tiny" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="kg-modal-body">
          {error ? (
            <div className="kg-error">
              <p>❌ {error}</p>
            </div>
          ) : (
            <div className="mindmap-container">
              <svg ref={svgRef} className="mindmap-svg" />
            </div>
          )}
        </div>
        <div className="kg-modal-footer">
          <span className="kg-legend">
            <span className="kg-legend-item">点击节点跳转到知识点</span>
            <span className="kg-legend-sep">|</span>
            <span className="kg-legend-item">滚轮缩放</span>
            <span className="kg-legend-sep">|</span>
            <span className="kg-legend-item">拖拽平移</span>
            <span className="kg-legend-sep">|</span>
            <span className="kg-legend-item">✅ 已学完</span>
            <span className="kg-legend-sep">|</span>
            <span className="kg-legend-item">⚠️ 困难</span>
          </span>
        </div>
      </div>
    </div>
  );
}
