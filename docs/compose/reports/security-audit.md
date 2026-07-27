# 毁灭性测试报告 — study-assistant 数据持久层审计

**审计时间**: 2026-07-10
**复核时间**: 2026-07-27
**适用版本**: `v1.13.2`
**审计范围**: `server/engine/store/crud.js`, `server/engine/provider.js`, `server/routes/learn.js`
**审计重点**: 原子写入、Windows 兼容性、SSE 资源泄漏、测试覆盖缺口

> 本文的文件行号和“修复前”代码块保留自 2026-07-10 原始审计，用于说明问题来源，不代表当前源码位置。2026-07-27 已逐项复核：11 项均已修复、由测试覆盖或按正确持久化语义关闭，当前无待修复项。

---

## P0 — 数据丢失/服务崩溃

### P0-1: `writeAtomic` 无 EPERM 保护（Windows 数据丢失风险）

**文件**: `server/engine/store/crud.js:42`

```js
fs.renameSync(tmp, filePath);  // ← 无 try-catch，Windows 下可能 EPERM
```

**问题**: Windows 上 `renameSync` 在目标文件被其他进程打开时抛出 `EPERM`。此异常会向上传播，导致：
1. 临时文件 `.tmp.{pid}` 残留
2. 如果这是 `writePlan` 内的调用（line 1161），整个 Promise 链中断
3. 后续对该 plan 的写入全部失败（Promise 链卡死）

**影响**: 用户正在学习的知识点内容丢失，前端无法再保存任何对该 plan 的修改。

**~~原始修复建议~~**: 在 `renameSync` 外包 try-catch，失败时降级为 `copyFileSync + unlinkSync`。

**⚠️ 预审发现的陷阱**: 简单的 copy+unlink 降级在 Windows 上会引入"幽灵文件"问题——copyFileSync 成功后，如果 unlinkSync 再次 EPERM（源文件仍被占用），磁盘上会同时存在目标文件和临时文件，且旧文件永远没人清理。

**✅ 安全修复方案**: copy + unlink 降级，但 unlink 失败时捕获并忽略（不阻断数据写入），记录日志即可。临时文件会在下次写入时被覆盖，不构成数据风险。

**状态**: ✅ 已修复并于 2026-07-27 复核 — `writeAtomic` 在 rename 失败时降级为 copy，unlink 失败安全忽略。

```js
// 修复后
try {
  fs.renameSync(tmp, filePath);
} catch (renameErr) {
  try {
    fs.copyFileSync(tmp, filePath);
  } catch (copyErr) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`writeAtomic failed: rename=${renameErr.message}, copy=${copyErr.message}`);
  }
  try { fs.unlinkSync(tmp); } catch {} // unlink 失败不阻断
}
```

---

### P0-2: `trashPlan` 的 rename 失败降级为删除（数据丢失）

**文件**: `server/engine/store/crud.js:338-341`

```js
} catch (err) {
  console.warn(`[learn-store] Failed to move plan to trash: ${err.message}`);
  // Fall back to deleting the file  ← 数据直接删除！
  try { fs.unlinkSync(src); } catch {}
}
```

**问题**: 如果 `renameSync` 失败（Windows EPERM），代码直接删除原文件。用户点击"删除"期望进入回收站，但文件被永久删除，无法恢复。

**影响**: 用户数据永久丢失，且没有任何备份路径（`.bak` 此时是旧版本）。

**✅ 安全修复方案**: 直接去掉 unlink 降级，rename 失败时抛出错误让用户知道删除未完成。保留原文件比误删安全。

**状态**: ✅ 已修复并于 2026-07-27 复核 — `trashPlan` 在 rename 失败时抛出错误，不再降级删除。

---

### P0-3: `writeQueues` 内存泄漏

**文件**: `server/engine/store/crud.js:68`

```js
const writeQueues = new Map(); // planId → Promise chain
```

