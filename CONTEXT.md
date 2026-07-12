# Study Assistant

AI 驱动的交互式学习助手，围绕"学习计划 -> 知识点 -> 学习内容 -> 测评反馈"的知识学习闭环。

## Language

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

### 交互教学

**Interactive Teaching**（交互教学）：
AI 与学生进行对话式教学的模式总称，包含以下子模式：

**Stepwise**（逐步引导）：
AI 按步骤逐段讲解，每个步骤后暂停等待学生确认。
_Avoid_：分步、逐步

**Realtime**（实时交互）：
AI 实时响应学生的问题和输入，自由对话式教学。
_Avoid_：实时对话、chat

**Scaffold**（支架式教学）：
AI 提供结构化的学习支架（如填空、提示），逐步撤除支持。
_Avoid_：搭脚手架、引导式

**Feynman**（费曼学习法）：
学生向 AI 讲解知识点，AI 分析薄弱点和误解，形成学习闭环。
_Avoid_：费曼技巧、retelling

**Challenge**（挑战模式）：
AI 在讲解中故意嵌入错误，训练学生的批判性思维。
_Avoid_：找茬、错误检测

### 评估与反馈

**Review**（复习）：
AI 基于历史学习记录生成复习内容和练习。
_Avoid_：回顾、温习

**Quiz**（快速测验）：
短平快的知识点测验，即时反馈。
_Avoid_：测试、小测

**Exam**（试卷）：
正式的考核试卷，包含多道题目，支持生成、作答、自动评分。
_Avoid_：考试、测验、test

**Exercise**（练习）：
学习内容中嵌入的练习题，学生提交后 AI 自动批改。
_Avoid_：习题、作业

**Weak Point**（弱项）：
AI 分析学生的学习记录后识别的薄弱知识点。
_Avoid_：薄弱点、不足

### 知识与分析

**Fact Check**（事实核查）：
AI 对已生成的 Detail 内容进行准确性验证，标记不确定或可能错误的内容。
_Avoid_：内容校验、验证

**Knowledge Graph**（知识图谱）：
知识点之间的前置依赖、扩展关系等构成的图结构。
_Avoid_：关系图、依赖图

**Core Topic**（核心知识点）：
Plan 中最重要的、起枢纽作用的知识点，由 AI 分析识别。
_Avoid_：重点、关键节点

**Decompose**（知识点拆分）：
将一个 Topic 拆分为更细粒度的子知识点。
_Avoid_：分解、拆分

### 数据与导出

**Profile**（用户画像）：
用户的学习偏好、知识背景、学习目标等个性化配置。
_Avoid_：用户设置、偏好

**Export**（导出）：
将学习内容导出为外部格式（Anki CSV、OPML、Notion CSV、JSON、学习笔记）。
_Avoid_：下载、输出

**Trash**（回收站）：
被删除的 Plan 暂存区，支持 30 天内恢复。
_Avoid_：已删除、垃圾桶

### 技术概念（项目内部）

**Provider**（AI 服务提供者）：
封装 OpenAI 兼容 API 的调用层，支持自定义 Base URL、API Key、Model，内置缓存感知和重试逻辑。
_Avoid_：API client、service

**Cache Monitor**（缓存监控）：
跟踪 OpenAI Prompt Cache 命中率的诊断工具。
_Avoid_：缓存统计

**Atomic Write**（原子写入）：
通过临时文件 + rename 保证文件写入的原子性，防止进程崩溃时数据损坏。
_Avoid_：安全写入、事务写入

**Flag**（标记文件）：
标记某个 Topic 的 Detail 是否需要重新生成（如 AI 配置变更后）。
_Avoid_：标记、脏标记、dirty flag

**Data Flywheel**（数据飞轮）：
自适应学习闭环：用户行为 → 薄弱点分析 → 干预建议 → 教学策略调整 → 新的用户行为。
_Avoid_：反馈循环、自适应引擎

**Adaptive Engine**（自适应引擎）：
根据用户行为数据动态调整教学策略的模块，包含错误状态机（ErrorStateMachine）和干预推荐器（InterventionRecommender）。
_Avoid_：自适应系统、推荐引擎

**Agent Dispatcher**（智能调度器）：
可选的细粒度 AI 调用调度层，按请求类型路由到不同策略（逐步生成、批处理等）。
_Avoid_：AI 路由器、dispatch
