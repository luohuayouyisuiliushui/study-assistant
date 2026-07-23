# 2026-07-24 语音输入会话记录

## 会话目标

用户最初讨论了 TTS，随后明确需要的是语音转文字来提高文本输入效率。最终要求是：新增用户语音转文字输入，同时保留已经存在的 TTS 能力和接口。

## 已完成工作

### 浏览器语音转文字

- 新增 `client/src/hooks/useSpeechRecognition.js`，封装浏览器 `SpeechRecognition` 与 `webkitSpeechRecognition`。
- 识别语言固定为 `zh-CN`，支持中间转写结果，并把转写追加到开始录音前已有的输入文本。
- 互动教学输入由 `TopicDetail.jsx` 改为使用共享 Hook。
- `QAPanel.jsx` 的扩展追问输入框新增麦克风按钮。
- 错误反馈输入框新增麦克风按钮。
- 不支持 Web Speech API 的浏览器不显示麦克风按钮；麦克风权限、设备、无语音和网络错误以行内提示显示。
- 发送追问或互动反馈、执行快捷互动、进入/退出互动、提交错误核对时都会停止当前识别，避免隐藏输入继续被写入。
- 应用没有新增音频上传后端；识别由用户浏览器提供的 Web Speech API 执行。

### TTS 兼容性

- 保留现有 `textToSpeech` API 和服务端 TTS 路由。
- 本次没有删除、替换或禁用 TTS；语音转文字是独立的输入效率功能。

### 学习时长 UTC 修复

- `server/engine/store/crud.js` 以 `toISOString()` 记录学习时长日期。
- `server/engine/user-profile.js` 原先按本地日期筛选日志，在东八区零点到 UTC 零点之间可能把 UTC 的未来日期视为有效。
- 日期过滤已统一为 UTC 日期；`server/__tests__/batch6-core.test.js` 使用 UTC 相对日期构造回归数据。

## 测试与验证

| 范围 | 结果 |
|---|---|
| 新增 QAPanel 语音测试 | 4/4 通过：转写追加、停止录音、无浏览器支持、权限错误 |
| Client 全套 | 17 个测试文件，118/118 通过 |
| Client 生产构建 | `npm run build --prefix client` 通过 |
| Server 全套 | 188 个 suite，603/603 通过 |
| 数据完整性 | `npm run check:data --prefix server` 通过 |
| Lint | Server 与 Client 均退出成功；仅有既有非阻塞 warning |

## 版本与提交

- 所有 package manifest 和 lockfile 已从 `1.12.5` 升级到 `1.13.0`。
- 功能提交：`af39ef7 feat(voice-input): 新增浏览器语音转文字输入`。
- 功能提交时工作区干净；本地分支相对 `origin/codex/fix-audit-findings` 领先一个提交。

## 外部限制与剩余风险

- 本机会话中的 `git pull --rebase` 与 `git push` 均因代理 `127.0.0.1` 无法连接 GitHub 而失败。本地提交未丢失，网络恢复后可推送。
- Web Speech API 的可用性和识别质量取决于浏览器、麦克风权限和浏览器服务；自动化测试使用了浏览器 API mock，未进行真实硬件麦克风录音。
- TTS 已保留，但本会话没有使用具备语音能力的 Provider 进行新的真实 TTS 烟测。
