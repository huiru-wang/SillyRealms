# Context Strategy：Token 预算驱动的 Window / Summary

> 2026-11-04 目标方案，尚未实现。WorldCard 决定策略和消息数上限，Preset 决定本次 Token 预算，Provider 给出模型硬上限。**只支持 `window` 与 `summary`，默认 `window`，不提供 `none`。**

## 1. 三份数据严格分离

1. **Raw History**：沿选定 Session 世界线保存的全部原始 Entry。包含 User、Assistant（含 ToolCall）、ToolResult、Pi 技术 Entry、SillyRealms 摘要，不因上下文裁剪或换分支删除。
2. **Narrative Context**：从当前真实 Entry 父链投影出的可见 user/assistant **叙事文本**，不含 ToolCall、thinking、ToolResult、状态内联指令。Window/Summary 和 Token 预算只影响这份模型历史。
3. **Current State**：沿真实 Entry 父链寻找最近有效的完整状态快照，按当前世界卡 Schema 校验或重置。**绝不受历史滑窗或摘要影响**。

聊天 UI 展示完整可见历史（按 Run 分页）。**关键词只扫描本轮压缩前的候选 Narrative Context + 当前 User**：Window 为先行限制到最近 N 条后的候选；Summary 为最新摘要和未覆盖原文的候选。`when` 始终读取全量 State。压缩后若触发词消失，本轮仍保留已经选中的条目，允许这种近似误差；不重新匹配或重建 Prompt。

## 2. 配置归属与默认值

WorldCard `data.context`：

~~~json
{
  "strategy": "window",
  "max_messages": 40,
  "keep_recent_messages": 12
}
~~~

| 字段 | 规则 |
| --- | --- |
| `strategy` | `window`（默认）或 `summary`；禁止 `none`，缺失 context 视作默认 window，显式 none 校验失败 |
| `max_messages` | 正整数，默认 40；window 最多保留最近 N 条叙事消息；summary 为生成新摘要的未覆盖叙事消息数阈值 |
| `keep_recent_messages` | 仅 summary 使用，默认 12；满足 `0 < K < N`，表示优先以原文保留的最近 K 条 |

`max_messages` 统计**消息条数**，不是 Run 数，也不是 Token 数；只有非空 user/assistant 叙事计数。Opening 是 Assistant 消息，也计数；ToolResult、纯 ToolCall、摘要和本轮新 User 不计数。本轮新 User **必须**放入 Prompt，不能被裁剪。

Preset `budget`：

~~~json
{
  "max_context_tokens": 32768,
  "max_output_tokens": 4096
}
~~~

- `max_context_tokens` 可选，指**一次请求输入 + 预留输出的总 Context 上限**；省略时使用 Provider 模型 `contextWindow`。有效上限 `C = min(预设上限（若设置）, Provider 模型 contextWindow)`，不得绕过模型硬上限。
- `max_output_tokens` 为本次生成预留的输出 Token，必须同时满足 Provider 的输出上限。**用户界面、Preset JSON 和公开 API 只出现以上两个字段**；Token 估算误差、协议额外开销等由应用内部固定的 `TOKEN_ESTIMATION_GUARD` 处理，不可由用户配置。
- **有效输入预算** `B = C - max_output_tokens - TOKEN_ESTIMATION_GUARD`，必须大于 0。`TOKEN_ESTIMATION_GUARD` 是 AgentContext 的**内部固定值**（首期固定 1024 Token，版本变更允许调整），不属于用户可见设置。例如 C=32768、输出=4096、内部余量=1024，则请求 Prompt 可用 **27648 Token**。
- 统计范围是**最终完整 ModelMessage[]**，包含系统指令、预设节点、角色、世界书、状态、叙事历史、当前 User 和协议/工具定义；不能只给聊天记录算 Token。优先使用 Provider/tokenizer 可提供的计数或估算方式，未知时保守估算并保留内部固定余量；Provider 最终拒绝超长请求时给出明确错误，不能当作已成功运行。
- Provider 解析失败、上下文上限未知或预算非法时要阻止请求并提示修正配置，**不得假定一个无限窗口**。

## 3. Window：默认策略，先限制 N 条，再仅裁剪历史

1. 在读取叙事消息时，先只取最新 `max_messages=N` 条非空 user/assistant 叙事（本轮 User 不计入 N）；这是先行硬上限，不是 Token 超限判断。
2. AgentContext 基于这些**候选消息 + 当前 UserInput + 全量 State**，按 Preset 顺序**只构建一次非历史 Prompt 节点**，同时完成 lorebook/角色/状态匹配和模板展开。
3. 把固定 Prompt + 候选 messages + 当前 UserInput（保持 Preset 实际节点顺序，包含工具定义开销）拼成候选 Context，计算输入 Token；`tokens <= B` 则无需再裁剪。
4. 若 `tokens > B`，从候选历史最旧消息开始逐条裁剪，只替换 `chatHistory` 节点中的 messages，并重新**计算 Token**。**不重新匹配关键词、不重新执行 NodeBuilder、不重新渲染固定 Prompt**。
5. 最终若固定 Prompt + 本轮 User + 工具定义本身仍超 B，返回 `CONTEXT_BUDGET_EXCEEDED`，绝不裁当前 User 或必要 Prompt；Raw Entries、当前 State 均不修改。

本轮关键词是在最初 N 条候选消息上匹配的，裁剪后消失也保持原命中，接受可能多加载一些 lorebook 的误差。**Token 复查不是 Prompt 重建**。

## 4. Summary：条数阈值与 Token 压力双触发

