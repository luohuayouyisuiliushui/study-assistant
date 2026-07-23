/**
 * Export Engine — Deep format binding for learning content.
 *
 * === DESIGN ===
 *
 * This is the "deep integration" layer that differentiates the product from
 * generic AI tools. Instead of just generating text in a web page, we provide
 * structured exports that bind to the tools real learners use every day:
 *
 * 1. Anki flashcards (CSV with cloze + basic cards)
 * 2. Mubu/幕布 outline (OPML format, importable by mind-mapping tools)
 * 3. Notion database (CSV with columns for title/tags/difficulty/status)
 * 4. Structured JSON (for programmatic consumption by other tools)
 * 5. Markdown study notes (self-contained with exercises + Q&A)
 *
 * All exports are pure computation — no AI calls, instant response.
 */

import { parseExercisesFromDetail, getTopicHistory } from './store/crud.js';

// ═══════════════════════════════════════════════════════
//  RICH MARKUP SANITIZER (for plain-text export targets)
// ═══════════════════════════════════════════════════════

/**
 * Strip or replace rich Markdown markup that cannot be rendered by external
 * tools like Anki (without plugins) or OPML readers.
 *
 * Rules:
 *  - Mermaid fenced blocks  → "[图表]"
 *  - Block LaTeX ($$…$$)    → "[公式]"
 *  - Inline LaTeX ($…$)     → kept as-is (Anki-KaTeX plugin can render it)
 *  - Generic fenced code    → kept as-is (Anki renders <pre> blocks acceptably)
 *  - HTML tags              → stripped (for OPML _note attributes)
 *
 * @param {string} md - Raw Markdown string
 * @param {{ stripHtml?: boolean }} options
 * @returns {string}
 */
function stripRichMarkup(md, { stripHtml = false } = {}) {
  if (!md) return '';
  // 1. Mermaid blocks (fenced, case-insensitive language tag)
  let text = md.replace(/```mermaid[\s\S]*?```/gi, '[图表]');
  // 2. Block LaTeX: $$…$$ (may span multiple lines)
  text = text.replace(/\$\$[\s\S]*?\$\$/g, '[公式]');
  // 3. Strip HTML tags when targeting XML attributes (OPML _note)
  if (stripHtml) {
    text = text.replace(/<[^>]+>/g, '');
  }
  return text;
}

// ═══════════════════════════════════════════════════════
//  DATA EXTRACTION HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Extract headings and their content from Markdown detail.
 * Returns [{ level, title, content, startIndex }] for structural parsing.
 */
function extractSections(detail) {
  if (!detail) return [];
  const lines = detail.split('\n');
  const sections = [];
  let currentSection = null;

  const headingRegex = /^(#{1,4})\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingRegex);
    if (match) {
      if (currentSection) {
        currentSection.content = currentSection.lines.join('\n').trim();
        delete currentSection.lines;
        sections.push(currentSection);
      }
      currentSection = {
        level: match[1].length,
        title: match[2].trim(),
        content: '',
        lines: [],
        startIndex: i,
      };
    } else if (currentSection) {
      currentSection.lines.push(lines[i]);
    } else {
      // Content before first heading → preamble
      currentSection = { level: 0, title: '__preamble__', content: '', lines: [lines[i]], startIndex: 0 };
    }
  }

  if (currentSection) {
    currentSection.content = currentSection.lines.join('\n').trim();
    delete currentSection.lines;
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Extract all code blocks from markdown with their language tags.
 */
function extractCodeBlocks(detail) {
  if (!detail) return [];
  const blocks = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(detail)) !== null) {
    blocks.push({ language: match[1] || 'text', code: match[2].trim() });
  }
  return blocks;
}

/**
 * Extract key-value pairs from sections (e.g. "端口号: 0-65535").
 */
function extractKeyFacts(detail) {
  if (!detail) return [];
  const facts = [];
  const lines = detail.split('\n');
  // Patterns: "名称：值", "名称: 值", "- **名称**：值", bullet points with key info
  const kvRegex = /[-*]\s*(?:\*\*)?([^*\n]+?)(?:\*\*)?\s*[：:]\s*(.+)/g;
  for (const line of lines) {
    let match;
    while ((match = kvRegex.exec(line)) !== null) {
      const key = match[1].replace(/\*\*/g, '').trim();
      const value = match[2].replace(/\*\*/g, '').trim();
      if (key.length > 1 && value.length > 0 && key.length < 50 && value.length < 200) {
        facts.push({ key, value });
      }
    }
  }
  return facts;
}

// ═══════════════════════════════════════════════════════
//  1. ANKI FLASHCARD EXPORT (CSV)
// ═══════════════════════════════════════════════════════

