# SR 上下文预算与滞后式历史压缩方案 v1

> 实施更新（2026-11-10）：上下文策略、模型窗口限制、上次主叙事 Usage 驱动的压缩及五轮降级已实现；具体现状见 `docs/technical/context-compaction.md`。按用户最新决定，会话按连续历史处理；旧预设不按第 10 节映射，而是在一次性数据库迁移中删除并将引用切换到新的标准预设。Provider 溢出自动重试尚未实现。
>
> 策略容量更新：`compact` / `standard` / `extended` 调整为 128K / 256K / 512K；以下原始设计中的容量示例不再适用。

> 原始状态：设计已确认（2026-11-09）；部分实施，以本页实施更新及技术文档为准。
>
> 本方案调整 SR 的上下文预算与历史压缩机制。目标是让创作者只选择上下文策略，由 SR 根据模型能力和上一次模型真实 Usage 自动管理压缩；正常运行路径不再自行估算完整 Prompt 的 Token 数。
>
> 关联方案：`plan/sr-session-token-usage.md`。本方案复用其中的 UsageStore、Session 累计统计、latestContext 和 Compaction Entry 设计，不重新建立 Token 统计体系。
>
> 以下为原始设计，部分内容已被上述实施更新取代。

## 1. 目标与原则

1. 普通预设不再暴露数值型 `max_context_tokens`，改为三个上下文策略枚举。
2. 策略在 SR 内部映射为上下文目标容量，并受实际模型上下文窗口约束。
3. 正常路径不对本轮完整 Prompt 进行 Token 估算；下一轮开始前，读取上一轮主叙事请求的真实 Usage，判断是否需要压缩。
4. 允许上下文在相邻两轮之间超过策略目标一次。策略容量是压缩触发目标，不是每次请求前的强制精确边界。
5. 正常压缩固定保留最近 **5 轮对话**；更早的历史从上次压缩边界或会话起点开始合并为摘要。
6. 原始 Entries 永远保留。摘要通过 Compaction Entry 和 `coveredThroughEntryId` 表达覆盖边界，不修改原始 Entry 的父子关系，也不向历史中间插入 Entry。
7. Usage 不可用时不得沿用更早的有效 Usage 冒充当前值；使用确定性的 5 轮滚动保留策略降级。
8. Provider 明确返回上下文溢出时，提供一次更激进的压缩重试；不允许无限重试。

## 2. 预设配置与策略映射

### 2.1 配置结构

预设预算配置调整为：

```json
{
  "budget": {
    "context_strategy": "standard",
    "max_output_tokens": 4096
  }
}
```

- `context_strategy` 只允许 `compact`、`standard`、`extended`。
- `max_output_tokens` 保留现有含义，仍由预设配置。
- 删除普通预设中的 `max_context_tokens`。
- 默认策略为 `standard`。

### 2.2 系统内部映射

| 枚举 | 默认上下文容量 | UI 名称 | 适用场景 |
|---|---:|---|---|
| `compact` | 32,768 Tokens（32K） | 轻量对话 | 短对话、低成本、较积极压缩 |
| `standard` | 65,536 Tokens（64K） | 标准叙事 | 默认选择，兼顾连续性与成本 |
| `extended` | 131,072 Tokens（128K） | 长篇沉浸 | 长篇叙事、多角色、复杂世界 |

以上是 SR 的策略目标容量，不代表模型原生上下文窗口，也不是承诺每次请求都精确使用到该容量。

### 2.3 有效容量与压缩触发阈值

```ts
const CONTEXT_STRATEGIES = {
  compact: 32_768,
  standard: 65_536,
  extended: 131_072,
} as const;

const effectiveContextTokens = Math.min(
  CONTEXT_STRATEGIES[preset.budget.context_strategy],
  model.contextWindow,
);
```

策略容量不能超过模型实际上下文窗口。下一轮触发阈值预留输出空间、安全空间和下一轮用户输入空间：

```ts
const SAFETY_RESERVE = 1_024;
const NEXT_USER_INPUT_RESERVE = 2_048;

const triggerThreshold =
  effectiveContextTokens
  - preset.budget.max_output_tokens
  - SAFETY_RESERVE
  - NEXT_USER_INPUT_RESERVE;
```

例如：标准策略 65,536、输出预留 4,096，则触发阈值为 58,368 Tokens。

