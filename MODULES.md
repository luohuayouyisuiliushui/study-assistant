# 模块清单与评估

> 本文件由审查边界（提示词第一部分）生成。评估证据来自：源码树枚举、测试基线（Server 517 通过 / Client 88 通过 / Server Lint 100 警告 0 错误 / Client Lint 43 警告 0 错误）、`docs/compose/reports/security-audit.md`（2026-07-10）、`docs/data-flywheel-audit.md`，以及对关键文件的抽样读取。
>
> Reasonix 不可用，使用本地工具（PowerShell / git / ripgrep）替代。

## 项目元数据

| 字段 | 值 |
|---|---|
| 仓库根 | `c:\.a\study-assistant` |
| 当前分支 | `codex/fix-mermaid-and-runtime-health` |
| 工作树状态 | 干净（`git status --short` 无输出） |
| 根 `package.json` 版本 | 1.11.1 |
| `server/package.json` 版本 | 1.11.1 |
| `client/package.json` 版本 | 1.11.1 |
| `README.md` / `AGENTS.md` 标注版本 | 1.9.1（陈旧，与代码不一致） |
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
| `PROTOCOL.md` / `COLLABORATION_POLICY.md` | 缺失 | AGENTS.md 已承担部分协议职责，无独立协议文件 |
| `CHANGELOG.md` | 缺失 | 版本从 1.9.1 → 1.11.1 无变更日志 |
| CI 配置 | 缺失 | 无 `.github/workflows/` 或其它 CI 配置；测试仅本地手动 |
| `npm audit` | 未执行 | 后续在实施边界执行 |
| E2E 测试 | 缺失 | 仅单元/集成测试，无 Playwright 端到端（`playwright` 已是 devDependency 但未使用） |
| Reasonix 工具 | 不可用 | 降级到本地工具 |

---

## 模块清单

### M1. 持久化基础设施（server/engine/store/）

- **路径**：`server/engine/store/storage.js`（290 行）、`server/engine/store/crud.js`（1504 行）、`server/engine/store/test-plan-marker.js`、`server/engine/learn-store.js`（barrel 重导出）
- **职责**：原子写入、JSON 读写、索引管理、回收站、计划 CRUD、测试计划标记
- **入口方式**：`import { ... } from './engine/learn-store.js'`
- **内部依赖**：`uuid`、Node `fs/path`
- **外部依赖**：无外部服务
- **已知测试路径**：`server/__tests__/storage-logic.test.js`、`crud-logic.test.js`、`learn-store.test.js`、`test-plan-marker.test.js`、`data-consistency.test.js`、`edge-cases.test.js`、`clean-test-plans*.test.js`

#### 评估

① 结构：`storage.js` 抽取底座、`crud.js` 承载业务 CRUD、`test-plan-marker.js` 隔离测试计划，分层清晰。`crud.js` 1504 行偏大，CRUD/回收站/索引维护/写入队列混在一起。

② 逻辑与协议：原子写入（tmp + rename + copy 降级）+ 双层备份（`.bak` + `.backups-v2/`）+ 写入队列（per-plan mutex）+ 索引 mutex。回收站 30 天 TTL。`writePlan` 内 `writeAtomic` 失败时 `updateIndex` 不执行（设计为 fail-fast，但若 writeAtomic 成功而 updateIndex 失败会导致索引 topicCount 过时 — 见 P1-3）。

③ 测试：覆盖充分（存储逻辑、CRUD 逻辑、数据一致性、边缘场景、测试计划标记）。`getCachedPlan`、`invalidatePlanCache`、`enqueueWrite`、`drainWriteQueue` 均有覆盖。

④ 依赖与副作用：仅 `uuid@14`。无网络副作用。文件 I/O 通过 tmp+rename 保证原子性。

⑤ 异味与可维护性：`crud.js` 单文件 1504 行、20+ 导出函数，职责密度高。`writePlan` 在 17 处被调用，是关键路径但实现简短。

