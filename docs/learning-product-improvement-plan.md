# Study Assistant 学习产品改进机会与实施计划

> 状态：规划稿。本文只记录产品与工程决策，**不包含应用代码改动**。
>
> 评估依据：用户提供的开源项目能力概览，以及当前仓库的实现。项目已经具备 Plan → Topic → Detail → Exercise/Quiz/Exam → Weak Point → Adaptive Engine 的学习闭环、Knowledge Graph、Interactive Teaching、Profile、Fact Check 和多格式 Export。因此本文不重复建设这些能力，而是优先补齐它们之间缺失的可验证数据链路。

## 1. 结论

最值得吸收的不是继续增加独立的 AI 模式，而是让每一次讲解、作答和复习都有可追溯的依据，并能驱动下一次学习。建议按以下顺序推进：

1. **Source Library 与 Citation Grounding**：把用户学习材料变成 Plan 内的可管理来源；Detail、追问和练习的回答必须能回到具体来源片段。
2. **Mastery Evidence 与 Review Schedule**：用可解释的作答证据计算 Topic 掌握度，并以间隔重复形成每天可执行的 Review 队列。
3. **Mistake Record 与 Repair Loop**：把“答错”从一次性统计升级为可验证的错误修复任务，直到后续检验通过才关闭。
4. **Knowledge Graph 学习导航**：将掌握度、复习到期和前置依赖叠加到已有 Knowledge Graph，给出“下一步学什么”的理由，而不是只展示关系。
5. **Source-linked Notes 与教学策略扩展**：允许学生保存带来源的个人笔记；在上述证据充分后，再扩展 Socratic、Debate、Analogy 等已有 ROADMAP 中的教学策略。

这条顺序的关键依赖是：没有 Source 和 Citation，就无法可靠地使用用户材料；没有 Mastery Evidence，就不应宣称已经“因材施教”；没有 Review Schedule 和 Repair Loop，Profile 与 Weak Point 只会停留在报告页，不能形成日常行动。

## 2. 外部项目能力的取舍

| 参考方向 | 当前项目情况 | 吸收方式 | 优先级 |
| --- | --- | --- | --- |
| KnowledgeFlow-StudyAgent 的知识点闭环 | Plan、Topic、讲解、练习、弱项已具备 | 不复制功能；用掌握度与 Review Schedule 提高闭环的可执行性 | P0 |
| AITeachMe / Clarify / bongo 的材料驱动学习 | 仅有 TXT/MD/CSV 导入为 Plan，尚无材料库和来源引用 | 建立 Plan 级 Source Library，支持材料问答、来源约束的讲解与练习 | P0 |
| nano-NotebookLM 的引用、错题自演化、可编辑图谱 | 有 Fact Check、Error State Machine、自动关系图 | 先做真实 Citation 和 Mistake Record；图谱只允许用户校正关系/备注，不把 AI 对话自动固化为永久事实 | P0/P1 |
| Comet / NodeNest 的记忆图谱 | 已有 Topic 关系图，但不应把对话推断当作知识事实 | 后期仅增加用户显式保存、带来源的 Note；默认不自动记忆 | P2 |
| Smart Learn / 费曼学习法 | Feynman 已是正式 Interactive Teaching 模式，且有分析 | 将费曼结论写入 Mastery Evidence 和 Repair Loop，而非新建重复模式 | P1 |
| tutor-mcp 的认知科学教学约束 | 已有多种 Interactive Teaching prompt | 将检索练习、间隔重复、反馈时机实现为产品策略；暂不把 MCP Server 作为核心产品需求 | P2 |
| Nova 的多智能体虚拟课堂 | 当前单用户、本地 JSON 存储，无身份与协作模型 | 暂不采用。角色编排提高成本和复杂度，不能替代可验证的学习证据 | 不做 |
| ECNUClaw 的五维认知/行为/情感画像 | 当前有 Profile 和 Behavior Profile | 只采集学习过程产生的最小必要行为数据；不推断情绪、人格或敏感特征 | 不做 |
| QuestionSeeker / StudyBuddy 的错题提升与作业拍照 | 有 Exercise、Exam、Weak Point、TTS，暂无统一错题生命周期或材料 OCR | 优先建设 Mistake Record；图片/PDF OCR 放到 Source Library 的后续增量 | P1/P3 |
| LAMB 的教育者平台、Obsidian 插件、多人协作 | 当前无账户、权限、数据库和团队边界 | 暂不采用。先保持本地单学习者产品的深度与可靠性 | 不做 |

