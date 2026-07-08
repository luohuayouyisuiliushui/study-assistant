# 📚 Study Assistant — AI 知识点学习助手

> **当前版本: v1.5.0** — 核心20%分析 + 费曼学习法 + 快速测验 + 用户画像

一个基于 AI 的交互式自学辅助工具。创建学习计划、添加知识点列表，AI 逐个生成详细讲解，支持追问、交互教学模式、组卷考试、知识图谱、学习分析等完整学习闭环。

## 快速开始

```bash
# 后端（端口 3001）
cd server && node index.js

# 前端开发服务器（端口 5173，自动代理 /api → 3001）
cd client && npm run dev

# 运行测试
cd server && node --test --test-concurrency=1 --test-force-exit "__tests__/*.test.js"
```

## 核心流程

```
创建计划 → 添加知识点 → AI 生成讲解 → 学习标记 → 追问扩展 → 做练习/测验 → 复习巩固 → 知识图谱 → 导出分享
```

## 全部功能

### 📖 学习管理
| 功能 | 说明 |
|------|------|
| **学习计划** | 创建/删除/批量管理，支持AI智能导入大纲 |
| **知识点树形层级** | 章节→小节→子节，📘📗📙📄 层级图标，展开/折叠 |
| **三态分类** | ⏸️ 未开始 / 🔄 学习中 / ✅ 已学习 |
| **文件批量导入** | TXT/MD/CSV，UTF-8/GBK 自动编码检测 |
| **回收站** | 误删可恢复，30天自动清理 |

### 🤖 AI 生成
| 功能 | 说明 |
|------|------|
| **知识点讲解** | SSE 流式生成 Markdown，含 Mermaid 图表、例题、练习题 |
| **多轮追问** | 基于完整对话历史继续回答 |
| **AI 配图** | 自动生成知识点示意图（SiliconFlow FLUX.1） |
| **知识点拆解** | 将一个知识点拆为 3-6 个子知识点 |

### 🎯 交互式教学（5 种模式）
| 模式 | 按钮 | 说明 |
|------|------|------|
| **stepwise** | 📖 分段讲解 | AI 每讲完一个子概念暂停，等你反馈后再继续 |
| **realtime** | 🎙️ 实时互动 | 灵活的小块高频对话式教学 |
| **challenge** | （实验性） | AI 在讲解中故意埋入微妙错误，考验你是否发现 |
| **scaffold** | （实验性） | 脚手架教学法：拆解为递进子问题逐步引导 |
| **feynman** | 🧑‍🏫 费曼学习法 | **你讲 AI 听**：向 AI 讲解知识点，AI 扮演好奇学生追问 |

### 📝 练习与测验
| 功能 | 说明 |
|------|------|
| **随堂练习题** | 讲解末尾自动生成 3-5 道题，交后 AI 评分 |
| **AI 组卷系统** | 智能组卷，支持选择题/简答题，自动批改+解析 |
| **错题练习** | 针对错题知识点生成针对性强化练习 |
| **快速测验** | 🆕 轻量随机出题（2-3 道），跨知识点考查 |

### 📊 学习分析
| 功能 | 说明 |
|------|------|
| **学习分析报告** | AI 分析学习进度、薄弱点、学习风格 |
| **核心 20% 分析** | 🆕 帕累托法则识别最重要的 20% 知识点 |
| **薄弱点追踪** | 跨知识点识别薄弱环节，可视化展示 |
| **复习模式** | 针对薄弱点生成精简复习材料 |
| **用户画像** | 🆕 跨计划聚合学习数据，AI 生成学习者画像 |

### 🕸️ 知识网络
| 功能 | 说明 |
|------|------|
| **知识图谱** | D3 + Mermaid 双引擎，12 种关系类型 |
| **思维导图** | markmap 内嵌渲染，支持 XMind 导出 |
| **关系系统** | 前置依赖、相关知识点、父子层级自动关联 |
| **关系推断** | 从 AI 讲解文本自动提取知识点关系 |

