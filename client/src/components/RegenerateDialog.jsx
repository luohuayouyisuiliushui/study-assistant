import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';

const REASONS = [
  '内容太浅，需要更深入',
  '内容太深，难以理解',
  '缺少例子或代码示例',
  '结构不清晰',
  '与我的水平不匹配',
];

export default function RegenerateDialog({ open, onClose, onSubmit }) {
  const [selected, setSelected] = useState('');
  const [custom, setCustom] = useState('');

  const handleSubmit = () => {
    const reason = selected === '其他' ? (custom.trim() || '其他') : selected;
    if (!reason) return;
    onSubmit(reason);
    setSelected('');
    setCustom('');
  };

  const handleClose = () => {
    setSelected('');
    setCustom('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重新生成讲解</DialogTitle>
          <p className='text-sm text-muted-foreground'>选择不满意的原因，AI 会据此改进下次生成的内容</p>
        </DialogHeader>

        <div className='space-y-2 my-4'>
          {REASONS.map((r) => (
            <label key={r} className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer transition-colors text-sm ${selected === r ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'}`}>
              <input type='radio' name='feedback-reason' value={r} checked={selected === r} onChange={() => setSelected(r)} className='accent-primary' />
              {r}
            </label>
          ))}
          <label className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer transition-colors text-sm ${selected === '其他' ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'}`}>
            <input type='radio' name='feedback-reason' value='其他' checked={selected === '其他'} onChange={() => setSelected('其他')} className='accent-primary' />
            其他
          </label>
          {selected === '其他' && (
            <textarea
              className='w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mt-1'
              placeholder='请描述具体问题...'
              rows={2}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant='outline' size='sm' onClick={handleClose}>取消</Button>
          <Button size='sm' onClick={handleSubmit} disabled={!selected || (selected === '其他' && !custom.trim())}>重新生成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
