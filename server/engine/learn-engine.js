/**
 * Core engine: generates detailed knowledge-point content using AI.
 *
 * === CACHE-OPTIMIZED ARCHITECTURE ===
 *
 * Instead of building a fresh system prompt per call (which changes the
 * entire prefix and guarantees a cache miss), we use:
 *
 * 1. STABLE system prompts — perfectly fixed persona strings
 * 2. DETERMINISTIC context digest — same state → same output
 * 3. Cache-aware Provider — tracks hit/miss, retry, diagnostics
 *
 * This means generateDetail() for the SAME topic on the SAME plan
 * will produce IDENTICAL first-2-messages = HIGH cache hit rate.
 */

import { Provider, isRelayBlockedError, isUnsupportedParameterError } from './provider.js';
import { KeyPool } from './key-pool.js';
import { CacheMonitor } from './cache-diagnostics.js';
import { factCheckQuickScan, buildFactCheckSummary, factCheckDetail, autoFixUncertainClaims, applyFixesToContent, buildFactCheckReport } from './fact-checker.js';
import { AdaptivePromptInjector } from './adaptive-engine.js';
import { getUserProfile } from './user-profile.js';
import { buildDetailMessages, buildDeterministicContext } from './learn-prompts.js';
import { updateTopic, addHistory } from './learn-store.js';
import { extractRelationsFromDetail } from './learn-store.js';
import { INFER_RELATIONS_PROMPT } from './learn-prompts.js';
import { generateExam, gradeExam, generateExamPractice,
  generateBlueprint, generateSingleQuestion, selfCorrectQuestion,
  generateExamStream, evaluateQuestionQuality } from './exam-engine.js';
import { startInteractiveDetail, continueInteractiveDetail, streamInteractiveStart,
  streamInteractiveContinue, revealEmbeddedErrors, examineTeachingErrors,
  decomposeTopic } from './interactive-teacher.js';
import { answerFollowUp, analyzeLearning, answerAnalysisFollowUp,
  analyzeCoreTopics, generateReview, gradeExercises, analyzeWeakPoints,
  generateQuickQuiz, analyzeFeynmanSession } from './learning-analyzer.js';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Global cache monitor for this process.
 * Exposed so routes can report diagnostics to users.
 */
export const engineCacheMonitor = new CacheMonitor();

/**
 * Get or create a Provider. Uses composite key to ensure different
 * API keys, base URLs, or models get separate provider instances.
 */
const _providerCache = new Map();

/**
 * Resolve a Provider from either a Provider instance or config-like object.
 * When a Provider is passed directly, returns it as-is.
 * When an OpenAI-like object (with apiKey, baseURL) is passed, creates/returns cached Provider.
 */
export function resolveProvider(providerOrConfig, model) {
  // Already a Provider instance — use directly
  if (providerOrConfig instanceof Provider) {
    return providerOrConfig;
  }
  // Legacy: OpenAI-like object with apiKey/baseURL
  const key = (providerOrConfig.apiKey || '') + '::' + (providerOrConfig.baseURL || '') + '::' + (model || '');
  if (!_providerCache.has(key)) {
    const provider = new Provider({
      apiKey: providerOrConfig.apiKey,
      baseURL: providerOrConfig.baseURL,
      model,
      debugCache: process.env.DEBUG_CACHE === 'true',
    });
    _providerCache.set(key, provider);
  }
  return _providerCache.get(key);
}

/**
 * Create a Provider from individual config values.
 * Shared between engine and routes layer for consistency.
 */
export function createProviderFromConfig(apiKey, baseURL, model) {
  const key = (apiKey || '') + '::' + (baseURL || '') + '::' + (model || '');
  if (!_providerCache.has(key)) {
    const provider = new Provider({
      apiKey,
      baseURL,
      model,
      debugCache: process.env.DEBUG_CACHE === 'true',
    });
    _providerCache.set(key, provider);
  }
  return _providerCache.get(key);
}

// ─── Public API ───

/**
 * Generate detailed explanation for a knowledge point.
 *
 * CACHE BEHAVIOR:
 * - First 2 messages (system + context) are IDENTICAL for same topic + plan
 * - Only the user question at the end varies per-session
 * - Provider tracks cache hit/miss tokens automatically
 */