### 🎤 其他
| 功能 | 说明 |
|------|------|
| **语音输入** | Web Speech API 语音转文字提问 |
| **TTS 语音合成** | SiliconFlow CosyVoice2 文字转语音 |
| **双格式导出** | Markdown / HTML（含渲染 SVG 图表） |
| **设置弹窗** | 在线配置 API Key / Base URL / Model |

## 技术栈

- **前端**: React 19 + Vite 8 + react-markdown + mermaid + markmap
- **后端**: Node.js + Express 5 + OpenAI SDK（ESM 模块）
- **AI**: OpenAI 兼容 API（OpenAI / DeepSeek / SiliconFlow 等），SSE 流式
- **存储**: JSON 文件系统，原子写入（tmp+rename），三重备份机制
- **测试**: Node.js 内置 `node:test` + `node:assert`，210+ 测试用例

## API 概览（50+ 端点）

| 分类 | 主要端点 |
|------|---------|
| **计划** | `GET/POST /api/learn/plans`，`DELETE /api/learn/plans/:id` |
| **回收站** | `GET/POST/DELETE /api/learn/trash`，`POST .../restore` |
| **知识点** | `POST /api/learn/plans/:id/topics`，`PUT .../reorder` |
| **AI 生成** | `POST /api/learn/plans/:planId/generate/:topicId` |
| **追问** | `POST /api/learn/plans/:planId/ask/:topicId` |
| **交互** | `POST .../interactive-start/:topicId`，`POST .../interactive-continue/:topicId` |
| **分析** | `POST /api/learn/plans/:planId/analysis` |
| **核心 20%** | `POST /api/learn/plans/:planId/core-topics` |
| **快速测验** | `POST /api/learn/plans/:planId/quick-quiz` |
| **组卷** | `POST .../exam/generate`，`POST .../exam/:examId/submit` |
| **知识图谱** | `GET /api/learn/plans/:id/graph`（支持 `?infer=true`） |
| **用户画像** | `GET /api/user-profile` |
| **TTS** | `POST /api/learn/tts` |

## 项目结构

```
study-assistant/
├── client/                          # React 19 前端
│   └── src/
│       ├── components/              # PlanList / PlanView / TopicDetail 等
│       ├── pages/                   # 用户画像 UserProfile
│       └── utils/                   # 编码检测等
└── server/                          # Express 5 后端
    ├── engine/
    │   ├── learn-engine.js          # AI 生成核心（16 个导出函数）
    │   ├── learn-prompts.js         # 15 个 Prompt 模板
    │   ├── learn-store.js           # 数据 CRUD + 知识图谱
    │   ├── store/crud.js            # 实现层（~1600 行）
    │   └── provider.js              # OpenAI Provider（三级缓存）
    ├── routes/
    │   ├── learn.js                 # 所有学习 API 路由
    │   └── user-profile.js          # 用户画像路由
    └── __tests__/                   # 5 个测试文件，210+ 测试
```

## 测试

```bash
cd server
node --test --test-concurrency=1 --test-force-exit "__tests__/*.test.js"
```

| 测试文件 | 测试数 | 覆盖内容 |
|----------|--------|----------|
| `learn-engine.test.js` | 64 | 讲解/追问/互动/核心20%/费曼/测验/组卷 |
| `learn-store.test.js` | 54 | CRUD/层级/回收站/练习/标记 |
| `learn-prompts.test.js` | 43 | 15 个 prompt 模板完整性 |
| `provider.test.js` | 43 | 连接/哈希/缓存/稳定性 |
| `cache-diagnostics.test.js` | 6 | 缓存监控 |
| **合计** | **210** | |

## 配置 API Key

四种方式（从前到后优先级）：
1. 请求头 `x-api-key` / `x-api-base` / `x-api-model`
2. 请求体 `apiKey` / `baseURL` / `model`
3. 环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`
4. 前端设置弹窗（localStorage）

## 已知注意事项

- **Windows**: 测试必须串行（`--test-concurrency=1`），否则文件锁冲突
- **Express 5**: 通配符路由使用 `/{*splat}` 而非 `*`
- **中转站**: 自动降级 `response_format` / `stream_options` 参数
- **数据安全**: 测试数据清理时谨慎操作，不要无条件调用 `store.deletePlan()`
