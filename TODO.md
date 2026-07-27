# TODO — 项目审查与增量改进

> 由审查边界生成。已完成项已归档至 `FINAL_REPORT.md`，本文件仅保留未完成项。
>
> 优先级：H = 高（数据丢失/安全/死代码）；M = 中（功能静默失败/文档不一致）；L = 低（重构/低概率缺陷）。

---

## H-3：修复 P0-4 SSE 客户端断开后 API 调用无取消机制（部分完成）

- **优先级**：H
- **目标**：客户端断开 SSE 连接后，底层 AI API 调用应被取消，避免后台继续消耗 tokens
- **涉及模块/文件**：`server/engine/provider.js`（M2）、`server/routes/content.js`、`server/routes/assessment.js`、`server/routes/learn.js`（M8）
- **已完成部分**：
  1. `provider.js` 的 `complete` / `stream` / `streamWithTools` 方法已接受 `signal` 参数
  2. `server/routes/content.js` 所有 SSE 路由已加 AbortController
  3. `server/routes/assessment.js` exam 路由已加 AbortController
  4. `withStreamTimeout` 已与 signal 协同
- **未完成部分**：验收标准第 4 项"新增单元测试：模拟客户端断开后 provider 不再写入"
- **验收标准**（剩余）：
  1. 新增单元测试：mock OpenAI SDK 验证 `signal` 被透传并在 abort 时抛错
  2. 测试通过
- **验证命令**：`node --test --test-concurrency=1 server/__tests__/provider.test.js`
- **状态**：`[部分完成]`
- **备注**：产品代码修复已落地并运行正常，仅缺测试覆盖。

---

## H-4：修复 P0-3 `writeQueues` Map 内存泄漏（部分完成）

- **优先级**：H
- **目标**：长时间运行的服务器不应在 `writeQueues` Map 中积累已完成 plan 的条目
- **涉及模块/文件**：`server/engine/store/storage.js`、`server/engine/store/crud.js`（M1）
- **已完成部分**：
  1. `storage.js` 的 `enqueueWrite` 完成后通过 `writeQueues.delete(planId)` 清理条目
  2. 保留 `drainWriteQueue` 作为强制清空
  3. 场景 2（并发串行化）已有测试覆盖
- **未完成部分**：验收标准第 4 项场景 1"多次写入完成后 writeQueues.size 回到 0"的单元测试
- **验收标准**（剩余）：
  1. 新增单元测试：显式断言 `writeQueues.size === 0` after 多次 enqueueWrite 完成
  2. 测试通过
- **验证命令**：`node --test --test-concurrency=1 server/__tests__/storage-logic.test.js`
- **状态**：`[部分完成]`
- **备注**：产品代码修复已落地，仅缺 size 回归测试。

---

## M-1：修复 P1-2 `DiskPrefixCache.flush` 的 `renameSync` 无 EPERM 保护（部分完成）

- **优先级**：M
- **目标**：Windows 下 `renameSync` 失败时降级为 copy + unlink，与 `writeAtomic` 行为一致
- **涉及模块/文件**：`server/engine/provider.js`（M2，约 159 行）
- **已完成部分**：`provider.js` 第 162-168 行已实现 EPERM 降级（copyFileSync + unlinkSync）
- **未完成部分**：验收标准第 3 项"新增单元测试：mock renameSync 抛 EPERM，验证降级路径被触发且 _dirty 被正确重置"
- **验收标准**（剩余）：
  1. 新增单元测试：mock `fs.renameSync` 抛 EPERM，验证 copy 降级路径被触发且 `_dirty` 被正确重置
  2. 测试通过
- **验证命令**：`node --test --test-concurrency=1 server/__tests__/provider.test.js`
- **状态**：`[部分完成]`
- **备注**：产品代码修复已落地，仅缺测试覆盖。

---

## M-5：修复 P1-3 `writePlan` 中 `updateIndex` 失败时的索引一致性（部分完成）

- **优先级**：M
- **目标**：`writeAtomic` 成功但 `updateIndex` 失败时，索引应能从磁盘重建或记录告警
- **涉及模块/文件**：`server/engine/store/crud.js`（M1，约 1153-1170 行）
- **已完成部分**：`crud.js` 第 1168-1170 行已加 try-catch 与 warn 日志
- **未完成部分**：验收标准第 3 项"新增测试：mock updateIndex 抛错，验证 writePlan 不抛、plan 文件已写入"
- **验收标准**（剩余）：
  1. 新增测试：mock `updateIndex` 抛错，验证 `writePlan` 不抛、plan 文件已写入
  2. 测试通过
- **验证命令**：`node --test --test-concurrency=1 server/__tests__/storage-logic.test.js`
- **状态**：`[部分完成]`
- **备注**：产品代码修复已落地，仅缺测试覆盖。

---

## L-3：修复 `TopicDetail.jsx` / `PlanView.jsx` 的 `useEffect` 依赖项 lint 警告（未完成）

- **优先级**：L
- **目标**：消除 react-hooks/exhaustive-deps 警告，避免 stale closure
- **涉及模块/文件**：`client/src/components/TopicDetail.jsx`、`client/src/components/PlanView.jsx`（M12）
- **已完成部分**：在 `TopicDetail.jsx` 的 7 个有意限定依赖的 effect 上方加了 NOTE 注释，表达设计意图
- **未完成部分**：验收标准第 1 项"lint 警告数 ≤ 30"
- **实际状态**：lint 警告数仍为 43（与改动前相同）
- **阻塞原因**：oxlint 1.75.0 不识别 `eslint-disable-next-line` 针对此规则的指令；强行补依赖会引入循环或意外重渲染
- **验收标准**（剩余）：
  1. `npm run lint --prefix client` 警告数 ≤ 30（当前 43）
  2. 现有客户端测试全部通过
- **验证命令**：`npm run lint --prefix client && npm test --prefix client`
- **状态**：`[未完成]`
- **后续建议**：
  1. 等 oxlint 后续版本支持 disable 指令后重新评估
  2. 或立项重构 effect 用 `useRef` + `useCallback` 包裹变量（工作量较大，需独立任务）

---

## 总结

| 优先级 | 总数 | 已完成 | 部分完成 | 未完成 | ID |
|---|---|---|---|---|---|
| H | 4 | 2 | 2 | 0 | H-3, H-4 部分完成 |
| M | 5 | 3 | 2 | 0 | M-1, M-5 部分完成 |
| L | 3 | 2 | 0 | 1 | L-3 未完成 |
| **合计** | **12** | **7** | **4** | **1** | |

> 已完成的 7 项证据已归档至 `FINAL_REPORT.md`。本文件仅保留 5 项未完成/部分完成项。