export async function generateDetail(providerOrConfig, plan, topicId, model = 'gpt-4o-mini', explainStyle) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  // Preserve previous content: if regeneration fails, restore it so the
  // user doesn't lose a previously successful generation.
  const previousDetail = topic.detail;

  topic.detail = '';
  topic.done = false;
  topic.lastError = null;
  await updateTopic(plan.id, topicId, { detail: '', done: false, lastError: null });

  const provider = resolveProvider(providerOrConfig, model || 'gpt-4o-mini');

  // Auto-warm cache with the prefix we're about to use
  const warmMessages = buildDetailMessages(plan, topicId);
  provider.warmCache(warmMessages);

  try {
    // ── Adaptive personalization: inject user profile into context ──
    const profile = getUserProfile();
    const injector = new AdaptivePromptInjector(profile);
    const adaptiveContext = injector.buildAdaptiveContext();

    let messages = buildDetailMessages(plan, topicId, '请为我详细讲解「' + topic.title + '」。', explainStyle);

    // Inject adaptive guidance between context and question (cache-safe:
    // user profile changes infrequently, so prefix stays stable most of the time)
    if (adaptiveContext && injector.hasMeaningfulProfile) {
      // Append adaptive context to the deterministic context message (messages[1])
      messages[1] = {
        ...messages[1],
        content: messages[1].content + '\n' + adaptiveContext,
      };
    }

    engineCacheMonitor.recordShape(messages, 'generateDetail:' + topicId.slice(0, 8));

    let chunkCount = 0;
    const fullContent = await provider.stream(messages, {
      maxTokens: 8192,
      onChunk: (delta) => {
        topic.detail += delta;
        chunkCount++;
        if (chunkCount % 20 === 0) {
          updateTopic(plan.id, topicId, { detail: topic.detail });
        }
      },
      onUsage: (usage) => {
        engineCacheMonitor.recordUsage(usage, 'generateDetail:' + topicId.slice(0, 8));
      },
    });

    if (!fullContent) throw new Error('AI 返回内容为空');

    topic.done = true;
    await updateTopic(plan.id, topicId, { detail: fullContent, done: true, lastError: null });
    await addHistory(plan.id, topicId, 'ai', fullContent);

    // ── Extract relations from generated detail and persist ──
    try {
      const extractedEdges = extractRelationsFromDetail(fullContent, plan.topics, topicId);
      if (extractedEdges.length > 0) {
        const prereqs = new Set(topic.prerequisites || []);
        const related = new Set(topic.relatedTopics || []);

        for (const e of extractedEdges) {
          if (e.to === topicId) {
            // A matched topic points to the current topic
            if (e.type === 'prerequisite' || e.type === 'buildsOn' || e.type === 'references') {
              prereqs.add(e.from);  // matched topic is something current needs first
            } else {
              related.add(e.from);  // matched topic is related
            }
          } else if (e.from === topicId) {
            // Current topic points to a matched topic
            related.add(e.to);
          }
        }

        await updateTopic(plan.id, topicId, {
          prerequisites: [...prereqs],
          relatedTopics: [...related],
        });
      }
    } catch (err) {
      console.error('[generateDetail] Relation extraction failed:', err.message);
    }

    // ── Post-generation fact-check (quick scan, fire-and-forget) ──
    factCheckQuickScan(provider, fullContent, topic.title, model).then(result => {
      if (result && result.flagged) {
        const summary = buildFactCheckSummary({
          overallScore: result.flagged ? 0.5 : 0.9,
          verdict: result.flagged ? 'caution' : 'trusted',
          summary: result.issues.map(i => i.problem).join('; '),
          findings: result.issues.map(i => ({ claim: i.claim, verdict: 'uncertain', confidence: 0.4, dimension: 'fact', location: '', explanation: i.problem, correction: '' })),
        });
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: true, issues: result.issues, summary, scannedAt: result.scanTime },
        }).catch(() => {});
      } else {
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: false, issues: [], summary: '✅ 快速扫描未发现明显问题', scannedAt: result?.scanTime || Date.now() },
        }).catch(() => {});
      }
    }).catch(() => {});

    return fullContent;
  } catch (err) {
    console.error('[generateDetail]', err);
    topic.lastError = err.message || '生成失败';
    // On failure, restore previous detail (if any) so user doesn't lose old content.
    // Prefer old complete content over partial new content from a failed stream.
    const detailToSave = previousDetail || topic.detail || null;
    await updateTopic(plan.id, topicId, {
      detail: detailToSave,
      done: false,
      lastError: topic.lastError,
    });
    throw err;
  }
}

/**
 * Generate detail content with SSE streaming events.
 * Accepts a writeEvent callback for real-time chunk delivery.
 * Events: chunk ({ content }), done ({ topicId, detail }), error ({ message })
 * Still persists to store (same as generateDetail), but also streams via SSE.
 */
