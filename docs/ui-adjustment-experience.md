# 前端界面调整经验总结

> 适用版本：`v1.14.0`。最后复核：2026-07-27。

基于多次 UI 调整与回归修复整理，涵盖技术栈特性、常见陷阱和最佳实践。早期会话记录保留为历史经验，当前交互约束以本页的 `v1.13.1+` 补充为准。

---

## 技术栈背景

- **框架**: React 19 + Vite 8
- **样式**: Tailwind CSS 4.3 + shadcn/ui (copy-paste 组件，非 npm)
- **工具函数**: `cn()` 仅是 `inputs.filter(Boolean).join(' ')`，**不是** tailwind-merge

---

## v1.13.1+ 交互回归约束

### 大型知识图谱

- 弹窗应使用接近整个视口的稳定画布，不能让 60+ 节点图只挤在局部区域。
- 大图默认聚合到一级主题骨架，同时保留“全部知识点”切换；聚合边只统计跨主题关系，不能把主题内部父子边画回骨架。
- 画布提供适应视图、按钮/滚轮缩放、指针拖拽、横向/纵向布局和可收起的关系筛选。
- Mermaid 生成的 DOM 节点 ID 不是原始 topic ID；点击处理必须显式映射回来，回归测试要断言真实 topic ID 的选中样式。

### 思维导图与学习画像

- 思维导图使用近全屏画布并提供适应视图；Markdown、SVG、PNG、JSON、OPML 必须分别生成真实格式，不能用 Markdown 文件冒充 XMind 或其它格式。
- 学习时长面向用户统一显示为小时/分钟，服务端原始秒数只用于计算与 API 数据，不直接写入说明文本。
- 提问风格只从实际问题样本分类；样本不足时显示简短状态，不展示模型的诊断句或无证据的早晚学习偏好。
- 画像要同时给出可信度、问题/答题样本、活跃日、计划覆盖和行为证据，避免只有几行标签的空泛卡片。

### 顶部悬浮导航

- 原始标题离开视口后，悬浮导航仍应默认隐藏。
- 仅当指针进入页面顶部 96px 感应区时显示；离开后延迟 400ms 收起，避免鼠标移入导航途中闪烁。
- 对 `hover: none` 的触屏设备保持导航可见，不能照搬桌面 hover 逻辑。
- 回归测试必须验证“标题离开视口不立即显示”和“指针进入顶部后显示”两个独立条件。

### 图片与 Mermaid 全屏查看

- 普通配图和 Mermaid SVG 统一通过 `MediaViewer` 打开，不为每种媒体重复实现 modal。
- 查看工具包含缩放、拖动、旋转、翻转、重置与下载；Mermaid 额外提供源码编辑和重新生成。
- 关闭时恢复触发按钮焦点；打开时锁定背景滚动并支持 Escape，保证键盘操作和焦点语义。
- 位图保存通过 Canvas 应用旋转/翻转，SVG 保存直接输出变换后的 SVG，避免只保存屏幕截图。

### Mermaid 渲染生命周期

- 首次进入视口时只渲染一次，React StrictMode 下也不能重复调用 `mermaid.render()`。
- `code` 更新只显示“内容已更新”的重绘提示，不自动再次渲染。
- 用户点击重绘或错误态“重试”后才递增 render attempt；用 request id 丢弃过期异步结果。

### 资源推荐状态

- 空缓存数组表示“尚无推荐”，必须继续显示“推荐资源”按钮。
- Client 65 秒、Server 60 秒截止时间都要清理 timer/listener，并取消上游 signal。
- 成功、失败、超时和组件卸载都必须结束 loading；失败后保留明确错误并允许重试。

### 发布前验证

- Vitest：112/112。
- Client lint：0 errors / 27 warnings。
- Vite production build：通过。
- Playwright：桌面与移动端检查媒体全屏、图表非空、导航不遮挡、图谱 13/64 切换与节点高亮、画像响应式布局和导出文件名；当前为手动发布检查，尚未形成仓库内 E2E 套件。

---

## 关键发现：`cn()` 不是 tailwind-merge

