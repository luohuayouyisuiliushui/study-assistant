import { describe, expect, it } from 'vitest';
import { normalizeMermaidSource } from '../lib/mermaid-source.js';

describe('normalizeMermaidSource', () => {
  it('leaves other Mermaid diagram types unchanged', () => {
    const source = 'flowchart TD\n    A["运行中"] --> B["已结束"]';

    expect(normalizeMermaidSource(source)).toBe(source);
  });

  it('reuses an existing state alias in quoted transition endpoints', () => {
    const source = [
      'stateDiagram-v2',
      '    state "运行中" as running',
      '    [*] --> "运行中"',
      '    "运行中" --> [*]',
    ].join('\n');

    expect(normalizeMermaidSource(source)).toBe([
      'stateDiagram-v2',
      '    state "运行中" as running',
      '    [*] --> running',
      '    running --> [*]',
    ].join('\n'));
  });
});
