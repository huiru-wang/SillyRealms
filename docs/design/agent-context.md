# AgentContext：单次模型调用的 Prompt 构建器

> 2026-11-03 目标架构，尚未实现。本模块只负责把 **PresetSnapshot + WorldInstanceContextView + 当前 Run 与祖先记录 + 已冻结父状态** 转为模型可消费的**有序 Messages 数组**、状态提交约束和构建诊断。它**不关心 Provider 连接/Key/请求执行**。一个 Session 可产生许多次 AgentContext，不能把它与一个世界实例的 [WorldInstanceContext](world-instance-context.md) 混同。

## 1. 核心职责和最终交付

AgentContext 是**纯构建应用服务**，一次调用一份新实例/只读快照。业务入口建议：

~~~ts
interface AgentContextBuilder {
  build(input: AgentContextInput): Promise<AgentContextResult>;
}
type AgentContextInput = {
  preset: PresetSnapshot;                 // 有序 nodes[] / budget / scanDepthRuns
  world: WorldInstanceContextView;        // 世界实例级静态索引及角色宏
  run: RunDraft;                          // 已确定 runId、parentRunId、用户输入
  ancestorRuns: RunView[];                // 当前 Run 之前的真实父链，旧->新
  parentState: EffectiveStateSnapshot;    // 父 Run 的完整有效快照
  stateDefinition: CompiledStateDefinition;
  budget: BudgetLimits;                   // 上层已解析数字和中立 token 估算器
};
type AgentContextResult = {
  messages: ModelMessage[];               // 已排序、拼接、裁剪、确定 role 的最终请求
  stateOutputContract?: StateOutputContract; // StateEngine 生成，交给执行层
  diagnostics: BuildDiagnostic[];
  usageEstimate: {inputTokens: number; budgetTokens: number};
  sourceVersion: ContextSourceVersion;    // 用于防止过期结果提交
};
~~~

`messages[]` 是完整、明确有序的 **system/user/assistant** 消息序列。`chatHistory` 展开为多条历史 Message，保留每条的原始 role；其它预设节点每个最多产生一条合并消息。`userInput` 是恰好一条 user Message，绝不能同时再放入历史。只有 AgentContext 负责**构建**；`PiAgentExecutor.execute({messages,...})` 由上层 AgentService 调用。若 Pi 不能无损注入这一数组，责任在 Provider/Pi 适配的 PoC，AgentContext 不降级成扁平文本。

## 2. 独立模块与建议结构

建议业务能力按函数/文件拆分，不引入多层抽象框架：

~~~text
agent-context/
  agent-context-builder         主流程与预算/裁剪协调（唯一编排者）
  system-node-registry          系统节点 ID -> 对应 NodeBuilder 的显式映射
  node-builders/
    main
    persona-info
    character-info
    world-state
    chat-history
    user-input
    post-history
    custom-text
  hook-resolver                  查询 before/after 候选并执行激活判断
  state-loader                   从冻结父状态挑选本轮激活根、可见状态和写入目标
  render/
    variable-resolver            如 {{user}}，无副作用
    state-template-renderer      {{state:/...}}、get()/exists()/if
    script-transformer           受控只读文本转换（非任意 JS）
  token-budget                   通用预算策略、全局片段采纳和 Run 级历史裁剪
  diagnostics                    可追溯构建来源与错误
~~~

`NodeBuilder` 不访问 SQLite、不处理 Provider、不决定裁剪；输入为已准备的环境，输出 `NodeFragment[]` 或 `ModelMessageDraft[]`，自带来源、是否必需、原始文本/role 等元数据。系统节点注册表是明确的固定 Map，而不是几十个 if/else 或自动发现世界卡脚本。通用内容工具是独立可单测的纯函数，允许以后新增**经过批准**的文本转换插件，但首期没有任意用户 JS 执行。

## 3. 构建阶段：**状态先于 Prompt**

