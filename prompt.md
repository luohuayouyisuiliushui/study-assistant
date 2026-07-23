# Study Assistant 产品功能与交互设计审查（第二轮）

## 任务目标与边界

你正在对单用户、本地运行的 Study Assistant **v1.12.0** 进行第二轮产品功能与交互设计审查。目标是找出学习闭环中的真实断点、已实现但用户不可触达或不可理解的功能，以及交互细节上的摩擦点。

这是**审查任务，不是实现任务**。**不要修改任何源码、测试、依赖或数据文件**。允许修改的唯一文件是 `TODO.md`，且只能按本文的"TODO.md 写入规则"追加审查结果。

---

## 第一轮已修复项（勿重报）

以下问题已在 v1.12.0 中修复，审查时跳过：

| 已修复 | 说明 |
|--------|------|
| weakPoints 标签展示 | TopicDetail 掌握度卡片内显示薄弱点标签 |
| Bundle 导入路由 | `POST /plans/import/bundle` + `api.importBundle()` 已实现 |
| PlanView 搜索/筛选 | 搜索框 + 状态筛选下拉已实现 |
| SM-2 参数可视化 | 复习后显示间隔天数/难度系数/重复次数 |
| 掌握度样本数 | tooltip 显示 N 次证据数 |
| generationFeedback 历史 | 折叠面板展示最近 5 条 |
| 资源 👍/👎 评分 | 前端控件 + `PATCH .../resources/:idx/rating` 路由均已实现 |
| learnerPersona.confidence | UserProfile 页彩色 badge 已实现 |
| 原生 confirm() | 全部替换为 ConfirmDialog（7 处） |
| 导出格式描述 | ActionMenu 每种格式加了说明文字 |
| 滚动位置恢复 | sessionStorage 保存/恢复已实现 |
| SettingsModal 离线说明 | 两栏对照卡片已添加 |

---

## 审查范围（8 个域）

### 域 1：功能可达性（已实现但用户触达不到）

重点检查：已有后端能力/API，但前端无入口的功能。

提示线索：
- `POST /plans/import/bundle` 路由已实现，`api.importBundle()` 已实现——但检查 `client/src/components/ActionMenu.jsx`、`client/src/components/PlanList.jsx`、`client/src/pages/` 是否有对应的 UI 按钮或入口
- `topic.weakPoints[]` 已显示为标签，但后端 `learning-analyzer.js` 的 `suggestedAction` 是否真实存在于数据结构？前端有无触发"针对薄弱点练习"的动作入口？
- `topic.resources[].userRating` 已持久化——检查 `server/engine/learn-engine.js`、`server/engine/adaptive-engine.js` 或 `server/routes/assessment.js` 有无消费该字段，还是只存不用

### 域 2：SettingsModal 入口逻辑

- `client/src/components/SettingsModal.jsx` 第 359 行：`<Button type='submit' disabled={!apiKey}>保存并开始</Button>`——离线说明已添加，但保存按钮仍强制要求 API Key。无 Key 时用户是否有"只读模式进入"的替代路径？还是必须填 Key 才能进入应用？
- 审查 `client/src/App.jsx` 或入口逻辑：应用启动时如果 `apiKey` 为空，是否会强制弹出 SettingsModal 并阻止进入？

### 域 3：新组件完整性（v1.12.0 新增）

审查 `client/src/components/MistakePanel.jsx` 和 `client/src/components/TodayReview.jsx`：
- 功能是否完整（有无 TODO/placeholder）
- 错误状态、空状态、加载状态是否处理
- 与 TopicDetail / PlanView 的跳转是否连通

### 域 4：PlanView 筛选完整性

搜索+状态筛选已实现，但检查：
- 有无**排序控件**（按掌握度/最近访问/待复习优先）
- 筛选结果为空时是否有空状态提示
- 筛选状态是否在切换计划后重置

### 域 5：generationFeedback 闭环

- `topic.generationFeedback[]` 已对用户可见——但检查 `server/engine/learn-engine.js` 中内容生成时是否将 `generationFeedback` 注入 prompt（实现"反馈影响下次生成"的闭环）
- 如果没有，用户提交反馈后实际上没有任何效果，反馈功能是否应该明确告知"反馈用于改进"或"暂不影响当前生成"？

### 域 6：ROADMAP 功能现状核查

检查以下 ROADMAP 中列出的功能是否已实现或有进展，如有则记录：
- **Debate / Socratic / Analogy 互动模式**：检查 `server/engine/interactive-teacher.js`、`server/routes/content.js`、`client/src/components/InteractivePanel.jsx`
- **Service Worker 离线缓存**：检查 `client/src/sw.js` 是否存在及其实现状态
- **HTML 离线包导出**：检查 `server/engine/export-engine.js` 和 `server/engine/html-exporter.js`

### 域 7：无障碍访问（Accessibility）

对以下高频操作路径做 ARIA 覆盖度检查（静态分析，不需要跑 axe）：
- 主导航和计划切换
- TopicDetail 里的按钮（生成、复习、练习）
- ConfirmDialog 的焦点管理（`open` 时 focus 是否移到 Dialog，关闭后是否返回触发元素）
- 键盘操作：Escape 能否关闭所有 Dialog/Modal

### 域 8：数据一致性风险

- `server/engine/store/crud.js` 的 `updateTopic`：检查 `resources` 数组整体替换时是否存在并发风险（两个请求都读到旧数组再写入，后者覆盖前者的修改）
- `server/engine/store/storage.js`：`writePlan` 是否保证原子性，双层备份在写入失败时是否可靠回滚
- `server/data/` 下的 `user-profile.json`：更新画像时是否也有原子写入保护

---

## 审查规范

1. **只读**：不修改任何 `.js`、`.jsx`、`.json`（除 TODO.md）、`.css`、测试文件
2. **证据驱动**：每条发现必须附上文件名和行号/函数名作为证据
3. **级别定义**：
   - `[P1]` — 功能断裂：已实现的能力用户完全触达不到，或数据存在丢失风险
   - `[P2]` — 体验缺口：功能可用但有明显摩擦、信息不透明或与用户预期不符
   - `[P3]` — 优化建议：锦上添花，不影响核心使用
4. **不重报**：本文"已修复"表格中的项目不计为新发现
5. **不评估**：不对 AI 生成质量、prompt 效果、算法准确性作评价（无法静态验证）

---

## TODO.md 写入规则

在 `TODO.md` 文件的 `## 未来方向` 之前，追加新的审查章节，格式如下：

```markdown
## 设计审查（YYYY-MM-DD）

> 审查范围：8 个域，静态代码分析为主。
> 第一轮已修复项（见 prompt.md）不再重报。

---

### [P1] [待修复] 标题

- 当前现象：...
- 受影响程度：...
- 建议方向：...
- 证据：`文件路径:行号`

### [P2] [待修复] 标题

...

---

> 覆盖说明：...
```

**只追加，不修改已有内容。** 如无发现，写 `> 本次审查未发现新问题。`
