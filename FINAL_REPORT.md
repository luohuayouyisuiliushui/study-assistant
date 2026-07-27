# FINAL_REPORT - 项目审查与增量改进

> 依据 `C:\.a\提示词\审查并修改项目.txt` 第 11 步终检归档。
> 原始终检分支：`codex/fix-review-followups`；原始验收版本：`1.12.3`。
> 当前发布版本：[`v1.14.0`](https://github.com/luohuayouyisuiliushui/study-assistant/releases/tag/v1.14.0)；复核日期：2026-07-27。

## v1.14.0 发布补充

`v1.14.0` 在 `v1.13.2` 稳定性基线上完成可视化与学习画像升级：

| 范围 | 当前实现 | 回归证据 |
|---|---|---|
| 知识图谱 | 近全屏画布；大型图谱自动聚合为主题骨架；支持完整视图、横/纵布局、缩放平移、适应视图、关系筛选、节点高亮和 JSON/SVG/PNG/Markdown 导出 | `KnowledgeGraphModal.test.jsx`、`knowledge-graph-layout.test.js`；真实页面验证 13/64 切换与节点选中 |
| 思维导图 | 近全屏查看与适应视图；提供真实 Markdown、SVG、PNG、结构化 JSON、OPML 导出 | `MindMapModal.test.jsx`；真实 OPML 下载文件名验证 |
| 学习画像 | 总时长、近 7/30 天、日均与峰值统一显示小时/分钟；提问风格按真实问题分类；画像增加可信度、样本量、活跃日和行为证据 | `UserProfile.test.jsx`、`user-profile.test.js`；桌面/移动端画像检查 |
| 菜单可用性 | 修复计划概览容器裁剪“更多操作”菜单的问题 | 桌面 Playwright 手动检查 |

版本发布证据：三个 `package.json` 均为 `1.14.0`；数据完整性检查通过；本次发布未引入依赖变更。

## v1.13.2 发布补充

原始 12 项终检任务继续保持完成。在该基线上，`v1.13.1` 纳入以下用户可见改进；`v1.13.2` 进一步同步全部发布文档与当前证据：

| 范围 | 当前实现 | 回归证据 |
|---|---|---|
| 图片与图表 | `MediaViewer` 支持全屏、缩放、拖动、旋转、翻转、Mermaid 源码编辑及 SVG/位图保存 | `MediaViewer.test.jsx`、`MermaidDiagram.test.jsx` |
| Mermaid 稳定性 | 首次进入视口时渲染；源码变化后等待用户点击重绘，不再自动反复渲染 | `MermaidDiagram.test.jsx` |
| 资源推荐 | 兼容 JSON 围栏/说明文字，截断或无效响应自动精简重试；Server 60 秒、Client 65 秒超时并取消上游请求 | `engine-additions.test.js`、`api.test.js`、`TopicDetail.test.jsx` |
| 失败恢复 | 推荐失败或超时后清除 loading 状态，允许再次请求；空缓存列表仍显示“推荐资源” | `TopicDetail.test.jsx` |
| 悬浮导航 | 鼠标靠近顶部才显示，离开延迟收起；触屏设备保持可操作 | `TopicDetail.test.jsx` + 桌面/移动端 Playwright 手动检查 |

版本发布证据：三个 `package.json` 均为 `1.13.2`；前序功能版 `v1.13.1` 指向版本校正提交 `281205e`，本次文档同步提交作为 `v1.13.2` 的 tag 与 GitHub Latest Release 目标。

## 当前验证基线（v1.14.0）

| 套件 | 结果 |
|---|---|
| Server | 540 pass / 0 fail |
| Client | 16 个测试文件，112 pass / 0 fail |
| Client lint | 0 errors / 27 warnings |
| Server lint | 0 errors / 105 warnings |
| Client build | Vite production build success |
| 数据完整性 | `npm run check:data --prefix server` 通过 |
| UI 验证 | Playwright 桌面与移动端关键交互、图谱切换/高亮及导出通过 |

Playwright 检查为发布前手动验证，仓库尚未保存独立 E2E 套件。需要真实付费 API 的生成链路仍受下文“端到端验证”限制约束。

## 原始任务总览（v1.12.3）

| 项目 | 数量 |
|---|---:|
| 审查任务总数 | 12 |
| 验收标准全部满足 | 12 |
| 因用户改动保护跳过 | 0 |
| 未完成 | 0 |

Reasonix 在本会话中不可用，按提示词约定使用本地 PowerShell、Git、ripgrep、Node Test Runner、Vitest 和 Playwright 完成验证。用户要求 SOLO Agent，本次未使用子 Agent。

## 原始终检任务证据

### H-1：删除 `server/dbg.mjs`

- **改动文件与摘要**：`server/dbg.mjs` 已在 `ae8914b` 删除。
- **验证**：`Test-Path server\dbg.mjs` -> `False`，退出码 0。
- **测试结果**：Server 全量测试 536/536 通过。
- **遗留风险**：无。

### H-2：删除 `server/_final.mjs`

- **改动文件与摘要**：`server/_final.mjs` 已在 `ae8914b` 删除。
- **验证**：`Test-Path server\_final.mjs` -> `False`，退出码 0。
- **测试结果**：Server 全量测试 536/536 通过。
- **遗留风险**：无。

### H-3：SSE 客户端断开后取消底层 AI 请求

- **改动文件与摘要**：
  - `server/engine/provider.js`：`complete`、`stream`、`streamWithTools` 将 `AbortSignal` 传给 SDK；流读取在 abort 后停止分发 chunk。
  - `server/routes/content.js`、`server/routes/assessment.js`、`server/engine/exam-engine.js`：SSE 关闭事件连接到 `AbortController`。
  - `server/__tests__/provider.test.js`：新增 5 个回归测试，覆盖三个 provider 入口、预先 abort 和流中 abort。
- **验证**：`rg -c "opts\.signal" server/engine/provider.js` -> 15；content/assessment 共匹配 8 处 controller 创建或 abort。
- **测试结果**：`node --test --test-concurrency=1 --test-force-exit __tests__/provider.test.js` -> 57 pass / 0 fail；流中 abort 后 `onChunk` 仅收到 abort 前内容。
- **遗留风险**：真实上游供应商是否立即停止计费取决于其对 HTTP abort 的实现；本地 SDK 透传与停止回调已锁定。

### H-4：清理 `writeQueues` 已完成条目

- **改动文件与摘要**：
  - `server/engine/store/storage.js`：成功或失败的最后一个写任务 settled 后删除对应 Map 条目，并导出 `writeQueues` 供回归测试观察。
  - `server/__tests__/storage-logic.test.js`：新增单次和同一 plan 多次排队测试。
- **验证**：测试在执行前及完成后均显式断言 `writeQueues.size === 0`；原有串行顺序测试继续通过。
- **测试结果**：`node --test --test-concurrency=1 --test-force-exit __tests__/storage-logic.test.js` -> 17 pass / 0 fail。
- **遗留风险**：`writeQueues` 导出扩大了内部可观察面，但未从 `learn-store.js` barrel 对外暴露。

### M-1：`DiskPrefixCache.flush` 的 Windows EPERM 降级

- **改动文件与摘要**：
  - `server/engine/provider.js`：rename 失败后使用 copy + unlink；仅在成功持久化后清除 `_dirty`；导出 `DiskPrefixCache` 作为测试 seam。
  - `server/__tests__/provider.test.js`：mock `renameSync` 抛 EPERM，验证 copy、unlink、文件内容和 `_dirty`；另覆盖 fallback 也失败的非致命路径。
- **测试结果**：Provider 定向测试 57 pass / 0 fail。
- **验证限制**：测试使用独立的系统临时目录并在 finally 中清理；没有操作项目数据目录。
- **遗留风险**：copy fallback 非原子，这是 Windows rename 不可用时的有意降级。

### M-2：补充 `encodeForRelay` 测试

- **改动文件与摘要**：`server/engine/provider.js` 导出函数；`server/__tests__/provider.test.js` 新增 7 个用例。
- **覆盖**：尖括号、单双引号、普通文本、空字符串、代码片段、中文混合和幂等性，满足至少 5 个用例的标准。
- **测试结果**：Provider 定向测试 57 pass / 0 fail。
- **遗留风险**：无。

### M-3：同步项目版本号

- **改动文件与摘要**：根、server、client 三个 `package.json` 和 `README.md` 同步为 `1.12.3`；被 `.gitignore` 忽略的本地 `AGENTS.md` 架构注释也同步为 `v1.12.3`，不进入提交。
- **验证**：三个 package 的 `version` 均为 `1.12.3`，README 第一行为 `Study Assistant v1.12.3`。
- **遗留风险**：三个历史 `package-lock.json` 的根版本字段仍为 `1.9.1`；仓库规则仅要求三个 `package.json` 同步，本次未机械改锁文件。

### M-4：核查 SSE 错误回调路径

- **改动文件与摘要**：无需新增产品改动；已走读 SSE 路由 catch/finally 路径，错误会通过 `onError` 或 SSE error event 返回。
- **验证**：H-3 的 abort 测试和 Server 全量 536 项测试通过。
- **验证限制**：未使用真实收费 AI API 制造上游错误。
- **遗留风险**：不同供应商的非标准流错误仍依赖 provider 的通用异常映射。

### M-5：`writePlan` 容忍异步索引更新失败

- **改动文件与摘要**：
  - `server/engine/store/crud.js`：队列回调改为 async，并 `await updateIndexFn(...)`，确保 Promise rejection 落入非致命 catch；第三参数允许测试注入 updater，现有两参数调用不变。
  - `server/__tests__/storage-logic.test.js`：注入异步 reject 的 updater，验证调用一次、告警产生、`writePlan` 不抛且有效 plan 已持久化。
- **红灯证据**：修复前新测试失败，`updateIndexCalls` 为 0；旧测试通过 `topics = undefined` 触发的是同步 TypeError，不能代表真实异步失败。
- **绿灯证据**：修复后 Storage 定向测试 17 pass / 0 fail；`rg` 命中 `await updateIndexFn` 与非致命告警。
- **遗留风险**：索引写失败后仍需后续 `rebuildIndex()` 对账，这是原设计的最终一致性策略。

### L-1：阻止 `interactiveSession` 并发覆盖

- **改动文件与摘要**：`server/engine/interactive-teacher.js` 在 continue 入口拒绝 `ai_thinking` 状态的并发请求。
- **验证**：`rg -n "ai_thinking"` 命中入口 guard；Server 全量测试 536/536 通过。
- **遗留风险**：保护点位于 continue 入口，其他新入口未来需要复用同一状态约束。

### L-2：清理 `adaptive-engine.js` 重复头部注释

- **改动文件与摘要**：移除重复的 DATA FLYWHEEL JSDoc。
- **验证**：读取文件前 45 行，`DATA FLYWHEEL` 仅出现一次。
- **遗留风险**：文件正文中的术语引用不属于重复头部。

### L-3：将 Client lint 警告降至阈值内

- **改动文件与摘要**：
  - `client/src/components/TopicDetail.jsx`：删除未使用图标/组件、未使用错误标签、死函数、未消费的 AbortController、只写 state 和无效 session 同步 effect。
  - `client/src/components/MindMapModal.jsx`、`client/src/components/SettingsModal.jsx`：移除只写 state，保留实际局部映射和保存行为。
  - 保留前序提交中对刻意限定依赖 effect 的 NOTE，未盲目补依赖导致重复请求。
- **验证**：`npx oxlint --format json` -> 0 errors / 29 warnings，较基线 43 减少 14，满足 `<= 30`；分类为 no-unused-vars 13、exhaustive-deps 12、only-export-components 4。
- **测试结果**：Client 13 个文件、97 项测试全部通过；Vite 生产构建通过。
- **遗留风险**：仍有 12 个 exhaustive-deps 告警。冻结的量化验收已满足，但这些 effect 的闭包约束需要在后续逐个重构，不能据此声称所有 stale-closure 风险已消失。

## 原始终检全量验证（v1.12.3）

| 套件 | 命令 | 结果 | 退出码 |
|---|---|---|---:|
| 预清理 | `npm run pretest` | candidates=0；基线 index=2 / disk=2 | 0 |
| Server | `npm test --prefix server` | 536 pass / 0 fail / 0 skipped | 0 |
| Client | `npm test --prefix client` | 13 files，97 pass / 0 fail | 0 |
| Client lint | `npx oxlint --format json` | 0 errors / 29 warnings | 0 |
| Client build | `npm run build --prefix client` | Vite build success | 0 |

Server `posttest` 删除了 18 个带测试标记的 fixture。其即时 consistency 行曾显示 20/20；测试进程完全结束后独立读取 `plans.json` 和 `data/learn/plans/` 均为 2，和 pretest 基线一致。未删除任何无法证明来源的对象。

## 原始终检端到端验证（v1.12.3）

- **环境**：当前分支 server `http://127.0.0.1:3001`，client `http://127.0.0.1:5173`。
- **场景**：GET 计划 API -> 打开首页 -> 进入“Linux 网络编程核心” -> 打开“TCP 服务端创建流程”详情。
- **实际结果**：API 200、计划数 2、详情标题和“一句话概括”可见、浏览器 console/page error 均为空。
- **截图**：`%TEMP%\study-assistant-review-e2e.png`。
- **限制**：界面未配置 API Key，因此未执行会消耗 tokens 的知识生成、互动教学和考试生成；这些路径不能记为 E2E 通过，相关本地逻辑由自动化测试覆盖。

## 原始终检依赖审计

| 工作区 | 结果 | 详情 |
|---|---|---|
| Root | 2 high，退出码 1 | direct `concurrently`；transitive `shell-quote`（ReDoS） |
| Server | 0 vulnerabilities，退出码 0 | 无 |
| Client | 3 high + 1 low，退出码 1 | `react-router-dom`/`react-router`、`postcss`、`dompurify` |

审计基于现有 lockfile。依赖声明属于共享文件，且本任务没有引入依赖；未在本任务中执行自动升级。应单独建立依赖升级任务，更新 lockfile 后重新审计和回归。

## 原始终检工作区基线变更

本次继续工作涉及 14 个 tracked 文件：

- 产品代码：`server/engine/provider.js`、`server/engine/store/storage.js`、`server/engine/store/crud.js`、`client/src/components/TopicDetail.jsx`、`client/src/components/MindMapModal.jsx`、`client/src/components/SettingsModal.jsx`
- 测试：`server/__tests__/provider.test.js`、`server/__tests__/storage-logic.test.js`
- 版本与文档：根/server/client `package.json`、`README.md`、`TODO.md`、`FINAL_REPORT.md`
- 本地忽略文件：`AGENTS.md` 仅同步版本注释，不进入 Git 提交

完整审查历史还包括提交 `ae8914b`、`b66360b`、`af7b03f` 和 `fae783e` 中的路由、引擎、删除脚本及初次归档改动。

## 用户改动保护记录

开始继续任务时已存在以下未跟踪文件，本次未修改、未删除、未暂存：

- `server/engine/store/crud-content.js`
- `server/engine/store/crud-exercises.js`
- `server/engine/store/crud-flags.js`
- `server/engine/store/crud-graph.js`
- `server/engine/store/crud-plans.js`
- `server/engine/store/crud-trash.js`
- `现存问题.md`

同事留下的 tracked 改动已由用户明确要求继续，本次在其最新内容上修正测试假绿、异步错误处理和终检证据，没有回退其他人的内容。

## 改善建议

1. 单独处理依赖审计：升级 `concurrently`、React Router 相关锁定版本、`postcss` 和 `dompurify`，再跑完整回归。
2. 为剩余 12 个 exhaustive-deps 告警逐个建立行为测试，再用 callback/ref 或拆分 effect 消除，不要批量补依赖。
3. 在具备专用测试 API Key 的环境补跑生成知识点、互动教学和考试三条 AI E2E 路径，并记录 token 成本与 abort 行为。

## 原始终检关键指标（v1.12.3）

- 完成任务：12/12
- 当前续作新增回归测试：10（H-3 5、H-4 2、M-1 2、M-5 1）
- 审查任务相关测试总数：17（本次续作 10 + M-2 既有 7）
- 全量通过率：536/536 Server + 97/97 Client
- Lint：0 errors，29 warnings（43 -> 29）
- 未完成 TODO：0

当前 `v1.14.0` 指标以本文顶部“当前验证基线”为准；原始数字保留用于证明当时验收，不代表最新测试总数。
