# AgentContext：单次请求的上下文加载与模型消息构建

> 2026-11-03 第二版精简设计，尚未实现。**不再存在 WorldInstanceContext**。AgentContext 承担一次模型请求所需 Session、历史、完整状态、触发条目和预设的加载与编排，最终向 Pi 返回 `ModelMessage[]`。不持久化 Context，不管理跨轮缓存。

## 1. 输入和输出

~~~ts
class AgentContext {
  static async create(input: {
    sessionId: string;
    parentEntryId: string;  // 本轮实际父节点，决定世界线
    userInput: string;      // 重试时从已持久化的 Entry.text 获取
  }): Promise<AgentContext>;

  readonly fullState: StateSnapshot;
  readonly activeStateModules: StateModuleSelection[];
  readonly worldBookIndex: WorldBookIndex;

  async buildMessages(): Promise<ModelMessage[]>;
}
~~~

`create` 完成本轮数据加载与条目筛选；`buildMessages` 遍历预设节点执行 NodeBuilder，最终**只返回消息数组**。`activeStateModules` 仅作为本轮状态工具构建的只读依据，不需要额外返回大而全的 `BuildResult` 或独立 WorldInstanceContext DTO。前端预览可以复用同一构建流程，不调用模型。

## 2. 唯一构建流程

1. **加载 Session**：`SessionService.getSession(sessionId)` 取得世界快照、选中角色、Preset ID、模型选择、选中分支 `parentEntryId` 和历史加载选项；验证目标父节点属于该会话，同时读取本轮 PresetSnapshot 的扫描深度配置（节点内容等到步骤 6 才构建），恢复本次生成需要的事实。
2. **加载会话历史**：从 `parentEntryId` 向上沿 `entries.parent_entry_id` 读取**这一条分支**。若有历史压缩，读到最近的 `kind=summary` Entry 为止，并保留该摘要；若配置 `history.max_messages=N`，从最新可见消息向前保留至少 N 条，按**完整 Entry** 边界截取以避免拆散 User/Assistant。两项同时启用时**保留最近 Summary 作为压缩前缀，再限制其后的最近 N 条可见消息**；无 Summary 则直接限制最近 N 条。Summary 不计入 N。`summary` 是数据库中的普通 Entry，不建 checkpoint 表。压缩前消息仍存在，可供 UI 查看，不进入当前 Prompt。
3. **加载最新完整状态**：从实际 `parentEntryId` 向上寻找最近一个**成功选中的 Run** 的 `state_snapshot`；不管历史截断 N 多小，都要读取完整状态，绝不依据被裁掉的叙事还原，也不读取另一分支的所谓「全局最新」状态。`awaiting_ai`/失败 Entry 退回父节点状态；Opening Root 持有 S0。
4. **筛选世界书和状态根**：使用本轮**已加载的历史窗口 + 当前用户输入**构建扫描文本；如 Preset 设置独立的 `scan_depth_entries`，仅在此窗口内取最近若干回合。读取世界书条目的 `always / on_mention / manual`、关键词包含/排除、`when` 状态表达式；状态 Module 加载支持 `always / on_mention`、关键词/排除及 `when`。**所有条件读取步骤 3 的全量状态**，按相同解析器执行，不允许只拿显示状态或筛选后的状态来判断其它条目。产出 `activeStateModules` 和 WorldBook 匹配列表。
5. **构建 WorldBook 位置索引**：激活的世界书条目依 `anchor` + `position` 分组，`order` 升序；同 `order` 时按原世界书位置稳定排序。形式为 `worldBookIndex[systemNodeId].before/after`。它是本轮临时对象，不入库。
6. **加载 Preset**：使用步骤 1 已读取的 `PresetSnapshot` 中完整有序的 `nodes[]`，含七系统节点、自定义 Prompt、role/启停/顺序及预算；模型选择仍来自 Session，Preset 不绑定 Provider。
7. **按节点顺序构建消息**：遍历 `nodes[]`。系统节点执行其对应 NodeBuilder：拉索引中的 `before` 文本 → 构建节点本体内容 → 拉 `after` 文本，合并为目标 role 的原始消息；`chatHistory` 返回按顺序的多条历史消息，`userInput` 保证仅出现一次本轮输入。自定义节点由 `CustomTextNodeBuilder` 处理。全部原始消息组装完成后，调用**共享 TextRenderer** 统一处理**允许渲染的模板片段**（变量、条件、状态引用和受控转换），对真实用户输入与历史原文保留 literal 片段，不重新插值，再做必要的消息/上下文上限检查，返回 `ModelMessage[]`。

**顺序是历史 → 全量状态 → 世界书与状态筛选 → 位置索引 → Preset → NodeBuilder → 全局文本渲染 → Messages。** 加载状态不受模型历史预算和压缩边界限制。

## 3. NodeBuilder 可扩展结构

保留「**一个系统节点对应一个 Builder**」的设计；这次不再为了削减类数量而删除真正有用的扩展点。固定注册表足够，不需要插件生命周期或动态发现系统。

~~~ts
type NodeBuildContext = {
  session: Session;
  history: EntryView[];
  fullState: StateSnapshot;
  activeStateModules: StateModuleSelection[];
  userInput: string;
  worldBookIndex: WorldBookIndex;
};