⑥ 风险与改进点：
- **高** P0-3：`writeQueues` Map 条目只在 `permanentlyDeletePlan`/`trashPlan` 时清理，长时间运行的服务器会积累条目阻止 GC（已登记 security-audit.md）
- **中** P1-3：`writePlan` 中 `writeAtomic` 成功但 `updateIndex` 失败时索引过时（已登记）
- **低** `crud.js` 文件过大，可按职责拆分为 `crud-plans.js` / `crud-trash.js` / `crud-index.js`（重构项，非缺陷）

状态：`[已评估]`

---

### M2. AI Provider（server/engine/provider.js）

- **路径**：`server/engine/provider.js`（958 行）
- **职责**：封装 OpenAI 兼容 API 调用，三层缓存（API 前缀缓存 + 内存响应缓存 + 磁盘前缀缓存），重试逻辑，错误格式化
- **入口方式**：`import { Provider, ... } from './engine/provider.js'`
- **内部依赖**：`openai` SDK、Node `fs/path/crypto`
- **外部依赖**：OpenAI 兼容 API（DeepSeek / SiliconFlow / OpenAI）
- **已知测试路径**：`server/__tests__/provider.test.js`、`server/__tests__/key-pool.test.js`

#### 评估

① 结构：单文件 958 行，包含 `Provider` 类、`DiskPrefixCache` 类、`KeyPool` 类、`formatConnectionError`、`encodeForRelay`、缓存键计算等。三层缓存架构清晰但耦合在一个文件。

② 逻辑与协议：`computePrefixHash`/`computeTailHash`/`computeRequestHash` 三层哈希。重试机制覆盖 429/500/503。`encodeForRelay` 在 API 调用边界对用户消息做全角化（防 SQLi/XSS 模式检测）。

③ 测试：`provider.test.js` 主要覆盖 `formatConnectionError`。`encodeForRelay`、`DiskPrefixCache`、缓存键计算无测试（见 P1-5）。

④ 依赖与副作用：`openai@6.45`。网络副作用集中在此模块。`DiskPrefixCache.flush` 使用裸 `renameSync`，无 EPERM 保护（见 P1-2）。

⑤ 异味与可维护性：单文件 958 行，`Provider` 类承担过多职责（调用 + 缓存 + 重试 + 错误格式化 + Key 池）。`encodeForRelay` 静默修改用户输入，AI 看到的与用户输入不一致。

⑥ 风险与改进点：
- **高** P0-4：SSE 客户端断开后底层 API 调用无取消机制（无 AbortController），后台继续消耗 tokens（已登记 security-audit.md）
- **中** P1-2：`DiskPrefixCache.flush` 的 `renameSync` 无 EPERM 降级（已登记）
- **中** P1-5：`encodeForRelay` 无任何测试覆盖（已登记）
- **低** 单文件过大，可拆分为 `provider/`、`cache/`、`key-pool.js`、`error-format.js`（重构项）

状态：`[已评估]`

---

### M3. 核心学习引擎（server/engine/learn-engine.js, learn-prompts.js）

- **路径**：`server/engine/learn-engine.js`（826 行）、`server/engine/learn-prompts.js`（1544 行）
- **职责**：生成学习内容（Detail）、追问、推荐资源、Mermaid 图、TTS、SSE 流式输出
- **入口方式**：`import { generateDetail, streamInteractiveStart, ... } from './engine/learn-engine.js'`
- **内部依赖**：`provider.js`、`learn-store.js`、`learn-prompts.js`、`adaptive-engine.js`、`interactive-teacher.js`
- **外部依赖**：OpenAI SDK（间接）
- **已知测试路径**：`server/__tests__/learn-engine.test.js`（1135 行）、`server/__tests__/learn-prompts.test.js`（353 行）

#### 评估

① 结构：`learn-engine.js` 是核心调度层，`learn-prompts.js` 是 prompt 常量库。`learn-prompts.js` 1544 行纯常量，体积大但职责单一。

