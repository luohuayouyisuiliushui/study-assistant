/**
 * Fact-Check Engine — Anti-Hallucination layer for AI-generated learning content.
 *
 * === DESIGN ===
 *
 * Implements a generate-check architecture:
 *   1. Generate Agent: creates learning content (existing engine)
 *   2. Verifier Agent: audits generated content for factual accuracy (this module)
 *   3. Fixer Agent: self-corrects uncertain claims (this module)
 *
 * This is the "second pair of eyes" that catches:
 *   - Hallucinated API names, version numbers, RFC numbers
 *   - Incorrect technical facts
 *   - Overconfident statements about platform behavior
 *   - Code examples with subtle bugs
 *
 * === CACHE BEHAVIOR ===
 *
 * STABLE_FACT_CHECK_PROMPT is immutable → cache-friendly prefix.
 * The user message (content to audit) varies, but sits at the TAIL of the
 * messages array where cache miss is expected.
 *
 * === INTEGRATION POINTS ===
 *
 * - factCheckDetail(): audit generated topic detail after generation completes
 * - autoFixUncertainClaims(): self-correct claims flagged as uncertain/wrong
 * - computeFactCheckScore(): aggregate confidence into a single score
 * - factCheckQuickScan(): lightweight scan for blatant hallucinations (low cost)
 */

import { STABLE_FACT_CHECK_PROMPT, STABLE_FACT_FIX_PROMPT } from './learn-prompts.js';
import { resolveProvider } from './ai-runtime.js';

// ─── Internal helpers ───

const MAX_CONTENT_LENGTH = 8000; // Truncate content for audit to fit context window
const MIN_CONTENT_LENGTH = 100;  // Don't bother auditing very short content

/**
 * Extract sections from Markdown content that are most likely to contain
 * checkable facts. Skips code blocks (they're checked separately).
 */
function extractAuditableContent(detail) {
  if (!detail || detail.length < MIN_CONTENT_LENGTH) return detail || '';

  // Truncate to max length, preferring the front (core concepts are usually first)
  if (detail.length > MAX_CONTENT_LENGTH) {
    return detail.slice(0, MAX_CONTENT_LENGTH) + '\n\n（后续内容已截断，仅审计前 8000 字）';
  }

  return detail;
}

/**
 * Compute an aggregate fact-check score from findings.
 * Weighted: hallucinations and wrong claims are heavily penalized.
 */
function computeAggregateScore(findings) {
  if (!findings || findings.length === 0) return 1.0;

  let totalWeight = 0;
  let weightedScore = 0;

  const verdictWeights = {
    'confirmed': 1.0,
    'likely_correct': 0.85,
    'uncertain': 0.5,
    'likely_wrong': 0.15,
    'hallucination': 0.0,
  };

  // Severity multiplier: wrong claims hurt more than uncertain ones
  const severityMultiplier = {
    'fact': 1.5,
    'code': 1.3,
    'version': 1.2,
    'standard': 1.2,
    'numeric': 1.1,
    'causal': 0.9,
    'history': 0.7,
    'platform': 0.8,
  };

  for (const f of findings) {
    const vw = verdictWeights[f.verdict] ?? 0.5;
    const sm = severityMultiplier[f.dimension] ?? 1.0;
    const weight = sm;
    totalWeight += weight;
    weightedScore += vw * weight;
  }

  if (totalWeight === 0) return 1.0;
  return Math.round((weightedScore / totalWeight) * 100) / 100;
}

// ─── Public API ───

/**
 * Perform a full fact-check audit on generated learning content.
 *
 * This is the PRIMARY entry point. Call after generateDetail() completes.
 *
 * @param {Provider|object} providerOrConfig - Provider instance or config with apiKey/baseURL
 * @param {string} content - The generated learning content (Markdown)
 * @param {string} topicTitle - Topic title for context
 * @param {string} [model='gpt-4o-mini'] - Model to use for fact-checking
 * @returns {Promise<{overallScore: number, verdict: string, summary: string, findings: Array, auditedAt: number}>}
 */
