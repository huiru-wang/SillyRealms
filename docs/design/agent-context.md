# AgentContext：真实消息持久化与叙事 Context 的唯一构建入口

> **职责与权威范围**：单轮 Prompt 构建时序、节点排序、worldState 延迟生成的权威来源；状态合并和持久化以状态及存储规范为准。

> 2026-11-04 设计稿。只有一个 AgentContext，无 WorldInstanceContext。Session、WorldCard、Preset/模型、完整 Entry、叙事 Context、状态均由本轮直接读取；构建完成仅输出 ModelMessage[]。Window/Summary 与 Token 预算算法见 [Context Strategy](context-strategy.md)。

## 1. 对外接口

~~~ts
class AgentContext {
  static async create(input: {
    sessionId: string;
    parentEntryId: string;  // 当前分支的实际父 Entry
    userInput: string;
  }): Promise<AgentContext>;

  readonly fullState: ScopedStateViews; // global / session / message
  readonly narrativeHistory: NarrativeMessage[];
  readonly activeStateModules: StateModuleSelection[];
  readonly lorebookIndex: LorebookIndex;
  async buildMessages(): Promise<ModelMessage[]>;
}
~~~

AgentRuntime 负责 Pi 真实执行、每条 Agent Message（含 toolCall 和 toolResult）正常持久化及 SSE；AgentContext 不把这些工具消息重新注入下一轮的模型历史。

## 2. 构建步骤（严格单次 Prompt 构建）

**每次调用只构建一遍非历史 Prompt。压缩只修改历史 messages，绝不因为关键词消失重新筛选 lorebook/角色/状态根，也不重新运行 NodeBuilder/TextRenderer。** 允许已命中的条目在压缩后的消息里找不到原关键词，这是明确接受的近似行为。

1. **加载 Session 元数据**：取得 `world_id`、`preset_id`、`user_character_id`、`tip_entry_id`，确定本次父链与用户输入。
2. **查询历史消息**：先沿选定 tip 的 `parent_id` 限制当前世界线，再查询 `entries.type=message AND role IN ('user','assistant')` 的历史候选。通过统一 NarrativeProjection 剔除 Assistant content 内的 toolCall、thinking/reasoning、内联状态指令；`toolResult` 不读入叙事。Window 先只选最近 N 条；Summary 使用已有最新 Summary + 未覆盖的原文候选，本轮新生成的摘要不参与本轮匹配。历史 Raw Entries 不受裁剪影响。
3. **加载配置并构建一次 Prompt**：用 `WorldService.getWorld`、`PresetService.getPreset`、`ProviderService.resolveModel` 和分别独立读取的 Global、Session、当前父链 Message 完整 State。复制三作用域已提交状态为本轮工作状态；先在只读初始视图上完成全部 when 并冻结激活结果，再按 nodes[] 顺序串行执行 before/body/after 和脚本，允许更新工作状态与 Run 临时变量。worldState 本体仅占位；所有普通 Prompt 脚本完成后，只读最新工作状态构建 worldState 并填回原位置，然后按场景执行 TextTransform。关键词扫描范围固定为**第 2 步所选候选叙事消息 + 当前 UserInput**；`when` 固定读取三作用域完整 State。得到冻结的非历史节点内容及 chatHistory/userInput 的位置。
4. **组装候选 Context 并检查预算**：把第 3 步冻结的节点、候选历史和 UserInput 按 nodes[] 实际顺序合成 ModelMessage[]（不是简单强制把所有 Prompt 放最前），连同工具定义统计 Token。预算 `B = min(Preset 上限（若配置）, Model.contextWindow) - max_output_tokens - 内部固定估算余量`。
5. **按策略只压缩历史消息**：Window 的 N 条先行限制已在第 2 步生效，仅当候选 Context 超 B 时从最旧历史开始裁剪；Summary 在未覆盖历史条数达到 N **或**候选 Context 超 B 时摘要较老历史并保留最近 K 条。可继续缩短/摘要 messages 直到满足预算，但**不能重新匹配关键词、重新选择节点、重新渲染变量或压缩当前 UserInput、State、固定 Prompt**。摘要 Prompt 只引用全量 State，其输入仅为历史叙事；摘要结果只先暂存。
6. **组装最终 Context 并校验**：在已冻结的 Prompt 节点序列的 chatHistory 位置替换为裁剪后的消息，或「最新 Summary + 最近原文」，不动其余节点和 UserInput，再核验完整输入 Token `<=B`。若历史清空/摘要仍无法容纳固定 Prompt、当前 User 和工具定义，则返回 `CONTEXT_BUDGET_EXCEEDED`，不调用模型。预算通过后由 Runtime 先持久化有效 Summary（如有），再写本轮 User，执行 Pi。

