# 模块清单与冻结评估

**审查日期：** 2026-07-23
**范围：** `server/`、`client/src/`、`client/public/`、根目录脚本与包清单。初始发现阶段已冻结源码清单，共 143 个相关源码、测试和静态资源文件；本文件复用该清单，不以本次收尾重新扫描项目。
**工作区边界：** 可改项目根目录下的产品源码、测试和文档；禁止改动 `node_modules/`、`.git/`、`client/dist/`、缓存和其他生成目录。`git reset --hard`、`git clean -fd` 和宽泛递归删除均未使用。

## 基线与约定

| 项目 | 结果 |
|---|---|
| 架构 | npm monorepo；Express 5 后端（3001）和 React 19/Vite 8 前端（5173） |
| 数据边界 | 无数据库；计划与用户画像持久化在 `server/data/` JSON 文件，计划写入使用原子写入和备份 |
| 规范来源 | 当前用户要求、`AGENTS.md`、`README.md`、`CONTEXT.md`、现有测试断言 |
| 测试工具 | Server: `node --test --test-concurrency=1`；Client: Vitest + jsdom；静态检查: oxlint |
| 依赖清单 | 根、`server/`、`client/` 都有 `package.json` 与锁文件 |
| 协议文件 | 已有 `AGENTS.md`、`CONTEXT.md`；冻结发现中未见独立 `PROTOCOL.md` 或 `COLLABORATION_POLICY.md` |
| Reasonix | 本环境没有可调用的 Reasonix 工具，所有读取、测试和审计均以 PowerShell/npm 本地工具完成 |

## 测试矩阵

| 功能/名称 | 类别 | 输入与预期 | 命令或方式 | 状态 |
|---|---|---|---|---|
| Bundle 导入 | 正常 | 合法 Bundle JSON；返回含新计划 `plan.id` 的响应并在界面更新 | 隔离服务 `POST /api/learn/plans/import/bundle`；`npx vitest run client/src/test/PlanList.test.jsx` | [已执行] |
| 评分值兼容 | 边界 | 数值 `1/-1`、旧字符串和清除值；标准化后持久化 | `npm test --prefix server` | [已有，已执行] |
| 导入/评分错误 | 异常 | 非法 Bundle 或不合法评分；客户端显示失败，服务端返回 4xx | 服务端测试套件与接口错误路径走读 | [已有，已执行] |
| 反馈提示词 | 回归 | 混合模式历史；只注入最近五条 `detail` 反馈且不重复 | `node --test server/__tests__/learn-engine.test.js` | [已有，已执行] |
| Dialog 焦点与 Escape | 回归 | 打开、Tab/Shift+Tab、Escape、关闭；焦点进入、圈定并恢复 | `npx vitest run client/src/test/Dialog.test.jsx` | [已有，已执行] |
| PlanView 排序 | 正常/边界 | 待复习、低掌握度、最近访问和空结果 | `npx vitest run client/src/test/PlanView.test.jsx` | [已有，已执行] |
| 计划级弹窗与操作菜单 | 回归 | Escape、模态语义、菜单方向键和关闭后焦点 | Client Vitest 全套 | [已有，已执行] |
| 评分离线重放 | 集成 | 网络失败的评分写入队列，恢复后安全重放；仅缓存 GET | Chromium + 同源隔离服务验证入队、失败保留、成功重放和评分持久化 | [已执行] |
| 用户画像备份恢复 | 集成 | 主文件损坏时从备份读取；写入使用原子替换 | `node --test server/__tests__/user-profile.test.js` | [已有，已执行] |
| 真实 AI 内容路径 | 集成/外部 | 已授权模型下的连接、最小 Completion、Detail 生成、stepwise 互动教学和 SSE 互动教学 | 临时凭据 + 隔离计划 API | [已执行] |

## 模块评估

### 1. 前端应用壳、导航与 API 客户端 [已评估]

