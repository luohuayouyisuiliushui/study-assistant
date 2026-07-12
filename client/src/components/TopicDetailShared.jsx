import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import MermaidDiagram from './MermaidDiagram';

const markdownComponents = {
  p({ children, ...props }) {
    return <p className='mb-4 last:mb-0' {...props}>{children}</p>;
  },
  code({ className, children, ...props }) {
    const isInline = !props?.node?.properties?.className && !className;
    const code = String(children).replace(/\n$/, '');
    if (className && className.includes('language-mermaid') && !isInline) {
      return <MermaidDiagram code={code} />;
    }
    if (isInline) return <code {...props}>{children}</code>;
    return <pre {...props}><code className={className}>{children}</code></pre>;
  },
};

const ContentArea = memo(function ContentArea({ content }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>{content}</ReactMarkdown>;
});

const QaMessages = memo(function QaMessages({ qaList }) {
  return qaList.length === 0 ? (
    <div className='text-center text-sm text-muted-foreground py-8'>暂无追问，在下方输入问题开始讨论</div>
  ) : (
    qaList.map((qa, i) => (
      <div key={i} className='mb-8 last:mb-0' data-round={i}>
        <div className='flex justify-end mb-3'>
          <div className='max-w-[75%] rounded-lg bg-primary/10 px-4 py-3 text-sm'>{qa.question}</div>
        </div>
        <div className='flex gap-2'>
          <span className='text-lg shrink-0 mt-1'>🤖</span>
          <div className='max-w-[75%] rounded-lg bg-muted px-4 py-3 text-sm leading-relaxed'>
            {qa.answer === '...' ? (
              <span className='text-muted-foreground animate-pulse'>思考中...</span>
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>{qa.answer}</ReactMarkdown>
            )}
          </div>
        </div>
      </div>
    ))
  );
});

export { markdownComponents, ContentArea, QaMessages };
