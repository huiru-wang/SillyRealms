# SR 上下文压缩策略模块方案 v1

> 日期：2026-11-13
>
> 状态：设计方案，待实施。本次仅新增方案文档并提交推送，不修改运行时代码或数据库。
>
> 基线：`ca50e88`（SRRuntime v2 / current-request budgets）。
>
> 最新决定：取消独立 `CompactionRunner`；在 `apps/server/src/runtime/context/compaction/` 下实现策略模式，首期提供“滚动摘要”和“滑动窗口裁剪”。

## 1. 目标与范围

由 ContextManager 统一准备 Direct 首次生成、Agent 首次生成及每次 continuation 的上下文，委托 context 内部压缩模块按策略处理，再由 Runtime 接受候选、提交必要变更并继续模型调用。

目标：

1. 普通请求优先复用有效模型输入用量，补充新增内容的粗估；无可用基准时本地全量粗估。
2. 滚动摘要保留近期完整回合，把旧摘要与更早连续历史整理为新摘要。
3. 滑动窗口按用户配置的 token 窗口保留预算内尽可能多的连续近期历史，不调用摘要模型。
4. 两种策略都配置主生成最大输出 tokens；摘要请求另有独立内部预算。
5. 原始 entries、权威状态及本轮权限保持不变；策略只改变当前请求的历史投影。
6. 摘要费用逐请求记录，失败或取消不漏账；所有尝试有界。

本方案替代先前讨论的独立 CompactionRunner 设计，也替代现行“所有模型必须有专用 current_request 计量适配”的压缩准入要求。SRRuntime v2 的锁、幂等、状态权限、Direct 扩展协议、错误结构和真实用量记账继续沿用。

本次不引入 Pi AgentSession、Pi JSONL 会话、自动工具重放、策略自动切换、多模态估算或新的压缩服务进程。参考 Pi 的 usage 与尾部粗估思路，摘要继续使用 SR 提示词与共享 ModelClient。

历史计划中的清空会话、删除预设、回退旧路由等操作不属于本方案，不得执行。现行技术文档在实现完成后再更新，不能把本方案描述成已经上线的行为。

## 2. 产品行为与配置

### 2.1 两种策略

| 项目 | 滚动摘要 | 滑动窗口裁剪 |
|---|---|---|
| 持久化标识 | `rolling_summary` | `sliding_window` |
| 历史处理 | 旧摘要 + 更早连续历史合并为新摘要，保留近期完整回合 | 从完整原始净叙事中选择能放下的连续后缀 |
| 窗口配置 | 沿用 compact / standard / extended 三档 | 显式填写 `max_context_tokens` |
| 主生成最大输出 | 必填 `max_output_tokens` | 必填 `max_output_tokens` |
| 摘要模型调用 | 达到阈值时有，独立预算 | 无 |
| 长期上下文记忆 | 由摘要保留，存在信息压缩损失 | 窗口外历史本次不发送，不承诺模型记住 |
| 原始记录 | 保留 | 保留 |
| 压缩持久化 | 成功后保存摘要与覆盖边界 | 只保存本次选择诊断，不建立永久裁剪水位 |

两种策略互斥，首期不提供“先滑窗再摘要”或自动降级。预算无解时明确失败。

### 2.2 预设配置：最小判别联合

预算仍保存在预设 `budget` 中；新增 `strategy` 区分算法。既有 `context_strategy` 只表示滚动摘要的窗口档位，不把它改成算法名称。

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

规范化类型：

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

明确语义：

- `max_context_tokens` 表示输入与输出预留合计的单次上下文窗口上限，不是旧消息条数，也不是累计消耗。
- `max_output_tokens` 是每次主生成/continuation 的输出上限，必须实际传给 ModelClient；它也参与输入预算扣减。它不是整个 Run 的总输出额度。
- 滚动摘要的摘要调用另用内部 `summary.maxOutputTokens`，默认 `min(2048, model.maxTokens)`，不复用主生成上限。首期不新增摘要输出长度的必填 UI 字段。
- 新建预设默认滚动摘要、standard、最大输出 2048，保持当前服务端默认值；示例 4096 不是迁移强制值。
- 切到滑动窗口时，表单给出 32768 的初始窗口值，并保留用户原有主生成输出上限；保存时必须提交明确数值。
- `summary_prompt` 独立于 budget 保留。滑窗不发送它，也不删除它。
- 配置修改只对下一个 Run 生效。运行中的策略、模型、输出额度与权限继续使用冻结快照。

### 2.3 统一预算口径

```text
rolling configuredWindow:
  compact  = 131072
  standard = 262144
  extended = 524288

sliding configuredWindow:
  budget.max_context_tokens

W = min(configuredWindow, model.contextWindow)
O = budget.max_output_tokens
S = 1024
inputAllowance = W - O - S
fits = estimatedInputTokens <= inputAllowance
```

当前用户输入已经包含在估算中，不再额外扣旧方案的 2048“下一轮输入预留”。

所有 token 配置必须是正的安全整数；S 为非负安全整数。O 不得超过模型输出上限；W、模型窗口或剩余输入预算无效时明确拒绝。配置窗口大于模型窗口时按模型窗口收紧，UI 可说明实际受模型能力限制。

