# SR 上下文压缩策略模块方案 v1

> 日期：2026-11-13
>
> 状态：设计方案，待实施。本次修订计划并提交推送，不修改运行时代码或数据库。
>
> 代码基线：`ca50e88`（SRRuntime v2）；本版修订 `fe61355` 中的上下文策略计划。
>
> 最新决定：在 `context/compaction/` 下采用策略模式；每个 Run 首次主生成前只做一次触发决策，Run 内不检查上下文预算、不压缩。策略预算是整理目标，Provider 的硬窗口拒绝按普通失败处理，由用户重试。

## 1. 产品行为与范围

### 1.1 一个 Run 只准备一次上下文

这里的 Run 指一次用户提交对应的完整执行，包括 Agent 内全部模型／工具往返。准备阶段属于该 Run 的生命周期，但发生在首次主生成之前；摘要模型调用也发生在准备阶段。

1. Runtime 接受请求、取得锁、建立运行 journal，冻结本轮配置、模型、权限及上下文来源。
2. ContextManager 按选定策略建立初始历史投影，估算完整输入；**只在这里决定一次是否触发压缩**。
3. 未超过阈值，直接使用初始投影；超过阈值，执行一次所选策略。滚动摘要内部可以顺序分批。
4. Runtime 接受结果，保存完整摘要候选及边界（如有），开始 Direct 或 Agent 主生成。
5. 主生成开始后，Agent 只按正常流程追加 assistant／tool 消息、构造下一请求；不再估算占用、不检查策略预算、不调用压缩。
6. Provider 拒绝硬窗口超限时，本 Run 失败，保存错误原因、触发现有失败事件；用户重试时建立新 Run，再执行一次准备。

“一次检测”限定触发决策的次数。为选择滑窗范围、安排摘要批次和记录整理后占用，准备阶段内部可以使用固定估算器；这些计算不能启动第二轮压缩，也不能成为主生成的预算准入检查。

### 1.2 三类结果必须分开

| 结果 | 处理 |
|---|---|
| 未达到触发阈值 | 原投影继续生成 |
| 已整理但仍超过策略目标，或没有可整理旧历史 | 保留必要内容，继续生成；记录整理结果 |
| 摘要执行、边界校验或持久化失败 | 结束本 Run，保存 failed 状态和原因，触发失败事件；不继续生成 |
| Provider 硬窗口拒绝 | 正常失败；不自动压缩、重试或重放工具 |

用户主动停止仍是 `stopped`，进程中断仍按 `interrupted` 恢复，不伪装成摘要失败。没有收到用户停止信号的 Provider 异常中止属于失败。

策略只改变模型看到的历史。原始 entries、权威状态、本轮权限和既有 Direct 扩展／Agent 工具语义继续保留。本文替代前版的 Run 内检查、续轮压缩、自动校准、二次更短摘要及“最终必须放得下才生成”的要求。

首期不引入独立 CompactionRunner、Pi AgentSession、动态策略插件、自动策略切换、多模态估算或新的任务服务。摘要继续使用 SR 提示词及共享 ModelClient。历史计划中的会话清空、预设删除和路由回退不属于本次范围。

## 2. 触发阈值与策略目标

### 2.1 共用公式

```text
configuredWindow:
  rolling_summary:
    compact  = 131072
    standard = 262144
    extended = 524288
  sliding_window:
    budget.max_context_tokens

W = min(configuredWindow, model.contextWindow)
O = budget.max_output_tokens
S = 1024
T = W - O - S

E = 首次主生成完整输入的估算 token 数
trigger = E > T
```

`E` 包含当前实际发送的 system／自定义提示、角色与世界书、状态与能力规则、历史／摘要、当前用户输入、tools 及相关包装。当前输入已经计入，不额外扣“下一轮用户输入预留”。等于 `T` 时不触发。

`T` 同时是 Run 前的触发线和希望达到的输入目标，**不是每次模型调用的硬限制**。输出预留用于准备阶段计算；`max_output_tokens` 仍会传给每一次主模型请求。Run 内增长超过 `T` 时继续。

例：滑窗配置 32768、主输出 4096、模型窗口不少于 32768 时，`T = 27648`。Run 开始前估算超过 27648 才裁剪；开始生成后即使增长超过该值也不再次处理。

配置有效性与内容超额分开：token 配置必须是正的安全整数；模型窗口有效，`O <= model.maxTokens`，有效 `T > 0`。不满足这些条件是配置错误，在主模型调用前拒绝；**内容的 `E > T` 不是配置错误**。未绑定模型的预设保存时检查自身预算关系，运行时再按实际模型检查。配置窗口大于模型窗口时以模型窗口计算；不静默缩小用户的主输出配置。

### 2.2 各策略的触发、目标与超额处理

| 项目 | 滚动摘要 `rolling_summary` | 滑动窗口裁剪 `sliding_window` |
|---|---|---|
| 初始投影 | 有效旧摘要 + 所有未覆盖历史 + 必要内容 | 全部原始净叙事 + 必要内容，不注入旧摘要 |
| 触发 | Run 前 `E > T` | Run 前 `E > T` |
| 范围 | 旧摘要与最近 5 个完整旧回合之前的连续历史 | 可选旧历史的早期完整回合 |
| 目标 | 用一份新摘要替换旧前缀，保留最近 5 个完整旧回合及必要内容；希望总输入不超过 `T` | 在必要内容之外，保留固定估算下能够放入 `T` 的最大完整连续历史后缀 |
| 没有可处理旧历史 | 原投影继续，记录 `no_eligible_history` | 保留必要内容继续 |
| 整理后仍超目标 | 继续，不追加压缩，不缩减保留回合 | 必要内容自身超额时保留 0 个可选旧回合，继续 |
| 模型调用 | 只在触发且有旧前缀时调用摘要模型 | 不调用摘要模型 |
| 持久化 | 成功且有缩减收益时保存完整摘要及覆盖／保留边界 | 只保存本次选择诊断，不建立永久裁剪水位 |