## 3. 目标数据闭环

```text
Source -> Citation-grounded Detail / Q&A / Exercise
                     |
                     v
Attempt -> Mastery Evidence -> Review Schedule -> Retrieval Practice
   |                 |                                  |
   v                 +--------------> Profile           v
Mistake Record -> Repair Task -> Verification Attempt -> resolved
```

### 新增术语

- **Source（学习来源）**：用户附加到某个 Plan 的原始学习材料及其元数据。原文和提取文本只在本地文件系统保存。
- **Citation（引用）**：AI 输出中指向某个 Source 的可定位片段，至少包含 `sourceId`、`chunkId`、显示标签和定位信息（页码或字符范围）。
- **Mastery Evidence（掌握证据）**：一次可审计的学习表现，例如 Exercise、Quiz、Exam、Feynman 检验或主动复习的结果；不能由“打开过页面”直接推断。
- **Review Schedule（复习安排）**：按 Topic 维护的、由掌握证据更新的下次 Review 时间和间隔。
- **Mistake Record（错题记录）**：一个可去重的错误概念记录，包含错误类型、证据、修复动作、验证结果和状态。

## 4. 详细实施计划

### Phase 0：数据契约、隐私边界与基线

**目的**：先建立能演进的本地 JSON 模式，再引入任何新字段，避免后续数据损坏或无迁移升级。

1. 落实 `ROADMAP.md` 中的数据版本迁移：为 Plan 数据和跨 Plan Profile 数据定义 `dataVersion`，迁移前备份，迁移失败回滚，并继续使用 `writeAtomic`。
2. 为上述五个新术语写 JSON schema 说明、字段所有权和状态转换表；明确哪些字段来自用户、确定性逻辑和 AI，禁止相互覆盖。
3. 定义最小必要数据策略：不采集情绪、摄像头画面或与学习无关的对话；用户能删除 Source、Note、Mistake Record 及其派生数据。
4. 记录基线指标：每日完成的 Review 数、7 日后检索正确率、重复错误率、AI 输出的 Citation 覆盖率、用户纠正错误分类的比例。

**涉及位置**：`server/engine/store/storage.js`、`server/engine/store/crud.js`、`server/engine/learn-store.js`、`server/migrations/`（新增）、`server/__tests__/storage-logic.test.js`。

**验收门槛**：旧数据可迁移、失败后可恢复；所有新增结构均有纯逻辑测试；测试数据清理脚本能清除新增文件。

### Phase 1：Plan 级 Source Library（P0）

**目的**：让学习材料成为明确、可删除、可引用的 Plan 资源，而不是把全文混进一次性的 prompt。

1. 新建深模块 `server/engine/source-library.js`，统一负责 Source 元数据、文本提取、分块、哈希去重、删除级联和查询；路由不得直接读写来源文件。
2. 初始格式限定为 TXT、MD、CSV 和可复制文本；PDF、DOCX、图片 OCR 放到后续迭代，先确定文本质量、大小上限、编码和恶意内容处理规则。新增解析依赖时须按仓库规则先确认，因为会改动共享依赖声明。
3. 每个 Source 保存不可变原文件、提取文本和分块索引；每个 chunk 必须有稳定 ID、定位信息、文本哈希和所属 `planId`。不要一开始引入向量数据库：先用关键词/标题检索和显式选择来源验证体验，再评估本地向量索引的收益。
4. 新增 Source API：列出、添加、读取元数据、删除、预览 chunk，以及为一次生成请求指定 `sourceIds`。所有 `planId`、文件类型、长度和数组参数必须校验。
5. 在 `PlanView.jsx` 增加“学习来源”入口，在 `TopicDetail.jsx` 的生成/追问区域提供来源选择和可读预览；通过 `client/src/api.js` 统一调用。上传失败、超限、解析失败和空文本都要有明确状态。