② 逻辑与协议：SSE 流式生成 + 自适应上下文注入。`interactiveSession` 直接赋值到 topic 再持久化（见 P1-4 并发覆盖风险）。

③ 测试：覆盖充分（detail 生成、追问、互动、配图、TTS、资源推荐）。`learn-prompts.test.js` 验证 prompt 常量结构。

④ 依赖与副作用：通过 provider 间接调用 AI。写入计划文件通过 `writePlan`。

⑤ 异味与可维护性：`learn-prompts.js` 1544 行常量难维护，但拆分价值有限。

⑥ 风险与改进点：
- **中** P1-4：`interactiveSession` 并发覆盖风险（已登记 security-audit.md，低概率）
- **低** `learn-prompts.js` 体积大，可考虑按模式拆分（重构项）

状态：`[已评估]`

---

### M4. 互动教学引擎（server/engine/interactive-teacher.js）

- **路径**：`server/engine/interactive-teacher.js`（876 行）
- **职责**：5 种基础互动模式 + 2 种复合模式（stepwise-challenge / realtime-challenge），错误检测、会话管理、知识点分解
- **入口方式**：`import { startInteractiveDetail, continueInteractiveDetail, ... } from './engine/interactive-teacher.js'`
- **内部依赖**：`provider.js`、`learn-store.js`、`learn-prompts.js`
- **外部依赖**：OpenAI SDK（间接）
- **已知测试路径**：`server/__tests__/learn-engine.test.js`（互动部分）、`server/__tests__/batch6-core.test.js`

#### 评估

① 结构：单一引擎文件管理 7 种模式的状态机。模式共享 state machine，复合模式附加错误嵌入逻辑。

② 逻辑与协议：`onError` 回调在多个 catch 块中被调用（P1-6 部分修复）。会话状态持久化到 `topic.interactiveSession`。

③ 测试：互动启动/继续/结束/挑战模式有覆盖。

④ 依赖与副作用：通过 provider 调用 AI，会话写入计划文件。

⑤ 异味与可维护性：876 行管理 7 种模式，单文件偏大但逻辑内聚。

⑥ 风险与改进点：
- **低** 单文件偏大，可按模式拆分（重构项，非缺陷）

状态：`[已评估]`

---

### M5. 自适应与画像（server/engine/adaptive-engine.js, user-profile.js, fact-checker.js）

- **路径**：`server/engine/adaptive-engine.js`（783+ 行）、`server/engine/user-profile.js`（381 行）、`server/engine/fact-checker.js`（401 行）
- **职责**：错误状态机、自适应 prompt 注入、干预推荐、跨计划学习画像、事实核查
- **入口方式**：`import { ErrorStateMachine, AdaptivePromptInjector, InterventionRecommender } from './engine/adaptive-engine.js'`
- **内部依赖**：`user-profile.js`、`learn-store.js`、`provider.js`
- **外部依赖**：OpenAI SDK（间接，画像生成与事实核查）
- **已知测试路径**：`server/__tests__/adaptive-engine.test.js`、`server/__tests__/user-profile.test.js`、`server/__tests__/fact-checker.test.js`、`server/__tests__/batch6-core.test.js`、`server/__tests__/data-flywheel.test.js`

#### 评估

① 结构：三个子模块（ErrorStateMachine / AdaptivePromptInjector / InterventionRecommender）共存于 `adaptive-engine.js`。`user-profile.js` 独立。`fact-checker.js` 独立（最近重构过，`findClaimLocation` 精确匹配）。

② 逻辑与协议：允许列表（persona types / modes）严格校验。`MIN_BEHAVIOR_SAMPLES = 3` 防止小样本噪声。`sanitize` / `sanitizeList` 防注入。事实/评分路径与个性化路径显式隔离。

③ 测试：覆盖充分（错误状态机、注入器、推荐器、画像更新、事实核查）。`batch6-core.test.js` 30 tests 覆盖飞轮核心。

