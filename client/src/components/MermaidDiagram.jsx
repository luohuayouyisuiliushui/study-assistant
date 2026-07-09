import { useEffect, useRef, useState } from 'react';

/**
 * Renders a Mermaid diagram from its source code.
 * Uses mermaid.render() to produce SVG safely — no innerHTML injection from user input.
 */
export default function MermaidDiagram({ code }) {
  const containerRef = useRef(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');

        // Initialize once with safe defaults
        mermaid.initialize({
          startOnLoad: false,
          theme: 'neutral',
          securityLevel: 'strict',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });

        // Use a unique id per render to avoid collisions
        const id = 'mermaid-' + Math.random().toString(36).slice(2, 9);
        const { svg: svgText } = await mermaid.render(id, code.replace(/\(/g, '&#40;').replace(/\)/g, '&#41;'));

        if (!cancelled) {
          setSvg(svgText);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || String(err));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    // Extract a short, readable error description
    const shortMsg = error
      .replace(/Syntax error in graph.*?$/ms, '语法错误，请检查图表定义')
      .replace(/Lexical error.*?$/ms, '存在无法识别的字符或符号')
      .replace(/Error: (.*?)\\n.*/s, '$1')
      .split('\n')[0]
      .substring(0, 120);
    const isSyntaxError = /syntax|parse|lexical|unexpected/i.test(error);

    return (
      <div className="mermaid-error">
        <div className="mermaid-error-header">
          <span>⚠️ 图表渲染失败</span>
          <button className="btn-tiny" onClick={() => { setError(null); setSvg(''); }} title="重新渲染">🔄 重试</button>
        </div>
        <div className="mermaid-error-body">
          <p className="mermaid-error-reason">{shortMsg}</p>
          {isSyntaxError && (
            <p className="mermaid-error-hint">💡 提示：Mermaid 图表语法可能有误。常见原因——缺少节点定义、箭头方向错误、括号不匹配。</p>
          )}
          <details>
            <summary>查看源代码</summary>
            <pre className="mermaid-error-source">{code}</pre>
          </details>
          <details>
            <summary>查看详细错误</summary>
            <pre>{error}</pre>
          </details>
        </div>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading">🔄 渲染图表中...</div>;
  }

  return (
    <div
      className="mermaid-container"
      ref={containerRef}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
