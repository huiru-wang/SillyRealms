# ServerV2 摘要与自动裁剪方案

状态：按最终确认实施。摘要记录及其计量仅在完整成功后保存；失败/中断不保存摘要记录或计量，成功但未知的 usage 为 null。依据当前原 Server 与 ServerV2 源码设计；本方案仅补齐上下文整理，不迁移模型输出扩展或 Studio 舞台。

任务拆解：[server-v2-context-compaction-tasks.md](server-v2-context-compaction-tasks.md)。

## 1. 产品行为

玩家仍然只发送一次输入。服务端立即保存用户消息并受理同一个 run，检查上下文预算：没有超过整理阈值就直接生成；达到阈值时，按照预设选择滑动窗口或滚动摘要，然后生成正文。

- sliding_window：从模型输入中移除较早的完整 run，保留最近的连续历史；不调用摘要模型，不删除数据库消息。
- rolling_summary：把旧摘要与本次需要压缩的较早历史合成一份新摘要，保留最近 5 个历史 run 的原文，再生成正文。当前提交不计入这 5 个 run，也绝不进入本次摘要。
- 原始历史一直可查看；摘要是模型上下文材料，不是普通 assistant 正文，不作为首条消息或额外 run 展示。
- 同一个 run 最多调用模型两次：一次摘要、一次正文；无须摘要时只有正文调用。不分块多次摘要、不自动重试、不失败后切换策略。
- 用户停止会同时取消正在进行的摘要或正文。摘要内部流不推送为 run.delta；正文仍按当前契约推送和保存完整/部分公开内容。

前端后续通过 run.summarizing / run.summarized 展示摘要进度；不增加 generating 事件或 phase 字段。本轮不迁移运行页面。

## 2. 原 Server 的参考与 V2 的调整

主要依据：

- apps/server/src/runtime/context/compaction/index.ts：生成前整理、60% 目标、候选结果复核。
- apps/server/src/runtime/context/compaction/sliding-window.ts、rolling-summary.ts：连续后缀选择、旧摘要合并、近期保护。
- apps/server/src/runtime/context/compaction/summary-generator.ts：摘要提示词、排除玩家系统指令、完整摘要要求。
- apps/server/src/runtime/context/snapshot.ts：读取摘要覆盖边界。
- apps/server/src/runtime/context/context-manager.ts、runtime/config.ts、domain/preset-budget.ts：预算与调用参数。
- apps/server/src/runtime/persistence/run-store.ts：原实现先准备摘要，再在事务里保存摘要和用户；这个顺序不适用于 V2。

保留产品语义，调整实现边界：

| 原实现 | V2 方案 |
| --- | --- |
| 按 user 消息划分轮次 | 按 entries.runId 分组，不区分开场与普通生成 |
| prepare 阶段结束后才保存用户 | 保持用户先保存；需要时在 user 后追加 compaction |
| summary 作为合成 assistant 混入 history | history.summary 单独承载摘要，history.messages 只承载未覆盖原文，避免重复注入 |
| RunStore 直接协调多个业务表 | narrative 调 modules 的公开 Service，SQL 留在属主 repository |
| run_preparations、准备日志、请求指纹及 usage 基线校准 | 均不迁移；复用 V2 本地估算与一次提交生命周期 |
| 单条消息携带某次调用计量 | 保持按 entry 保存：摘要调用在 compaction.metrics，正文调用在 assistant.metrics |

摘要覆盖正文的有效性需要一个 sourceHash；它仅判断现有消息是否被编辑，不参与模型请求指纹、重试或恢复。

## 3. 预算规则

继续使用预设已有字段，不新增配置面板：

```ts
config.contextStrategy = {
  strategy: 'rolling_summary' | 'sliding_window',
  maxContextTokens: number,
  maxOutputTokens: number,
  summaryPrompt: string
}
```

主叙事预算：

```text
safetyMargin = 1024
B = min(preset.maxContextTokens,
        model.contextWindow - preset.maxOutputTokens - safetyMargin)
T = floor(B * 60%)
```