对于未绑定模型的预设，保存阶段检查配置结构与自身预算关系；运行时再按实际模型检查输出上限及有效窗口。不静默缩小用户设置的主生成输出上限。

## 3. 与当前代码的关系

当前实现依据：

- `apps/server/src/runtime/context/context-manager.ts`：编排、measure、压缩循环、重建复核集中在 prepareRequest。
- `apps/server/src/runtime/context/history-compactor.ts`：保留五轮、摘要分批和结果校验。
- `apps/server/src/runtime/context/budget.ts`：窗口计算、计量报告、PreparedRequest 一致性。
- `apps/server/src/runtime/config.ts`、`types.ts`：固定为 current_request / summarize_history。
- `apps/server/src/runtime/persistence/usage-store.ts`：逐请求记账与 Run 结算；latestContext 在结算阶段更新。
- `apps/server/src/runtime/persistence/run-store.ts`、`sr-runtime.ts`：初次摘要与 user Entry 同事务，Agent 续轮摘要目前在最终化时提交。
- `apps/server/src/routes/presets.ts`：只接受 context_strategy/max_output_tokens，PATCH 目前浅合并 budget。
- `apps/studio/src/fixtures/presets.ts` 与 `features/presets/PresetStore.tsx`：仍使用 contextStrategy/maxOutputTokens 的本地预设模型。
- `apps/web/src/features/presets/PresetPage.tsx`：现有服务器预设编辑入口。

实现时需要同时迁移配置契约和调用链，不能只移动 history-compactor 文件。现有 Direct 对 Provider system 消息顺序的能力限制仍独立保留；通用估算通过不代表所有 Provider 自动具备 Direct 协议能力。

## 4. 模块设计与职责

### 4.1 目录

在 `apps/server/src/runtime/context/compaction/` 新建以下模块：

| 文件 | 职责 |
|---|---|
| `index.ts` | 统一入口 prepareContext、策略注册与公共流程 |
| `types.ts` | 策略接口、上下文快照、估算基准、返回候选 |
| `estimator.ts` | 有效 usage 基准选择、通用文本粗估、校准 |
| `history.ts` | 完整历史投影、按回合分组、受保护区和覆盖边界校验 |
| `rolling-summary.ts` | 滚动摘要策略：选范围、生成候选和有限调整 |
| `sliding-window.ts` | 滑窗策略：选择连续近期后缀 |
| `summary-generator.ts` | 摘要请求组装、预算内分批、结果校验 |

`context/budget.ts` 继续提供公共预算公式、报告和 PreparedRequest fingerprint，减少 ModelClient 的无关路径变更。旧 `history-compactor.ts` 的能力迁入上述文件后删除旧生产入口，避免双实现。

不新增名为 CompactionRunner 的类、接口或 runtime runner 注册项。DirectRunner 与 AgentRunner 仍只负责各自的生成流程。

### 4.2 职责分配

| 组件 | 负责 |
|---|---|
| Runtime | 锁、配置冻结、取消、候选接受、摘要检查点事务、Run 生命周期 |
| ContextManager | 构建冻结来源与本轮激活结果，调用压缩模块，组装最终 PreparedRequest |
| compaction 模块 | 估算、触发判断、策略执行、重建复核，返回候选投影 |
| 两个策略实现 | 只处理各自的历史变换，不直接执行 SQL 或变更世界状态 |
| ModelClient / UsageStore | 模型调用、请求级真实用量 journal、取消传递及结算 |

压缩模块通过窄依赖调用现有 ModelClient 的摘要能力；不接收完整 Runtime、数据库或任意 ToolExecutor。Runtime 的取消以 AbortSignal 传入，策略必须响应。

ContextManager 在每次主模型调用前走同一入口：Direct 首次；Agent 首次及每次 continuation。不能让两个 runner 各复制一套预算分支。

### 4.3 策略接口与结果

采用静态注册表，新增策略时扩展判别联合、实现、注册和测试，不建立动态插件加载系统。以下为结构示意，复用项目已有 Context / RuntimeError 等类型：

```ts
interface ContextCompactionStrategy {
  readonly kind: PresetBudget["strategy"];
  project(snapshot: ContextSnapshot): ContextProjection;
  reduce(
    input: StrategyInput,
    services: CompactionServices,
  ): Promise<StrategyCandidate>;
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
  budget: BudgetReport;
  baseFingerprint: string;
  change: ContextChange;
};
```

公共入口先调用选中策略的 project，再估算完整候选；符合预算则返回，无需调用 reduce。超限时 reduce、重建、复核，成功才返回可接受结果。

失败或取消走现有 RuntimeError / 公共错误映射，不返回“旧上下文且成功”的降级结果。滑窗的 change 只描述当前请求投影，不得被持久层误当摘要覆盖更新。

### 4.4 输入必须可还原完整历史

ContextSnapshot 至少携带：

