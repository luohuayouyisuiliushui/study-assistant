# 📚 Study Assistant — AI 知识点学习助手

> **当前版本: v1.3.0** — 全面测试覆盖 + 交互模式增强

一个基于 AI 的交互式自学辅助工具。用户创建学习计划、添加知识点列表，AI 逐个生成详细的 Markdown 讲解，支持追问、练习题、复习模式和 Mermaid 图表。

## 核心流程

```
创建计划 → 添加知识点 → AI 生成讲解 → 学习完成并标记 → 追问扩展 → 做练习题 → 复习巩固 → 导出分享
```

1. **创建学习计划** — 自定义计划名称，或粘贴大纲文本让 AI 自动解析
2. **添加知识点** — 按阶段/章节组织知识点列表，支持文件批量导入
3. **AI 生成讲解** — 逐个生成结构化的详细讲解（含 Mermaid 图表）
4. **学习完成标记** — 阅读讲解后点击「✅ 学完了」手动标记完成
5. **追问扩展** — 对每个知识点可进行多轮追问，历史影响后续讲解
6. **练习题** — AI 自动生成练习题，作答后 AI 评分并给出解析（v1.1.0）
7. **复习模式** — 针对薄弱点生成强化复习内容（v1.1.0）
8. **薄弱点分析** — 跨知识点分析薄弱环节，指导复习方向（v1.1.0）
9. **导出** — 支持导出为 Markdown 或 HTML（含渲染后的图表）

## 功能特性

- 🤖 **AI 驱动生成** — 接入 OpenAI 兼容 API（OpenAI / DeepSeek / SiliconFlow 等）
- ✅ **学习完成标记** — 阅读讲解后手动标记完成，返回列表继续学
- 📝 **Markdown 渲染** — 支持 GFM 表格、代码高亮、原始 HTML
- 📊 **Mermaid 图表** — AI 自动绘制流程图、时序图、类图等 20+ 种图表
- 💬 **扩展讨论** — 对每个知识点可多轮追问，记录完整的 Q&A 历史
- 📈 **学习分析** — AI 分析学习进度和问答历史，给出个性化建议
- 📝 **练习题系统** — AI 自动生成选择题/简答题，作答后评分 + 解析（v1.1.0）
- 🔄 **复习模式** — 针对薄弱知识点生成复习材料，强化记忆（v1.1.0）
- 📌 **薄弱点追踪** — 跨知识点识别薄弱环节，可视化展示（v1.1.0）
- 🔗 **知识点层级** — 支持阶段分组、前置依赖、知识图谱
- ⬇️ **双格式导出** — Markdown（保留源码）或 HTML（含渲染 SVG 图表）
- 📂 **文件导入** — UTF-8 / GBK 自动检测，支持批量导入知识点
- 🔌 **中转站兼容** — 自动适配不支持的 API 参数（response_format / stream_options 降级）
- 🔍 **连接测试** — 设置页一键测试 API Key 是否可用

## 技术栈

- **前端**: React 19 + Vite 8 + react-markdown + mermaid
- **后端**: Node.js + Express + OpenAI SDK
- **存储**: JSON 文件（原子写入 + 自动备份）
- **AI**: OpenAI 兼容 API

## 快速开始

### 前置要求

- Node.js >= 18
- 一个 OpenAI 兼容的 API Key

### 安装

```bash
# 安装所有依赖
npm run install:all

# 或者手动安装
cd server && npm install
cd ../client && npm install
cd ..
```

### 配置

在 `server/.env` 中配置（或启动后在界面上设置）：

```env
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
PORT=3001
```

> 💡 **中转站用户**：如果使用 One-API / New-API 等代理，只需将 `OPENAI_BASE_URL` 指到中转站地址即可。系统会自动检测不兼容的参数并降级。

### 启动开发模式

```bash
npm run dev
```

这会同时启动：
- 后端服务: http://localhost:3001
- 前端开发服务器: http://localhost:5173（自动代理 /api → 3001）

### 生产构建

```bash
npm run build
npm start
```

然后访问 http://localhost:3001

## 测试

```bash
cd server
node --test --test-concurrency=1 --test-force-exit __tests__/
```

> 注意：由于 Windows 文件锁问题，跑全部测试时需要 `--test-concurrency=1` 串行执行。

## 项目结构

```
study-assistant/
├── server/                         # 后端服务
│   ├── index.js                    # Express 入口
│   ├── routes/
│   │   └── learn.js                # 学习模块 REST API 路由
│   ├── engine/
│   │   ├── provider.js             # OpenAI 兼容 Provider（缓存 + 重试 + 中转站兼容）
│   │   ├── learn-store.js          # 数据层（CRUD + 原子写入 + 备份）
│   │   ├── learn-engine.js         # AI 生成引擎（讲解/追问/练习/复习/分析）
│   │   ├── learn-prompts.js        # Prompt 模板（含 Mermaid 指引）
│   │   └── cache-diagnostics.js    # 缓存性能诊断
│   ├── __tests__/                  # 单元测试（共 111 个）
│   │   ├── provider.test.js        # Provider 兼容性 + Mock 测试
│   │   ├── learn-engine.test.js    # 引擎功能测试
│   │   ├── learn-store.test.js     # 数据层测试
│   │   ├── learn-prompts.test.js   # Prompt 模板测试
│   │   └── cache-diagnostics.test.js
│   └── data/learn/
│       ├── plans/                  # 学习计划 JSON 文件
│       └── .backups/               # 自动备份
├── client/                         # 前端应用
│   └── src/
│       ├── App.jsx                 # 主应用组件（3 视图路由）
│       ├── api.js                  # API 调用封装
│       ├── components/
│       │   ├── PlanList.jsx        # 计划列表 + AI 导入
│       │   ├── PlanView.jsx        # 知识点列表 + 文件导入 + 薄弱点标记
│       │   ├── TopicDetail.jsx     # 知识点详情 + 追问 + 练习题 + 复习
│       │   ├── MermaidDiagram.jsx  # Mermaid 图表渲染组件
│       │   └── SettingsModal.jsx   # API 设置弹窗（含连接测试）
│       └── styles/
│           └── app.css             # 样式
└── package.json                    # 根工作区配置
```

## API 兼容说明

本工具支持所有 OpenAI 兼容 API，包括各类中转站（One-API / New-API 等）：

| 兼容项 | 说明 |
|--------|------|
| `response_format` | 自动检测中转站是否支持，不支持则降级 |
| `stream_options` | 自动检测并降级（回退后无 usage 数据，不影响功能） |
| 错误提示 | 中文格式化错误信息（401/403/404/429/500/超时/DNS/余额不足等） |
| 连接测试 | 设置页「测试连接」按钮，一键验证 API 配置 |

## Mermaid 图表支持

AI 在生成讲解时，如果适合用图表展示，会自动使用 Mermaid 语法绘制：

- **流程图** (`graph TD/LR`)
- **时序图** (`sequenceDiagram`)
- **类图** (`classDiagram`)
- **甘特图** (`gantt`)
- **思维导图** (`mindmap`)
- **ER 图** (`erDiagram`)
- 以及状态图、饼图、Git 分支图等 20+ 种类型

渲染由 `MermaidDiagram.jsx` 组件在客户端完成，使用 `mermaid.render()` 安全转换为 SVG，不会生成虚假的外部图片链接。

## License

MIT
