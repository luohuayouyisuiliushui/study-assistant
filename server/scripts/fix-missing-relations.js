/**
 * 修复脚本：为已有讲解内容但缺少关联关系的知识点补全关系。
 *
 * 此脚本执行两步修复：
 * 1. 文本提取：对有 detail 且包含"与相关知识点的联系"段落的知识点，
 *    调用 extractRelationsFromDetail 提取关系并保存。
 * 2. AI 推断（--ai 参数）：对文本提取未能覆盖的知识点（缺段落等），
 *    调用 inferTopicRelations 进行 AI 推断，与现有关系合并。
 *
 * 用法：
 *   node server/scripts/fix-missing-relations.js <planId> [--dry-run]
 *      仅执行文本提取（不涉及 AI，不需要 API Key）
 *   node server/scripts/fix-missing-relations.js <planId> --ai [--dry-run]
 *      执行文本提取 + AI 推断（需要 server/.env 中配置 OPENAI_API_KEY）
 *   node server/scripts/fix-missing-relations.js <planId> --ai-only [--dry-run]
 *      仅执行 AI 推断（跳过文本提取）
 *
 *   --dry-run: 仅输出将要执行的操作，不修改数据
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadPlan(planId) {
  const path = resolve(__dirname, '..', 'data', 'learn', 'plans', `${planId}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function savePlan(plan) {
  const path = resolve(__dirname, '..', 'data', 'learn', 'plans', `${plan.id}.json`);
  writeFileSync(path, JSON.stringify(plan, null, 2), 'utf8');
}

// ── 从公开数据层导入 extractRelationsFromDetail ──
async function main() {
  const args = process.argv.slice(2);
  const planId = args[0];
  const dryRun = args.includes('--dry-run');
  const useAI = args.includes('--ai') || args.includes('--ai-only');
  const aiOnly = args.includes('--ai-only');

  if (!planId || planId.startsWith('--')) {
    console.error('用法: node server/scripts/fix-missing-relations.js <planId> [--dry-run] [--ai|--ai-only]');
    process.exit(1);
  }

  console.log(`📋 加载计划: ${planId}`);
  const plan = loadPlan(planId);
  console.log(`   计划名称: ${plan.name}`);
  console.log(`   知识点总数: ${plan.topics.length}`);
  console.log(`   模式: ${dryRun ? '🔍 预览 (--dry-run)' : '✏️  执行'}`);

  // ── 动态导入 ──
  const { extractRelationsFromDetail } = await import('../engine/learn-store.js');

  // ── 第一步：文本提取（--ai-only 模式跳过） ──
  const textExtracted = [];

  if (!aiOnly) {
    console.log('\n═══════════════════════════════════════');
    console.log('步骤 1: 从 detail 文本提取关联关系');
    console.log('═══════════════════════════════════════');

  for (const topic of plan.topics) {
    if (!topic.detail || topic.detail.length < 200) continue;

    // 检查是否已有关系
    const hasExisting = (topic.prerequisites?.length || 0) > 0 ||
                        (topic.relatedTopics?.length || 0) > 0;
    if (hasExisting) {
      console.log(`   ⏭️  已跳过 ${topic.title}（已有 ${topic.prerequisites?.length || 0} 个前置 + ${topic.relatedTopics?.length || 0} 个相关关系）`);
      continue;
    }

    // 检查是否有 "与相关知识点的联系" 段落（支持多种标题格式）
    const hasSection = /^#{2,4}\s*(?:承上启下\s*[：:]\s*)?与相关知识点的联系\s*$/m.test(topic.detail) ||
                       /^#{2,4}\s*(?:承上启下\s*[：:]\s*)?(?:关联|相关|联系|后续|延伸)(?:知识|学习|概念|主题)?(?:点)?\s*(?:的联系|的关系)?\s*$/m.test(topic.detail);
    if (!hasSection) {
      console.log(`   ⏭️  跳过 ${topic.title}（detail 中没有"与相关知识点的联系"段落，后续由 AI 推断处理）`);
      continue;
    }

    const edges = extractRelationsFromDetail(topic.detail, plan.topics, topic.id);
    if (edges.length === 0) {
      console.log(`   ⚠️  ${topic.title}：有段落但未解析出有效关系`);
      continue;
    }

    const prereqs = new Set(topic.prerequisites || []);
    const related = new Set(topic.relatedTopics || []);

    for (const e of edges) {
      const targetId = e.to === topic.id ? e.from : e.to;
      const targetTopic = plan.topics.find(t => t.id === targetId);
      const targetTitle = targetTopic?.title || '(未知)';
      if (e.to === topic.id) {
        if (e.type === 'prerequisite' || e.type === 'buildsOn' || e.type === 'references') {
          prereqs.add(e.from);
          console.log(`   📍 ${topic.title} ← [${e.type}] ${targetTitle}`);
        } else {
          related.add(e.from);
          console.log(`   🔗 ${topic.title} ↔ [${e.type}] ${targetTitle}`);
        }
      } else if (e.from === topic.id) {
        related.add(e.to);
        console.log(`   🔗 ${topic.title} → [${e.type}] ${targetTitle}`);
      }
    }

    textExtracted.push({
      id: topic.id,
      title: topic.title,
      prerequisites: [...prereqs],
      relatedTopics: [...related],
    });

    if (!dryRun) {
      topic.prerequisites = [...prereqs];
      topic.relatedTopics = [...related];
    }
  }

  console.log(`\n   文本提取完成: ${textExtracted.length} 个知识点提取了关系\n`);
  } // end if (!aiOnly) — text extraction loop

  // ── 第二步：分析哪些知识点还需要 AI 推断 ──
  console.log('═══════════════════════════════════════');
  console.log('步骤 2: 标记需要 AI 推断的知识点');
  console.log('═══════════════════════════════════════');

  const needAI = [];
  for (const topic of plan.topics) {
    if (!topic.detail || topic.detail.length < 200) continue;
    const hasExisting = (topic.prerequisites?.length || 0) > 0 ||
                        (topic.relatedTopics?.length || 0) > 0;
    if (hasExisting) continue;
    const hasSection = /^#{2,4}\s*(?:承上启下\s*[：:]\s*)?与相关知识点的联系\s*$/m.test(topic.detail) ||
                       /^#{2,4}\s*(?:承上启下\s*[：:]\s*)?(?:关联|相关|联系|后续|延伸)(?:知识|学习|概念|主题)?(?:点)?\s*(?:的联系|的关系)?\s*$/m.test(topic.detail);
    if (!hasSection) {
      needAI.push({ id: topic.id, title: topic.title });
    }
  }

  if (needAI.length === 0) {
    console.log('   ✅ 所有知识点已有关系或可以通过文本提取覆盖，无需 AI 推断。\n');
  } else {
    console.log(`   ⚠️  以下 ${needAI.length} 个知识点缺少"与相关知识点的联系"段落，需要 AI 推断：`);
    needAI.forEach(t => console.log(`      - ${t.title}`));
    console.log();
    console.log('   请通过 API 手动触发 AI 推断:');
    console.log(`   POST /api/learn/plans/${planId}/infer-relations`);
    console.log('   或使用 curl:');
    console.log(`   curl -X POST http://localhost:3001/api/learn/plans/${planId}/infer-relations \\`);
    console.log(`     -H "Content-Type: application/json" -d '{}'`);
    console.log();
  }

  // ── 保存文本提取结果 ──
  if (!aiOnly) {
    if (!dryRun && textExtracted.length > 0) {
      savePlan(plan);
      console.log(`✅ 已保存更新（文本提取 ${textExtracted.length} 个知识点的关系已写入）`);
    } else if (dryRun && textExtracted.length > 0) {
      console.log(`🔍 [dry-run] 将更新 ${textExtracted.length} 个知识点，但未执行写入。`);
    } else {
      console.log('ℹ️  没有需要保存的文本提取变更。');
    }

    // ── 输出摘要 ──
    if (textExtracted.length > 0) {
      console.log('\n═══════════════════════════════════════');
      console.log('修复摘要（文本提取）');
      console.log('═══════════════════════════════════════');
      for (const item of textExtracted) {
        const prereqTitles = item.prerequisites.map(id => {
          const t = plan.topics.find(p => p.id === id);
          return t ? t.title : id;
        });
        const relatedTitles = item.relatedTopics.map(id => {
          const t = plan.topics.find(p => p.id === id);
          return t ? t.title : id;
        });
        console.log(`\n📘 ${item.title}`);
        if (prereqTitles.length) console.log(`   前置依赖: ${prereqTitles.join(', ')}`);
        if (relatedTitles.length) console.log(`   相关知识点: ${relatedTitles.join(', ')}`);
      }
      console.log();
    }
  } // end !aiOnly

  // ── 第三步：AI 推断（--ai 模式） ──
  if (useAI) {
    console.log('\n═══════════════════════════════════════');
    console.log('步骤 3: AI 推断关联关系（inferTopicRelations）');
    console.log('═══════════════════════════════════════');

    // 加载 .env（如果存在）
    const envPath = resolve(__dirname, '..', '.env');
    let apiKey = process.env.OPENAI_API_KEY;
    let baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    let model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    try {
      const envContent = readFileSync(envPath, 'utf8');
      const keyMatch = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
      if (keyMatch) apiKey = keyMatch[1].trim();
      const urlMatch = envContent.match(/^OPENAI_BASE_URL=(.+)$/m);
      if (urlMatch) baseURL = urlMatch[1].trim();
      const modelMatch = envContent.match(/^OPENAI_MODEL=(.+)$/m);
      if (modelMatch) model = modelMatch[1].trim();
    } catch {}

    if (!apiKey) {
      console.error('❌ 未找到 OPENAI_API_KEY，请在 server/.env 中配置或通过环境变量设置');
      process.exit(1);
    }

    const { createProviderFromConfig, inferTopicRelations } = await import('../engine/learn-engine.js');
    const provider = createProviderFromConfig(apiKey, baseURL, model);

    console.log(`   正在调用 AI 推断（${model}）...`);
    if (dryRun) {
      console.log('   🔍 [dry-run] 跳过 AI 调用');
    } else {
      try {
        const result = await inferTopicRelations(provider, plan, model);
        console.log(`   ✅ AI 推断完成，共识别 ${result.relations.length} 条关系`);
        if (result.analysis) {
          console.log(`   📝 分析: ${result.analysis.substring(0, 200)}`);
        }
        // 重新加载 plan（inferTopicRelations 已通过 updateTopic 写入文件）
        const updatedPlan = loadPlan(planId);
        const updatedCount = updatedPlan.topics.filter(t =>
          (t.prerequisites?.length || 0) > 0 || (t.relatedTopics?.length || 0) > 0
        ).length;
        console.log(`   现在共有 ${updatedCount} 个知识点具有关联关系`);
      } catch (err) {
        console.error(`   ❌ AI 推断失败: ${err.message}`);
      }
    }
  } else if (needAI.length > 0) {
    console.log('\n💡 提示: 要触发 AI 推断补全剩余知识点的关系，请添加 --ai 参数重新运行');
    console.log(`   node server/scripts/fix-missing-relations.js ${planId} --ai\n`);
  }
}

main().catch(err => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