- 当前模型/API/序列化方式、冻结策略、主生成参数与 AbortSignal。
- 当前祖先链的完整原始净叙事投影及稳定来源 Entry ID。
- 已有滚动摘要记录和其覆盖边界；不可先用它截掉完整历史来源。
- 已结束的旧回合分组（包括 completed、failed、stopped、interrupted，不遗漏合法保留正文）、当前用户输入、当前 Run 的完整 assistant/tool 往返。
- 已冻结的系统/自定义提示、激活角色、世界书、权威状态与能力规则；tools/toolChoice 纳入请求。
- 当前 source/tip/fingerprint、可用用量基准、共享 Run 级摘要调用额度。
- 保持现有角色与布局的纯重建函数，用于只替换历史区域。

“完整原始净叙事”不是直接回放所有 raw entries：Direct 仍剥离扩展尾块、思考和不应进入叙事的私有内容；Agent 当前 Run 的工具协议消息完整保留。两种策略复用相同的合法投影规则。

重建不重新激活角色、世界书或状态模块，不扩大权限；摘要和裁剪结果都不能改变权威状态。只有 Runtime 接受成功结果后，才更新运行中的有效历史视图。

## 5. 共用占用估算

### 5.1 有效基准

只使用同一主生成上下文的 generation/continuation 请求，不能使用 summary 或其他独立请求。Agent 优先读取当前 Run journal 中最近一次符合条件的记录，不能只依赖结算后更新的 session.latestContext。

基准需关联真实请求 ID、模型/Provider/API、请求内容指纹、覆盖的消息范围及上下文投影。直接复用已有 Runtime 的身份、tip 与 fingerprint 机制，不新建版本管理服务。

复用条件：

1. 收到可信的服务商 usage，数值合法；SDK 初始化的 usage 对象不等于真实报告。
2. 基准覆盖的有效输入按原样保留，当前变化仅是其后的消息追加。
3. 模型、API、模式、序列化、system、tools、状态、已覆盖历史及摘要没有破坏上述关系。
4. 基准不来自失败、取消或无法对齐实际回填内容的响应。

满足时：

```text
estimatedInput
= lastReportedInputTokens
+ estimate(messages actually replayed/appended after that input)
```

Pi 归一化完整输入为 input + cacheRead + cacheWrite；SR 的 inputTokens 已包含这部分，不能再次相加。直接使用 totalTokens 只允许在完整输出确实原样回填且口径已证明相同时作为等价优化，默认不走此捷径。

基准失效时全量粗估当前实际投影，不做复杂的逐节点差额修补。策略切换、历史裁剪/恢复、摘要替换和模型变化都使旧基准失效；合法原始历史仍可用于重新计算。Direct 布局变化较多时允许经常回退全量本地粗估。

### 5.2 通用文本粗估

参考 Pi 的“usage 基准 + 新增内容粗估”，不直接把字符数除以 4 当作中文场景的保守上界。

首版提供统一、确定性的文本估算器，建议初始规则：

- ASCII 字符按 1/3 token 估算。
- CJK 字符按 1 token 估算。
- 其他 Unicode 字符按 UTF-8 字节数估算。
- 每条消息额外预留 16 tokens，请求级额外预留 64 tokens。
- 工具名称、描述及 schema 按实际声明序列化文本使用同一估算函数，每个工具再预留 32 tokens。
- 文本块只统计一次；tools 与中途 system 的声明不能既在消息里算又在 tools 中重复算。
- 统一向上取整，使用安全整数检查；未实现的多模态内容返回明确不支持，不伪装为零。

以上是首版工程启发式，不是模型 tokenizer 的精确上界；估算器携带内部版本，常量集中维护，允许根据离线样本修订。完整输入包含本轮实际发送的系统、自定义提示、摘要、历史、当前输入、工具及其结果。

校准按“同一次请求的原始输入估算”与“真实输入 usage”比较，不能拿 totalTokens 校准。按模型/Provider/API/估算器版本隔离；首版只上调低估系数，初始为 1，使用正常报告形成的有界系数（1–4），异常值不更新，保留诊断。不要修改原始 usage。

已有 DeepSeek BPE 适配可保留为可选验证能力，不能再成为其他文本模型的生成门槛。未做专用 tokenizer 适配的普通文本模型走 estimated 路径。

### 5.3 报告、冻结与服务商拒绝

报告至少区分 usage_plus_estimate / full_estimate，记录输入估算、有效窗口、输出预留、安全余量、估算器版本及基准失效原因。真实计费字段继续由 UsageStore 保存，不用估算填充。

保留 PreparedRequest 的冻结及发送一致性检查。检查后不得再追加消息、工具结果或动态 system；有变更则重新准备。

估算通过不保证 Provider 永不超窗。首版识别已知的 Provider 超窗错误，映射为明确的上下文预算失败；不自动重放工具、不隐式切换策略、不引入无限重试。服务商拒绝前已经产生的有效用量仍记录。

## 6. 滚动摘要策略

### 6.1 初始投影与压缩范围

1. 校验已有滚动摘要的 kind、来源链和覆盖边界；使用有效摘要 + 覆盖边界之后的原始净叙事。
2. 当前用户输入、固定提示、权威状态、权限、工具定义和当前整个 Agent 回合受保护。
3. 固定保留最近 5 个已结束的旧用户回合；“已结束”包括失败、停止和中断，不等于生成成功；“回合”从 user 开始，直到下一个 user 前，包含其中实际参与投影的关联消息。
4. 将旧摘要与更早的连续历史作为输入。新摘要覆盖范围只向历史尾部推进，不能跳过中间片段。
5. 没有可压缩旧历史，或仅受保护部分就超预算时，明确失败；首期不擅自缩短保留回合、不仅为通过检查而删掉旧摘要。

