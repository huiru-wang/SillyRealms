# Pi SDK 技术可行性实测评估

> 评估日期：2026-11-01；项目：SillyRealms；技术验证对象：`@earendil-works/pi-coding-agent@1.4.0`。
>
> 状态：**完成离线/本地 mock 验证；真实 Provider 与生产 SQLite 集成仍需下一阶段验证**。
> 可重复脚本：[tests/pi-sdk.test.mjs](tests/pi-sdk.test.mjs)，结果：[test-output.txt](results/test-output.txt)

## 结论与 Go / No-Go

**有条件 Go：可以将 Pi SDK 用作模型调用、流式事件和取消执行的底座，下一阶段允许开始 SQLite → Context → Pi → SQLite 的最小端到端工程 PoC。**

**No-Go：不可直接采用 Pi 默认 SessionManager 文件作为 SillyRealms 的权威历史；也不可承诺任意预设节点的消息角色/位置都能被所有 Provider 原样发送。** 当前自定义 Prompt Builder 与 Pi 最终消息投影之间必须有专用适配层和请求快照测试。

- **已验证可行：** 固定自定义模型地址、独立资源加载、关闭全部工具、内存会话、分叉父链投影、显式恢复指定叶子、生成时 SSE 事件、结束事件、取消执行和以公开低层 `prepareRequest` hook 覆盖本轮模型 Context。
- **验证到真实限制：** ①从原始 Entries 恢复时，Pi 默认采用最后追加节点作为叶子，需要显式 `branch(active_leaf_entry_id)`；②SDK 即使提供自定义 system prompt 仍自动增加 `<cwd>` 节；③对于所测的 `openai-completions` 适配器，排在 `chatHistory` 后的 `system` 节点被合并到**开头的 system 消息**，而同位置的 `user` 文本保持原顺序。
- **未验证、不能宣称通过：** 真实模型平台和网络流式稳定性、Provider 兼容矩阵、token 预算/成本、SQLite 数据库读写及事务、Pi 进程重启后的项目恢复、万轮长篇对话、性能生产负载、多角色秘密可见性、模型质量与状态 Agent 语义结算。

## 测试环境和证据等级

| 项目 | 实测/事实 |
| --- | --- |
| 主机 | macOS arm64 |
| Node | v22.23.2 |
| npm | 10.9.8 |
| Pi SDK | `@earendil-works/pi-coding-agent@1.4.0`；实验目录 `package.json` 和 `package-lock.json` |
| 调用对象 | 仅 localhost 的 OpenAI Chat Completions SSE 模拟端点，没有调用收费模型 |
| 验证方式 | Node 原生 `node:test` + 临时内存会话 + 请求捕获/事件断言 |
| 测试结果 | **8/8 PASS，0 FAIL**；完整日志在 `results/test-output.txt` |

`SessionManager` API 与插件接口依据本次安装的 **1.4.0 类型声明和运行时代码**核对；报告中的特定行为来自实测。外部文档仅为补充来源：

- Pi SDK：https://pi.dev/docs/latest/sdk
- Session 及恢复接口：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts
- Model 兼容端点：https://pi.dev/docs/latest/models

## 实测矩阵

