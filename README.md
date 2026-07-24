# Study Assistant v1.13.2

AI 学习助手 —— 告诉 AI 你想学什么，它帮你拆解知识点、生成讲解、出题考试、追踪薄弱环节，还越用越懂你。

## 它能做什么

你创建一个学习计划（比如"Python 入门"），添加几个知识点（比如"变量与类型"、"条件判断"、"循环"），然后：

### AI 生成讲解
1. AI 为每个知识点生成**详细讲解**，包含概念解释、Mermaid 图表、代码示例和练习题
2. 支持 **SSE 流式输出**，实时看到生成过程
3. 讲解内容支持 **Markdown 渲染**、**数学公式**（KaTeX）、**思维导图**和 **Mermaid 图表**

### 互动学习
4. **7 种互动教学模式**：费曼教学、挑战找错、分段引导、实时互动、脚手架引导、分段挑战、实时挑战
5. 随时**追问**任何不理解的地方，AI 深入解释
6. **练习与测验**：随堂练习 AI 自动批改，支持智能组卷考试
7. **浏览器语音输入**：在互动教学、扩展追问和错误反馈输入框中可使用麦克风将中文语音转成文本；不支持 Web Speech API 的浏览器不会显示该控件

### 知识图谱
8. **自动提取知识点关系**：从讲解文本中识别前置依赖、扩展、对比等关系
9. **交互式图谱可视化**：支持力导向图、鱼眼缩放、拖拽和关系推断

### 学习分析与画像
10. **跨计划学习画像**：自动识别你的强项、弱项、学习模式（深度思考型 / 实践应用型 / 类比联想型等）
11. **当天答题情况显示板**：按天/周追踪练习、试卷、快问的正确率和数量
12. **费曼教学分析**：记录教学质量、精彩讲解摘录、学生遗留问题

### 数据导出
13. 导出为 **Anki 卡片**、**Markdown**、**HTML 离线单文件**、**OPML**（思维导图）、**JSON**、**学习笔记**、**计划数据包**（备份恢复）等 7 种格式，每种格式均带用途说明
14. **数据包还原**：导出的计划数据包（Bundle JSON）可通过导入功能重新恢复，支持跨设备迁移和灾难恢复

### 个性化自适应
15. **越用越懂你**：每次做练习、提问、学习时长都被记录，AI 自动调整难度和讲解风格
16. **自适应引擎**：根据薄弱点自动推荐复习内容，事实核查你的理解

### 复习与错题修复
17. **今日复习队列**：到期复习与待修复错题合并为一个智能队列，优先处理错题，到期复习紧随其后，优先级基于逾期天数和掌握水平动态计算
18. **错题修复**：练习/测验中答错的题自动归入错题台账；修复练习答对后进入 24 小时等待期，到期后再次验证，通过才标记为已验证，未通过则重新打开
19. **间隔重复（SM-2）**：每个知识点独立维护 SM-2 复习计划表（间隔天数、难度系数、重复次数、遗忘次数），复习后 UI 直接展示本次调度参数（间隔 X 天 / 难度系数 Y / 已复习 Z 次），帮助用户理解排期依据

### 掌握评估体系
20. **完成 ≠ 掌握**：知识点标记为"已完成"仅代表用户已标记学完，不自动视为掌握。掌握水平由 `mastery` 字段独立追踪，初始状态为 `unassessed` 或 `learning`（已标记完成）
21. **证据驱动掌握**：所有练习、测验、费曼教学、复习的数据点作为证据（`masteryEvidence`）持久化，引擎从最近 20 条证据加权计算掌握分数（`level: 0–1`）和状态；掌握度旁展示证据样本数 tooltip，帮助区分可靠程度
22. **薄弱点可视化**：AI 分析后将薄弱知识点以标签形式展示在知识点详情页，标注掌握程度与建议行动
23. **掌握判定条件**：达到 `mastered` 需同时满足 — 掌握分数 ≥ 0.8、至少 3 个独立练习轮次、至少 2 条 high 置信度的高分证据、且覆盖超过 24 小时

---

## 快速开始

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`，在设置里填入 API Key（支持 OpenAI / DeepSeek / SiliconFlow / 任意兼容 OpenAI 的 API）即可使用。

> 也可通过 `npm run start` 启动**生产模式**（先 `npm run build` 构建前端，后端在端口 3001 提供完整服务）。

### Windows 快速开始

要求 Windows 10/11 和 Node.js 20.19+（或 22.12+）。在项目根目录依次双击：

1. `windows-doctor.cmd`：检查 Node.js、npm、端口和依赖状态
2. `windows-setup.cmd`：安装根目录、服务端和客户端依赖
3. `windows-dev.cmd`：启动开发环境，然后访问 `http://localhost:5173`