**涉及位置**：新增 `server/engine/source-library.js`、`server/routes/sources.js`；`server/index.js` 挂载；`server/engine/learn-store.js`、`server/routes/learn.js`、`client/src/api.js`、`client/src/components/PlanView.jsx`、`client/src/components/TopicDetail.jsx`。

**测试**：新增 `server/__tests__/source-library.test.js` 和路由集成测试，覆盖路径隔离、重复上传、原子删除、跨 Plan 越权访问、文本分块边界；新增客户端测试覆盖来源选择、加载和错误状态。

**验收门槛**：用户可以在同一 Plan 内添加、查看、删除文本来源；不同 Plan 不能读取对方来源；一次生成可以明确知道使用了哪些 Source。

### Phase 2：Citation-grounded Detail、追问与练习（P0）

**目的**：将“看似正确”的 AI 内容改为“可核对来源”的内容，优先提高用户材料场景下的可信度。

1. 在 `learn-prompts.js` 定义稳定的引用输出契约：事实性陈述若基于 Source，必须带 Citation；无法由 Source 支持时应标注为通用解释或明确说“不在材料中”。禁止模型编造 `sourceId` 或页码。
2. 在 `learn-engine.js`、`learning-analyzer.js` 和 `interactive-teacher.js` 通过 Source Library 取回有限、相关的 chunk；将 chunk ID 和定位作为受控上下文传入，而非拼接整份文档。
3. 让生成结果先经过 Citation 校验器：只接受当前请求允许的 Source/chunk；非法引用降级为未引用而不是保存为真。Detail、追问、Review 与 Exercise 都保存结构化 Citation 元数据。
4. 在 `TopicDetailShared.jsx` 或专用 Citation 组件中把引用显示为可点击脚注，打开相应 Source 的定位片段；无 Source 的既有 Detail 保持兼容，不伪造来源。
5. 扩展 Fact Check：当存在用户 Source 时，优先报告“被来源支持 / 与来源矛盾 / 来源未覆盖”，与通用模型事实核查分开展示，避免两者混淆。

**涉及位置**：`server/engine/learn-prompts.js`、`server/engine/learn-engine.js`、`server/engine/learning-analyzer.js`、`server/engine/interactive-teacher.js`、`server/engine/fact-checker.js`、`client/src/components/TopicDetailShared.jsx`、`client/src/components/TopicDetail.jsx`。

**测试**：prompt/解析单测、Citation allowlist 校验、Source 删除后的引用降级、无 Source 的回归、含 Citation 的 Markdown 渲染和脚注定位测试。

**验收门槛**：选择来源生成的内容可以逐条回到合法 Source chunk；模型给出不存在的引用不会持久化；来源覆盖范围与通用 AI 判断在界面上可区分。

### Phase 3：Mastery Evidence 与 Review Schedule（P0）

**目的**：将已有 Exercise、Quiz、Exam、Feynman 和 Weak Point 的碎片信号汇成可解释的 Topic 掌握度，并给出今天应该完成的 Review。

1. 新建 `server/engine/mastery-scheduler.js`。输入只能是结构化 Mastery Evidence，输出 Topic `mastery` 摘要和 `reviewSchedule`；把算法版本写入状态，便于以后调整而不误改历史解释。
2. 首版采用可解释的 SM-2-inspired 调度，而不是黑盒分数：正确率、间隔、重复次数、最近一次表现、错误严重度和遗忘风险各有明确权重；用户可在复习后给出“困难/适中/简单”评级校正节奏。
3. Exercise、Quiz、Exam 的提交路径生成 Evidence；Feynman Insights 仅在有具体 gap 或通过结论时生成低/中置信度 Evidence。`done` 仍代表 Topic 学习完成，不等价于“已掌握”。
4. 新增 Review Queue API：按 `dueAt`、前置依赖、风险和预计时长排序，返回今天到期、即将到期和推荐加练的 Topic。第一版只在应用内展示，不承诺推送通知或后台任务。
5. 在 `PlanView.jsx` 显示紧凑的今日 Review 队列；在 `TopicDetail.jsx` 显示掌握证据和下一次 Review 原因，用户可手动提前复习或暂停一个 Topic。
6. 将计算后的可靠汇总传给已有 `AdaptivePromptInjector` 和 Profile，而不是让 prompt 从全部历史中自行猜测掌握度。

