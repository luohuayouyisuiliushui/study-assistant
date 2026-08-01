# Study Assistant v5.0.0

AI 学习助手 —— 告诉 AI 你想学什么，它帮你拆解知识点、生成讲解、出题考试、追踪薄弱环节，还越用越懂你。

当前工作区版本：`v5.0.0`。下载源码归档或查看已发布版本，请前往 [GitHub Releases](https://github.com/luohuayouyisuiliushui/study-assistant/releases/latest)。

## 它能做什么

你创建一个学习计划（比如"Python 入门"），添加几个知识点（比如"变量与类型"、"条件判断"、"循环"），然后：

### AI 生成讲解
1. AI 为每个知识点生成**详细讲解**，包含概念解释、Mermaid 图表、代码示例和练习题
2. 支持 **SSE 流式输出**，实时看到生成过程
3. 讲解内容支持 **Markdown 渲染**、**思维导图**和 **Mermaid 图表**
4. 知识点配图和 Mermaid 图可点击进入**全屏查看**，支持缩放、拖动、旋转、翻转、编辑图表源码和保存

### 互动学习
5. **5 种基础互动教学模式 + 2 种复合模式**：费曼教学、挑战找错、分段引导、实时互动、脚手架引导、分段挑战、实时挑战
6. 随时**追问**任何不理解的地方，AI 深入解释
7. **练习与测验**：随堂练习 AI 自动批改，支持智能组卷考试

### 知识图谱
8. **自动提取知识点关系**：从讲解文本中识别前置依赖、扩展、对比等关系
9. **大屏知识图谱**：自动把大型图谱聚合为主题骨架，也可切换全部知识点；支持横向/纵向布局、节点高亮、缩放、平移、关系筛选和多格式导出

### 学习分析与画像
10. **跨计划学习画像**：基于真实提问、答题和学习时长证据识别强项、弱项、提问风格与学习节奏，并展示画像可信度和样本量
11. **当天答题情况显示板**：按天/周追踪练习、试卷、快问的正确率和数量
12. **费曼教学分析**：记录教学质量、精彩讲解摘录、学生遗留问题

### 数据导出
13. 导出为 **Anki CSV**、**Markdown**、**OPML**、**JSON**、**Notion CSV** 等格式；思维导图还可单独导出 **SVG** 和 **PNG**

### 个性化自适应
14. **越用越懂你**：每次做练习、提问、学习时长都被记录，AI 自动调整难度和讲解风格
15. **自适应引擎**：根据薄弱点自动推荐复习内容，事实核查你的理解

### 稳定交互
16. 资源推荐兼容标准 JSON、Markdown JSON 围栏和附带说明文字的模型响应；异常时自动精简重试，并提供明确的超时和重试状态
17. Mermaid 图表只在首次进入视口时自动渲染，内容变化后由用户点击重绘按钮，避免反复渲染导致页面刷新
18. 知识点顶部悬浮导航默认隐藏，鼠标靠近页面顶部时显示，离开后自动收起；触屏设备始终保留可操作入口

---

## 快速开始

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5270`，在设置里填入 API Key（支持 OpenAI / DeepSeek / SiliconFlow / 任意兼容 OpenAI 的 API）即可使用。

### 与 study_trace 集成

`GET /api/study-trace/plans` 和 `GET /api/study-trace/plans/:id` 只读输出 `study-trace-theory-v1` 理论 DTO。study-assistant 负责讲解、题目、理论计时和薄弱点，但不决定实践完成、检查点顺序或阶段推进；这些事实由 `study_trace` 确认。带 `?practice=1` 的主题页会保留讲解与题目，并把导出、资源和互动工具收进“更多操作”。

服务端默认只监听 `127.0.0.1:3001`。如确需允许远程访问，显式设置
`STUDY_ASSISTANT_HOST`，并同时设置 `STUDY_ASSISTANT_API_TOKEN`；远程 API 请求必须携带
`x-study-assistant-token`。不要把 CORS 当作访问控制。

> 也可通过 `npm run start` 启动**生产模式**（先 `npm run build` 构建前端，后端在端口 3001 提供完整服务）。

### Windows 快速开始

要求 Windows 10/11 和 Node.js 20.19+（或 22.12+）。在项目根目录依次双击：

1. `windows-doctor.cmd`：检查 Node.js、npm、端口和依赖状态
2. `windows-setup.cmd`：安装根目录、服务端和客户端依赖
3. `windows-dev.cmd`：启动开发环境，然后访问 `http://localhost:5270`

清理测试数据：双击 `windows-clean-testdata.cmd`，一键清除测试计划、备份和缓存文件。

前两个检查/安装窗口执行完会停留，阅读结果后按任意键关闭。

生产模式使用 `windows-start.cmd`，它会先构建前端，再由服务端在 `http://localhost:3001` 提供完整应用。启动窗口中按 `Ctrl+C` 可正常停止；也可在另一个终端运行 `windows-stop.cmd`，脚本会校验已记录的 PID 和启动时间，再用 `taskkill /T /F` 终止完整的 npm/Node.js 进程树，避免残留后台进程。Windows 无法从另一个控制台可靠转发 `Ctrl+C`，如需优雅退出请在原启动窗口操作。

这些 `.cmd` 入口会为当前进程使用 PowerShell `ExecutionPolicy Bypass`，不会修改系统或用户的永久执行策略。也可以在 PowerShell 中直接运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\doctor.ps1
.\scripts\windows\setup.ps1
.\scripts\windows\dev.ps1
```

常见问题：

- 提示端口 3001 或 5270 被占用：先运行 `windows-stop.cmd`；若不是本项目进程，可用 `Get-NetTCPConnection -State Listen -LocalPort 3001,5270` 找到 PID。
- 缺少 API Key：可直接在应用设置中填写；也可将 `server/.env.example` 复制为 `server/.env` 后填写，切勿提交真实 Key。
- `npm.ps1` 被执行策略阻止：Windows 脚本固定调用 `npm.cmd`，请使用上述 `.cmd` 或 `.ps1` 入口。
- 数据位置：学习数据保存在 `server/data/`，缓存位于 `server/cache/`；升级或重装前请备份 `server/data/`。

---

## 使用方法

### 1. 创建学习计划

点击"新建计划"，输入计划名称（如"JavaScript 基础"），然后添加知识点列表。支持手动输入，也支持从 TXT/MD/CSV 文件批量导入。

### 2. 生成讲解

点击知识点旁的"生成"按钮，AI 会实时流式输出讲解内容，包含：
- 核心概念解释
- Mermaid 图表
- 代码示例
- 例题与练习题
- 与相关知识点的联系（自动用于知识图谱）

生成后可直接点击配图或 Mermaid 图表进入全屏查看。全屏工具栏支持缩放、旋转、翻转、拖动和下载；Mermaid 图还可编辑源码并重新生成。图表源码发生变化时不会自动反复渲染，点击图表右上角的重绘图标即可更新。

### 3. 互动学习

选择一种互动模式深入学习：

| 模式 | 说明 |
|------|------|
| **费曼学习** | 你向 AI 讲解，AI 追问你不懂的地方 |
| **挑战模式** | AI 故意讲错，看你能不能发现 |
| **分段讲解** | AI 按步骤逐段讲解，每段后暂停等你确认 |
| **实时互动** | AI 实时响应你的反馈，灵活调整节奏 |
| **脚手架引导** | 将复杂概念拆成递进子问题，逐个掌握 |

### 4. 练习与测验

完成学习后，可以：
- 做随堂练习（AI 自动批改）
- AI 智能组卷考试（选择题 + 问答题 + 编程题）
- 快速测验（quick quiz，按知识点随机出题）
- 查看薄弱点分析

### 5. 查看知识图谱

- 大型计划默认聚合为可读的主题骨架，可随时切换到全部知识点
- 关系类型：前置依赖、扩展、示例、对比、构建于、引用
- 支持推断边、分组关系筛选、横向/纵向布局和节点关联高亮
- 近全屏画布支持拖拽平移、滚轮/按钮缩放和一键适应视图
- 可导出 JSON、SVG、PNG 或 Markdown

### 6. 学习画像与今日统计

- **学习画像**：AI 分析与行为证据结合，展示学习风格、强项、弱项、提问样本、答题样本、活跃日和个性化建议
- **时间与提问风格**：学习时长统一显示为小时/分钟；提问风格只在真实问题样本达到阈值后展示，不再输出模型诊断占位文本
- **当日答题板**：实时追踪今天做了多少题、正确率多少，按练习/试卷/快问分类展示
- **上周回顾**：统计本周累计答题数和正确率

### 7. 数据导出

计划数据支持导出为 **Anki CSV**、**Markdown**、**OPML**、**JSON**、**Notion CSV**。思维导图窗口另提供 **Markdown、SVG、PNG、JSON、OPML** 五种真实格式，并支持一键适应视图。

### 8. 推荐学习资源

在知识点的更多操作菜单中选择“推荐资源”，系统会生成书籍、视频、官方文档、文章、课程和互动练习等多渠道建议。服务端等待上限为 60 秒，客户端等待上限为 65 秒；超时或生成失败后按钮会恢复为可重试状态，不会持续卡在加载中。

---

## 技术细节（开发者）

### 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + Vite 8 + Tailwind CSS 4 + shadcn/ui（copy-paste） |
| 后端 | Node.js + Express 5 + OpenAI SDK（兼容 DeepSeek / SiliconFlow 等） |
| AI | OpenAI 兼容 API，SSE 流式输出 |
| 存储 | JSON 文件系统，原子写入 + 双层备份（无需数据库） |
| 可视化 | Mermaid（流程图）、Markmap（思维导图）、Recharts（统计图）、原生 SVG（知识图谱） |

### 项目结构

```
study-assistant/
├── client/                      # React 前端
│   ├── src/
│   │   ├── api.js               # API 客户端封装
│   │   ├── hooks/
│   │   │   └── useTopicLearningWorkspace.js # 六组学习流程状态与 API 编排
│   │   ├── components/          # 业务组件
│   │   │   ├── ui/              # shadcn/ui 手写组件
│   │   │   ├── PlanView.jsx     # 计划详情
│   │   │   ├── TopicDetail.jsx  # 知识点详情
│   │   │   ├── MediaViewer.jsx   # 图片/图表全屏查看、编辑与保存
│   │   │   ├── MermaidDiagram.jsx # Mermaid 手动重绘控制
│   │   │   ├── KnowledgeGraphModal.jsx  # 聚合/完整知识图谱与导出
│   │   │   ├── MindMapModal.jsx         # 思维导图查看与多格式导出
│   │   │   ├── ExercisePanel.jsx       # 练习面板
│   │   │   ├── ExamPaperModal.jsx      # 考试面板
│   │   │   ├── InteractivePanel.jsx    # 互动教学
│   │   │   ├── QAPanel.jsx      # 问答面板
│   │   │   └── ...
│   │   └── pages/
│   │       └── UserProfile.jsx  # 学习画像页
│   └── dist/                    # 生产构建产物
├── server/                      # Express 后端
│   ├── engine/
│   │   ├── ai-runtime.js        # 请求配置、Key 池、Provider/Dispatcher 与执行边界
│   │   ├── learn-engine.js      # 核心引擎（讲解/追问）
│   │   ├── learn-store.js       # barrel 导出
│   │   ├── learning-analyzer.js # 学习分析（练习批改/薄弱点）
│   │   ├── exam-engine.js       # 试卷引擎（生成/评分/练习）
│   │   ├── interactive-teacher.js # 互动教学（5 种基础模式 + 2 种复合）
│   │   ├── adaptive-engine.js   # 自适应推荐引擎
│   │   ├── user-profile.js      # 跨计划学习画像
│   │   ├── store/
│   │   │   ├── storage.js       # 持久化基础设施
│   │   │   ├── crud-content.js  # 串行 Plan/Topic 写事务
│   │   │   ├── crud-exercises.js # 练习与试卷事务
│   │   │   ├── crud-plans.js    # Plan 生命周期
│   │   │   └── crud-trash.js    # 回收站
│   │   └── ...
│   ├── routes/
│   │   ├── learn.js             # 计划/知识点 CRUD + 分析
│   │   ├── content.js           # 内容教学（生成/交互/TTS）
│   │   ├── assessment.js        # 评估（考试/事实核查/自适应）
│   │   ├── export.js            # 导出（Anki/OPML/Notion/MD）
│   │   ├── user-profile.js      # 学习画像 API
│   │   ├── settings.js          # 服务端持久化设置（.env.local）
│   │   ├── study-trace.js       # 跨项目只读理论事实 DTO
│   │   ├── flywheel.js          # 数据飞轮
│   │   └── middleware.js        # AI invocation 适配与 Plan ID 校验
│   ├── data/                    # 学习数据（JSON 文件）
│   ├── cache/                   # AI 缓存
│   └── __tests__/               # 后端测试
│       ├── crud-logic.test.js
│       ├── user-profile.test.js
│       ├── storage-logic.test.js
│       ├── settings.test.js      # Settings API（.env.local 读写）
│       └── ...
├── scripts/windows/             # Windows 辅助脚本
│   ├── doctor.ps1 / doctor.cmd
│   ├── setup.ps1 / setup.cmd
│   ├── dev.ps1 / dev.cmd
│   └── start.ps1 / start.cmd / stop.cmd
├── docs/                        # 专题说明与审计记录
├── MODULES.md                   # 模块清单与当前验证基线
├── FINAL_REPORT.md              # 终检与发布证据
└── package.json                 # monorepo 根（workspaces）
```

### API 端点

80+ 端点，涵盖：

| 路由 | 功能 |
|------|------|
| `/api/learn/plans` | 计划管理 CRUD |
| `/api/learn/plans/:id/topics` | 知识点管理、生成讲解 |
| `/api/learn/plans/:id/topics/:tid/qa` | 问答（追问） |
| `/api/learn/plans/:id/topics/:tid/interactive` | 互动教学（5 种基础模式 + 2 种复合） |
| `/api/learn/plans/:id/topics/:tid/grade` | 练习批改 |
| `/api/learn/plans/:id/exam` | 试卷管理（生成/提交/评分） |
| `/api/learn/plans/:id/quick-quiz` | 快速测验 |
| `/api/learn/plans/:id/weakpoints` | 薄弱点分析 |
| `/api/learn/plans/:id/knowledge-graph` | 知识图谱 |
| `/api/learn/plans/:id/export` | 数据导出 |
| `/api/learn/plans/:id/adaptive/review` | 自适应复习推荐 |
| `/api/learn/fact-check` | 事实核查 |
| `/api/user-profile/summary` | 学习画像摘要 |
| `/api/user-profile/analyze` | AI 画像生成 |
| `/api/user-profile` | 画像数据 |
| `/api/settings/env-key` | 服务端 Key 持久化（读写 .env.local） |
| `/api/study-trace/plans` | study_trace 专用只读理论事实（不暴露原始 Plan JSON） |

### 运行测试

```bash
npm run pretest          # 确认后端测试使用隔离数据目录
npm test                 # Server node:test + Client Vitest
npm test --prefix client # Client Vitest
npm run lint             # Server + Client lint
npx oxlint               # Client lint
cd server && npx oxlint  # Server lint
npm run build            # Client 生产构建
```

Server 使用 Node.js 内置 `node --test --test-concurrency=1`（串行，防止 JSON 文件竞态），Client 使用 `vitest + jsdom`。

**重要：** AI 相关测试需要 `server/.env` 中配置有效的 `OPENAI_API_KEY`，否则会挂起超时。

`v5.0.0` 的验证入口统一为根目录 `npm test`、`npm run lint` 和 `npm run build`。测试数量随功能变化，不在文档中维护可漂移的固定计数。

### 代码规范

- **纯 JS/JSX**，无 TypeScript
- 前端 ESM 导入无后缀，后端 Node ESM 导入必须带 `.js` 后缀
- shadcn/ui 组件是 copy-paste 在 `client/src/components/ui/` 下的手写文件，不使用 `npx shadcn-ui add`
- Lint 使用 oxlint（前后端均已配置）

### 数据存储

- **无数据库**，所有数据存 `server/data/` 下的 JSON 文件
- 原子写入 + 双层备份（`.bak` 文件）
- 计划索引：`server/data/plans.json`
- 每计划独立文件：`server/data/plans/<id>.json`
- 用户画像：`server/data/user-profile.json`

### 清理命令

```bash
npm run clean:testdata                 # 清理失效索引 + 测试计划
npm run clean:testdata:legacy          # 预览旧版测试计划
npm run clean:testdata:legacy:confirm  # 删除旧版测试计划
npm run clean:testdata:all             # 一键清理：测试计划 + 旧版计划 + 备份 + 缓存
npm run clean:cache                    # 清理 AI 缓存
npm run clean:backups                  # 清理备份文件
```

### 已知限制

- Windows 测试需串行（`--test-concurrency=1`）
- 前端使用 HashRouter（`/#/`）
- 服务端没有数据库，数据量极大时 JSON 文件 I/O 可能成为瓶颈