**问题**: Map 条目只在 `permanentlyDeletePlan`（line 248）和 `trashPlan`（line 308）时删除。正常使用中（创建 plan → 添加知识点 → 学习），每个 plan 的条目永远不清理。长时间运行的服务器（days/weeks）会积累大量条目。

**影响**: 单个 Map 条目很小，但 thousands of plans 时会有显著内存压力。更严重的是，旧 plan 的 Promise 链引用会阻止这些 plan 对象被 GC。

**~~原始修复建议~~**: 在 `enqueueWrite` 中设置 TTL 或使用 WeakRef，定期清理已完成的队列。

**⚠️ 预审发现的陷阱**: writeQueues 本质是串行化锁（Per-plan Mutex）。用 TTL 自动清理正在排队但尚未执行的写操作会导致 Promise 链断裂，后续写操作丢失。

**安全修复方案**: 不使用 TTL。为每次写入保存当前 Promise，在其 settled 时仅当 Map 仍指向该 Promise 才删除；若已有更新写入排队，则由更新 Promise 在最终 settled 时负责清理。删除/回收路径仍先 drain 队列。

**状态**: ✅ 已修复 — `enqueueWrite` 在最后一个排队 Promise settled 后按 Promise 身份删除 Map 条目，不会误删同一 plan 的新队列；`storage-logic.test.js` 覆盖单次与连续写入后 `writeQueues.size === 0`。

---

### P0-4: `provider.stream()` 客户端断开后 API 调用继续消耗 tokens

**文件**: `server/engine/provider.js:722`, `server/routes/learn.js:556`

```js
// 路由层：
res.on('close', () => { aborted = true; if (idleTimer) clearTimeout(idleTimer); });
// 但 provider 调用继续：
await streamInteractiveStart(provider, plan, ...);  // ← 无取消机制
```

**问题**: 客户端断开 SSE 连接后，`aborted = true` 阻止向 response 写入，但底层 AI API 调用仍在进行。`withStreamTimeout` 的 120 秒超时是唯一的终止机制。

**影响**:
- 每次客户端刷新页面，后台 AI 调用继续消耗 2-5 秒的 API tokens
- 并发刷新 10 次 = 10 个并行 API 调用在后台运行
- 长时间运行的生成（如组卷 50 题）会在客户端离开后继续消耗大量 tokens

**~~原始修复建议~~**: 在 `res.on('close')` 中设置 AbortController 并传入 provider。

**⚠️ 预审发现的陷阱**: Provider 底层调用 OpenAI SDK，SDK 的 request 支持 signal，但 provider.js 没有把 signal 透传给底层 fetch。只在路由层 abort() 而 provider 不接信号 = 修复无效。

**安全修复方案**: 三层联动——路由层创建并传入 AbortSignal → Provider 三个调用入口把 signal 交给 OpenAI SDK → 流读取与 chunk 回调在 abort 后立即停止。超时路径复用同一 signal 取消上游请求。

**状态**: ✅ 已修复 — SSE 路由创建 `AbortController` 并在连接关闭时 abort；signal 透传到 `Provider.complete`、`stream` 与 `streamWithTools`。Provider 回归测试覆盖预先取消、三个入口透传和流中取消后停止分发 chunk。资源推荐同样支持取消，并额外设置 Server 60 秒截止时间。

---

## P1 — 功能静默失败

### P1-1: `rebuildIndex` 不创建备份

**文件**: `server/engine/store/crud.js:174`

```js
writeAtomic(PLANS_INDEX, JSON.stringify(index, null, 2));  // ← 无 { backup: true }
```

**问题**: 索引损坏后重建时，新索引不创建 `.bak` 和 `.backups-v2/` 备份。如果重建过程中再次断电，索引再次损坏，下次启动时 `readIndex` 会再次尝试重建，但此时 `readJSON` 可能读到空文件（上一次 writeAtomic 的 tmp 文件残留）。

**影响**: 极端情况下（连续两次断电），可能导致索引永久损坏，需要手动恢复。

