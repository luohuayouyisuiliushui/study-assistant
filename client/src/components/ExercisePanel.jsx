import { Button } from '#/components/ui/button';
import { RotateCcw, SendHorizonal } from 'lucide-react';

export default function ExercisePanel({
  exercises, answers, onAnswer, onSubmit, loading, submitted, results,
}) {
  if (exercises.length === 0) return null;

  if (submitted && results) {
    return (
      <div className='pt-4 space-y-3'>
        <h3 className='text-sm font-medium'>练习结果</h3>
        {results.map((res, i) => (
          <div key={i} className={`border rounded-md p-3 text-sm ${res.correct ? 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30' : 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30'}`}>
            <div className='flex items-center gap-1.5 mb-1'>
              <span>{res.correct ? '✅' : '❌'}</span>
              <span className='font-medium'>练习题 {i + 1}</span>
            </div>
            {res.explanation && <p className='text-muted-foreground'>{res.explanation}</p>}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className='pt-4 space-y-6'>
      <h3 className='text-sm font-medium'>练习题</h3>
      {exercises.map((ex, i) => (
        <div key={i} className='rounded-md bg-muted/20 p-4 space-y-3'>
          <div className='flex items-center gap-1.5 text-xs'>
            <span className='font-medium'>练习题 {i + 1}</span>
            <span className={`px-1.5 py-0.5 rounded ${ex.type === 'choice' ? 'bg-primary/10 text-primary' : 'bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300'}`}>{ex.type === 'choice' ? '选择题' : '简答题'}</span>
            {ex.conceptTag && <span className='px-1.5 py-0.5 rounded bg-muted text-muted-foreground'>{ex.conceptTag}</span>}
          </div>
          <p className='text-sm'>{ex.question}</p>
          {ex.type === 'choice' && ex.options && ex.options.length > 0 ? (
            <div className='space-y-1'>
              {ex.options.map((opt, oi) => (
                <label key={oi} className={`flex items-center gap-2 px-2.5 py-1.5 rounded text-sm cursor-pointer transition-colors ${answers[i] === opt.charAt(0) ? 'bg-primary/10 border border-primary/30' : 'border border-transparent hover:bg-accent'}`}>
                  <input type='radio' name={'ex-' + i} value={opt.charAt(0)} checked={answers[i] === opt.charAt(0)} onChange={() => onAnswer(i, opt.charAt(0))} className='accent-primary' />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          ) : (
            <textarea className='w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' placeholder='输入你的答案...' value={answers[i] || ''} onChange={e => onAnswer(i, e.target.value)} rows={3} />
          )}
        </div>
      ))}
      {!submitted && (
        <Button onClick={onSubmit} disabled={loading || Object.keys(answers).length === 0}>
          {loading ? <RotateCcw className='h-4 w-4 mr-1 animate-spin' /> : <SendHorizonal className='h-4 w-4 mr-1' />}
          {loading ? '批改中...' : '提交答案'}
        </Button>
      )}
    </div>
  );
}
