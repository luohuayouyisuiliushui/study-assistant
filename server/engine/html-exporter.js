/**
 * HTML Export Engine - Self-contained study note HTML generation.
 * All CSS/JS inlined. No CDN dependencies.
 */

import { parseExercisesFromDetail, getTopicHistory } from './store/crud.js';

const HL = {
  js: [
    { p: /\/\/.*$/gm, c: 'h-c' }, { p: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, c: 'h-s' },
    { p: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|class|import|export|from|async|await|yield|throw|try|catch|finally|this|super|in|of|true|false|null|undefined|NaN)\b/g, c: 'h-k' },
    { p: /\b(\d+\.?\d*)\b/g, c: 'h-n' },
  ],
  python: [
    { p: /#.*$/gm, c: 'h-c' },
    { p: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, c: 'h-s' },
    { p: /\b(def|class|if|elif|else|for|while|import|from|as|return|yield|try|except|finally|raise|with|pass|break|continue|lambda|async|await|True|False|None|in|not|and|or|is|del|global|nonlocal)\b/g, c: 'h-k' },
    { p: /\b(\d+\.?\d*)\b/g, c: 'h-n' },
  ],
  html: [
    { p: /&lt;!--[\s\S]*?--&gt;/g, c: 'h-c' },
    { p: /&lt;\/?[\w-]+(?:\s[^>]*)?&gt;/g, c: 'h-t' },
    { p: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, c: 'h-s' },
    { p: /\b(class|id|style|src|href|rel|type|name|value|data-\w+)\s*=/g, c: 'h-a' },
  ],
  css: [
    { p: /\/\*[\s\S]*?\*\//g, c: 'h-c' },
    { p: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, c: 'h-s' },
    { p: /(\.[\w-]+|#[\w-]+|[\w-]+(?=\s*\{))/g, c: 'h-se' },
    { p: /\b(color|background|margin|padding|font-size|display|position|width|height|border|text-align|flex|grid)\b/g, c: 'h-p' },
  ],
  bash: [
    { p: /#.*$/gm, c: 'h-c' }, { p: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, c: 'h-s' },
    { p: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|source|cd|echo|printf|read|set|unset)\b/g, c: 'h-k' },
    { p: /\$[\w{}]+/g, c: 'h-v' },
  ],
};


const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε',
  Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ',
  Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο',
  Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ',
  Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
};

function highlight(code, lang) {
  var rules = HL[lang];
  if (!rules) return esc(code);
  var r = esc(code);
  for (var i = 0; i < rules.length; i++) {
    r = r.replace(rules[i].p, function(m) { return '<span class="' + rules[i].c + '">' + m + '</span>'; });
  }
  return r;
}

function renderCodeBlock(code, lang) {
  var l = (lang || 'text').toLowerCase();
  return '<pre><code class="lang-' + l + '">' + highlight(code, l) + '</code><button class="copy-btn" onclick="copyCode(this)">复制</button></pre>';
}

function parseMath(expr) {
  var r = expr;
  r = r.replace(/\\frac\{([^}]*)\}\\{([^}]*)\}/g, '<span class="mf"><span class="mn">$1</span><span class="md">$2</span></span>');
  r = r.replace(/\\sqrt(?:\[([^\]]*)\])?\{([^}]*)\}/g, function(_, n, rad) {
    var idx = n ? '<span class="mr">' + n + '</span>' : '';
    return '<span class="ms">' + idx + '<span class="msb">' + rad + '</span></span>';
  });
  r = r.replace(/\\int(?:_\{([^}]*)\})?(?:\^\{([^}]*)\})?/g, function(_, l, u) {
    var h = '∫'; if (l) h += '<sub>' + l + '</sub>'; if (u) h += '<sup>' + u + '</sup>'; return h;
  });
  r = r.replace(/\\sum(?:_\{([^}]*)\})?(?:\^\{([^}]*)\})?/g, function(_, l, u) {
    var h = '∑'; if (l) h += '<sub>' + l + '</sub>'; if (u) h += '<sup>' + u + '</sup>'; return h;
  });
  r = r.replace(/\\prod(?:_\{([^}]*)\})?(?:\^\{([^}]*)\})?/g, function(_, l, u) {
    var h = '∏'; if (l) h += '<sub>' + l + '</sub>'; if (u) h += '<sup>' + u + '</sup>'; return h;
  });
  r = r.replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>');
  r = r.replace(/\^(\w)/g, '<sup>$1</sup>');
  r = r.replace(/_{([^}]*)}/g, '<sub>$1</sub>');
  r = r.replace(/_(\w)/g, '<sub>$1</sub>');
  for (var n in GREEK) {
    if (GREEK.hasOwnProperty(n)) {
      r = r.replace(new RegExp('\\\\' + n + '\\b', 'g'), GREEK[n]);
    }
  }
  r = r.replace(/\\(sin|cos|tan|cot|sec|csc|log|ln|lim|exp|det|dim|ker|hom|Pr|max|min|sup|inf)\/g, '<span class="mf">$1</span>');
  r = r.replace(/\\to\/g, '→').replace(/\\Rightarrow\/g, '⇒').replace(/\\Leftarrow\/g, '⇐');
  r = r.replace(/\\infty\/g, '∞').replace(/\\partial\/g, '∂').replace(/\\nabla\/g, '∇');
  r = r.replace(/\\times\/g, '×').replace(/\\div\/g, '÷').replace(/\\pm\/g, '±').replace(/\\cdot\/g, '·');
  r = r.replace(/\\approx\/g, '≈').replace(/\\neq\/g, '≠').replace(/\\leq\/g, '≤').replace(/\\geq\/g, '≥');
  r = r.replace(/\\subset\/g, '⊂').replace(/\\supset\/g, '⊃').replace(/\\subseteq\/g, '⊆').replace(/\\supseteq\/g, '⊇');
  r = r.replace(/\\cup\/g, '∪').replace(/\\cap\/g, '∩').replace(/\\in\/g, '∈').replace(/\\notin\/g, '∉');
  r = r.replace(/\\forall\/g, '∀').replace(/\\exists\/g, '∃').replace(/\\emptyset\/g, '∅');
  r = r.replace(/\\,/g, ' ').replace(/\\;/g, '  ').replace(/\\quad\/g, '  ').replace(/\\qquad\/g, '    ');
  r = r.replace(/\\left\(/g, '(').replace(/\\right\)/g, ')').replace(/\\left\[/g, '[').replace(/\\right\]/g, ']');
  r = r.replace(/\\left\{/g, '{').replace(/\\right\}/g, '}');
  return r;
}