~~~mermaid
flowchart TD
 A[冻结 Preset/World/当前 Run/祖先父链/父状态] --> B[扫描当前 Run 和最近祖先 Run]
 B --> C[StateLoader 选择激活状态根与可写目标]
 C --> D[构建受限 StateOutputContract]
 D --> E[按 Preset nodes 顺序进入 NodeBuilder]
 E --> F[每个系统节点: before -> body -> after]
 F --> G[统一只读变量/状态/条件/受控脚本渲染]
 G --> H[主流程 TokenBudget 采纳/裁剪片段]
 H --> I[合并为有序 Messages + 诊断]
 I --> J[返回给 AgentService/Pi 执行层]
~~~

必须在任何 Prompt 构建与 WorldBook 条件判定之前，**先冻结有效父 Run 的状态并确定本轮 StateView**，理由：角色资料、世界书 `when`、状态 description、变量/脚本均可能依赖当前状态。`StateLoader.prepare(parentState, stateDefinition, scanWindow, world)` 返回 `StateView`（**完整只读值引用 + 已激活根集合**）和 `StateOutputContract`（已激活目标的受限 ChangeSet schema）；仅对激活根注入值/描述并允许模型写入。`when` 条件读取完整父快照，即使某根未注入也不表示数据库里不存在；禁止在一次调用中途因渲染结果变化再重新激活另一根。

### 3.1 扫描与候选激活

扫描窗口按 `preset.scan_depth_runs` 从当前 Run 的用户文本算起，再沿真实 `parent_run_id` 取最近若干祖先 Run；每个 Run 可包含 User/Assistant 两条可见消息，按先后顺序串接用于关键词匹配。**窗口长度按 Run，不按 Message**。不读取兄弟分支、工具参数、历史非叙事日志；每一来源的命中原因记录供预览。

世界资料候选由 WorldInstanceContext 提供**已按锚点/顺序预索引的原始定义**；当前调用的 `always/on_mention/manual`、禁用集合、排除关键词、`when` 表达式由 HookResolver 在当前 scanWindow + StateView 上决定。WorldInstanceContext 只提供索引，不缓存本轮命中结果。角色资料使用相同基础加载规则：玩家角色固定 personaInfo，不会再次出现在 characterInfo。

### 3.2 系统节点钩子

执行 Preset 的单个系统节点 `N` 时，流程固定：

1. `HookResolver.resolve(N.id, "before", scanWindow, stateView)`：查询、过滤、排序激活的 WorldBook 条目；
2. `NodeBuilder[N.id].buildBody(ctx)`：生成该系统节点本体，可能为空，**不管预算**；
3. `HookResolver.resolve(N.id, "after", ...)`：同上；
4. 把 before / body / after 按原始顺序组成 `NodeFragment[]`，经统一 `renderText()` 渲染变量、状态引用、条件分支和允许的文本脚本；
5. **将已渲染片段交回 AgentContext 主流程**；主流程按全局预算采纳后，再把属于同一个节点的非空片段以两次换行拼成一条 `ModelMessage`，role 严格由该节点的 Preset role 决定。

例如 `personaInfo`：先取 `personaInfo.before` 世界书候选，再读本局扮演角色的静态资料，再取 `personaInfo.after`，最后统一渲染 `{{user}}` 和 `{{state:/...}}` 等，形成节点的最终 Prompt。若节点本体关闭，before/after 仍可独立注入；整个节点最终无内容才不产生 Message。

`custom-text` 不运行 before/after 钩子，但执行相同模板管线。`chatHistory` 特殊：从可见祖先 Runs 展开历史消息，而不是合并成一条系统角色 Message。`userInput` 是合并 before/原始用户输入/after 的单条 user Message；User 原始文本不得被改写回数据库。`main/postHistory` 正文来自 Preset 的配置字段。

## 4. 通用文本处理

唯一公开管道：

~~~ts
renderText(input: {
  text: string;
  macros: Readonly<Record<string,string>>;
  state: Readonly<EffectiveStateSnapshot>;
  scriptPolicy: SafeTransformPolicy;
  origin: SourceLocation;
}): {text: string; diagnostics: Diagnostic[]};
~~~

处理顺序：**结构化条件解析与选支 → 基础变量展开（如 `{{user}}`）→ 状态引用 `{{state:/清月/灵力}}` → 已授权的只读文本转换规则**。仅处理**一次**，替换出的内容不会再次解释为模板或脚本；对无效路径、非法条件、未声明宏提供来源定位错误。全部步骤必须确定性、无状态写入、无副作用；`get("/路径")` / `exists("/路径")` 条件读取冻结父快照。执行器有长度、深度、步骤与输出容量限制。

