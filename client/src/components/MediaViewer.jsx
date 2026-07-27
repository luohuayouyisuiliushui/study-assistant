import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  FlipHorizontal2,
  FlipVertical2,
  Maximize2,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '#/components/ui/button';
import { cn } from '#/lib/utils';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function sanitizeFilename(value, fallback = 'image') {
  const sanitized = String(value || fallback)
    .replace(/[/\\?%*:|"<>]/g, '_')
    .trim();
  return sanitized || fallback;
}

function extensionFromSource(src) {
  try {
    const pathname = new URL(src, window.location.href).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match?.[1]?.toLowerCase() || 'png';
  } catch {
    return 'png';
  }
}

function getSvgAspectRatio(svg) {
  const viewBox = svg?.match(/\bviewBox=["']([^"']+)["']/i)?.[1];
  if (!viewBox) return 4 / 3;
  const values = viewBox.trim().split(/[\s,]+/).map(Number);
  const width = values[2];
  const height = values[3];
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 4 / 3;
}

function transformSvgForDownload(svg, rotation, flipX, flipY) {
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  if (normalizedRotation === 0 && !flipX && !flipY) return svg;

  const container = document.createElement('div');
  container.innerHTML = svg;
  const root = container.querySelector('svg');
  if (!root) throw new Error('无法处理当前 SVG 图片');
  const values = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some(value => !Number.isFinite(value))) {
    throw new Error('SVG 缺少有效的 viewBox');
  }

  const [minX, minY, width, height] = values;
  const swapsDimensions = normalizedRotation === 90 || normalizedRotation === 270;
  const outputWidth = swapsDimensions ? height : width;
  const outputHeight = swapsDimensions ? width : height;
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  while (root.firstChild) group.appendChild(root.firstChild);
  group.setAttribute(
    'transform',
    `translate(${outputWidth / 2} ${outputHeight / 2}) rotate(${normalizedRotation}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1}) translate(${-minX - width / 2} ${-minY - height / 2})`
  );
  root.appendChild(group);
  root.setAttribute('viewBox', `0 0 ${outputWidth} ${outputHeight}`);
  root.setAttribute('width', String(outputWidth));
  root.setAttribute('height', String(outputHeight));
  root.removeAttribute('style');
  return new XMLSerializer().serializeToString(root);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('无法生成编辑后的图片'));
    }, 'image/png');
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = url;
  });
}