**✅ 安全修复方案**: 调用 `writeAtomic` 时传入 `{ backup: true }`。

**状态**: ✅ 已修复并于 2026-07-27 复核

---

### P1-2: `DiskPrefixCache.flush` 的 `renameSync` 无 EPERM 保护

**文件**: `server/engine/provider.js:157`

```js
fs.renameSync(tmp, this._path);  // ← 无 try-catch
```

**问题**: 与 P0-1 类似，但此处有外层 try-catch（line 159-161），所以不会崩溃。但缓存刷新失败是静默的，下次刷新时 `_dirty` 标志仍为 true，可能导致重复写入。

**影响**: 缓存数据可能丢失，导致服务器重启后缓存预热失败，增加 API 调用次数。

**状态**: ✅ 已修复 — rename 失败时使用 copy + unlink 降级；只有成功持久化才清除 `_dirty`。`provider.test.js` 覆盖 EPERM 成功降级，以及 rename/copy 均失败时的非致命清理路径。

---

### P1-3: `writeAtomic` 内部 updateIndex 可能不执行

**文件**: `server/engine/store/crud.js:1161-1165`

**问题**: `writePlan` 中 `writeAtomic` 成功后才调用 `updateIndex`。如果 `writeAtomic`（含 backup）中途失败，`updateIndex` 不执行，导致索引中的 `topicCount` 过时。

**影响**: `listPlans` 返回的 `topicCount` 与实际 topic 数量不一致，前端显示的 topic 数量错误。

**状态**: ✅ 已关闭（设计澄清） — plan 文件写失败时不更新索引是正确语义，不能让索引指向未持久化状态。plan 文件已成功写入而 `updateIndex` 异步失败时，`writePlan` 会记录非致命告警并保留有效 plan，后续由 `rebuildIndex()` 对账；该路径有依赖注入回归测试。

---

### P1-4: `interactiveSession` 存储在 topic 上但无版本控制

**文件**: `server/engine/learn-engine.js:289-290`

```js
topic.interactiveSession = session;
await updateTopic(plan.id, topicId, { interactiveSession: session });
```

**问题**: `interactiveSession` 对象直接赋值给 topic，然后通过 `updateTopic` 持久化。如果两个并发请求同时操作同一个 topic 的 interactive session（用户快速点击），后一个请求会覆盖前一个的 session 状态。

**影响**: 互动教学的对话历史丢失，用户需要重新开始。

**状态**: ✅ 已修复 — 流式 continue 入口在 session 为 `ai_thinking` 时拒绝第二次请求，避免两个响应竞态覆盖 `interactiveSession`。

---

### P1-5: `encodeForRelay` 无测试覆盖

**文件**: `server/engine/provider.js:439-447`

```js
function encodeForRelay(text) {
  const map = { '<': '＜', '>': '＞', "'": '＇', '"': '＂' };
  return text.replace(/[<>'"]/g, ch => map[ch]);
}
```

**问题**: 此函数在每次 API 调用时对用户消息进行编码，但没有任何测试。如果正则或映射表有误，所有用户输入都会被静默修改。

**影响**: 用户输入的 `<` `>` `'` `"` 会被替换为全角字符，AI 看到的输入与用户输入不一致。

**状态**: ✅ 已修复 — `provider.test.js` 已增加 7 个用例，覆盖尖括号、单双引号、普通/中文文本、空字符串、代码片段和幂等性。

---

### P1-6: SSE 路由的 `onError` 回调未被 `streamInteractiveStart` 调用

**文件**: `server/routes/learn.js:569`, `server/engine/learn-engine.js:453`

```js
// 路由定义了 onError：
onError: (err) => writeEvent({ type: 'error', data: err.message }),

// 但 streamInteractiveStart 内部：
// 没有调用 callbacks.onError，错误直接 throw
```

