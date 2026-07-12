import { useState, useRef, useEffect } from 'react';
import { Button } from '#/components/ui/button';
import { SendHorizonal } from 'lucide-react';
import { QaMessages } from './TopicDetailShared.jsx';

export default function QAPanel({ qaList, onAsk, loading, scrollToRound, setHoveredRound, hoveredRound }) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  const handleSubmit = () => {
    const q = input.trim();
    if (!q || loading) return;
    onAsk(q);
    setInput('');
  };

  return (
    <div className='rounded-lg bg-muted/20'>
      <div className='flex items-center justify-between px-4 py-3'>
        <h2 className='text-sm font-medium'>扩展讨论</h2>
        {qaList.length > 0 && <span className='text-xs text-muted-foreground'>{qaList.length} 轮</span>}
      </div>
      {qaList.length >= 2 && (
        <div className='flex gap-1.5 px-4 py-2 overflow-x-auto'>
          {qaList.map((qa, i) => (
            <div key={i} className='relative'>
              <button className='text-xs w-6 h-6 rounded-full bg-muted hover:bg-accent transition-colors' onClick={() => scrollToRound(i)} onMouseEnter={() => setHoveredRound(i)} onMouseLeave={() => setHoveredRound(null)} title={qa.question}>
                {i + 1}
              </button>
              {hoveredRound === i && (
                <div className='absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-48 p-2 rounded-md border bg-popover text-xs shadow-md z-10'>
                  <div className='font-medium mb-0.5'>追问 {i + 1}</div>
                  <div className='text-muted-foreground truncate'>{qa.question}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className='max-h-80 overflow-y-auto p-4 mx-auto max-w-4xl'>
        <QaMessages qaList={qaList} />
      </div>
      <div className='p-4'>
        <form onSubmit={e => { e.preventDefault(); handleSubmit(); }} className='flex gap-2'>
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }} placeholder='输入你的追问...（Shift+Enter 换行，Enter 发送）' disabled={loading} rows={1} onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }} className='flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none' />
          <Button type='button' onClick={handleSubmit} disabled={!input.trim() || loading} size='icon'>
            {loading ? <div className='animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent' /> : <SendHorizonal className='h-4 w-4' />}
          </Button>
        </form>
      </div>
    </div>
  );
}