“必要内容”包括本轮固定提示、状态／权限、工具定义、当前用户输入及协议必需消息。滚动摘要还固定保留最近 5 个已结束旧用户回合；不足 5 个全部保留。已结束包括 completed、failed、stopped、interrupted，其合法正文和缺口语义按现有规则参与投影。

“完整回合”从一个 user 开始，到下一个 user 之前，包含参与模型投影的关联消息。不得拆开 toolCall 与对应 toolResults，不跳过中间大回合去挑更早的小回合。

两种策略互斥；不隐式改用另一策略。没有达到软目标不是摘要执行失败，未完成的摘要批次也不能按“软目标”放行。

## 3. 用户配置

### 3.1 配置契约

沿用预设 `budget`，增加算法判别字段 `strategy`。旧 `context_strategy` 继续表示滚动摘要的窗口档位。

```ts
type PresetBudget =
  | {
      strategy: "rolling_summary";
      context_strategy: "compact" | "standard" | "extended";
      max_output_tokens: number;
    }
  | {
      strategy: "sliding_window";
      max_context_tokens: number;
      max_output_tokens: number;
    };
```

| 用户配置 | 滚动摘要 | 滑动窗口 | 语义／默认值 |
|---|---|---|---|
| `budget.strategy` | 必填 | 必填 | 新建预设默认 `rolling_summary` |
| `budget.context_strategy` | 必填 | 不允许 | compact / standard / extended；新建默认 standard |
| `budget.max_context_tokens` | 不允许 | 必填 | 输入与输出预留合计的策略窗口；切换到滑窗时表单初值 32768 |
| `budget.max_output_tokens` | 必填 | 必填 | 每次主生成／continuation 的输出上限；新建默认 2048 |
| `summary_prompt` | 生效，可编辑 | 保留但不发送 | 沿用既有摘要提示词 |

滚动摘要示例：

```json
{
  "budget": {
    "strategy": "rolling_summary",
    "context_strategy": "standard",
    "max_output_tokens": 4096
  },
  "summary_prompt": "概括已发生的事件、人物关系与未解决的线索。"
}
```

滑动窗口示例：

```json
{
  "budget": {
    "strategy": "sliding_window",
    "max_context_tokens": 32768,
    "max_output_tokens": 4096
  },
  "summary_prompt": "保留原配置，切回滚动摘要时继续使用。"
}
```

`max_context_tokens` 不是累计消耗额度，也不是 Run 内持续执行的硬门槛。`max_output_tokens` 是每次主模型请求的参数，不是整个 Run 的总输出额度，也不是摘要输出长度。

### 3.2 首期固定的内部规则

| 内部规则 | 首期值 |
|---|---|
| 安全余量 | 1024 tokens |
| 滚动摘要保留旧回合 | 最近 5 个完整回合 |
| 摘要输出上限 | `min(2048, model.maxTokens)` |
| 摘要输入占窗口比例 | 0.75，另扣摘要输出及安全余量 |
| 一次准备最多摘要请求 | 8 次，顺序分批共用；不是重试次数 |
| 单批辅助文本上限 | 12000 个 Unicode codepoint，不作为 token 换算 |
| 粗估规则 | 固定版本、固定系数，见第 5 节 |

这些不是首期用户可配置项。不增加自动校准、重试次数、Run 内压缩开关或独立摘要模型选择器。主输出配置与内部摘要输出预算分开。

### 3.3 配置界面

Studio 预设的“上下文”区域提供：

- “历史处理方式”：滚动摘要／滑动窗口裁剪。
- 两者均显示“最大输出长度（tokens）”。
- 滚动摘要显示原三档窗口、“摘要提示词”入口，说明保留近期完整对话并整理早期历史。
- 滑窗显示“上下文上限（tokens）”，说明只发送能够容纳的近期完整历史，不生成摘要。
- 两者共同说明：每次开始生成前检查一次；生成过程中可能继续增长，服务商超限时本次失败，可调整配置后重试。

切换策略保留用户现有主输出值；滑窗窗口初值 32768，保存时必须提交明确数值。草稿可保留两个分支的输入，提交时只包含当前分支字段。滑窗隐藏不生效的摘要入口，但不删除 `summary_prompt`。修改配置仅影响下一个 Run。

Studio 目前仍使用 fixture 与本地 store，本次后续实现须同步类型、校验和本地存储兼容，不扩大为完整 Studio 预设 API 接入。Web 现有预设页做同契约的最小适配；导入、导出、编辑往返不能丢字段。

## 4. 模块与职责

### 4.1 目录

在 `apps/server/src/runtime/context/compaction/` 下新增：

| 文件 | 职责 |
|---|---|
| `index.ts` | `prepareForRun` 公共入口、静态策略注册、一次触发决策 |
| `types.ts` | 配置、快照、估算基准、候选与准备报告 |
| `estimator.ts` | 适用 usage 基准 + 新增粗估，或全量固定粗估 |
| `history.ts` | 完整净叙事、回合分组、必要内容和边界验证 |
| `rolling-summary.ts` | 连续前缀选择、滚动摘要与候选构造 |
| `sliding-window.ts` | 最大完整连续后缀选择 |
| `summary-generator.ts` | 独立预算、顺序分批、结果校验 |

