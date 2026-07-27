const BIDIRECTIONAL_TYPES = new Set(['related', 'contrasts', 'extends', 'exampleOf', 'references']);

export function collapseGraphToOverview(nodes = [], visibleEdges = [], hierarchyEdges = visibleEdges) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const parentByChild = new Map();
  for (const edge of hierarchyEdges) {
    if (edge.type === 'parentOf' && nodeMap.has(edge.from) && nodeMap.has(edge.to)) {
      parentByChild.set(edge.to, edge.from);
    }
  }

  const rootIds = new Set(nodes.filter(node => Number(node.level) <= 1).map(node => node.id));
  if (rootIds.size === 0) {
    for (const node of nodes) {
      if (!parentByChild.has(node.id)) rootIds.add(node.id);
    }
  }

  const rootCache = new Map();
  function findRoot(nodeId) {
    if (rootCache.has(nodeId)) return rootCache.get(nodeId);
    const visited = new Set();
    let current = nodeId;
    while (parentByChild.has(current) && !rootIds.has(current) && !visited.has(current)) {
      visited.add(current);
      current = parentByChild.get(current);
    }
    const rootId = rootIds.has(current) ? current : nodeId;
    rootCache.set(nodeId, rootId);
    return rootId;
  }

  const totals = new Map();
  for (const node of nodes) {
    const rootId = findRoot(node.id);
    const entry = totals.get(rootId) || { totalCount: 0, doneCount: 0 };
    entry.totalCount += 1;
    if (node.done) entry.doneCount += 1;
    totals.set(rootId, entry);
  }

  const overviewNodes = nodes
    .filter(node => rootIds.has(node.id) || (!parentByChild.has(node.id) && findRoot(node.id) === node.id))
    .map(node => {
      const total = totals.get(node.id) || { totalCount: 1, doneCount: node.done ? 1 : 0 };
      return {
        ...node,
        totalCount: total.totalCount,
        doneCount: total.doneCount,
        collapsedCount: Math.max(0, total.totalCount - 1),
      };
    });

  const aggregated = new Map();
  for (const edge of visibleEdges) {
    if (edge.type === 'parentOf') continue;
    let from = findRoot(edge.from);
    let to = findRoot(edge.to);
    if (!nodeMap.has(from) || !nodeMap.has(to) || from === to) continue;
    if (BIDIRECTIONAL_TYPES.has(edge.type) && from.localeCompare(to) > 0) [from, to] = [to, from];
    const key = `${edge.type}|${from}|${to}`;
    const current = aggregated.get(key);
    if (current) {
      current.count += 1;
      current.weight = Math.max(current.weight, Number(edge.weight) || 0.5);
      if (current.source !== 'manual' && edge.source === 'manual') current.source = 'manual';
    } else {
      aggregated.set(key, {
        ...edge,
        from,
        to,
        count: 1,
        weight: Number(edge.weight) || 0.5,
      });
    }
  }

  return { nodes: overviewNodes, edges: [...aggregated.values()] };
}
