# AgentContext：真实消息持久化与叙事 Context 的唯一构建入口

> 2026-11-04 设计稿。只有一个 AgentContext，无 WorldInstanceContext。Session、WorldCard、Preset/模型、完整 Entry、叙事 Context、状态均由本轮直接读取；构建完成仅输出 ModelMessage[]。Window/Summary 与 Token 预算算法见 [Context Strategy](context-strategy.md)。

## 1. 对外接口

~~~ts
class AgentContext {
  static async create(input: {
    sessionId: string;
    parentEntryId: string;  // 当前分支的实际父 Entry
    userInput: string;
  }): Promise<AgentContext>;

  readonly fullState: StateSnapshot;
  readonly narrativeHistory: NarrativeMessage[];
  readonly activeStateModules: StateModuleSelection[];
  readonly lorebookIndex: LorebookIndex;
  async buildMessages(): Promise<ModelMessage[]>;
}
~~~

AgentRuntime 负责 Pi 真实执行、每条 Agent Message（含 toolCall 和 toolResult）正常持久化及 SSE；AgentContext 不把这些工具消息重新注入下一轮的模型历史。

## 2. 构建步骤（有序）

1. **加载 Session**：只有 world_id、preset_id、user_character_id、tip_entry_id；通过 world_id 读取**当前最新世界卡**，通过 preset_id 读取有序 Preset（其中包含模型选择、生成参数及摘要 Prompt）。不使用世界卡快照、session opening_id、session model_selection/options。
2. **读取完整 Raw Entry 父链**：从本轮实际 parentEntryId 向上沿 entries.parent_id 取得真实历史。原始记录包括 user、assistant（可能含 toolCall）、toolResult、summary。不能直接按 seq 拼接历史，也不能因为工具消息不进入模型而删除它们。
3. **获取当前 Narrative Context**：从**本轮 User 尚未写入前的父链**统一投影 user/assistant 叙事文本，排除工具结果、Assistant 内 toolCall/thinking、状态内联标记；按当前 WorldCard 的 window/summary 算法先处理消息数约束、再依 Preset/Provider 的 Token 预算执行缩窗或摘要（阈值或 Token 压力均可触发）。summary 需要执行时**先读取当前完整 State** 供 Preset 摘要 Prompt 渲染，再把 Summary 写在原 tip 之后，才追加当前 User Entry。逻辑消息顺序为 Summary + 未覆盖真实历史 + 当前 User，当前 User 在模型输入里只能出现**一次**。
4. **独立加载最新全量 State**：沿真实父链寻找最近完成的 Assistant 的 stateSnapshot；不受第 3 步历史窗口限制。对照当前世界卡 State Schema，若旧状态不兼容**直接允许舍弃并初始化最新 Schema 初值**，无需阻止旧 Session 继续；本轮结束状态元数据可标记 stateReset。
5. **激活 lorebook、State Module 与角色**：以**根据完整 Prompt Token 预算最终确认的 user/assistant 叙事历史 + 当前 User** 为唯一关键词文本范围；没有额外 scan_depth。条目只支持 always/on_mention。on_mention 的关键词命中和可选 when(fullState) 通过逻辑 AND 共同判定；排除词优先。角色同样支持 order，按升序排列；当前玩家角色不能在 characterInfo 重复。
6. **建立 lorebook 位置索引**：按 anchor/position(before|after) 分组，再以 order 升序、同序原始位置稳定排序。本轮索引无需入库。
7. **执行 Preset Nodes**：按预设的 nodes[] 顺序执行七个系统 NodeBuilder 和自定义节点。系统 Builder 从索引取 before 内容，构建本体，再取 after；chatHistory 展开本轮 Narrative Context（Summary 为 assistant 前缀），userInput 仅一条真实用户输入。
8. **统一模板处理**：所有 Builder 输出 RawMessage 后，交给独立共享 TextRenderer，对可渲染的预设/角色/世界书模板片段执行变量、条件、状态引用和受控转换。历史叙事和当前 User 为 literal，绝不二次执行。
9. **输出 ModelMessage[]**：根据 Provider.contextWindow、Preset.budget.max_context_tokens（若配）、输出 Token 和安全余量计算有效输入预算 B。按 window 先留最近 N 条、超 B 再逐条裁最旧叙事；summary 按 N 或超 B 摘要，最后校验包含所有系统节点/状态/世界书/工具定义的完整 Prompt。每次内容变化必须重新匹配关键词并构建。固定 Prompt+User 仍超 B 则抛 CONTEXT_BUDGET_EXCEEDED，**不得在匹配后静默裁剪**。

在内部可先独立加载 State 再压缩摘要（摘要 Prompt 需要 State）；但最终 Context 和世界书命中必须使用同一份固定的叙事消息集合，状态读取不受压缩影响。

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

对于普通 System Node：按索引取 before（有序模板片段）→ 本体 → after（有序模板片段），统一使用该节点 role。chatHistory 特例保留多条 user/assistant 消息各自 role（只含叙事文本），userInput 不可重复发送。各系统节点独立 Builder 便于后续扩展，不引入动态 Plugin Registry 或 Cache 生命周期。

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
  text/                        # RenderText、evaluateCondition、状态引用，Web/Server 共享
  world/                       # WorldCard/State/Preset 的纯类型、校验与算法
~~~

## 4. 状态和工具

- 当前状态是本分支最近有效全量快照（经新 Schema 校验/重置），并不等于 Prompt 历史或 UI 可见消息。
- AgentContext 选择的 activeStateModules 同时用于 worldState Node 内容与本轮 StateTool Schema；候选变更必须带 reason，StateEngine 验证后结算到最终 Assistant Message 的元数据。
- **本轮 Pi 执行过程仍传递、持久化真实 ToolCall/ToolResult 消息**；下一轮只用 user/assistant **叙事投影**重建历史，不携带旧工具消息。
- 用户看到的历史也只显示叙事投影，完整历史仍保留可用于开发者诊断与世界线恢复。

## 5. Pi 实测约束和验收

此前 Mock PoC 已证实某些 OpenAI-compatible 模型协议可能重排后置 system；Pi prompt(text) 也可能自动追加 User。执行层必须核查最终 HTTP role/order 和消息去重，不能把示例函数签名当 Pi 原生 API。

验收：所有 Agent Message（含 ToolCall/ToolResult）都写 Entry 并归属 run_id；三个读取场景复用 NarrativeProjection；window/summary 与 Token 裁剪后的关键词扫描和真实历史一致；完整 State 独立；when 与 keyword AND；角色/世界书 order 正确；每轮输出有序 ModelMessage[]，不二次插入当前 User。