`context/budget.ts` 保留窗口数学及请求一致性能力，移除主生成依赖 `report.fits` 的发送门槛。旧 `history-compactor.ts` 中可复用的摘要分批、提示与边界逻辑迁入模块后删除旧生产入口。

### 4.2 调用关系

| 组件 | 职责 |
|---|---|
| Runtime | 锁、运行 journal、冻结配置、候选接受、取消、事务、失败终态、事件和用量结算 |
| ContextManager | 构建初始上下文；每 Run 调用一次 `prepareForRun`；之后只构造 continuation 请求 |
| compaction 模块 | 准备期估算、一次触发判断、执行选定策略、返回候选与诊断 |
| 策略实现 | 变换历史投影，不直接写 SQL、执行工具或修改权威状态 |
| ModelClient / UsageStore | 模型请求、取消、真实 usage 记录及失败归类 |

压缩不作为 runner 注册。DirectRunner 与 AgentRunner 共享一次准备结果。Agent 的后续请求构造入口应明确命名为 `buildContinuationRequest` 或等价纯组装入口，不再复用包含估算／压缩的 `prepareRequest`。

即使后续工具结果、动态消息或工具选择改变请求，也只按正常执行语义组装并记录真实 usage，不触发预算管理。冻结配置、权限、消息协议和请求发送前的一致性检查仍然执行；它们不检查策略预算。

### 4.3 接口示意

```ts
interface ContextCompactionStrategy {
  readonly kind: PresetBudget["strategy"];
  project(snapshot: ContextSnapshot): ContextProjection;
  reduce(input: StrategyInput, services: CompactionServices):
    Promise<StrategyCandidate>;
}

type ContextChange =
  | { kind: "none" }
  | { kind: "rolling_summary"; update: SummaryCandidate }
  | {
      kind: "sliding_window";
      firstKeptEntryId: string | null;
      omittedTurnCount: number;
    };

type PreparedContext = {
  context: Context;
  sourceFingerprint: string;
  change: ContextChange;
  report: {
    method: "usage_plus_estimate" | "full_estimate";
    estimatedInputBefore: number;
    estimatedInputAfter?: number;
    threshold: number;
    triggered: boolean;
    outcome: "unchanged" | "summarized" | "trimmed" | "skipped";
    reason?: "no_eligible_history" | "no_reduction" | "protected_over_target";
    targetExceeded: boolean;
  };
};
```

以上复用既有 Context、RuntimeError 等类型，非新的外部 API。完整报告还记录窗口、输出预留、安全余量、估算器版本和基准失效原因；无 prompt 全文。

公共入口：初始投影 → 估算并决定触发 → 最多一次策略执行 → 返回候选。未触发不调用 `reduce`；策略内部的批次不递归调用该入口。整理后的全量粗估只用于结果和诊断，不构造必须满足的 `fits` 凭证。

### 4.4 快照与历史来源

快照包含当前祖先链的完整原始净叙事及稳定 Entry ID、已有摘要与边界、已结束回合、当前输入、冻结提示与状态／权限、实际工具定义、模型／API／序列化标识、可用 usage 基准、source/tip 指纹及 AbortSignal。

读取层不能先按旧摘要覆盖边界截断原始历史，否则滑窗、窗口扩大和策略切换无法正确恢复。净叙事沿用既有过滤：Direct 扩展尾块、思考和私有内容不进入叙事；确实进入上下文的工具关联必须完整。

纯重建函数只替换历史区域，保留消息角色、顺序、能力规则及本轮激活结果。压缩不重新激活角色、世界书或状态模块。当前 Run 尚无新工具往返；开始主生成后产生的消息全部由正常执行流程追加并保留。

## 5. 简单估算：usage 基准或全量粗估

### 5.1 适用基准

每个 Run 准备时，优先检查最近一条有真实 usage 的主生成／continuation 请求。摘要及其他独立请求不能作为主上下文的基准。只读取已完成请求中适用的基准；本 Run 的后续请求只记录用量，供下一 Run 判断。

基准至少关联模型／Provider／API／序列化方式、模式、完整输入身份、历史投影及覆盖位置。直接复用请求 fingerprint、Entry ID 和现有 `latestContext` 元数据；不建立自动校准服务。

以下条件全部成立才复用：

1. 服务商确实报告了合法 usage；SDK 默认初始化对象不能算真实报告。
2. 基准请求的有效输入在当前投影中原样保留，变化仅为其后的实际回填／追加内容。
3. system（含中途 system）、自定义提示、状态、工具定义、模型、历史及摘要等没有改变基准覆盖内容。
4. 能确定新增内容的边界；请求本身正常完成，未失败或取消。

```text
E = lastReportedInputTokens
  + fixedEstimate(该次输入之后实际进入本次上下文的内容)

基准不可用：
E = fixedEstimate(当前完整输入)
```

优先使用真实 **input tokens**，不是无条件使用最近一次 `totalTokens`。当时输入中的 system／tools 已包含在该 input usage 中，不再重复相加；上一回复只粗估实际回填部分，未回填的 thinking、Direct 扩展尾块等不进入上下文占用。

Pi 归一化输入口径为 `input + cacheRead + cacheWrite`；SR 的 `inputTokens` 已包含这些输入，不能再次加缓存。`totalTokens`、整个会话累计消耗或多条请求 usage 的和，都不能直接作为当前上下文长度。

### 5.2 失效即全量粗估

下列变化导致旧基准失效：压缩、裁剪、恢复被省略的历史、历史编辑／重生成、摘要替换、策略切换、system／状态／tools 变化、模型／API／序列化变化，以及缺少关联元数据。

