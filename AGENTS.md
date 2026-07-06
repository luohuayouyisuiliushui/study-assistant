# AGENTS.md — 多人 vibecoding 协作规则

将此文件放在项目根目录（`.reasonix/AGENTS.md` 或 `AGENTS.md`），AI Agent 每次启动时自动加载。

---

## 🔴 强制规则

### 1. 分支纪律——绝不直接改主分支

- 每次改动前，先 `git branch --show-current` 确认当前分支
- 除非明确指示，绝不直接提交到 `main` / `master` / `develop`
- 每个任务对应一个独立 feature/fix 分支
- 分支命名规范：`{作者昵称}/{改动类型}-{简短描述}`
  - 例：`alice/feat-add-login`、`bob/fix-typo-in-readme`

### 2. 先拉后改——避免冲突

- 每次工作前先 `git pull --rebase` 拉取最新
- 改动涉及**共享配置文件**时（`.env.example`、依赖声明、CI 配置等），必须 ask 用户确认

### 3. 保持改动范围最小与代码质量

- 不做任何请求之外的文件修改（包括格式化空格、调整顺序等）
- 如果发现应该修复的附带问题，先 ask 再动手
- 不自动整合同一个文件里别人的改动——那是人工该做的事
- **避免不必要的动态 import**：同一模块的常量应在文件顶部一次性静态导入（`import { X } from './module.js'`），不要用 `await import()`。动态 import 仅用于条件加载/懒加载场景

### 4. 提交信息可追溯

- commit message 格式（供队友阅读）：

  ```
  type(scope): 一句话总结

  - 具体改了哪几个文件
  - 改动原因
  - 关联 issue/PR 号（如有）
  ```

- type 使用：`feat` / `fix` / `refactor` / `docs` / `chore`
- 示例：

  ```
  feat(auth): 添加 GitHub OAuth 登录

  - src/auth/github.ts: 新增 OAuth callback 处理
  - src/pages/login.tsx: 添加"使用 GitHub 登录"按钮
  - Closes #42
  ```

### 5. 不改他人未提交的代码

- 不修改、不删除、不移动 `git status` 中显示的 `unstaged` / `uncommitted` 文件（那是队友正在做但还没提交的改动）
- 如果必须改，先 ask 用户确认

### 6. 推送前构建/测试通过

- 提交前跑对应项目的测试命令（`npm test` / `go test` / `pytest` / `cargo test` 等）
- 如果测试失败，自己先排查修复，不要提交坏的代码
- 检查是否有 lint 错误
- **每增功能必加/改测试**：新功能必须新增测试用例覆盖成功路径 + 边界情况 + 错误处理；修改现有逻辑必须更新已有测试；修改 prompt/engine/store 等模块必须在对应 `*.test.js` 中添加测试
- **多文件改动后自动运行 review**：修改 ≥3 个文件或新增重要功能后，主动运行 `review` 子 agent 做质量检查，在提交前发现遗漏的边界条件、拼写错误、安全问题

### 7. 主动报告潜在的冲突区

- 如果你的改动和 `git log` 中最近同文件改动有关联，在回复里指出
- 涉及数据库迁移、API 接口签名、包依赖版本升级等影响面广的变更，必须 ask

### 8. PR 描述让队友秒懂

创建 PR 时包含以下内容：

- **做了什么**（why + what）
- **改动清单**（改了哪些文件）
- **测试方式**（手动测试流程 / 自动化测试结果）
- **截图/录屏**（如果有 UI 变化）
- **注意事项**（有没有破坏性变更、需要 teammate 配合什么）

### 9. AI 优先自己动手解决问题

- 接到问题解决类请求时，AI 默认优先自己动手完成（读写文件、执行命令、分析调试等），不需要先问"要不要我帮你改"
- 只有当 AI 判断让用户操作效率明显更高时（如需要输入密码、手动操作 GUI、物理操作等），才把操作交给用户，并说明理由

---

## 推荐工作流

### 日常开发流

```
1. git checkout -b alice/feat-add-login
2. git pull --rebase origin main
3. 写代码 → 跑测试 → lint 检查
4. 多文件改动时先运行 review 子 agent 做质量检查
5. git add <最小化改动的文件>
6. git commit -m "feat(login): ..."
7. git push origin alice/feat-add-login
8. 创建 PR（填写模板）
9. @队友 review
```

### 自动双向同步（会话启动/结束时执行）

每次 AI 会话启动时和任务结束后，执行以下双向检查：

```powershell
# 1. 更新远程追踪
git fetch origin

# 2. 检查本地是否领先远程（有未推送的提交）
git log origin/main..HEAD --oneline
# 如果有输出 → 本地有改动未推送，自动推送

# 3. 检查远程是否领先本地（有来自他人的新提交）
git log HEAD..origin/main --oneline
# 如果有输出 → 远程有外部变更，拉取到本地

# 4. 检查工作目录是否有未提交的变更
git status --short
# 如果有 → 先提交后再按第 2 步推送
```

### 版本号规则（自动决定，不问用户）

按语义化版本，依据本次改动的大小自动决定：

| 改动类型 | 示例 | 版本变化 |
|---|---|---|
| 小修补（bug fix、文案调整、样式微调） | 0.0.1 → 0.0.2 | 递增 patch |
| 新增功能（新组件、新特性） | 0.1.0 → 0.2.0 | 递增 minor |
| 重大重构或架构变化 | 1.0.0 → 2.0.0 | 递增 major |

三个 `package.json`（根 / server / client）同步更新。

---

## 项目约定

### 知识点图谱关系提取

在 topic detail 的 AI 生成内容中，`## 与相关知识点的联系` 段落包含知识点关系信息。实现要点：

1. **段落定位**：用正则 `/^#{2,4}\s*与相关知识点的联系\s*$/m` 匹配多种标题变体
2. **条目解析**：匹配 `- **Title**：description` 格式
3. **标题匹配**：先精确匹配（normalize 后），再模糊匹配（substring inclusion）
4. **关系类型推断**：从 description 中关键词推断类型（prerequisite/extends/exampleOf/contrasts/buildsOn/references）
5. **方向确定**：前置依赖和构建于类的关键词，链接方向是反向的（被引用的知识点 → 当前知识点）

提取结果可作为 `buildKnowledgeGraph` 的补充，通过 `?infer=true` 参数控制是否显示推断边。
