# 前端界面调整经验总结

基于两次 UI 调整会话的经验整理，涵盖技术栈特性、常见陷阱和最佳实践。

---

## 技术栈背景

- **框架**: React 19 + Vite 8
- **样式**: Tailwind CSS 4.3 + shadcn/ui (copy-paste 组件，非 npm)
- **工具函数**: `cn()` 仅是 `inputs.filter(Boolean).join(' ')`，**不是** tailwind-merge

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