| # | 验证对象 | 结果 | 证据与含义 |
| --- | --- | --- | --- |
| 1 | 内存 Session、从公共祖先分叉、按当前叶子提取消息 | **PASS** | `getBranch` / `buildSessionContext` 仅包含选定路径；导入原始 entries 后默认选择最后追加叶子，手动 `branch()` 恢复正确路径 |
| 2 | Pi 自带 JSONL 文件 reopen | **PASS（非目标存储）** | `SessionManager.create` → `appendMessage` → `open` 恢复，但 SQLite 不是这里的受测来源 |
| 3 | 不加载工具/扩展/Skills/Context 文件和注入自定义主指令 | **PASS，带附加内容** | `noTools:'all'` + `DefaultResourceLoader` 隔离成功；`systemPrompt` 出现附加的 `<cwd>` |
| 4 | 自定义 mock 模型、流式响应与最终 Agent settled | **PASS** | 捕获 `POST /v1/chat/completions`，从种子历史 + 本次用户输入发送，合并两个 SSE text delta 为完整回复，收到 `agent_settled` |
| 5 | 通过 `agent.prepareRequest` 替换发送给模型的 Context；在历史末尾放 `user` 文本 | **PASS** | 最终请求顺序严格为 system → user 开局 → user 当前输入 → user 后置，证明可以在这一 Provider 下精确注入该角色 |
| 6 | 在历史末尾放 `system` 文本 | **明确限制（测试 PASS）** | 发给 OpenAI 兼容 mock 的真实请求将 `POST_HISTORY_SYSTEM` 合并进开头 system，**失去历史之后的位置语义**；符合该适配器的系统消息规范化方式 |
| 7 | 流式过程中 abort | **PASS** | 只产生一次 mock 请求，最终 assistant `stopReason='aborted'`，`isStreaming=false`，无额外继续请求 |
| 8 | 1,000 条消息的内存投影 | **PASS，仅微基准** | 单机本次 `buildSessionContext` 为约 **3.60ms**；不含 SQLite 查询、历史分页、Token 构建、UI 或真实模型调用，不是生产性能承诺 |

测试 1 在第一次运行中暴露了叶子恢复假设错误，修订测试以明确记录**恢复必须由 SillyRealms 提供 `active_leaf_entry_id`** 后 8/8 全部通过。首次 SDK mock 请求由于 npm 安装不完整失败，补齐 OpenAI 适配依赖后生成/流式测试成功；详情见 [README](README.md) 安装说明。

## 对 SillyRealms 的核心架构含义

### 1. SQLite 是唯一权威：建议「单次请求构建内存 Pi Session」

```text
SQLite: sessions.active_leaf_entry_id + entries.parent_entry_id
  ↓ 按明确选中的叶子读取唯一祖先链（不使用全局 seq 拼接）
SillyRealms Context Builder: 世界/世界书/预设 nodes[]/状态快照 → 有序消息
  ↓ 在请求时加载 Pi 内存 Session 并绑定受控 prompt 适配
Pi SDK: ModelRuntime + Agent 请求生命周期 + SSE/abort
  ↓ 接收完成/失败/取消事件
SQLite: 写回 User/AI Entry 与状态，不写入 Pi JSONL 作为第二个权威库
```

SDK 的 SessionManager 维护自己的 append-only Entry ID / JSONL，**并不自动理解 SillyRealms 的数据库 ID、历史编辑语义或自定义世界线限制**。本轮可用测试证明：可以使用 `SessionManager.inMemory(cwd, options, entries)` 用外部事先准备的 Pi 格式 Entry 初始化；创建后的当前叶子若和业务叶子不一致，要显式恢复。真正的 SQLite adapter 尚未编写或验证，不能宣称零适配成本。

**不要**在生产中仅修改 `session.agent.state.messages` 试图长期替换历史，因为下次请求时 Pi 会使用 SessionManager 投影重建有效消息。完整系统应只从 SQLite 派生临时执行态，模型结果最后再提交回 SQLite。

### 2. 自定义 Prompt 编排：必须在「发送前」覆盖最终请求内容

SillyRealms 最近已确定 `builtin/default` 的 10 个固定节点及自定义预设 `nodes[]` 排序，它们由自己的 Context Builder 负责组合。普通 `createAgentSession({resourceLoader})` 的 `systemPromptOverride` 只影响基础 system 段，并不会自动实现任意 Prompt 节点序列；Pi 还会追加 `<cwd>` 上下文。