**涉及位置**：新增 `server/engine/mastery-scheduler.js`；`server/engine/learning-analyzer.js`、`server/engine/exam-engine.js`、`server/engine/interactive-teacher.js`、`server/engine/adaptive-engine.js`、`server/engine/user-profile.js`、`server/routes/learn.js`、`client/src/api.js`、`client/src/components/PlanView.jsx`、`client/src/components/TopicDetail.jsx`、`client/src/pages/UserProfile.jsx`。

**测试**：新增 `server/__tests__/mastery-scheduler.test.js`，固定时钟验证首次复习、连续正确、失败回退、手动评级、算法版本兼容和边界日期；补充 Exercise/Quiz/Exam/Feynman 集成测试与 Review Queue 客户端测试。

**验收门槛**：同样的证据总是得到同样的计划；任何掌握度都有可查看的证据和计算原因；答错后复习会提前，连续成功后间隔会合理拉长。

### Phase 4：Mistake Record 与 Repair Loop（P1）

**目的**：把 Error State Machine 的“累计错误次数”升级为可以处理、复查和关闭的错误闭环。

1. 新建 `server/engine/mistake-ledger.js`，以规范化概念标识、Topic、错误类型和时间窗口合并重复错误。`ErrorStateMachine` 成为该账本的一个输入和摘要视图，而不是唯一持久状态。
2. 每条 Mistake Record 记录：原始 Evidence、概念标签、错误类型、置信度、用户可见解释、关联 Citation/Detail、状态（`open`、`repairing`、`verified`、`dismissed`）及后续验证 Evidence。
3. 对自动分类采用“建议而非事实”：低置信度必须让用户确认或编辑；禁止把模型猜测直接写为永久 Weak Point。保留 `dismissed` 原因以改进分类规则。
4. 为 `open` 记录生成短 Repair Task：先解释错误原因，再给一个不同表述的检索题或应用题；只有指定难度/延迟后的正确 Evidence 才标记 `verified`。不要因一次重新阅读自动关闭。
5. 在 `TopicDetail.jsx` 提供错题卡片和修复入口，在 `PlanView.jsx` 汇总待修复数；与 Review Queue 合并排序，避免给用户两份互相竞争的待办列表。

**涉及位置**：新增 `server/engine/mistake-ledger.js`；`server/engine/adaptive-engine.js`、`server/engine/learning-analyzer.js`、`server/engine/exam-engine.js`、`server/routes/learn.js`、`server/routes/assessment.js`、`client/src/api.js`、`client/src/components/TopicDetail.jsx`、`client/src/components/PlanView.jsx`。

**测试**：新增 `server/__tests__/mistake-ledger.test.js`，覆盖归并、错误来源、用户否决、错误修复、延迟验证和重复错误率；路由与客户端测试覆盖状态变更及空状态。

**验收门槛**：用户能看见“为什么错、如何修、何时验证”；一次答对不误关长期错误；同类错误不会在每个页面生成重复卡片。

### Phase 5：Knowledge Graph 学习导航与显式 Note（P1/P2）

**目的**：复用已有 Knowledge Graph，把它从关系浏览器提升为学习路径解释器，同时防止对话幻觉污染图谱。

1. 保持当前 Detail 关系提取与 `?infer=true` 语义不变，在节点上叠加只读状态：掌握度区间、Review 是否到期、开放 Mistake Record 数、前置 Topic 是否未满足。
2. 新增“为什么推荐此 Topic”的解释：由前置关系、到期时间、掌握证据和核心 Topic 分析共同生成确定性理由。默认建议，不强制锁住后续 Topic。
3. 提供人工校正关系的轻量入口：接受/拒绝推断边、添加备注、标记关系不适用；保留 AI 推断来源和用户操作历史。
4. 增加用户显式创建的 Source-linked Note。Note 可关联 Topic、Source chunk 和用户自己的结论；只有用户点击保存，才会进入图谱的注释层。AI 对话摘要不能自动成为图节点。
5. 等证据层稳定后，实施 `ROADMAP.md` 已列出的 Socratic、Debate、Analogy：它们读取学习导航和掌握度作为教学策略输入，并以 Evidence/Repair Task 收尾，而不是仅增加三个 prompt 按钮。