**问题**: `streamInteractiveStart` 和 `streamInteractiveContinue` 在 catch 块中 throw 错误，但不会调用 `onError` 回调。路由层的 catch 块（line 574-578）会处理，但 `onError` 永远不会被触发。

**影响**: 客户端无法通过 SSE 事件收到错误通知（除非 headers 未发送，才走 JSON 500 路径）。

**⚠️ 预审发现的陷阱**: 如果在 headers 未发送时调用 onError 写 SSE，外层 catch 又去 `res.status(500).json()`，会抛出 `ERR_HTTP_HEADERS_SENT`。当前路由通过 `res.headersSent` 分支和统一的 SSE 写入/收尾路径区分 JSON 与 SSE 错误响应。

**状态**: ✅ 已关闭（实现复核） — `streamInteractiveStart` 与 `streamInteractiveContinue` 的流式 catch 均调用 `onError` 后继续抛出，路由层 catch/finally 负责 SSE 错误输出与收尾；未发现错误被静默吞掉。真实供应商的非标准流错误仍由 Provider 通用异常映射处理。

---

### P1-7: `test-connection` 不验证 API Key 空字符串

**文件**: `server/routes/learn.js:26-34`

```js
router.post('/test-connection', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: '请提供 API Key...' });
  }
  // ...
});
```

**问题**: 如果 `process.env.OPENAI_API_KEY` 为空字符串 `""`，`!apiKey` 为 false，会继续调用 `provider.testConnection()`，用空字符串作为 API key 发请求，得到 401 错误。

**影响**: 用户看到的错误信息是 "API Key 无效" 而不是 "请提供 API Key"，误导用户。

**✅ 安全修复方案**: `if (!apiKey || !apiKey.trim())`

**状态**: ✅ 已修复并于 2026-07-27 复核

---

## 修复状态汇总

| 编号 | 问题 | 陷阱等级 | 状态 | 修复方式 |
|------|------|----------|------|----------|
| P0-1 | writeAtomic EPERM | ⚠️ 有陷阱 | ✅ 已修复 | copy+unlink 降级，unlink 失败安全忽略 |
| P0-2 | trashPlan 降级删除 | ✅ 无陷阱 | ✅ 已修复 | 去掉 unlink，直接 throw |
| P0-3 | writeQueues 内存泄漏 | ⚠️ 有陷阱 | ✅ 已修复 | settled 后按 Promise 身份回收；队列测试锁定 |
| P0-4 | SSE 客户端断开后 API 继续 | ⚠️ 有陷阱 | ✅ 已修复 | 路由 signal → Provider → SDK 三层透传 |
| P1-1 | rebuildIndex 无备份 | ✅ 无陷阱 | ✅ 已修复 | 加 `{ backup: true }` |
| P1-2 | DiskCache renameSync | ⚠️ 有陷阱 | ✅ 已修复 | copy + unlink 降级，失败保持 dirty |
| P1-3 | writeAtomic 中 updateIndex 不执行 | ⚠️ 有陷阱 | ✅ 已关闭 | 写失败不推进索引；索引异步失败可重建 |
| P1-4 | interactiveSession 并发覆盖 | ⚠️ 有陷阱 | ✅ 已修复 | `ai_thinking` 并发 guard |
| P1-5 | encodeForRelay 无测试 | ✅ 无陷阱 | ✅ 已修复 | 7 个回归用例 |
| P1-6 | onError 回调不被调用 | ⚠️ 有陷阱 | ✅ 已关闭 | 引擎回调 + 路由 catch/finally 已核查 |
| P1-7 | test-connection 空字符串 | ✅ 无陷阱 | ✅ 已修复 | `apiKey.trim()` 校验 |

**已修复或关闭**: 11 项
**待修复**: 0 项

当前自动化基线为 Server `538/538`、Client `100/100`。与真实收费 AI 供应商相关的立即停止计费行为仍取决于上游对 HTTP abort 的实现；本项目已验证 SDK signal 透传及本地 chunk 分发停止。
