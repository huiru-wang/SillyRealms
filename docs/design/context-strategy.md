# Context Strategy：Token 预算驱动的 Window / Summary

> 2026-11-04 目标方案，尚未实现。WorldCard 决定策略和消息数上限，Preset 决定本次 Token 预算，Provider 给出模型硬上限。**只支持 `window` 与 `summary`，默认 `window`，不提供 `none`。**

## 1. 三份数据严格分离

1. **Raw History**：沿选定 Session 世界线保存的全部原始 Entry。包含 User、Assistant（含 ToolCall）、ToolResult、Pi 技术 Entry、SillyRealms 摘要，不因上下文裁剪或换分支删除。
2. **Narrative Context**：从当前真实 Entry 父链投影出的可见 user/assistant **叙事文本**，不含 ToolCall、thinking、ToolResult、状态内联指令。Window/Summary 和 Token 预算只影响这份模型历史。
3. **Current State**：沿真实 Entry 父链寻找最近有效的完整状态快照，按当前世界卡 Schema 校验或重置。**绝不受历史滑窗或摘要影响**。

聊天 UI 展示完整可见历史（可以按 Run 分页），模型历史与世界书/状态根的关键词扫描只看**预算处理后的最终 Narrative Context + 当前 User**。摘要前的原文、被裁掉的旧消息不参与关键词匹配；`when` 总是读取完整 State。

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
  "max_output_tokens": 4096,
  "safety_margin_tokens": 1024
}
~~~

- `max_context_tokens` 可选，指**一次请求输入 + 预留输出的总 Context 上限**；省略时使用 Provider 模型 `contextWindow`。有效上限 `C = min(预设上限（若设置）, Provider 模型 contextWindow)`，不得绕过模型硬上限。
- `max_output_tokens` 为本次生成预留的输出 Token，必须同时满足 Provider 的输出上限；`safety_margin_tokens` 为 Token 估算误差、协议开销和工具开销预留。
- **有效输入预算** `B = C - max_output_tokens - safety_margin_tokens`，必须大于 0。例如 C=32768、输出=4096、余量=1024，则全部请求 Prompt 可用 **27648 Token**，不是 32768 Token。
- 统计范围是**最终完整 ModelMessage[]**，包含系统指令、预设节点、角色、世界书、状态、叙事历史、当前 User 和协议/工具定义；不能只给聊天记录算 Token。优先使用 Provider/tokenizer 可提供的计数或估算方式，未知时保守估算并保留 safety margin；Provider 最终拒绝超长请求时给出明确错误，不能当作已成功运行。
- Provider 解析失败、上下文上限未知或预算非法时要阻止请求并提示修正配置，**不得假定一个无限窗口**。

## 3. Window：默认策略，先限制条数，再按 Token 裁剪

每次运行（本轮 User 落库前）执行：

1. 从选中分支真实父链得到**全部**叙事消息；先截取最后 `max_messages=N` 条作为候选，按原始先后顺序保留。历史上已有摘要 Entry 也不当原始消息加入 Window。
2. 将候选历史和本轮 User 交给 AgentContext，加载最新全量 State，计算角色/世界书/状态根命中、预设节点和最终 ModelMessage[]。
3. 对**整个 Prompt**计算输入 Token。如果 `tokens <= B`，可直接发送；**无需等到 Token 用满才裁剪**，N 条是先行硬上限。
4. 若 `tokens > B`，**移除候选历史最早的一条叙事消息**，重新做关键词匹配、条目选择、Prompt 构建和 Token 计算；如此迭代，直到完整 Prompt 能放入 B。不要在已经匹配世界书后简单截取 ModelMessage 数组。
5. 可以裁到历史为 0 条，但**不能裁当前 User**，也不能默默移除必要的系统 Prompt、世界卡或状态。连无历史时仍超 B，则返回明确的 `CONTEXT_BUDGET_EXCEEDED`，提示用户缩短输入/预设/世界书或调大有效预算，不执行模型。
6. 选定的叙事集合在这一轮固定，用同一集合构建模型历史与关键词扫描范围。数据库的全部原始消息、分支与 State 完全不变。

所以 Window **同时**受「最多 N 条」和「完整 Prompt 的 Token 预算 B」限制；不是简单地“Token 到上限就截断整段消息”，而是**从最老的可裁叙事 Entry 开始逐条缩窗，并重建 Prompt**。

## 4. Summary：条数阈值与 Token 压力双触发

Summary 只归档**较老的叙事**，保留近期原文，摘要生成行为由 Preset `summary_prompt` 控制。