- `max_output_tokens` 仍须小于等于模型允许的最大输出。
- 有效容量扣除输出及安全预留后必须大于 0，否则属于无效预算配置。
- 2K 用户输入预留是内部安全余量，不限制用户输入长度。
- 不在普通配置 UI 暴露以上计算值。

## 3. 基于上一轮真实 Usage 的滞后式压缩

### 3.1 正常判断逻辑

在新一轮 `ContextManager.prepare()` 阶段，读取 Session 最近一次有效的主叙事请求快照。

上一轮生成完成后的上下文规模近似为：

```ts
const previousContextTokens =
  latestContext.inputTokens + latestContext.outputTokens;
```

其中：

- `inputTokens` 是 Provider 对上一轮完整模型请求报告的输入 Token，包含其报告口径中的缓存输入。
- `outputTokens` 是该次主叙事请求的输出 Token。
- 两者相加近似表示上一轮请求完成后的上下文规模。
- 该值包含实际请求中的预设、世界卡、状态、历史、用户输入及 Provider 计入的工具结构等，不是单纯聊天消息 Token。
- 主叙事包含工具续写时，使用 Run 中最后一次 generation / continuation 请求的 Usage；该请求已经包含前序工具交互进入上下文后的实际输入。
- `summary` 和 `state_review` 请求不更新主叙事上下文快照，但它们的 Usage 仍计入 Session 累计消耗。

判断：

```ts
shouldCompact =
  previousContextTokens >= triggerThreshold;
```

- 未达到阈值：不压缩，直接构建下一轮上下文。
- 达到或超过阈值：在创建本轮 User Entry 前压缩历史，再构建本轮请求。
- 不计算本轮用户输入与固定 Prompt 的 Token 数，不预测本轮最终上下文大小。
- 允许一次滞后误差；如果新一轮输入或输出明显增大，可能超过策略目标，交由 Provider 溢出恢复处理。

### 3.2 Usage 快照必须代表“最新主叙事请求”

复用现有 `sessions.usage_json.latestContext`，增加：

```ts
type LatestContext = {
  inputTokens: number | null;
  outputTokens: number | null;
  usageStatus: 'reported' | 'unavailable';
  contextWindowTokens: number;
  modelId: string;
  apiModelConfigId?: string;
  runId: string;
  requestId: string;
  finishedAt: number;
};
```

需要修正当前 `UsageStore.settleRun()` 的选择逻辑：

- 当前实现只在主叙事请求 Usage 有效时更新 `latestContext`；若最新请求没有 Usage，会留下上一轮旧快照。
- 新实现应先找出本 Run 中时间最新的 generation / continuation 请求，不论其 Usage 是否可用。
- 最新请求 Usage 有效：更新 input/output Token 和 `usageStatus: reported`。
- 最新请求 Usage 不可用：更新为 `usageStatus: unavailable`，Token 字段为 null；不得保留更早请求的 Token 数冒充最新值。
- 如果本 Run 在发起主叙事请求前就失败（例如准备阶段失败），没有新的主叙事请求，则不覆盖已有快照。
- `state_review`、`summary` 不参与上述“最新主叙事请求”的选择。
- Session 累计 Usage 的现有归集逻辑不变。

### 3.3 快照失效条件

以下情况不能把旧快照直接当成当前上下文规模：

- 当前世界线与快照所属 Run 不一致。
- 当前模型配置与快照的 `apiModelConfigId` 不一致。
- 预设或世界卡的 Prompt 相关内容发生修改。
- 其他会改变固定上下文构成的配置发生变化。

复用现有 branch stale / model config stale 判断，并补充 Prompt 配置指纹或等价失效机制。快照失效时按 Usage 不可用处理，不沿用旧数值。

## 4. 固定保留最近 5 轮的压缩规则

### 4.1 对话轮次定义

一轮对话按一个 User Entry 划分：

- 从一条 User Entry 开始，到下一条 User Entry 之前结束。
- 该轮内所有 Assistant 叙事消息都属于同一轮，包括工具调用前后的多条 Assistant 消息。
- ToolResult 等内部协议消息不单独计为对话轮次，遵循现有 `RunStore.narrative()` 的上下文构建规则。
- 不从一轮中间截断；保留或摘要都以完整轮次为单位。