旧历史来自固定来源；摘要依旧排除玩家指令作为故事事实，保留失败/停止/状态未同步的缺口语义，沿用既有有界 gaps 标记。不让摘要替代权威状态。

### 6.2 独立摘要预算

继续使用当前配置的主模型执行摘要，首期不新增摘要模型选择器。摘要调用不注册业务工具。

```text
summaryOutput = min(2048, model.maxTokens)
summaryInputLimit = min(
  floor(W * 0.75),
  W - summaryOutput - S
)
```

摘要输入预算涵盖平台摘要约束、preset.summary_prompt、旧摘要、缺口标记、来源包装和本批正文。它独立于主生成的 max_output_tokens。

超长历史采用预算内的顺序分批：上一批摘要作为下一批旧摘要，直到所有选中的连续范围都得到处理。可以按 Unicode codepoint 切分超长纯文本供内部摘要使用，记录片段来源与偏移；只能在全部目标范围处理成功后提交完整覆盖边界。对外保留的模型消息组不得被拆散。

复用现有 12000 字符的辅助单批资源上限，但不能把它当作 token 换算。固定摘要指令和旧摘要已占满预算、无法容纳任何新片段时立即失败，不递归调用压缩模块。

摘要结果必须满足：未取消、正常 stop、非空、没有工具调用、流与最终结果一致。length、error、aborted、重复终态等继续按现行严格语义拒绝。

### 6.3 重建与有限调整

完整重建请求后，旧 usage 基准失效，使用当前投影重新估算。只有占用下降且满足输入预算，才形成 SummaryCandidate。

首版沿用：

- 每次主请求准备最多 2 次压缩变换；
- 每个 Run 最多 8 次真实摘要请求，分批和后续 continuation 共用额度；
- 第二次只允许对第一次临时候选作一次更短摘要，或重新处理原计划允许的连续范围；不能裁掉受保护内容。两次都成功前不得提交中间候选；
- 新摘要没有缩短、不满足预算、固定内容无解或达到次数上限时明确失败，保留原有效视图。

不新增运行时循环组件：上述限制属于 context/compaction 公共流程和滚动策略内部。策略内部临时修改不得写回 ExecutionContext；Runtime 接受最终结果后再更新。

SummaryCandidate 至少包括摘要正文、coveredThroughEntryId、firstKeptEntryId、来源 fingerprint、受控 gaps，以及摘要请求 ID 关联信息。覆盖边界与保留边界按参与投影的消息组校验，无遗漏、无重叠；不要求它们在原始 SQL seq 上相邻。

## 7. 滑动窗口裁剪策略

### 7.1 输入与算法

滑窗从当前祖先链的完整原始净叙事开始，忽略已有滚动摘要及其覆盖水位。不能先读取“摘要之后的历史”再执行滑窗。

处理顺序：

1. 组装并估算受保护内容：固定提示、当前状态/权限、tools/toolChoice、当前输入及当前完整 Agent 往返。
2. 如果受保护内容本身超过 inputAllowance，直接返回上下文预算失败。
3. 对已结束的旧历史（含失败/停止留下的合法正文）按完整回合分组，从最新组向前尝试加入。
4. 使用同一冻结估算规则，选择预算内最大的连续后缀；遇到无法加入的相邻组停止，不越过大组去挑更早小组。
5. 按原角色和原顺序重建完整 Context，重新估算并验证边界。
6. 若复核仍超预算，只能从当前后缀的最旧完整组继续移除；不会添加摘要、截断当前输入或拆工具消息组。

裁剪策略的可用预算包含所有提示及当前输入，不是把 max_context_tokens 全部分给历史。

滑窗不继承滚动摘要的“必须保留 5 个旧回合”。旧回合可以保留 0 个，只要当前受保护请求仍合法；产品诊断说明历史省略，不能声称保留了长期记忆。如果最新旧回合单独也放不下，不退而选择更早回合。

工具关联以 assistant toolCalls 与对应的全部 toolResults 为原子组；当前 Run 整个进行中回合始终受保护，不以尚未完成的工具结果作裁剪点。

### 7.2 有界与轻量

滑窗不调用任何摘要模型，summary 请求数和新增摘要 usage 必须为 0。它仍有主生成模型的正常费用。

每个旧回合在一次准备中最多加入一次、移除一次，选择过程总次数为 O(n)；缓存本次消息粗估，避免反复序列化同一段大历史。最终按同一可加性估算口径复核；若使用无法证明可加性的特殊适配，采用有限的完整请求复核，不能凭单调性假设跳过验证。

记录本次 firstKeptEntryId、omittedTurnCount、估算前后值即可。不能写入 rolling summary 的 coveredThroughEntryId，不创建假的摘要 Entry，不把窗口起点保存为下次不可跨越的永久边界。

### 7.3 窗口调整