这里的“历史变化”指追加以外的变换；能够证明为纯追加的部分走上一节。不能证明输入覆盖关系时，直接全量粗估，不做复杂的节点增减差额修补。

这也解决下一轮 system prompt 变动的问题：不能拿上一请求的输入或 totalTokens 原样当作新一轮占用；system 变化就使基准失效。Direct 的布局经常变化时，频繁回退全量粗估是允许的。

压缩后的投影重新使用固定规则全量估算。新的真实主生成 usage 可成为后续 Run 的候选基准；这只是更换基准，**不是自动校准**。

### 5.3 固定文本规则

首期固定采用以下规则，集中常量并标识内部版本：

- ASCII 字符按 1/3 token；Han、Hiragana、Katakana、Hangul 字符按 1 token。
- 其他 Unicode 字符按 UTF-8 字节数估算。
- 每条消息额外 16 tokens，请求级额外 64 tokens。
- 工具名称、描述、schema 按实际序列化文本估算，每个工具再加 32 tokens。
- 文本／工具声明只统计一次；追加估算不重复加入基准已有的请求级包装。
- 合计向上取整并检查安全整数；未支持的多模态内容明确拒绝，不能记成零。

这些是固定工程启发式，不是精确 tokenizer 或误差上界。首期不保存、学习或更新校准系数，不按实际 usage 调整字符规则；后续规则变更需显式修改版本。

已有 DeepSeek BPE 能力可用于离线比较，不作为主准备路径的额外计数要求。普通文本模型使用同一固定规则；缺少专用 tokenizer 不阻断生成。

### 5.4 估算与计费彻底分开

估算只进入准备报告，不能补写真实 usage。Run 内各主生成／continuation／摘要请求仍照常记账，但记账不触发占用估算、阈值判断或压缩。

每次摘要批次按独立请求 ID 记录实际 input、output、cache、费用及状态；无 usage 保持 unavailable，不能用估算填零或补齐。真实报告的零值如实保存；没有报告证据的全零 SDK 对象不标记为 reported，也不作为占用基准。

## 6. 滚动摘要

### 6.1 范围与一次处理

1. 初始投影使用有效旧摘要和全部未覆盖净叙事。旧摘要来源／边界无效时不使用；可安全恢复完整原始净叙事则重新投影，无法还原则准备失败。
2. 仅在 `E > T` 时选择范围：保留最近 5 个完整旧回合及必要内容。
3. 将有效旧摘要与更早的连续历史作为一次逻辑摘要任务。覆盖只能连续推进，不能漏掉中间片段。
4. 没有新的可摘要前缀时返回原投影，记录 `no_eligible_history`；不为压缩已有摘要单独启动一次调用。
5. 全部批次成功后生成一份候选摘要；只替换历史区域。

用户指令不能被摘要误记为已经发生的故事事实。沿用 SR 提示词、指令过滤和既有有界 gaps，表达失败／停止／状态未同步的缺口；摘要不替代权威状态。

### 6.2 独立预算与顺序分批

摘要使用当前配置的主模型，不注册业务工具，独立设置输入／输出预算：

```text
summaryOutput = min(2048, model.maxTokens)
summaryInputLimit = min(
  floor(W * 0.75),
  W - summaryOutput - S
)
```

完整摘要请求包含平台约束、`summary_prompt`、旧摘要／上一批摘要、缺口标记、来源包装及本批正文，全部按固定规则估算后安排批次。这里的预算用于限制摘要任务自身，是准备阶段内部工作，不是 Run 内主生成检查。

顺序处理选中的全部前缀：上一批摘要加入下一批，直至全部来源处理完成。总共最多 8 次真实摘要请求；不能在失败后再次请求，不能递归调用压缩入口。

超长纯文本可按 Unicode codepoint 拆片供内部摘要使用，保存来源与偏移；摘要完成后的覆盖边界只推进到完整消息组边界。工具关联不得作为孤立协议消息发给摘要模型，应在摘要输入中保持关联标识；对外保留历史不拆组。

固定摘要指令和前一摘要已耗尽输入预算、无法容纳任何新片段，或 8 次调用内无法处理完整范围，属于摘要任务失败。单批 12000 codepoint 只是辅助资源上限；达到任一输入限制均需分批，不把字符数等同 token 数。

每批结果必须正常 stop、非空、无工具调用，且流与最终结果一致。length／截断、Provider error、无用户停止信号的 aborted、重复终态等立即失败。失败后不继续后面的批次，不发送主生成；SDK／网关包装层也不能自动重试已失败的摘要请求。

### 6.3 成功后的候选处理

完整摘要成功后，重建输入并全量粗估，做两项不同的判断：

- **结构与覆盖校验必须通过**：无遗漏、无重复，保留范围完整，来源未变化；失败结束 Run。
- **容量目标只用于报告**：即使仍 `> T` 也继续，不再生成更短摘要，不减少保留回合。

若完整有效摘要没有缩减收益，则保留原投影，记录 `no_reduction`，继续生成；摘要费用仍记录。收益比较使用原投影与新投影的同一固定全量估算，不混用 usage 基准值和新粗估值。这属于有效摘要未带来收益，不是摘要调用失败。

有收益的 SummaryCandidate 包含摘要、`coveredThroughEntryId`、`firstKeptEntryId`、来源指纹、受控 gaps 及摘要请求 ID。Runtime 接受前只存在内存中；不得把部分批次写入有效历史，也不写入覆盖边界。

## 7. 滑动窗口裁剪

### 7.1 触发后选择连续后缀

滑窗从完整原始净叙事开始，忽略已有滚动摘要及覆盖水位。未触发则完整发送该初始投影。

触发时使用固定粗估完成一次选择：

