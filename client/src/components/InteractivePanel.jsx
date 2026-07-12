import { useRef } from 'react';
import { Button } from '#/components/ui/button';
import { RotateCcw, CheckCheck, MessageSquare, SendHorizonal, Mic } from 'lucide-react';
import { ContentArea } from './TopicDetailShared.jsx';

const MODE_LABELS = {
  stepwise: '分段讲解',
  'stepwise-challenge': '分段挑战',
  feynman: '费曼学习法',
  challenge: '挑战模式',
  scaffold: '支架教学',
  'realtime-challenge': '实时挑战',
  realtime: '实时互动',
};

export default function InteractivePanel({
  interactiveMode, interactiveSections, streamingContent,
  interactiveLoading, interactiveFinished, interactiveInput,
  interactiveStateMachine, isRecording, voiceSupported,
  onInputChange, onQuickAction, onSendFeedback, onVoiceInput,
  onExit, onRegenerate,
}) {
  const interactiveInputRef = useRef(null);

  return (
    <div className='space-y-5'>
      <div className='flex items-center gap-2 text-sm'>
        <span className='inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-xs font-medium'>
          {MODE_LABELS[interactiveMode] || interactiveMode}
        </span>
        {interactiveLoading && <span className='text-xs text-muted-foreground animate-pulse'>导师正在思考...</span>}
        {interactiveFinished && <span className='text-xs text-green-600'>讲解完成</span>}
        {!interactiveLoading && interactiveSections.length > 0 && (
          <Button variant='ghost' size='sm' className='text-xs h-6 px-2' onClick={onRegenerate} title='反馈问题并重新开始'>
            <RotateCcw className='h-3 w-3 mr-1' />重新开始
          </Button>
        )}
      </div>

      {(interactiveMode === 'stepwise' || interactiveMode === 'stepwise-challenge') && interactiveStateMachine && (
        <div className='text-xs text-muted-foreground'>
          {interactiveStateMachine.completedSteps > 0 ? `已完成 ${interactiveStateMachine.completedSteps} 部分` : '第 1 部分'}
        </div>
      )}

      <div className='space-y-3'>
        {interactiveSections.map((section, i) => (
          <div key={i} className='rounded-md bg-muted/20 p-4'>
            <div className='text-xs text-muted-foreground mb-2'>第 {i + 1} 部分</div>
            <ContentArea content={section.content} />
          </div>
        ))}
      </div>

      {streamingContent && (
        <div className='border rounded-md p-4 border-dashed'>
          <div className='text-xs text-muted-foreground mb-2'>正在生成...</div>
          <ContentArea content={streamingContent} />
        </div>
      )}

      {interactiveLoading && (
        <div className='flex items-center gap-2 text-sm text-muted-foreground'>
          <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' />
          <span>{streamingContent ? '正在生成内容...' : '导师正在思考...'}</span>
        </div>
      )}

      {!interactiveLoading && !interactiveFinished && interactiveSections.length > 0 && (
        <div className='space-y-3'>
          {interactiveMode === 'feynman' ? (
            <>
              <p className='text-sm text-muted-foreground'>请用你自己的话讲解这段内容</p>
              <div className='flex flex-wrap gap-1.5'>
                {['我继续讲', '这样对吗？', '换个角度', '我讲完了'].map((text, i) => {
                  const actions = ['我继续讲解下面部分', '这样理解对吗？请指出我的问题', '我换个角度来解释', '这部分我讲完了，你觉得还有什么疑问？'];
                  return <Button key={i} variant='outline' size='sm' onClick={() => onQuickAction(actions[i])}>{text}</Button>;
                })}
              </div>
              <div className='flex gap-2'>
                <textarea ref={interactiveInputRef} value={interactiveInput} onChange={e => onInputChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendFeedback(); } }} placeholder='输入你的讲解或回答...（Enter 发送）' rows={2} className='flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' />
                {voiceSupported && (
                  <Button variant='outline' size='icon' onClick={onVoiceInput} disabled={interactiveLoading} title={isRecording ? '点击停止录音' : '语音输入'} className={isRecording ? 'bg-red-100 dark:bg-red-900 text-red-600' : ''}>
                    <Mic className='h-4 w-4' />
                  </Button>
                )}
                <Button onClick={onSendFeedback} disabled={!interactiveInput.trim()}>
                  <SendHorizonal className='h-4 w-4' />
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className='text-sm text-muted-foreground'>你的回应是什么？</p>
              <div className='flex flex-wrap gap-1.5'>
                {['继续', '不太懂', '举例', '关联'].map((text, i) => {
                  const actions = ['继续', '不太懂，详细解释', '给我举个例子', '和前面讲的有什么关系？'];
                  return <Button key={i} variant='outline' size='sm' onClick={() => onQuickAction(actions[i])}>{text}</Button>;
                })}
                {interactiveMode === 'realtime' && (
                  <Button variant='outline' size='sm' onClick={() => onQuickAction('换个角度解释')}>换角度</Button>
                )}
              </div>
              <div className='flex gap-2'>
                <textarea ref={interactiveInputRef} value={interactiveInput} onChange={e => onInputChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendFeedback(); } }} placeholder='输入你的问题或反馈...（Enter 发送）' rows={2} className='flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' />
                {voiceSupported && (
                  <Button variant='outline' size='icon' onClick={onVoiceInput} disabled={interactiveLoading} title={isRecording ? '点击停止录音' : '语音输入'} className={isRecording ? 'bg-red-100 dark:bg-red-900 text-red-600' : ''}>
                    <Mic className='h-4 w-4' />
                  </Button>
                )}
                <Button onClick={onSendFeedback} disabled={!interactiveInput.trim()}>
                  <SendHorizonal className='h-4 w-4' />
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {interactiveFinished && (
        <div className='text-center py-4 space-y-2'>
          <p className='text-sm text-muted-foreground'>
            {interactiveMode === 'feynman' ? '费曼练习已完成！AI 正在分析你的讲解...' : '互动讲解已完成！你可以继续提问或退出互动模式。'}
          </p>
          <div className='flex justify-center gap-2'>
            <Button variant='outline' size='sm' onClick={() => onQuickAction('我还有问题想问')}><MessageSquare className='h-3.5 w-3.5 mr-1' />继续提问</Button>
            <Button size='sm' onClick={onExit}><CheckCheck className='h-3.5 w-3.5 mr-1' />结束互动</Button>
          </div>
        </div>
      )}
    </div>
  );
}
