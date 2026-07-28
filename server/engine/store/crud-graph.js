/**
 * Knowledge graph construction and analysis.
 *
 * Pure functions that build graph data structures from plan topics,
 * infer relationships from detail text, and compute centrality metrics.
 */

// ─── Topic tree helpers ───

/**
 * Get children topics for a given parent topic.
 */
export function getTopicChildren(plan, parentId) {
  if (!plan || !plan.topics) return [];
  return plan.topics.filter(t => t.parentId === parentId).sort((a, b) => a.order - b.order);
}

/**
 * Get topic prerequisites (topics that should be learned first).
 */
export function getTopicPrerequisites(plan, topicId) {
  if (!plan || !plan.topics) return [];
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic || !topic.prerequisites?.length) return [];
  return topic.prerequisites.map(id => plan.topics.find(t => t.id === id)).filter(Boolean);
}

/**
 * Get topic descendants (recursively) for tree operations.
 */
export function getTopicDescendants(plan, parentId) {
  const result = [];
  const children = getTopicChildren(plan, parentId);
  for (const child of children) {
    result.push(child);
    result.push(...getTopicDescendants(plan, child.id));
  }
  return result;
}

// ─── Knowledge graph construction ───

/**
 * Build a knowledge graph data structure for visualization.
 * Returns { nodes: [...], edges: [...] }
 */
export function buildKnowledgeGraph(plan) {
  if (!plan || !plan.topics) return { nodes: [], edges: [] };

  const nodes = plan.topics.map(t => ({
    id: t.id,
    title: t.title,
    phaseId: t.phaseId,
    level: t.level || 1,
    done: t.done,
    difficulty: t.difficulty,
  }));

  const edges = [];
  const seen = new Set();

  // Parent-child edges
  for (const t of plan.topics) {
    if (t.parentId) {
      const key = `${t.parentId}-parentOf-${t.id}`;
      if (!seen.has(key)) {
        edges.push({ from: t.parentId, to: t.id, type: 'parentOf' });
        seen.add(key);
      }
    }
  }

  // Prerequisite edges
  for (const t of plan.topics) {
    if (t.prerequisites) {
      for (const preId of t.prerequisites) {
        const key = `${preId}-prerequisite-${t.id}`;
        if (!seen.has(key)) {
          edges.push({ from: preId, to: t.id, type: 'prerequisite' });
          seen.add(key);
        }
      }
    }
  }

  // Related edges (undirected, show as bidirectional)
  for (const t of plan.topics) {
    if (t.relatedTopics) {
      for (const relId of t.relatedTopics) {
        const key = [t.id, relId].sort().join('-related-');
        if (!seen.has(key)) {
          edges.push({ from: t.id, to: relId, type: 'related' });
          seen.add(key);
        }
      }
    }
  }

  return { nodes, edges };
}

// ─── Detail-text relation extraction ───

/**
 * Relationship type keywords for inferring relation types from AI detail text.
 * Maps keyword patterns to relationship types.
 */
const RELATION_TYPE_KEYWORDS = [
  { keywords: ['下一步学习', '下一步', '先学', '前置', '基础', '预备', '需要掌握', '建议先'], type: 'prerequisite' },
  { keywords: ['扩展', '深入', '进阶', '进一步学习', '更深', '提升'], type: 'extends' },
  { keywords: ['示例', '例子', '实例', '应用场景', '实际应用', '实践'], type: 'exampleOf' },
  { keywords: ['对比', '区别', '异同', '比较', 'vs', 'versus', '差异', '不同'], type: 'contrasts' },
  { keywords: ['构建于', '基于', '依赖', '建立在', '依托'], type: 'buildsOn' },
  { keywords: ['参考', '引用', '参见', '详见', '参阅'], type: 'references' },
];

/**
 * Extract relationship edges from a topic's AI-generated detail text.
 * Parses the "与相关知识点的联系" section and infers edge types from descriptions.
 * @param {string} detail - The topic's Markdown detail content
 * @param {Array} allTopics - All topics in the plan (for title matching)
 * @param {string} currentTopicId - The ID of the topic whose detail is being parsed
 * @returns {Array} Inferred edges: [{ from, to, type, description, source: 'detail' }]
 */