**涉及位置**：`server/engine/learn-store.js`、`server/routes/learn.js`、`server/engine/adaptive-engine.js`、`server/engine/interactive-teacher.js`、`client/src/components/KnowledgeGraphModal.jsx`、`client/src/components/PlanView.jsx`、`client/src/components/TopicDetail.jsx`。

**测试**：图谱状态聚合、前置关系方向、推断边与人工校正共存、Note 删除级联、模式输入与 Evidence 写入测试。

**验收门槛**：图谱推荐可以解释且不阻断学习；用户能纠正关系；只有显式保存的 Note 才出现在注释层。

### Phase 6：评估、迁移与逐步发布

1. 每个 Phase 在真实数据迁移前用备份副本和 `check:data` 验证，异常时回滚到上一数据版本；不修改用户原始 Source。
2. 使用有限 Plan 试运行，并提供关闭新调度/来源约束的回退开关，直至数据质量稳定。
3. 对比 Phase 0 基线，重点观察：Citation 覆盖率与非法引用数、到期 Review 完成率、7/14 日检索正确率、重复 Mistake Record 比例、用户对自动分类的否决率、每次 AI 调用的上下文长度与成本。
4. 只有当证据显示学习效果或可信度提升，才扩展 PDF/OCR、向量检索、通知、学科专用工作流或外部 MCP 集成。

## 5. 实施顺序、依赖与范围控制

| 阶段 | 前置条件 | 交付后才能开始 | 不应提前做的事 |
| --- | --- | --- | --- |
| Phase 0 | 无 | 数据迁移契约 | 改动历史数据字段 |
| Phase 1 | Phase 0 | Citation Grounding | 向量数据库、OCR、全格式解析 |
| Phase 2 | Phase 1 | Source-aware Fact Check | 将无来源内容显示为“已证实” |
| Phase 3 | Phase 0 | Mistake Record、图谱学习导航 | 推送通知、黑盒推荐 |
| Phase 4 | Phase 3 | 统一待办队列 | AI 自动确诊长期 Weak Point |
| Phase 5 | Phase 2、3、4 | 新互动策略 | 自动把对话写入永久图谱 |
| Phase 6 | 每个独立阶段完成 | 下一轮能力扩展 | 一次性迁移所有用户数据 |

## 6. 当前不做的项目

1. **多人协作、教师后台、LMS 集成和虚拟课堂**：需要账户、权限、服务端多租户与数据库，超出当前本地 JSON 单用户架构。
2. **五维情感/人格画像**：既缺少可靠信号，也会扩大隐私风险；现有 Profile 应以可解释的学习行为为限。
3. **无来源的“自动记忆”或自动扩展个人知识图谱**：会将模型幻觉和临时对话永久化；必须由用户显式保存且尽量附 Citation。
4. **为模式而模式的多智能体或新 prompt**：已有 Interactive Teaching 足够丰富。新模式须接入 Mastery Evidence、Review Schedule 或 Repair Loop，才能进入实现队列。
5. **首次迭代就引入向量数据库、OCR、复杂文档解析或后台推送**：先以可验证的文本来源和应用内 Review 证明核心循环的价值。

## 7. 建议的首个可交付版本

首个版本只包含 Phase 0、Phase 1 的 TXT/MD/CSV/粘贴文本，以及 Phase 2 的 Detail/追问 Citation。它的用户价值清晰、架构风险可控：学习者能把一份自己的材料加入 Plan，生成讲解后点击每条引用回到原文。通过后，再进入以确定性掌握证据为中心的 Review Schedule；不要并行堆叠所有高级能力。