- **路径与职责：** `client/src/main.jsx`、`App.jsx`、`api.js`、`pages/UserProfile.jsx`、`styles/`；启动 React、管理路由和计划状态，并封装 HTTP 请求。
- **入口与依赖：** Vite 入口为 `main.jsx`；依赖 React、React Router、后端 `/api/*` 路由和浏览器的 Service Worker API；测试在 `client/src/test/`。
- **① 结构：** 应用壳与 API 边界清晰；Service Worker 注册保持在入口层，符合发布静态资源边界。
- **② 逻辑与协议：** `api.js` 统一处理请求及离线评分消息；请求键优先级和 JSON 契约由服务端约束。错误会向调用组件传播。
- **③ 测试：** Client 全套 17 文件、118 测试通过；具体 UI/API 调用由 PlanList、TopicDetail、Profile 和 QAPanel 测试覆盖。
- **④ 依赖与副作用：** 依赖 React/Vite/Router；网络请求、`sessionStorage` 与 Service Worker 为主要副作用。客户端生产依赖审计为 0 漏洞。
- **⑤ 异味与可维护性：** `api.js` 是集中契约层，需继续避免把页面状态逻辑放入其中。
- **⑥ 风险与改进点：** 中：真实离线重放需浏览器多轮场景回归；低：API 错误文案可逐步统一。无需为本轮新增 TODO。

### 2. 计划与知识点学习界面 [已评估]

- **路径与职责：** `client/src/components/PlanList.jsx`、`PlanView.jsx`、`TopicDetail.jsx`、学习内容面板及相邻测试；承担计划创建/导入、筛选排序、内容学习、资源评分与导出入口。
- **入口与依赖：** 由 `App.jsx` 路由渲染；依赖 `api.js`、Dialog/ActionMenu、Markdown 和图表组件。
- **① 结构：** 计划列表、计划视图和知识点详情分层明确；Bundle 导入和排序均落在对应交互组件。
- **② 逻辑与协议：** Bundle 成功响应使用 `plan` 契约；资源评分支持历史字符串与数字写入，失败可见；排序不改变持久化顺序。TopicDetail 复用浏览器语音识别，将转写追加到互动或错误反馈文本。
- **③ 测试：** `PlanList.test.jsx`、`PlanView.test.jsx`、`TopicDetail.test.jsx`、`QAPanel.test.jsx` 及 Client 全套均通过。
- **④ 依赖与副作用：** 主要副作用为计划 API、文件读取、`sessionStorage`；没有直接访问服务端数据目录。
- **⑤ 异味与可维护性：** `TopicDetail.jsx` 职责密度较高，后续功能增长时适合按资源、反馈、操作菜单拆分。
- **⑥ 风险与改进点：** 中：大型详情组件的回归成本；低：Bundle 非法文件的用户提示需持续保持与后端校验一致。

### 3. 评估、复习、错题与互动学习界面 [已评估]

- **路径与职责：** `ExamPaperModal.jsx`、`InteractivePanel.jsx`、`TodayReview.jsx`、`MistakePanel.jsx`、`ExercisePanel.jsx`、`QAPanel.jsx` 及测试；提供考试、纠错、间隔复习和互动教学。
- **入口与依赖：** 从 PlanView/TopicDetail 发起，依赖评估与内容 API、通用确认弹窗。
- **① 结构：** 业务流程按用户任务切分，确认类操作复用 `ConfirmDialog`；`useSpeechRecognition.js` 让互动与追问共享浏览器识别生命周期。
- **② 逻辑与协议：** 评分、复习和错题状态由服务端引擎作权威判定；客户端显示 SM-2 与掌握度结果。语音识别仅在支持的浏览器显示，权限、设备和网络错误以内联文本呈现，录音会在发送、切换或退出时停止。
- **③ 测试：** `ExamPaperModal.test.jsx`、`TodayReview.test.jsx`、`MistakePanel.test.jsx`、`QAPanel.test.jsx` 和全套 Client 测试通过。
- **④ 依赖与副作用：** 调用评估/复习 API；含用户可见的状态写入与确认操作。
- **⑤ 异味与可维护性：** 交互流程状态较多，新增模式应沿用现有面板状态机而非复制请求逻辑。
- **⑥ 风险与改进点：** 中：真实 AI 驱动互动模式需要有 Key 的集成回归；低：无。

### 4. 前端 UI 原语、可访问性与离线资源 [已评估]

