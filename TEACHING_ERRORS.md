# 教学错误系统 (Teaching Errors) — 技术文档

## 概述

把"AI 在讲解中偶尔埋错"从**随机幻觉**升级为**有教育意义的教学错误**（Erroneous Examples）：
每个错误都显式绑定「知识误区 misconception + 布鲁姆认知层次 bloomLevel + 错误类型 errorType」，
模仿真实学生的典型误解，用以锻炼批判性思维。学生"学完了"时经**生成-检查双代理**流程揭示，
并将其未识别的错误联动到薄弱点分析。

## 核心流程

```
讲解生成（埋错） → 学生自报发现的错误 → [学完了]
        ↓
[生成代理] revealEmbeddedErrors: 检出候选教学错误（结构化字段）
        ↓
[检查代理] examineTeachingErrors: 剔除假阳性 / 低教学价值，补全 misconception/bloomLevel
        ↓
标记 recognized（学生是否识别） → recordTeachingErrors 持久化到 topic.teachingErrors
        ↓
analyzeWeakPoints: 未识别的教学错误 → 薄弱点证据
```

## 误区分类目录 (MISCONCEPTION_TAXONOMY)

`learn-prompts.js` 导出的稳定常量，供 prompt 拼接与 engine 校验共用：

- **bloomLevels**：记住 / 理解 / 应用 / 分析 / 评价 / 创造
- **errorTypes**：`boundary`(边界条件偏差)、`concept-approx`(概念近似不精确)、
  `concept-confusion`(概念混淆)、`causal-fallacy`(因果谬误)、`overgeneralization`(过度概括)、
  `code-bug`(代码错误)、`symbol-slip`(符号/计算错误)、`procedural`(步骤缺失/顺序错误)

## 关键实现

| 位置 | 职责 |
|------|------|
| `learn-prompts.js` · `MISCONCEPTION_TAXONOMY` | 误区/认知层次分类目录（frozen 常量） |
| `learn-prompts.js` · `buildTeachingErrorSpec()` | 生成"教学错误设计规范"文本块 |
| `learn-prompts.js` · `STABLE_TEACHING_ERROR_EXAM_PROMPT` | 检查代理 prompt（generate-check） |
| `learn-prompts.js` · `STABLE_INTERACTIVE_CHALLENGE_SYSTEM_PROMPT` | 挑战模式：错误绑定类型目录 |
| `learn-engine.js` · `revealEmbeddedErrors(..., recognizedErrors)` | 生成代理 + 结构化输出 + recognized 标记 + 持久化 |
| `learn-engine.js` · `examineTeachingErrors()` | 检查代理：保留 isRealError && pedagogicalValue≥6 |
| `learn-engine.js` · `analyzeWeakPoints()` | 纳入 `unrecognizedTeachingErrors` 作为薄弱点证据 |
| `learn-store.js` · `recordTeachingErrors()` | 持久化 `topic.teachingErrors[]` |
| `routes/learn.js` · `POST /reveal-errors/:topicId` | 接收 `{ recognizedErrors }` |
| `client/api.js` · `revealErrors(planId, topicId, recognizedErrors)` | 传递学生自报 |
| `client/TopicDetail.jsx` | 自报输入框 + 揭示弹窗（误区/认知层次/识别状态） |

## 数据模型

```js
topic.teachingErrors = [{
  location, description, correction,
  errorType,        // 分类目录编码
  misconception,    // 针对的具体误区
  bloomLevel,       // 认知层次
  pedagogicalValue, // 检查代理评分 0-10（可选）
  recognized,       // 学生是否识别（自报或追问中发现）
  source,           // 'qa' 表示来自追问历史
}]
topic.teachingErrorsUpdatedAt = timestamp
```

## reveal 返回结构

```js
{ errors: [...], hasErrors: bool, unrecognizedCount: number }
```

## 测试

```bash
cd server
node --test __tests__/learn-prompts.test.js   # 分类目录 / spec / 检查代理 prompt
node --test __tests__/learn-engine.test.js     # examineTeachingErrors + 结构化 reveal
node --test __tests__/learn-store.test.js       # recordTeachingErrors CRUD
```

## 兼容性 & 兜底

- 检查代理失败 → 回退到旧的 `verifyErrorCandidates` 假阳性过滤；再失败 → 保留原候选
- 检查代理把所有错误都剔除 → 保留原候选，避免过度过滤
- 持久化为 best-effort，失败不影响揭示结果
- 旧字段 `type` 仍被读取（`err.errorType || err.type`），向后兼容

## 参考理论

布鲁姆分类学（Bloom's Taxonomy）、教学错误示例（Erroneous Examples）、
生成-检查代理框架（Generation + Examination Agent）、L-RISK 评估视角（关注对心智模型的影响）。
