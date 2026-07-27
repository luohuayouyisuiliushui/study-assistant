# TODO — 项目审查与增量改进

> 由审查边界生成。所有任务初始状态为 `[待处理]`。实施边界按 ID 顺序逐项执行。
>
> 优先级：H = 高（数据丢失/安全/死代码）；M = 中（功能静默失败/文档不一致）；L = 低（重构/低概率缺陷）。

---

## H-1：删除 `server/dbg.mjs` 调试残留

- **优先级**：H
- **目标**：移除仓库中的临时调试脚本
- **涉及模块/文件**：`server/dbg.mjs`（M10）
- **预期改动范围**：删除单文件
- **验收标准**：
  1. `server/dbg.mjs` 不存在
  2. `git status` 显示该文件被删除
  3. `npm test --prefix server` 退出码 0，测试通过数 ≥ 517
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`

---

## H-2：删除 `server/_final.mjs` 一次性重构脚本

- **优先级**：H
- **目标**：移除已应用过的一次性重构脚本（死代码）
- **涉及模块/文件**：`server/_final.mjs`（M10）
- **预期改动范围**：删除单文件
- **验收标准**：
  1. `server/_final.mjs` 不存在
  2. `git status` 显示该文件被删除
  3. `npm test --prefix server` 退出码 0，测试通过数 ≥ 517
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`

---

## H-3：修复 P0-4 SSE 客户端断开后 API 调用无取消机制

- **优先级**：H
- **目标**：客户端断开 SSE 连接后，底层 AI API 调用应被取消，避免后台继续消耗 tokens
- **涉及模块/文件**：`server/engine/provider.js`（M2）、`server/routes/content.js`、`server/routes/assessment.js`、`server/routes/learn.js`（M8）
- **预期改动范围**：
  1. `provider.js` 的 `stream` / `complete` 方法接受 `signal: AbortSignal` 选项，并透传给 OpenAI SDK 的 `fetch`
  2. SSE 路由在 `res.on('close')` 中调用 `controller.abort()`
  3. `withStreamTimeout` 与 signal 协同（Promise.race）
- **验收标准**：
  1. `provider.js` 中 `grep -n "signal\|AbortController"` 有匹配
  2. SSE 路由中 `grep -n "AbortController\|controller.abort"` 有匹配
  3. 现有测试全部通过（Server ≥ 517，Client ≥ 88）
  4. 新增单元测试：模拟客户端断开后 provider 不再写入（用 mock provider 验证 signal 被传递）
- **验证命令**：`npm test --prefix server && npm test --prefix client`
- **状态**：`[待处理]`
- **备注**：架构级改动，三层联动（路由 → provider → fetch）。按 AGENTS.md 应在独立分支。

---

## H-4：修复 P0-3 `writeQueues` Map 内存泄漏

- **优先级**：H
- **目标**：长时间运行的服务器不应在 `writeQueues` Map 中积累已完成 plan 的条目
- **涉及模块/文件**：`server/engine/store/storage.js`、`server/engine/store/crud.js`（M1）
- **预期改动范围**：
  1. `enqueueWrite` 完成后，若队列长度为 1（无后续排队），清理 Map 条目
  2. 保留 `drainWriteQueue` 作为删除前的强制清空
  3. 不能用 TTL 自动清理（会断裂 Promise 链）
- **验收标准**：
  1. 模拟同一 plan 多次写入完成后，`writeQueues.size` 回到 0
  2. 模拟并发写入时，`writeQueues` 仍正确串行化
  3. 现有测试全部通过
  4. 新增单元测试覆盖上述两个场景
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`
- **备注**：架构级改动。security-audit.md 已分析过陷阱（不能用 TTL）。

---

## M-1：修复 P1-2 `DiskPrefixCache.flush` 的 `renameSync` 无 EPERM 保护

- **优先级**：M
- **目标**：Windows 下 `renameSync` 失败时降级为 copy + unlink，与 `writeAtomic` 行为一致
- **涉及模块/文件**：`server/engine/provider.js`（M2，约 159 行）
- **预期改动范围**：在 `flush` 方法中包 try-catch，rename 失败时 `copyFileSync + unlinkSync`（unlink 失败安全忽略）
- **验收标准**：
  1. `provider.js` 中 `flush` 方法有 copy 降级逻辑
  2. 现有测试全部通过
  3. 新增单元测试：mock `renameSync` 抛 EPERM，验证降级路径被触发且 `_dirty` 被正确重置
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`

---

## M-2：补充 P1-5 `encodeForRelay` 测试

- **优先级**：M
- **目标**：为 `encodeForRelay` 函数补充单元测试，覆盖正常/边界/异常场景
- **涉及模块/文件**：`server/__tests__/provider.test.js`（新增测试，可能需要先 export `encodeForRelay`）
- **预期改动范围**：
  1. 在 `provider.js` 中 export `encodeForRelay`（若未 export）
  2. 新增测试：正常输入（含 `<>'"` 全部替换）、空字符串、无特殊字符、纯特殊字符、混合中英文
- **验收标准**：
  1. `provider.test.js` 中有 `describe('encodeForRelay', ...)` 块
  2. 至少 5 个测试用例覆盖正常/边界/异常
  3. 所有测试通过