export function extractRelationsFromDetail(detail, allTopics, currentTopicId) {
  if (!detail || !allTopics || !currentTopicId) return [];
  const edges = [];

  // Section headers indicating a "related topics" section
  const sectionPatterns = [
    /^#{2,4}\s*与相关知识点的联系\s*$/m,
    /^#{2,4}\s*承上启下\s*[：:]\s*与相关知识点的联系\s*$/m,
    /^#{2,4}\s*(?:承上启下\s*[：:]\s*)?(?:关联|相关|联系|后续|延伸)(?:知识|学习|概念|主题)?(?:点)?\s*(?:的联系|的关系)?\s*$/m,
  ];

  let sectionStart = -1;
  let sectionEnd = -1;
  const lines = detail.split('\n');

  // Find the matching section
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (sectionStart === -1) {
      for (const pat of sectionPatterns) {
        if (pat.test(line)) {
          sectionStart = i;
          break;
        }
      }
    } else if (sectionStart >= 0 && line.startsWith('#')) {
      // Next heading ends the section
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) return [];
  if (sectionEnd === -1) sectionEnd = lines.length;

  // Normalize a string for fuzzy matching
  const normalize = (s) => s.toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, '')
    .replace(/\s+/g, '');

  // Build a map of normalized titles for matching
  const titleMap = [];
  for (const t of allTopics) {
    if (t.id === currentTopicId) continue;
    titleMap.push({ id: t.id, title: t.title, norm: normalize(t.title) });
  }

  // Parse each line within the section
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

    // Bullet point with **Title** pattern: - **Title**：description
    let bulletMatch = line.match(/^[-*]\s+\*\*(.+?)\*\*\s*[：:]\s*(.*)/);
    if (!bulletMatch) {
      // Try without bullet: **Title**：description
      bulletMatch = line.match(/^\*\*(.+?)\*\*\s*[：:]\s*(.*)/);
    }
    if (!bulletMatch) {
      // Try [Title] pattern
      bulletMatch = line.match(/^[-*]\s*\[(.+?)\]\s*[：:]\s*(.*)/);
    }
    if (!bulletMatch) continue;

    const bulletTitle = bulletMatch[1].trim();
    const description = bulletMatch[2].trim();
    if (!bulletTitle) continue;

    // Match title to a topic
    const bulletNorm = normalize(bulletTitle);
    let matchedTopic = null;

    // Exact match first
    matchedTopic = titleMap.find(t => t.norm === bulletNorm);
    if (!matchedTopic) {
      // Partial match: bullet title is contained in stored title or vice versa
      matchedTopic = titleMap.find(t =>
        t.norm.includes(bulletNorm) || bulletNorm.includes(t.norm)
      );
    }

    if (!matchedTopic) continue;

    // Infer relationship type from description
    let relType = 'related';
    for (const rule of RELATION_TYPE_KEYWORDS) {
      const descLower = description.toLowerCase();
      if (rule.keywords.some(kw => descLower.includes(kw))) {
        relType = rule.type;
        break;
      }
    }

    // Determine edge direction based on description semantics:
    // - "下一步学习/深入/扩展" → current topic is foundation, matched comes after → current → matched
    // - "先学/前置/基础/需要掌握/构建于/基于" → matched topic is foundation → matched → current
    // - "示例/例子" → current's example → current → matched
    // - "对比/区别" → symmetric, keep current → matched
    let from = currentTopicId;
    let to = matchedTopic.id;

    const nextStepKeywords = ['下一步学习', '下一步', '扩展', '深入', '进阶', '进一步学习', '更深', '提升', '延伸'];
    const foundationKeywords = ['先学', '前置', '基础', '需要掌握', '建议先', '预备知识',
                                '构建于', '基于', '依赖', '建立在', '依托',
                                '参考', '引用', '参见'];

    const isNextStep = nextStepKeywords.some(kw => description.includes(kw));
    const isFoundation = foundationKeywords.some(kw => description.includes(kw));
    const currentIsFoundation = [
      /(?:本节|本讲|本章|本文|当前知识点|本知识点)[^。]{0,40}(?:前置(?:知识|条件)?|先决条件)/,
      /(?:本节|本讲|本章|本文|当前知识点|本知识点)[^。]{0,50}(?:奠定|提供)[^。]{0,10}基础/,
    ].some(pattern => pattern.test(description));

    if ((relType === 'buildsOn' || relType === 'references') && !currentIsFoundation) {
      // Linked topic is the foundation → reverse direction: matched → current
      from = matchedTopic.id;
      to = currentTopicId;
    } else if (relType === 'prerequisite') {
      if (!currentIsFoundation && isFoundation && !isNextStep) {
        // Linked topic should be learned first → matched → current
        from = matchedTopic.id;
        to = currentTopicId;
      }
      // else: isNextStep → current → matched (already the default)
    }
    // For 'extends', 'exampleOf', 'contrasts', 'related': keep default current → matched

    edges.push({
      from,
      to,
      type: relType,
      description: description.substring(0, 120),
      source: 'detail',
    });
  }

  return edges;
}

