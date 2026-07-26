import { useEffect, useRef, useState } from 'react';
import { normalizeMermaidSource } from '../lib/mermaid-source.js';

/**
 * Renders a Mermaid diagram from its source code.
 * Uses IntersectionObserver to lazy-render only when scrolled into view.
 * Uses mermaid.render() to produce SVG safely — no innerHTML injection from user input.
 */
export default function MermaidDiagram({ code }) {
  const containerRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const [renderAttempt, setRenderAttempt] = useState(0);

  // Lazy load: observe when element enters viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // If IntersectionObserver is not available, render immediately
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' } // start loading 200px before it enters viewport
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Render diagram when visible
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    setError(null);
    setSvg('');

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
        const { svg: svgText } = await mermaid.render(id, normalizeMermaidSource(code));

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
  }, [code, visible, renderAttempt]);

  if (error) {
    // Extract a short, readable error description
    const shortMsg = error
      .replace(/Syntax error in (?:graph|text).*?$/ms, '语法错误，请检查图表定义')
      .replace(/Lexical error.*?$/ms, '存在无法识别的字符或符号')
      .replace(/Error: (.*?)\\n.*/s, '$1')
      .split('\n')[0]
      .substring(0, 120);
    const isSyntaxError = /syntax|parse|lexical|unexpected/i.test(error);

    return (
      <div className="mermaid-error">
        <div className="mermaid-error-header">
          <span>图表渲染失败</span>
          <button className="btn-tiny" onClick={() => setRenderAttempt(attempt => attempt + 1)} title="重新渲染">重试</button>
        </div>
        <div className="mermaid-error-body">
          <p className="mermaid-error-reason">{shortMsg}</p>
          {isSyntaxError && (
            <p className="mermaid-error-hint">提示：Mermaid 图表语法可能有误。常见原因——缺少节点定义、箭头方向错误、括号不匹配。</p>
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

  if (!visible) {
    return (
      <div
        className="mermaid-container mermaid-placeholder"
        ref={containerRef}
        style={{ minHeight: '60px' }}
      >
        <div className="mermaid-loading">滚动到可视区域后渲染图表</div>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading" ref={containerRef}>渲染图表中...</div>;
  }

  return (
    <div
      className="mermaid-container"
      ref={containerRef}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