- **路径与职责：** `client/src/components/ui/`、`ConfirmDialog.jsx`、`ActionMenu.jsx`、`KnowledgeGraphModal.jsx`、`MindMapModal.jsx`、`client/public/sw.js`；提供对话框、菜单、图谱工具与离线缓存。
- **入口与依赖：** 由业务组件调用；依赖 React、Lucide 和浏览器焦点/Cache/Service Worker API。
- **① 结构：** 模态焦点管理抽为 `use-modal-accessibility.js`；Service Worker 位于 Vite 可发布的 `public/`，而非源码目录。
- **② 逻辑与协议：** Dialog 有 `role="dialog"`、`aria-modal`、Escape 和焦点恢复；ActionMenu 有菜单语义、方向键和 Escape；SW 仅缓存安全 GET，评分写操作才可排队。
- **③ 测试：** `Dialog.test.jsx` 与菜单角色导出测试通过；计划级弹窗由 Client 全套覆盖。
- **④ 依赖与副作用：** 操作 DOM 焦点、滚动锁定、Cache Storage 和 IndexedDB/Service Worker 队列；需兼容浏览器实现差异。
- **⑤ 异味与可维护性：** 自定义可视化弹窗仍有不同内容模型，但共享可访问性钩子已减少重复。
- **⑥ 风险与改进点：** 中：建议在真实 Chrome/Firefox 离线模式做定期手动验证；低：无。

### 5. 服务端 HTTP 路由与中间件 [已评估]

- **路径与职责：** `server/index.js`、`server/routes/learn.js`、`content.js`、`assessment.js`、`export.js`、`flywheel.js`、`middleware.js`；暴露 JSON API、验证参数并取得 Provider/Dispatcher。
- **入口与依赖：** Express 入口 `server/index.js`；依赖引擎层、CORS、dotenv、UUID 和 OpenAI Provider。
- **① 结构：** 路由按学习、内容、评估、导出拆分，共享 Provider 获取逻辑集中在 `middleware.js`。
- **② 逻辑与协议：** Bundle 导入返回 `plan`；评分路由兼容数字与遗留字符串并执行范围验证；全局错误以 JSON 形式返回。
- **③ 测试：** Server 全套 602 测试、187 个 suite 通过；隔离服务验证了 Bundle 导入和评分持久化。
- **④ 依赖与副作用：** 读写本地计划 JSON、调用引擎和可能的 OpenAI API；生产依赖审计为 0 漏洞。
- **⑤ 异味与可维护性：** `learn.js` 路由面较广；后续端点增加时应继续提取纯校验器而不破坏路由契约。
- **⑥ 风险与改进点：** 中：外部 AI 请求的超时/配额行为仍依赖运行环境；低：无。

### 6. 持久化、CRUD 与数据迁移 [已评估]

- **路径与职责：** `server/engine/store/storage.js`、`crud.js`、`learn-store.js`、`server/migrations/`、数据完整性与清理脚本；管理 JSON 读取、原子写入、备份、计划 CRUD 与迁移。
- **入口与依赖：** 所有上层通过 `learn-store.js`；依赖 Node `fs`、数据目录和 UUID。
- **① 结构：** 基础存储、CRUD、barrel 分层符合架构约定，避免上层直接分散读写。
- **② 逻辑与协议：** 写入采用原子替换和双层备份；数据迁移可回滚；参数和计划标识由路由层和 CRUD 共同约束。
- **③ 测试：** `storage-logic`、`crud-logic`、`data-version`、`data-consistency`、`storage-startup-migration` 等 Server 测试通过，`npm run check:data --prefix server` 通过。
- **④ 依赖与副作用：** 磁盘 JSON 为核心副作用；串行 Node test 避免并发测试竞态。
- **⑤ 异味与可维护性：** 文件存储适合单用户本地应用；数据规模扩大时目录扫描与写入延迟会成为限制。
- **⑥ 风险与改进点：** 中：大数据量下 JSON I/O；低：备份清理脚本需要继续使用显式注册的测试数据。无本轮未完成项。

### 7. 内容生成、提示词与 AI Provider [已评估]

- **路径与职责：** `server/engine/learn-engine.js`、`learn-prompts.js`、`provider.js`、`interactive-teacher.js`；生成讲解、互动内容、图像/TTS 请求和提示词构造。
- **入口与依赖：** 内容与学习路由调用；依赖 OpenAI SDK、学习画像和计划数据。
- **① 结构：** 提示词构造从引擎分离；Provider 集中承载 API Key 优先级与模型调用。
- **② 逻辑与协议：** 详情生成仅注入最近五条同模式反馈，避免无关反馈和重复注入；外部响应仍需由调用端处理失败。
- **③ 测试：** `learn-engine.test.js` 回归覆盖反馈注入；完整 Server suite 通过。隔离计划上的真实 Detail 生成与 stepwise 互动教学均通过。
- **④ 依赖与副作用：** OpenAI 网络调用、可能的图像/TTS 生成及 token 成本；`openai` 生产依赖审计为 0 漏洞。
- **⑤ 异味与可维护性：** 提示词是隐性协议，应将每个新用户反馈字段纳入明确的长度与模式约束。
- **⑥ 风险与改进点：** 中：真实模型输出的非确定性；已验证 OpenAI-compatible Provider、Detail 生成和两种互动教学路径，TTS 仍应在对应授权模型下单独回归。

