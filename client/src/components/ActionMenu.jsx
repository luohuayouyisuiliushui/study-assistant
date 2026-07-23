import { useEffect, useRef } from 'react';
import { Search, BarChart3, Lightbulb } from 'lucide-react';

/**
 * Reusable action menu for TopicDetail.
 * Renders three groups: Export, Teaching Modes, Analysis Tools.
 * Visibility of each group is controlled by the caller via props.
 */
export default function ActionMenu({
  onStartInteractive,
  onExport,
  onExportHtml,
  onExportFormat,
  onFactCheck,
  onAdaptiveAnalysis,
  onRecommendResources,
  factCheckLoading,
  adaptiveLoading,
  resourcesLoading,
  showExport,
  showTeaching,
  showAnalysis,
  onClose,
  id,
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, []);

  const handleKeyDown = (event) => {
    const items = [...menuRef.current?.querySelectorAll('[role="menuitem"]') || []];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + direction + items.length) % items.length]?.focus();
    }
  };

  return (
    <div ref={menuRef} id={id} role='menu' aria-label='更多学习操作' onKeyDown={handleKeyDown} className='absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-md border bg-popover p-1 shadow-md'>
      {showExport && (
        <>
          <div className='px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border mb-1'>导出</div>
          <button type='button' role='menuitem' className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors' onClick={onExport}>
            <span className='text-xs'>Markdown (.md)</span>
            <span className='text-[10px] text-muted-foreground'>通用文档格式，可在 Obsidian/Notion 中打开</span>
          </button>
          <button type='button' role='menuitem' className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors' onClick={onExportHtml}>
            <span className='text-xs'>HTML (.html)</span>
            <span className='text-[10px] text-muted-foreground'>离线单文件网页，含公式渲染与代码高亮</span>
          </button>
          <button type='button' role='menuitem' className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors' onClick={() => onExportFormat('anki')}>
            <span className='text-xs'>Anki CSV (.csv)</span>
            <span className='text-[10px] text-muted-foreground'>导入 Anki 制作闪卡，用间隔重复记忆</span>
          </button>
          <button type='button' role='menuitem' className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors' onClick={() => onExportFormat('opml')}>
            <span className='text-xs'>OPML 大纲 (.opml)</span>
            <span className='text-[10px] text-muted-foreground'>导入思维导图工具（OmniOutliner/WorkFlowy）</span>
          </button>
          <button type='button' role='menuitem' className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors' onClick={() => onExportFormat('json')}>
            <span className='text-xs'>结构化 JSON</span>
            <span className='text-[10px] text-muted-foreground'>含题目与答案，适合二次开发或数据分析</span>
          </button>
          <button type='button' role='menuitem' className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors' onClick={() => onExportFormat('notes')}>
            <span className='text-xs'>学习笔记 (.md)</span>
            <span className='text-[10px] text-muted-foreground'>精炼版学习摘要，去除练习题的纯笔记</span>
          </button>
          <button type='button' role='menuitem' className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors' onClick={() => onExportFormat('bundle')}>
            <span className='text-xs'>计划数据包 (JSON)</span>
            <span className='text-[10px] text-muted-foreground'>完整计划元数据，可通过导入功能恢复结构</span>
          </button>
        </>
      )}

      {showTeaching && (
        <>
          <div className='px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border mt-2 mb-1'>教学模式</div>
          {[
            { mode: 'stepwise',           label: '分段讲解',   hint: 'AI 逐段讲解，每段后等你确认再继续' },
            { mode: 'realtime',           label: '实时互动',   hint: 'AI 实时响应，随时打断追问' },
            { mode: 'feynman',            label: '费曼学习法', hint: '👉 你来讲，AI 追问薄弱点（需主动开口）' },
            { mode: 'scaffold',           label: '支架教学',   hint: '👉 逐个回答递进子问题，逐步拆解难点' },
            { mode: 'challenge',          label: '挑战模式',   hint: 'AI 故意混入错误，看你能否发现' },
            { mode: 'stepwise-challenge', label: '分段挑战',   hint: '分段讲解 + 嵌入错误，批判性阅读训练' },
            { mode: 'realtime-challenge', label: '实时挑战',   hint: '实时对话 + 嵌入错误，保持警觉' },
          ].map(({ mode, label, hint }) => (
            <button
              type='button'
              role='menuitem'
              key={mode}
              className='flex w-full flex-col items-start rounded-sm px-2 py-1.5 hover:bg-accent transition-colors'
              onClick={() => { onStartInteractive(mode); }}
            >
              <span className='text-xs font-medium leading-tight'>{label}</span>
              <span className='text-[10px] text-muted-foreground leading-tight mt-0.5'>{hint}</span>
            </button>
          ))}
        </>
      )}

      {showAnalysis && (
        <>
          <div className='px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border mt-2 mb-1'>分析工具</div>
          <button type='button' role='menuitem' className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onFactCheck} disabled={factCheckLoading}>
            <Search className='h-3.5 w-3.5' />事实核查
          </button>
          <button type='button' role='menuitem' className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onAdaptiveAnalysis} disabled={adaptiveLoading}>
            <BarChart3 className='h-3.5 w-3.5' />自适应分析
          </button>
          <button type='button' role='menuitem' className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onRecommendResources} disabled={resourcesLoading}>
            <Lightbulb className='h-3.5 w-3.5' />推荐学习资源
          </button>
        </>
      )}
    </div>
  );
}
