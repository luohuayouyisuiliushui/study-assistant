import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import MermaidDiagram from './MermaidDiagram';

const markdownComponents = {
  p({ children }) {
    return <p className='mb-4 last:mb-0'>{children}</p>;
  },
  pre({ children }) {
    // Mermaid fenced blocks should NOT be wrapped in <pre>.
    // In react-markdown v10, pre receives the raw hast <code> element as children,
    // not our custom code component's return value — so we check className.
    if (children?.props?.className?.includes('language-mermaid')) {
      return children;
    }
    return <pre>{children}</pre>;
  },
  code({ className, children }) {
    const code = String(children).replace(/\n$/, '');
    // Mermaid fenced block
    if (className && className.includes('language-mermaid')) {
      return <MermaidDiagram code={code} />;
    }
    // Block vs inline detection.
    // react-markdown v10 removed the `inline` prop, so we can no longer rely on it.
    // A fenced code block WITHOUT a language (e.g. ``` with no lang) has no
    // className — previously this was misclassified as inline code and lost its
    // <pre> wrapper. Treat anything with a language- class OR containing a
    // newline as a block (fenced) code block.
    const isBlock = (className && className.includes('language-')) || code.includes('\n');
    if (!isBlock) {
      return <code>{children}</code>;
    }
    // Fenced code block — <pre> wrapper is provided by the pre component above
    return <code className={className}>{code}</code>;
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