项目中的 `cn()` 工具函数（`client/src/lib/utils.js`）只是一个简单的字符串拼接：

```js
export function cn(...inputs) {
  return inputs.filter(Boolean).join(' ')
}
```

**这意味着：**

1. Tailwind class 冲突**不会被解决**，两组 class 都会出现在 DOM 中
2. CSS cascade 决定最终效果，不可预测
3. shadcn 组件的默认 class（如 CardContent 的 `p-6 pt-0`）会与自定义 class 同时存在

### 解决方案：对 shadcn 组件使用 inline styles

```jsx
// ❌ 不可靠：cn() 不会合并，两组 class 都在 DOM 中
<CardContent className="px-10 py-8">

// ✅ 可靠：直接用 inline style 覆盖
<CardContent style={{ padding: '32px 40px' }}>
```

---

## 间距调整实战经验

### 第一次会话：系统性全局调整

用户反馈"前端页面很多地方都很紧凑"，需要增加呼吸感。

**调整范围**：5 个文件，约 30 处 Tailwind class 修改

| 文件 | 调整内容 |
|------|----------|
| App.jsx | Header `py-2.5` → `py-3` |
| PlanView.jsx | 外层 `px-8` → `px-10`，topic 行高、间距、stats grid |
| TopicDetail.jsx | 外层 `px-8` → `px-10`，内容区、讨论面板、输入区 |
| UserProfile.jsx | 外层 padding、section 卡片、grid gaps |
| PlanList.jsx | 列表容器 `space-y-5` → `space-y-6` |

**间距参考模式**（已验证可用）：

```
外层容器:  px-8 py-8 space-y-6 或 max-w-5xl
内层卡片:  px-4 py-3 或 px-6 py-5
按钮:      h-9 px-4 py-2 (默认) / h-8 px-3 (sm)
```

**页面容器宽度**：
- PlanList / PlanView: `max-w-5xl`
- TopicDetail / UserProfile: `max-w-4xl`

### 第二次会话：基于截图的精确修复

用户提供截图，指出具体问题并要求"直接修改代码，不需要解释原理"。

**修复的典型问题**：

1. **卡片内边距不足** → 用 inline style 替换 shadcn 组件
2. **Tab bar 间距不对** → 用 inline `marginTop/Bottom: 24px`
3. **标题冗余** → 删除 `<h2>` 标题，只保留功能按钮

---

## 常见陷阱

### 1. Edit 工具的 multiple matches 问题

当一个文件中有多个相同 className 时，`replace_all: false` 会报错。

**解决**：提供更多上下文行，或用 `replace_all: true`（如果所有匹配都应该改）。

```jsx
// PlanView.jsx 中有两处 space-y-1
// 必须提供更多上下文来唯一匹配
```

### 2. shadcn 组件的默认样式残留

```jsx
// CardHeader 默认有: flex-col space-y-1.5 p-6
// 即使你传了 className="flex flex-row ..."，默认样式仍在 DOM 中
```

**方案**：对需要精确控制的场景，用 `<div style={{...}}>` 替代 shadcn 组件。

### 3. Tailwind class 不生效

当 `cn()` 拼接了冲突的 class 时，结果不可预测。优先用 inline style。

---

## 工作流程建议

1. **先截图确认问题** → 用户提供截图比描述更精确
2. **小步迭代** → 改一处看一处，避免大改后难以定位问题
3. **用 inline style 保底** → shadcn 组件覆盖时，inline style 比 Tailwind class 更可靠
4. **检查 Edit 冲突** → 同文件多处相同 className 时，准备更多上下文

---

## 文件修改清单

以下是实际修改过的前端文件（供参考）：

```
client/src/App.jsx              - Header 间距
client/src/components/PlanList.jsx    - 卡片 padding、tab bar、标题
client/src/components/PlanView.jsx    - 外层 padding、topic 行、stats
client/src/components/TopicDetail.jsx - 内容区、讨论面板
client/src/pages/UserProfile.jsx      - section 卡片、grid
client/src/lib/utils.js              - cn() 工具函数（确认）
client/src/components/ui/card.jsx    - shadcn card（确认默认样式）
```