B 是实际可用输入上限；T 是整理后的期望目标。输出预算仍需小于等于模型 maxTokens，B 非正直接报 INVALID_MODEL_BUDGET。与当前 V2 相比，增加原 Server 已使用的 1024 token 余量；不照搬 V1 对预设值超过模型窗口 80% 时直接拒绝的限制，使用有效上限 B。

对最终模型消息调用 V2 的 estimateInputTokens，包含系统模板、已激活角色/世界书/状态材料、摘要、历史、当前输入和消息开销。估算不是供应商精确 tokenizer 或实际用量。

- 估算小于 B：不触发新整理；rolling_summary 仍可使用已有有效摘要。
- 估算达到 B：执行所选整理策略。
- T 是软目标，B 是硬上限。保护内容导致无法达到 T、但最终不超过 B 时允许生成。
- 滑动窗口仍超过 B：停止本轮，返回 context_budget_exceeded。摘要一次后仍超过 B：直接以 summary_capacity_exceeded 结束，不做第二次摘要、额外裁剪或策略切换，保留已保存用户。
- 没有可整理历史但恰好等于 B 时允许直接生成；超过 B 则失败。

拆开当前 compileNarrativeContext 中的“纯编译/估算”和“最终预算断言”，候选超过预算时先允许策略处理，而不是在编译阶段直接抛错。

## 4. 历史与材料计算

捕获来源仍在首次模型/凭据 await 前同步完成，包括世界、预设、模型、三个 scope 状态和真实线性 entries；排除已保存的本轮 user，保留其 previousTip 作为来源边界。

历史处理保留 id、seq、runId、role 和可见 content。compaction 不作为普通消息投影，reasoning/tool-only 记录不进入摘要正文，但其 run 身份与边界仍参与完整分组。

截断仅发生在完整 run 边界。首条 assistant 所在 run 与其他 run 一样参与分组和近期计数，不引入 kind/origin。通用 entry API 若形成交错 runId，不能在跨越同一 run 的 seq 位置截断；扩大保留范围，没有合法前缀就按不可整理处理。

每个候选上下文都从同一份捕获数据重算材料激活，并使用同一个编译器估算：

- sliding_window 的关键词材料扫描仅看保留的历史和当前输入。
- rolling_summary 扫描有效摘要、未覆盖的保留历史和当前输入。
- when 使用本轮捕获的真实状态；裁剪或摘要不改变状态，不从摘要重建状态。
- 不根据“少几条消息必然少几个 token”判断最终可用性；关键词排除规则可能让材料重新激活。

变量职责：history.summary 是单份文本，history.messages 是保留原文。rolling_summary 要求启用且实际参与编译的节点中恰好出现一次 history.summary；没有或重复时返回 INVALID_NARRATIVE_TEMPLATE，避免摘要丢失或重复注入。默认预设已满足。此检查放在运行时，不收紧旧预设读取解析而导致无法打开编辑；不自动改写用户模板。sliding_window 将 history.summary 置空。

## 5. 滑动窗口

1. 使用完整可见原文历史，忽略旧 compaction；切换策略时不会因为此前摘要而丢失可用来源。
2. 从最旧完整 run 开始移除，始终只保留连续后缀；当前输入和固定节点不参与删除。
3. 对候选重新激活材料、编译并估算，找到符合 T 的最长候选后缀。
4. 若 T 无法达到，使用计算过程中符合 B 的最长候选；连零历史候选也无法满足 B 且没有其他符合 B 的候选，则失败。
5. 不写 compaction、不修改原历史、不增加 seq。下一轮根据当时的预设和历史重新选择。

滑动窗口不固定保护过去 5 轮；必要时可以移除全部旧历史，但不能删除本轮输入。这与滚动摘要的近期原文保护不同。

## 6. 滚动摘要

### 6.1 读取旧摘要

只考虑当前前驱链上最新的 compaction；失败/中断不生成 compaction。验证摘要非空、覆盖 entry 属于该会话且早于 compaction、覆盖边界为完整 run 结尾、覆盖范围在本轮 user 之前，并校验 sourceHash。

摘要不合法或来源正文已变化：忽略它，使用完整原始历史重新规划，不因为一份旧摘要阻塞正常历史读取。原始消息结构本身非法时仍按当前 invalid_context 失败。