type TextPart = { text: string; template: boolean };
type RawMessage = { role: "system" | "user" | "assistant"; parts: TextPart[] };
interface NodeBuilder {
  build(node: PresetNode, ctx: NodeBuildContext): Promise<RawMessage[]>;
}

const systemNodeBuilders = {
  main: mainNodeBuilder,
  personaInfo: personaInfoNodeBuilder,
  characterInfo: characterInfoNodeBuilder,
  worldState: worldStateNodeBuilder,
  chatHistory: chatHistoryNodeBuilder,
  userInput: userInputNodeBuilder,
  postHistory: postHistoryNodeBuilder,
} satisfies Record<SystemNodeId, NodeBuilder>;
~~~

普通系统 NodeBuilder 的实现示意：

~~~ts
async function buildSystemNode(node: PresetNode, ctx: NodeBuildContext): Promise<RawMessage[]> {
  const { before = [], after = [] } = ctx.worldBookIndex[node.id] ?? {};
  const body = node.enabled ? await buildSystemBody(node, ctx) : "";
  const parts: TextPart[] = [
    ...before.map(e => ({ text: e.content, template: true })),
    { text: body, template: node.id !== "userInput" },
    ...after.map(e => ({ text: e.content, template: true })),
  ].filter(p => p.text);
  return parts.length ? [{ role: node.role, parts }] : [];
}
~~~

`chatHistory` 特例会展开多个 User/Assistant 消息，不能把历史压成单一系统消息，且其文本片段全为 `template:false`；`userInput` 的原始用户文字也是 `template:false`，before/after 世界书片段为 `template:true`。这样全局文本处理只执行一遍，却不会改写用户真实输入。系统节点关闭时可保留其世界书挂钩（沿用当前 Preset 语义）。每个 Builder **只处理自己的来源/本体内容**；位置排序在匹配阶段完成，模板执行统一在所有 Builder 完成后进行。

建议目录：

~~~text
src/
  agent/
    agent-runtime.ts
    context/
      agent-context.ts          # create/load/buildMessages
      world-book.ts             # 匹配、按位置和 order 索引
      node-builders/
        index.ts                # 固定映射
        main.ts
        persona-info.ts
        character-info.ts
        world-state.ts
        chat-history.ts
        user-input.ts
        post-history.ts
        custom-text.ts
  domain/
    text/
      text-renderer.ts          # 供 Agent、世界卡详情、状态栏共同使用
      expressions.ts
      transforms.ts
~~~

## 4. 状态工具与共享文本引擎的边界

`AgentContext.activeStateModules` 是本轮筛选结果，`AgentRuntime` 根据它与用户的状态更新配置构造 Pi 工具或内联状态说明。工具定义由 State Domain 生成，AgentContext 不处理工具的实际执行/提交；用户选择的 `off/inline/tool` 模式和实际模型工具支持仍需检查。

`TextRenderer` **不属于 Agent Context**，因为世界卡详情、预设预览、未来状态栏渲染也要用变量/条件/状态引用和文字转换。它接受文本 + 明确提供的值和安全配置，不主动查 Session/SQLite，不拥有世界书筛选或状态更新能力。见 [文本渲染](text-rendering.md)。

## 5. 历史、预算与 Pi 限制

`history.max_messages` 是实际进入模型的会话窗口，不是 UI 分页参数；`scan_depth_entries` 是触发扫描范围。压缩摘要即使在近 N 条消息的窗口外也作为固定前缀，摘要内容按 system/assistant 的已定义渲染方式参与模型上下文，但**绝不能当成真实新发生的世界事件**。模型历史只取当前分支已选 Run 的叙事，不回灌调试/失败/中断的工具内部记录。

优先执行用户配置的历史窗口，然后检查 Pi 模型上下文上限；仍过长时按完整 Entry 继续从头裁剪，当前用户输入、世界设定和必要状态说明不得被静默截断。`max_messages` 计可见 User/Assistant 消息，遇到临界点为保留完整回合可以稍微超过 N。

`@earendil-works/pi-coding-agent@1.4.0` 的本地 mock 实验已证明 OpenAI-compatible 路径可能重排后置 system；Pi 的 `prompt(text)` 不等价于直接发送任意 `ModelMessage[]`。执行层必须验证真正发出的消息序列，防止当前 User 被自动追加第二次；见 [PoC](../../experiments/pi-sdk-feasibility/REPORT.md)。

## 6. 验收

- 六步输入变更中只有当前分支历史与状态可影响本轮，分叉不串线。
- 压缩窗口、近 N 消息窗口、扫描深度和全量状态的职责严格区分。
- `always/on_mention/manual/when` 的世界书与状态模块筛选一致，`when` 始终用完整快照。
- 同一 anchor/position 内按 order 排序；系统 NodeBuilder 按预设顺序执行且 before/body/after 正确。
- 所有原始消息构建完再执行一次共享 TextRenderer；预览、世界卡详情和状态栏复用相同基础规则。
- 只返回 `ModelMessage[]`，不引入额外世界实例 Context 或二级缓存。