// ─── Inferred edges ───

/**
 * Build inferred relationships from a plan:
 * 1. Parse detail text of each topic for explicit relationships
 * 2. Compute transitive prerequisites (if A→B and B→C, then A→C)
 * 3. Inherit prerequisites down the tree (if parent has prereq P, children also effectively depend on P)
 * @param {object} plan - The plan object
 * @param {object} options
 * @param {boolean} options.includeDetailExtraction - Parse detail text (default: true)
 * @param {boolean} options.includeTransitive - Compute transitive closures (default: true)
 * @param {boolean} options.includeInherited - Inherit prerequisites to children (default: true)
 * @returns {Array} All inferred edges
 */
export function buildInferredEdges(plan, options = {}) {
  const {
    includeDetailExtraction = true,
    includeTransitive = true,
    includeInherited = true,
    includeSiblingRelated = true,
    includeSequential = true,
    includeKeywordCrossPhase = true,
  } = options;

  if (!plan || !plan.topics || plan.topics.length === 0) return [];

  const inferredEdges = [];
  const seen = new Set();
  const topicMap = {};
  for (const t of plan.topics) {
    topicMap[t.id] = t;
  }

  // 0. Structure-based edges: parent-child hierarchy (works even without detail)
  for (const t of plan.topics) {
    if (t.parentId && topicMap[t.parentId]) {
      const key = `${t.parentId}:parentOf:${t.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        inferredEdges.push({
          from: t.parentId,
          to: t.id,
          type: 'parentOf',
          description: `「${topicMap[t.parentId]?.title || ''}」包含子知识点「${t.title}」`,
          source: 'structure',
          weight: 1.0,
        });
      }
    }
  }

  // 1. Extract from detail text
  if (includeDetailExtraction) {
    for (const t of plan.topics) {
      if (!t.detail) continue;
      const extracted = extractRelationsFromDetail(t.detail, plan.topics, t.id);
      for (const e of extracted) {
        const isUndirected = e.type === 'related' || e.type === 'contrasts';
        const key = isUndirected
          ? [e.from, e.to].sort().join(':') + ':' + e.type
          : e.from + ':' + e.type + ':' + e.to;
        if (!seen.has(key)) {
          seen.add(key);
          inferredEdges.push(e);
        }
      }
    }
  }

  // 2. Inherit prerequisites to children
  if (includeInherited) {
    for (const t of plan.topics) {
      if (!t.prerequisites) continue;
      // Find all descendants of this topic
      const descendants = getTopicDescendants(plan, t.id);
      for (const preId of t.prerequisites) {
        for (const desc of descendants) {
          const key = `${preId}:inheritedPrerequisite:${desc.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            inferredEdges.push({
              from: preId,
              to: desc.id,
              type: 'inheritedPrerequisite',
              description: `父知识点「${topicMap[t.id]?.title || ''}」的前置依赖传递给子知识点`,
              source: 'inherited',
            });
          }
        }
      }
    }
  }

  // 3. Compute transitive prerequisites (A→B, B→C => A→C)
  if (includeTransitive) {
    // Build adjacency list
    const prereqOf = {}; // topicId → Set of topics that depend on it
    for (const t of plan.topics) {
      if (!t.prerequisites) continue;
      for (const preId of t.prerequisites) {
        if (!prereqOf[preId]) prereqOf[preId] = new Set();
        prereqOf[preId].add(t.id);
      }
    }

    // For each topic, BFS to find all transitive dependents
    for (const t of plan.topics) {
      const visited = new Set();
      const queue = [...(t.prerequisites || [])];
      while (queue.length > 0) {
        const depId = queue.shift();
        if (visited.has(depId)) continue;
        visited.add(depId);

        // Add edge: depId → t.id (already exists as direct, skip)
        // Instead, find: if depId has its own prerequisites, those are transitive prerequisites of t
        const depTopic = topicMap[depId];
        if (depTopic && depTopic.prerequisites) {
          for (const transPreId of depTopic.prerequisites) {
            if (transPreId === t.id) continue;
            // Check this isn't already a direct prerequisite
            if (t.prerequisites && t.prerequisites.includes(transPreId)) continue;
            const key = `${transPreId}:transitivePrerequisite:${t.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              inferredEdges.push({
                from: transPreId,
                to: t.id,
                type: 'transitivePrerequisite',
                description: `通过「${topicMap[depId]?.title || ''}」传递的间接前置依赖`,
                source: 'transitive',
              });
            }
          }
        }
      }
    }
  }

  // 4. Sibling relatedness — topics under the same parent are inherently related
  if (includeSiblingRelated) {
    const siblingsByParent = {};
    for (const t of plan.topics) {
      const key = t.parentId || '__root__';
      if (!siblingsByParent[key]) siblingsByParent[key] = [];
      siblingsByParent[key].push(t);
    }
    for (const [parentKey, siblings] of Object.entries(siblingsByParent)) {
      if (siblings.length < 2) continue;
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          const a = siblings[i], b = siblings[j];
          const key = `${[a.id, b.id].sort().join(':')}:related`;
          if (seen.has(key)) continue;
          seen.add(key);
          inferredEdges.push({
            from: a.id,
            to: b.id,
            type: 'related',
            description: `同属于「${topicMap[parentKey]?.title || '根节点'}」的兄弟知识点`,
            source: 'structure',
            weight: 0.6,
          });
        }
      }
    }
  }

  // 5. Sequential dependency — ordered topics under the same parent imply builds-on
  if (includeSequential) {
    const groups = {};
    for (const t of plan.topics) {
      const gk = t.parentId || '__root__';
      if (!groups[gk]) groups[gk] = [];
      groups[gk].push(t);
    }
    for (const [, group] of Object.entries(groups)) {
      group.sort((a, b) => a.order - b.order);
      for (let i = 0; i < group.length - 1; i++) {
        const a = group[i], b = group[i + 1];
        if (b.prerequisites && b.prerequisites.includes(a.id)) continue;
        const key = `${a.id}:buildsOn:${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inferredEdges.push({
          from: a.id,
          to: b.id,
          type: 'buildsOn',
          description: `在学习顺序上位于「${b.title}」之前`,
          source: 'structure',
          weight: 0.4,
        });
      }
    }
  }

  // 6. Cross-phase keyword matching
  if (includeKeywordCrossPhase) {
    const keywordIndex = [];
    const skipWords = new Set(['的', '与', '和', '及', '在', '之', '基础', '入门', '详解', '介绍', '概述', '浅析', '初步']);
    for (const t of plan.topics) {
      const words = t.title.split(/[\s,，、：:()（）\/]/).filter(Boolean);
      const keywords = [];
      for (const w of words) {
        const trimmed = w.trim();
        if (!trimmed || trimmed.length < 2) continue;
        if (skipWords.has(trimmed)) continue;
        keywords.push(trimmed);
      }
      keywordIndex.push({ id: t.id, title: t.title, phaseId: t.phaseId, keywords });
    }
    for (let i = 0; i < keywordIndex.length; i++) {
      for (let j = i + 1; j < keywordIndex.length; j++) {
        const a = keywordIndex[i], b = keywordIndex[j];
        if (a.phaseId === b.phaseId) continue;
        const key = `${[a.id, b.id].sort().join(':')}:related`;
        if (seen.has(key)) continue;
        const overlap = a.keywords.filter(kw => b.keywords.some(bkw => bkw.includes(kw) || kw.includes(bkw)));
        if (overlap.length === 0) continue;
        seen.add(key);
        inferredEdges.push({
          from: a.id,
          to: b.id,
          type: 'related',
          description: `共享关键词「${overlap.join('、')}」的跨阶段关联`,
          source: 'structure',
          weight: Math.min(0.3 + overlap.length * 0.1, 0.8),
        });
      }
    }
  }

  return inferredEdges;
}

// ─── Enhanced graph + centrality ───

/**
 * Build knowledge graph with optional inferred edges.
 * Extends buildKnowledgeGraph by supporting inferred relationships from detail text,
 * transitive dependencies, and inherited prerequisites.
 * @param {object} plan
 * @param {object} options
 * @returns {{ nodes: Array, edges: Array, inferredCount: number }}
 */
export function buildEnhancedKnowledgeGraph(plan, options = {}) {
  const base = buildKnowledgeGraph(plan);
  const inferredEdges = buildInferredEdges(plan, options);
  // Dedup: base edges take priority over inferred
  const baseKeys = new Set();
  for (const e of base.edges) {
    // For undirected types (related), use sorted key
    const key = e.type === 'related'
      ? [e.from, e.to].sort().join(':') + ':related'
      : e.from + ':' + e.type + ':' + e.to;
    baseKeys.add(key);
  }
  const dedupedInferred = inferredEdges.filter(e => {
    const key = e.type === 'related'
      ? [e.from, e.to].sort().join(':') + ':related'
      : e.from + ':' + e.type + ':' + e.to;
    return !baseKeys.has(key);
  });
  const allEdges = [...base.edges, ...dedupedInferred];
  // Keep the engine helper Map-based, but expose a JSON-safe object at the API boundary.
  const centrality = Object.fromEntries(computeGraphCentrality({ nodes: base.nodes, edges: allEdges }));
  return {
    nodes: base.nodes,
    edges: allEdges,
    baseEdgeCount: base.edges.length,
    inferredCount: dedupedInferred.length,
    centrality,
  };
}

/**
 * Compute graph centrality metrics for knowledge graph nodes.
 *
 * Returns a Map<nodeId, { inDegree, outDegree, pageRank }> where:
 *   - inDegree: number of incoming edges (other topics depend on this one)
 *   - outDegree: number of outgoing edges (this topic depends on others)
 *   - pageRank: iterative importance score (damping=0.85, 20 iterations)
 *
 * Edge direction semantics:
 *   - parentOf, prerequisite, extends, buildsOn, exampleOf, references,
 *     contrasts: directed from→to
 *   - related: undirected, treated as bidirectional (counts in both degrees)
 *
 * High inDegree + high pageRank ⇒ hub topic (many topics reference it).
 * Use this to surface "core knowledge points" quantitatively, complementing
 * the AI-based analyzeCoreTopics identification.
 *
 * Standard PageRank with dangling-node redistribution. No external deps;
 * O(iterations * (N + E)) which is fine for typical plan graphs (<1000 nodes).
 *
 * @param {{nodes: Array, edges: Array}} graph
 * @param {{iterations?: number, damping?: number}} options
 * @returns {Map<string, {inDegree: number, outDegree: number, pageRank: number}>}
 */
export function computeGraphCentrality(graph, options = {}) {
  const { iterations = 20, damping = 0.85 } = options;
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  if (nodes.length === 0) return new Map();

  const nodeIds = new Set(nodes.map(n => n.id));
  const inDeg = new Map();
  const outDeg = new Map();
  const inbound = new Map();
  const outbound = new Map();
  for (const id of nodeIds) {
    inDeg.set(id, 0);
    outDeg.set(id, 0);
    inbound.set(id, []);
    outbound.set(id, []);
  }

  const UNDIRECTED_TYPES = new Set(['related']);
  for (const e of edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    if (UNDIRECTED_TYPES.has(e.type)) {
      inbound.get(e.to).push(e.from);
      inbound.get(e.from).push(e.to);
      outbound.get(e.from).push(e.to);
      outbound.get(e.to).push(e.from);
      outDeg.set(e.from, outDeg.get(e.from) + 1);
      outDeg.set(e.to, outDeg.get(e.to) + 1);
      inDeg.set(e.from, inDeg.get(e.from) + 1);
      inDeg.set(e.to, inDeg.get(e.to) + 1);
    } else {
      outbound.get(e.from).push(e.to);
      inbound.get(e.to).push(e.from);
      outDeg.set(e.from, outDeg.get(e.from) + 1);
      inDeg.set(e.to, inDeg.get(e.to) + 1);
    }
  }

  // PageRank: PR(n) = (1-d)/N + d * (sum(PR(m)/outdeg(m) for m in inbound(n)) + danglingSum/N)
  const N = nodeIds.size;
  let pr = new Map();
  for (const id of nodeIds) pr.set(id, 1 / N);

  for (let iter = 0; iter < iterations; iter++) {
    let danglingSum = 0;
    for (const id of nodeIds) {
      if (outbound.get(id).length === 0) danglingSum += pr.get(id);
    }
    const danglingShare = danglingSum / N;
    const base = (1 - damping) / N;

    const next = new Map();
    for (const id of nodeIds) {
      let sum = 0;
      for (const m of inbound.get(id)) {
        const outM = outbound.get(m).length;
        if (outM > 0) sum += pr.get(m) / outM;
      }
      next.set(id, base + damping * (sum + danglingShare));
    }
    pr = next;
  }

  const result = new Map();
  for (const id of nodeIds) {
    result.set(id, {
      inDegree: inDeg.get(id),
      outDegree: outDeg.get(id),
      pageRank: pr.get(id),
    });
  }
  return result;
}