### 4.2 压缩范围

正常压缩时：

1. 找到最近 5 轮对话的起始 User Entry。
2. 最近 5 轮及其后续 Assistant 叙事内容完整保留。
3. 最近 5 轮之前的所有未压缩历史参与摘要：
   - 如果没有旧摘要：从会话第一条可叙事消息开始。
   - 如果存在旧摘要：从旧摘要覆盖边界之后开始。
4. 新摘要由“旧摘要 + 本次新进入摘要范围的历史消息”生成。
5. 新摘要的 `coveredThroughEntryId` 指向本次摘要覆盖的最后一条原始叙事 Entry。
6. 若不足 6 轮，且没有需要继续合并的旧历史，则不生成新摘要。

最终提供给模型的逻辑上下文：

```text
最新摘要（覆盖会话起点/旧摘要边界至最近 5 轮之前）
最近 5 轮原始对话
本轮 User Input
```

不使用固定 Entry 条数（例如 N=40、K=12）作为正常触发或保留策略。

### 4.3 摘要内容规则

- 摘要必须承接旧摘要，不能只总结本次新增片段而丢失更早上下文。
- 继续遵循现有 `summaryNarrative()`，从玩家指令中排除不应进入长期摘要的内容。
- 摘要请求的 Usage 计入 Session 累计消耗，但不更新 `latestContext`。
- 摘要生成失败时本轮准备失败，不得静默丢弃待摘要的原始历史。
- 保留现有摘要生成 trace / generation 数据，以便诊断和复现。

## 5. Compaction Entry 与 Entries 链路

### 5.1 不向 Entries 中间插入消息

不修改原始 Entry 的 `parent_id`，不删除历史消息，也不把摘要插入两条既有消息之间。

当前 `RunStore.startRun()` 已有可复用的行为：

1. 以当前 Session tip 为父节点，追加一条新的 `compaction` Entry。
2. `ext_data.summary.coveredThroughEntryId` 指向摘要覆盖的最后一条原始叙事 Entry。
3. 再以 Compaction Entry 为父节点，追加本轮 User Entry。
4. Assistant / ToolResult 后续继续沿现有 Entry 链追加。

例如，数据库父子链：

```text
E1 → E2 → ... → E12 → C1 → U13 → A13
```

逻辑模型上下文：

```text
Summary(E1 ~ E7)
E8 → E9 → E10 → E11 → E12
U13
```

其中 C1 不要求在物理链中间；ContextManager 读取最新 Compaction Entry，根据 `coveredThroughEntryId` 找到逻辑边界，将摘要放在边界之后的保留消息之前。

### 5.2 后续重复压缩

例如第一次压缩生成 C1，覆盖 E1～E7；后续又有若干轮消息，第二次压缩生成 C2：

- C2 的摘要输入 = C1 的摘要 + C1 覆盖边界之后、最近 5 轮之前的新历史。
- C2 的 `coveredThroughEntryId` 更新为新的最后覆盖 Entry。
- ContextManager 只采用当前分支上最新的有效摘要。
- C1 和所有原始 Entry 仍保留在数据库中，不删除、不重写。
- 分叉读取仍按各自祖先链寻找对应分支上的最新 Compaction Entry，不能跨分支复用摘要。

## 6. Usage 不可用与降级行为

### 6.1 含义

“Usage 不可用”不是 Token 数为 0，而是 SR 没有拿到可信的模型 Token 统计。常见原因：

- Provider / OpenAI 兼容服务没有返回 Usage。
- 流式响应没有启用或没有携带 Usage。
- Provider 适配器未正确解析 Usage。
- 请求中断、网络错误或进程异常，未收到最终 Usage。
- Usage 字段缺失或格式不符合有效统计要求。

### 6.2 降级策略

不再使用旧的有效 Usage，也不在主链路使用 UTF-8 字节数或 `chars / 4` 冒充 Token 数。

当最新主叙事 Usage 不可用、快照 stale 或从未有过有效 Usage 时：

- 使用固定 5 轮滚动策略作为安全降级。
- 如果未压缩历史超过 5 轮，将 5 轮之前的历史并入摘要，保留最近 5 轮。
- 如果只有 5 轮或更少，则不为凑策略而压缩。
- 该降级保证无 Usage 的 Provider 仍能控制历史增长，但不承诺上下文 Token 精确落在策略容量内。
- 当后续某轮重新返回有效 Usage，恢复基于真实 Usage 的阈值判断。