export async function generateDetailStream(providerOrConfig, plan, topicId, writeEvent, model = 'gpt-4o-mini', explainStyle, signal) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const previousDetail = topic.detail;

  topic.detail = '';
  topic.done = false;
  topic.lastError = null;
  await updateTopic(plan.id, topicId, { detail: '', done: false, lastError: null });

  const provider = resolveProvider(providerOrConfig, model);

  const warmMessages = buildDetailMessages(plan, topicId);
  provider.warmCache(warmMessages);

  try {
    const profile = getUserProfile();
    const injector = new AdaptivePromptInjector(profile);
    const adaptiveContext = injector.buildAdaptiveContext();

    let messages = buildDetailMessages(plan, topicId, '请为我详细讲解「' + topic.title + '」。', explainStyle);

    if (adaptiveContext && injector.hasMeaningfulProfile) {
      messages[1] = {
        ...messages[1],
        content: messages[1].content + '\n' + adaptiveContext,
      };
    }

    engineCacheMonitor.recordShape(messages, 'generateDetail:' + topicId.slice(0, 8));

    let chunkCount = 0;
    const fullContent = await provider.stream(messages, {
      maxTokens: 8192,
      signal,
      onChunk: (delta) => {
        topic.detail += delta;
        chunkCount++;
        if (writeEvent) writeEvent({ type: 'chunk', content: delta });
        if (chunkCount % 20 === 0) {
          updateTopic(plan.id, topicId, { detail: topic.detail });
        }
      },
      onUsage: (usage) => {
        engineCacheMonitor.recordUsage(usage, 'generateDetail:' + topicId.slice(0, 8));
      },
    });

    if (!fullContent) throw new Error('AI 返回内容为空');

    topic.done = true;
    await updateTopic(plan.id, topicId, { detail: fullContent, done: true, lastError: null });
    await addHistory(plan.id, topicId, 'ai', fullContent);

    if (writeEvent) writeEvent({ type: 'done', topicId, detail: fullContent });

    factCheckQuickScan(provider, fullContent, topic.title, model).then(result => {
      if (result && result.flagged) {
        const summary = buildFactCheckSummary({
          overallScore: result.flagged ? 0.5 : 0.9,
          verdict: result.flagged ? 'caution' : 'trusted',
          summary: result.issues.map(i => i.problem).join('; '),
          findings: result.issues.map(i => ({ claim: i.claim, verdict: 'uncertain', confidence: 0.4, dimension: 'fact', location: '', explanation: i.problem, correction: '' })),
        });
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: true, issues: result.issues, summary, scannedAt: result.scanTime },
        }).catch(() => {});
      } else {
        updateTopic(plan.id, topicId, {
          factCheck: { flagged: false, issues: [], summary: '✅ 快速扫描未发现明显问题', scannedAt: result?.scanTime || Date.now() },
        }).catch(() => {});
      }
    }).catch(() => {});

    return fullContent;
  } catch (err) {
    console.error('[generateDetailStream]', err);
    topic.lastError = err.message || '生成失败';
    const detailToSave = previousDetail || topic.detail || null;
    await updateTopic(plan.id, topicId, {
      detail: detailToSave,
      done: false,
      lastError: topic.lastError,
    });
    if (writeEvent) writeEvent({ type: 'error', data: err.message });
    throw err;
  }
}

/**
 * Infer prerequisite and related-topic relationships among all topics in a plan.
 * Uses AI to analyze all topic titles at once and produce a mapping of relationships.
 * Called once per plan when topics lack relationship data (fire-and-forget).
 *
 * @param {object} providerOrConfig - Provider instance or config
 * @param {object} plan - Full plan object
 * @param {string} model - Model name
 * @returns {Promise<object>} Inferred relations result
 */
export async function inferTopicRelations(providerOrConfig, plan, model = 'gpt-4o-mini') {
  const provider = resolveProvider(providerOrConfig, model);
  const topics = plan.topics || [];
  if (topics.length < 2) {
    return { relations: [], analysis: '知识点少于 2 个，无需推断' };
  }

  // Build topic list as numbered index for the AI
  const sorted = [...topics].sort((a, b) => a.order - b.order);
  const topicLines = sorted.map((t, i) => `topic-${i}: ${t.title}`).join('\n');

  const userMessage =
    `以下是学习计划「${plan.name || '未命名'}」中按顺序排列的知识点列表。请分析并推断它们之间的关系：\n\n${topicLines}`;

  const messages = [
    { role: 'system', content: INFER_RELATIONS_PROMPT },
    { role: 'user', content: userMessage },
  ];

  try {
    const result = await provider.complete(messages, {
      temperature: 0.3,
      maxTokens: 4096,
      responseFormat: { type: 'json_object' },
    });

    const parsed = JSON.parse(result.content || '{}');
    const relations = parsed.relations || [];

    // Map topic indices back to actual topic IDs
    const indexToId = {};
    sorted.forEach((t, i) => { indexToId[`topic-${i}`] = t.id; });

    // Collect updates per topic
    const updatesByTopicId = {};

    for (const rel of relations) {
      const fromId = indexToId[rel.from];
      const toId = indexToId[rel.to];
      if (!fromId || !toId || fromId === toId) continue;

      if (rel.type === 'prerequisite') {
        if (!updatesByTopicId[toId]) updatesByTopicId[toId] = { prerequisites: [] };
        if (!updatesByTopicId[toId].prerequisites.includes(fromId)) {
          updatesByTopicId[toId].prerequisites.push(fromId);
        }
      } else if (rel.type === 'related') {
        if (!updatesByTopicId[fromId]) updatesByTopicId[fromId] = { relatedTopics: [] };
        if (!updatesByTopicId[toId]) updatesByTopicId[toId] = { relatedTopics: [] };
        if (!updatesByTopicId[fromId].relatedTopics.includes(toId)) {
          updatesByTopicId[fromId].relatedTopics.push(toId);
        }
        if (!updatesByTopicId[toId].relatedTopics.includes(fromId)) {
          updatesByTopicId[toId].relatedTopics.push(fromId);
        }
      }
    }

    // Apply all updates to topics
    for (const [topicId, updates] of Object.entries(updatesByTopicId)) {
      const topic = plan.topics.find(t => t.id === topicId);
      if (!topic) continue;
      const merged = {
        prerequisites: [...(topic.prerequisites || [])],
        relatedTopics: [...(topic.relatedTopics || [])],
      };
      for (const pid of (updates.prerequisites || [])) {
        if (!merged.prerequisites.includes(pid)) merged.prerequisites.push(pid);
      }
      for (const rid of (updates.relatedTopics || [])) {
        if (!merged.relatedTopics.includes(rid)) merged.relatedTopics.push(rid);
      }
      await updateTopic(plan.id, topicId, {
        prerequisites: merged.prerequisites,
        relatedTopics: merged.relatedTopics,
      });
    }

    return { relations, analysis: parsed.analysis || '' };
  } catch (err) {
    console.error('[inferTopicRelations] AI call failed:', err.message);
    throw err;
  }
}

