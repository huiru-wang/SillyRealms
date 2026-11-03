# Context Strategy：完整历史、模型上下文、状态严格分离

> 2026-11-04 目标方案，尚未实现。策略由当前世界卡 data.context 配置；模型和摘要提示词由当前 Preset 配置。

## 1. 三种数据

1. **Raw History**：Session 的全部 Entry 消息和所有分支。包括 user、assistant（其中 toolCall 内容块）、toolResult 与 summary。所有真实 Pi Agent 消息都写入 entries，无论是否对用户可见。
2. **Narrative Context**：沿 tip_entry_id 的真实 parent_id 祖先链，将 Raw Entry 统一投影为仅 user 和 assistant 的**叙事 text**。Assistant 的 toolCall、thinking、状态更新内联块不在其中；toolResult、纯工具 Assistant 消息也不在其中。再按世界卡策略截取，产生本轮送给模型的聊天历史。
3. **Current State**：沿同一原始分支查最近完成的 Assistant Entry 所附全量状态快照。和当前世界卡 Schema 校验；不兼容则允许舍弃旧状态，按新 Schema initial 重置。不受上下文摘要/滑窗影响。

聊天 UI 可见内容与 NarrativeProjection 相同（user/assistant 的叙事）。世界书和状态根的**关键词匹配范围**恰好是本轮 Narrative Context 的叙事文本加当前 User 输入；不能把已经截断/压缩的旧文本拿回来匹配。Preset 的系统节点文本不参加关键词扫描，避免循环激活。

## 2. 世界卡配置

~~~json
{
  "context": {
    "strategy": "summary",
    "max_messages": 40,
    "keep_recent_messages": 12
  }
}
~~~

- strategy：none | window | summary，默认 none。
- max_messages：window 保留的最近 N 条可见 user/assistant 消息；summary 策略触发新摘要的**未覆盖叙事消息数阈值**，推荐 40。
- keep_recent_messages：只用于 summary，摘要后保留的最近 K 条叙事消息，要求 0 < K < max_messages，推荐 12。
- 只统计有实际文本的可见 user/assistant 消息：不包括 toolResult、Assistant 中的 toolCall、纯工具 Assistant、Summary、当前尚未纳入历史的 User。
- 已保存消息与摘要全部不删除；切换 WorldCard 策略只影响新请求的上下文。

## 3. 三种策略基本逻辑

| 策略 | 何时触发 | 实际送给模型的聊天历史 | 数据库 |
| --- | --- | --- | --- |
| none | 每次交互 | 当前分支全部 user/assistant 叙事 + 当前 User | 全量保存，不生成摘要 |
| window | 每次交互 | 当前分支最近 N 条 user/assistant 叙事 + 当前 User | 旧消息依旧保留，永不调用摘要 |
| summary | 未被最新摘要覆盖的可见叙事消息条数达到/超过 N | 最近 Summary + 摘要覆盖边界后留下的叙事消息 + 当前 User | 保留全量消息和全部 Summary，超阈值时调用摘要模型 |

### none

从真实分支恢复所有 user/assistant 文本，按时间顺序传给模型；以前产生的 Summary 不替代原历史。超过 Pi 模型实际上下文窗口时**明确报错**，不在后台偷偷更改策略或裁剪。

### window

从完整原始历史中过滤出 user/assistant 叙事，再只取最后 max_messages=N 条，追加当前 User 一次；不要求窗口中 user/assistant 两两成对。被排除的旧消息仍能在 UI 查看、从旧节点创建分支，不会消失。

### summary

1. 取得当前分支最新 Summary（如果有）及其中的 coveredThroughEntryId，标记之前已被压缩的叙事范围；如果没有，则从 Opening 开始。
2. 计算 coveredThroughEntryId **之后**的未覆盖可见 user/assistant 消息数。工具消息、旧 Summary 以及本轮当前 User 不计数。
3. 若未覆盖条数 **小于** max_messages=N，不生成摘要，使用「最新 Summary（如有）+ 未覆盖的全部叙事 + 当前 User」。
4. 若未覆盖条数 **达到/超过** N，保留最近 keep_recent_messages=K 条消息为原文，其余较旧叙事连同旧 Summary（如有）作为摘要输入。**摘要前独立读取真实分支最新全量 State。** 摘要 prompt 在 Preset 中配置，可以读取当前完整状态，例如状态引用表达式；通过共享 TextRenderer 渲染，只用叙事文本做实际摘要来源，不把 ToolCall/ToolResult 当内容摘要。
5. 摘要成功后，在**本轮 User 消息尚未入库前**，在原 tip 后**追加** type=summary 的 Entry，parent_id 指向原 tip；本轮 User 随后接到新的 Summary 节点上。payload 至少保存 text、coveredThroughEntryId（本次最后一条被覆盖的实际叙事 Entry ID）和摘要请求/回复消息，作为可恢复的内部执行记录。**不删除或重挂 K 条消息**。
6. 之后构建上下文时**逻辑重排**为：「最新 Summary 文本（作为 assistant 前缀）+ coveredThroughEntryId 之后的真实可见叙事 + 当前 User」。即使物理 Summary Entry 追加在最新消息的末尾，也不能错误地把其之前的保留消息全部丢弃；父链不改写，Summary 仅记录覆盖边界。
7. 下一次再次超阈值时，以旧 Summary 和新近叙事生成新的单一 Summary，避免累积多个摘要正文。每条分叉使用自己祖先链上的最新 Summary。

~~~text
原始 Entries：
Opening → U1 → A1 → U2 → A2 → U3 → A3 → Summary(coveredThrough=A2)

下一轮模型历史和关键词扫描：
Summary(Opening..A2) → U3 → A3 → 当前 User
~~~

摘要生成失败时不写已完成 Summary，不继续依赖压缩结果的主请求；明确报错允许重试。Summary 不参与状态结算。

## 4. Prompt 与条件匹配时序

~~~text
从本分支 tip 读取 Raw Entries（含工具消息）
  → NarrativeProjection（只保留 user/assistant 叙事）
  → 世界卡 none/window/summary 策略（必要时生成 Summary）
  → 得到本轮最终 Narrative Context + 当前 User
  → 独立读取最近有效全量 State（不受窗口影响）
  → WorldBook/状态根 keywords 与 when 判定
  → 按 anchor/position/order 建世界书索引
  → Preset 七系统 NodeBuilder 和自定义节点
  → TextRenderer 统一模板渲染
  → ModelMessage[]
~~~

激活条件：mode=always 无需关键词；mode=on_mention 按关键词 logic any/all。exclude_keywords 命中优先否决；若有 when，则基础命中 **AND** when(fullState) 为 true。**删除 manual 模式**，不单独配置关键字扫描深度。角色额外支持 order，按值升序排列。

Pi 在**本次模型执行过程中**仍可正常交换 toolCall/toolResult，并把每条产生的 Agent 消息正常持久化；**下一轮重建模型历史时**，只从原始 Entry 投影出 user/assistant 叙事消息，不回放这些工具消息。

## 5. 验收

- Raw Entries 含 user/assistant/toolResult 和 assistant 内 toolCall；UI、模型历史、关键词扫描中都不出现工具内容。
- none 不裁剪；window 精确最近 N 条可见消息；summary 达阈值摘要、保留 K 条，且 Summary 虽物理追加在最后，逻辑正确前置。
- 压缩只影响模型上下文；跨分支历史/摘要互不污染，旧消息保持可查。
- Current State 由原始父链独立读取，Schema 不兼容时可重置；when 使用全量状态。