1. 先计入全部必要内容。
2. 必要内容已超过 `T` 时，保留 0 个可选旧回合，记录 `protected_over_target`，继续主生成。
3. 否则从最新完整旧回合向前加入，直到再加相邻旧回合会超出 `T`。
4. 保留这一最大完整连续后缀；最新旧回合也放不下时允许保留 0 个。
5. 按原角色和原顺序重建，校验边界；最终全量粗估仅作诊断。

使用各组固定估算累计，准备复杂度保持线性；无模型调用，无重试循环。估算同实际投影保持一致；若最终报告仍超目标，记录后继续，不进行第二轮处理。

### 7.2 保留与恢复

裁剪仅影响本次 Run 初始模型上下文；原始记录完整保存。没有新的 compaction Entry，也不推进摘要覆盖边界。

下次 Run 再从完整合法历史建立投影，窗口扩大后可以重新包含此前省略的历史。`firstKeptEntryId` 和省略回合数只作本次诊断，不能作为后续读取历史的永久起点。

## 8. 策略切换与摘要兼容

| 切换 | 下一个 Run 初始投影 |
|---|---|
| 滚动摘要 → 滑窗 | 忽略旧摘要，从完整原始净叙事选择；旧摘要记录保留 |
| 滑窗 → 滚动摘要 | 恢复仍有效的旧摘要 + 其边界之后的全部历史，包括滑窗曾省略的部分 |
| 滑窗窗口扩大 | 从完整历史重新选择，允许恢复早期回合 |
| 滚动窗口档位变化 | 使用合法摘要投影，按新阈值决定一次是否整理 |

摘要的覆盖有效性与 usage 基准有效性不同。策略切换使旧 usage 基准失效，不等于必须删除仍有效的摘要。任何策略都不得把滑窗保留起点误当成摘要覆盖边界。

原始历史、失败／停止留下的合法正文和必要缺口按同一投影规则处理。无法证明来源链或覆盖完整时明确失败，不猜测边界。

## 9. Runtime 生命周期、失败和保存

### 9.1 准备成功到开始生成

Runtime 沿用现有锁、expected tip、幂等与冻结配置机制。先建立 `pendingRun`，再进行一次 ContextManager 准备。

如果有完整摘要候选，在现有 `RunStore.startRun` 事务中先验证并保存摘要，再保存当前 user Entry；无候选只写 user Entry。最后一次取消检查到同步事务提交之间不 await。提交使用稳定候选身份防重，覆盖范围必须早于当前 user Entry。

提交后才开始主生成。摘要已提交后，主生成失败或用户停止不回滚该摘要；后续正常终态仍按既有 Direct／Agent 规则处理状态。

取消前未提交的摘要全部丢弃；tip 冲突、来源不匹配或保存失败不得发送主生成。权限、协议、来源完整性检查不受软预算规则影响。

### 9.2 Run 内执行

首次主生成消费准备好的上下文。Agent continuation 只在该视图后追加本 Run 完整往返，按冻结主输出参数构造请求。删除现有实现中的对应路径，并撤销前版计划中的以下设计：

- continuation 中的预算估算、阈值判断及压缩。
- 主生成或 continuation 因 `BudgetReport.fits === false` 被拒绝发送的逻辑。
- Run 内摘要检查点、续轮候选及 finalize 再次提交摘要。
- 自动校准、二次更短摘要、硬窗口拒绝后的自动压缩／重试。

保留请求身份／实际 payload 一致性校验，验证的是本次构造的请求；不得使用 Run 前的旧 fingerprint 检查追加后的新请求。继续记录每次真实 usage，不产生 continuation 预算报告。

### 9.3 准备失败必须有持久终态

当前代码的准备失败发生在 user Entry 创建前：结算主要写 `unattachedTotals` 并清掉 `pendingRun`，随后发送失败通知；`RunStore.status/duplicate` 只查 user Entry，因而无法持久查询该失败 Run。后续实现需补齐，而不能只增加一条错误日志。

明确使用既有 `sessions.usage_json` 增加内部 `preparationRuns`，作为未创建 user Entry 的终态归档，不新建表或叙事 Entry。保留最近 64 个记录：

- runId、用户 requestId、起止时间、expectedTipEntryId。
- failed／stopped／interrupted、finalized 阶段及已解析的公开运行元数据。
- 受控 errorCode；准备／摘要阶段、失败批次和安全 causeCode。
- 已封账的 RequestMetrics 与实际 totals，不包含用户输入、候选摘要、prompt 或原始 Provider 异常。

在现有结算事务中：核对 pending → 按模型请求 ID 去重结算 → 写准备终态（即使零模型调用）→ 更新累计数据 → 清 pending。重复封账不得重复计费。先保存终态，再通知失败；保存失败不得伪报已持久完成，保留可恢复 journal 并走既有持久化错误处理。

`RunStore.status` 和 `duplicate` 先查询原 user Entry，再查准备终态。复用既有公开 Run 投影，准备失败返回 `messages: []` 和当前 tip，不扩展公开 Run 字段。准备终态不混入叙事 ancestry 分页，不改变历史 tip。

已有 user Entry 的去重范围不缩短。准备终态的查询／去重只保证最近 64 个；淘汰明细不扣减 cumulative／unattachedTotals，过期 run 查询返回既有 RUN_NOT_FOUND。用户主动重试使用新的 requestId／runId，原失败记录不改成成功。

中断恢复沿用 pending journal：无 user Entry 的 pending 归档为 interrupted，再清理；公开投影仍按现有 failed + RUN_INTERRUPTED 语义。有 user Entry 的恢复沿用原流程。

### 9.4 失败事件与错误原因