清理测试数据：双击 `windows-clean-testdata.cmd`，一键清除测试计划、回收站测试条目、测试通知、备份和缓存文件。

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

- 提示端口 3001 或 5173 被占用：先运行 `windows-stop.cmd`；若不是本项目进程，可用 `Get-NetTCPConnection -State Listen -LocalPort 3001,5173` 找到 PID。
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

### 3. 互动学习

选择一种互动模式深入学习：

| 模式 | 说明 |
|------|------|
| **费曼学习** | 你向 AI 讲解，AI 追问你不懂的地方 |
| **挑战模式** | AI 故意讲错，看你能不能发现 |
| **分段讲解** | AI 按步骤逐段讲解，每段后暂停等你确认 |
| **实时互动** | AI 实时响应你的反馈，灵活调整节奏 |
| **脚手架引导** | 将复杂概念拆成递进子问题，逐个掌握 |
| **分段挑战** | 分段讲解 + AI 嵌入错误，边读边纠错 |
| **实时挑战** | 实时对话 + AI 嵌入错误，保持批判性警觉 |

### 4. 练习与测验

完成学习后，可以：
- 做随堂练习（AI 自动批改）
- AI 智能组卷考试（选择题 + 问答题 + 编程题）
- 快速测验（quick quiz，按知识点随机出题）
- 查看薄弱点分析

### 5. 查看知识图谱

- 打开知识图谱视图，展示所有知识点及其关系
- 关系类型：前置依赖、扩展、示例、对比、构建于、引用
- 支持推断边（隐藏/显示）
- 力导向图布局，可交互拖拽

### 6. 学习画像与今日统计

- **学习画像**：AI 自动分析跨计划的学习数据，生成你的学习风格、强项、弱项和个性化建议
- **当日答题板**：实时追踪今天做了多少题、正确率多少，按练习/试卷/快问分类展示
- **上周回顾**：统计本周累计答题数和正确率

### 7. 数据导出

支持导出为：

| 格式 | 用途 |
|------|------|
| **Markdown (.md)** | 通用文档，可在 Obsidian / Notion 中打开 |
| **HTML 离线网页** | 单文件离线浏览，含渲染样式 |
| **Anki CSV** | 导入 Anki 制作闪卡复习 |
| **OPML** | 导入思维导图工具（XMind / FreeMind 等） |
| **JSON** | 结构化数据，供二次开发或脚本处理 |
| **学习笔记** | 纯 Markdown 笔记，不含题目 |
| **计划数据包** | 完整备份 JSON，可通过导入功能恢复至本应用 |

### 8. 复习与错题修复

- **今日复习**：打开今日复习面板，查看合并队列中的到期复习和待修复错题，按优先级从高到低展示。复习时逐题作答，每次回答质量（0–5 分）驱动 SM-2 间隔算法
- **启动错题修复**：从错题面板选择记录并完成定向练习；答对后显示精确的 24 小时验证时间，到期后再次作答，通过才标记为已验证，未通过则重新打开
- **掌握进度**：完成标记只表示学完；系统根据练习证据与复习记录独立计算掌握状态，并据此安排后续复习

---

## 技术细节（开发者）

### 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + Vite 8 + Tailwind CSS 4 + shadcn/ui（copy-paste） |
| 后端 | Node.js + Express 5 + OpenAI SDK（兼容 DeepSeek / SiliconFlow 等） |
| AI | OpenAI 兼容 API，SSE 流式输出 |
| 存储 | JSON 文件系统，原子写入 + 双层备份（无需数据库） |
| 图表 | Mermaid（流程图）、Recharts（统计图）、Cytoscape（知识图谱） |
| 数学 | KaTeX |

### 项目结构

