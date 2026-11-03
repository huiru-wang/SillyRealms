# AgentContext：一次调用的 ModelMessage[] 构建函数

> 2026-11-03 精简设计，尚未实现。**AgentContext 只负责从本轮 metadata、预设、历史与用户输入构建有序 `ModelMessage[]`**。不把 Context 变成框架/可持久化对象，不在这里调用 Pi、写数据库、管理 Provider/API Key 或状态事务。

## 1. 唯一对外职责

~~~ts
async function buildAgentContext(
  metadata: WorldInstanceContext,
  input: {
    userMessage: string;
    ancestorRuns: RunWithMessages[];  // Session 读取的当前分支父链
    stateScope?: StateScope;          // State Domain 按本轮输入选中的只读状态范围
  }
): Promise<ModelMessage[]>;
~~~

对外返回的就是消息数组，不附带生命周期对象、状态提交协议、Provider 连接、复杂诊断结构。Context 预览若需要来源说明，可以在调用方可选记录轻量 debug 信息，不改变基本返回类型。

输入 `ancestorRuns` 必须来自所选 `parentRunId` 的真实父链，**不能**从 UI 30 Run 分页拼历史、不能混入兄弟分支；当前 `userMessage` 还未出现在祖先链中，输出仅包含一次当前 User。重试 awaiting_ai Run 时读取其父链，并使用该 Run 已持久化的 User 文本，防止重复消息。

## 2. 最小构建步骤

1. 从 `metadata.world / metadata.preset / metadata.userCharacter` 获取固定内容；使用 `metadata.parentState` 和本轮 `stateScope`。
2. 按 `preset.scan_depth_runs` 扫描当前用户输入及最近祖先 Run 可见文本，解析世界书条目的 `always / on_mention / manual`、exclude 和条件 `when`，保持锚点 `before/after` 与条目顺序。
3. 按 `preset.nodes[]` 原始顺序依次组装七系统节点和自定义文本节点；系统节点的 `before → body → after` 合并成对应 role 消息，`chatHistory` 特例展开历史 Message 保留角色，`userInput` 特例形成一次 user 消息。禁用节点的钩子行为仍按 Preset 现有协议。
4. 统一执行一次只读模板处理：`{{user}}`、状态引用、受限 `if/else`、安全声明式文本转换；不执行来源卡任意 JS/EJS/HTML。
5. 按预设预算和模型上下文限制执行**简单历史裁剪**：保留必需指令/状态/当前用户输入，优先裁掉最早的**完整 Run**，不在单个 Run 中只保留 Assistant 而丢掉 User。当前必要内容仍超额时明确失败，不偷偷截断状态或工具 Schema。
6. 返回最终 `ModelMessage[]`。Pi 适配层负责将其映射到实际 SDK 请求，不由 Context 为某一 Provider 改写顺序。

## 3. 内部实现建议

~~~text
agent/context/
  world-instance-context.ts   # loadWorldInstanceContext，普通数据读取
  agent-context.ts            # buildAgentContext，唯一消息构建入口
  world-book.ts               # resolveWorldBook：匹配与挂钩
  template.ts                 # renderTemplate：只读变量/条件/状态引用
~~~

`composeMessages` 可以是 `agent-context.ts` 内部小函数；系统节点只用固定 `switch/Map` 映射对应正文，不需要 `SystemNodeRegistry`、7 个可注册 NodeBuilder、`HookResolver` 服务、`StateLoader` 类、独立 token-budget 框架或巨大的 `AgentContextResult`。

特别注意：**不删已有预设能力**。七个系统节点、任意自定义文本、节点 role/顺序、WorldBook before/after、状态引用、历史作为多条模型消息必须仍然按原业务语义工作。简化的是实现拆分，不是编辑器的表达能力。

## 4. 状态与工具的关系

本轮状态范围由 State Domain 在模型调用前按同一父 Run 状态、同一 `scanWindow` 选出一次：`stateScope = selectStateScope(...)`。`buildAgentContext` 读取其可见状态/描述；`AgentRuntime` 使用该范围决定是否生成 `state-update` 工具 Schema。两者不得独立再算一份激活根集合。

`buildAgentContext` **不返回** `StateOutputContract`；状态工具约束由 State Domain 直接提供给执行入口。`stateUpdateMode=off` 时不注入状态更新协议；`inline` 时通过预设对应的 worldState 内容要求末尾 `<StateUpdate>`，工具模式只有在 Pi/模型真实支持时开启。状态后置校验不在 AgentContext 内执行。

## 5. Pi 有序 Messages 的实际约束

本模块尽力按作者预设形成完整有序的 system/user/assistant 消息，但不承诺所有模型协议均能**无损发送**。2026-11-01 Pi mock PoC 已验证 `prepareRequest` 可覆盖模型请求，也验证 OpenAI-compatible 对后置 `system` 的重排；详情见 [报告](../../experiments/pi-sdk-feasibility/REPORT.md)。

因此 PiAgentExecutor 需要覆盖真实请求测试；对不能表达的角色/位置组合明确失败或提示用户选择不同 role，不静默把全部历史变成一个 system 文本。禁止先给 Pi 一份包含当前 User 的消息数组、又再次通过 `prompt(userMessage)` 自动追加同一条输入。

## 6. MVP 验收

- 相同固定输入构造的模型消息顺序与 role 相同；未运行模型也能预览消息内容。
- 世界书 before/body/after、关键词/排除/条件、模板变量和状态引用按现有语义工作。
- 所选父 Run 祖先历史正确、分支不串线、User 仅出现一次、历史按完整 Run 裁剪。
- 不依赖 Provider API Key、不落盘、不在 Context 内管理缓存/失效/工具调用。
- SDK 实际请求对不支持的后置 system 顺序可检测，不假装无损保序。

相关：[Preset](preset.md)、[WorldInstanceContext](world-instance-context.md)、[State](state.md)、[Provider](provider.md)。