function renderInline(text) {
  var r = text;
  r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
  r = r.replace(/\$([^\$]+)\$/g, function(_, m) {
    try { return '<span class="mi">' + parseMath(m.trim()) + '</span>'; }
    catch (e) { return '<span class="mf fb" title="公式无法渲染">' + esc(m) + '</span>'; }
  });
  r = r.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  r = r.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  r = r.replace(/\!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return r;
}

function renderMarkdown(md) {
  if (!md) return '';
  var lines = md.split('\n'), out = [];
  for (var i = 0; i < lines.length;) {
    var line = lines[i], m, items, ql;
    if (m = line.match(/^```(\w*)/)) {
      var lang = m[1], cl = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) cl.push(lines[i]);
      i++; out.push(renderCodeBlock(cl.join('\n'), lang)); continue;
    }
    if (line.startsWith('$$')) {
      var ml = [];
      for (i++; i < lines.length && !lines[i].startsWith('$$'); i++) ml.push(lines[i]);
      i++;
      try { out.push('<div class="mb">' + parseMath(ml.join('\n').trim()) + '</div>'); }
      catch (e) { out.push('<div class="mf fb">[公式无法渲染] ' + esc(ml.join('\n')) + '</div>'); }
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (m = line.match(/^(#{1,4})\s+(.+)$/)) {
      var lv = m[1].length, txt = m[2];
      var id = txt.toLowerCase().replace(/[^\w\u4e00-\u9fff\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      out.push('<h' + lv + ' id="' + id + '">' + renderInline(esc(txt)) + '</h' + lv + '>');
      i++; continue;
    }
    if (line.startsWith('> ')) {
      ql = [];
      while (i < lines.length && lines[i].startsWith('> ')) { ql.push(lines[i].slice(2)); i++; }
      out.push('<blockquote>' + renderInline(esc(ql.join('\n'))) + '</blockquote>');
      continue;
    }
    if (m = line.match(/^[\s]*[-*]\s+/)) {
      items = [];
      while (i < lines.length && (m = lines[i].match(/^[\s]*[-*]\s+/))) { items.push('<li>' + renderInline(esc(lines[i].slice(m[0].length))) + '</li>'); i++; }
      out.push('<ul>' + items.join('') + '</ul>'); continue;
    }
    if (m = line.match(/^\d+\.\s+/)) {
      items = [];
      while (i < lines.length && (m = lines[i].match(/^\d+\.\s+/))) { items.push('<li>' + renderInline(esc(lines[i].slice(m[0].length))) + '</li>'); i++; }
      out.push('<ol>' + items.join('') + '</ol>'); continue;
    }
    if (line.trim() === '') { out.push(''); i++; continue; }
    var pl = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(#{1,4}\s+|```|---+\s*$|>\s|\d+\.\s+|[\s]*[-*]\s+)/)) { pl.push(lines[i]); i++; }
    if (pl.length > 0) { out.push('<p>' + renderInline(esc(pl.join('\n'))) + '</p>'); }
    else i++;
  }
  return out.join('\n');
}

