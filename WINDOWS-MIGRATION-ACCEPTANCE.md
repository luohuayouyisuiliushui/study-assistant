# Study Assistant Windows 迁移验收记录

记录更新时间：2026-07-17 11:45（Asia/Shanghai）

## 结论

Windows 迁移主体已完成。项目已在 Windows 11、Windows PowerShell 5.1、Node.js 24.18.0、npm 11.16.0 环境完成依赖安装、前端构建、开发/生产启动、HTTP 访问和完整进程树停止验证。

用户已取消关机要求；本次没有执行或安排关机。

## 完成的改动

- 新增 `scripts/windows/`：
  - `common.ps1`：环境检测、端口检查、npm 调用、PID/启动时间状态管理。
  - `doctor.ps1`：检查 Node.js、npm、端口、`.env` 是否存在及依赖状态，不读取密钥内容。
  - `setup.ps1`：安装根目录、服务端和客户端依赖，可选构建。
  - `dev.ps1`：启动 Express 与 Vite 开发环境。
  - `start.ps1`：构建并启动生产模式，或用 `-SkipBuild` 复用已有产物。
  - `stop.ps1`：校验 checkout、PID 和启动时间后终止完整 npm/Node.js 进程树。
- 新增五个根目录 `.cmd` 入口，并让 `windows-doctor.cmd`、`windows-setup.cmd` 成功后停留以便双击用户查看结果。
- 根 `package.json` 新增 `windows:*` npm 命令；根、服务端、客户端及三个 lockfile 的版本统一为 `1.8.0`。
- 更新 `README.md` 与 `AGENTS.md` 的 Windows 用法、故障排查和技术说明。
- 修复 Vite 的 `dayjs` 前缀 alias：仅精确匹配 `dayjs`，避免 Windows 下把 Mermaid 的 `dayjs/plugin/*` 错误解析到 `dayjs.min.js/plugin/*`。
- 发布分支补齐远程 `main` 已引用但未跟踪的 `client/src/components/RegenerateDialog.jsx`，否则干净检出会在构建时报告模块缺失。
- 补齐 `TopicDetail` 测试中的 `inferRelations`/`getPlan` API mock，并为 `RegenerateDialog` 增加交互测试，使 client 50 个测试全部通过。
- 让回收站定时器 `unref()`，避免一次性 CLI 清理命令完成后被定时器永久挂住。
- 收紧测试计划清理：必须先匹配测试式名称；有 Detail 或大量 Topic 的计划受到保护，避免误删真实的轻量计划。
- Windows 进程状态增加 checkout 校验和并发删除重试，避免不同副本互相覆盖状态以及 start/stop 同时清理状态文件时发生竞态。

## 验证结果

| 检查 | 结果 |
|---|---|
| `windows-setup` 实际安装 | 通过；根、server、client 依赖安装完成，npm 报告 0 vulnerabilities |
| 6 个 PowerShell 文件的 5.1 语法解析 | 通过 |
| `windows-doctor` 完整检查（含端口） | 通过；3001/5173 可用，依赖完整；仅确认 `server/.env` 存在，未读取内容 |
| `windows-setup.cmd -WhatIf -Build` | 通过；双击入口停留行为已验证 |
| 六个 package/lock 顶层版本 | 全部为 `1.8.0` |
| `npm run build` | 通过；Vite 8.1.3 成功转换 4603 个模块 |
| 开发模式烟测 | 通过；3001 与 5173 同时监听，状态记录为 `development` |
| 生产模式烟测 | 通过；`GET /` 返回 200 和 React 根节点，`GET /api/learn/plans` 返回 200 JSON |
| `windows-stop` 开发/生产停止 | 通过；完整 npm/concurrently/Vite/Node 树被终止，无状态文件和端口残留 |
| 改动文件针对性 oxlint | 通过；`client/vite.config.js` 无问题，服务端改动没有新增 error |
| client 全量 lint | 退出 0；存在原项目已有 warning |
| 数据完整性检查 | 退出 0；报告 147 个原快照已有的索引/文件不一致项，未自动修复 |
| client 全量测试 | 通过；7 个测试文件、50 个测试全部通过 |
| 测试计划清理专项测试 | 通过；13/13，覆盖异步删除、dry-run 和真实计划名称防误删 |
| server 全量 lint | 未通过；未改动模块中已有多处 `no-undef`，例如 `AdaptivePromptInjector`、`saveCoreAnalysis`、`updateTopic` |
| server 全量测试 | 未通过；主要因测试仍同步使用已经异步化的 `createPlan()`，另有原数据一致性与网络错误文案断言问题 |

全量失败的相关测试和业务文件在 Linux 基线快照中已是相同内容，不是 Windows 启动脚本引入的回归。迁移涉及的构建、启动、停止和 HTTP 路径均已独立实测通过。

## 数据与安全

- 测试完成后，已从 `C:\.a\study-assistant - Linux\server\data` 恢复 `server/data`。
- 恢复后逐文件 SHA-256 比较：源与目标均为 619 个文件，差异为 0。
- 未读取、打印或写入 `server/.env` 内容；未记录任何 API Key。
- `windows-stop` 在另一个控制台中使用 `taskkill /T /F`。这是因为 Windows 不能可靠地跨控制台转发 `Ctrl+C`；需要优雅退出时，应在原启动窗口按 `Ctrl+C`。项目的 JSON 写入使用原子写入与备份机制。

## Git 状态

用户随后初始化了 Git，现已关联可信远程仓库：

- `origin`：`https://github.com/luohuayouyisuiliushui/study-assistant.git`
- 基线：`origin/main`（关联时为 `a73b45c`）
- 发布分支：`luohuayouyisuiliushui/feat-windows-migration`
- 原工作目录中迁移前已有的其他本地改动保留在 `luohuayouyisuiliushui/local-uncommitted-snapshot` 工作树，没有混入 Windows 迁移提交。

发布分支从远程 `main` 创建，未直接提交或强推 `main`。

## 使用方式

双击顺序：

1. `windows-doctor.cmd`
2. `windows-setup.cmd`
3. `windows-dev.cmd`，访问 `http://localhost:5173`

生产模式运行 `windows-start.cmd`，访问 `http://localhost:3001`。优雅停止请在启动窗口按 `Ctrl+C`；从另一个终端停止可运行 `windows-stop.cmd`。

## 已知遗留项

- server 测试与当前异步 Store API 不同步；server lint 也有既有未定义引用，应作为独立修复任务处理。
- 原始数据快照包含 147 个一致性告警；为避免擅自改变用户数据，本次没有运行 `check:data:fix`。
