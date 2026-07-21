# Study Assistant — 领域术语表

AI 驱动的交互式学习助手，围绕"学习计划 -> 知识点 -> 学习内容 -> 测评反馈"的知识学习闭环。

> 此文件供 AI 操作代码时统一命名使用。下列术语是代码、注释、API 路由和 UI 文案中的正式名称。

## Language（基本概念）

**Plan**（学习计划）：
一个学习计划，包含多个知识点和阶段。用户可创建、编辑、删除计划。
_Avoid_：课程、学习方案、syllabus

**Topic**（知识点）：
学习计划下的一个知识单元。每个 Topic 可生成详细的学习内容（Detail），可分阶段组织、支持调整顺序。
_Avoid_：章节、主题、node、subject

**Detail**（学习内容）：
AI 为一个 Topic 生成的详细讲解内容，包含 Markdown 格式的知识讲解、代码示例、Mermaid 图表等。
_Avoid_：内容、讲解、content、article

**Phase**（学习阶段）：
Plan 中的学习阶段分组，每个阶段包含多个 Topic。用于有序推进学习进度。
_Avoid_：章节、单元、module

**History**（学习历史）：
用户对某个 Topic 的学习交互记录（问答、复习等），记录在 Plan JSON 中。
_Avoid_：日志、记录、log

## Interactive Teaching（交互教学）

**Interactive Teaching**（交互教学）：
AI 与学生进行对话式教学的模式总称，包含以下 5 种基础模式：

**Stepwise**（逐步引导）：
AI 按步骤逐段讲解，每个步骤后暂停等待学生确认。
_Avoid_：分步、逐步

**Realtime**（实时交互）：
AI 实时响应学生的问题和输入，灵活调整讲解节奏，小块输出、高频率交互。
_Avoid_：实时对话、chat

**Scaffold**（支架式教学）：
AI 提供结构化的学习支架，将复杂知识点分解为递进子问题，每次专注一个，用户掌握后再进入下一个。
_Avoid_：搭脚手架、引导式

**Feynman**（费曼学习法）：
学生向 AI 讲解知识点，AI 分析薄弱点和误解，形成学习闭环。
_Avoid_：费曼技巧、retelling

**Challenge**（挑战模式）：
AI 在讲解中故意嵌入错误，训练学生的批判性思维。
_Avoid_：找茬、错误检测

另有 `stepwise-challenge` 和 `realtime-challenge` 两种复合模式（路由层接受，但对应的 prompt 常量在 `interactive-teacher.js` 中未导入，运行时会报错）。

## Assessment & Feedback（评估与反馈）

**Review**（复习）：
AI 基于历史学习记录生成复习内容和练习。
_Avoid_：回顾、温习

**Quiz**（快速测验）：
短平快的知识点测验，即时反馈。结果存储在 `plan.quickQuizHistory`。
_Avoid_：测试、小测

**Exam**（试卷）：
正式的考核试卷，包含多道题目，支持生成、作答、自动评分。结果存储在 `plan.examPapers`。
_Avoid_：考试、测验、test

**Exercise**（练习）：
学习内容中嵌入的练习题，学生提交后 AI 自动批改。每个 exercise 有 `id`、`type`、`userAnswer`、`correct`、`gradedAt` 等字段。
_Avoid_：习题、作业

**Weak Point**（弱项）：
AI 分析学生的学习记录后识别的薄弱知识点。
_Avoid_：薄弱点、不足

**Fact Check**（事实核查）：
AI 对已生成的 Detail 内容进行准确性验证，标记不确定或可能错误的内容。
_Avoid_：内容校验、验证

## Knowledge & Analysis（知识与分析）

**Knowledge Graph**（知识图谱）：
知识点之间的前置依赖、扩展、对比、示例、构建于、引用等关系构成的图结构。关系从 Detail 中的"与相关知识点的联系"段落自动提取。
_Avoid_：关系图、依赖图

**Core Topic**（核心知识点）：
Plan 中最重要的、起枢纽作用的知识点，由 AI 分析识别。
_Avoid_：重点、关键节点

**Decompose**（知识点拆分）：
将一个 Topic 拆分为更细粒度的子知识点。
_Avoid_：分解、拆分

**Learning Analyzer**（学习分析引擎）：
负责练习批改（`gradeExercises`）、薄弱点分析（`analyzeWeakPoints`）、概念理解评估等核心分析逻辑的模块。位于 `server/engine/learning-analyzer.js`。
_Avoid_：分析器、grading engine

