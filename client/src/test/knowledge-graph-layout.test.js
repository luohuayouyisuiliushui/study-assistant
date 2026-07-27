import { describe, it, expect } from 'vitest';
import { collapseGraphToOverview } from '../lib/knowledge-graph-layout';

describe('collapseGraphToOverview', () => {
  it('collapses descendants into root topics and aggregates cross-topic relations', () => {
    const nodes = [
      { id: 'root-a', title: '主题 A', level: 1, phaseId: 'p1' },
      { id: 'a-1', title: 'A-1', level: 2, phaseId: 'p1' },
      { id: 'a-2', title: 'A-2', level: 2, phaseId: 'p1' },
      { id: 'root-b', title: '主题 B', level: 1, phaseId: 'p2' },
      { id: 'b-1', title: 'B-1', level: 2, phaseId: 'p2' },
      { id: 'root-c', title: '主题 C', level: 1, phaseId: 'p2' },
    ];
    const edges = [
      { from: 'root-a', to: 'a-1', type: 'parentOf' },
      { from: 'root-a', to: 'a-2', type: 'parentOf' },
      { from: 'root-b', to: 'b-1', type: 'parentOf' },
      { from: 'a-1', to: 'b-1', type: 'prerequisite', weight: 0.7 },
      { from: 'a-2', to: 'b-1', type: 'prerequisite', weight: 0.9 },
      { from: 'a-1', to: 'root-c', type: 'related', weight: 0.5 },
    ];

    const overview = collapseGraphToOverview(nodes, edges, edges);

    expect(overview.nodes.map(node => node.id)).toEqual(['root-a', 'root-b', 'root-c']);
    expect(overview.nodes.find(node => node.id === 'root-a').collapsedCount).toBe(2);
    expect(overview.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'root-a', to: 'root-b', type: 'prerequisite', count: 2, weight: 0.9 }),
      expect.objectContaining({ from: 'root-a', to: 'root-c', type: 'related', count: 1 }),
    ]));
    expect(overview.edges.some(edge => edge.type === 'parentOf')).toBe(false);
    expect(nodes).toHaveLength(6);
    expect(edges).toHaveLength(6);
  });
});