```
study-assistant/
├── client/                      # React 前端
│   ├── src/
│   │   ├── api.js               # API 客户端封装
│   │   ├── components/          # 业务组件
│   │   │   ├── ui/              # shadcn/ui 手写组件
│   │   │   ├── PlanView.jsx     # 计划详情（含搜索/筛选/滚动恢复）
│   │   │   ├── TopicDetail.jsx  # 知识点详情（薄弱点/SM-2参数/资源评分）
│   │   │   ├── KnowledgeGraphModal.jsx  # 知识图谱
│   │   │   ├── ExercisePanel.jsx       # 练习面板
│   │   │   ├── ExamPaperModal.jsx      # 考试面板
│   │   │   ├── InteractivePanel.jsx    # 互动教学
│   │   │   ├── QAPanel.jsx      # 问答面板
│   │   │   ├── MistakePanel.jsx # 错题管理
│   │   │   ├── TodayReview.jsx  # 今日复习队列
│   │   │   ├── ConfirmDialog.jsx # 统一确认对话框（替代 window.confirm）
│   │   │   └── ...
│   │   └── pages/
│   │       └── UserProfile.jsx  # 学习画像页
│   └── dist/                    # 生产构建产物
├── server/                      # Express 后端
│   ├── engine/
│   │   ├── learn-engine.js      # 核心引擎（讲解/追问）
│   │   ├── learn-store.js       # barrel 导出
│   │   ├── learning-analyzer.js # 学习分析（练习批改/薄弱点）
│   │   ├── exam-engine.js       # 试卷引擎（生成/评分/练习）
│   │   ├── interactive-teacher.js # 互动教学（5 种基础模式 + 2 种复合）
│   │   ├── adaptive-engine.js   # 自适应推荐引擎
│   │   ├── user-profile.js      # 跨计划学习画像
│   │   ├── store/
│   │   │   ├── storage.js       # 持久化基础设施
│   │   │   └── crud.js          # CRUD 操作
│   │   └── ...
│   ├── routes/
│   │   ├── learn.js             # 计划/知识点 CRUD + 分析
│   │   ├── content.js           # 内容教学（生成/交互/TTS）
│   │   ├── assessment.js        # 评估（考试/事实核查/自适应）
│   │   ├── export.js            # 导出（Anki/OPML/Notion/MD）
│   │   ├── user-profile.js      # 学习画像 API
│   │   ├── settings.js          # 服务端持久化设置（.env.local）
│   │   ├── flywheel.js          # 数据飞轮
│   │   └── middleware.js        # 共享中间件
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
├── package.json                 # monorepo 根（workspaces）
├── CONTEXT.md                   # 领域术语表
└── AGENTS.md                    # AI 协作规范
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
| `/api/learn/plans/:id/export` | 数据导出（MD/HTML/Anki/OPML/JSON/Bundle） |
| `/api/learn/plans/import/bundle` | 计划数据包还原（Bundle JSON 导入） |
| `/api/learn/plans/:id/topics/:tid/resources/:idx/rating` | 资源推荐评分（👍/👎） |
| `/api/learn/plans/:id/adaptive/review` | 自适应复习推荐 |
| `/api/learn/fact-check` | 事实核查 |
| `/api/user-profile/summary` | 学习画像摘要 |
| `/api/user-profile/analyze` | AI 画像生成 |
| `/api/user-profile` | 画像数据 |
| `/api/settings/env-key` | 服务端 Key 持久化（读写 .env.local） |

### 运行测试

```bash
npm test                 # 后端测试 + 前端 lint
npm run pretest          # 清理测试数据（务必先跑）
cd server && npm test    # 仅后端测试（node --test --test-concurrency=1）
```

Server 使用 Node.js 内置 `node --test --test-concurrency=1`（串行，防止 JSON 文件竞态），Client 使用 `vitest + jsdom`。

**重要：** AI 相关测试需要 `server/.env` 中配置有效的 `OPENAI_API_KEY`，否则会挂起超时。

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
- **自动数据迁移**：升级到 v2 schema 时自动将计划数据迁移到当前版本；迁移前将原始文件备份到 `server/data/.migration-backups/data-version-<timestamp>` 目录，迁移失败自动回滚

### 清理命令

```bash
npm run clean:testdata                 # 清理带测试标记的计划、回收站条目和测试通知文件
npm run clean:testdata:legacy          # 预览旧版命名的测试计划和回收站条目
npm run clean:testdata:legacy:confirm  # 删除安全的旧版命名测试数据
npm run clean:testdata:all             # 一键清理：测试数据、回收站、备份和缓存
npm run clean:cache                    # 清理 AI 缓存
npm run clean:backups                  # 清理备份文件
```

### 已知限制

- **单用户本地应用**：所有数据存储在本地的 `server/data/` 目录下，无云端同步、无多用户/多设备协作、无通知推送。数据仅限浏览器访问当前后端进程时可用
- Windows 测试需串行（`--test-concurrency=1`）
- 前端使用 HashRouter（`/#/`）
- 服务端没有数据库，数据量极大时 JSON 文件 I/O 可能成为瓶颈
