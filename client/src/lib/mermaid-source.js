const STATE_DIAGRAM_HEADER = /^\s*stateDiagram(?:-v2)?\s*;?\s*$/;
const QUOTED_STATE = '"(?:\\\\.|[^"\\\\])*"';
const STATE_REFERENCE = `(?:${QUOTED_STATE}|\\[\\*\\]|[A-Za-z_][A-Za-z0-9_.-]*)`;
const STATE_DECLARATION = new RegExp(
  `^\\s*state\\s+(${QUOTED_STATE})\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)\\b`
);
const STATE_TRANSITION = new RegExp(
  `^(\\s*)(${STATE_REFERENCE})(\\s*-->\\s*)(${STATE_REFERENCE})(.*)$`
);
const MERGEABLE_STATE_TRANSITION = new RegExp(
  `^(\\s*)(${STATE_REFERENCE})\\s*-->\\s*(${STATE_REFERENCE})(?:\\s*:\\s*(.*?))?\\s*$`
);
const STATE_BLOCK_START = /^\s*state\s+(.+?)\s*\{\s*$/;

function mergeDuplicateTransitions(lines) {
  const transitions = new Map();
  const scope = [];
  const mergedLines = [];
  let changed = false;

  for (const line of lines) {
    const blockStart = line.match(STATE_BLOCK_START);
    if (blockStart) {
      scope.push(blockStart[1]);
      mergedLines.push(line);
      continue;
    }
    if (/^\s*}\s*$/.test(line)) {
      scope.pop();
      mergedLines.push(line);
      continue;
    }

    const transition = line.match(MERGEABLE_STATE_TRANSITION);
    if (!transition) {
      mergedLines.push(line);
      continue;
    }

    const [, indent, from, to, rawLabel = ''] = transition;
    const label = rawLabel.trim();
    const key = `${scope.join('\u0000')}\u0001${from}\u0001${to}`;
    const existing = transitions.get(key);

    if (!existing) {
      transitions.set(key, {
        index: mergedLines.length,
        indent,
        from,
        to,
        labels: label ? [label] : [],
      });
      mergedLines.push(line);
      continue;
    }

    if (label && !existing.labels.includes(label)) existing.labels.push(label);
    const suffix = existing.labels.length > 0 ? ` : ${existing.labels.join('<br/>')}` : '';
    mergedLines[existing.index] = `${existing.indent}${existing.from} --> ${existing.to}${suffix}`;
    changed = true;
  }

  return { lines: mergedLines, changed };
}

/**
 * Mermaid state transitions use identifiers for endpoints. AI output often
 * puts quoted display labels there instead, which the state diagram parser
 * rejects. Declare aliases for those labels and rewrite only the endpoints.
 */
export function normalizeMermaidSource(source) {
  if (typeof source !== 'string' || source.length === 0) return source;

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => STATE_DIAGRAM_HEADER.test(line));
  if (headerIndex === -1) return source;

  const aliasesByLabel = new Map();
  const usedAliases = new Set(source.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []);

  for (const line of lines.slice(headerIndex + 1)) {
    const declaration = line.match(STATE_DECLARATION);
    if (declaration) aliasesByLabel.set(declaration[1], declaration[2]);
  }

  let aliasIndex = 1;
  const declarations = [];
  const aliasFor = (quotedLabel) => {
    const existing = aliasesByLabel.get(quotedLabel);
    if (existing) return existing;

    let alias;
    do {
      alias = `mermaid_state_${aliasIndex++}`;
    } while (usedAliases.has(alias));

    usedAliases.add(alias);
    aliasesByLabel.set(quotedLabel, alias);
    declarations.push({ quotedLabel, alias });
    return alias;
  };

  let changed = false;
  const normalizedLines = lines.map((line) => {
    const transition = line.match(STATE_TRANSITION);
    if (!transition) return line;

    const [, indent, rawFrom, arrow, rawTo, suffix] = transition;
    const from = rawFrom.startsWith('"') ? aliasFor(rawFrom) : rawFrom;
    const to = rawTo.startsWith('"') ? aliasFor(rawTo) : rawTo;
    if (from !== rawFrom || to !== rawTo) changed = true;
    return `${indent}${from}${arrow}${to}${suffix}`;
  });

  if (declarations.length > 0) {
    const firstContentLine = lines.slice(headerIndex + 1).find(line => line.trim());
    const indent = firstContentLine?.match(/^\s*/)?.[0] || '    ';
    const declarationLines = declarations.map(
      ({ quotedLabel, alias }) => `${indent}state ${quotedLabel} as ${alias}`
    );
    normalizedLines.splice(headerIndex + 1, 0, ...declarationLines);
  }

  const merged = mergeDuplicateTransitions(normalizedLines);
  if (!changed && !merged.changed) return source;

  return merged.lines.join(newline);
}