④ 依赖与副作用：通过 provider 调用 AI。`profileUpdater` 增量更新画像。

⑤ 异味与可维护性：`adaptive-engine.js` 783+ 行混合三个子模块，可拆分。注释中重复的 `=== DATA FLYWHEEL ===` 段落（见文件头部）。

⑥ 风险与改进点：
- **低** `adaptive-engine.js` 文件头部有重复的 `=== DATA FLYWHEEL ===` 注释段（代码异味，非功能缺陷）
- **低** 三子模块可拆分为独立文件（重构项）

状态：`[已评估]`

---

### M6. 试卷与导出引擎（server/engine/exam-engine.js, export-engine.js）

- **路径**：`server/engine/exam-engine.js`（434 行）、`server/engine/export-engine.js`（466 行）
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

- **路径**：`server/engine/learning-analyzer.js`（509 行）
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

- **路径**：`server/routes/learn.js`（625 行）、`content.js`（417 行）、`assessment.js`（307 行）、`export.js`、`flywheel.js`、`settings.js`、`user-profile.js`、`middleware.js`
- **职责**：HTTP 路由、参数校验、SSE 流式响应、错误处理
- **入口方式**：`app.use('/api/learn', router)` 等（在 `server/index.js`）
- **内部依赖**：所有 engine 模块
- **外部依赖**：`express@5`
- **已知测试路径**：`server/__tests__/route-integration.test.js`、`server/__tests__/settings.test.js`、`server/__tests__/user-profile.test.js`

#### 评估

① 结构：按功能拆分路由模块，共享中间件在 `middleware.js`。`learn.js` 625 行偏大。

② 逻辑与协议：CORS 仅允许 localhost。API Key 优先级：`x-api-key` > `req.body.apiKey` > 环境变量。`test-connection` 已修复空字符串校验（P1-7）。SSE 路由使用 `aborted` 标志但无 `AbortController`（见 P0-4）。

③ 测试：路由集成测试覆盖关键路径。Settings API 有独立测试。

④ 依赖与副作用：`express@5.2`。SSE 连接保持期间占用一个连接。

⑤ 异味与可维护性：`learn.js` 单文件 625 行混合计划/知识点/分析/考试/快测/薄弱点/图谱等多类路由。

⑥ 风险与改进点：
- **高** P0-4：SSE 路由客户端断开后无 `AbortController`，provider 调用继续（已登记）
- **中** P1-6：`onError` 回调在 interactive-teacher 已修复，但其他 SSE 路由（detail 生成）的 `onError` 路径未核查（已登记）
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

### M10. 调试与辅助脚本（server/scripts/, server/dbg.mjs, server/_final.mjs）

- **路径**：`server/scripts/check-data-integrity.js`、`clean-backups.js`、`clean-cache.js`、`clean-test-plans.js`、`fix-missing-relations.js`、`server/dbg.mjs`、`server/_final.mjs`
- **职责**：数据完整性检查、清理脚本、关系修复
- **入口方式**：`npm run check:data` / `npm run clean:*`
- **内部依赖**：`learn-store.js`
- **外部依赖**：无
- **已知测试路径**：`server/__tests__/clean-test-plans.test.js`、`server/__tests__/clean-test-plans-entrypoint.test.js`

#### 评估

① 结构：脚本独立，职责清晰。但 `server/dbg.mjs` 和 `server/_final.mjs` 是临时调试/重构脚本，不应留在仓库。

② 逻辑与协议：`clean-test-plans.js` 通过 `test-plan-marker` 识别测试计划，安全删除。`check-data-integrity.js` 支持自动修复。

③ 测试：清理脚本有覆盖。

④ 依赖与副作用：清理脚本只动 `data/` 目录下的测试计划和备份。

⑤ 异味与可维护性：`dbg.mjs`（10 行调试代码）和 `_final.mjs`（重构脚本，已应用过）是死代码。