/**
 * Clean up topic detail for image prompt context:
 * - Remove fenced code/Mermaid blocks
 * - Remove exercise/answer sections
 * - Strip Markdown formatting
 * - Collapse whitespace
 * - Trim to ~1000 chars
 */
function cleanDetailForContext(detail) {
  if (!detail) return '';
  let text = detail;

  // Remove fenced code blocks (including Mermaid)
  text = text.replace(/```[\s\S]*?```/g, ' ');

  // Remove inline code
  text = text.replace(/`[^`]+`/g, ' ');

  // Remove Mermaid diagram definitions
  text = text.replace(/```mermaid[\s\S]*?```/g, ' ');

  // Remove exercise section (from "练习题" heading onward)
  const exerciseIdx = text.search(/^#{1,3}\s*练习题|📝\s*练习题/m);
  if (exerciseIdx >= 0) text = text.slice(0, exerciseIdx);

  // Remove Markdown headings markers
  text = text.replace(/^#{1,6}\s*/gm, '');

  // Remove bold/italic markers
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');

  // Remove link syntax but keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Remove image syntax
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

  // Remove horizontal rules
  text = text.replace(/^---+\s*$/gm, '');

  // Remove blockquote markers
  text = text.replace(/^>\s*/gm, '');

  // Remove list markers
  text = text.replace(/^[\s]*(?:[-*+]|\d+\.)\s+/gm, '');

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Trim to max 1000 chars
  if (text.length > 1000) {
    // Cut at last sentence boundary within limit
    const cut = text.lastIndexOf('。', 1000);
    if (cut > 500) text = text.slice(0, cut + 1);
    else text = text.slice(0, 1000) + '...';
  }

  return text;
}

/**
 * Detect illustration type based on title + detail context.
 * Returns { type, style, composition } for the image prompt.
 */
function detectIllustrationType(title, context) {
  const lower = (title || '').toLowerCase();
  const ctx = (context || '').toLowerCase();
  // Match against both title and context for better classification
  const text = lower + ' ' + ctx;

  if (/流程|步骤|过程|workflow|pipeline|flow|build|deploy|编译|部署|构建/.test(text)) {
    return {
      type: 'process flow diagram',
      style: 'Modern flat vector, clean lines, directional arrows in blue and green tones',
      composition: 'Horizontal left-to-right connected steps with clear directional arrows between distinct stages',
      details: 'Each stage as a distinct visual block, sequential flow, organized pipeline with clear progression'
    };
  }

  if (/架构|结构|体系|分层|stack|architecture|layer|hierarchy|模块/.test(text)) {
    return {
      type: 'architecture diagram',
      style: 'Modern flat vector, layered blocks in coordinated color scheme',
      composition: 'Vertically stacked layers or interconnected modules showing hierarchical structure',
      details: 'Clean layered architecture, each tier visually distinct, organized structural layout'
    };
  }

  if (/对比|区别|vs|versus|比较|comparison|diff|异同/.test(text)) {
    return {
      type: 'comparison diagram',
      style: 'Modern flat vector, side-by-side layout with contrasting complementary colors',
      composition: 'Two-column symmetrical layout alternating key attributes for clear visual comparison',
      details: 'Balanced symmetrical design, contrasting but harmonious color pairs'
    };
  }

  if (/网络|连接|通信|protocol|network|connect|link|拓扑/.test(text)) {
    return {
      type: 'network topology diagram',
      style: 'Modern flat vector, interconnected nodes in tech-blue and gray palette',
      composition: 'Distributed nodes or devices with connecting lines showing communication paths',
      details: 'Clean network topology, distinct node types, organized spatial layout'
    };
  }

  if (/硬件|设备|芯片|电路|board|hardware|chip|embedded|存储器|CPU|内存/.test(text)) {
    return {
      type: 'hardware component diagram',
      style: 'Modern flat vector, isometric or 2D top-down view with tech-industrial palette',
      composition: 'Technical hardware illustration with clearly separated functional blocks and data/control flow arrows',
      details: 'Component-level hardware representation, organized functional blocks'
    };
  }

  if (/编程|代码|语法|函数|class|function|code|variable|算法|排序|搜索|递归/.test(text)) {
    return {
      type: 'algorithm/code visualization',
      style: 'Modern flat vector, code-token-inspired blocks in syntax-highlight colors',
      composition: 'Step-by-step execution flow diagram with colored data/control elements and transformation arrows',
      details: 'Algorithmic process visualization, clear data flow, execution path highlighted'
    };
  }

  if (/调试|排查|错误|debug|error|bug|fix|异常/.test(text)) {
    return {
      type: 'debug/troubleshooting workflow',
      style: 'Modern flat vector, diagnostic flowchart with decision diamonds in amber-blue palette',
      composition: 'Decision-tree style diagnostic workflow showing inspection points, branching paths, and resolution',
      details: 'Problem-solving flowchart, clear decision points, resolution path highlighted'
    };
  }

  if (/数据|database|sql|存储|缓存|cache|持久化|文件系统/.test(text)) {
    return {
      type: 'data storage diagram',
      style: 'Modern flat vector, database/server icons in cool blue-gray palette',
      composition: 'Data storage hierarchy or database schema showing tables/collections with relationship connectors',
      details: 'Clean data organization, entity-relationship style layout, organized storage tiers'
    };
  }

  if (/时间复杂度|空间复杂度|算法|排序|遍历|递归/.test(text)) {
    return {
      type: 'algorithm complexity visualization',
      style: 'Modern flat vector, chart-style in vibrant educational palette',
      composition: 'Comparative visual showing growth curves or step-by-step transformation of data structures',
      details: 'Educational algorithm illustration, conceptual data transformation visualization'
    };
  }

  // Default: concept explanation
  return {
    type: 'concept illustration',
    style: 'Modern flat vector illustration, clean minimalist design, soft educational color palette',
    composition: 'Central concept representation with clearly arranged supporting elements around it, showing relationships and structure',
    details: 'Educational concept visualization with clear visual hierarchy, suitable for study notes'
  };
}

/**
 * Map a detected illustration type to a concrete, high-quality visual brief:
 * a coherent subject, a single dominant visual metaphor, an explicit color
 * palette, and lighting. Keeping the brief tight and consistent (rather than a
 * long laundry list of prohibitions) measurably improves FLUX output quality.
 */
function buildVisualBrief(illustration) {
  const { type, style, composition, details } = illustration;
  const palette = 'cohesive palette of indigo #4f46e5, teal #0d9488, amber #f59e0b and slate #475569 on a clean #fafafa background';
  return {
    subject: `a single, clearly readable ${type} for the topic`,
    metaphor: 'one dominant visual metaphor that instantly communicates the core idea',
    palette,
    lighting: 'soft even studio lighting, subtle drop shadow for depth, no harsh contrast',
    style,
    composition,
    details,
  };
}

/**
 * Build a rich, detailed image generation prompt based on the full topic object.
 * Uses topic title + cleaned detail context for better relevance.
 * The context is trimmed to ~600 characters — enough for key concepts
 * without overwhelming the image model prompt budget.
 * Accepts plain string title for backward compatibility.
 *
 * @param {object|string} topic - Topic object (with title, detail, id) or plain title string
 * @returns {string} Detailed image generation prompt
 */
export function buildImagePrompt(topic) {
  const title = (typeof topic === 'string') ? topic : (topic?.title || '');
  const context = (typeof topic === 'string') ? '' : cleanDetailForContext(topic?.detail);

  const brief = buildVisualBrief(detectIllustrationType(title, context));

  // Trim context to ~600 chars — enough for subject-specific keywords
  // while leaving room for instruction tokens in the image model's prompt budget.
  const contextHint = context
    ? ` Key concepts to illustrate: ${context.slice(0, 600).trim()}.`
    : '';

  return [
    `Professional educational infographic: ${brief.subject} about "${title}".${contextHint}`,
    `Central idea: ${brief.metaphor}.`,
    `${brief.style}. ${brief.composition}.`,
    `${brief.details}.`,
    `Visual quality: ${brief.palette}; ${brief.lighting}. High detail, crisp vector shapes, clean consistent line work, balanced negative space.`,
    'Convey meaning through icons, geometric shapes, arrows, and color coding rather than words.',
    'No readable text, no letters, no numbers, no watermarks, no UI screenshots. No photorealistic humans, no 3D render, no dark background.',
    'Conceptually accurate, pedagogically clear, suitable as a study-note illustration.',
  ].join(' ');
}

function buildRelaySafeImagePrompt(title) {
  const topicTitle = String(title).replace(/\s+/g, ' ').trim().slice(0, 160);
  return `Create a simple, neutral educational illustration of the topic "${topicTitle}". Use clear shapes, a light background, and a diagram-like composition.`;
}

const DEFAULT_IMAGE_MODEL = 'black-forest-labs/FLUX.1-pro';
const SILICONFLOW_IMAGE_MODEL_FALLBACKS = [
  'black-forest-labs/FLUX.1-dev',
  'Kwai-Kolors/Kolors',
  'stabilityai/stable-diffusion-xl-base-1.0',
];

export function getImageFallbackModels(imageModel, imageBaseUrl, configuredFallbackModel = '') {
  const primaryModel = String(imageModel || '').trim();
  const configuredModel = String(configuredFallbackModel || '').trim();
  const candidates = configuredModel
    ? [configuredModel]
    : /^https:\/\/api\.siliconflow\.cn(?:\/|$)/i.test(String(imageBaseUrl || ''))
      ? SILICONFLOW_IMAGE_MODEL_FALLBACKS
      : [];

  return [...new Set(candidates.filter(candidate => candidate && candidate !== primaryModel))];
}

function getImageApiKeys(imageApiKey) {
  return [...new Set(KeyPool.parse(imageApiKey))];
}

function shouldRetryImageChannel(err) {
  return isRelayBlockedError(err) || [401, 403, 429].includes(Number(err?.status));
}

/**
 * Generate an illustration for a knowledge point using SiliconFlow API.
 * Calls the text-to-image model, downloads the result, and saves it to server/data/images/.
 * @param {object} topic - The topic object (must have id and title)
 * @param {string} imageApiKey - Image generation API key
 * @param {string} [model] - Image generation model (default: FLUX.1-dev)
 * @param {string} [imageBaseUrl] - Custom API base URL (default: SiliconFlow)
 * @returns {Promise<string|null>} The local URL path to the saved image, or null on failure
 */
export async function generateTopicImage(topic, imageApiKey, model, imageBaseUrl, imageFallbackModel = '') {
  if (!topic?.id || !topic?.title || !imageApiKey) return null;

  const imageKeys = getImageApiKeys(imageApiKey);
  if (imageKeys.length === 0) return null;

  const imageModel = model || DEFAULT_IMAGE_MODEL;
  const baseUrl = imageBaseUrl || 'https://api.siliconflow.cn/v1';
  const fallbackModels = getImageFallbackModels(imageModel, baseUrl, imageFallbackModel);

  const imageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'images');
  fs.mkdirSync(imageDir, { recursive: true });

  try {
    return await generateImageWithKeyFallback(imageKeys, apiKey =>
      generateTopicImageWithKey(topic, apiKey, imageModel, baseUrl, imageDir, fallbackModels)
    );
  } catch (err) {
    console.warn('[generateTopicImage] Failed:', err.message);
    throw err;
  }
}

export async function generateImageWithKeyFallback(imageKeys, generate) {
  let lastError;
  for (const [index, apiKey] of imageKeys.entries()) {
    try {
      return await generate(apiKey);
    } catch (err) {
      lastError = err;
      if (index === imageKeys.length - 1 || !shouldRetryImageChannel(err)) throw err;
      console.warn('[generateTopicImage] Image channel rejected the request; trying the next configured image key');
    }
  }
  throw lastError;
}

async function generateTopicImageWithKey(topic, imageApiKey, imageModel, baseUrl, imageDir, fallbackModels) {
  const client = new OpenAI({
    apiKey: imageApiKey,
    baseURL: baseUrl,
    maxRetries: 2,
    timeout: 60_000,
  });
  const response = await generateImageWithFallback(client, {
    model: imageModel,
    prompt: buildImagePrompt(topic),
    n: 1,
    size: '1024x1024',
    response_format: 'url',
  }, buildRelaySafeImagePrompt(topic.title), fallbackModels);

  const generatedImage = extractGeneratedImage(response);
  if (!generatedImage) {
    const fields = Object.keys(response?.data?.[0] || {}).join(', ') || 'none';
    throw new Error(`图片 API 未返回可用的 URL 或 Base64 图片数据（字段: ${fields}）`);
  }

  const safeName = topic.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
  const localPath = path.join(imageDir, safeName);
  const imageBytes = generatedImage.kind === 'base64'
    ? decodeBase64Image(generatedImage.value)
    : await downloadGeneratedImage(generatedImage.value, baseUrl);
  await fs.promises.writeFile(localPath, imageBytes);

  const relativePath = '/images/' + safeName;
  console.log('[generateTopicImage] Saved:', relativePath);
  return relativePath;
}

/**
 * Normalize the common image payload shapes used by OpenAI-compatible APIs.
 * Providers may ignore response_format=url and return b64_json instead.
 */
export function extractGeneratedImage(response) {
  const image = response?.data?.[0] || response?.images?.[0] || response?.output?.[0];
  if (!image || typeof image !== 'object') return null;

  const base64 = image.b64_json || image.b64 || image.image_base64;
  if (typeof base64 === 'string' && base64.trim()) {
    return { kind: 'base64', value: base64.trim() };
  }

  const candidates = [image.url, image.image_url, image.uri, image.image?.url];
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate : candidate?.url;
    if (typeof value === 'string' && value.trim()) {
      return { kind: 'url', value: value.trim() };
    }
  }
  return null;
}

export async function generateImageWithFallback(client, request, relaySafePrompt, fallbackModels = []) {
  try {
    return await generateImageRequest(client, request);
  } catch (err) {
    if (!relaySafePrompt || !isRelayBlockedError(err) || relaySafePrompt === request.prompt) {
      throw err;
    }
    // Some relays block verbose prompts before the image model evaluates them.
    // Keep the topic title intact, but retry once without generated detail or restrictive clauses.
    console.warn('[generateTopicImage] Image request blocked by relay; retrying with a compact educational prompt');
    try {
      return await generateImageRequest(client, { ...request, prompt: relaySafePrompt });
    } catch (safePromptErr) {
      if (!isRelayBlockedError(safePromptErr)) throw safePromptErr;

      let lastError = safePromptErr;
      for (const model of [...new Set(fallbackModels)].filter(candidate => candidate && candidate !== request.model)) {
        try {
          console.warn(`[generateTopicImage] Image model ${request.model} was blocked; retrying with fallback model ${model}`);
          return await generateImageRequest(client, { ...request, model, prompt: relaySafePrompt });
        } catch (fallbackErr) {
          lastError = fallbackErr;
          if (!isRelayBlockedError(fallbackErr)) throw fallbackErr;
        }
      }
      throw lastError;
    }
  }
}

async function generateImageRequest(client, request) {
  try {
    return await client.images.generate(request);
  } catch (err) {
    if (!request.response_format || !isUnsupportedParameterError(err, 'response_format')) {
      throw err;
    }
    console.warn('[generateTopicImage] Image API does not support response_format; retrying without it');
    const fallbackRequest = { ...request };
    delete fallbackRequest.response_format;
    return client.images.generate(fallbackRequest);
  }
}

function decodeBase64Image(value) {
  const base64 = value.replace(/^data:image\/[^;,]+;base64,/i, '').trim();
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new Error('图片 API 返回的 Base64 数据为空');
  return bytes;
}

async function downloadGeneratedImage(rawUrl, baseUrl) {
  const imageUrl = new URL(rawUrl, baseUrl);
  if (!['https:', 'http:', 'data:'].includes(imageUrl.protocol)) {
    throw new Error(`图片 URL 使用了不支持的协议: ${imageUrl.protocol}`);
  }
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Generate a detail + illustration for a topic (combines text and image generation).
 */
export async function generateDetailWithImage(providerOrConfig, plan, topicId, imageApiKey, model = 'gpt-4o-mini', imageModel, explainStyle, imageBaseUrl, imageFallbackModel) {
  // First generate the text detail
  const content = await generateDetail(providerOrConfig, plan, topicId, model, explainStyle);

  // Then generate an illustration (fire-and-forget on the image, don't block)
  const topic = plan.topics.find(t => t.id === topicId);
  if (topic && imageApiKey) {
    generateTopicImage(topic, imageApiKey, imageModel, imageBaseUrl, imageFallbackModel)
      .then(imageUrl => {
        if (imageUrl && topic) {
          updateTopic(plan.id, topicId, { imageUrl });
        }
      })
      .catch(err => console.warn('[generateDetailWithImage] Image generation failed:', err.message));
  }

  return content;
}

// ═══════════════════════════════════════════════════════

/**
 * JSON Schema validation for LLM outputs.
 * Returns null if valid, or an error message string if invalid.
 */

/** Validate blueprint output */
function validateBlueprintOutput(data) {
  if (!data || typeof data !== 'object') return '输出不是有效对象';
  if (!data.title || typeof data.title !== 'string') return '缺少 title 字段';
  if (!Array.isArray(data.orders) || data.orders.length === 0) return 'orders 必须是数组且不为空';
  for (let i = 0; i < data.orders.length; i++) {
    const o = data.orders[i];
    if (typeof o.index !== 'number') return `orders[${i}].index 必须是数字`;
    if (!o.topicTitle || typeof o.topicTitle !== 'string') return `orders[${i}].topicTitle 必须是字符串`;
    if (!['choice', 'open'].includes(o.type)) return `orders[${i}].type 必须是 choice 或 open，得到 "${o.type}"`;
    if (!['easy', 'medium', 'hard'].includes(o.difficulty)) return `orders[${i}].difficulty 必须是 easy/medium/hard，得到 "${o.difficulty}"`;
  }
  return null;
}

/** Validate self-correction output */
function validateSelfCorrectOutput(data) {
  if (!data || typeof data !== 'object') return '输出不是有效对象';
  if (!data.studentAnswer || typeof data.studentAnswer !== 'string') return 'studentAnswer 字段缺失或非字符串';
  // reasoning is optional
  return null;
}
// ═══════════════════════════════════════════════════════
//  SILICONFLOW TTS (Text-to-Speech)
// ═══════════════════════════════════════════════════════

/**
 * Text-to-speech: synthesize speech using SiliconFlow CosyVoice2.
 * @param {string} apiKey - SiliconFlow API key
 * @param {string} text - Text to synthesize
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function textToSpeech(apiKey, text) {
  if (!apiKey) throw new Error('请先配置 API Key');
  if (!text || !text.trim()) throw new Error('请输入要合成的文本');

  const response = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: text.slice(0, 2000),
      voice: 'default',
      response_format: 'mp3',
      speed: 1.0,
    }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`TTS 请求失败 (${response.status}): ${errBody.slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export function getEngineCacheDiagnostics() {
  return engineCacheMonitor.summary();
}

function parseResourceRecommendations(content, fallbackTitle) {
  const raw = String(content || '').trim();
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);

  const objectStart = raw.indexOf('{');
  const objectEnd = raw.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(raw.slice(objectStart, objectEnd + 1));
  }

  let parsed = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate || '{}');
      break;
    } catch {}
  }
  if (!parsed) {
    throw new Error('AI 返回的资源推荐 JSON 不完整');
  }

  const resources = (Array.isArray(parsed.resources) ? parsed.resources : [])
    .filter(r => r && typeof r === 'object')
    .map(r => ({
      type: r.type || 'article',
      title: String(r.title || '').trim(),
      source: String(r.source || '').trim(),
      level: r.level || 'intermediate',
      paid: !!r.paid,
      reason: String(r.reason || '').trim(),
      url: String(r.url || '').trim(),
    }))
    .filter(r => r.title);

  if (resources.length === 0) {
    throw new Error('AI 未返回有效的学习资源');
  }

  return {
    topicTitle: parsed.topicTitle || fallbackTitle,
    resources,
  };
}

