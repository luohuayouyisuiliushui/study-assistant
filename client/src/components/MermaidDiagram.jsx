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
        const { svg: svgText } = await mermaid.render(id, code);

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
    return (
      <div className="mermaid-error">
        <details>
          <summary>⚠️ 图表渲染失败</summary>
          <pre>{error}</pre>
          <pre className="mermaid-error-source">{code}</pre>
        </details>
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
