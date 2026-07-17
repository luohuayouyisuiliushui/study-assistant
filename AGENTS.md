# AGENTS.md

## 强制规则

### 1. 分支纪律

- 每次改动前 `git branch --show-current` 确认当前分支
- 不直接提交到 `main`，每个任务对应独立 `{作者}/{type}-{描述}` 分支
- 例：`reasonix/fix-store-duplication`

### 2. 先拉后改

- 每次工作前 `git pull --rebase` 拉取最新
- 涉及 `.env.example`、依赖声明、CI 配置等共享文件时，先 ask 确认

### 3. 不改他人未提交的代码

- `git status --short` 中 `M` / `??` 的文件是队友正在做但还没提交的改动，不要动
- 如果必须改，先 ask

### 4. 提交格式

```
type(scope): 一句话总结
- 改了什么文件，为什么
```

type: `feat` / `fix` / `refactor` / `docs` / `chore`

### 5. 版本号（自动递增，不问）

| 改动 | 版本 |
|---|---|
| bug fix / 文案 / 样式微调 | patch (1.6.2 → 1.6.3) |
| 新功能 / 新组件 | minor (1.6.2 → 1.7.0) |
| 重大重构 / 架构变化 | major (1.6.2 → 2.0.0) |

三个 `package.json`（根 / server / client）同步更新。

---

## 项目架构

```
study-assistant (monorepo, v1.8.1)
├── server/   Express 5 + OpenAI SDK  |  端口 3001
├── client/   React 19 + Vite 8      |  端口 5173 (dev)
```

**后端没有数据库**，所有数据存 `server/data/` 下的 JSON 文件（原子写入 + 双层备份）。**应用代码没有 TypeScript**，前后端是纯 JS/JSX；Windows 启动与诊断入口使用 PowerShell/CMD。

关键模块层级：
```
server/engine/store/storage.js    ← 持久化基础设施 (writeAtomic, readJSON)
server/engine/store/crud.js       ← CRUD 操作 (从 storage.js 导入)
server/engine/learn-store.js      ← barrel 重导出 (所有上层通过它导入)
server/engine/learn-engine.js     ← 核心引擎 (内容生成 + 图像 + TTS)
server/engine/exam-engine.js      ← 试卷引擎 (生成/评分/练习)
server/engine/interactive-teacher.js  ← 交互教学引擎 (7 种模式 + 错误检测)
server/engine/learning-analyzer.js    ← 学习分析引擎 (分析/复习/测验/费曼)
server/routes/learn.js            ← 主路由 (计划/知识点 CRUD + 分析)
server/routes/content.js          ← 内容教学路由 (生成/交互/TTS/追问)
server/routes/assessment.js       ← 评估路由 (考试/事实核查/自适应)
server/routes/export.js           ← 导出路由 (Anki/OPML/Notion/JSON/MD)
server/routes/middleware.js       ← 共享中间件 (getProvider, getDispatcher)
```

**前端 shadcn/ui 是 copy-paste** — `client/src/components/ui/` 下的组件是手写的，不是 npm 包。不要用 `npx shadcn-ui add` 添加组件，直接复制 `*.jsx` 文件。

领域术语表在 `CONTEXT.md`，AI 操作代码时用它统一命名。

---

## 命令速查

```bash
npm install          # 安装依赖（自动执行 server + client 的 postinstall）
npm run dev          # 同时启动前后端 (端口 3001 + 5173)

# 测试
npm run pretest      # 清理测试数据 (必须先跑)
npm test             # 全部测试 (server: node --test, client: vitest)

# 单测
node --test server/__tests__/storage-logic.test.js
npx vitest run client/src/test/PlanView.test.jsx

# Lint
npx oxlint                        # client (已配置 react + oxc 插件)
cd server && npx oxlint           # server (已配置 no-unused-vars, no-undef)

# 数据完整性
cd server && npm run check:data       # 检查
cd server && npm run check:data:fix   # 检查 + 自动修复
```

**重要：** server 测试需要 `server/.env` 中配置有效的 `OPENAI_API_KEY`，否则涉及 AI 调用的测试会挂起超时。复制 `server/.env.example` 为 `server/.env` 并填入 Key。

Server 使用 Node.js 内置 `node --test --test-concurrency=1`（串行，防止 JSON 文件竞态），Client 使用 `vitest + jsdom`。

---

## 项目约定

### ESM 导入

所有文件是 ESM (`"type": "module"`)，导入必须带 `.js` 后缀：

```js
import { writeAtomic } from './store/storage.js';  // ✔
import { writeAtomic } from './store/storage';     // ✘ (Node ESM 要求后缀)
```

### 知识点图谱关系提取

AI 生成的 Detail 中 `## 与相关知识点的联系` 段落包含知识点关系，提取规则：

1. 正则定位：`/^#{2,4}\s*与相关知识点的联系\s*$/m`
2. 解析 `- **Title**：description` 格式
3. 标题匹配：先精确匹配，再模糊匹配（substring inclusion）
4. 从 description 关键词推断关系类型：prerequisite / extends / exampleOf / contrasts / buildsOn / references
5. 前置依赖类关键词的链接方向是反向的（被引用知识点 → 当前知识点）
6. 通过 `?infer=true` 参数控制是否显示推断边

### 路由拆分约定

- 路由模块放在 `server/routes/`，每个模块 export default Router
- 在 `server/index.js` 中用 `app.use('/api/learn', router)` 挂载
- 共享中间件（getProvider, getDispatcher）在 `server/routes/middleware.js`
- 新建引擎模块时，从 `learn-engine.js` 重导出以保持向后兼容

### 安全约定

- CORS 仅允许 localhost 来源（`server/index.js`）
- Express 全局异常处理器统一返回 JSON 错误
- API Key 优先级：`x-api-key` 请求头 > `req.body.apiKey` > 环境变量
- 路由参数（数组、整数）必须校验类型和范围

### 测试约定

- 新增模块必须加测试：`server/__tests__/<module-name>.test.js` 或 `client/src/test/<Component>.test.jsx`
- Server 纯逻辑测试用 `node --test`，不需要 API Key
- Server AI 测试需 `OPENAI_API_KEY`，跳过用 `--test-skip-pattern`
- Client 测试用 `vitest + @testing-library/react`，需要 Router 包裹时用 `MemoryRouter`
- `setup.js` 提供 IntersectionObserver、matchMedia 等 jsdom mock