function esc(s) { return typeof s === 'string' ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; }

function extractTOC(detail) {
  if (!detail) return [];
  var toc = [];
  var lines = detail.split('\n');
  for (var j = 0; j < lines.length; j++) {
    var m = lines[j].match(/^(#{1,3})\s+(.+)$/);
    if (m) {
      var lv = m[1].length, t = m[2].trim();
      toc.push({ level: lv, title: t, id: t.toLowerCase().replace(/[^\w\u4e00-\u9fff\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') });
    }
  }
  return toc;
}

export function generateHTML(plan, topicId) {
  var topic = plan && plan.topics && plan.topics.find(function(t) { return t.id === topicId; });
  if (!topic || !topic.detail) return '';
  var exercises = parseExercisesFromDetail(topic.detail);
  var history = getTopicHistory(plan, topicId);
  var toc = extractTOC(topic.detail);
  var qaPairs = [];
  for (var i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
      qaPairs.push({ q: history[i].content, a: history[i + 1].content });
      i++;
    }
  }
  var rc = renderMarkdown(topic.detail);
  return buildDoc({
    title: topic.title, planName: plan.name,
    toc: renderTOC(toc), content: rc,
    exercises: renderExercises(exercises), qaHistory: renderQA(qaPairs),
    meta: renderMeta(topic, plan),
    hasEx: exercises.length > 0, hasQA: qaPairs.length > 0, hasTOC: toc.length > 0,
  });
}

function renderTOC(toc) {
  if (!toc.length) return '';
  var items = toc.map(function(e) {
    var indent = e.level > 1 ? ' style="padding-left:' + ((e.level - 1) * 16) + 'px"' : '';
    return '<li' + indent + '><a href="#' + e.id + '">' + esc(e.title) + '</a></li>';
  }).join('\n');
  return '<ul>' + items + '</ul>';
}

function cleanQuestion(q) {
  return q.replace(/^>\s*\*\*练习题\s*\d+\*\*\s*[（(][^)）]+[)）]\s*[：:]\s*/, '').trim();
}

function renderExercises(ex) {
  if (!ex.length) return '';
  return '<section class="es"><h2>📝 练习题答案</h2>' + ex.map(function(e, i) {
    var opts = (e.options || []).map(function(o) { return '<li>' + esc(o) + '</li>'; }).join('');
    return '<details class="ei"><summary>' + esc(String(i + 1)) + '. ' + esc(cleanQuestion(e.question)) + '</summary><div class="ea">' + (opts ? '<ul class="eo">' + opts + '</ul>' : '') + '<p><strong>答案：</strong>' + esc(e.answer || '') + '</p>' + (e.explanation ? '<p><strong>解析：</strong>' + esc(e.explanation) + '</p>' : '') + (e.conceptTag ? '<p><strong>关联概念：</strong>' + esc(e.conceptTag) + '</p>' : '') + '</div></details>';
  }).join('\n') + '</section>';
}

function renderQA(qa) {
  if (!qa.length) return '';
  return '<section class="qs"><h2>💬 扩展讨论</h2>' + qa.map(function(p, i) {
    return '<div class="qi"><div class="qq"><strong>Q' + (i + 1) + ':</strong> ' + esc(p.q) + '</div><div class="qa"><strong>A:</strong> ' + esc(p.a) + '</div></div>';
  }).join('\n') + '</section>';
}

function renderMeta(topic, plan) {
  var p = ['<span class="mp">📚 ' + esc(plan.name) + '</span>'];
  if (topic.difficulty) p.push('<span class="md">📊 ' + esc(topic.difficulty) + '</span>');
  if (topic.timeSpent) p.push('<span class="mt">⏱ ' + Math.round(topic.timeSpent / 60) + ' 分钟</span>');
  p.push('<span class="ms">' + (topic.done ? '\u2705 已完成' : '📖 学习中') + '</span>');
  return '<div class="meta">' + p.join('') + '</div>';
}

var CSS = [
  '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
  'html{font-size:16px;scroll-behavior:smooth}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.7;color:#1a1a2e;background:#f8f9fa;transition:color .3s,background .3s}',
  'a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}',
  'img{max-width:100%;height:auto;border-radius:6px}',
  'hr{border:none;border-top:1px solid #e2e8f0;margin:2em 0}',
  '.wrapper{display:flex;min-height:100vh}',
  '.toc{position:sticky;top:0;width:280px;height:100vh;overflow-y:auto;background:#fff;border-right:1px solid #e2e8f0;padding:1.5rem;flex-shrink:0;z-index:10}',
  '.toc h3{font-size:.9rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1rem}',
  '.toc ul{list-style:none}.toc li{margin-bottom:.4rem}',
  '.toc a{font-size:.85rem;color:#475569;display:block;padding:.2rem 0;border-radius:4px;transition:color .2s}.toc a:hover{color:#2563eb}',
  '.main{flex:1;max-width:860px;padding:2.5rem 3rem;margin:0 auto}',
  '.toc-toggle{display:none;position:fixed;top:1rem;left:1rem;z-index:20;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:.5rem .7rem;cursor:pointer;font-size:1.2rem;box-shadow:0 1px 3px rgba(0,0,0,.1)}',
  'header{margin-bottom:2rem;padding-bottom:1.5rem;border-bottom:2px solid #e2e8f0}header h1{font-size:2rem;font-weight:700;color:#0f172a;margin-bottom:.5rem}',
  '.meta{display:flex;flex-wrap:wrap;gap:.8rem;font-size:.85rem;color:#64748b}.meta span{background:#f1f5f9;padding:.25rem .6rem;border-radius:4px}',
  '.body h2{font-size:1.5rem;font-weight:600;color:#0f172a;margin:2rem 0 .8rem;padding-bottom:.4rem;border-bottom:1px solid #e2e8f0}',
  '.body h3{font-size:1.2rem;font-weight:600;color:#1e293b;margin:1.5rem 0 .6rem}.body h4{font-size:1.05rem;font-weight:600;color:#334155;margin:1.2rem 0 .4rem}',
  '.body p{margin:.6rem 0}.body ul,.body ol{margin:.6rem 0;padding-left:1.5rem}.body li{margin:.3rem 0}',
  '.body blockquote{border-left:4px solid #2563eb;background:#f1f5f9;padding:.6rem 1rem;margin:.8rem 0;border-radius:0 6px 6px 0;color:#475569}',
  '.body code{background:#f1f5f9;padding:.15rem .4rem;border-radius:4px;font-size:.9em;font-family:"JetBrains Mono","Fira Code","Consolas",monospace;color:#2563eb}',
  '.body pre{position:relative;background:#1e293b;color:#e2e8f0;padding:1rem 1.2rem;border-radius:8px;overflow-x:auto;margin:1rem 0;font-size:.88rem;line-height:1.6;font-family:"JetBrains Mono","Fira Code","Consolas",monospace}',
  '.body pre code{background:transparent;color:inherit;padding:0;font-size:inherit}',
  '.copy-btn{position:absolute;top:.5rem;right:.5rem;background:rgba(255,255,255,.1);color:#94a3b8;border:1px solid rgba(255,255,255,.15);border-radius:4px;padding:.2rem .6rem;font-size:.75rem;cursor:pointer;transition:all .2s;opacity:0}',
  'pre:hover .copy-btn{opacity:1}.copy-btn:hover{background:rgba(255,255,255,.2);color:#e2e8f0}.copy-btn.copied{background:#22c55e;color:#fff;border-color:#22c55e}',
  '.h-c{color:#94a3b8;font-style:italic}.h-k{color:#c084fc;font-weight:500}.h-s{color:#34d399}.h-n{color:#fbbf24}',
  '.h-v{color:#f472b6}.h-t{color:#f87171}.h-a{color:#fb923c}.h-se{color:#60a5fa}.h-p{color:#a78bfa}',
  '.mi{display:inline;padding:.1rem .2rem;font-family:"Times New Roman",serif;font-style:italic}',
  '.mb{display:block;text-align:center;padding:.8rem;margin:.8rem 0;background:#f1f5f9;border-radius:8px;font-family:"Times New Roman",serif;font-style:italic;font-size:1.1rem;overflow-x:auto}',
  '.fb{color:#dc2626;font-style:normal;font-size:.85rem}.mf{font-family:"Times New Roman",serif}',
  '.mn{border-bottom:1px solid;padding:0 .3rem .1rem}.md{padding:.1rem .3rem 0}',
  '.ms{display:inline-flex;align-items:flex-start}.ms::before{content:"\\221A";font-size:1.2em;margin-right:2px}.msb{border-top:1px solid;padding:0 .2rem}.mr{font-size:.7em;vertical-align:super;margin-right:2px}',
  '.es,.qs{margin-top:2.5rem;padding-top:1.5rem;border-top:2px solid #e2e8f0}.es h2,.qs h2{font-size:1.3rem;font-weight:600;color:#0f172a;margin-bottom:1rem}',
  '.ei{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin:.8rem 0;overflow:hidden}',
  '.ei summary{padding:.8rem 1rem;cursor:pointer;font-weight:500;color:#1e293b;background:#f1f5f9;transition:background .2s}.ei summary:hover{background:#e2e8f0}',
  '.ea{padding:.8rem 1rem;border-top:1px solid #e2e8f0}.ea p{margin:.4rem 0}.eo{list-style:none;padding:0;margin:.4rem 0}.eo li{padding:.2rem 0;color:#475569}',
  '.qi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:1rem;margin:.8rem 0}.qq{color:#0f172a;margin-bottom:.4rem;font-weight:500}',
  '.qa{color:#475569;padding-left:1rem;border-left:3px solid #2563eb}',
  'footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid #e2e8f0;font-size:.8rem;color:#94a3b8;text-align:center}',
  '@media(prefers-color-scheme:dark){body{color:#e2e8f0;background:#0f172a}.toc{background:#1e293b;border-right-color:#334155}.toc h3{color:#94a3b8}.toc a{color:#94a3b8}.toc a:hover{color:#60a5fa}header h1{color:#f1f5f9}.body h2{color:#f1f5f9;border-bottom-color:#334155}.body h3{color:#e2e8f0}.body h4{color:#cbd5e1}.body blockquote{background:#1e293b;color:#94a3b8}.body code{background:#1e293b;color:#60a5fa}.meta span{background:#1e293b;color:#94a3b8}.ei{background:#1e293b;border-color:#334155}.ei summary{background:#1e293b;color:#e2e8f0}.ei summary:hover{background:#334155}.ea{color:#cbd5e1}.qi{background:#1e293b;border-color:#334155}.qq{color:#e2e8f0}.qa{color:#94a3b8}.mb{background:#1e293b}.toc-toggle{background:#1e293b;color:#e2e8f0;border-color:#334155}footer{color:#475569}}',
  'body.dark{color:#e2e8f0;background:#0f172a}',
  'body.dark .toc{background:#1e293b;border-right-color:#334155}body.dark .toc h3{color:#94a3b8}body.dark .toc a{color:#94a3b8}body.dark .toc a:hover{color:#60a5fa}',
  'body.dark header h1{color:#f1f5f9}body.dark .body h2{color:#f1f5f9;border-bottom-color:#334155}body.dark .body h3{color:#e2e8f0}body.dark .body h4{color:#cbd5e1}',
  'body.dark .body blockquote{background:#1e293b;color:#94a3b8}body.dark .body code{background:#1e293b;color:#60a5fa}body.dark .meta span{background:#1e293b;color:#94a3b8}',
  'body.dark .ei{background:#1e293b;border-color:#334155}body.dark .ei summary{background:#1e293b;color:#e2e8f0}body.dark .ei summary:hover{background:#334155}body.dark .ea{color:#cbd5e1}',
  'body.dark .qi{background:#1e293b;border-color:#334155}body.dark .qq{color:#e2e8f0}body.dark .qa{color:#94a3b8}body.dark .mb{background:#1e293b}',
  'body.dark .toc-toggle{background:#1e293b;color:#e2e8f0;border-color:#334155}body.dark footer{color:#475569}',
  '@media(max-width:768px){.toc{position:fixed;left:-300px;top:0;height:100vh;transition:left .3s ease;box-shadow:2px 0 12px rgba(0,0,0,.15)}.toc.open{left:0}.toc-toggle{display:block}.main{padding:1.5rem 1rem;max-width:100%}header h1{font-size:1.5rem}.body h2{font-size:1.25rem}.body h3{font-size:1.1rem}}',
  '@media print{.toc,.toc-toggle,.copy-btn{display:none!important}.main{max-width:100%;padding:0}body{color:#000;background:#fff}a{color:#000;text-decoration:underline}pre{background:#f5f5f5!important;color:#333!important;border:1px solid #ddd;page-break-inside:avoid}.ei{break-inside:avoid}}',
].join('');

var JS = [
  'function toggleTOC(){document.getElementById("tocSidebar").classList.toggle("open")}',
  'function toggleDarkMode(){document.body.classList.toggle("dark")}',
  'function copyCode(btn){var code=btn.parentElement.querySelector("code");var text=code.textContent||code.innerText;navigator.clipboard.writeText(text).then(function(){btn.textContent="已复制";btn.classList.add("copied");setTimeout(function(){btn.textContent="复制";btn.classList.remove("copied")},2000)})}',
  'document.addEventListener("click",function(e){var toc=document.getElementById("tocSidebar");if(toc.classList.contains("open")&&!toc.contains(e.target)&&!e.target.matches(".toc-toggle")){toc.classList.remove("open")}})',
].join('\n');

function buildDoc(d) {
  var dt = new Date().toISOString().slice(0, 10);
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>' + esc(d.title) + ' \u2014 \u5b66\u4e60\u7b14\u8bb0</title>\n<style>' + CSS + '</style>\n</head>\n<body>\n<div class="wrapper">\n<button class="toc-toggle" onclick="toggleTOC()" aria-label="\u5207\u6362\u76ee\u5f55">\u2630</button>\n<nav class="toc" id="tocSidebar">\n<h3>\u{1f4d1} \u76ee\u5f55</h3>\n' + (d.hasTOC ? d.toc : '<p style="color:#94a3b8;font-size:.85rem">\u65e0\u7ae0\u8282\u5185\u5bb9</p>') + '\n<div style="margin-top:2rem;padding-top:1rem;border-top:1px solid #e2e8f0">\n<button onclick="toggleDarkMode()" style="width:100%;padding:.5rem;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;font-size:.85rem;color:#475569;transition:all .2s">\u{1f313} \u5207\u6362\u6697\u8272\u6a21\u5f0f</button>\n</div>\n</nav>\n<main class="main">\n<header>\n<h1>' + esc(d.title) + '</h1>\n' + d.meta + '\n</header>\n<article class="body">\n' + d.content + '\n</article>\n' + (d.hasEx ? d.exercises : '') + '\n' + (d.hasQA ? d.qaHistory : '') + '\n<footer>\n<p>\u7531 \u77e5\u8bc6\u70b9\u5b66\u4e60\u52a9\u624b \u751f\u6210 \u00b7 \u5bfc\u51fa\u65e5\u671f\uff1a' + dt + '</p>\n</footer>\n</main>\n</div>\n<script>' + JS + '</script>\n</body>\n</html>';
}

export default { generateHTML };