1. 从当前分支寻找最近的 `Entry(type=custom, custom_type=sillyrealms.summary)`，读取它的 `coveredThroughEntryId`。没有摘要则从 Opening 开始。取覆盖边界之后的可见叙事列表 H；最新 Summary 文本作为摘要前缀（如果存在）。
2. **触发条件是二选一**：
   - H 的条数 **达到/超过** `max_messages=N`；
   - 虽不足 N，但「最新 Summary + 全部 H + 当前 User」构建出的**完整 Prompt 已超过 B**。
3. 不触发时沿用「已有 Summary 前缀 + H + 当前 User」，也要通过最终 Token 校验。
4. 触发时优先保留 H 最后 `K=keep_recent_messages` 条原文；更老的 H 与旧 Summary 一同交给摘要模型。**先独立读取完整 State**，供摘要 Prompt 模板只读引用；实际摘要来源仅为叙事文本，工具调用/结果不可混入。
5. 摘要请求也必须符合 Provider 的 Context / 输出预算；较老材料一次放不下时按时间顺序**分批滚动摘要**，不静默丢掉未处理来源。所有摘要请求与结果存到技术 Entry 的 `generation` 元数据。
6. 生成新摘要后，必须重新构建「新 Summary + 原文尾部 K 条 + 当前 User」和世界书命中、完整 Prompt 并校验 B。若仍超限，**缩小保留尾部 K 并重新生成覆盖这些原文的新摘要**，或在允许的摘要长度预算内重试；不能直接丢掉尚未摘要的尾部消息。仍放不下时明确报 `CONTEXT_BUDGET_EXCEEDED`，不可写入不完整摘要。
7. 摘要成功且预算通过后，在**当前 User 入库前**把一条 `custom/sillyrealms.summary` Entry 追加到原 tip 之后，其 `coveredThroughEntryId` 指向最后一条**被摘要覆盖**的原始叙事 Entry；随后将本轮 User 接在它后面。两条 Entry 使用**本轮同一个 run_id**，建议一个短事务提交；不删除或重挂已存在的消息和分支。
8. 下一轮**逻辑**模型历史始终是「最新 Summary 作为 assistant 前缀 + coveredThroughEntryId 之后的原文叙事 + 当前 User」，**不是**从 Summary Entry 的物理位置往后切。再次触发时用旧 Summary + 新原文生成一个新 Summary，模型历史只带最新一个摘要。

~~~text
真实父链：Opening → U1 → A1 → U2 → A2 → U3 → A3 → Summary(覆盖至 A2) → 本轮 U4
逻辑模型历史：Summary(Opening..A2) → U3 → A3 → U4
~~~

摘要生成失败/Token 校验失败时不写已完成 Summary，不发送依赖缺失上下文的主请求；原始历史仍完整。Run 归属、Entry 类型见 [Session](session.md)。

## 5. 本轮构建时序与一致性

~~~text
读取当前 Session tip 的完整 Raw 父链
  → NarrativeProjection（user/assistant 叙事）
  → 独立读取当前完整 State
  → 读取 Preset Token 预算 + Provider 实际模型上限
  → window: 最近 N 条；或 summary: 原文/摘要逻辑链
  → 通过 Token 预检查，必要时缩窗或生成摘要
  → 对最终叙事集合重新做 lorebook/角色/状态关键词匹配 + when(fullState)
  → 预设七节点 NodeBuilder + TextRenderer
  → 校验最终 ModelMessage[] 输入 Token ≤ B
  → 同一 run_id 写摘要（若有）和本轮 User，执行 Pi
~~~

- **关键词文本范围必须和最终模型历史一致**；每次裁剪/重摘要导致文本变化，都重新匹配和构建，不保留过期命中条目。
- Pi 在**本轮执行期间**正常交换并持久化 ToolCall/ToolResult；下一轮重新构建历史时只回放叙事投影。
- **Run / Entry 分页与 Context 是不同的轴**：分页按当前世界线 run_id 成组返回 Raw Entries；模型使用选中世界线经策略和 Token 预算裁剪后的 Narrative Context。状态始终独立读取。

## 6. 最小验收

- 未指定 strategy 时默认 window；显式 none 拒绝；window 先最多 N 条，Prompt 超 B 时从旧到新裁剪并重匹配；固定 Prompt + User 超 B 时明确失败。
- summary 分别在 N 阈值、Token 压力下触发；逻辑前置最新摘要、保留 K 原文且不丢旧分支；大材料分批摘要不漏输入；摘要与 User 同 run_id。
- Provider contextWindow 与 Preset max_context_tokens 正确取小值；输出和安全余量正确扣除；实际 Token 统计覆盖完整 Prompt，不只数聊天文本。
- UI Run 分页、Raw Entry 恢复、完整 State 不因 Window/Summary 丢失。