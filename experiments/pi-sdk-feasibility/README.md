# SillyRealms · Pi SDK 可行性实验

> 验证日期：2026-11-01；本目录是**可重复运行的隔离技术实验**，不是 SillyRealms 应用工程或正式 SDK 集成。结论见 [REPORT.md](REPORT.md)。

## 目录结构

```text
experiments/pi-sdk-feasibility/
├── README.md                 操作、限制与安全说明
├── REPORT.md                 实测证据、评估结论和下一步
├── package.json              单独的实验包，锁定 SDK 顶层版本
├── package-lock.json         完整依赖锁文件
├── tests/pi-sdk.test.mjs     本地 mock Server + 8 项 node:test
├── scripts/probe.mjs        无模型调用的 Session 隔离检查
├── scripts/mock-probe.mjs   可观察完整请求的调试脚本
└── results/test-output.txt  2026-11-01 的原始终端测试输出
```

## 前置条件与运行

- Node.js 22+、npm。
- 安装依赖时需要网络，执行自动化测试时**不需要任何云模型凭据，也不会向公有模型 API 发送请求**。全部网络模型请求都发往测试进程绑定的 `127.0.0.1` 本地 HTTP 端口。
- 从本目录运行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run probe
node scripts/mock-probe.mjs
```

`npm test` 使用 Node 内置 `node:test`，无第三方测试框架。真实执行证据见 `results/test-output.txt`；测试输出包含 macOS 临时目录路径和虚构提示词，不包含真实用户聊天、模型 API Key 或令牌。

### 安装异常说明

2026-11-01 实机在 `registry.npmmirror.com` 及 npm 官方 Registry 执行完整 `npm install` 时发生下载缓慢/安装超时，首次创建的 `node_modules/openai` 缺少 `index.mjs`，导致 mock 请求前报模块找不到。实验期间通过下载**确定版本 `openai@7.19.0`** 的 npm 官方 tarball 补齐本地、被 `.gitignore` 忽略的 `node_modules`，再执行 `npm install --package-lock-only --offline` 生成锁文件。

这不是产品逻辑失败，也不证明全新机器运行 `npm ci` 必然成功；**本轮并未验证从空目录执行 `npm ci` 的结果**。如果重新安装仍遇到网络问题，应处理 npm Registry 网络/缓存，而不是从报告中移除该限制。不要把 `node_modules` 或临时补包提交至 Git。

## 实验隔离与安全

- SDK 使用 `SessionManager.inMemory()`；在持久化特性测试中使用系统临时目录的 JSONL，再及时清理。不会改动用户的 `~/.pi`、真实世界卡或生产 SQLite。
- `DefaultResourceLoader` 关闭扩展、Skills、Prompt Templates、Context Files、主题发现，`noTools:'all'` 禁用 Pi 内置工具。
- 模型通过 `ModelRuntime` 注册在本地回环 HTTP mock endpoint，认证键为**固定的无效测试字符串**。
- `REPORT.md` 清楚区分 **实测通过**、**发现行为限制**、**尚未验证**。不可把本地 SSE mock 等价于真实 Provider 兼容性、成本或叙事效果。

## 相关文档

- [产品与技术方案](../../docs/technical/architecture.md)
- [预设与 Prompt 组成](../../docs/design/configuration.md)
- [Context 组装](../../docs/design/context.md)
- [SQLite/Entry 树](../../docs/technical/storage.md)
- SDK 官方说明：https://pi.dev/docs/latest/sdk
- 会话管理 API 与 Session 投影：https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core