沿用内部 `run.updated` 的 failed 终态，由现有会话事件路由转换为 SDK 已有的 `run.failed`，不新增同义事件。失败事件和 GET Run 使用相同的 `errorCode/errorMessage`；准备失败尚未创建正文流，通过既有会话 SSE 发布失败。

| 情况 | 终态／错误 | 历史与后续行为 |
|---|---|---|
| 摘要调用失败、空结果、截断、分批预算不可满足或次数耗尽 | failed；沿用 SUMMARY_FAILED／SUMMARY_EMPTY，记录安全原因及失败批次 | 丢弃全部本次候选，不写 user／摘要，不主生成，用户重试 |
| 完整摘要仍超软目标、没有可整理前缀、无缩减收益 | 继续生成，诊断标注原因 | 不重复压缩 |
| 必要内容自身超软目标 | 继续生成 | 保留必要内容，不因估算超额失败 |
| 主生成／continuation 被 Provider 硬窗口拒绝 | failed；新增明确的 `PROVIDER_CONTEXT_WINDOW_EXCEEDED` | 沿用正常失败最终化，不自动恢复或重放工具 |
| 其他 Provider 错误 | 现有正常失败分类 | 沿用正常失败流程 |
| 用户主动停止 | stopped | 未提交候选丢弃，已提交摘要保留 |
| 进程中断 | 按既有 interrupted 恢复并公开为失败 | 已有真实 usage 保留，未知仍未知 |

硬窗口错误由统一模型错误适配识别已知 Provider 错误码／结构，映射到受控新码；不把本地 `E > T` 映射为此错误。未能明确识别的错误保留通用 Provider 分类，不假定为窗口拒绝。各 runner 不得再次把明确分类降为泛化 PROVIDER_ERROR。

摘要中的 Provider 硬窗口拒绝，公开保持 SUMMARY_FAILED，内部记 causeCode=PROVIDER_CONTEXT_WINDOW_EXCEEDED；其他原因同样保留可追踪的安全分类。对外不增加通用 detail 字段，不泄露原始请求。

任何实际发生的摘要请求，无论整次准备成功、失败还是停止，都照实结算。成功提交后关联 compaction／Run；准备失败保存在 preparationRuns 与现有 unattachedTotals。返回候选中的 usage 仅供关联，不重复累加。

## 10. 配置迁移与 API

新增共用 `apps/server/src/domain/preset-budget.ts`，路由、Runtime、默认预设及导入导出共用。

- 当前合法旧格式只有 `context_strategy + max_output_tokens` 时，归一化为 rolling_summary，保留原值。
- 新写入、规范化响应和导出显式包含 strategy。
- 两种分支严格校验；不允许同时出现 context_strategy 与 max_context_tokens，未知算法或缺少输出上限拒绝。
- 无 strategy 且只有旧数值 max_context_tokens 的更早格式不猜成滑窗；不属于本次认可的当前旧格式。
- 同策略 PATCH 可局部更新，合并后完整校验；跨策略必须提交目标分支的完整 budget，原子替换。
- 不直接沿用 `{ ...current.budget, ...patch.budget }` 处理策略切换，避免混入旧分支字段。
- summary_prompt、其他能力、旧预设及 session/world 引用保留；读取规范化，正常保存时写新格式，不做数据清空。
- 已开始 Run 使用冻结配置；新的配置在下一个 Run 生效。

JSON 扩展采用向后兼容读取。旧 usage 没有基准关联信息时回退全量粗估；旧 session 缺少 preparationRuns 按空处理。任何必要迁移只允许非破坏性增量。

## 11. 与现行代码的差异及实施范围

当前 `context-manager.ts` 在首次和 continuation 的 `prepareRequest` 中执行 measure／压缩循环；`budget.ts` 的发送检查还要求 `report.fits`。仅移动旧文件无法达到本方案，必须同时改变调用链与 PreparedRequest 的含义。

主生成的 PreparedRequest 只表达已组装、冻结且身份一致的请求，不再要求附带一份“预算通过”的报告。Run 前报告属于 Run 准备结果；continuation 不伪造 `fits: true` 或无限窗口来绕过旧检查。wire fingerprint 如需保留，应与 token 计数解耦。

