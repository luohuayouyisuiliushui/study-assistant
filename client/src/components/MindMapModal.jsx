import { useState, useEffect, useRef } from 'react';
import { X, Download, Brain } from 'lucide-react';
import { Button } from '#/components/ui/button';

function buildTree(plan) {
  const phaseMap = {};
  for (const p of plan.phases || []) {
    phaseMap[p.id] = { id: p.id, name: p.name, order: p.order || 0, children: [] };
  }

  const topicMap = {};
  for (const t of plan.topics) {
    topicMap[t.id] = { ...t, children: [] };
  }

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

  for (const phaseId of Object.keys(phaseMap)) {
    const phase = phaseMap[phaseId];
    phase.children.sort((a, b) => a.order - b.order);
    roots.push(phase);
  }

  roots.sort((a, b) => (a.order || 0) - (b.order || 0));
  return roots;
}

function treeToMarkdown(nodes, depth = 1) {
  let md = '';
  for (const n of nodes) {
    if (n.name !== undefined) {
      const done = n.children.every(c => c.done);
      md += `${'#'.repeat(depth)} ${n.name}${done ? ' ✅' : ''}\n`;
      if (n.children.length > 0) {
        n.children.sort((a, b) => a.order - b.order);
        md += treeToMarkdown(n.children, depth + 1);
      }
    } else {
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

  useEffect(() => {
    if (!plan || !svgRef.current) return;
    renderMindMap();
  }, [plan?.id]);

  const renderMindMap = async () => {
    setError(null);
    try {
      const idMap = {};
      function collectIds(nodes) {
        for (const n of nodes) {
          if (n.id) idMap[n.title] = n.id;
          if (n.children) collectIds(n.children);
        }
      }
      const tree = buildTree(plan);
      collectIds(tree);

      const md = treeToMarkdown(tree);
      if (!md.trim()) {
        setError('暂无知识点数据');
        return;
      }

      const { Transformer } = await import('markmap-lib');
      const { Markmap } = await import('markmap-view');

      const transformer = new Transformer();
      const { root } = transformer.transform(md);

      function attachIds(node) {
        if (node.children) {
          for (const child of node.children) {
            attachIds(child);
          }
        }
      }
      attachIds(root);

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
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={onClose}>
      <div className='flex flex-col w-[90vw] h-[85vh] max-w-6xl rounded-lg border bg-card shadow-lg' onClick={e => e.stopPropagation()}>
        <div className='flex items-center justify-between border-b px-4 py-2.5'>
          <span className='flex items-center gap-2 text-sm font-medium'>
            <Brain className='h-4 w-4 text-primary' />
            思维导图 — {plan.name}
          </span>
          <div className='flex items-center gap-1'>
            <Button variant='ghost' size='sm' onClick={handleExportXMind} title='导出 XMind 兼容格式'>
              <Download className='h-3.5 w-3.5 mr-1' />导出
            </Button>
            <Button variant='ghost' size='icon' onClick={onClose}><X className='h-4 w-4' /></Button>
          </div>
        </div>
        <div className='flex-1 overflow-auto p-4'>
          {error ? (
            <div className='flex flex-col items-center justify-center h-full text-muted-foreground gap-2'>
              <p className='text-sm text-destructive'>{error}</p>
            </div>
          ) : (
            <div className='w-full h-full'>
              <svg ref={svgRef} className='w-full h-full' />
            </div>
          )}
        </div>
        <div className='flex items-center gap-3 border-t px-4 py-1.5 text-xs text-muted-foreground'>
          <span>点击节点跳转到知识点</span>
          <span className='text-border'>|</span>
          <span>滚轮缩放</span>
          <span className='text-border'>|</span>
          <span>拖拽平移</span>
          <span className='text-border'>|</span>
          <span>✅ 已学完</span>
          <span className='text-border'>|</span>
          <span>⚠️ 困难</span>
        </div>
      </div>
    </div>
  );
}