export async function factCheckDetail(providerOrConfig, content, topicTitle, model = 'gpt-4o-mini') {
  if (!content || content.length < MIN_CONTENT_LENGTH) {
    return {
      overallScore: 1.0,
      verdict: 'trusted',
      summary: '内容过短，无需审计',
      findings: [],
      auditedAt: Date.now(),
    };
  }

  const auditableContent = extractAuditableContent(content);

  try {
    return await _withFallback(async (provider, currentModel) => {
      const messages = [
        { role: 'system', content: STABLE_FACT_CHECK_PROMPT },
        {
          role: 'user',
          content: `请审计以下关于「${topicTitle}」的AI生成讲解内容：\n\n---\n${auditableContent}\n---\n\n请按照审计维度逐条检查，并输出 JSON。`,
        },
      ];

      const result = await provider.complete(messages, {
        maxTokens: 3072,
        temperature: 0.2,
        responseFormat: { type: 'json_object' },
      });

      const parsed = JSON.parse(result.content || '{}');
      const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
      const overallScore = typeof parsed.overallScore === 'number'
        ? parsed.overallScore
        : computeAggregateScore(findings);

      let verdict = parsed.verdict || 'caution';
      if (!['trusted', 'caution', 'unreliable'].includes(verdict)) {
        verdict = overallScore >= 0.8 ? 'trusted' : overallScore >= 0.5 ? 'caution' : 'unreliable';
      }

      return {
        overallScore,
        verdict,
        summary: parsed.summary || `审计完成，发现 ${findings.length} 个需要关注的陈述`,
        findings: findings.map(f => ({
          claim: f.claim || '',
          location: f.location || '',
          dimension: f.dimension || 'fact',
          confidence: typeof f.confidence === 'number' ? f.confidence : 0.5,
          verdict: f.verdict || 'uncertain',
          explanation: f.explanation || '',
          correction: f.correction || '',
        })),
        auditedAt: Date.now(),
      };
    }, providerOrConfig, model);
  } catch (err) {
    console.warn('[factCheckDetail] Audit failed:', err.message);
    return {
      overallScore: null,
      verdict: 'error',
      summary: '事实核查失败: ' + err.message,
      findings: [],
      auditedAt: Date.now(),
    };
  }
}

/**
 * Auto-fix claims that were flagged as uncertain or wrong by the fact-check.
 *
 * This is the "Fixer Agent" stage: takes uncertain claims and asks the AI
 * to correct them. Returns corrected replacements that can be merged back
 * into the original content.
 *
 * @param {Provider|object} providerOrConfig - Provider instance or config
 * @param {Array} uncertainFindings - Findings with verdict in ['uncertain','likely_wrong','hallucination']
 * @param {string} [model='gpt-4o-mini'] - Model to use
 * @returns {Promise<Array>} Fixes with action + replacement
 */
export async function autoFixUncertainClaims(providerOrConfig, uncertainFindings, model = 'gpt-4o-mini') {
  if (!uncertainFindings || uncertainFindings.length === 0) return [];

  const claimsList = uncertainFindings
    .map((f, i) => `${i + 1}. [${f.verdict}] ${f.claim}\n   位置：${f.location}\n   原因：${f.explanation || '未提供'}`)
    .join('\n\n');

  try {
    return await _withFallback(async (provider, currentModel) => {
      const messages = [
        { role: 'system', content: STABLE_FACT_FIX_PROMPT },
        {
          role: 'user',
          content: `以下陈述在前一轮事实核查中被标记为存疑，请逐一修正：\n\n${claimsList}`,
        },
      ];

      const result = await provider.complete(messages, {
        maxTokens: 3072,
        temperature: 0.3,
        responseFormat: { type: 'json_object' },
      });

      const parsed = JSON.parse(result.content || '{}');
      return Array.isArray(parsed.fixes) ? parsed.fixes : [];
    }, providerOrConfig, model);
  } catch (err) {
    console.warn('[autoFixUncertainClaims] Auto-fix failed:', err.message);
    return [];
  }
}