| 路径 | 后续实施变更 |
|---|---|
| `apps/server/src/runtime/context/compaction/*` | 新增策略入口、固定估算、历史边界和摘要模块 |
| `apps/server/src/runtime/context/context-manager.ts` | 每 Run 只调用一次策略入口；continuation 只组装请求 |
| `apps/server/src/runtime/context/history-compactor.ts` | 迁移可复用逻辑后移除旧生产入口 |
| `apps/server/src/runtime/context/budget.ts` | 共用阈值数学；解耦 PreparedRequest 与预算报告，移除主发送 fits 门槛 |
| `apps/server/src/runtime/config.ts`、`types.ts` | 预算联合、固定策略规则、候选和 Run 前报告；移除逐请求压缩循环配置，不增加校准字段 |
| `apps/server/src/domain/preset-budget.ts` | 共用 schema、legacy normalizer 和分支 PATCH 规则 |
| `apps/server/src/routes/presets.ts` | 预设读写／导入导出兼容及策略切换替换 |
| `apps/server/src/infrastructure/database/database.ts` | 规范默认预设、准备期 pending 中断恢复；不清理用户配置或历史 |
| `apps/server/src/runtime/model/model-client.ts`、`pi-gateway.ts` | 真实 usage 来源和基准关联、明确硬窗口错误分类、摘要失败不重试；移除主计量强依赖 |
| `apps/server/src/runtime/persistence/usage-store.ts` | 真实用量与下个 Run 基准；准备终态归档、一次结算，不保存校准系数 |
| `apps/server/src/runtime/persistence/run-store.ts` | 保留初始摘要与 user 原子提交；状态／去重支持准备终态 fallback；移除续轮摘要提交 |
| `apps/server/src/runtime/sr-runtime.ts` | 一次准备、候选接受、持久失败与事件；不建立 Run 内压缩检查点 |
| `apps/server/src/runtime/persistence/run-post-processor.ts` | 传递准备终态与安全错误原因，避免先清 pending 再记录失败 |
| `apps/server/src/runtime/runners/agent-runner.ts` | 后续请求纯组装、正常工具循环，不调用预算或压缩 |
| `apps/server/src/runtime/runners/direct-runner.ts` | 消费一次准备结果，保留单次主生成及扩展协议 |
| `apps/server/src/common/error-codes.ts`、公开错误投影 | 增加 PROVIDER_CONTEXT_WINDOW_EXCEEDED，GET／SSE 保持一致 |
| `apps/server/src/routes/session-runtime.ts` | 复用 run.failed 契约，验证准备失败的查询与事件投影 |
| `apps/studio/src/fixtures/presets.ts`、`features/presets/PresetStore.tsx`、`PresetLibraryPage.tsx` | 策略配置、条件字段、本地存储兼容 |
| `apps/web/src/features/presets/PresetPage.tsx` | 现有服务端预设编辑器最小适配 |
| 相关既有测试 | 更换逐请求强预算预期，验证一次准备、软目标及失败持久化 |
| `docs/technical/context-compaction.md`、`runtime-context-v2.md`、配置契约与 `AGENTS.md` | 实现完成后更新现状，此次不提前改写 |

现行 Direct Provider 消息顺序能力、状态提交权限、扩展终止完整性、Run 幂等及锁等规则继续成立。通用估算不能被理解为任意 Provider 都已支持 Direct 协议。

## 12. 实施顺序

### P1：配置和请求契约

- [ ] 实现 budget 判别联合、旧格式规范化和 PATCH 分支规则。
- [ ] 固定主输出配置来源；验证其实际进入每次模型请求。
- [ ] 拆开 Run 前估算报告与 PreparedRequest 身份校验，删除主模型 fits 门槛。
- [ ] 更新默认预设及导入／导出，保留旧值和引用。

完成标准：新旧配置可确定性解析，非法配置明确拒绝，合法但内容超软目标可发送。

### P2：一次准备与固定估算

- [ ] 建立完整历史投影、原子回合、必要内容及纯重建函数。
- [ ] 实现适用 usage + 实际新增粗估；其余全量固定粗估。
- [ ] 覆盖动态 system、缓存输入、非回填输出、历史恢复和策略切换。
- [ ] ContextManager 在准备阶段统一调用一次；Agent continuation 改为纯请求组装。
- [ ] 采用固定规则，不增加自动校准；移除主模型专用计量门槛；usage 记录只服务计费及后续 Run 基准。

完成标准：首次主生成开始后，没有预算估算、检查或压缩调用。

### P3：两种策略

- [ ] 滚动摘要：连续前缀、旧摘要、五轮保留、独立预算、顺序分批及严格结果校验。
- [ ] 保留最多 8 次摘要请求的上限；任一失败立即结束，不自动重试。
- [ ] 摘要后全量估算只作诊断；无收益原投影继续，目标未达不拦截。
- [ ] 滑窗：最大完整连续后缀、必要内容超额仍继续、零摘要调用。
- [ ] 实现策略切换与窗口扩大恢复；无原始历史删除和永久裁剪水位。

完成标准：触发、目标及超目标行为确定，边界无遗漏、无重复。

### P4：保存、失败与真实用量

- [ ] 沿用初次摘要与 user Entry 原子提交，移除续轮候选／检查点。
- [ ] preparationRuns 补齐无 user Entry 的失败、停止、中断终态及查询／去重。
- [ ] 使用现有 run.updated → run.failed 通道，终态和原因先落库。
- [ ] 增加 Provider 硬窗口错误分类，直接正常失败；不自动恢复。
- [ ] 每批摘要真实 usage 只结算一次，失败／停止／零调用和中断均可追踪。

完成标准：摘要失败不进入主生成，既不损坏历史，也不丢失终态与已发生费用。

### P5：界面与现状文档

- [ ] Studio 增加策略选择、滑窗窗口、两者主输出及条件摘要入口。
- [ ] 本地旧草稿兼容、切换字段保留、当前分支严格保存。
- [ ] Web／导入／导出往返不丢配置。
- [ ] 验证必要 UI 状态及错误展示；不扩大为 Studio API 全量接入。
- [ ] 更新正式文档与 AGENTS 中“每次生成前测量”的旧现状说明。

## 13. 验收场景

### 13.1 调度与软目标

- [ ] Direct 和多次 tool continuation 的 Agent 均只调用一次 Run 前入口。
- [ ] `E < T` 和 `E == T` 不触发；`E > T` 触发所选策略。
- [ ] Run 内超出 `T` 仍发送下一主请求；估算器、预算检查器、策略均无 Run 内调用。
- [ ] 整理后仍超 `T`、没有可处理历史、必要内容超额，都不产生本地预算失败。
- [ ] Provider 硬窗口拒绝直接 failed；没有新的摘要、重试请求或工具重放。
- [ ] 用户重试使用新 Run，再检查一次；已失败 Run 的状态和费用不被覆盖。
- [ ] PreparedRequest 不因缺预算报告或 fits=false 拒绝主请求；实际消息被构造外修改、权限或工具协议错误仍被拒绝。

