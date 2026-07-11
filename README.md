# Study Assistant

> AI 驱动的交互式学习助手 v1.6.2

## 简介

Study Assistant 帮助你高效学习任何知识领域。创建学习计划，AI 为每个知识点生成详细讲解，支持追问、互动教学、测验考试，并自动追踪你的学习进度和薄弱环节。

## 功能

| 模块 | 功能 |
|------|------|
| **学习计划** | 创建/删除/批量管理，支持 AI 导入大纲、文件批量导入（TXT/MD/CSV） |
| **AI 讲解** | SSE 流式 Markdown 生成，含 Mermaid 图表、例题、练习题 |
| **交互教学** | 7 种模式：分段讲解、实时互动、费曼学习、挑战模式、支架教学等 |
| **追问系统** | 基于对话历史的多轮追问 |
| **练习测验** | 随堂练习、AI 组卷、错题强化、快速测验 |
| **学习分析** | 学习报告、核心 20% 分析、薄弱点追踪、用户画像 |
| **自适应引擎** | 错误状态机 + 干预推荐 + 个性化 prompt |
| **知识图谱** | D3 + Mermaid 双引擎，12 种关系类型，支持思维导图 |
| **导出** | Markdown / HTML / Anki / OPML / Notion / JSON / 学习笔记 |
| **其他** | 深色模式（6 套主题）、语音输入、TTS 语音合成 |

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器（前端 :5173 / 后端 :3001）
npm run dev

# 运行测试
npm test
```

浏览器打开 `http://localhost:5173`，首次使用在设置弹窗中配置 API Key。

## 使用指南

### 基本流程

```
创建计划 → 添加知识点 → AI 生成讲解 → 标记进度 → 追问扩展 → 做练习/测验 → 复习巩固 → 导出分享
```

### 配置 API Key

支持 OpenAI / DeepSeek / SiliconFlow 等 OpenAI 兼容 API。配置方式（优先级从高到低）：

1. 前端设置弹窗（推荐）
2. 请求头 `x-api-key`
3. 环境变量 `OPENAI_API_KEY`

```bash
# 或创建 .env 文件
cp server/.env.example server/.env
```

### 交互教学模式

| 模式 | 说明 |
|------|------|
| 分段讲解 | AI 每讲完一个子概念暂停，等你反馈后再继续 |
| 实时互动 | 小块高频对话式教学 |
| 费曼学习 | 你讲 AI 听，AI 扮演好奇学生追问 |
| 挑战模式 | AI 故意埋入错误，考验你是否发现 |
| 支架教学 | 拆解为递进子问题逐步引导 |

### 数据导出

支持导出为 Anki 卡片、OPML 大纲、Notion CSV、JSON 等格式，便于与其他工具集成。

## 技术架构

| 层 | 技术 |
|----|------|
| 前端 | React 19 + Vite 8 + Tailwind CSS 4 + shadcn/ui |
| 后端 | Node.js + Express 5 + OpenAI SDK（ESM） |
| AI | OpenAI 兼容 API，SSE 流式响应 |
| 存储 | JSON 文件系统，原子写入 + 双层备份 |
| 测试 | Node.js 内置 `node:test`，476 测试用例 |

### 数据飞轮

```
AI 生成（注入个性化上下文）→ 用户行为（练习/考试/提问）→ 画像更新 → 下次生成使用更新后的画像
```

### 项目结构

```
study-assistant/
├── client/                     # React 前端
│   └── src/components/         # UI 组件
└── server/                     # Express 后端
    ├── engine/                 # AI 核心（讲解/追问/自适应/核查）
    ├── routes/                 # API 路由（60+ 端点）
    └── __tests__/              # 测试用例
```

## 开发

### 测试

```bash
cd server
npm test
```

### API 端点一览

| 分类 | 端点 |
|------|------|
| 计划 | `GET/POST /api/learn/plans` |
| 知识点 | `POST .../topics`，`PUT .../reorder` |
| AI 生成 | `POST .../generate/:topicId`（SSE） |
| 追问 | `POST .../ask/:topicId` |
| 交互 | `POST .../interactive-start-sse/:topicId` |
| 测验 | `POST .../quick-quiz`，`POST .../exam/generate-stream` |
| 分析 | `POST .../analysis`，`POST .../core-topics` |
| 图谱 | `GET .../graph` |
| 导出 | `GET .../export/anki\|opml\|notion\|json\|notes` |
| 画像 | `GET /api/user-profile` |

### 已知注意事项

- Windows 测试需串行（`--test-concurrency=1`）
- 前端使用 HashRouter（`/#/`），无需服务器配置
