import { describe, expect, it } from 'vitest';
import { normalizeMermaidSource } from '../lib/mermaid-source.js';

describe('normalizeMermaidSource', () => {
  it('leaves non-state diagrams unchanged', () => {
    const source = 'flowchart TD\n    A["运行中"] --> B["已结束"]';

    expect(normalizeMermaidSource(source)).toBe(source);
  });

  it('rewrites quoted state transition endpoints to declared aliases', () => {
    const source = [
      'stateDiagram-v2',
      '    [*] --> "运行中"',
      '    "运行中" --> "可连接线程已结束": "线程函数 return 或 pthread_exit()"',
      '    "运行中" --> "分离线程已结束": "线程函数 return 或 pthread_exit()"',
      '    "可连接线程已结束" --> [*]: "pthread_join() 回收"',
      '    "分离线程已结束" --> [*]: "内核自动回收"',
    ].join('\n');

    const normalized = normalizeMermaidSource(source);

    expect(normalized).toContain('state "运行中" as mermaid_state_1');
    expect(normalized).toContain('state "可连接线程已结束" as mermaid_state_2');
    expect(normalized).toContain('state "分离线程已结束" as mermaid_state_3');
    expect(normalized).toContain('[*] --> mermaid_state_1');
    expect(normalized).not.toContain('--> "运行中"');
  });

  it('reuses an existing alias declaration', () => {
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

  it('merges labels for duplicate state transitions so Mermaid does not overlap them', () => {
    const source = [
      'stateDiagram-v2',
      '    [*] --> Joinable : pthread_create()',
      '    Joinable --> Running : 被调度',
      '    Running --> Zombie : 线程退出(return/pthread_exit)',
      '    Zombie --> [*] : pthread_join() 回收资源',
      '    Joinable --> Detached : pthread_detach()',
      '    Detached --> Running : 被调度',
      '    Running --> [*] : 线程退出，自动回收资源',
      '    Zombie --> [*] : 进程结束（强制回收）',
    ].join('\n');

    const normalized = normalizeMermaidSource(source);

    expect(normalized.match(/Zombie\s*-->\s*\[\*\]/g)).toHaveLength(1);
    expect(normalized).toContain(
      'Zombie --> [*] : pthread_join() 回收资源<br/>进程结束（强制回收）'
    );
  });
});