### 6.2 选择范围

- 有有效旧摘要时，候选材料为“旧摘要 + 覆盖边界之后原文”；没有时为完整原文。
- 保留最近 5 个历史 run 的原文，这是滚动摘要的保护下限；不足 5 个时保留全部。
- 参考 V1 用固定材料估算、目标 T 和摘要输出预留选择更长的近期后缀；只压缩保护范围之前、尚未被旧摘要覆盖的完整前缀。
- 不压缩本轮输入，不只为重写旧摘要而调用模型。
- 没有可压缩前缀且最终超过 B 时失败，不能偷偷把滚动摘要改成滑动窗口。

### 6.3 摘要模型调用

使用本轮已经捕获的同一模型配置和凭据，不新增摘要模型设置。

```text
S = min(2048, model.maxTokens)
summaryInputLimit = min(floor(model.contextWindow * 75%),
                        model.contextWindow - S - 1024)
```

摘要 maxTokens=S，temperature/thinkingEnabled 沿用本轮预设与 pi 映射。沿用 V1 的独立摘要输入预算：它可能大于叙事 maxContextTokens，这个字段继续表示主叙事的整理阈值，不是所有辅助调用的统一硬限。

使用两条自有 ModelMessage：system 为 summaryPrompt，user 为明确的数据包，包含 previousSummary 和按角色标记的待压缩消息正文。复用 roleplay 解析排除玩家指令区段，避免将操作指令当作故事事实；不带世界全部提示词、reasoning、tool_calls 或运行元数据。

摘要与正文调用前都使用 ModelClient.assertMessageOrder 验证最终消息顺序，不通过搬动 system 消息绕过模型限制。调用摘要前按相同估算方法验证摘要输入上限，超过时停止本轮，不切片多次调用。摘要内部消费完整模型流，只有正常 stop、非空正文、无工具请求才是有效结果。最终 snapshot 为准，允许 SDK 定稿修正增量；不继承 V1 的“delta 拼接必须等于 finalText”限制。

失败、截断、取消或只有 reasoning 的摘要不能作为有效摘要保存，不生成普通助手消息。不会自动重试、切换策略或带超限原文继续正文生成。

### 6.4 保存摘要并复核预算

- 模型正常返回完整、非空且无工具调用的摘要后，保存 compaction 及其调用 metrics，再发布 run.summarized。
- 将摘要放入 history.summary，与保留原文重新编译；最终不超过 B 就继续正文，即使高于软目标 T。
- 摘要一次后仍超过 B，直接以 summary_capacity_exceeded 结束 run。不做第二次摘要、不额外裁剪、不切换策略，不要求额外的“相较之前减少了多少”验收。用户消息、已完成摘要与摘要用量均保留，前端按 stop_reason 展示文案。
- 保存仍使用 SessionService 现有 expected parent/tip 约束，防止破坏线性链；不增加摘要生成期间的历史编辑锁或 context_changed 分支。这类并发写入准入后续统一处理。
- 摘要保存成功后，即使正文失败或停止也保留该摘要。摘要的成功事件表示摘要已生成并保存，不表示整个 run 或预算检查已通过。

## 7. entries 持久化与线性关系

不新增表、列、触发器或 schema version，复用已有 compaction 类型：

```ts
{
  id: compactionEntryId,
  sessionId,
  parentId: userEntryId,
  runId,                    // 与本次 user / assistant 相同
  type: 'compaction',
  role: null,
  payload: { summary: '完整的新摘要正文' },
  state: null,
  extData: {
    summary: {
      coveredThroughEntryId: '被覆盖前缀最后一条 message 的 ID',
      sourceHash: 'SHA-256 摘要覆盖范围内全部 message 的规范化来源'
    }
  },
  metrics: {
    requests: [{ requestId, provider, modelId, usage, durationMs, firstTextMs? }]
  }
}
```

规范化来源按 seq 排序，包含 message 的 id、seq、runId、role、可见 content；不含 compaction、状态、metrics、时间戳或其他扩展。Hash 覆盖的是完整被摘要范围，而不只是本次新增压缩的部分。sourceHash 只用于摘要来源有效性，不记录请求指纹或恢复日志。

