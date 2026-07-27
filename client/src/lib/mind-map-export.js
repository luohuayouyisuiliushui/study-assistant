export function buildTree(plan) {
  const phaseMap = {};
  for (const phase of plan.phases || []) {
    phaseMap[phase.id] = { id: phase.id, name: phase.name, order: phase.order || 0, children: [] };
  }

  const topicMap = {};
  for (const topic of plan.topics || []) {
    topicMap[topic.id] = { ...topic, children: [] };
  }

  const roots = [];
  for (const topic of plan.topics || []) {
    const node = topicMap[topic.id];
    if (topic.parentId && topicMap[topic.parentId]) {
      topicMap[topic.parentId].children.push(node);
    } else if (topic.phaseId && phaseMap[topic.phaseId]) {
      phaseMap[topic.phaseId].children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const phase of Object.values(phaseMap)) {
    phase.children.sort((a, b) => a.order - b.order);
    roots.push(phase);
  }

  roots.sort((a, b) => (a.order || 0) - (b.order || 0));
  return roots;
}

export function treeToMarkdown(nodes, depth = 1) {
  let markdown = '';
  for (const node of nodes) {
    if (node.name !== undefined) {
      const done = node.children.length > 0 && node.children.every(child => child.done);
      markdown += `${'#'.repeat(depth)} ${node.name}${done ? ' ✅' : ''}\n`;
    } else {
      const doneMark = node.done ? ' ✅' : node.difficulty === 'hard' ? ' ⚠️' : '';
      markdown += `${'#'.repeat(depth)} ${node.title}${doneMark}\n`;
    }
    if (node.children?.length > 0) {
      const sortedChildren = [...node.children].sort((a, b) => a.order - b.order);
      markdown += treeToMarkdown(sortedChildren, depth + 1);
    }
  }
  return markdown;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function treeToOpmlOutlines(nodes, depth = 2) {
  const indent = '  '.repeat(depth);
  return nodes.map(node => {
    const label = node.name !== undefined ? node.name : node.title;
    const status = node.name === undefined && node.done ? ' [已完成]' : '';
    if (!node.children?.length) return `${indent}<outline text="${escapeXml(label + status)}" />`;
    const children = treeToOpmlOutlines(node.children, depth + 1);
    return `${indent}<outline text="${escapeXml(label + status)}">\n${children}\n${indent}</outline>`;
  }).join('\n');
}

export function treeToOpml(planName, nodes) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeXml(planName)}</title>\n  </head>\n  <body>\n    <outline text="${escapeXml(planName)}">\n${treeToOpmlOutlines(nodes, 3)}\n    </outline>\n  </body>\n</opml>\n`;
}

export function treeToJson(nodes) {
  return nodes.map(node => ({
    id: node.id,
    title: node.name !== undefined ? node.name : node.title,
    type: node.name !== undefined ? 'phase' : 'topic',
    ...(node.name === undefined ? { done: Boolean(node.done), difficulty: node.difficulty || null } : {}),
    children: treeToJson(node.children || []),
  }));
}