async function exportRasterImage(src, rotation, flipX, flipY) {
  const response = await fetch(src);
  if (!response.ok) throw new Error('图片下载失败');
  const originalBlob = await response.blob();
  const hasEdits = rotation % 360 !== 0 || flipX || flipY;
  if (!hasEdits) return { blob: originalBlob, extension: extensionFromSource(src) };

  const objectUrl = URL.createObjectURL(originalBlob);
  try {
    const image = await loadImage(objectUrl);
    const normalizedRotation = ((rotation % 360) + 360) % 360;
    const swapsDimensions = normalizedRotation === 90 || normalizedRotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swapsDimensions ? image.naturalHeight : image.naturalWidth;
    canvas.height = swapsDimensions ? image.naturalWidth : image.naturalHeight;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持图片编辑导出');
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((normalizedRotation * Math.PI) / 180);
    context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    context.drawImage(
      image,
      -image.naturalWidth / 2,
      -image.naturalHeight / 2,
      image.naturalWidth,
      image.naturalHeight
    );
    return { blob: await canvasToBlob(canvas), extension: 'png' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function ViewerTool({ label, children, active = false, className, ...props }) {
  return (
    <button
      type='button'
      className={cn('media-viewer-tool', active && 'is-active', className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export default function MediaViewer({
  children,
  src,
  svg,
  alt = '图片',
  filename = 'image',
  editableSource,
  renderSource,
  triggerClassName,
}) {
  const triggerRef = useRef(null);
  const dialogRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState(false);
  const [draftSource, setDraftSource] = useState(editableSource || '');
  const [currentSvg, setCurrentSvg] = useState(svg || '');
  const [renderingEdit, setRenderingEdit] = useState(false);
  const [message, setMessage] = useState('');
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const resetTransform = useCallback(() => {
    setZoom(1);
    setRotation(0);
    setFlipX(false);
    setFlipY(false);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleOpen = () => {
    setDraftSource(editableSource || '');
    setCurrentSvg(svg || '');
    setEditing(false);
    setMessage('');
    resetTransform();
    setOpen(true);
  };

  const handleClose = useCallback(() => {
    setOpen(false);
    setEditing(false);
    dragRef.current = null;
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const appRoot = document.getElementById('root');
    const previousInert = appRoot?.inert;
    document.body.style.overflow = 'hidden';
    if (appRoot) appRoot.inert = true;
    dialogRef.current?.focus({ preventScroll: true });

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') handleClose();
      if (event.key === '+' || event.key === '=') setZoom(value => clampZoom(value + ZOOM_STEP));
      if (event.key === '-') setZoom(value => clampZoom(value - ZOOM_STEP));
      if (event.key === '0') resetTransform();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (appRoot) appRoot.inert = previousInert;
    };
  }, [handleClose, open, resetTransform]);

  useLayoutEffect(() => {
    if (!open || !stageRef.current) return undefined;
    const stage = stageRef.current;
    const updateSize = () => {
      const bounds = stage.getBoundingClientRect();
      setStageSize({ width: bounds.width, height: bounds.height });
    };
    updateSize();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateSize);
      observer.observe(stage);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [open]);

  const handleWheel = (event) => {
    event.preventDefault();
    setZoom(value => clampZoom(value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan };
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: drag.pan.x + event.clientX - drag.x,
      y: drag.pan.y + event.clientY - drag.y,
    });
  };

  const handlePointerUp = (event) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleApplySource = async () => {
    if (!renderSource || !draftSource.trim()) return;
    setRenderingEdit(true);
    setMessage('');
    try {
      const nextSvg = await renderSource(draftSource);
      setCurrentSvg(nextSvg);
      resetTransform();
    } catch (error) {
      setMessage(error.message || String(error));
    } finally {
      setRenderingEdit(false);
    }
  };

  const handleResetSource = () => {
    setDraftSource(editableSource || '');
    setCurrentSvg(svg || '');
    setMessage('');
    resetTransform();
  };

  const handleDownload = async () => {
    setMessage('');
    try {
      const baseFilename = sanitizeFilename(filename, alt);
      if (currentSvg) {
        const exportedSvg = transformSvgForDownload(currentSvg, rotation, flipX, flipY);
        downloadBlob(new Blob([exportedSvg], { type: 'image/svg+xml;charset=utf-8' }), `${baseFilename}.svg`);
        return;
      }
      if (!src) return;
      const exported = await exportRasterImage(src, rotation, flipX, flipY);
      downloadBlob(exported.blob, `${baseFilename}.${exported.extension}`);
    } catch (error) {
      setMessage(error.message || String(error));
    }
  };

  const svgAspectRatio = getSvgAspectRatio(currentSvg);
  const availableWidth = Math.max(0, stageSize.width - 40);
  const availableHeight = Math.max(0, stageSize.height - 40);
  const svgWidth = Math.min(availableWidth, availableHeight * svgAspectRatio);
  const svgHeight = svgWidth > 0 ? svgWidth / svgAspectRatio : 0;
  const transformedStyle = {
    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom}) rotate(${rotation}deg) scaleX(${flipX ? -1 : 1}) scaleY(${flipY ? -1 : 1})`,
    ...(currentSvg && svgWidth > 0 ? { width: svgWidth, height: svgHeight } : {}),
  };

  return (
    <>
      <button
        ref={triggerRef}
        type='button'
        className={cn('media-viewer-trigger', triggerClassName)}
        onClick={handleOpen}
        aria-label={`全屏查看：${alt}`}
      >
        {children}
        <span className='media-viewer-trigger-icon' aria-hidden='true'><Maximize2 /></span>
      </button>

      {open && createPortal(
        <div
          ref={dialogRef}
          className='media-viewer'
          role='dialog'
          aria-modal='true'
          aria-label={`${alt} 全屏预览`}
          tabIndex='-1'
        >
          <header className='media-viewer-header'>
            <div className='media-viewer-title' title={alt}>{alt}</div>
            <div className='media-viewer-header-actions'>
              <div className='media-viewer-toolbar'>
                <ViewerTool label='缩小' onClick={() => setZoom(value => clampZoom(value - ZOOM_STEP))} disabled={zoom <= MIN_ZOOM}>
                  <ZoomOut />
                </ViewerTool>
                <span className='media-viewer-zoom' aria-label={`当前缩放 ${Math.round(zoom * 100)}%`}>{Math.round(zoom * 100)}%</span>
                <ViewerTool label='放大' onClick={() => setZoom(value => clampZoom(value + ZOOM_STEP))} disabled={zoom >= MAX_ZOOM}>
                  <ZoomIn />
                </ViewerTool>
                <ViewerTool label='还原视图' onClick={resetTransform}><Maximize2 /></ViewerTool>
                {editableSource && renderSource && (
                  <ViewerTool label='编辑图表源码' onClick={() => setEditing(value => !value)} active={editing}><Pencil /></ViewerTool>
                )}
                <ViewerTool label='保存图片' onClick={handleDownload}><Download /></ViewerTool>
                <span className='media-viewer-divider' />
                <ViewerTool label='向左旋转' onClick={() => setRotation(value => value - 90)}><RotateCcw /></ViewerTool>
                <ViewerTool label='向右旋转' onClick={() => setRotation(value => value + 90)}><RotateCw /></ViewerTool>
                <ViewerTool label='水平翻转' onClick={() => setFlipX(value => !value)} active={flipX}><FlipHorizontal2 /></ViewerTool>
                <ViewerTool label='垂直翻转' onClick={() => setFlipY(value => !value)} active={flipY}><FlipVertical2 /></ViewerTool>
              </div>
              <ViewerTool className='media-viewer-close' label='关闭' onClick={handleClose}><X /></ViewerTool>
            </div>
          </header>

          <div className={cn('media-viewer-body', editing && 'is-editing')}>
            <div
              ref={stageRef}
              className='media-viewer-stage'
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onDoubleClick={resetTransform}
            >
              <div className={cn('media-viewer-canvas', currentSvg && 'is-svg')} style={transformedStyle}>
                {currentSvg ? (
                  <div className='media-viewer-svg' dangerouslySetInnerHTML={{ __html: currentSvg }} />
                ) : (
                  <img src={src} alt={alt} draggable='false' />
                )}
              </div>
            </div>

            {editing && (
              <aside className='media-viewer-editor'>
                <div className='media-viewer-editor-header'>
                  <strong>编辑图表</strong>
                  <div>
                    <Button variant='ghost' size='icon' onClick={handleResetSource} title='还原源码' aria-label='还原源码'>
                      <Undo2 className='h-4 w-4' />
                    </Button>
                    <Button className='gap-1.5' size='sm' onClick={handleApplySource} disabled={renderingEdit || !draftSource.trim()}>
                      {renderingEdit ? <RotateCw className='h-4 w-4 animate-spin' /> : <Play className='h-4 w-4' />}
                      应用
                    </Button>
                  </div>
                </div>
                <textarea
                  value={draftSource}
                  onChange={event => setDraftSource(event.target.value)}
                  aria-label='Mermaid 源代码'
                  spellCheck='false'
                />
              </aside>
            )}
          </div>
          {message && <div className='media-viewer-message' role='alert'>{message}</div>}
        </div>,
        document.body
      )}
    </>
  );
}