/**
 * Recommend learning resources for a knowledge point.
 * Returns structured recommendations across multiple channels/forms
 * (books, videos, docs, articles, courses, interactive) so the learner
 * can reinforce the topic through their preferred medium.
 *
 * @param {object} providerOrConfig - Provider instance or config
 * @param {object} plan - Full plan object
 * @param {string} topicId - Topic id
 * @param {string} model - Model name
 * @param {{signal?: AbortSignal}} options - Cancellation options
 * @returns {Promise<{topicTitle: string, resources: Array}>}
 */
export async function recommendResources(providerOrConfig, plan, topicId, model = 'gpt-4o-mini', options = {}) {
  const topic = plan.topics.find(t => t.id === topicId);
  if (!topic) throw new Error('Topic not found');

  const provider = resolveProvider(providerOrConfig, model);

  const context = cleanDetailForContext(topic.detail).slice(0, 800);

  const systemPrompt =
    '你是一位资深的学习资源策展人。根据用户正在学习的一个知识点，推荐多种渠道、多种形式的优质学习资源。\n' +
    '## 要求\n' +
    '- 覆盖多种「形式」：书籍(book)、视频(video)、官方文档(doc)、技术文章(article)、在线课程(course)、互动练习(practice)\n' +
    '- 覆盖多种「渠道」：经典教材、知名慕课平台、官方文档、技术博客/社区（如官方文档、MDN、Stack Overflow、知名博客等）\n' +
    '- 每个资源必须真实、权威、广为人知，不要编造不存在的书名或链接\n' +
    '- 恰好推荐 6 个资源，每个资源的推荐理由不超过 40 个汉字\n' +
    '- 标注适合人群（初学者/进阶）与推荐理由（为什么对这个知识点有帮助）\n' +
    '- 优先推荐免费或易获取的资源，付费资源需明确标注\n' +
    '## 输出格式（只输出 JSON）\n' +
    '{\n' +
    '  "topicTitle": "知识点名称",\n' +
    '  "resources": [\n' +
    '    { "type": "book|video|doc|article|course|practice", "title": "资源名称", "source": "渠道/平台", "level": "beginner|intermediate|advanced", "paid": false, "reason": "推荐理由", "url": "官方/权威链接(可选，确保真实)" }\n' +
    '  ]\n' +
    '}\n' +
    '只输出 JSON，不要其他文字。';

  const userMessage =
    `知识点名称：${topic.title}\n` +
    `知识点讲解摘要：${context || topic.title}\n\n` +
    '请恰好推荐 6 个学习资源，覆盖书籍、视频、文档、文章、课程、互动练习等不同形式与渠道。';

  const complete = (recovery = false) => provider.complete([
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: recovery
        ? `${userMessage}\n\n上一次输出无效或被截断。请精简内容，严格输出完整 JSON，不要附加说明。`
        : userMessage,
    },
  ], {
    temperature: recovery ? 0.2 : 0.4,
    maxTokens: 4096,
    timeoutMs: 120_000,
    responseFormat: { type: 'json_object' },
    model,
    signal: options.signal,
  });

  let result = await complete();
  try {
    if (result.finishReason === 'length') {
      throw new Error('AI 返回的资源推荐被截断');
    }
    return parseResourceRecommendations(result.content, topic.title);
  } catch {
    result = await complete(true);
  }

  if (result.finishReason === 'length') {
    throw new Error('AI 返回的资源推荐仍被截断，请稍后重试');
  }
  return parseResourceRecommendations(result.content, topic.title);
}