⑥ 风险与改进点：
- **高** 删除 `server/dbg.mjs`（调试残留，会被 `npm test` 的 `__tests__/*.test.js` glob 忽略，但污染仓库）
- **高** 删除 `server/_final.mjs`（一次性重构脚本，已应用，死代码）

状态：`[已评估]`

---

### M11. 客户端入口与 API（client/src/App.jsx, main.jsx, api.js）

- **路径**：`client/src/App.jsx`、`main.jsx`、`api.js`（468 行）
- **职责**：React 应用入口、路由、API 客户端封装
- **入口方式**：`vite` 启动，`main.jsx` 渲染 `App.jsx`
- **内部依赖**：所有组件
- **外部依赖**：`react@19`、`react-router-dom@7`、`react-helmet-async`
- **已知测试路径**：`client/src/test/api-routing.test.js`

#### 评估

① 结构：`api.js` 468 行封装所有后端调用，按资源分组。使用 HashRouter。

② 逻辑与协议：API Key 通过 `x-api-key` 头传递。SSE 通过 `fetch + ReadableStream` 实现。

③ 测试：API 路由测试覆盖。

④ 依赖与副作用：浏览器 fetch。无本地存储副作用（除设置）。

⑤ 异味与可维护性：`api.js` 468 行偏大，但按资源分块。

⑥ 风险与改进点：无需改进。

状态：`[已评估]`

---

### M12. 客户端组件（client/src/components/）

- **路径**：`PlanView.jsx`（679 行）、`TopicDetail.jsx`（1193 行）、`KnowledgeGraphModal.jsx`（553 行）、`ExamPaperModal.jsx`（491 行）、`PlanList.jsx`（350 行）、`SettingsModal.jsx`（288 行）等 16 个组件
- **职责**：业务 UI 组件
- **入口方式**：`App.jsx` 引用
- **内部依赖**：`ui/` 原子组件、`api.js`、`lib/` 工具
- **外部依赖**：`react`、`recharts`、`mermaid`、`markmap-lib/view`、`lucide-react`
- **已知测试路径**：`client/src/test/*.test.jsx`（9 个测试文件）

#### 评估

① 结构：业务组件 + `ui/` 手写 shadcn 组件。`TopicDetail.jsx` 1193 行偏大。

② 逻辑与协议：使用 React 19 + Hooks。`TopicDetail` 包含生成/配图/TTS/互动/练习/考试多个面板。

③ 测试：`TopicDetail.test.jsx`（9 tests）、`PlanView.test.jsx`（10 tests）等共 88 tests 通过。`act()` 警告存在于 `MermaidDiagram` 和 `TopicDetail`（异步状态更新未包裹 act）。

④ 依赖与副作用：浏览器 DOM。无直接文件系统副作用。

⑤ 异味与可维护性：`TopicDetail.jsx` 1193 行单文件偏大。Lint 警告 43 个（react-hooks/exhaustive-deps 居多）。

⑥ 风险与改进点：
- **中** `TopicDetail.jsx` / `PlanView.jsx` 的 `useEffect` 缺失依赖项（lint 警告，可能导致 stale closure）
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

- **路径**：`lib/mermaid-source.js`、`plan-context.jsx`、`settings-storage.js`、`theme-context.jsx`、`utils.js`、`utils/encoding.js`
- **职责**：Mermaid 源码生成、计划上下文、设置存储、主题上下文、通用工具、编码工具
- **入口方式**：组件引用
- **内部依赖**：无
- **外部依赖**：无
- **已知测试路径**：`client/src/test/mermaid-source.test.js`、`settings-storage.test.js`

#### 评估

① 结构：按职责拆分，清晰。

② 逻辑与协议：`settings-storage.js` 使用 localStorage。`plan-context.jsx` 提供 React context。

③ 测试：Mermaid 源码和设置存储有测试。

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

### M16. 文档（README.md, AGENTS.md, CONTEXT.md, docs/）

