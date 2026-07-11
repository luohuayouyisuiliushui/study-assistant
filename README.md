# Study Assistant — AI 知识点学习助手

> **v1.6.1** — 修复备份清理机制，删除计划时自动清理 .backups-v2/ 目录

一个基于 AI 的交互式自学辅助工具。创建学习计划、添加知识点列表，AI 逐个生成详细讲解，支持追问、7 种交互教学模式、组卷考试、知识图谱、用户画像等完整学习闭环。

## 快速开始

```bash
# 后端（端口 3001）
cd server && node index.js

# 前端开发服务器（端口 5173，自动代理 /api → 3001）
cd client && npm run dev

# 运行测试
cd server && node --test --test-concurrency=1 --test-force-exit "__tests__/*.test.js"
```

浏览器访问 `http://localhost:5173`，首次使用需在设置弹窗中配置 API Key。

## 核心流程

```
创建计划 → 添加知识点 → AI 生成讲解 → 学习标记 → 追问扩展 → 做练习/测验 → 复习巩固 → 知识图谱 → 导出分享
```

## 全部功能

### 学习管理

| 功能 | 说明 |
|------|------|
| **学习计划** | 创建/删除/批量管理，支持 AI 智能导入大纲 |
| **知识点树形层级** | 章节→小节→子节，层级图标，展开/折叠 |
| **三态分类** | 未开始 / 学习中 / 已学习 |
| **文件批量导入** | TXT/MD/CSV，UTF-8/GBK 自动编码检测 |
| **回收站** | 误删可恢复，30 天自动清理 |

### AI 生成

| 功能 | 说明 |
|------|------|
| **知识点讲解** | SSE 流式生成 Markdown，含 Mermaid 图表、例题、练习题 |
| **多轮追问** | 基于完整对话历史继续回答 |
| **AI 配图** | 自动生成知识点示意图（SiliconFlow FLUX.1） |
| **知识点拆解** | 将一个知识点拆为 3-6 个子知识点 |
| **事实核查** | 自动检测生成内容中的不确定声明，支持一键修正 |

### 交互式教学（7 种模式）

| 模式 | 说明 |
|------|------|
| **分段讲解** | AI 每讲完一个子概念暂停，等你反馈后再继续 |
| **实时互动** | 灵活的小块高频对话式教学 |
| **费曼学习法** | 你讲 AI 听：向 AI 讲解知识点，AI 扮演好奇学生追问 |
| **挑战模式** | AI 在讲解中故意埋入微妙错误，考验你是否发现 |
| **分段挑战** | 分段讲解 + 挑战模式结合 |
| **实时挑战** | 实时互动 + 挑战模式结合 |
| **支架教学** | 拆解为递进子问题逐步引导 |

### 练习与测验

| 功能 | 说明 |
|------|------|
| **随堂练习题** | 讲解末尾自动生成 3-5 道题，AI 批改评分 |
| **AI 组卷系统** | 智能组卷，支持选择题/简答题，自动批改+解析 |
| **错题练习** | 针对错题知识点生成针对性强化练习 |
| **快速测验** | 轻量随机出题，结果可持久化 |

### 学习分析

| 功能 | 说明 |
|------|------|
| **学习分析报告** | AI 分析学习进度、薄弱点、学习风格 |
| **核心 20% 分析** | 帕累托法则识别最重要的 20% 知识点 |
| **薄弱点追踪** | 跨知识点识别薄弱环节，可视化展示 |
| **复习模式** | 针对薄弱点生成精简复习材料 |
| **用户画像** | 跨计划聚合学习数据，AI 生成学习者画像 |
| **自适应引擎** | 错误状态机 + 干预推荐 + 个性化 prompt 注入 |

### 知识网络

| 功能 | 说明 |
|------|------|
| **知识图谱** | D3 + Mermaid 双引擎，12 种关系类型 |
| **思维导图** | markmap 内嵌渲染，支持 XMind 导出 |
| **关系系统** | 前置依赖、相关知识点、父子层级自动关联 |
| **关系推断** | 从 AI 讲解文本自动提取知识点关系 |

### 导出与工具

| 功能 | 说明 |
|------|------|
| **多格式导出** | Markdown / HTML / Anki CSV / OPML / Notion CSV / JSON / 学习笔记 |
| **语音输入** | Web Speech API 语音转文字提问 |
| **TTS 语音合成** | SiliconFlow CosyVoice2 文字转语音 |
| **设置弹窗** | 在线配置 API Key / Base URL / Model |
| **深色模式** | 支持 6 套主题（默认/森林/紫/琥珀/红/石墨） |

## 技术栈

- **前端**: React 19 + Vite 8 + Tailwind CSS 4 + shadcn/ui + recharts
- **后端**: Node.js + Express 5 + OpenAI SDK（ESM 模块）
- **AI**: OpenAI 兼容 API（OpenAI / DeepSeek / SiliconFlow 等），SSE 流式
- **存储**: JSON 文件系统，原子写入（tmp+rename），三重备份机制
- **测试**: Node.js 内置 `node:test` + `node:assert`，476 测试用例

## 架构亮点

### 数据飞轮

```
AI 生成讲解（注入个性化上下文）
    ↓
用户学习行为（练习/考试/提问/时长/费曼）
    ↓
ErrorStateMachine + profileUpdater 增量更新画像
    ↓
下一次 AI 生成时使用更新后的画像
```

### 自适应引擎

- **ErrorStateMachine**: 按概念聚合错误频率（练习/考试/弱项/费曼缺口/未识别教学错误），3 次错误触发干预
- **AdaptivePromptInjector**: 将学习者类型、强弱项、跨计划薄弱点注入 AI prompt
- **InterventionRecommender**: 推荐复习/重教/简化/挑战/费曼等干预措施