旧来源卡 `regex_scripts[]` 可作为素材归档，但**MVP 不执行任意 JavaScript/HTML/EJS**，也不允许脚本偷偷改变状态。用户说的“状态脚本”首期定义为**受限状态条件表达式和安全的声明式文本转换**；未来确需开放脚本，必须引入独立沙箱/权限/审计设计，不能直接把 JS 写进 NodeBuilder。这条边界保证插件化不牺牲可预测性。

## 5. Token 预算是主流程的唯一职责

NodeBuilder / HookResolver / renderText **都不处理 Token**，避免预算逻辑散入每个系统节点。AgentContext 主流程执行全局策略，输入上限来自 `BudgetLimits` 和 Preset 策略。节点输出的片段包括 `origin`、`kind`、`required`、`text` 和预计 Token，仅主流程负责放入/丢弃及形成诊断。

- 先预留不可裁的当前用户输入、已激活状态的必要说明/协议、若采用 Tool Call 则动态工具参数 Schema 的 Token，以及系统强制的必要指令；如果必需部分自身超额，**拒绝调用**而非截断状态 JSON。
- 再按 Preset `nodes[]` 顺序尝试可选片段；WorldBook 条目以完整条目为裁剪单位，不能半条截断。`main`/自定义文本的可选策略与 `required` 必须在主流程显式配置，不能由 builder 随意标记关键。
- `chatHistory` 以**完整 Run** 为最小历史保留单元，从最近祖先 Run 向前挑选**连续 Run**，每个 Run 的可见消息要么整组保留，要么整组舍弃；生成预算结束后按真实时间正序展开。不能在同一个 Run 中保留 Assistant 丢掉 User。Opening Run 也作为完整 Run。
- 切分节点前须完成模板渲染，按最终角色/分隔符和协议估算占用；组成最终 Messages 后重新计量。预算不足且裁剪会破坏必需完整消息时明确报错。输入的 `BudgetLimits` 仅有数值和抽象 tokenCounter，**没有 modelId、API Key、Provider 对象**。
- 固定诊断状态：`included / skipped_budget / disabled / unmatched / invalid_template / missing_state / truncated_history_runs`，返回激活来源、每个片段的最终字数与 Token 估算，预览/执行共用同一构建代码。

## 6. 生命周期与一致性

上层 AgentService 在生成前锁定 `runId`、父 Run、预设修订、世界快照修订、Session 角色、状态 Schema/hash、父状态版本及手动 WorldBook 选择；AgentContext 返回 `sourceVersion` 用于最终提交冲突检查，不会因为另一个请求修改了世界卡就混入半套新规则。

若 WorldInstanceContext 缓存失效，使用旧 frozen view 构建的执行结果不能穿越相应版本提交；调用者负责拒绝或重新执行。AgentContext 无持久化副作用：它不落 Run/Message、不修改 WorldInstanceContext、不会缓存“当前已激活条目”供下一轮重用。

## 7. API/模块验收

- 给定完全相同的 PresetSnapshot、WorldInstanceContextView、父状态及真实 Run 父链，输出 `messages[]`、顺序、role、诊断应一致。
- `personaInfo.before -> personaInfo.body -> personaInfo.after -> renderText -> TokenBudget` 顺序符合预期；系统节点单条消息、User 输入仅一次，历史角色逐条原样保留。
- 状态先加载；世界书 `when`/变量状态宏/文本条件在同一父快照求值；从已失效状态不构建有效模型请求。
- 增加一个系统 NodeBuilder 不必修改 TokenBudget/Provider；增加一种安全文本转换不需要修改各个 NodeBuilder；能对每个模块纯函数单测。
- Run 级历史预算与 Run 级分页语义一致，既不拼接兄弟分支，也不拆开一次用户交互的消息。
- 最终 Output 有且仅有确定的 `messages[]` 和 `stateOutputContract`，绝不暴露 API Key/Provider 内部资源。

相关：[Preset](preset.md)、[WorldInstanceContext](world-instance-context.md)、[Session](session.md)、[State](state.md)、[Provider](provider.md)。
