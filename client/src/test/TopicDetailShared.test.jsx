import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents, markdownRehypePlugins, ContentArea, QaMessages } from '../components/TopicDetailShared';

// Mock MermaidDiagram to make assertions easier
vi.mock('../components/MermaidDiagram', () => ({
  default: ({ code }) => <div data-testid='mermaid-diagram' data-code={code} />,
}));

function renderMd(content) {
  return render(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={markdownRehypePlugins}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
}

describe('markdownComponents', () => {
  it('renders fenced code block as single <pre><code class="language-c"> without leaking node attribute', () => {
    renderMd('```c\nint x = 1;\nprintf("%%d", x);\n```');

    const pres = document.querySelectorAll('pre');
    expect(pres.length).toBe(1);

    const code = pres[0].querySelector('code');
    expect(code).toBeInTheDocument();
    expect(code).toHaveClass('language-c');
    expect(code.textContent).toContain('int x = 1;');

    // No DOM attribute named "node" should leak
    expect(pres[0].hasAttribute('node')).toBe(false);
    expect(code.hasAttribute('node')).toBe(false);
  });

  it('renders inline code as <code> without <pre> wrapper', () => {
    renderMd('This is `inline code` text.');

    const code = document.querySelector('code');
    expect(code).toBeInTheDocument();
    expect(code.textContent).toBe('inline code');

    // Inline code should NOT be wrapped in a <pre>
    expect(document.querySelectorAll('pre').length).toBe(0);
    // No "node" attribute leak
    expect(code.hasAttribute('node')).toBe(false);
  });

  it('routes mermaid fenced block to MermaidDiagram without <pre> wrapper', () => {
    renderMd('```mermaid\ngraph TD;\nA-->B;\n```');

    expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
    const diagram = screen.getByTestId('mermaid-diagram');
    // MermaidDiagram should NOT be inside a <pre>
    expect(diagram.closest('pre')).toBeNull();
  });

  it('renders the TEMP_PROBLEMS blockquote fenced C code as one block', () => {
    renderMd(
      '> **练习题 3**（选择题）以下代码片段，哪个选项指出了潜在的 bug？\n' +
      '> ```c\n' +
      '> int fd = socket(AF_INET, SOCK_STREAM, 0);\n' +
      '> struct sockaddr_in addr;\n' +
      '> bind(fd, (struct sockaddr*)&addr, sizeof(addr));\n' +
      '> ```'
    );

    const quote = document.querySelector('blockquote');
    const pres = quote.querySelectorAll('pre');
    expect(pres).toHaveLength(1);
    const code = pres[0].querySelector('code');
    expect(code).toBeInTheDocument();
    expect(code).toHaveClass('language-c');
    expect(code.textContent).toContain('socket');
  });

  it('renders a fenced block WITHOUT a language class as a block (not inline)', () => {
    renderMd('```\nint fd = socket(AF_INET, SOCK_STREAM, 0);\nstruct sockaddr_in addr;\nbind(fd, (struct sockaddr*)&addr, sizeof(addr));\n```');

    const pres = document.querySelectorAll('pre');
    expect(pres.length).toBe(1);
    const code = pres[0].querySelector('code');
    expect(code).toBeInTheDocument();
    expect(code.textContent).toContain('socket');
    expect(code.textContent).toContain('bind');
  });

  it('renders multiple fenced blocks independently', () => {
    renderMd(
      'First block:\n```js\nconst a = 1;\n```\n\nSecond block:\n```py\nb = 2\n```'
    );

    const pres = document.querySelectorAll('pre');
    expect(pres.length).toBe(2);

    const codeBlocks = document.querySelectorAll('pre code');
    expect(codeBlocks.length).toBe(2);
    expect(codeBlocks[0]).toHaveClass('language-js');
    expect(codeBlocks[1]).toHaveClass('language-py');
  });

  it('wraps Markdown images in the full-screen media viewer', () => {
    renderMd('![线程结构图](/images/thread.png)');

    const trigger = screen.getByRole('button', { name: '全屏查看：线程结构图' });
    expect(trigger).toContainElement(screen.getByRole('img', { name: '线程结构图' }));
  });

  it('removes active HTML from generated detail content', () => {
    render(<ContentArea content={'<iframe srcdoc="<script>window.pwned=1</script>"></iframe>\n\n**安全文本**'} />);

    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('安全文本')).toBeInTheDocument();
  });

  it('removes active HTML from generated follow-up answers', () => {
    render(<QaMessages qaList={[{
      question: '解释一下',
      answer: '<object data="javascript:alert(1)"></object>\n\n保留回答',
    }]} />);

    expect(document.querySelector('object')).toBeNull();
    expect(screen.getByText('保留回答')).toBeInTheDocument();
  });
});
