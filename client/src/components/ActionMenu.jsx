import { Search, BarChart3 } from 'lucide-react';

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
}) {
  return (
    <div className='absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-md border bg-popover p-1 shadow-md'>
      {showExport && (
        <>
          <div className='px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border mb-1'>导出</div>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onExport}>Markdown (.md)</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onExportHtml}>HTML (.html)</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => onExportFormat('anki')}>Anki CSV (.csv)</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => onExportFormat('opml')}>OPML 大纲 (.opml)</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => onExportFormat('json')}>结构化 JSON</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => onExportFormat('notes')}>学习笔记 (.md)</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => onExportFormat('bundle')}>计划数据包 (JSON)</button>
        </>
      )}

      {showTeaching && (
        <>
          <div className='px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border mt-2 mb-1'>教学模式</div>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => { onStartInteractive('stepwise'); }}>分段讲解</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => { onStartInteractive('realtime'); }}>实时互动</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => { onStartInteractive('feynman'); }}>费曼学习法</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => { onStartInteractive('challenge'); }}>挑战模式</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => { onStartInteractive('stepwise-challenge'); }}>分段挑战</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => { onStartInteractive('realtime-challenge'); }}>实时挑战</button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={() => { onStartInteractive('scaffold'); }}>支架教学</button>
        </>
      )}

      {showAnalysis && (
        <>
          <div className='px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border mt-2 mb-1'>分析工具</div>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onFactCheck} disabled={factCheckLoading}>
            <Search className='h-3.5 w-3.5' />事实核查
          </button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onAdaptiveAnalysis} disabled={adaptiveLoading}>
            <BarChart3 className='h-3.5 w-3.5' />自适应分析
          </button>
          <button className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors' onClick={onRecommendResources} disabled={resourcesLoading}>
            <Lightbulb className='h-3.5 w-3.5' />推荐学习资源
          </button>
        </>
      )}
    </div>
  );
}