- **验证命令**：`node --test --test-concurrency=1 server/__tests__/provider.test.js`
- **状态**：`[待处理]`

---

## M-3：同步文档版本号

- **优先级**：M
- **目标**：`README.md` 和 `AGENTS.md` 中标注的版本号与 `package.json` 一致
- **涉及模块/文件**：`README.md`、`AGENTS.md`（M16）
- **预期改动范围**：将 `v1.9.1` 改为 `v1.11.1`（共 2 处：README 标题、AGENTS 项目架构注释）
- **验收标准**：
  1. `grep -n "v1\.9\.1\|1\.9\.1"` 在 `README.md` 和 `AGENTS.md` 中无匹配
  2. `grep -n "1\.11\.1"` 在两文件中各有 1 处匹配
  3. 结构化走读：正向（版本号一致）+ 反向（无遗漏的旧版本号）
- **验证命令**：`grep -n "1\.9\.1\|1\.11\.1" README.md AGENTS.md`
- **状态**：`[待处理]`

---

## M-4：验证并补全 P1-6 其他 SSE 路由的 `onError` 调用路径

- **优先级**：M
- **目标**：核查 detail 生成 / 流式追问等 SSE 路由的 `onError` 回调是否被正确触发，避免客户端收不到错误事件
- **涉及模块/文件**：`server/engine/learn-engine.js`（M3）、`server/routes/content.js`（M8）
- **预期改动范围**：
  1. 走读 `streamDetail` 等函数的 catch 块，确认 `onError` 被调用
  2. 路由层加 `isHeaderSent` 标志区分 SSE 错误 vs JSON 500
  3. 若已正确则仅补测试，否则补修复
- **验收标准**：
  1. 走读记录列出每个 SSE 路由的 onError 调用状态
  2. 现有测试全部通过
  3. 若发现未调用的路径，新增测试覆盖
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`
- **备注**：可能核查后发现无需修复，仅补测试。

---

## M-5：修复 P1-3 `writePlan` 中 `updateIndex` 失败时的索引一致性

- **优先级**：M
- **目标**：`writeAtomic` 成功但 `updateIndex` 失败时，索引应能从磁盘重建或记录告警
- **涉及模块/文件**：`server/engine/store/crud.js`（M1，约 1153-1170 行）
- **预期改动范围**：
  1. `writePlan` 中 `updateIndex` 包 try-catch
  2. 失败时记录 warn 日志（不阻断主流程，因为 plan 文件已成功写入）
  3. 下次 `readIndex` 会从磁盘重建（已有 fallback）
- **验收标准**：
  1. `writePlan` 中 `updateIndex` 有 try-catch
  2. 现有测试全部通过
  3. 新增测试：mock `updateIndex` 抛错，验证 `writePlan` 不抛、plan 文件已写入
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`

---

## L-1：修复 P1-4 `interactiveSession` 并发覆盖风险

- **优先级**：L
- **目标**：避免快速点击导致互动会话状态被覆盖
- **涉及模块/文件**：`server/engine/interactive-teacher.js`（M4）、`server/engine/store/crud.js`（M1）
- **预期改动范围**：
  1. `interactiveSession` 写入通过 `writePlan` 而非 `updateTopic`（确保串行化）
  2. 或在 `updateTopic` 中加乐观锁（version 字段）
- **验收标准**：
  1. 模拟并发 continue 调用，会话状态不丢失
  2. 现有测试全部通过
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`
- **备注**：低概率缺陷，security-audit.md 标注"可暂缓"。

---

## L-2：清理 `adaptive-engine.js` 头部重复注释

- **优先级**：L
- **目标**：移除文件头部重复的 `=== DATA FLYWHEEL ===` 段落
- **涉及模块/文件**：`server/engine/adaptive-engine.js`（M5，约 1-30 行）
- **预期改动范围**：删除重复段落，保留一份
- **验收标准**：
  1. `adaptive-engine.js` 头部 `DATA FLYWHEEL` 注释只出现一次
  2. 现有测试全部通过
- **验证命令**：`npm test --prefix server`
- **状态**：`[待处理]`

---

## L-3：修复 `TopicDetail.jsx` / `PlanView.jsx` 的 `useEffect` 依赖项 lint 警告

- **优先级**：L
- **目标**：消除 react-hooks/exhaustive-deps 警告，避免 stale closure
- **涉及模块/文件**：`client/src/components/TopicDetail.jsx`、`client/src/components/PlanView.jsx`（M12）
- **预期改动范围**：补全 `useEffect` 依赖数组，或使用 `useCallback` 稳定引用
- **验收标准**：
  1. `npm run lint --prefix client` 警告数 ≤ 30（当前 43，目标减少 ≥ 13）
  2. 现有客户端测试全部通过
  3. 手动验证关键路径（生成/刷新/互动）无回归
- **验证命令**：`npm run lint --prefix client && npm test --prefix client`
- **状态**：`[待处理]`
- **备注**：lint 警告非错误，但部分可能掩盖真实 bug。

---

## 总结

| 优先级 | 数量 | ID |
|---|---|---|
| H | 4 | H-1, H-2, H-3, H-4 |
| M | 5 | M-1, M-2, M-3, M-4, M-5 |
| L | 3 | L-1, L-2, L-3 |
| **合计** | **12** | |
