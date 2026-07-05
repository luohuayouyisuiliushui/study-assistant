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

### 3. 保持改动范围最小

- 不做任何请求之外的文件修改（包括格式化空格、调整顺序等）
- 如果发现应该修复的附带问题，先 ask 再动手
- 不自动整合同一个文件里别人的改动——那是人工该做的事

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

---

## 推荐工作流

```
1. git checkout -b alice/feat-add-login
2. git pull --rebase origin main
3. 写代码 → 跑测试 → lint 检查
4. git add <最小化改动的文件>
5. git commit -m "feat(login): ..."
6. git push origin alice/feat-add-login
7. 创建 PR（填写模板）
8. @队友 review
```
