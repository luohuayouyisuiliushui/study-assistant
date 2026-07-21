# ROADMAP — 展望与待实现功能

此文件记录项目未来可能实现的功能和方向，与当前已有功能区分开。

## 互动教学模式扩展

`server/engine/user-profile.js` 的 `ALLOWED_MODES` 中已预留以下三种模式枚举，但前端 UI、路由和引擎逻辑尚未实现：

- **Debate（辩论模式）**：AI 扮演反方，针对学生的观点提出质疑和反例，训练论证能力
- **Socratic（苏格拉底式）**：AI 只提问不回答，通过层层追问引导学生自行推理出结论
- **Analogy（类比教学）**：AI 用日常生活中的比喻和类比来解释抽象概念

实现要点：
- `server/engine/interactive-teacher.js` 中新增处理函数
- `server/routes/content.js` 中新增路由
- 前端 `InteractivePanel.jsx` 中新增模式选择入口
- 需要定义各模式的 system prompt 和会话状态机

## 离线缓存策略（Service Worker）

当前所有内容依赖 AI API，断网时完全不可用。

方向：
- 用 Service Worker 拦截已生成的 Detail 讲解请求，缓存到 Cache Storage
- 断网时从 Cache Storage 提供已缓存的讲解内容，保证可阅读
- 练习提交时暂存到 IndexedDB，联网后自动补提交批改
- 知识点列表、计划索引等轻量数据也可 SW 缓存
- 提示用户"当前为离线模式，部分功能受限"

## 数据版本迁移

`server/data/` 下的 `plans.json` 和 `user-profile.json` 的 schema 随迭代可能变化，目前无迁移机制。

方向：
- 在 `server/data/learn/plans.json` 和 `user-profile.json` 顶层增加 `dataVersion` 字段（如 `"1"`）
- `server/index.js` 启动时检查版本号，不匹配则运行对应迁移脚本
- 迁移脚本放在 `server/migrations/` 目录，按版本号命名（如 `v1-to-v2.js`）
- 迁移逻辑：读取全量数据 → 按需转换字段 → 原子写入
- 备份旧数据后再执行迁移，迁移失败时自动回滚

## 纯本地模型后端

当前强制依赖云端 AI API（OpenAI / DeepSeek / SiliconFlow），对隐私敏感或离线场景不够友好。

方向：
- 在 Provider 抽象层新增 `LocalProvider` 子类
- 对接 [Ollama](https://ollama.com) REST API（兼容 OpenAI 格式，可直接复用现有 Provider）
- 或对接 [llama.cpp](https://github.com/ggerganov/llama.cpp) 的 HTTP server
- 模型选择和配置在前端设置面板中与云端 API 并列
- 规划中可考虑先兼容 Ollama（API 格式最接近），再支持其他后端

## HTML 离线包导出

当前导出格式（Anki/OPML/Notion/MD/JSON）都假设接收方有对应软件。缺少一份"打开即看"的存档格式。

方向：
- 新增 `generateHTMLBundle(topic)` 导出函数，输出一个自包含的 `.html` 文件
- 将 Topic 的 Detail Markdown 渲染为 HTML（含 KaTeX 公式、Mermaid 图表静态化）
- Mermaid 图表：利用 `mermaid-cli` 或服务端 `puppeteer` 渲染为内嵌 SVG
- KaTeX 公式：服务端渲染为 HTML，无需客户端 JS
- 样式内嵌，单个 HTML 文件即可打开阅读，无需网络

## 已知缺陷（已修复）

- ~~**`stepwise-challenge` 和 `realtime-challenge` prompt 未导入**：路由层接受这两个模式，但 `interactive-teacher.js` 中对应的 prompt 常量未导入，运行时抛出 `ReferenceError`。~~ **已在 v1.9.1 修复**：在 `interactive-teacher.js` 第 15-16 行补入了 `STABLE_INTERACTIVE_STEPWISE_CHALLENGE_PROMPT` 和 `STABLE_INTERACTIVE_REALTIME_CHALLENGE_PROMPT`。

## 其他可能方向

- **间隔重复（Spaced Repetition）**：基于 SM-2 算法安排复习计划，类似 Anki
- **多语言界面**：除中英文外支持更多 UI 语言
- **协作学习**：多个用户共享计划、对比学习进度
- **数据看板增强**：更多维度（按计划、按标签、按时段）的学习统计可视化