每次请求按当前配置和完整来源重新投影。增大窗口后，过去暂时省略的原始历史可以重新进入上下文；减小窗口则选择更短后缀。上一次保留起点仅是诊断或优化线索，不是数据删除标记。

复用上次选择必须证明仍得到本次策略要求的后缀；无法证明时从原始来源重新选择。不要为追求 usage 快速路径锁死历史窗口。

## 8. 策略切换与旧摘要

| 场景 | 处理规则 |
|---|---|
| 滚动摘要 → 滑窗 | 下一个 Run 从原始净叙事选后缀，不注入旧摘要；保留数据库中的摘要记录 |
| 滑窗 → 滚动摘要 | 重新校验最近有效滚动摘要；有效则使用它及其覆盖之后的全部原始历史 |
| 滑窗期间积累了大量历史 | 切回滚动时仍需处理全部未覆盖范围；受摘要预算和调用上限约束，不能跳过被滑窗省略的中间历史 |
| 没有有效摘要或摘要因合法历史变更失效 | 从完整合法原始历史重新准备；新摘要仅在成功提交后生效 |
| 祖先链或边界损坏，无法还原合法历史 | 明确报边界/历史错误，不猜测、不跳过记录 |
| 修改窗口、输出参数或切换模型 | 下一个 Run 重新计算有效预算；实际投影变化时旧 usage 基准失效 |

摘要内容的有效性与 usage 基准有效性分别判断。换了策略或模型通常使 usage 基准失效，不等于必须删除仍正确的故事摘要。

旧 `kind: sillyrealms.summary` 且无 strategy 标志的记录按滚动摘要解释，沿用既有祖先链/覆盖校验；不信任缺失关联信息的旧 usage 作为新估算基准。新增摘要补齐来源和保留边界元数据。

切回滚动时永远不能把“最后一次滑窗起点”解释成“此前内容已经摘要”。

## 9. Runtime 提交、取消与实际用量

### 9.1 从准备到继续生成

1. Runtime 获取现有 session/world 占用，冻结配置、来源、状态与权限。
2. ContextManager 构建快照并调用 compaction.prepareContext。
3. 得到 ready 结果后，Runtime 再检查取消、来源 fingerprint 和 tip。
4. 若有滚动摘要更新，Runtime 原子提交摘要及边界；无更新或仅滑窗不写摘要记录。
5. 接受新的有效上下文，生成/检查不可变 PreparedRequest，开始下一次模型调用。
6. 每次模型调用将实际 usage 和请求基准送回共享 journal，供下一次准备选择或校准。

主模型调用入口应经 Runtime 统一协调接受候选，不让 AgentRunner 直接写 compaction 记录。可提供窄的 prepareNextRequest 回调给 AgentRunner，内部委托 ContextManager，再完成检查点提交；不把整个 Runtime 注入 runner。

### 9.2 提交时机

采用“合格摘要先提交，再继续生成”的统一语义：

- 初次准备：继续与本轮 user Entry 在 startRun 同一事务提交。
- Agent continuation：增加 Runtime 管理的摘要检查点事务，在下一次模型请求前提交；随后更新 execution.progress.latestEntryId 和有效历史视图。
- finalize 不再重复提交已经接受的摘要；删除旧 pendingSummary 延迟提交分支，或明确其只保存尚未接受候选且不会跨请求使用，不能双写。
- 摘要覆盖范围必须早于当前 user Entry；当前 Run 的工具往返不在覆盖范围。
- checkpoint 不写世界状态。状态仍按现有 Direct/Agent 生命周期提交，不能借摘要检查点提前提交 workspace。

检查点需校验来源链、tip、边界、摘要内容及取消状态；取消的最后检查到同步事务提交之间不 await。检查点使用稳定候选/操作标识进行幂等处理，重复接受不得新增两份摘要或重复关联用量。

这是对当前“Agent 续轮摘要在 finalize 才提交”的明确行为变更，必须更新相应生命周期测试。

### 9.3 取消与失败矩阵

| 情况 | 摘要/窗口状态 | 用量 |
|---|---|---|
| 摘要请求失败、空结果、截断、取消 | 不接受候选，保留原有效历史 | 已返回实际 usage 仍记录 |
| 重建复核失败或尝试耗尽 | 不提交任何中间候选 | 所有已发生摘要请求照常结算 |
| 提交前取消或 tip 不符 | 不提交候选 | 不回滚已发生的用量 |
| 摘要提交后主生成失败/停止 | 保留已提交摘要，不回滚检查点 | 主生成及摘要分别按真实结果结算 |
| 滑窗后主生成失败/停止 | 无永久裁剪；原始历史仍完整 | 不产生摘要用量 |
| 崩溃或缺少服务商 usage | 依现有中断恢复规则处理 | 未知保持未知，不伪造成零 |

### 9.4 用量与报告

每一次实际摘要 attempt 通过 ModelClient + RunAccounting.request("summary") 记录，包含分批、重试及最终失败的请求。返回结果中的 usage 只供展示/关联，不能再累计一次。

没有 user Entry 的准备期消耗继续进入 unattachedTotals。UsageStore 对“服务商已报告”与“SDK 默认对象”的判断需要补齐来源证据；真实报告的零值可按事实保存，但无法成立的零占用不能当估算基准。