/**
 * Generate Anki flashcards as a CSV string (UTF-8 BOM for Anki compatibility).
 *
 * Card types generated:
 * - Basic: Q&A from exercises (front = question, back = answer + explanation)
 * - Cloze: Key facts with blanked-out values
 * - Basic: Section title → summary (for structural review)
 *
 * CSV columns: Type, Front, Back, Tags, Extra
 */
export function generateAnkiCSV(plan, topicId) {
  if (!plan) return '';
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic || !topic.detail) return '';

  const rows = [];
  // Add BOM for Anki UTF-8 compatibility
  const bom = '﻿';

  // CSV escaping: wrap in quotes, double any internal quotes
  const esc = (s) => '"' + (s || '').replace(/"/g, '""').replace(/\n/g, '<br>') + '"';

  // Column headers
  rows.push(`${bom}Type,Front,Back,Tags,Extra`);

  const tags = `${plan.name.replace(/[,\s]+/g, '_')} ${topic.title.replace(/[,\s]+/g, '_')}`;

  // 1. Exercise-based Basic cards
  const exercises = parseExercisesFromDetail(topic.detail);
  for (const ex of exercises) {
    let front = ex.question || '';
    let back = '';
    if (ex.options && ex.options.length > 0) {
      front += '<br><br>' + ex.options.map(o => o.replace(/^[A-D][.．、]\s*/, '')).join('<br>');
    }
    back += `<b>答案：${ex.answer || ''}</b>`;
    if (ex.explanation) back += `<br><br><i>${ex.explanation}</i>`;
    if (ex.conceptTag) back += `<br><br>关联概念：${ex.conceptTag}`;
    rows.push(`Basic,${esc(front)},${esc(back)},${esc(tags)},`);
  }

  // 2. Section-based Basic cards (section title → summary)
  const sections = extractSections(topic.detail);
  for (const section of sections) {
    if (section.level === 0 || section.title === '__preamble__') continue;
    const content = stripRichMarkup(section.content || '').slice(0, 500);
    if (content.length < 20) continue;
    rows.push(
      `Basic,${esc(`「${topic.title}」— ${section.title}`)},${esc(content)},${esc(tags)},`
    );
  }

  // 3. Cloze cards from key facts
  const facts = extractKeyFacts(topic.detail);
  for (const fact of facts.slice(0, 8)) {
    const clozeText = `${fact.key}：{{c1::${fact.value}}}`;
    rows.push(`Cloze,${esc(clozeText)},,${esc(tags)},${esc(`来源：${topic.title}`)}`);
  }

  // 4. Q&A from history (if any relevant)
  const history = getTopicHistory(plan, topicId);
  const pairs = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
      pairs.push({ q: history[i].content, a: history[i + 1].content.slice(0, 400) });
      i++;
    }
  }
  for (const pair of pairs.slice(-5)) {
    rows.push(
      `Basic,${esc(pair.q)},${esc(pair.a)},${esc(tags)},${esc('追问记录')}`
    );
  }

  return rows.join('\n');
}

// ═══════════════════════════════════════════════════════
//  2. OPML / MUBU OUTLINE EXPORT
// ═══════════════════════════════════════════════════════

/**
 * Generate an OPML outline from topic detail sections.
 * This format is importable by 幕布 (Mubu), XMind, Workflowy, and other
 * outlining / mind-mapping tools.
 *
 * Structure:
 *   - Topic title (root)
 *     - H2 sections
 *       - H3 subsections
 *         - H4 detailed points
 */