### 持久化存储

| 文件 | 内容 |
|------|------|
| `data/learn/plans.json` | 计划索引 |
| `data/learn/plans/{id}.json` | 完整计划数据（知识点/历史/考试/快速测验） |
| `data/learn/user-profile.json` | AI 生成 + 增量更新的用户画像 |
| `data/learn/trash/index.json` | 回收站元数据 |

**备份机制**：双层备份策略，删除计划时自动清理所有备份文件
- 同目录 `.bak` 文件（快速恢复）
- `.backups-v2/` 独立备份（防止主目录误清）

## API 端点（60+）

| 分类 | 主要端点 |
|------|---------|
| **计划** | `GET/POST /api/learn/plans`，`DELETE /api/learn/plans/:id` |
| **回收站** | `GET/POST/DELETE /api/learn/trash`，`POST .../restore` |
| **知识点** | `POST /api/learn/plans/:id/topics`，`PUT .../reorder` |
| **AI 生成** | `POST .../generate/:topicId`（SSE 流式） |
| **追问** | `POST .../ask/:topicId` |
| **交互** | `POST .../interactive-start-sse/:topicId`，`POST .../interactive-continue-sse/:topicId` |
| **费曼分析** | `POST .../feynman-analyze/:topicId` |
| **事实核查** | `POST .../fact-check/:topicId`，`POST .../fact-check-auto-fix/:topicId` |
| **练习** | `POST .../exercises/:topicId/submit` |
| **组卷** | `POST .../exam/generate-stream`，`POST .../exam/:examId/submit` |
| **快速测验** | `POST .../quick-quiz`，`POST .../quick-quiz/submit` |
| **分析** | `POST .../analysis`，`POST .../core-topics`，`POST .../adaptive-analysis` |
| **薄弱点** | `POST .../weak-points`，`GET .../review-needs` |
| **知识图谱** | `GET .../graph`（支持 `?infer=true`） |
| **用户画像** | `GET /api/user-profile`，`GET /api/user-profile/summary`，`POST /api/user-profile/analyze` |
| **导出** | `GET .../export/anki`，`GET .../export/opml`，`GET .../export/notion`，`GET .../export/json`，`GET .../export/notes`，`GET .../export/bundle` |
| **TTS** | `POST /api/learn/tts` |

## 项目结构

```
study-assistant/
├── client/                              # React 19 前端
│   └── src/
│       ├── components/                  # PlanList / PlanView / TopicDetail / ExamPaperModal 等
│       ├── components/ui/               # shadcn/ui 组件（Button / Card / Input / Progress 等）
│       ├── pages/                       # UserProfile 用户画像页
│       ├── lib/                         # plan-context / theme-context / utils
│       └── styles/                      # globals.css + app.css（oklch 主题系统）
└── server/                              # Express 5 后端
    ├── engine/
    │   ├── learn-engine.js              # AI 生成核心（16 个导出函数）
    │   ├── learn-prompts.js             # 15 个 Prompt 模板 + buildDeterministicContext
    │   ├── adaptive-engine.js           # ErrorStateMachine + AdaptivePromptInjector + InterventionRecommender
    │   ├── user-profile.js              # 用户画像聚合 + 增量更新 + AI 分析
    │   ├── fact-checker.js              # 事实核查 + 自动修正
    │   ├── agent-dispatcher.js          # 多 Agent 路由
    │   ├── provider.js                  # OpenAI Provider（三级缓存）
    │   └── store/
    │       └── crud.js                  # 数据 CRUD 实现层
    ├── routes/
    │   ├── learn.js                     # 所有学习 API 路由（60+ 端点）
    │   └── user-profile.js              # 用户画像路由
    └── __tests__/                       # 476 测试用例
```

## 测试

```bash
cd server
node --test --test-concurrency=1 --test-force-exit "__tests__/*.test.js"
```

| 测试文件 | 覆盖内容 |
|----------|----------|
| `learn-engine.test.js` | 讲解/追问/互动/核心20%/费曼/测验/组卷 |
| `learn-store.test.js` | CRUD/层级/回收站/练习/标记 |
| `learn-prompts.test.js` | 15 个 prompt 模板完整性 |
| `provider.test.js` | 连接/哈希/缓存/稳定性 |
| `cache-diagnostics.test.js` | 缓存监控 |
| `data-consistency.test.js` | 数据一致性 |
| `edge-cases.test.js` | 边界情况 |
| `route-integration.test.js` | 路由集成 |
| `adaptive-engine.test.js` | 自适应引擎 |
| `agent-dispatcher.test.js` | 多 Agent 路由 |
| `data-flywheel.test.js` | 数据飞轮 |
| `export-engine.test.js` | 导出引擎 |
| `fact-checker.test.js` | 事实核查 |

## 配置 API Key

四种方式（从前到后优先级）：
1. 请求头 `x-api-key` / `x-api-base` / `x-api-model`
2. 请求体 `apiKey` / `baseURL` / `model`
3. 环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`
4. 前端设置弹窗（localStorage）

## 已知注意事项

- **Windows**: 测试必须串行（`--test-concurrency=1`），否则文件锁冲突
- **Express 5**: 通配符路由使用 `/{*splat}` 而非 `*`
- **HashRouter**: 前端使用 HashRouter（`/#/`），无需服务器配置即可刷新
- **数据安全**: 测试数据清理时谨慎操作，不要无条件调用 `store.deletePlan()`