### 8. 评估、掌握度、复习与错题引擎 [已评估]

- **路径与职责：** `exam-engine.js`、`learning-analyzer.js`、`mastery-scheduler.js`、`spaced-repetition.js`、`mistake-ledger.js`；生成和评分考试，维护掌握证据、SM-2 队列和错题状态。
- **入口与依赖：** Assessment、Learn 与 Flywheel 路由；依赖计划 store 和可选 AI Provider。
- **① 结构：** 调度、掌握度和错题账本分为专用引擎，数据证据链可单独测试。
- **② 逻辑与协议：** 复习评分更新间隔、难度与重复次数；错题修复遵循等待和验证状态；掌握状态不等同于完成状态。
- **③ 测试：** `mastery-scheduler`、`mastery-evidence-integration`、`spaced-repetition`、`mistake-ledger`、`mistake-evidence-integration`、`today-review` 等测试通过。
- **④ 依赖与副作用：** 写计划 JSON、调用可能的 AI 评分；无数据库事务，因此依赖存储层原子写。
- **⑤ 异味与可维护性：** 状态机语义应继续通过具名状态和测试保护，避免 UI 推断服务端状态。
- **⑥ 风险与改进点：** 中：跨版本证据迁移；低：无。

### 9. 导出、用户画像、自适应与反馈闭环 [已评估]

- **路径与职责：** `export-engine.js`、`html-exporter.js`、`user-profile.js`、`routes/export.js`、`routes/flywheel.js`；导出多种格式、维护用户画像并汇总反馈偏好。
- **入口与依赖：** 导出菜单、用户画像页和计划 API；依赖 store 的 `readJSON`/`writeAtomic` 与浏览器下载。
- **① 结构：** 导出与画像职责已独立；画像改为复用存储基础设施，消除单独的非原子写路径。
- **② 逻辑与协议：** 画像主文件损坏时可读备份；资源评分进入推荐偏好；Bundle 为可恢复的完整数据契约。学习时长由 `toISOString()` 写入，用户画像对日志日期也按 UTC 日界过滤，避免东八区零点后的未来日期误判。
- **③ 测试：** `user-profile.test.js`、`batch6-core.test.js`、`export-engine.test.js`、`html-exporter.test.js` 与 Client HTML 导出测试通过。
- **④ 依赖与副作用：** 持久化画像/计划、产生下载内容；生产依赖审计为 0 漏洞。
- **⑤ 异味与可维护性：** 导出格式随产品扩展，应保持每种格式用途说明和契约测试。
- **⑥ 风险与改进点：** 低：README 标题已与根目录、Server 和 Client manifest 的 `1.13.3` 同步。

### 10. 测试、脚本与开发工具 [已评估]

- **路径与职责：** `server/__tests__/`、`client/src/test/`、`server/scripts/`、根 `scripts/windows/`、Vite/Vitest/oxlint 配置；提供串行测试、测试数据清理、数据检查和 Windows 运维入口。
- **入口与依赖：** npm scripts；依赖 Node test runner、Vitest/jsdom、oxlint、PowerShell。
- **① 结构：** Server 测试串行运行以保护 JSON 文件；清理脚本在 pre/post test 钩子执行。
- **② 逻辑与协议：** 清理脚本基于受保护计划和显式测试命名；数据完整性脚本只检测或由 `--fix` 明确修复。
- **③ 测试：** Server 603/603、Client 118/118、生产构建和数据完整性检查均通过。
- **④ 依赖与副作用：** 清理脚本会修改测试数据与备份；本轮端到端创建物已按唯一 ID 清除。三个 manifest 的生产依赖 audit 均为 0 漏洞。
- **⑤ 异味与可维护性：** oxlint 通过但保留既有警告；应渐进处理，不应为消警而扩大本轮范围。
- **⑥ 风险与改进点：** 低：为离线 Service Worker 增加浏览器自动化回归可降低手动验证负担。

## 冻结结论

本轮冻结 TODO 的 10 个缺陷均已实施和验证，后续会话已补充浏览器语音输入和 UTC 日期边界修复，未发现需要重新打开的产品任务。TTS 接口保留；其对应授权模型的真实回归仍应在具备语音能力的 Provider 下单独执行。
