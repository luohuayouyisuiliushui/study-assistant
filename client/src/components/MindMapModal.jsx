import { useState, useEffect, useRef } from 'react';
import { X, Download, Brain, Maximize2 } from 'lucide-react';
import { Button } from '#/components/ui/button';
import { buildTree, treeToJson, treeToMarkdown, treeToOpml } from '#/lib/mind-map-export';

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
}

function serializeSvg(svgElement) {
  const clone = svgElement.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const viewBox = clone.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      clone.setAttribute('width', String(parts[2]));
      clone.setAttribute('height', String(parts[3]));
    }
  } else {
    const bounds = svgElement.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || svgElement.clientWidth || 1600));
    const height = Math.max(1, Math.round(bounds.height || svgElement.clientHeight || 900));
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
  }
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute('fill', 'white');
  clone.insertBefore(background, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

export default function MindMapModal({ plan, onClose, onSelectTopic }) {
  const svgRef = useRef(null);
  const mmRef = useRef(null);
  const [error, setError] = useState(null);
  const [exportFormat, setExportFormat] = useState('markdown');

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
          if (n.id && n.title) idMap[n.title] = n.id;
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

  const downloadBlob = (blob, extension) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(plan.name)}.思维导图.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPng = () => {
    if (!svgRef.current) return;
    const svgData = serializeSvg(svgRef.current);
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgData)}`;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const width = image.naturalWidth || image.width || 1600;
      const height = image.naturalHeight || image.height || 900;
      const scale = 2;
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.scale(scale, scale);
      context.fillStyle = 'white';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (blob) downloadBlob(blob, 'png');
      }, 'image/png');
    };
    image.onerror = () => setError('PNG 导出失败，请改用 SVG 格式');
    image.src = dataUrl;
  };

  const handleExport = () => {
    const tree = buildTree(plan);
    if (exportFormat === 'markdown') {
      const markdown = `# ${plan.name}\n\n${treeToMarkdown(tree)}`;
      downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), 'md');
      return;
    }
    if (exportFormat === 'json') {
      downloadBlob(new Blob([JSON.stringify({ name: plan.name, tree: treeToJson(tree) }, null, 2)], { type: 'application/json;charset=utf-8' }), 'json');
      return;
    }
    if (exportFormat === 'opml') {
      downloadBlob(new Blob([treeToOpml(plan.name, tree)], { type: 'text/x-opml;charset=utf-8' }), 'opml');
      return;
    }
    if (exportFormat === 'svg') {
      if (!svgRef.current) return;
      downloadBlob(new Blob([serializeSvg(svgRef.current)], { type: 'image/svg+xml;charset=utf-8' }), 'svg');
      return;
    }
    if (exportFormat === 'png') handleExportPng();
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={onClose}>
      <div role='dialog' aria-modal='true' aria-labelledby='mind-map-title' className='flex flex-col w-[calc(100vw-1rem)] h-[calc(100vh-1rem)] sm:w-[calc(100vw-2rem)] sm:h-[calc(100vh-2rem)] max-w-none rounded-lg border bg-card shadow-lg' onClick={e => e.stopPropagation()}>
        <div className='flex items-center justify-between border-b px-4 py-2.5'>
          <span id='mind-map-title' className='flex min-w-0 items-center gap-2 text-sm font-medium'>
            <Brain className='h-4 w-4 text-primary' />
            <span className='truncate'>思维导图 — {plan.name}</span>
          </span>
          <div className='flex items-center gap-1'>
            <select
              aria-label='导出格式'
              value={exportFormat}
              onChange={event => setExportFormat(event.target.value)}
              className='h-8 rounded-md border bg-background px-2 text-xs'
            >
              <option value='markdown'>Markdown</option>
              <option value='svg'>SVG</option>
              <option value='png'>PNG</option>
              <option value='json'>JSON</option>
              <option value='opml'>OPML</option>
            </select>
            <Button variant='ghost' size='icon' className='h-8 w-8' onClick={handleExport} aria-label='导出思维导图' title='导出思维导图'>
              <Download className='h-4 w-4' />
            </Button>
            <Button variant='ghost' size='icon' className='h-8 w-8' onClick={() => mmRef.current?.fit?.()} aria-label='适应视图' title='适应视图'>
              <Maximize2 className='h-4 w-4' />
            </Button>
            <Button variant='ghost' size='icon' onClick={onClose} aria-label='关闭思维导图'><X className='h-4 w-4' /></Button>
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
        <div className='flex shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap border-t px-4 py-1.5 text-xs text-muted-foreground'>
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