export function generateOPML(plan, topicId) {
  const topic = plan?.topics?.find(t => t.id === topicId);
  if (!topic || !topic.detail) return '';

  const esc = (s) => (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const sections = extractSections(topic.detail);
  if (sections.length === 0) return '';

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<opml version="2.0">');
  lines.push('  <head>');
  lines.push(`    <title>${esc(topic.title)}</title>`);
  lines.push(`    <dateCreated>${new Date().toISOString()}</dateCreated>`);
  lines.push('  </head>');
  lines.push('  <body>');
  lines.push(`    <outline text="${esc(topic.title)}" _note="${esc('学习笔记 — 由知识点学习助手生成')}">`);

  // Build a tree from sections
  const rootSections = sections.filter(s => s.level === 2);
  for (const section of rootSections) {
    const hasSubsections = sections.some(s => s.level > 2 && s.startIndex > section.startIndex);
    const subsections = [];
    if (hasSubsections) {
      let collecting = false;
      for (const s of sections) {
        if (s === section) { collecting = true; continue; }
        if (collecting && s.level > 2) subsections.push(s);
        if (collecting && s.level === 2 && s !== section) break;
      }
    }

    if (subsections.length > 0) {
      lines.push(`      <outline text="${esc(section.title)}">`);
      for (const sub of subsections) {
        const excerpt = stripRichMarkup(sub.content || '', { stripHtml: true }).slice(0, 200).replace(/\n/g, ' ');
        lines.push(`        <outline text="${esc(sub.title)}" _note="${esc(excerpt)}"/>`);
      }
      lines.push('      </outline>');
    } else {
      const excerpt = stripRichMarkup(section.content || '', { stripHtml: true }).slice(0, 200).replace(/\n/g, ' ');
      lines.push(`      <outline text="${esc(section.title)}" _note="${esc(excerpt)}"/>`);
    }
  }

  lines.push('    </outline>');
  lines.push('  </body>');
  lines.push('</opml>');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════
//  3. NOTION DATABASE CSV
// ═══════════════════════════════════════════════════════

/**
 * Export a plan's topics as a Notion-database-importable CSV.
 * Each row = one topic with columns: Title, Status, Difficulty, Tags, Summary, Detail Excerpt
 *
 * This CSV can be imported into Notion via "Import → CSV" to create a database.
 */
export function generateNotionCSV(plan) {
  if (!plan || !plan.topics) return '';
  const bom = '﻿';
  const esc = (s) => '"' + (s || '').replace(/"/g, '""').replace(/\n/g, ' ') + '"';

  const rows = [];
  rows.push(`${bom}Title,Status,Difficulty,Tags,Summary,Detail Excerpt,Weak Points,Review`);

  for (const topic of plan.topics) {
    const status = topic.done ? '已完成' : topic.lastError ? '生成失败' : topic.detail ? '已生成' : '待学习';
    const difficulty = topic.difficulty || '';
    const tags = plan.name.replace(/[,\s]+/g, ',');
    const summary = (() => {
      if (!topic.detail) return '';
      // Take first ~150 chars after the title
      const lines = topic.detail.split('\n');
      let start = false;
      const content = [];
      for (const line of lines) {
        if (line.startsWith('#')) { start = true; continue; }
        if (start && line.trim()) content.push(line.trim());
        if (content.join(' ').length > 150) break;
      }
      return content.join(' ');
    })();
    const excerpt = stripRichMarkup(topic.detail || '', { stripHtml: true }).slice(0, 300).replace(/\n/g, ' ');
    const weakPoints = (topic.weakPoints || []).join('; ');
    const reviewNeeded = ((topic.weakPoints || []).length > 0 || (topic.exercises || []).some(e => e.correct === false)) ? '需要复习' : '';

    rows.push(
      `${esc(topic.title)},${esc(status)},${esc(difficulty)},${esc(tags)},${esc(summary)},${esc(excerpt)},${esc(weakPoints)},${esc(reviewNeeded)}`
    );
  }

  return rows.join('\n');
}

// ═══════════════════════════════════════════════════════
//  4. STRUCTURED JSON EXPORT
// ═══════════════════════════════════════════════════════

/**
 * Export a single topic's full data as structured JSON.
 * Includes: topic metadata, detail, exercises, Q&A history, weak points,
 * fact-check results, teaching errors, and time spent.
 *
 * This is the most comprehensive format — suitable for programmatic
 * consumption, backup, or feeding into other tools.
 */
export function generateTopicJSON(plan, topicId) {
  const topic = plan?.topics?.find(t => t.id === topicId);
  if (!topic) return null;

  const history = getTopicHistory(plan, topicId);
  const qaPairs = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
      qaPairs.push({
        question: history[i].content,
        answer: history[i + 1].content,
        askedAt: history[i].timestamp,
        answeredAt: history[i + 1].timestamp,
      });
      i++;
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    planName: plan.name,
    topic: {
      id: topic.id,
      title: topic.title,
      difficulty: topic.difficulty || null,
      done: topic.done || false,
      timeSpent: topic.timeSpent || 0,
      level: topic.level || 1,
      phaseId: topic.phaseId || null,
      parentId: topic.parentId || null,
    },
    content: {
      detail: topic.detail || null,
      sections: extractSections(topic.detail || ''),
      codeBlocks: extractCodeBlocks(topic.detail || ''),
      keyFacts: extractKeyFacts(topic.detail || ''),
    },
    exercises: (topic.exercises || []).map(e => ({
      id: e.id,
      type: e.type,
      question: e.question,
      options: e.options,
      correctAnswer: e.answer,
      explanation: e.explanation,
      conceptTag: e.conceptTag,
      userAnswer: e.userAnswer,
      correct: e.correct,
    })),
    qaHistory: qaPairs,
    weakPoints: topic.weakPoints || [],
    teachingErrors: (topic.teachingErrors || []).map(e => ({
      location: e.location,
      description: e.description,
      errorType: e.errorType,
      misconception: e.misconception,
      recognized: e.recognized,
    })),
    factCheck: topic.factCheck || null,
    review: topic.reviewGenerated || null,
    feynmanInsights: topic.feynmanInsights || null,
  };
}

// ═══════════════════════════════════════════════════════
//  5. STUDY NOTES MARKDOWN (enhanced)
// ═══════════════════════════════════════════════════════

/**
 * Generate self-contained study notes including all metadata.
 * Unlike the simple Markdown export in the frontend, this includes:
 * - Frontmatter (YAML: title, date, difficulty, topics, tags)
 * - Table of contents
 * - Exercises with answers (collapsed)
 * - Q&A history
 * - Review section
 */
export function generateStudyNotes(plan, topicId) {
  const topic = plan?.topics?.find(t => t.id === topicId);
  if (!topic || !topic.detail) return '';

  const lines = [];

  // YAML frontmatter
  lines.push('---');
  lines.push(`title: "${topic.title}"`);
  lines.push(`plan: "${plan.name}"`);
  lines.push(`date: ${new Date().toISOString().slice(0, 10)}`);
  if (topic.difficulty) lines.push(`difficulty: ${topic.difficulty}`);
  lines.push(`status: ${topic.done ? 'completed' : 'in-progress'}`);
  if (topic.timeSpent) lines.push(`timeSpent: ${Math.round(topic.timeSpent / 60)}m`);
  const weakTags = (topic.weakPoints || []).join(', ');
  if (weakTags) lines.push(`weakPoints: [${weakTags}]`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${topic.title}`);
  lines.push('');

  // Content
  lines.push(topic.detail);

  // Exercises section
  const exercises = parseExercisesFromDetail(topic.detail);
  if (exercises.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 📝 练习题答案');
    lines.push('');
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      lines.push(`### ${i + 1}. ${ex.question}`);
      lines.push('');
      lines.push(`<details>`);
      lines.push(`<summary>查看答案</summary>`);
      lines.push('');
      lines.push(`**答案**: ${ex.answer}`);
      if (ex.explanation) lines.push(`\n**解析**: ${ex.explanation}`);
      if (ex.conceptTag) lines.push(`\n**关联概念**: ${ex.conceptTag}`);
      lines.push('');
      lines.push(`</details>`);
      lines.push('');
    }
  }

  // Q&A history
  const history = getTopicHistory(plan, topicId);
  const qaPairs = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
      qaPairs.push({ q: history[i].content, a: history[i + 1].content });
      i++;
    }
  }
  if (qaPairs.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 💬 扩展讨论');
    lines.push('');
    for (let i = 0; i < qaPairs.length; i++) {
      lines.push(`### Q${i + 1}: ${qaPairs[i].q}`);
      lines.push('');
      lines.push(qaPairs[i].a);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════
//  CONVENIENCE: BULK PLAN EXPORT
// ═══════════════════════════════════════════════════════

/**
 * Export an entire plan as a JSON data bundle (all topics + metadata).
 * Suitable for backup, syncing, or feeding to analytics tools.
 */
export function exportPlanBundle(plan) {
  if (!plan) return null;

  const topics = (plan.topics || []).map(t => ({
    id: t.id,
    title: t.title,
    done: t.done || false,
    difficulty: t.difficulty || null,
    level: t.level || 1,
    timeSpent: t.timeSpent || 0,
    hasDetail: !!t.detail,
    exerciseCount: (t.exercises || []).length,
    correctExercises: (t.exercises || []).filter(e => e.correct === true).length,
    weakPointCount: (t.weakPoints || []).length,
    hasReview: !!t.reviewGenerated,
  }));

  return {
    exportedAt: new Date().toISOString(),
    plan: {
      id: plan.id,
      name: plan.name,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      topicCount: plan.topics?.length || 0,
      completedTopics: topics.filter(t => t.done).length,
      phases: (plan.phases || []).map(p => ({ name: p.name, order: p.order })),
    },
    topics,
    examCount: (plan.examPapers || []).length,
    totalQuestions: (plan.history || []).filter(h => h.role === 'user').length,
    version: '1.6.0',
  };
}

export default {
  generateAnkiCSV,
  generateOPML,
  generateNotionCSV,
  generateTopicJSON,
  generateStudyNotes,
  exportPlanBundle,
};