Summary 只归档**较老的叙事**，保留近期原文，摘要生成行为由 Preset `summary_prompt` 控制。**与 Fanto 的区别**：Fanto 配置 Pi AgentHarness 原生 Compaction，由 SDK 生成/恢复摘要；SillyRealms 为严格满足「只使用 user/assistant 叙事、按当前世界线、可读取完整状态变量和用户自定义摘要 Prompt」的要求，首期由 AgentContext 管理摘要，并持久化为 `custom + sub_type=sillyrealms.summary`。Pi 原生 `compaction` 仍可完整存储/恢复但不主动触发，不能未经真实 PoC 验证就将其当作产品 Summary 的等价实现。

1. 从当前分支寻找最近的 `Entry(type=custom, sub_type=sillyrealms.summary)`，读取它的 `coveredThroughEntryId`。没有摘要则从 Opening 开始。取覆盖边界之后的可见叙事列表 H；最新 Summary 文本作为摘要前缀（如果存在）。
2. **触发条件是二选一**：
   - H 的条数 **达到/超过** `max_messages=N`；
   - 虽不足 N，但「最新 Summary + 全部 H + 当前 User」构建出的**完整 Prompt 已超过 B**。
3. 不触发时沿用「已有 Summary 前缀 + H + 当前 User」，也要通过最终 Token 校验。
4. 触发时优先保留 H 最后 `K=keep_recent_messages` 条原文；更老的 H 与旧 Summary 一同交给摘要模型。**先独立读取完整 State**，供摘要 Prompt 模板只读引用；实际摘要来源仅为叙事文本，工具调用/结果不可混入。
5. 摘要请求也必须符合 Provider 的 Context / 输出预算；较老材料一次放不下时按时间顺序**分批滚动摘要**，不静默丢掉未处理来源。所有摘要请求与结果存到技术 Entry 的 `generation` 元数据。
6. 生成新摘要后，**只替换 chatHistory 历史消息**为「新 Summary + 原文尾部 K 条」，保留先前单次构建的所有固定 Prompt 节点和匹配结果；重新统计完整 Context Token，但不重新筛选 lorebook/角色/状态根，也不重新渲染模板。若仍超限，可扩大摘要覆盖范围或在摘要长度预算内有限次数重试，只调整 messages；不能直接丢掉未摘要的尾部消息。仍不满足预算则报 `CONTEXT_BUDGET_EXCEEDED`，不持久化不完整摘要。
7. 摘要成功且预算通过后，在**当前 User 入库前**把一条 `custom/sillyrealms.summary` Entry 追加到原 tip 之后，其 `coveredThroughEntryId` 指向最后一条**被摘要覆盖**的原始叙事 Entry；随后将本轮 User 接在它后面。两条 Entry 使用**本轮同一个 run_id**，建议一个短事务提交；不删除或重挂已存在的消息和分支。
8. 下一轮**逻辑**模型历史始终是「最新 Summary 作为 assistant 前缀 + coveredThroughEntryId 之后的原文叙事 + 当前 User」，**不是**从 Summary Entry 的物理位置往后切。再次触发时用旧 Summary + 新原文生成一个新 Summary，模型历史只带最新一个摘要。

~~~text
真实父链：Opening → U1 → A1 → U2 → A2 → U3 → A3 → Summary(覆盖至 A2) → 本轮 U4
逻辑模型历史：Summary(Opening..A2) → U3 → A3 → U4
~~~

摘要生成失败/Token 校验失败时不写已完成 Summary，不发送依赖缺失上下文的主请求；原始历史仍完整。Run 归属、Entry 类型见 [Session](session.md)。

## 5. 单次 Prompt 构建的执行顺序

~~~text
Session → 当前世界线候选 NarrativeProjection（Window 先取 N 条）
  → 加载 World/Preset/Model/完整 State
  → 用候选消息 + UserInput，按 nodes[] 顺序筛选条目、匹配 keyword/when、渲染模板
  → 冻结本轮 Prompt（仅构建一次）
  → 候选 Prompt + messages + UserInput（遵守节点实际顺序）→ Token 判断
  → 不超限且 Summary 未达 N：直接使用
  → 需要压缩：仅裁剪/摘要 messages，Prompt 和条目命中保持不变
  → 组装最终 Context + Token 复查（绝不重新构建 Prompt）
  → 合法则同一 run_id 写 Summary（如有）和 User → 执行 Pi
~~~

- **明确接受命中偏差**：压缩后关键词可能从 messages 中消失，但本轮已选中的 lorebook/角色/状态 Prompt 不变；不要求匹配文本与最终消息完全一致。
- **限定允许偏差的边界**：可以多保留已选 Prompt，但最终 Token 必须合法。压缩只动历史 `chatHistory`，不动当前 User、最新全量 State、其它节点或工具定义。
- Pi 本轮执行中仍完整保存 ToolCall/ToolResult；下一轮只回放 user/assistant 叙事，不回放旧工具交换。
- **Run 分页与 Context 是不同轴**：UI 按当前分支的 run_id 分页 Raw Entries；模型历史按窗口/摘要调整，State 始终独立读取。

## 6. 最小验收

- 未指定 strategy 时默认 window；显式 none 拒绝；window 先最多 N 条，完整候选 Context 超 B 时从旧到新裁剪 messages，**不重匹配**；固定 Prompt + User 超 B 时明确失败。
- summary 在 N 阈值或 Token 压力下触发，只替换 chatHistory；压缩后不重建 Prompt；逻辑前置最新摘要、保留 K 原文且不丢旧分支；大材料分批摘要不漏输入；摘要与 User 同 run_id。
- Provider contextWindow 与 Preset max_context_tokens 正确取小值；输出预留和内部固定余量正确扣除；用户/JSON 只配置 max_context_tokens 与 max_output_tokens；Token 统计覆盖完整 Prompt。
- UI Run 分页、Raw Entry 恢复、完整 State 不因 Window/Summary 丢失。