### 13.2 配置与估算

- [ ] 两策略都要求主输出；滑窗另要求显式窗口。未知、混合、零／负／小数／不安全整数配置拒绝。
- [ ] 新旧配置、同策略部分 PATCH、跨策略完整替换、导入导出及旧本地草稿均符合契约。
- [ ] 模型窗口收紧、输出上限、`T > 0` 的配置校验与内容超额放行分别验证。
- [ ] 每次主模型实际 maxTokens 等于 budget.max_output_tokens；摘要另用内部值。
- [ ] 纯追加时复用真实 input + 实际回填／新增粗估；summary usage 和累计 usage 不能作为上下文长度。
- [ ] system／状态／工具／历史／摘要／策略／模型／序列化变化时全量粗估，包含本轮实际新 system。
- [ ] 未回填 thinking／扩展尾块不计入新增；缓存输入只计一次。
- [ ] SDK 默认 usage 与真实报告零值区分；未报告保持未知，不污染估算基准。
- [ ] 中英文、JSON、emoji、工具 schema、请求包装使用确定性固定规则；无自动校准字段或更新路径。
- [ ] 原投影与摘要候选比较收益时使用同一全量固定估算。

### 13.3 滚动摘要与滑窗

- [ ] 摘要覆盖完整连续前缀，保留最近 5 个完整旧回合和必要内容；旧摘要迭代无遗漏／重复。
- [ ] toolCall／toolResults、失败／停止的合法正文及 gaps 不被拆散或错误改写为已完成事实。
- [ ] 长历史顺序分批，单批完整请求符合独立预算；超过 8 次才能覆盖全部范围时失败。
- [ ] 第一个或后续摘要批次 error／empty／length／异常流即失败，不继续下一批，不主生成。
- [ ] 固定摘要输入无法容纳新片段时失败；不递归压缩提示词或上一批摘要。
- [ ] 有效摘要超软目标仍继续；无收益保留原投影，既不提交摘要也不重试，费用照实。
- [ ] 滑窗保留最大完整连续后缀，不跳过邻近大回合；必要内容过大时保留 0 个旧回合继续。
- [ ] 滑窗不创建 summary 请求或 compaction Entry；窗口扩大恢复原始历史。
- [ ] rolling → sliding 忽略但保留摘要；切回时恢复摘要及全部未覆盖历史。

### 13.4 保存、失败、取消和恢复

- [ ] 摘要全部成功后与 user Entry 同事务提交；未提交阶段失败／取消，tip 和原历史不变。
- [ ] 摘要提交后主生成失败／停止，摘要保留，世界状态按原终态规则处理。
- [ ] 无 user Entry 的摘要失败和零模型调用准备失败都有可查询终态、错误原因及一次失败通知。
- [ ] GET Run 与 run.failed 终态／错误一致；准备失败 messages 为空，记录不混入叙事历史。
- [ ] 第 N 批失败时前面请求的真实费用保留，未报告用量仍未知；重复封账不重复累加。
- [ ] 准备期 pending 在重启后归档为中断；不是先清 journal 再丢失原因。
- [ ] 最近 64 个准备终态支持查询／去重；淘汰仅影响明细，累计用量不变，已建 user 的去重范围不缩短。
- [ ] 候选来源不符、tip 冲突、重复接受及提交失败不会重复摘要、误推进边界或发送主生成。

### 13.5 验证范围

后续实现使用临时 SQLite、fake Provider 和离线 SDK transport；不默认调用付费模型。优先更新：

- `apps/server/test/presets.test.ts`
- `apps/server/test/budget-v2.test.ts`
- `apps/server/test/summary-budget.test.ts`
- `apps/server/test/compaction-lifecycle.test.ts`
- `apps/server/test/usage.test.ts`
- `apps/server/test/runtime.test.ts`

按行为补充估算、滑窗、策略切换、一次准备及准备失败查询用例。涉及 UI 时验证两种表单、保存往返、旧草稿和失败展示。文档修订阶段只检查方案一致性、Markdown／JSON／链接及 diff，不运行全套代码或浏览器回归。

## 14. 依据与交付边界

- 本轮用户决定优先：每 Run 前一次触发决策，Run 内无预算管理；超过策略预算继续；摘要失败或 Provider 硬窗口拒绝正常失败，由用户重试。
- 配置与模块决定：context 内策略模式，滚动摘要／滑动窗口，两者配置最大输出，滑窗显式配置上下文上限。
- 继续遵循：估算和计费分开、原始历史保留、权威状态及权限不变、关联边界完整、Runtime 接受候选并负责生命周期。
- 当前实现参考：[上下文压缩](../docs/technical/context-compaction.md)、[Runtime v2](../docs/technical/runtime-context-v2.md)、[Runtime 架构计划](sr-runtime-context-architecture-v2.md)及第 11 节源码。
- 历史背景：[滞后式压缩 v1](sr-context-budget-and-lagged-compaction-v1.md)。其中清理数据、旧容量和仅看上一轮 totalTokens 的规则不作为实施要求。
- 外部参考：[Pi 压缩说明](https://pi.dev/docs/latest/compaction)、[Pi 压缩实现](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)。借鉴阈值判断、连续前缀摘要与 usage 加尾部估算思路；SR 的一次准备、固定保留规则、失败处理和用户配置以本文为准，不继承 Pi 的 Run 内检查或 overflow 自动恢复。前序已对照 1.5.0 发布包，本次也核对官方说明；main/latest 仅用于定位，不作为运行时依赖版本。
- 本文定义未来实施及验收。此次只修订本计划，不执行 P1–P5，不宣称当前运行时代码已具备上述行为。