这样不需要为了 Usage 缺失而给每个 Provider 实现 Tokenizer。

## 7. Tokenizer 与估算器的范围

正常上下文预算判断只使用 Provider 返回的真实 Usage，不依赖模型专属 Tokenizer。

需要移除当前错误的 Token 估算用途：

- `prompt-builder.ts` 的 `estimateTokens()` 当前返回 UTF-8 字节数，不能继续作为 Token 数。
- `ContextManager.prepare()` 不再通过估算固定 Prompt Token 来提前抛出预算超限。
- `history-compactor.ts` 不再通过估算 Token 决定正常压缩触发、历史保留数量或摘要范围。
- 不要求本次为所有 Provider 实现专属 Tokenizer。

摘要请求本身仍需要避免构造无限大的批次。可采用保守的字符长度分批（按 Unicode code point 切分），Provider 明确返回上下文溢出时缩小批次重试；字符数只作为分批上限，不得标注或当作 Token 数。

未来若确实需要精确的固定 Prompt 诊断，再按 Provider 能力增加官方计数 API / 本地 Tokenizer，作为可选能力，不阻塞本方案。

## 8. Provider 上下文溢出的异常恢复

滞后式策略允许上一轮之后出现一轮容量误差，因此必须处理 Provider 明确返回的上下文长度超限错误。

建议异常恢复：

1. 识别 Provider 的明确 context length / context window exceeded 错误，不能把普通网络错误或内容拒绝误判为上下文溢出。
2. 对当前 Run 自动执行一次更激进的历史压缩重试，例如把正常保留的 5 轮临时降低到 3 轮。
3. 重试使用重建后的摘要 + 保留历史 + 当前 User Input。
4. 成功后持久化新的摘要边界，保证后续 ContextManager 读取到的逻辑历史与本次重试上下文一致。
5. 恢复路径不得在原始 Entries 的父子链中间插入 Entry。由于当前 User Entry 可能已经写入，需通过明确的恢复写入方法将恢复 Compaction Entry 追加到当前链 tip，并让 `coveredThroughEntryId` 指向更早的历史边界；后续逻辑上下文应为“新摘要 + 覆盖边界之后的原始消息”，包含本轮 User / Assistant。
6. 只自动重试一次；仍然溢出时返回明确错误，不无限压缩或重试。
7. 如果固定 Prompt 本身已超过模型能力，或者缩减历史后仍无法请求，提示用户检查世界卡、预设、状态定义或模型上下文能力。没有 Provider 精确计数时，不虚构各节点 Token 数。

异常恢复可以临时突破“保留 5 轮”的正常规则；5 轮是常态保留策略，不是异常时不可突破的硬约束。

## 9. 需要调整的现有代码

| 文件 | 改造内容 |
|---|---|
| `apps/server/src/agent/context/context-manager.ts` | 校验 `context_strategy`；解析策略容量；读取 latestContext；根据上一轮 Usage 决定是否压缩；移除固定 Prompt Token 估算硬检查；处理 stale / unavailable 降级 |
| `apps/server/src/agent/context/history-compactor.ts` | 移除 N=40、K=12 和 Token 估算驱动逻辑；改为保留最近 5 轮、摘要此前所有未压缩历史；承接旧摘要 |
| `apps/server/src/agent/context/prompt-builder.ts` | 移除 UTF-8 字节数冒充 Token 的 `estimateTokens()` 用法；若无其他用途则删除该函数 |
| `apps/server/src/agent/persistence/usage-store.ts` | latestContext 增加 outputTokens / usageStatus；最新主叙事请求无 Usage 时显式记录 unavailable；不沿用旧值 |
| `apps/server/src/agent/runtime/run-post-processor.ts` | 确保最新主叙事请求快照按 generation / continuation 选择，summary / state_review 不覆盖 |
| `apps/server/src/agent/persistence/run-store.ts` | 沿用当前 Compaction Entry 追加方式；必要时增加上下文溢出恢复的摘要持久化方法，不重写历史 parent 链 |
| 预设领域模型、路由与前端预设配置 | 将 `max_context_tokens` 替换为 `context_strategy` 枚举；UI 提供三个策略选项 |
| `apps/server/test/context.test.ts`、`history-runs.test.ts`、`usage.test.ts` 等 | 增加策略、滞后触发、5 轮边界、Usage 不可用、分叉摘要和溢出恢复测试 |