滑窗诊断与预算报告写入现有有界 ext_data.runtime 诊断集合，最多保留既定 32 份报告；不存完整 prompt，不修改公开消息正文。真实 usage 面板继续表示实际调用，另需显示估算时明确标识为估算。

## 10. 配置迁移、API 与前端

### 10.1 服务端规范化

新增一个共用预算 schema/normalizer，建议位置 `apps/server/src/domain/preset-budget.ts`。路由、数据库默认预设、Runtime 配置解析及导入导出复用它，避免各自猜测策略。

- 识别当前合法旧格式：只有 context_strategy + max_output_tokens 时归一化为 rolling_summary，原值保留。
- 规范化输出、导出及新写入都包含 strategy。
- sliding_window 必须携带 max_context_tokens 和 max_output_tokens。
- 新格式按分支 strict 校验；滚动分支不允许 max_context_tokens，滑窗分支不允许 context_strategy。
- 未知 strategy、混合两种分支字段、缺少必填项或不合法数值拒绝。
- 无 strategy 但只有旧数值 max_context_tokens 的更早历史格式不自动猜为滑窗；它不属于本次认可的当前旧格式。
- 不删除旧预设，不重绑 session/world 引用；现存 config_json 可读取时规范化，并在正常保存时写入新格式。默认 seed 更新为规范格式。

### 10.2 PATCH 与运行快照

当前 PATCH 的 `budget: { ...current.budget, ...budget }` 不能直接用于策略切换。

规则：

1. 不切换策略时允许同分支合法字段的局部更新，合并后完整校验。
2. 切换 strategy 时必须提交目标分支完整 budget（含 max_output_tokens），原子替换预算对象。
3. 新分支不携带旧分支字段；任何显式冲突都拒绝，不按优先级猜测。
4. summary_prompt 与节点配置保留；切换预算策略不修改其他预设能力。
5. 已开始 Run 的冻结配置不变；后续 Run 使用新策略。

保留现有 HTTP/SSE 的 errorCode/errorMessage 结构；不新增 detail 字段，不改变无关接口结构。

### 10.3 配置界面

产品界面优先落实 Studio 的预设“上下文”区域：

- 增加“历史处理方式”：滚动摘要 / 滑动窗口裁剪。
- 两者始终显示“最大输出长度（tokens）”。
- 滚动摘要显示原三档窗口和“摘要提示词”入口。
- 滑窗显示“上下文上限（tokens）”，隐藏不生效的摘要编辑入口；摘要配置保留，切回时恢复。
- 给出简短说明：滑窗仅发送最近能放下的完整历史，不生成摘要；不向用户暴露估算器、journal 或内部尝试次数。
- 切换时保留当前最大输出值；窗口数值初始 32768，之后由用户明确保存。
- 本地草稿可暂存两个分支输入，提交/导出时只发送选中分支，不把草稿残留字段混入 budget。

Studio 当前预设仍是 fixture + 本地 store。更新其类型、校验、序列化及本地持久化兼容；本方案不自动扩展为完整 Studio 预设 API 接入。未来映射到服务端时使用同一个 budget 契约。

Web 现有预设页也要最小适配新 budget，避免打开新预设后丢字段或保存失败；不在本次实施中重做 Web 视觉风格。现有导入/导出必须往返保留 strategy、数值窗口及输出上限。

## 11. 实施文件清单

以下是后续实现范围，本次仅保存本计划。

| 路径 | 预期变更 |
|---|---|
| `apps/server/src/runtime/context/compaction/*` | 新增公共入口、策略、历史边界、估算与摘要生成模块 |
| `apps/server/src/runtime/context/context-manager.ts` | 保留编排与冻结来源；改为委托策略模块，返回待 Runtime 接受的结果 |
| `apps/server/src/runtime/context/history-compactor.ts` | 迁移可复用能力后移除旧生产入口 |
| `apps/server/src/runtime/context/budget.ts` | 共用窗口/预留公式；合法 estimated 可准入，保留 fingerprint 一致性 |
| `apps/server/src/runtime/config.ts`、`types.ts` | 判别联合配置、统一内部策略、冻结输入、候选结构 |
| `apps/server/src/domain/preset-budget.ts` | 共用规范化、验证与 PATCH 分支规则 |
| `apps/server/src/routes/presets.ts` | 创建/读取/导入/导出兼容及策略切换原子替换 |
| `apps/server/src/infrastructure/database/database.ts` | 默认预设写规范 budget；不清理用户配置或历史 |
| `apps/server/src/runtime/model/model-client.ts`、`pi-gateway.ts` | 关联真实请求基准/usage 来源，保留实际发送校验，移除专用计量强依赖 |
| `apps/server/src/runtime/persistence/usage-store.ts` | 当前 Run 基准选择所需数据、真实报告与默认对象区分、校准资料 |
| `apps/server/src/runtime/persistence/run-store.ts` | 增加幂等摘要检查点事务及来源/边界校验，保留既有 Entry 类型 |
| `apps/server/src/runtime/sr-runtime.ts` | 接受候选、初次/续轮提交、取消检查与有效视图更新 |
| `apps/server/src/runtime/runners/agent-runner.ts` | 通过窄回调获取下一次已接受的 PreparedRequest；不直接提交摘要 |
| `apps/server/src/runtime/runners/direct-runner.ts` | 消费共同准备入口的结果，保持单次主生成 |
| `apps/studio/src/fixtures/presets.ts`、`features/presets/PresetStore.tsx`、`PresetLibraryPage.tsx` | 策略配置、字段校验、本地兼容及条件界面 |
| `apps/web/src/features/presets/PresetPage.tsx` | 已有接口消费者的最小配置适配 |
| `apps/server/test/*`、相关前端现有测试 | 更新预算/生命周期预期，覆盖新策略及切换 |
| `docs/technical/context-compaction.md`、`runtime-context-v2.md`、相关公开配置契约及 `AGENTS.md` | 实现完成后更新现状；此次不提前改写 |

