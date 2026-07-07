# 组卷系统 (Exam Paper System) — 技术文档

## 概述

AI 驱动的组卷功能，支持选定知识点范围，自动生成试卷、在线作答、AI 批改、针对性练习。位于学习计划详情页的「📝 组卷」按钮。

## 核心架构

```
用户选择知识点 + 配置
        ↓
[蓝图算法] → 分层抽样计算 (topic × type × difficulty) 订单列表
        ↓
[并行生成] → 每批 5 道并发，每道题经过三重过滤：
  ① JSON Schema 校验（结构合规）
  ② 自校验（AI 以考生身份作答，比对答案）
  ③ 质量评估（5 维度评分，accept/revise/regenerate）
        ↓
[修订迭代] → 质量返回 "revise" 时自动修订，不丢弃
        ↓
[保存] → examPapers[] 存入计划数据，错题→复习联动
```

## 6 重质量保障（按执行顺序）

| # | 机制 | 文件 | 函数 |
|---|------|------|------|
| 1 | **布鲁姆分类学** — 6 认知层次映射到难度 | `learn-prompts.js` | `STABLE_EXAM_SINGLE_QUESTION_PROMPT` |
| 2 | **Few-shot 示例** — 3 个高质量题目示范 | `learn-prompts.js` | `STABLE_EXAM_SINGLE_QUESTION_PROMPT` |
| 3 | **JSON Schema 校验** — 字段存在、类型、值域 | `learn-engine.js` | `validateBlueprintOutput()` / `validateQuestionOutput()` |
| 4 | **自校验** — AI 以考生身份答题验证 | `learn-engine.js` | `selfCorrectQuestion()` |
| 5 | **质量评估** — 5 维度评分 (OpenAI Evals 思路) | `learn-prompts.js` | `STABLE_EXAM_QUALITY_EVAL_PROMPT` |
| 6 | **修订迭代** — "生成→评判→修正" 循环 | `learn-engine.js` | `reviseQuestion()` |

## 数据模型

试卷存储在 `plan.examPapers[]` 数组中：

```js
{
  examPapers: [{
    id: "uuid",           // 试卷 ID
    title: "试卷标题",
    createdAt: timestamp,
    config: {
      topicIds: ["id1", "id2"],
      questionCount: 10,
      choiceRatio: 0.6,
      difficulty: "balanced"  // "easy" | "balanced" | "hard"
    },
    paper: "# Markdown 格式的完整试卷",
    questions: [{
      id: "uuid",
      index: 0,
      type: "choice" | "open",
      question: "题干",
      options: ["A. ...", "B. ..."],
      answer: "正确答案",
      explanation: "解析",
      conceptTag: "关联知识点",
      topicId: "知识点 ID",
      difficulty: "easy" | "medium" | "hard",
      validated: true | false,
      qualityScore: 7.8,   // 质量评分（可选）
      bloomLevel: "理解"     // 认知层次
    }],
    results: null | [{       // 批改结果
      exerciseIndex: 0,
      correct: true | false,
      userAnswer: "用户的答案",
      correctAnswer: "标准答案",
      explanation: "批改解析"
    }],
    gradedAt: null | timestamp
  }]
}
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/learn/plans/:planId/exam/generate` | 生成试卷（非流式） |
| POST | `/api/learn/plans/:planId/exam/generate-stream` | 生成试卷（SSE 流式，逐题推送） |
| POST | `/api/learn/plans/:planId/exam/:examId/submit` | 提交答案批改 |
| GET | `/api/learn/plans/:planId/exams` | 获取历史试卷列表 |
| DELETE | `/api/learn/plans/:planId/exam/:examId` | 删除试卷 |
| POST | `/api/learn/plans/:planId/exam/:examId/practice` | 基于错题生成针对性练习 |

### SSE 流式事件格式

```
data: {"type":"status","data":"正在计算命题蓝图..."}
data: {"type":"blueprint","data":{"total":10,"title":"试卷标题"}}
data: {"type":"question","data":{questionObject}}
data: {"type":"done","data":{"examId":"...","totalQuestions":10}}
data: {"type":"error","data":"错误信息"}
```

SSE 路由有 120 秒超时，客户端断开自动停止。

## 蓝图算法 (SDV 条件生成思路)

纯确定性算法，**不需要 AI 调用**。位于 `generateBlueprint()`：

1. 根据 difficulty 配置计算 easy/medium/hard 各多少题
2. 根据 choiceRatio 将每层拆分为 choice/open
3. Shuffle 混合难度和题型
4. Round-robin 分配到每个知识点（保证均匀覆盖）

难度比例映射：
- `easy`: 简单 50% / 中等 40% / 较难 10%
- `balanced` (默认): 简单 30% / 中等 50% / 较难 20%
- `hard`: 简单 10% / 中等 40% / 较难 50%

## 关键文件

| 文件 | 职责 |
|------|------|
| `server/engine/learn-engine.js` | 引擎函数：generateExam / generateExamStream / generateBlueprint / generateSingleQuestion / selfCorrectQuestion / evaluateQuestionQuality / reviseQuestion / generateExamPractice |
| `server/engine/learn-prompts.js` | 所有 AI Prompt 常量（STABLE_EXAM_xxx） |
| `server/engine/learn-store.js` | 数据存储：addExamPaper / getExamPapers / updateExamResults / deleteExamPaper |
| `server/routes/learn.js` | API 路由（/exam/*） |
| `client/src/components/ExamPaperModal.jsx` | 前端组卷弹窗（选题 → 配置 → 流式生成 → 作答 → 结果 → 历史） |
| `client/src/api.js` | 前端 API 方法 |
| `client/src/styles/app.css` | 组卷样式 |

## 测试

```bash
cd server
node --test __tests__/learn-store.test.js    # 存储层测试（含 exam CRUD）
node --test __tests__/learn-engine.test.js   # 引擎测试（含 blueprint + validator + practice）
```

新增测试：14 个（5 store + 4 blueprint + 7 validators + 3 practice）

## 配置要求

使用前需要在设置中配置：
- **API Key**: 中转站或直接 API key
- **Base URL**: API 地址
- **Model**: 需支持 JSON 输出的模型（如 deepseek-v4-pro, gpt-4o 等）

默认模型 `gpt-4o-mini` 可能在某些中转站不可用。

## 已知限制

- 自校验和质量评估需要模型能稳定输出 JSON（某些中转站模型可能返回格式不一致→走兜底逻辑）
- 题目数量越多生成时间越长（每道题 ~3 次 API 调用）
- 人工审核入口尚未实现