/**
 * Generate a lightweight quick quiz (2-3 questions) from random topics in a plan.
 * Uses fewer tokens than a full exam paper.
 * @param {object} provider - Provider instance
 * @param {object} plan - Plan object
 * @param {string} model - Model name
 * @returns {Promise<{questions: Array, topicCount: number}>}
 */

export default {
  generateDetail,
  generateDetailWithImage,
  generateTopicImage,
  buildImagePrompt,
  answerFollowUp,
  answerAnalysisFollowUp,
  analyzeLearning,
  generateReview,
  gradeExercises,
  analyzeWeakPoints,
  generateExam,
  gradeExam,
  generateExamPractice,
  generateBlueprint,
  generateSingleQuestion,
  selfCorrectQuestion,
  generateExamStream,
  evaluateQuestionQuality,
  startInteractiveDetail,
  continueInteractiveDetail,
  revealEmbeddedErrors,
  examineTeachingErrors,
  decomposeTopic,
  generateQuickQuiz,
  analyzeFeynmanSession,
  textToSpeech,
  getEngineCacheDiagnostics,
  createProviderFromConfig,
  inferTopicRelations,
  recommendResources,
  // Fact-check engine (re-exported from fact-checker.js)
  factCheckDetail,
  factCheckQuickScan,
  autoFixUncertainClaims,
  applyFixesToContent,
  buildFactCheckReport,
  buildFactCheckSummary,
};

export {
  applyFixesToContent,
  autoFixUncertainClaims,
  buildFactCheckReport,
  buildFactCheckSummary,
  factCheckDetail,
  factCheckQuickScan,
};

export {
  generateExam, gradeExam, generateExamPractice, generateExamStream,
  generateBlueprint, generateSingleQuestion, selfCorrectQuestion,
  evaluateQuestionQuality,
} from './exam-engine.js';

export {
  startInteractiveDetail, continueInteractiveDetail, streamInteractiveStart,
  streamInteractiveContinue, revealEmbeddedErrors, examineTeachingErrors,
  decomposeTopic,
} from './interactive-teacher.js';

export {
  answerFollowUp, analyzeLearning, answerAnalysisFollowUp,
  analyzeCoreTopics, generateReview, gradeExercises, analyzeWeakPoints,
  generateQuickQuiz, analyzeFeynmanSession,
} from './learning-analyzer.js';