不新增独立 compaction 表或第二套 session schema。摘要仍用现有 compaction Entry，诊断仍用现有运行元数据。扩展 JSON 字段时旧记录能读取，缺少基准关联时回退估算；任何必要数据库变更只允许非破坏性增量迁移。

## 12. 分步执行顺序

### P1：配置契约与内部策略类型

- [ ] 增加 budget 判别联合、legacy normalizer、边界校验和分支 PATCH 规则。
- [ ] 更新 RuntimeConfig 解析与冻结；主生成输出参数只有一个配置来源。
- [ ] 更新默认预设和导入导出；旧预设、引用和 summary_prompt 原值保留。
- [ ] 配置测试证明同策略局部更新、跨策略完整替换及冲突拒绝。

完成标准：新旧配置能确定性解析，非法配置在调用模型前失败。

### P2：共用快照、估算与预算入口

- [ ] 定义完整净叙事来源、原子回合与受保护消息组，保留纯重建函数。
- [ ] 实现有效输入 usage 基准、当前 Run 记录优先及全量粗估回退。
- [ ] 处理中文、包装、工具 schema、缓存计数和校准来源。
- [ ] 调整专用 measure 阻断，保留 PreparedRequest 与最终发送一致性。
- [ ] 修正 SDK 默认 usage 被误认 reported 的路径。

完成标准：普通文本模型无需专用 tokenizer 也能获得 estimated 预算；权限和发送协议检查没有被绕过。

### P3：两种策略

- [ ] 注册 rolling_summary / sliding_window，不新增 Runner。
- [ ] 迁移滚动摘要的提示、分批、五轮保留、结果校验及共享调用额度。
- [ ] 实现滑窗的最大连续后缀、受保护区无解判断及零摘要调用。
- [ ] 实现策略切换、窗口扩大、摘要恢复与全部未覆盖历史衔接。
- [ ] 重建后统一复核，失败不写回候选视图。

完成标准：两种策略独立工作，均不删除原始记录，不隐式互相回退。

### P4：Runtime 生命周期与用量

- [ ] 初次摘要与 user Entry 原子提交。
- [ ] Agent 续轮新增 Runtime 检查点，提交后再继续，更新 tip 与有效视图。
- [ ] 消除 finalize 对已提交摘要的二次提交。
- [ ] 验证提交前/后的停止、后续主生成失败、幂等重入与中断恢复。
- [ ] 逐摘要请求记账，失败/取消/无 user Entry 不漏账、不重复。

完成标准：候选接受、持久化和模型继续调用有清晰顺序，工具与状态执行次数保持原有语义。

### P5：配置界面与文档收尾

- [ ] Studio 增加策略选择、滑窗上限、两策略最大输出和条件摘要入口。
- [ ] Studio 本地存储读取旧格式，切换草稿保留用户输入，保存只含当前分支。
- [ ] Web 最小适配，导入/导出/编辑往返不丢字段。
- [ ] 更新技术文档、配置契约和 AGENTS 的现行压缩说明。
- [ ] 完成相关离线验证，明确真实 Provider 与浏览器验证范围。

## 13. 验收场景

### 13.1 配置与输出

- [ ] 旧 budget 读为 rolling_summary，窗口档位、输出和摘要提示不变；原始记录不删除。
- [ ] 两种策略都拒绝零、负数、小数、不安全整数及缺少的输出配置。
- [ ] sliding 缺少 max_context_tokens、未知 strategy 或混合字段明确拒绝。
- [ ] 同策略 PATCH 可只改输出；切换策略必须完整替换，旧字段不残留。
- [ ] 模型窗口小于配置窗口时正确收紧；O 超模型上限或剩余输入 <= 0 时失败。
- [ ] Direct generation、Agent generation/continuation 实际请求的 maxTokens 等于所选 budget.max_output_tokens。
- [ ] 滚动摘要使用独立输出预算，修改主输出不会意外改成摘要输出；滑窗不会创建 summary 请求。

### 13.2 估算与真实用量