## 10. 旧预设配置迁移

已有预设可能仍使用数值型 `max_context_tokens`。迁移时保留 `max_output_tokens`，将旧值映射到最接近的策略：

| 旧 `max_context_tokens` | 新策略 |
|---:|---|
| 小于等于 49,152（48K） | `compact` |
| 大于 49,152 且小于等于 98,304（96K） | `standard` |
| 大于 98,304（96K） | `extended` |
| 缺失 | `standard` |

迁移完成后移除旧字段。预设读取层可以短期兼容旧格式，但保存时统一写新结构。

## 11. 验收标准

### 11.1 策略与预算

- [ ] 预设只保存 `context_strategy` 和 `max_output_tokens`，不再暴露 `max_context_tokens`。
- [ ] 三种策略分别映射 32K / 64K / 128K。
- [ ] 模型原生上下文窗口小于策略容量时，自动使用模型窗口。
- [ ] 输出预留、安全余量和下一轮用户输入余量参与触发阈值计算。
- [ ] 无效枚举、输出超出模型限制、阈值小于等于零时返回明确配置错误。

### 11.2 滞后式判断

- [ ] 上一轮真实上下文低于阈值：本轮不压缩，不运行 Token 估算器。
- [ ] 上一轮真实上下文达到或超过阈值：本轮开始前压缩。
- [ ] 上下文判断使用最新 generation / continuation 的 input + output，不使用 Session 累计 Token。
- [ ] summary / state_review Usage 只计入累计，不改变最新主叙事快照。
- [ ] 允许本轮输入/输出造成一次策略容量误差，不在每轮发送前计算完整 Prompt。

### 11.3 五轮压缩与 Entries

- [ ] 最近 5 轮 User/Assistant 叙事完整保留，不按 Entry 数量截断。
- [ ] 5 轮之前的全部未压缩历史与旧摘要合并生成新摘要。
- [ ] 少于等于 5 轮且无待合并旧历史时，不生成摘要。
- [ ] Compaction Entry 追加到当前 tip，不插入原始 Entries 中间。
- [ ] `coveredThroughEntryId` 正确指向摘要覆盖的最后一条原始叙事 Entry。
- [ ] 原始消息、Entry parent 链和历史分叉均不被破坏。
- [ ] 连续多次压缩只使用当前分支最新摘要，摘要边界单调向后推进。

### 11.4 Usage 不可用

- [ ] Provider 不返回 Usage 时标记 unavailable，不当作 0。
- [ ] 最新请求 unavailable 时不复用旧快照进行阈值判断。
- [ ] Usage unavailable / stale 时启用固定 5 轮滚动降级。
- [ ] 后续 Usage 恢复后自动回到真实 Usage 触发模式。

### 11.5 异常恢复与回归

- [ ] Provider 明确上下文溢出时最多自动压缩重试一次。
- [ ] 恢复压缩不在 Entries 中间插入记录，不破坏当前 User / Assistant 历史顺序。
- [ ] 固定 Prompt 超出模型能力时返回可理解的诊断，不伪造 Token 明细。
- [ ] 不因摘要失败静默丢弃历史。
- [ ] 世界线分叉、模型切换、预设修改、世界卡修改后正确处理 Usage 快照失效。
- [ ] 使用 FakeGateway 验证，不依赖真实付费 Provider。

## 12. 不在本次范围

- 不实现所有 Provider 的模型专属 Tokenizer。
- 不在每轮请求前计算完整 Prompt 的精确 Token 数。
- 不以字符数或 UTF-8 字节数伪装 Token 数。
- 不删除原始 Entries，不重写原始消息父子关系。
- 不更改 Session 累计 Token 统计口径，不增加费用统计。
- 不改变世界卡、角色卡、预设节点的业务语义。
- 不重构整个 Pi Agent Runtime；只复用其 Usage 驱动压缩思想。

---

**最终原则：策略由创作者选择，真实 Usage 由 Provider 提供，压缩由 SR 在下一轮开始前执行；正常情况下保留最近 5 轮，旧历史通过带边界的摘要延续。**