- **路径**：`README.md`、`AGENTS.md`、`CONTEXT.md`、`docs/*.md`
- **职责**：项目说明、AI 协作规范、领域术语、审计报告
- **入口方式**：阅读
- **内部依赖**：无
- **外部依赖**：无
- **已知测试路径**：无

#### 评估

① 结构：分层清晰（README 用户文档 / AGENTS AI 规范 / CONTEXT 术语表 / docs 审计报告）。

② 逻辑与协议：AGENTS.md 定义强制规则（分支纪律、提交格式、版本号同步）。

③ 测试：无。

④ 依赖与副作用：无。

⑤ 异味与可维护性：`README.md` 和 `AGENTS.md` 标注版本 v1.9.1，与 `package.json` 的 v1.11.1 不一致。`docs/compose/reports/security-audit.md` 的修复状态需要同步（已修复项未标记完成日期）。

⑥ 风险与改进点：
- **中** 文档版本号不一致：`README.md` / `AGENTS.md` 写 v1.9.1，实际 v1.11.1
- **低** `security-audit.md` 修复状态可补充完成日期

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
| `encodeForRelay` | [缺失待补] P1-5 | [缺失待补] 空字符串 | [缺失待补] 非字符串 | [缺失待补] | [缺失待补] |
| `DiskPrefixCache` | [缺失待补] P1-2 | [缺失待补] 满容量 | [缺失待补] rename EPERM | [缺失待补] | [缺失待补] |
| SSE 流式 detail | [需外部] | [缺失待补] 客户端断开 P0-4 | [已有] aborted 标志 | [已有] | [需外部] |
| SSE 流式 interactive | [需外部] | [缺失待补] 客户端断开 | [已有] onError P1-6 部分 | [已有] | [需外部] |
| 互动会话持久化 | [已有] learn-engine | [缺失待补] 并发覆盖 P1-4 | [已有] 无会话 | [已有] | [已有] |
| 错误状态机 | [已有] adaptive-engine | [已有] 阈值边界 | [已有] 空概念 | [已有] | [已有] |
| 自适应注入器 | [已有] batch6-core | [已有] MIN_BEHAVIOR_SAMPLES | [已有] 无画像 | [已有] | [已有] |
| 学习画像 | [已有] user-profile | [已有] 空计划 | [已有] 损坏 JSON | [已有] | [已有] |
| 事实核查 | [已有] fact-checker | [已有] 无 claim | [已有] provider 错误 | [已有] | [已有] |
| 试卷生成/评分 | [已有] learn-engine | [缺失待补] 大题量 | [已有] provider 错误 | [已有] | [已有] |
| 数据导出 | [已有] engine-additions | [缺失待补] 空计划 | [缺失待补] 损坏数据 | [已有] | [缺失待补] |
| 清理脚本 | [已有] clean-test-plans | [已有] 空目录 | [已有] 损坏索引 | [已有] | [已有] |
| 前端 PlanView | [已有] PlanView.test | [已有] 空计划 | [缺失待补] API 错误 | [已有] | [已有] |
| 前端 TopicDetail | [已有] TopicDetail.test | [已有] 无 detail | [缺失待补] 生成失败 | [已有] | [已有] |
| 前端 KnowledgeGraph | [已有] KnowledgeGraphModal.test | [已有] 空图谱 | [缺失待补] 损坏数据 | [已有] | [已有] |

## 失败分类（基线）

| 测试套件 | 命令 | 退出码 | 通过/失败 | 分类 |
|---|---|---|---|---|
| Server | `npm test --prefix server` | 0 | 517 / 0 | 全部通过 |
| Client | `npm test --prefix client` | 0 | 88 / 0 | 全部通过（有 act() 警告，非失败） |
| Server Lint | `cd server && npx oxlint` | 0 | 100 警告 / 0 错误 | 既有警告 |
| Client Lint | `npm run lint --prefix client` | 0 | 43 警告 / 0 错误 | 既有警告 |