**可行的适配切口（实测）：** 创建 `AgentSession` 后包装公开的低层 `session.agent.prepareRequest`，先执行 Pi 原 hook，然后将此次请求的 `context.messages` 替换为**SillyRealms 已生成的有序模型消息**。本轮 mock 证实该方法能改变真实 HTTP 请求，且 `user` 角色的 post-history 文本保持末尾位置。需保留 SDK 原 hook 的模型选取、压缩、工具投影等逻辑，不直接覆盖后丢弃原结果。

这不等价于“所有节点一定精确保序”：**最终模型协议仍会规范化部分角色**。本轮 OpenAI 兼容实现将 post-history `system` 移到头部，故预设/Context 检查必须具备 `Provider` 最终请求层的预览和能力校验。对于不能表达的设置，**明确拒绝生成或经用户明确选择的降级方案**（如改为独立 `user` 消息），不能静默移动。还需评估 Pi 公开低层 hook 未来版本兼容性，建议固定 SDK 版本并保留端到端回归用例。

备选方案：若确实要求所有 Provider 都独立于 Pi 的消息规范化逻辑，评估直接使用 `@earendil-works/pi-agent-core` / `pi-ai` 的更底层调用，或另写 Provider adapter；但它们也不能突破各厂商模型协议本身的角色限制。

### 3. 工具与系统资源最小化已验证

`DefaultResourceLoader({noExtensions:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,noThemes:true})` + `noTools:'all'`，并使用临时 `agentDir` / `SettingsManager.inMemory()`，可在本轮无副作用实验里得到 **工具数量 0，扩展/Skills/模板/项目上下文数量 0**。生产开发时仍要保持默认不暴露读写 Shell/文件工具，且避免重新启用用户 `~/.pi` 的配置发现。

### 4. 流式与取消适合 H5，但事件语义要区分

本地 SSE 的 `message_update:text_delta`、`message_end`、`agent_settled` 正常工作；取消会产生 `aborted` 助手终态。H5 层需要区分“已收到一些 token”和“生成已完成并成功写入 SQLite”，不将前者标记为业务成功。`agent_end` 与 `agent_settled` 含义不同：使用 `agent_settled` 才能确认 Pi 无自动后续执行。

## 没有被本轮验证的关键项（下一步任务）

1. **真实 SQLite 集成**：选择驱动，按业务 `active_leaf_entry_id` 的父链恢复 Session，验证重启、失败重试、编辑历史消息、多分支及 1000 轮以上的路径查询。需避免 SDK 自带 JSONL 和 SQLite 两份权威写入。
2. **Prompt 数组与 Provider 兼容矩阵**：在不付费的 mock 下扩充不同角色/消息位置用例，再用至少一个**明确经用户配置的真实模型**验证流式、取消、超时与 Token 预算；任何实际调用均可能产生费用，本轮未进行。
3. **固定运行时方案**：对比「每次 Pi 内存 Session + `prepareRequest`」和「更底层 pi-agent-core / pi-ai」的复杂度、维护性、性能与宿主能力，选择一个方案固定到应用工程。
4. **生产安全**：实际 API Key 保存、局域网鉴权、Provider 参数映射、错误处理和关闭自动资源发现。基于无密钥 mock 的成功不能视为这些已完成。
5. **预设合法性**：运行中 `chatHistory` 恰好一次、`postHistory` 角色兼容、模型适配后的真实请求检查；自动加的 `<cwd>` 必须被报告或者受控抑制，不能让 UI 预览和真实请求产生未告知差异。

## 进入工程开发的验收门槛

- 最小链路通过：`WorldCard → Opening → SQLite Session/Entry → 自定义 Preset Context → Pi(mock/实际可选) → SSE → SQLite Entry → 重启恢复`。
- 最终发送消息与 Prompt 检查一致；不能保持的顺序/角色被用户看见并得到明确处理。
- 禁止 SDK 默认持久化第二份 Session 历史；无代码工具和隐式扩展；请求失败、取消和重试不重复创建用户分支。

**最终判断：基础 SDK 技术路线可以继续，但应先实现上述工程 PoC，不宜直接宣称完整 MVP 架构已被验证。**
