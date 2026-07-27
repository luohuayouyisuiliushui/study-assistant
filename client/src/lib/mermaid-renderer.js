import { normalizeMermaidSource } from './mermaid-source.js';

export const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'strict',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  state: {
    nodeSpacing: 70,
    rankSpacing: 70,
  },
};

export async function renderMermaidSvg(code, idPrefix = 'mermaid') {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize(MERMAID_CONFIG);

  const id = `${idPrefix}-${Math.random().toString(36).slice(2, 9)}`;
  const { svg } = await mermaid.render(id, normalizeMermaidSource(code));
  return svg;
}