/**
 * Merge auto-fix corrections back into the original content.
 * Uses simple string replacement for each fix where action is 'correct' or 'clarify'.
 *
 * @param {string} content - Original Markdown content
 * @param {Array} fixes - Fix objects from autoFixUncertainClaims
 * @returns {{ content: string, fixedCount: number }} Corrected content and count of fixes applied
 */
export function applyFixesToContent(content, fixes) {
  if (!fixes || fixes.length === 0) return { content, fixedCount: 0 };

  let corrected = content;
  let fixedCount = 0;

  for (const fix of fixes) {
    if (fix.action === 'confirm' || fix.action === 'remove') continue;
    if (!fix.claim || !fix.replacement) continue;

    // Try exact replacement first
    if (corrected.includes(fix.claim)) {
      corrected = corrected.replace(fix.claim, fix.replacement);
      fixedCount++;
      continue;
    }

    // Try normalized replacement (whitespace-insensitive)
    const normalizedClaim = fix.claim.replace(/\s+/g, ' ').trim();
    const normalizedContent = corrected.replace(/\s+/g, ' ');

    const idx = normalizedContent.indexOf(normalizedClaim);
    if (idx >= 0) {
      // Find the original substring using the normalized index
      // This is approximate but works for most cases
      const before = normalizedContent.slice(0, idx);
      const beforeLines = before.split('\n').length - 1;
      const contentLines = corrected.split('\n');
      const lineStart = beforeLines;
      // Try to locate and replace in the original content
      // Fallback: use the first occurrence of the claim's first 30 chars
      const searchKey = fix.claim.slice(0, Math.min(30, fix.claim.length));
      const searchIdx = corrected.indexOf(searchKey);
      if (searchIdx >= 0) {
        // Replace from searchIdx to end of claim (approximate)
        const claimLen = fix.claim.length;
        const originalSegment = corrected.slice(searchIdx, searchIdx + claimLen);
        if (originalSegment.trim().length > 0) {
          corrected = corrected.slice(0, searchIdx) + fix.replacement + corrected.slice(searchIdx + claimLen);
          fixedCount++;
        }
      }
    }
  }

  return { content: corrected, fixedCount };
}

/**
 * Lightweight quick scan for blatant hallucinations.
 *
 * Instead of a full audit (which uses ~2-3k output tokens), this asks the AI
 * to scan for only the most obvious issues: hallucinated APIs, wrong version
 * numbers, impossible claims. Uses ~500 output tokens.
 *
 * Good for post-generation "sanity check" without the cost of a full audit.
 *
 * @param {Provider|object} providerOrConfig
 * @param {string} content
 * @param {string} topicTitle
 * @param {string} [model='gpt-4o-mini']
 * @returns {Promise<{flagged: boolean, issues: Array, scanTime: number}>}
 */
export async function factCheckQuickScan(providerOrConfig, content, topicTitle, model = 'gpt-4o-mini') {
  if (!content || content.length < MIN_CONTENT_LENGTH) {
    return { flagged: false, issues: [], scanTime: Date.now() };
  }

  const snippet = content.length > 5000 ? content.slice(0, 5000) : content;

  const quickScanPrompt =
    '你是一个快速审查员。请用最少的字数扫描以下内容，只标记明显的AI幻觉痕迹：\n' +
    '- 编造的函数名/API名\n- 不存在的版本号\n- 完全错误的事实陈述\n' +
    '- 明显错误的因果逻辑\n\n' +
    '如果内容基本正确，返回空数组。只输出JSON。\n' +
    '格式：{"flagged": true/false, "issues": [{"claim": "原文", "problem": "问题简述"}]}\n\n' +
    `内容主题：${topicTitle}\n\n${snippet.slice(0, 4000)}`;

  try {
    return await _withFallback(async (provider, currentModel) => {
      const result = await provider.complete(
        [
          { role: 'system', content: '你是一个快速内容审查员。只输出JSON。' },
          { role: 'user', content: quickScanPrompt },
        ],
        { maxTokens: 512, temperature: 0.1, responseFormat: { type: 'json_object' } }
      );

      const parsed = JSON.parse(result.content || '{}');
      return {
        flagged: parsed.flagged === true,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        scanTime: Date.now(),
      };
    }, providerOrConfig, model);
  } catch (err) {
    return { flagged: false, issues: [], scanTime: Date.now(), error: err.message };
  }
}