物理链：

```mermaid
flowchart LR
  P[原 tip] --> U[本轮 user 已保存]
  U --> C[有效 compaction 可选]
  C --> A[本轮 assistant 可选]
  U --> A
```

有 compaction 时 assistant.parentId=compactionEntryId，否则仍为 userEntryId。不能维持当前写死 userEntryId 的假设。compaction.state=null，不改变有效 message 状态，不发布 state.changed。

run 的完成结果仍在首条 user entry.extData.narrative，不移动到 compaction；所有记录共享 runId，分页仍最多 5 个分组，afterSeq 可以发现新增 compaction。首条会话消息所在 run 没有例外规则。

savedMessageIds 继续只列已保存的 message，不把 compaction ID 混入。tipEntryId 可能指向 compaction（摘要成功后正文未保存），客户端必须使用真实 tip，不能等同于最后一个聊天气泡。

## 8. 摘要的写入边界与历史编辑

摘要由服务内部生成。通用 HTTP entry 追加不再接受 type=compaction；通用编辑不能修改 compaction.payload 或 extData.summary，也不能给普通 entry 伪造 summary 元数据。SessionService 保留内部 compaction 持久化能力。

用户仍可修改普通消息正文。摘要读取时用 sourceHash 发现覆盖来源变化并忽略过期摘要；状态或 metrics 更新不使摘要失效。sourceHash 在后续读取时检查覆盖来源是否变化；本轮不增加异步期间的编辑冲突处理，不增加历史版本表或通用并发锁。

旧 compaction 缺少 sourceHash 或元数据不完整时不用于上下文，原始历史仍完整可用；不批量改写旧摘要。

## 9. 多次调用的计量

当前 ServerV2 的持久化 usage 位于 entries.metrics_json，领域字段为 entry.metrics.requests[].usage。正文调用指标随 assistant 保存；完全没有可保存助手输出时，该次调用没有历史 metrics 载体，实时 run.usage 仍按规则发布。session.usage 不作为累计账本。

本方案不把指标搬到首条 user：

- 摘要调用的指标存 type=compaction 的 entry.metrics。
- 正文调用的指标继续存 assistant entry.metrics。
- user.metrics 保持 null，不增加 setRunMetrics 或调整用户消息计量禁写规则。
- requests 保持现有 requestId/provider/modelId/usage/durationMs/firstTextMs 结构，不增加 status/purpose。
- metrics=null 表示没有调用记录；请求内 usage=null 表示有尝试但用量未知。
- run.usage 仍只发布一次，汇总本轮成功保存的摘要和正文；参与统计的任一次未知则总量为 null，无参与统计的调用为零。
- 历史 usage 查询汇总所有 entry.metrics，包含 compaction；不重复将同一次请求保存到另一条 entry，不新增表。

最终确认：摘要失败或中断不保留 compaction，不保存这次摘要的 metrics，也不计入 run.usage。摘要记录及计量只在完整成功后一起保存。成功摘要未拿到可信用量时 requests[].usage=null，汇总也为 null。不生成 summary=null 的计量占位记录。

只有失败摘要而没有正文调用时，本轮 run.usage 为零；允许与实际供应商消耗存在误差。正文有可保存输出时仍保存对应 metrics，未知 usage 为 null；完全无输出时沿用现有不造空助手的行为。

## 10. 事件、锁与错误

继续使用 /sessions/:id/events，run.created 保持当前 user 消息形状；摘要正文不推送为聊天 delta。摘要事件为：

```ts
{
  event: 'run.summarizing',
  data: { runId, sessionId, provider, model, timestamp }
}
{
  event: 'run.summarized',
  data: { runId, sessionId, provider, model, timestamp, entryId }
}
```

run.summarizing 在摘要输入/取消检查通过且准备发起调用时发布；run.summarized 在完整摘要和 metrics 成功落库后发布，entryId 是对应 compaction ID。没有 run.phase、generating 事件或 phase 字段。失败/取消的摘要不发 summarized；完整摘要落库后预算仍超限，可以先 summarized 再 stopped。

