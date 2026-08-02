# Study Assistant Client v5.0.1

Study Assistant 的 React 前端。开发服务器运行在 `http://localhost:5270`，并通过 Vite proxy 将 `/api` 请求转发到 `http://localhost:3001`。

## 技术栈

- React 19、React Router 7、Vite 8
- Tailwind CSS 4 与仓库内手写的 shadcn/ui 组件
- React Markdown、Mermaid、Markmap、Recharts 与原生 SVG 图谱
- Vitest、Testing Library、jsdom、Oxlint

应用代码为纯 JS/JSX。`src/components/ui/` 是 copy-paste 组件目录，不要使用 `npx shadcn-ui add` 覆盖。

## 本地运行

从仓库根目录启动前后端：

```bash
npm install
npm run dev
```

只启动前端：

```bash
npm run dev --prefix client
```

只运行前端时仍需单独启动端口 `3001` 的 Server，否则 API 请求会失败。

## 命令

```bash
npm test --prefix client       # Vitest 单次运行
npm run test:watch --prefix client
npm run lint --prefix client   # Oxlint
npm run build --prefix client  # 生产构建到 client/dist
npm run preview --prefix client
```

`v5.0.1` 的验证入口为 `npm test`、`npm run lint` 和 `npm run build`；不在文档中维护会随功能变化的固定测试计数。

## 目录

```text
src/
├── api.js                     # API 请求、Provider 配置注入与超时控制
├── App.jsx                    # HashRouter 页面入口
├── hooks/
│   └── useTopicLearningWorkspace.js # 六组学习流程状态与 API 编排
├── components/
│   ├── TopicDetail.jsx        # 知识点详情渲染、导航、语音与导出
│   ├── MediaViewer.jsx        # 图片/图表全屏、变换、编辑与下载
│   ├── MermaidDiagram.jsx     # Mermaid 懒加载与手动重绘
│   ├── KnowledgeGraphModal.jsx # 主题骨架/完整图谱、缩放与导出
│   ├── MindMapModal.jsx       # 思维导图与五种导出格式
│   ├── TopicDetailShared.jsx  # Markdown 内容渲染
│   └── ui/                    # 手写 shadcn/ui 原子组件
├── lib/                       # 设置、主题、Mermaid、图谱布局与导出工具
├── pages/UserProfile.jsx      # 证据驱动的跨计划学习画像
├── styles/                    # 全局、业务与视觉微调样式
└── test/                      # Vitest/Testing Library 测试
```

## 关键交互约定

- Mermaid 首次进入视口时渲染一次；源码变化后显示重绘提示，只有用户点击按钮才再次渲染。
- 配图和 Mermaid 图均可点击全屏。全屏视图支持缩放、拖动、旋转、翻转、源码编辑及下载。
- 知识点悬浮导航在鼠标靠近页面顶部时出现，离开后延迟收起；无 hover 的触屏设备保持导航可见。
- 资源推荐客户端超时为 65 秒，失败或超时后必须恢复可重试按钮状态。
- 大型知识图谱默认显示主题骨架，允许切换全部知识点；节点 ID 必须从 Mermaid DOM 映射回真实 topic ID 后再高亮。
- 思维导图导出必须生成对应的 Markdown、SVG、PNG、结构化 JSON 或 OPML 内容，不能用 Markdown 冒充专用格式。
- 学习画像的时间统一显示为小时/分钟；提问风格和学习节奏必须来自当前行为证据，不显示 AI 的诊断占位文本或无依据的早晚偏好。

## 开发约定

- 前端导入沿用现有风格；`#` alias 指向 `src/`。
- 新增组件或交互必须在 `src/test/` 补 Vitest/Testing Library 测试。
- `src/lib/utils.js` 的 `cn()` 只拼接 class，不执行 Tailwind 冲突合并；覆盖既有组件样式时先检查 CSS cascade。
- 不提交 `dist/`，发布构建由 `npm run build` 生成。

完整项目说明和下载入口见仓库根目录的 [README](../README.md)。