/**
 * Build a human-readable fact-check report in Markdown.
 * Can be displayed in the UI alongside the generated content.
 *
 * @param {object} factCheckResult - Result from factCheckDetail()
 * @returns {string} Markdown report
 */
export function buildFactCheckReport(factCheckResult) {
  if (!factCheckResult || factCheckResult.verdict === 'error') {
    return '⚠️ 事实核查未能完成';
  }

  const { overallScore, verdict, summary, findings } = factCheckResult;

  if (!findings || findings.length === 0) {
    const emoji = verdict === 'trusted' ? '✅' : '⚠️';
    return `${emoji} **事实核查通过** — 分数: ${Math.round((overallScore || 1) * 100)}% — ${summary}`;
  }

  const verdictEmoji = {
    trusted: '🟢',
    caution: '🟡',
    unreliable: '🔴',
    error: '⚠️',
  };

  const lines = [
    `## ${verdictEmoji[verdict] || ''} 事实核查报告`,
    '',
    `**可信度评分**: ${Math.round((overallScore || 0) * 100)}% — **评级**: ${verdict === 'trusted' ? '可信' : verdict === 'caution' ? '需注意' : '不可靠'}`,
    '',
    `> ${summary}`,
    '',
  ];

  if (findings.length > 0) {
    lines.push('### 发现的问题');
    lines.push('');
    lines.push('| # | 陈述 | 判定 | 置信度 | 说明 |');
    lines.push('|---|------|------|--------|------|');

    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      const vLabel = {
        'confirmed': '✅ 确认正确',
        'likely_correct': '👍 大概率正确',
        'uncertain': '❓ 存疑',
        'likely_wrong': '⚠️ 可能错误',
        'hallucination': '🚫 疑似幻觉',
      }[f.verdict] || f.verdict;

      const claim = f.claim.length > 80 ? f.claim.slice(0, 80) + '...' : f.claim;
      const explanation = (f.explanation || '').length > 60
        ? f.explanation.slice(0, 60) + '...'
        : (f.explanation || '');

      lines.push(`| ${i + 1} | ${claim} | ${vLabel} | ${Math.round(f.confidence * 100)}% | ${explanation} |`);
    }
  }

  return lines.join('\n');
}

/**
 * Compute a summary suitable for inline display (one line).
 */
export function buildFactCheckSummary(factCheckResult) {
  if (!factCheckResult) return '';
  if (factCheckResult.verdict === 'error') return '⚠️ 核查失败';

  const score = Math.round((factCheckResult.overallScore || 0) * 100);
  const emoji = score >= 80 ? '✅' : score >= 50 ? '🟡' : '🔴';
  const issueCount = (factCheckResult.findings || []).length;

  if (issueCount === 0) return `${emoji} 可信度 ${score}% — 未发现问题`;
  return `${emoji} 可信度 ${score}% — ${issueCount} 个关注点`;
}

// ─── Provider resolution ───

const FALLBACK_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4'];

function _resolveProviderForFactCheck(providerOrConfig, model) {
  return resolveProvider(providerOrConfig, model);
}

/**
 * Call a fact-check function with automatic model fallback.
 * Tries the primary model first; on failure, falls back through FALLBACK_MODELS.
 */
async function _withFallback(fn, providerOrConfig, model, ...args) {
  const primaryModel = model || 'gpt-4o-mini';
  const modelsToTry = [primaryModel, ...FALLBACK_MODELS.filter(m => m !== primaryModel)];

  let lastError;
  for (const m of modelsToTry) {
    try {
      const provider = _resolveProviderForFactCheck(providerOrConfig, m);
      return await fn(provider, m, ...args);
    } catch (err) {
      lastError = err;
      console.warn(`[fact-checker] Model ${m} failed, trying fallback: ${err.message}`);
    }
  }
  throw lastError;
}

export default {
  factCheckDetail,
  factCheckQuickScan,
  autoFixUncertainClaims,
  applyFixesToContent,
  buildFactCheckReport,
  buildFactCheckSummary,
};
