# Study Assistant

AI 学习助手 —— 告诉 AI 你想学什么，它帮你拆解知识点、生成讲解、出题考试、追踪薄弱环节。

## 它能做什么

你创建一个学习计划（比如"Python 入门"），添加几个知识点（比如"变量与类型"、"条件判断"、"循环"），然后：

1. AI 为每个知识点生成**详细讲解**（含图表、例题、练习题）
2. 你可以**追问**任何不理解的地方
3. 用**7 种互动模式**学习（费曼教学、挑战找错、分段引导等）
4. 做**练习和测验**，AI 自动批改
5. 查看**学习分析**，知道哪些知识点还没掌握
6. 导出为 **Anki 卡片**、Markdown 等格式

**而且它会越用越懂你：** 每次你做练习、提问、学习的时长，都会被记录并更新你的学习画像。下次生成讲解时，AI 会自动调整难度和讲解风格——薄弱点会反复强化，已经掌握的会快速带过。

## 快速开始

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`，在设置里填入 API Key（支持 OpenAI / DeepSeek / SiliconFlow 等）即可使用。

### Windows 快速开始

要求 Windows 10/11 和 Node.js 20.19+（或 22.12+）。在项目根目录依次双击：

1. `windows-doctor.cmd`：检查 Node.js、npm、端口和依赖状态
2. `windows-setup.cmd`：安装根目录、服务端和客户端依赖
3. `windows-dev.cmd`：启动开发环境，然后访问 `http://localhost:5173`

前两个检查/安装窗口执行完会停留，阅读结果后按任意键关闭。

生产模式使用 `windows-start.cmd`，它会先构建前端，再由服务端在 `http://localhost:3001` 提供完整应用。启动窗口中按 `Ctrl+C` 可正常停止；也可在另一个终端运行 `windows-stop.cmd`，脚本会校验已记录的 PID 和启动时间，再用 `taskkill /T /F` 终止完整的 npm/Node.js 进程树，避免残留后台进程。Windows 无法从另一个控制台可靠转发 `Ctrl+C`，如需优雅退出请在原启动窗口操作。

这些 `.cmd` 入口会为当前进程使用 PowerShell `ExecutionPolicy Bypass`，不会修改系统或用户的永久执行策略。也可以在 PowerShell 中直接运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\doctor.ps1
.\scripts\windows\setup.ps1
.\scripts\windows\dev.ps1
```

常见问题：

- 提示端口 3001 或 5173 被占用：先运行 `windows-stop.cmd`；若不是本项目进程，可用 `Get-NetTCPConnection -State Listen -LocalPort 3001,5173` 找到 PID。
- 缺少 API Key：可直接在应用设置中填写；也可将 `server/.env.example` 复制为 `server/.env` 后填写，切勿提交真实 Key。
- `npm.ps1` 被执行策略阻止：Windows 脚本固定调用 `npm.cmd`，请使用上述 `.cmd` 或 `.ps1` 入口。
- 数据位置：学习数据保存在 `server/data/`，缓存位于 `server/cache/`；升级或重装前请备份 `server/data/`。

## 截图

<!-- 截图占位 -->

## 使用方法

### 1. 创建学习计划

点击"新建计划"，输入计划名称（如"JavaScript 基础"），然后添加知识点列表。支持手动输入，也支持从 TXT/MD/CSV 文件批量导入。

### 2. 生成讲解

点击知识点旁的"生成"按钮，AI 会实时流式输出讲解内容，包含：
- 核心概念解释
- Mermaid 图表
- 代码示例
- 例题与练习题

### 3. 互动学习

选择一种互动模式深入学习：
- **费曼学习**：你向 AI 讲解，AI 追问你不懂的地方
- **挑战模式**：AI 故意讲错，看你能不能发现
- **分段讲解**：AI 讲一段停一下，等你反馈再继续

### 4. 测验与复习

完成学习后，可以：
- 做随堂练习（AI 自动批改）
- AI 智能组卷考试
- 查看薄弱点分析
- 导出 Anki 卡片复习

### 5. 个性化推荐

系统会自动收集你的学习数据：
- 练习正确率、错题分布
- 学习时长、提问频率
- 费曼讲解中的理解缺口

基于这些数据，AI 会：
- 自动识别你的**强项和弱项**
- 推荐下一步**该学什么、该复习什么**
- 在生成讲解时**注入你的个性化上下文**（比如"你之前在闭包上出过错，这里再强调一下"）

---

<details>
<summary>技术细节（开发者）</summary>

### 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + Vite 8 + Tailwind CSS 4 + shadcn/ui |
| 后端 | Node.js + Express 5 + OpenAI SDK |
| AI | OpenAI 兼容 API，SSE 流式 |
| 存储 | JSON 文件系统，原子写入 + 双层备份 |

### 运行测试

```bash
cd server && npm test
```

### API 端点

60+ 端点，涵盖计划管理、AI 生成、交互教学、测验组卷、学习分析、知识图谱、数据导出等。详见 `server/routes/learn.js`。

### 项目结构

```
client/          # React 前端
server/
├── engine/      # AI 核心（讲解/追问/自适应/核查）
├── routes/      # API 路由
└── __tests__/   # 测试用例
```

### 已知限制

- Windows 测试需串行（`--test-concurrency=1`）
- 前端使用 HashRouter（`/#/`）

</details>