**单轮结果**：`frozenPrompt + trimmedMessages + userInput` 或 `frozenPrompt + summary + recentMessages + userInput`，这里是逻辑组成，并非改变 Preset 节点顺序。下一轮重新从当前历史/状态加载并正常匹配条目；仅**当前这一轮**允许压缩后的关键词命中与最终消息不完全一致。

## 2.1. 为什么允许一次匹配后的过期命中

假设候选历史中有“魔王”，触发了 lorebook 的魔王设定。压缩后最早的“魔王”消息被裁掉，**本轮仍保留已加载的魔王条目**。无需再次构建 Prompt，代价是少量无关 Prompt Token。只要完整 Context 最终不超预算，就认为合法；如果固定 Prompt 本身超预算，直接失败而不是删除世界书条目。这是产品明确选定的简化规则。

## 3. NodeBuilder 保持可扩展

~~~ts
type TextPart = { text: string; template: boolean };
type RawMessage = {
  role: "system" | "user" | "assistant";
  parts: TextPart[];
};
interface NodeBuilder {
  build(node: PresetNode, ctx: AgentBuildContext): Promise<RawMessage[]>;
}
const systemNodeBuilders = {
  main: mainNodeBuilder,
  personaInfo: personaNodeBuilder,
  characterInfo: characterNodeBuilder,
  worldState: worldStateNodeBuilder,
  chatHistory: chatHistoryNodeBuilder,
  userInput: userInputNodeBuilder,
  postHistory: postHistoryNodeBuilder,
} satisfies Record<SystemNodeId, NodeBuilder>;
~~~

worldState 本体是例外：保留节点位置，等所有普通 Prompt 脚本完成后只读最新工作状态构建；其 before/after 仍按本体原位置正常执行，禁止最后的本体渲染再写状态或 Run 变量。对于普通 System Node：按索引取 before（有序模板片段）→ 本体 → after（有序模板片段），统一使用该节点 role。chatHistory 特例保留多条 user/assistant 消息各自 role（只含叙事文本），userInput 不可重复发送。各系统节点独立 Builder 便于后续扩展，不引入动态 Plugin Registry 或 Cache 生命周期。

建议目录：

~~~text
apps/server/src/agent/
  agent-runtime.ts
  context/
    agent-context.ts
    narrative-projection.ts     # 供 UI/Context/关键词扫描共用的投影契约
    lorebook.ts
    context-strategy.ts
    node-builders/             # main / persona / character / state / history / input / postHistory
  pi/
    executor.ts
    events.ts

packages/core/src/
  state/                       # StateReader 只读状态
  expression/                  # 隔离的 JavaScript 脚本与表达式执行
  activation/                  # ContentActivation 统一加载判断
  text/                        # TextRenderer 与独立 TextTransform
  world/                       # WorldCard/State/Preset 的纯类型、校验与算法
~~~

## 4. 状态和工具

- Global 从本世界卡读取、Session 从本会话读取、Message 从当前父链读取；Run 起冻结初始视图供 when，并以副本作为工作状态；历史裁剪不改变状态。
- AgentContext 先冻结 activeStateModules，脚本按顺序修改三作用域工作状态；worldState 延迟输出选中状态根的最新值。模型工具只开放其中的 Message 状态；候选变更必须带 reason，在脚本后的 Message 工作状态上应用。Run 成功后事务提交三个作用域最终值和变更元数据。
- **本轮 Pi 执行过程仍传递、持久化真实 ToolCall/ToolResult 消息**；下一轮只用 user/assistant **叙事投影**重建历史，不携带旧工具消息。
- 用户看到的历史也只显示叙事投影，完整历史仍保留可用于开发者诊断与世界线恢复。

## 5. Pi 实测约束和验收

此前 Mock PoC 已证实某些 OpenAI-compatible 模型协议可能重排后置 system；Pi prompt(text) 也可能自动追加 User。执行层必须核查最终 HTTP role/order 和消息去重，不能把示例函数签名当 Pi 原生 API。

验收：所有 Agent Message（含 ToolCall/ToolResult）都写 Entry 并归属 run_id；NarrativeProjection 统一清理工具和思维块；每轮普通 Prompt 脚本按顺序执行一次、worldState 最后填充一次，压缩 messages 不重新匹配关键词/状态条件或重渲染模板；最终完整 Context Token 校验通过；完整 State 独立；角色/世界书 order 正确，当前 User 恰好一次。
