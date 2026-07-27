# 模块清单与评估

> 本文件最初由审查边界（提示词第一部分）生成，并于 2026-07-27 按 `v1.14.0` 重新核对。当前证据来自源码树、Server 540 项测试、Client 112 项测试、前后端 Oxlint、数据完整性检查、生产构建、`docs/compose/reports/security-audit.md` 与 `docs/data-flywheel-audit.md`。
>
> 各模块行数是 `v1.14.0` 快照，不是接口契约；历史审查基线与完整执行证据保留在 `FINAL_REPORT.md`。

## 项目元数据

| 字段 | 值 |
|---|---|
| 仓库根 | `c:\.a\study-assistant` |
| 当前发布 | [`v1.14.0`](https://github.com/luohuayouyisuiliushui/study-assistant/releases/tag/v1.14.0) |
| 根 `package.json` 版本 | 1.14.0 |
| `server/package.json` 版本 | 1.14.0 |
| `client/package.json` 版本 | 1.14.0 |
| `README.md` 标注版本 | 1.14.0 |
| 测试框架 | Server: `node --test --test-concurrency=1`；Client: `vitest + jsdom` |
| Lint | `oxlint`（前后端各自配置） |
| 持久化 | JSON 文件 + 原子写入 + 双层备份（无数据库） |

## 工作区边界

- 允许修改：`server/`、`client/src/`、`scripts/`、`exe/`、根目录文档文件
- 禁止修改：`node_modules/`、`.git/`、`client/dist/`、`server/data/`（用户数据）、`server/cache/`
- 禁用命令：`git reset --hard`、`git clean -fd`、`Remove-Item -Recurse` 等宽泛破坏性操作

## 缺失基线汇总

| 项 | 状态 | 说明 |
|---|---|---|
| `PROTOCOL.md` / `COLLABORATION_POLICY.md` | 缺失 | 本地忽略的 AGENTS.md 承担协作协议职责，不属于发布文档 |
| `CHANGELOG.md` | 缺失 | 当前版本历史由 GitHub Releases 与 Git commit 承载 |
| CI 配置 | 缺失 | 无 `.github/workflows/` 或其它 CI 配置；测试仅本地手动 |
| `npm audit` | 已执行（原始终检） | 结果与限制见 `FINAL_REPORT.md` 的“原始终检依赖审计” |
| 持久化 E2E 套件 | 缺失 | `v1.14.0` 复用已通过的桌面/移动 Playwright 发布检查，但临时脚本不纳入仓库 |

---

## 模块清单

### M1. 持久化基础设施（server/engine/store/）

- **路径**：`server/engine/store/storage.js`（328 行）、`server/engine/store/crud.js`（1670 行）、`server/engine/store/test-plan-marker.js`、`server/engine/learn-store.js`（barrel 重导出）
- **职责**：原子写入、JSON 读写、索引管理、回收站、计划 CRUD、测试计划标记
- **入口方式**：`import { ... } from './engine/learn-store.js'`
- **内部依赖**：`uuid`、Node `fs/path`
- **外部依赖**：无外部服务
- **已知测试路径**：`server/__tests__/storage-logic.test.js`、`crud-logic.test.js`、`learn-store.test.js`、`test-plan-marker.test.js`、`data-consistency.test.js`、`edge-cases.test.js`、`clean-test-plans*.test.js`

#### 评估

① 结构：`storage.js` 抽取底座、`crud.js` 承载业务 CRUD、`test-plan-marker.js` 隔离测试计划，分层清晰。`crud.js` 1670 行偏大，CRUD/回收站/索引维护仍集中在一个模块。

② 逻辑与协议：原子写入（tmp + rename + copy 降级）+ 双层备份（`.bak` + `.backups-v2/`）+ 写入队列（per-plan mutex）+ 索引 mutex。回收站 30 天 TTL。队列最后一个 Promise settled 后按身份检查删除 Map 条目；`writePlan` 在数据落盘后等待索引更新，并将索引失败作为可重建的非致命错误记录。

③ 测试：覆盖充分（存储逻辑、CRUD 逻辑、数据一致性、边缘场景、测试计划标记）。`getCachedPlan`、`invalidatePlanCache`、`enqueueWrite`、`drainWriteQueue`、队列回收及索引异步失败均有覆盖。

④ 依赖与副作用：仅 `uuid@14`。无网络副作用。文件 I/O 通过 tmp+rename 保证原子性。

⑤ 异味与可维护性：`crud.js` 单文件 1670 行、20+ 导出函数，职责密度高。`writePlan` 是关键路径但实现保持集中。

⑥ 风险与改进点：
- **已关闭** P0-3：`writeQueues` settled 后自动回收，单次与连续排队测试均断言 `size === 0`
- **已关闭** P1-3：数据写入失败不推进索引；数据写入成功但索引更新失败时不回滚有效 plan，可通过 `rebuildIndex()` 对账
- **低** `crud.js` 文件过大，可按职责拆分为 `crud-plans.js` / `crud-trash.js` / `crud-index.js`（重构项，非缺陷）

状态：`[已评估]`

---

### M2. AI Provider（server/engine/provider.js）

- **路径**：`server/engine/provider.js`（1147 行）
- **职责**：封装 OpenAI 兼容 API 调用，三层缓存（API 前缀缓存 + 内存响应缓存 + 磁盘前缀缓存），重试逻辑，错误格式化
- **入口方式**：`import { Provider, ... } from './engine/provider.js'`
- **内部依赖**：`openai` SDK、Node `fs/path/crypto`
- **外部依赖**：OpenAI 兼容 API（DeepSeek / SiliconFlow / OpenAI）
- **已知测试路径**：`server/__tests__/provider.test.js`、`server/__tests__/key-pool.test.js`

#### 评估

① 结构：单文件 1147 行，包含 `Provider` 类、`DiskPrefixCache` 类、`KeyPool` 类、`formatConnectionError`、`encodeForRelay`、缓存键计算等。三层缓存架构清晰但耦合在一个文件。

② 逻辑与协议：`computePrefixHash`/`computeTailHash`/`computeRequestHash` 三层哈希。重试机制覆盖 429/500/503。`encodeForRelay` 在 API 调用边界对用户消息做全角化（防 SQLi/XSS 模式检测）。

③ 测试：`provider.test.js` 覆盖连接错误、哈希/缓存键、`encodeForRelay`、三个 Provider 入口的 AbortSignal 透传与流中取消，以及 `DiskPrefixCache` EPERM 降级。

④ 依赖与副作用：`openai@6.45`。网络副作用集中在此模块。`DiskPrefixCache.flush` 在 rename 失败时使用 copy + unlink 降级，持久化失败保持 dirty 以便后续重试。

⑤ 异味与可维护性：单文件 1147 行，`Provider` 类承担调用、缓存、重试、错误格式化与 Key 池等多项职责。`encodeForRelay` 的边界替换行为已有幂等及中英文回归测试锁定。

⑥ 风险与改进点：
- **已关闭** P0-4：路由 AbortSignal 已透传到 `complete`、`stream` 与 `streamWithTools`，流中取消停止 chunk 分发
- **已关闭** P1-2：`DiskPrefixCache.flush` 的 EPERM copy + unlink 降级有两条回归测试
- **已关闭** P1-5：`encodeForRelay` 有 7 条回归测试
- **低** 单文件过大，可拆分为 `provider/`、`cache/`、`key-pool.js`、`error-format.js`（重构项）

状态：`[已评估]`

---

### M3. 核心学习引擎（server/engine/learn-engine.js, learn-prompts.js）

- **路径**：`server/engine/learn-engine.js`（996 行）、`server/engine/learn-prompts.js`（1616 行）
- **职责**：生成学习内容（Detail）、追问、推荐资源、Mermaid 图、TTS、SSE 流式输出
- **入口方式**：`import { generateDetail, streamInteractiveStart, ... } from './engine/learn-engine.js'`
- **内部依赖**：`provider.js`、`learn-store.js`、`learn-prompts.js`、`adaptive-engine.js`、`interactive-teacher.js`
- **外部依赖**：OpenAI SDK（间接）
- **已知测试路径**：`server/__tests__/learn-engine.test.js`（1338 行）、`server/__tests__/learn-prompts.test.js`（406 行）

#### 评估

① 结构：`learn-engine.js` 是核心调度层，`learn-prompts.js` 是 prompt 常量库。`learn-prompts.js` 1616 行以常量为主，体积大但职责单一。

② 逻辑与协议：SSE 流式生成 + 自适应上下文注入。资源推荐对模型返回做结构化解析，兼容 JSON 围栏与说明文字；截断/空结果触发一次精简重试，并接受 AbortSignal。

③ 测试：覆盖充分（detail 生成、追问、互动、配图、TTS、资源推荐）。资源推荐另覆盖围栏、截断重试、空列表重试与 signal 透传；`learn-prompts.test.js` 验证 prompt 常量结构。

④ 依赖与副作用：通过 provider 间接调用 AI。写入计划文件通过 `writePlan`。

⑤ 异味与可维护性：`learn-prompts.js` 1616 行常量难维护，但拆分价值有限。

⑥ 风险与改进点：
- **已关闭** P1-4：SSE continue 在 `ai_thinking` 状态拒绝第二个请求，避免并发覆盖
- **低** `learn-prompts.js` 体积大，可考虑按模式拆分（重构项）

状态：`[已评估]`

---

### M4. 互动教学引擎（server/engine/interactive-teacher.js）

- **路径**：`server/engine/interactive-teacher.js`（1027 行）
- **职责**：5 种基础互动模式 + 2 种复合模式（stepwise-challenge / realtime-challenge），错误检测、会话管理、知识点分解
- **入口方式**：`import { startInteractiveDetail, continueInteractiveDetail, ... } from './engine/interactive-teacher.js'`
- **内部依赖**：`provider.js`、`learn-store.js`、`learn-prompts.js`
- **外部依赖**：OpenAI SDK（间接）
- **已知测试路径**：`server/__tests__/learn-engine.test.js`（互动部分）、`server/__tests__/batch6-core.test.js`

#### 评估

① 结构：单一引擎文件管理 7 种模式的状态机。模式共享 state machine，复合模式附加错误嵌入逻辑。

② 逻辑与协议：`onError` 回调在流式入口 catch 中调用并继续抛给路由层；会话状态持久化到 `topic.interactiveSession`。SSE continue 入口在 `ai_thinking` 时拒绝并发请求。

③ 测试：互动启动/继续/结束/挑战模式有覆盖。

④ 依赖与副作用：通过 provider 调用 AI，会话写入计划文件。

⑤ 异味与可维护性：1027 行管理 7 种模式，单文件偏大但逻辑内聚。

⑥ 风险与改进点：
- **低** 单文件偏大，可按模式拆分（重构项，非缺陷）

状态：`[已评估]`

---

### M5. 自适应与画像（server/engine/adaptive-engine.js, user-profile.js, fact-checker.js）

- **路径**：`server/engine/adaptive-engine.js`（783 行）、`server/engine/user-profile.js`（433 行）、`server/engine/fact-checker.js`（459 行）
- **职责**：错误状态机、自适应 prompt 注入、干预推荐、跨计划学习画像、事实核查
- **入口方式**：`import { ErrorStateMachine, AdaptivePromptInjector, InterventionRecommender } from './engine/adaptive-engine.js'`
- **内部依赖**：`user-profile.js`、`learn-store.js`、`provider.js`
- **外部依赖**：OpenAI SDK（间接，画像生成与事实核查）
- **已知测试路径**：`server/__tests__/adaptive-engine.test.js`、`server/__tests__/user-profile.test.js`、`server/__tests__/fact-checker.test.js`、`server/__tests__/batch6-core.test.js`、`server/__tests__/data-flywheel.test.js`

#### 评估

① 结构：三个子模块（ErrorStateMachine / AdaptivePromptInjector / InterventionRecommender）共存于 `adaptive-engine.js`。`user-profile.js` 独立。`fact-checker.js` 独立（最近重构过，`findClaimLocation` 精确匹配）。

② 逻辑与协议：允许列表（persona types / modes）严格校验。`MIN_BEHAVIOR_SAMPLES = 3` 防止小样本噪声。提问风格从当前问答历史按原理、实践、对比、确认、场景与持续追问分类；展示接口会重算行为字段，清除旧 AI 诊断文本与无依据的早晚偏好。`sanitize` / `sanitizeList` 防注入。事实/评分路径与个性化路径显式隔离。

③ 测试：覆盖充分（错误状态机、注入器、推荐器、画像更新、事实核查）。`batch6-core.test.js` 30 tests 覆盖飞轮核心。

④ 依赖与副作用：通过 provider 调用 AI。`profileUpdater` 增量更新画像。

⑤ 异味与可维护性：`adaptive-engine.js` 783 行混合三个子模块，可拆分。重复的文件头 DATA FLYWHEEL 注释已清理。

⑥ 风险与改进点：
- **已关闭** 重复的 `=== DATA FLYWHEEL ===` 文件头注释已移除
- **低** 三子模块可拆分为独立文件（重构项）

状态：`[已评估]`

---

### M6. 试卷与导出引擎（server/engine/exam-engine.js, export-engine.js）

- **路径**：`server/engine/exam-engine.js`（488 行）、`server/engine/export-engine.js`（519 行）
- **职责**：试卷生成/评分/练习、Anki/OPML/Notion/JSON/MD 导出
- **入口方式**：`import { ... } from './engine/exam-engine.js'`、`import { ... } from './engine/export-engine.js'`
- **内部依赖**：`learn-store.js`、`provider.js`、`learn-prompts.js`
- **外部依赖**：OpenAI SDK（间接）
- **已知测试路径**：`server/__tests__/engine-additions.test.js`、`server/__tests__/batch6-core.test.js`

#### 评估

① 结构：两个独立引擎文件，职责清晰。

② 逻辑与协议：试卷评分标准不被画像覆盖（显式隔离）。导出格式覆盖 5 种。

③ 测试：试卷生成/评分有覆盖。导出引擎测试覆盖度未深入核查。

④ 依赖与副作用：通过 provider 调用 AI。导出产生文件下载。

⑤ 异味与可维护性：无明显异味。

⑥ 风险与改进点：
- **低** 导出引擎测试覆盖度待核查（非缺陷，仅观察）

状态：`[已评估]`

---

### M7. 学习分析引擎（server/engine/learning-analyzer.js）

- **路径**：`server/engine/learning-analyzer.js`（580 行）
- **职责**：练习批改（gradeExercises）、薄弱点分析（analyzeWeakPoints）、概念理解评估、复习生成
- **入口方式**：`import { gradeExercises, analyzeWeakPoints, ... } from './engine/learning-analyzer.js'`
- **内部依赖**：`provider.js`、`learn-store.js`
- **外部依赖**：OpenAI SDK（间接）
- **已知测试路径**：`server/__tests__/learn-engine.test.js`（批改部分）、`server/__tests__/batch6-core.test.js`

#### 评估

① 结构：单一分析引擎文件，职责集中。

② 逻辑与协议：批改结果写入 `exercise.correct` / `gradedAt`。薄弱点写入 `topic.weakPoints`。

③ 测试：批改与薄弱点分析有覆盖。

④ 依赖与副作用：通过 provider 调用 AI。

⑤ 异味与可维护性：无明显异味。

⑥ 风险与改进点：无需改进。

状态：`[已评估]`

---

### M8. 路由层（server/routes/）

- **路径**：`server/routes/learn.js`（716 行）、`content.js`（520 行）、`assessment.js`（353 行）、`export.js`、`flywheel.js`、`settings.js`、`user-profile.js`、`middleware.js`
- **职责**：HTTP 路由、参数校验、SSE 流式响应、错误处理
- **入口方式**：`app.use('/api/learn', router)` 等（在 `server/index.js`）
- **内部依赖**：所有 engine 模块
- **外部依赖**：`express@5`
- **已知测试路径**：`server/__tests__/route-integration.test.js`、`server/__tests__/settings.test.js`、`server/__tests__/user-profile.test.js`

#### 评估

① 结构：按功能拆分路由模块，共享中间件在 `middleware.js`。`learn.js` 716 行偏大。

② 逻辑与协议：CORS 仅允许 localhost。API Key 优先级：`x-api-key` > `req.body.apiKey` > 环境变量。`test-connection` 已修复空字符串校验。SSE 路由在连接关闭时 abort 上游请求；资源推荐另设 Server 60 秒截止时间。

③ 测试：路由集成测试覆盖关键路径。Settings API 有独立测试。

④ 依赖与副作用：`express@5.2`。SSE 连接保持期间占用一个连接。

⑤ 异味与可维护性：`learn.js` 单文件 716 行混合计划/知识点/分析/考试/快测/薄弱点/图谱等多类路由。

⑥ 风险与改进点：
- **已关闭** P0-4：SSE 关闭事件连接到 AbortController，并传入 Provider
- **已关闭** P1-6：互动引擎调用 `onError`，路由 catch/finally 负责 SSE 错误与收尾；未发现错误被静默吞掉
- **低** `learn.js` 体积大，可按资源拆分（重构项）

状态：`[已评估]`

---

### M9. 入口与配置（server/index.js, server/.env.example）

- **路径**：`server/index.js`（80 行）、`server/.env.example`、`server/.oxlintrc.json`
- **职责**：Express 应用启动、中间件挂载、路由注册、生产模式静态文件服务
- **入口方式**：`node index.js`
- **内部依赖**：所有路由模块
- **外部依赖**：`express`、`cors`、`dotenv`
- **已知测试路径**：无独立测试（通过路由集成测试间接覆盖）

#### 评估

① 结构：80 行简洁入口，中间件顺序合理（日志 → CORS → JSON → 路由 → 静态 → SPA fallback → 错误处理）。

② 逻辑与协议：CORS 限制 localhost。`express.json({ limit: '10mb' })` 支持大请求体（导出/导入）。全局错误处理器返回 JSON。

③ 测试：无独立测试，依赖路由集成测试。

④ 依赖与副作用：监听端口 3001。启动时创建 `data/images/` 目录。

⑤ 异味与可维护性：无明显异味。

⑥ 风险与改进点：无需改进。

状态：`[已评估]`

---

### M10. 调试与辅助脚本（server/scripts/）

- **路径**：`server/scripts/check-data-integrity.js`、`clean-backups.js`、`clean-cache.js`、`clean-test-plans.js`、`fix-missing-relations.js`
- **职责**：数据完整性检查、清理脚本、关系修复
- **入口方式**：`npm run check:data` / `npm run clean:*`
- **内部依赖**：`learn-store.js`
- **外部依赖**：无
- **已知测试路径**：`server/__tests__/clean-test-plans.test.js`、`server/__tests__/clean-test-plans-entrypoint.test.js`

#### 评估

① 结构：脚本独立，职责清晰。原有临时文件 `server/dbg.mjs` 与 `server/_final.mjs` 已删除。

② 逻辑与协议：`clean-test-plans.js` 通过 `test-plan-marker` 识别测试计划，安全删除。`check-data-integrity.js` 支持自动修复。

③ 测试：清理脚本有覆盖。

④ 依赖与副作用：清理脚本只动 `data/` 目录下的测试计划和备份。

⑤ 异味与可维护性：已无上述一次性调试脚本残留。

⑥ 风险与改进点：
- **已关闭** `server/dbg.mjs` 与 `server/_final.mjs` 已删除

状态：`[已评估]`

---

### M11. 客户端入口与 API（client/src/App.jsx, main.jsx, api.js）

- **路径**：`client/src/App.jsx`（206 行）、`main.jsx`（21 行）、`api.js`（538 行）
- **职责**：React 应用入口、路由、API 客户端封装
- **入口方式**：`vite` 启动，`main.jsx` 渲染 `App.jsx`
- **内部依赖**：所有组件
- **外部依赖**：`react@19`、`react-router-dom@7`、`react-helmet-async`
- **已知测试路径**：`client/src/test/api-routing.test.js`、`client/src/test/api.test.js`

#### 评估

① 结构：`api.js` 538 行封装所有后端调用，按资源分组。使用 HashRouter。

② 逻辑与协议：根据任务类型从设置中选择 Provider，并把凭据注入请求。SSE 使用 `fetch + ReadableStream`；通用 request 支持组合外部 signal 与截止时间，资源推荐客户端超时为 65 秒。

③ 测试：API 路由测试覆盖端点映射；`api.test.js` 覆盖资源推荐超时、中止和可读错误。

④ 依赖与副作用：浏览器 fetch。无本地存储副作用（除设置）。

⑤ 异味与可维护性：`api.js` 538 行偏大，但按资源分块。

⑥ 风险与改进点：无需改进。

状态：`[已评估]`

---

### M12. 客户端组件（client/src/components/）

- **路径**：`PlanView.jsx`（718 行）、`TopicDetail.jsx`（1316 行）、`KnowledgeGraphModal.jsx`（767 行）、`MindMapModal.jsx`（230 行）、`UserProfile.jsx`（546 行）、`MediaViewer.jsx`（426 行）、`MermaidDiagram.jsx`（175 行）等业务组件
- **职责**：业务 UI 组件
- **入口方式**：`App.jsx` 引用
- **内部依赖**：`ui/` 原子组件、`api.js`、`lib/` 工具
- **外部依赖**：`react`、`recharts`、`mermaid`、`markmap-lib/view`、`lucide-react`
- **已知测试路径**：`client/src/test/*.test.{js,jsx}`（16 个测试文件）

#### 评估

① 结构：业务组件 + `ui/` 手写 shadcn 组件。`MediaViewer` 统一承载位图/Mermaid 全屏工具；知识图谱布局和思维导图导出逻辑已下沉到 `lib/`；`TopicDetail.jsx` 1316 行偏大。

② 逻辑与协议：使用 React 19 + Hooks。`TopicDetail` 包含生成/配图/TTS/互动/练习/考试、资源推荐和顶部感应导航。`MermaidDiagram` 首次懒渲染，后续源码变化等待显式重绘。大型知识图谱自动聚合根主题并允许切换完整视图；思维导图提供 Markdown/SVG/PNG/JSON/OPML 导出；画像时长只以小时/分钟呈现。

③ 测试：16 个测试文件、112 项测试通过。新增覆盖知识图谱聚合、Mermaid 节点 ID 映射、视图切换、思维导图结构化导出，以及画像时间和提问风格展示。

④ 依赖与副作用：浏览器 DOM。无直接文件系统副作用。

⑤ 异味与可维护性：`TopicDetail.jsx` 1316 行单文件偏大。Client lint 为 27 个 warning / 0 error，其中仍有需要逐项重构的 Hooks 依赖告警。

⑥ 风险与改进点：
- **中** 剩余 Hooks 依赖告警需逐条用行为测试保护后再重构，避免补依赖触发重复请求
- **低** `TopicDetail.jsx` 体积大，可按面板拆分（重构项）

状态：`[已评估]`

---

### M13. 客户端 UI 原子组件（client/src/components/ui/）

- **路径**：12 个 `.jsx` 文件（badge、button、card、dialog、dropdown-menu、input、label、progress、select、separator、skeleton、tabs）
- **职责**：手写 shadcn/ui 组件
- **入口方式**：业务组件引用
- **内部依赖**：`lib/utils.js`
- **外部依赖**：`tailwindcss@4`、`lucide-react`
- **已知测试路径**：无独立测试（通过业务组件间接覆盖）

#### 评估

① 结构：标准 shadcn/ui copy-paste 模式。

② 逻辑与协议：纯展示组件，无业务逻辑。

③ 测试：无独立测试。

④ 依赖与副作用：无。

⑤ 异味与可维护性：无明显异味。

⑥ 风险与改进点：无需改进。

状态：`[已评估]`

---

### M14. 客户端工具与上下文（client/src/lib/, client/src/utils/）

- **路径**：`lib/knowledge-graph-layout.js`、`mind-map-export.js`、`mermaid-source.js`、`mermaid-renderer.js`、`plan-context.jsx`、`settings-storage.js`、`theme-context.jsx`、`utils.js`、`utils/encoding.js`
- **职责**：知识图谱聚合、思维导图结构化导出、Mermaid 源码规范化与渲染、计划上下文、设置存储、主题上下文、通用工具、编码工具
- **入口方式**：组件引用
- **内部依赖**：无
- **外部依赖**：无
- **已知测试路径**：`client/src/test/knowledge-graph-layout.test.js`、`MindMapModal.test.jsx`、`mermaid-source.test.js`、`MermaidDiagram.test.jsx`、`settings-storage.test.js`

#### 评估

① 结构：按职责拆分，清晰。

② 逻辑与协议：`settings-storage.js` 使用 localStorage。`plan-context.jsx` 提供 React context。

③ 测试：图谱聚合、思维导图 OPML/JSON/Markdown、Mermaid 源码与渲染触发策略、设置存储均有测试。

④ 依赖与副作用：localStorage。

⑤ 异味与可维护性：无明显异味。

⑥ 风险与改进点：无需改进。

状态：`[已评估]`

---

### M15. Windows 脚本（scripts/windows/, exe/）

- **路径**：`scripts/windows/*.ps1`（7 个）、`exe/*.cmd`（6 个）
- **职责**：Windows 启动/诊断/清理脚本
- **入口方式**：双击 `.cmd` 或 PowerShell 执行 `.ps1`
- **内部依赖**：无
- **外部依赖**：PowerShell 5+
- **已知测试路径**：无

#### 评估

① 结构：`.cmd` 入口调用 `.ps1` 实现，分离便捷性与逻辑。

② 逻辑与协议：`ExecutionPolicy Bypass` 仅限当前进程。`stop.ps1` 校验 PID + 启动时间后 taskkill。

③ 测试：无测试。

④ 依赖与副作用：启动/停止 Node 进程。

⑤ 异味与可维护性：无明显异味。

⑥ 风险与改进点：无需改进。

状态：`[已评估]`

---

### M16. 文档（README.md, FINAL_REPORT.md, MODULES.md, TODO.md, client/README.md, docs/）

- **路径**：9 个已跟踪 Markdown；另有本地忽略的 `AGENTS.md`、`CONTEXT.md` 等协作资料，不随 Release 发布
- **职责**：项目说明、AI 协作规范、领域术语、审计报告
- **入口方式**：阅读
- **内部依赖**：无
- **外部依赖**：无
- **已知测试路径**：无

#### 评估

① 结构：分层清晰（README 用户文档 / FINAL_REPORT 与 MODULES 证据文档 / TODO 未完成项 / docs 专题报告）。

② 逻辑与协议：已跟踪文档面向用户和发布审计；本地 AGENTS.md 定义分支、提交和版本号等协作规则。

③ 测试：无。

④ 依赖与副作用：无。

⑤ 异味与可维护性：9 个已跟踪 Markdown 已在 `v1.14.0` 统一复核；历史报告通过明确的快照标签与当前状态区分。

⑥ 风险与改进点：
- **已关闭** README、三个 package 与发布链接均同步到 `v1.14.0`
- **已关闭** `security-audit.md` 已补 2026-07-27 复核状态

状态：`[已评估]`

---

## 测试矩阵（汇总）

> 完整测试矩阵按功能划分。`[已有]` = 已有测试；`[缺失待补]` = 无测试需补；`[仅手动]` = 无法自动化；`[需外部]` = 依赖外部服务。

| 功能 | 正常 | 边界 | 异常 | 回归 | 集成 |
|---|---|---|---|---|---|
| 原子写入 | [已有] storage-logic | [已有] storage-logic | [已有] EPERM 降级 | [已有] | [已有] data-consistency |
| 计划 CRUD | [已有] crud-logic | [已有] edge-cases | [已有] 不存在计划 | [已有] | [已有] route-integration |
| 回收站 | [已有] crud-logic | [已有] edge-cases | [缺失待补] rename 失败 | [已有] | [已有] |
| 索引重建 | [已有] storage-logic | [已有] 空目录 | [缺失待补] 损坏索引 | [已有] | [已有] |
| Provider 调用 | [需外部] OPENAI_API_KEY | [缺失待补] 超时 | [已有] formatConnectionError | [已有] | [需外部] |
| 缓存键计算 | [已有] provider | [缺失待补] 空消息 | [缺失待补] 深度越界 | [已有] | [缺失待补] |
| `encodeForRelay` | [已有] provider | [已有] 空字符串/中文/代码 | [N/A] 字符串接口 | [已有] 幂等 | [已有] Provider |
| `DiskPrefixCache` | [已有] provider | [缺失待补] 满容量 | [已有] rename/copy 失败 | [已有] EPERM | [已有] 文件持久化 |
| SSE 流式 detail | [需外部] | [已有] Provider 流中取消 | [已有] aborted/error | [已有] signal 透传 | [需外部] |
| SSE 流式 interactive | [需外部] | [已有] Provider 流中取消 | [已有] onError | [已有] signal 透传 | [需外部] |
| 互动会话持久化 | [已有] learn-engine | [已有] `ai_thinking` guard | [已有] 无会话 | [已有] | [已有] |
| 资源推荐 | [已有] engine-additions | [已有] 围栏/空列表/截断 | [已有] 超时/取消 | [已有] 重试恢复 | [已有] API + UI |
| 错误状态机 | [已有] adaptive-engine | [已有] 阈值边界 | [已有] 空概念 | [已有] | [已有] |
| 自适应注入器 | [已有] batch6-core | [已有] MIN_BEHAVIOR_SAMPLES | [已有] 无画像 | [已有] | [已有] |
| 学习画像 | [已有] user-profile | [已有] 空计划 | [已有] 损坏 JSON | [已有] | [已有] |
| 事实核查 | [已有] fact-checker | [已有] 无 claim | [已有] provider 错误 | [已有] | [已有] |
| 试卷生成/评分 | [已有] learn-engine | [缺失待补] 大题量 | [已有] provider 错误 | [已有] | [已有] |
| 数据导出 | [已有] engine-additions | [缺失待补] 空计划 | [缺失待补] 损坏数据 | [已有] | [缺失待补] |
| 清理脚本 | [已有] clean-test-plans | [已有] 空目录 | [已有] 损坏索引 | [已有] | [已有] |
| 前端 PlanView | [已有] PlanView.test | [已有] 空计划 | [缺失待补] API 错误 | [已有] | [已有] |
| 前端 TopicDetail | [已有] TopicDetail.test | [已有] 无 detail | [缺失待补] 生成失败 | [已有] | [已有] |
| 前端 KnowledgeGraph | [已有] KnowledgeGraphModal.test | [已有] 聚合/完整切换 | [已有] API 错误 | [已有] 节点 ID 映射 | [已有] Mermaid DOM |
| 前端 MindMap | [已有] MindMapModal.test | [已有] 结构化树 | [已有] PNG fallback 文案 | [已有] 五种导出 | [已有] Markmap |
| 前端 MediaViewer | [已有] MediaViewer.test | [已有] SVG/位图 | [已有] 编辑失败信息 | [已有] 下载变换 | [已有] TopicDetail |
| 前端 Mermaid | [已有] MermaidDiagram.test | [已有] StrictMode/源码变化 | [已有] 语法失败重试 | [已有] 手动重绘 | [已有] MediaViewer |

## 当前验证基线（v1.14.0）

| 测试套件 | 命令 | 退出码 | 通过/失败 | 分类 |
|---|---|---|---|---|
| Server | `npm test --prefix server` | 0 | 540 / 0 | 全部通过 |
| Client | `npm test --prefix client` | 0 | 112 / 0 | 全部通过 |
| Server Lint | `npm run lint --prefix server` | 0 | 105 警告 / 0 错误 | 既有 warning，无 error |
| Client Lint | `npm run lint --prefix client` | 0 | 27 警告 / 0 错误 | 低于 30 的验收阈值 |
| Client Build | `npm run build --prefix client` | 0 | production build success | 全部通过 |
| Data Integrity | `npm run check:data --prefix server` | 0 | all checks passed | 全部通过 |