**Adaptive Engine**（自适应引擎）：
根据用户行为数据动态调整教学策略的模块，包含错误状态机（ErrorStateMachine）和干预推荐器（InterventionRecommender）。
_Avoid_：自适应系统、推荐引擎

**Data Flywheel**（数据飞轮）：
自适应学习闭环：用户行为 → 薄弱点分析 → 干预建议 → 教学策略调整 → 新的用户行为。
_Avoid_：反馈循环、自适应引擎

## User Profile（学习画像）

**Profile**（学习画像）：
跨计划聚合的用户学习画像，包含学习者类型、强项、弱项、学习模式、个性化建议等。由 AI 分析生成（`generateUserProfile`）或行为数据自动更新（`profileUpdater`）。
_Avoid_：用户设置、偏好

**Profile Summary**（画像摘要）：
无需 AI 调用的轻量级跨计划统计摘要，通过 `GET /api/user-profile/summary` 获取。包含 `stats`、`exerciseStats`、`todayStats`、`weekStats`、`timeDistribution` 等字段。
_Avoid_：摘要数据、概览

**Today Stats**（今日答题统计）：
当天答题数的统计，包含 `total`（总题数）、`correct`（正确数）、`rate`（正确率），以及按类型（`exercises` / `exams` / `quizzes`）的细分。数据来自 exercise 的 `gradedAt`、exam 的 `gradedAt`、quiz 的 `createdAt`。
_Avoid_：今日数据、当天统计

**Week Stats**（本周答题统计）：
近 7 天的答题统计，结构同 Today Stats，时间范围为当天往前 6 天（共 7 天）。
_Avoid_：周报、近一周

**Learner Persona**（学习者类型）：
AI 分析用户提问模式后识别出的学习风格，如"深度思考型"、"实践应用型"、"类比联想型"、"谨慎确认型"、"目标驱动型"。置信度由 `confidence` 字段表示。
_Avoid_：学习风格、用户画像类型

**Behavior Profile**（行为画像）：
基于用户实际行为数据（练习正确率、提问分布等）自动构建的画像，不依赖 AI 生成。通过 `profileUpdater` 函数增量更新。
_Avoid_：行为数据、自动画像

## Export（数据导出）

**Export**（导出）：
将学习内容导出为外部格式。支持以下格式：
- **Anki**：APKG 格式，含图片和样式
- **Markdown**：纯文本笔记
- **OPML**：思维导图格式
- **Notion**：CSV 格式
- **JSON**：原始数据
_Avoid_：下载、输出

## Data & Storage（数据存储）

**Trash**（回收站）：
被删除的 Plan 暂存区，支持 30 天内恢复。
_Avoid_：已删除、垃圾桶

**Atomic Write**（原子写入）：
通过临时文件 + rename 保证文件写入的原子性，防止进程崩溃时数据损坏。
_Avoid_：安全写入、事务写入

**Flag**（标记文件）：
标记某个 Topic 的 Detail 是否需要重新生成（如 AI 配置变更后）。
_Avoid_：标记、脏标记、dirty flag

**Cache Monitor**（缓存监控）：
跟踪 OpenAI Prompt Cache 命中率的诊断工具。
_Avoid_：缓存统计

## Technical Concepts（技术概念）

**Provider**（AI 服务提供者）：
封装 OpenAI 兼容 API 的调用层，支持自定义 Base URL、API Key、Model，内置缓存感知和重试逻辑。
_Avoid_：API client、service

**Agent Dispatcher**（智能调度器）：
可选的细粒度 AI 调用调度层，按请求类型路由到不同策略（逐步生成、批处理等）。
_Avoid_：AI 路由器、dispatch

**gradedAt**（批改时间戳）：
Exercise 对象上的时间戳字段，记录该题被 AI 批改的时刻（`Date.now()`）。用于当日/本周答题统计的时间过滤。
_Avoid_：批改时间、评分时间

**Exam Engine**（试卷引擎）：
位于 `server/engine/exam-engine.js`，负责试卷的生成、自动评分、随机练习生成等。
_Avoid_：考试引擎、test engine

**Interactive Teacher**（互动教学引擎）：
位于 `server/engine/interactive-teacher.js`，实现 5 种基础互动教学模式（详见上方 Interactive Teaching 章节），包含错误检测、会话管理和知识点分解。
_Avoid_：教学引擎、对话系统