典型顺序：run.created → run.summarizing → run.summarized → 正文 run.delta → run.usage → run.completed/run.stopped。摘要后超限则没有正文 delta，直接 run.usage → run.stopped(summary_capacity_exceeded)。

会话执行锁复用当前 active Map 的同步占位，不另建第二份锁状态。首次 await 前获得，占用覆盖用户保存、摘要、正文、持久化及结算准备；完成结果和计量保存后释放，再通知终态。用户保存失败立即释放，任何异常最终释放。重复提交仍为 RUN_ALREADY_ACTIVE/409；不同会话可以并行，stop/shutdown 可以取消持锁执行。

本轮的锁只保证同一会话不同时执行多个 run。编辑、删除、手工追加、状态修改等操作是否拒绝持锁会话，留待后续统一处理；不在本轮增加多进程锁、排队或恢复。保留既有 tip 冲突校验。

| 情况 | 保存与终态 |
| --- | --- |
| 滑动窗口无法满足 B | 用户保留；context_budget_exceeded |
| 摘要输入超过上限 | 用户保留；summary_capacity_exceeded，无模型尝试 |
| 摘要调用失败、空白、截断、工具调用 | 用户保留；summary_failed；不保存摘要及其计量 |
| 摘要完成后上下文仍超过 B | 用户、完整 compaction 与摘要 metrics 保留；summary_capacity_exceeded，结束 run |
| tip 改变/会话删除 | 沿用 tip_conflict/session_deleted，不覆盖外部写入 |
| compaction 或计量落库失败 | 沿用 message_persist_failed，保留此前成功保存的数据 |
| 用户停止/正常关闭 | cancelled/server_shutdown；保留已提交摘要；未完成摘要及其计量丢弃，正文部分输出照常保存 |
| 摘要保存成功，正文模型失败 | 摘要保留，助手有公开输出则保存部分内容及正文 metrics，沿用正文失败原因 |

新增停止原因只需 summary_capacity_exceeded、summary_failed；不增加 context_changed。仍然只有一次总 usage 和唯一终态，不发布 run.failed，不新增 HTTP prepare 接口。

## 11. 代码结构和模块职责

```text
apps/serverV2/src/usecases/narrative/
  context.ts               # 同步捕获 entries、配置、状态；接入可用摘要
  history.ts               # message 投影、完整 run 边界、摘要覆盖与来源 hash
  compile.ts               # 纯编译和估算；与最终预算断言分开
  materials.ts             # 显式 summary/history 输入，按候选重算激活
  context-policy.ts        # B/T、输出预算、摘要输入预算
  prepare-context.ts       # 策略分支、调用一次摘要、验收和提交候选
  summary.ts               # 摘要提示词、指令区段过滤、内部流结果校验
  model-call.ts            # 复用可取消读取、调用指标；不依赖 SDK
  execute.ts               # 正文推送、保存、总 usage 和终态
  index.ts                 # 维持用户先保存、同会话占位与停止生命周期
```

只在出现实际复用的取消/模型调用处提取函数，不预建策略注册器、ContextManager 类、Runner 基类或插件层。编译器和历史计算为纯函数；存储编排只使用 modules 公开 service.ts；新增同步事务能力经 usecases.ts 装配，不把数据库或 RunStore 传进 narrative。

SessionService/Repository 负责内部 compaction 与其 metrics 写入、通用编辑保护以及 entries 查询。StateService 不处理摘要，pi 不感知摘要/会话/数据库，只继续提供已有 ModelClient 流。

## 12. 实施与验收边界

只修改 ServerV2 及其事实文档/AGENTS，原 Server 保持独立。StudioV2 已有预设策略字段无需新增配置；阶段展示和 compaction 的前端过滤留给舞台接入。

函数测试覆盖候选选择、完整 run 边界、材料重新激活、摘要覆盖/失效、策略切换、一次摘要后超限即结束、双调用与取消、锁释放、按 entry 计量、父链与分页。有限 ModelClient 流替身仅用于函数行为验证；使用内存 SQLite，不启动真实服务、不执行 HTTP/浏览器链路，不访问模型或 Keychain。

不包含运行恢复、自动重试、分块摘要、并行模型调用、工具循环、自动状态更新、行动建议或新的 runs/run_preparations 表。
