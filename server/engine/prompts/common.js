/**
 * Prompt templates for the knowledge-point learning assistant.
 *
 * === CACHE-OPTIMIZED DESIGN ===
 *
 * Instead of injecting variable context into the system prompt
 * (which makes EVERY call have a different cache prefix), we split into:
 *
 *   [STABLE_SYSTEM_PROMPT] + [DETERMINISTIC_CONTEXT] + [USER_MESSAGE]
 *
 * - STABLE_SYSTEM_PROMPT: perfectly fixed string, never changes
 * - DETERMINISTIC_CONTEXT: formatted deterministically — same state → same output
 * - USER_MESSAGE: the variable part (question), which is at the END of prefix
 *
 * This way, as long as the plan structure hasn't changed, the FIRST 2 messages
 * are IDENTICAL across calls → high cache hit rate.
 */

import { STABLE_DETAIL_SYSTEM_PROMPT, STABLE_FOLLOWUP_SYSTEM_PROMPT } from './detail.js';

// ═══════════════════════════════════════════════════════
//  PART 2: DETERMINISTIC CONTEXT DIGEST
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════
export function buildDeterministicContext(plan, topicId) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) return '';

  const lines = [];

  // Fixed-length fields first (most stable = best for caching)
  lines.push('=== 学习上下文（自动生成）===');
  lines.push('计划名称: ' + (plan.name || '未命名'));
  lines.push('当前知识点: ' + (topic.title || '未知'));

  // Topic position — deterministic integer, stable as long as plan structure is stable
  const idx = plan.topics.findIndex(t => t.id === topicId);
  const total = plan.topics.length;
  lines.push('知识点位置: 第' + (idx + 1) + '/' + total + '个');

  // Previous topic — stable as long as plan structure is stable
  const prevTopics = plan.topics.slice(0, idx).filter(t => t.done);
  if (prevTopics.length > 0) {
    lines.push('已有基础: ' + prevTopics.map(t => t.title).join(' → '));
  }

  // Next topics — stable as long as plan structure is stable
  const nextTopics = plan.topics.slice(idx + 1);
  if (nextTopics.length > 0) {
    lines.push('后续目标: ' + nextTopics.map(t => t.title).join(' → '));
  }

  // Learning progress — deterministic
  const doneCount = plan.topics.filter(t => t.done && !t.lastError).length;
  lines.push('学习进度: ' + doneCount + '/' + total + ' 已完成');

  // History — deterministic: Q&A pairs, full content
  const history = (plan.history || []).filter(h => h.topicId === topicId);
  if (history.length > 0) {
    // Pair user + ai messages into Q&A blocks
    const pairs = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user' && i + 1 < history.length && history[i + 1].role === 'ai') {
        pairs.push({ question: history[i].content, answer: history[i + 1].content });
        i++; // skip the next ai entry
      }
    }
    // Take last 5 Q&A pairs (up to 10 entries) — no randomness in selection
    const recentPairs = pairs.slice(-20);
    if (recentPairs.length > 0) {
      lines.push('学习历史记录（近' + recentPairs.length + '轮问答）:');
      for (let i = 0; i < recentPairs.length; i++) {
        const p = recentPairs[i];
        lines.push('  --- 第' + (pairs.length - recentPairs.length + i + 1) + '轮 ---');
        lines.push('  用户: ' + p.question);
        lines.push('  助手: ' + p.answer);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Get the stable system prompt + deterministic context as messages.
 *
 * Returns: [system_msg, context_msg] — BOTH are stable when state hasn't changed.
 * The caller appends the actual user question/message AFTER these.
 */
export function buildDetailMessages(plan, topicId, question) {
  const messages = [
    { role: 'system', content: STABLE_DETAIL_SYSTEM_PROMPT },
    { role: 'user', content: buildDeterministicContext(plan, topicId) },
  ];

  // The actual question comes AFTER the stable prefix
  // This is the only part that changes per-call
  if (question) {
    messages.push({ role: 'user', content: question });
  }

  return messages;
}

/**
 * Build messages for follow-up Q&A.
 * The first 2 messages (system + context) are stable across calls.
 */
export function buildFollowUpMessages(plan, topicId, question) {
  // For follow-up, system prompt is different but still stable
  // Context digest is shared (same deterministic format)
  const messages = [
    { role: 'system', content: STABLE_FOLLOWUP_SYSTEM_PROMPT },
    { role: 'user', content: buildDeterministicContext(plan, topicId) },
  ];

  if (question) {
    messages.push({ role: 'user', content: question });
  }

  return messages;
}

// ═══════════════════════════════════════════════════════
//  PART 3: LEGACY COMPATIBILITY
// ═══════════════════════════════════════════════════════

/**
 * @deprecated Use buildDetailMessages() for cache-optimized calls.
 * Kept for backward compatibility with existing callers.
 */
export function getDetailSystemPrompt(plan, topicId) {
  return STABLE_DETAIL_SYSTEM_PROMPT;
}

/**
 * @deprecated Use buildFollowUpMessages() for cache-optimized calls.
 */
export function getFollowUpSystemPrompt(plan, topicId) {
  return STABLE_FOLLOWUP_SYSTEM_PROMPT;
}

// ═══════════════════════════════════════════════════════