- [ ] 只选 generation/continuation 基准；summary usage、错误/取消响应和默认全零对象不能成为有效占用基准。
- [ ] 当前 Run 最新有效请求优先于 session.latestContext。
- [ ] 仅追加消息时使用真实输入加实际回填/新增粗估，不再重复累计旧请求 input。
- [ ] system/状态/tools/旧历史/摘要/策略/模型或序列化变化导致失效重估。
- [ ] Direct 不回填的思考和扩展尾块不被无条件当作下一轮历史。
- [ ] 缓存输入仅计一次；context 输入估算不混入 session 累计消耗。
- [ ] 中英文、JSON、长数字、emoji、工具 schema 和包装都有确定性样本。
- [ ] 校准比较同请求输入口径，按模型隔离；未知/异常 usage 不污染系数。
- [ ] 估算后请求被修改会拒绝发送；Provider 超窗错误明确失败而不重放工具。

### 13.3 滚动摘要

- [ ] 超阈值且有旧历史时，保留 5 个已结束旧回合及当前整个回合。
- [ ] 旧摘要与后续未覆盖历史连续合并，不遗漏、不重复。
- [ ] toolCalls 与其全部 toolResults 不被拆组；停止/失败的旧回合保留缺口语义。
- [ ] 单批/多批/超长单消息输入均受独立预算和总调用上限约束。
- [ ] 固定摘要输入已满、正常摘要无缩短、空结果、length、error、取消均明确失败。
- [ ] 第一批成功、后续批失败或复核失败：不提交局部覆盖，真实调用费用仍记录。
- [ ] 每准备最多 2 次变换、每 Run 最多 8 次摘要请求，Agent 续轮不重置总额度。
- [ ] 当前受保护内容自身超预算时，不发起无意义摘要调用。

### 13.4 滑动窗口

- [ ] 未超预算时保留所有合法原始净叙事，不调用摘要。
- [ ] 超预算时只保留最大连续后缀，不抽样、不跳过大回合挑选更早的小回合。
- [ ] 不拆完整回合及工具关联；当前用户/工具往返/system/权限不能被裁掉。
- [ ] 最新旧回合无法容纳时允许保留 0 个旧回合；若受保护内容也放不下则失败。
- [ ] 滑窗不注入旧摘要、不创建 compaction Entry、不推进摘要水位。
- [ ] 增大窗口后可重新包含先前省略的原始历史。
- [ ] 每次准备选择有界，重建复核失败不会继续发送 generation/continuation。

### 13.5 切换、提交与恢复

- [ ] rolling → sliding 忽略但保留旧摘要；sliding → rolling 恢复有效摘要及全部未覆盖范围。
- [ ] 滑窗期间被省略的历史切回后没有永久漏掉；不能把窗口起点误作摘要覆盖边界。
- [ ] 无效来源/损坏边界不被使用；完整合法历史可重新投影，无法还原时明确失败。
- [ ] 提交前取消无新摘要；提交后取消保留检查点；世界状态仍遵循现有模式的终态规则。
- [ ] Agent continuation 提交发生在下一模型请求前，finalize 不重复写入。
- [ ] tip 冲突、重复接受候选、进程中断不会重复提交、重复记账或重放工具。
- [ ] 准备期无 user Entry 的摘要费用计入 unattachedTotals；缺失 usage 标记未知。
- [ ] 策略切换/预算调整仅影响后续 Run；本轮冻结的权限、模型与状态基准不变。

### 13.6 验证执行范围

后续实施使用临时 SQLite、fake Provider 和离线 SDK transport 验证，不为验收默认调用付费模型。

优先复用并更新：

- `apps/server/test/presets.test.ts`
- `apps/server/test/budget-v2.test.ts`
- `apps/server/test/summary-budget.test.ts`
- `apps/server/test/compaction-lifecycle.test.ts`
- `apps/server/test/usage.test.ts`
- `apps/server/test/runtime.test.ts`

新增覆盖新行为的 estimator、sliding-window、strategy-switch 与 checkpoint 用例，避免仅镜像实现的测试。涉及 UI 的阶段再检查两策略表单、移动端、旧草稿和保存往返。完成相关验证后停止，不为文档本身运行整套模型或浏览器回归。

## 14. 决策依据与交付边界

- 用户最新要求：context 内策略模块，不建立 CompactionRunner；支持滚动摘要和带数值上下文上限的滑窗，两者配置最大输出。
- 前序确认原则：估算与计费分开、原始记录保留、状态权限冻结、边界完整、候选由 Runtime 提交、失败可恢复。
- 当前实现：[上下文压缩](../docs/technical/context-compaction.md)、[Runtime v2](../docs/technical/runtime-context-v2.md)。
- 当前架构基线：[Runtime 架构 v2](sr-runtime-context-architecture-v2.md)。本计划只覆盖其上下文策略与相关生命周期调整，其他约束继续适用。
- 历史背景：[滞后式压缩 v1](sr-context-budget-and-lagged-compaction-v1.md)。其中旧容量、清理数据和纯上一轮阈值规则不作为本计划实施要求。
- 外部参考：[Pi 压缩说明](https://pi.dev/docs/latest/compaction)、[Pi 压缩实现](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)、[DeepSeek token 说明](https://api-docs.deepseek.com/quick_start/token_usage/)。Pi 细节已对照 1.5.0 发布包；外部 main/latest 仅供定位，不构成运行时版本锁定。
- 本文定义未来实现和验收。本次文档提交不执行上述 P1–P5，不修改 API、数据或当前生成行为。
