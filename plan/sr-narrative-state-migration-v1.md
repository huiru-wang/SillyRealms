# 叙事与状态迁移首版方案

- 日期：2026-11-17（Asia/Shanghai）
- 状态：待实施；本文件描述实施批次，不表示代码或测试已完成。
- 核对基线：commit 1cd4f62；state schema v2；数据库 user_version 7。
- 整体目标：[SR Server 整体架构与渐进迁移方案](./sr-server-architecture.md)。
- 本期产出：一条职责清楚、可以继续扩展的 Direct 叙事链路，以及完整独立的 State 业务服务。

## 1. 先明确本期产品结果

用户发送行动后，可以持续看到正文。正文正常生成并保存，主 Run 即完成，输入恢复可用；状态和行动建议各自完成自己的工作。状态错误、建议错误以及扩展标签错误，不把已经成功的故事改成失败。

本期保留现有历史、分支、上下文压缩、自动建议、取消、用量统计及主 Run 中断恢复。新一轮可以在上一轮后置尚未结束时开始；不保证它一定读到上一轮尚未保存的状态。

本期不增加 Agent、AI 单次帮答、无用户发言续写的新入口、生图、TTS、漫画和视觉小说；不增加通用任务队列、冻结、状态锁、版本协调或后置跨进程续跑。未来能力依照整体方案接入，不提前建立空模块。

### 简要结论

1. 用 NarrativeService 编排现有叙事，用 TaskRuntime 管理主任务，用 Sessions 管理正文与历史，用 StateService 管理状态。
2. EventHub 独立于 Run，SSE 直接订阅会话事件。
3. Direct 自己拥有输出切分与后置处理；未来 Agent 直接使用业务工具。
4. 主结果保存与任务终态脱离状态保存；状态和建议独立启动、独立处理失败。
5. 状态输出切成 JSONL，扩展按块恢复，坏一项只影响一项，坏一个块只影响该块。
6. 分批替换真实调用链，必要的 SDK/Studio 契约同步切换；保留现有数据库与历史数据。

## 2. 首版模块与职责

| 模块 | 本期负责 | 不承担 |
|---|---|---|
| api | 叙事请求、取消、查询、State HTTP、会话 SSE | 模型上下文编译、SQL 细节、后置编排 |
| scenarios/narrative | 叙事输入、Context、Direct Runner、结果保存的编排、历史 Run 视图 | 通用状态业务规则、所有未来场景 |
| domain/sessions | 会话、消息、历史、分支、摘要及必要的消息附属结果 | 通用任务执行、Direct 标签解析 |
| domain/state | 定义与初始化、状态读取、授权范围、逐项应用、最终快照校验与保存 | Run 终态、正文生成、建议处理 |
| engine/tasks | 任务身份、执行生命周期、取消和主任务终态 | 世界材料读取、正文格式、状态提交 |
| engine/events | 进程内事件发布和订阅 | 每轮专属 SSE 生命周期、持久消息队列 |
| engine/inference | 文字调用接口与流事件 | 世界书、预设节点编排 |
| engine/usage | 用量记录和统计 | 更改任务终态 |
| infrastructure | SQLite、Provider、凭据和现有文件能力 | 产品场景编排 |
| bootstrap | 实例装配、接口实现注入和启动恢复接线 | 主流程业务规则 |

domain 与 engine 是并列能力。领域服务不直接 import engine；业务变更返回给调用方，或通过所属模块定义的事件接口发布，由装配层接入事件服务。

TaskRuntime/TaskRepository 管理一次执行的 Run，不额外建立第二套 Task 生命周期。通用任务只保存任务身份、类型、关联对象和执行状态。sessionId、assistantMessageId 等在叙事场景中必需，不强制成为所有未来媒体任务的必填字段。对外已有 Run.messages 历史视图由叙事查询组合 Sessions 与任务记录生成，不反向决定通用引擎结构。

### 2.1 首版目标目录

下列是本期迁移后的核心目录。未列出的世界、模型配置、预设管理等现有功能继续保留原位置，后续按所属能力迁移；本期不要求一次改完所有 CRUD 或移动整个 Server。

~~~text
apps/server/src/
  app.ts
  server.ts
  bootstrap/
    services.ts
    runtime-config.ts
    recovery.ts

  api/
    routes/
      sessions.ts
      narrative.ts
      state.ts
    events/
      session-events.ts

  scenarios/
    narrative/
      service.ts
      contracts.ts
      events.ts
      queries/
        history-runs.ts
        run-result.ts
      context/
        builder.ts
        materials.ts
        activation.ts
        node-compiler.ts
        budget.ts
        snapshot.ts
        contracts.ts
        compaction/
          index.ts
          history.ts
          rolling-summary.ts
          sliding-window.ts
          summary-generator.ts
          estimator.ts
          types.ts
      direct/
        runner.ts
        story-writer.ts
        postprocess/
          dispatch.ts
          frame-parser.ts
          state-jsonl.ts
          state-update.ts
          action-suggestions.ts
          stream-splitter.ts
          contracts.ts

  domain/
    sessions/
      service.ts
      repository.ts
      types.ts
      history-page.ts
      ancestors.ts
    state/
      service.ts
      repository.ts
      types.ts
      ...                         # 保留现有 v2 定义、规则和校验能力

  engine/
    tasks/
      task-runtime.ts
      repository.ts
      types.ts
    events/
      event-hub.ts
    inference/
      text.ts
    usage/
      service.ts
      repository.ts

  infrastructure/
    persistence/
      sqlite/
        session-repository.ts
        state-repository.ts
        task-repository.ts
        usage-repository.ts
    providers/
      pi-gateway.ts
    database/                     # 本期保留数据库初始化、v7 与现有工具
    credentials/
    world-files/

  routes/                         # 未涉及的其他管理路由暂留
  ...                             # 其余既有能力，不在本期强制重排
~~~

没有 domain/story、domain/actions；没有通用 CompactionRunner；没有预建的 Agent、Image、Speech Runner。跨场景 Context 抽取要等第二个真实使用者出现。

### 2.2 当前代码的迁移落点

| 当前位置（相对仓库根目录） | 迁移落点与处理 |
|---|---|
| apps/server/src/runtime/sr-runtime.ts | 拆到 NarrativeService、TaskRuntime、EventHub；最后删除总 Runtime |
| apps/server/src/runtime/runners/direct-runner.ts | narrative/direct/runner.ts，仅负责 Direct 执行与输出 |
| apps/server/src/runtime/runners/story-writer.ts | narrative/direct/story-writer.ts，处理正文流；名称不代表 Story 领域 |
| apps/server/src/runtime/context/ | narrative/context/，先保留算法，再整理入口 |
| apps/server/src/runtime/postprocess/ | narrative/direct/postprocess/，重做按块及按行失败边界 |
| apps/server/src/runtime/persistence/run-store.ts | 拆为 Sessions、State、Task 仓储，不把旧 finalize 原样搬过去 |
| apps/server/src/runtime/persistence/usage-store.ts | UsageRepository 仅记量；settleRun 的 preparation 终态写入交给 TaskRepository |
| apps/server/src/runtime/persistence/run-post-processor.ts | 当前只是用量结算薄封装；删除或并入用量服务，不作为新后置管理器 |
| apps/server/src/runtime/model/model-client.ts | engine/inference 的调用接口及通用实现 |
| apps/server/src/runtime/model/pi-gateway.ts | infrastructure/providers |
| apps/server/src/runtime/config.ts、types.ts、shared/errors.ts | 按配置、任务、叙事与通用错误归属拆分，不保留万能 types |
| apps/server/src/domain/session/ | 会话规则进入 domain/sessions；当前及历史 Run 投影视图进入 narrative/queries |
| apps/server/src/routes/session-runtime.ts | api/routes/narrative.ts 与 api/events/session-events.ts |
| apps/server/src/routes/sessions.ts | api/routes/sessions.ts，调用 Sessions |
| apps/server/src/routes/state-updates.ts | api/routes/state.ts，调用完整 StateService |
| apps/server/src/infrastructure/database/database.ts | 保留初始化与 v7；中断恢复改接 Task 服务，去掉通过 UsageStore 修改终态的路径 |

表内目标的 narrative、engine 等均指 apps/server/src 下相应目录。只是搬目录而保留混合职责，不算完成迁移。

## 3. 目标执行关系

~~~mermaid
flowchart TB
    R["叙事请求"] --> N["NarrativeService：Context + Direct"]
    N --> B["保存正文：Sessions"]
    B --> T["完成主任务：TaskRuntime"]
    T --> E["发布主结果并释放主任务占用"]
    E --> S["Direct 状态处理"]
    E --> A["Direct 建议处理"]
    S --> SS["StateService：校验、应用、保存"]
    A --> AE["发布建议事件"]
    SS --> SE["发布状态结果"]
    E -.-> H["独立 EventHub / 会话 SSE"]
    AE -.-> H
    SE -.-> H
~~~

图中的两条后置分支不互相等待。EventHub 在请求前已存在，SSE 连接不由此图中的主任务创建或终止。

### 3.1 主任务完成边界

正常路径：

1. 场景准备所需关联标识和 Context，执行 Direct；保留现有用户消息与摘要生成语义。
2. 正文 delta 持续发布，扩展内容留在 Direct 隐藏输出中。
3. 确认正文符合完成条件，通过 Sessions 保存最终正文。
4. 由任务服务保存 completed，发布正文最终结果与主任务完成事件；释放原有主任务占用。
5. 分别启动状态处理和建议处理，各自捕获异常、保存自身结果或发布事件。不得在步骤 4 前等待这些工作，也不得串行等待状态后才处理建议。

正文未完成、用户取消、Provider 执行失败、正文保存失败、主任务终态保存失败，仍按现有 failed/stopped 语义处理。正文失败路径保留已显示内容的既有行为。本方案没有把所有错误都改成成功。

主结果持久化必要；状态持久化独立。即使二者仍使用同一 SQLite，也不再进入同一个 finalize 方法或同一终态决策。

保留当前单会话主 Run 的请求准入规则；它只覆盖主任务，不能延伸到后置任务。删除当前 worldRuns/worldBusy 对同世界不同会话的互斥准入，不把它搬进新引擎；资源删除时必要的使用中检查按资源生命周期处理，不作为世界状态锁。既有任务准备、取消和重启中断恢复继续可用，异步后置不保证重启续跑。

### 3.2 StateService 必须是完整能力

StateService 统一提供定义校验、global / session / message 初值生成、开局覆盖、读取和更新，复用现有 v2 的类型、路径、规则和最终快照校验。HTTP 与 Direct 只是不同输入适配及授权范围。

世界导入、新建会话和 opening.initial_state 都接入同一初始化能力。世界卡内的状态定义仍随 World 持久化；现有创建行的聚合 INSERT 可以携带 StateService 返回的已校验初值，但不得自行实现另一套状态规则或编码。后续状态更新由 StateService/StateRepository 处理，不扩为整套世界 CRUD 重构。

- HTTP 保留 SDK 授权 scope 和路径约定。
- Direct 只提交本次 Context 已激活的 message 根；不扩展模型写权限。
- JSONL 语法诊断属于 Direct；解析成功的项再交 StateService 做业务校验。
- 每项失败不污染后续项；最后一次完整快照校验和数据库保存都属于状态操作。
- 快照校验失败或状态保存失败：该状态处理失败，主 Run 保持 completed，建议照常独立执行。
- 状态写入成功后才发布相应变更；global 更新仍广播到对应世界会话。
- 状态失败不调用主任务的 markCommitFailed，也不写回主 Run.extensions。

Direct 保存目标必须包含固定的 sessionId、runId、assistantMessageId。服务验证这些关联确实属于来源消息，但不要求来源消息仍是当前 tip。禁止在晚到保存时重新调用 tip(sessionId) 选择目标。

message 状态为 NULL 表示沿该消息的祖先链继承最近的非 NULL 状态，不表示空状态。拆出 StateRepository 后保留此语义；按固定来源 messageId 解析对应祖先链，不能以当前 tip 代替来源。

HTTP 当前状态操作仍可按既有接口选择当前目标；不能把这个便利行为复用为 Direct 晚到结果的写入方式。message 来源事件携带 runId/messageId。首版 SDK 收到这类消息状态事件时，通过既有读取能力刷新当前服务端状态视图，不把旧来源消息的 value 直接覆盖到当前 message 镜像；不建立每条消息的缓存、状态版本或排序协调。global/session 事件保留现有范围语义，不强行附会到某个叙事消息。

P3 同步移除 State HTTP 对 runtime.worldBusy 的依赖，以及主终态提交对状态 baselineHash 的依赖。保留一般输入有效性及来源关联检查；不加入锁、CAS、状态版本或新的覆盖协调。

### 3.3 建议与前端展示

保持现有自动建议产品约束：3 条互不重复的非空短文本，每条不超过 50 字符，绑定来源 Run 和已保存正文消息。

- 主任务完成事件先于该任务的建议事件发布，保证 Host 已建立正文消息映射。
- 当前 Run 已 completed，稍后到达的建议仍可展示。
- 已接受新的主 Run 后，上轮晚到建议不再替换当前输入候选；这是当前建议的有效期规则。
- Server 发布结果仍携带正确来源；不能为迎合当前页面而改绑到最新消息。
- 状态成功、失败或仍在进行，都不是建议启用、校验和发布条件。
- 本期不新增建议持久化和回放。刷新或重连后可能没有此前的即时建议。

如未来要把建议长期展示在各历史消息下面，再作为 Sessions 的消息附属结果设计；本期不因此创建 Actions 领域。

### 3.4 事件与公共契约

已有 GET /sessions/:id/events 是长连接；当前终态事件本身不会关闭 SSE。本期提取其发布源，不把已经正确的连接机制重新设计为每 Run 一个流。

- 把 SRRuntime 的 listener 集合提取为 EventHub；SSE 直接订阅，断开、背压和关闭服务按现有规则处理。P1 中组装公共结果仍需要的 runtime.status 只读调用暂经查询适配保留，P3 移到 narrative/queries。
- SRRuntime.start 内部被 drain 的 ReadableStream 不等于 SSE。核对调用方后移除多余双通道；有真实调用者时才保留短期适配，P5 清理。
- Server、SDK、Studio 同批取消对 Run.extensions 汇总的依赖。
- 叙事对外 phase 保留 preparing / narrative / finalized，去掉等待 extensions 的阶段与“正在处理状态与建议”文案。这是叙事视图，不是所有引擎任务的统一阶段表。
- 新结果不再持久化或不断回填两个后置状态到 Run。
- DEBUG 即时反馈使用独立 narrative.postprocess.updated 事件，携带 sessionId、runId、messageId、processor、status 和允许展示的诊断；processor 分别为 state_update / action_suggestions。
- 错误诊断仅由服务端 SILLYREALMS_DEBUG=1 开启，普通模式保持静默；不新增后置状态表、任务追踪平台或重连回放。
- 修改 packages/sr-sdk/src/run-contract.ts、story-history.ts、postprocess-feedback.ts、state-contract.ts、state-runtime.ts、session-runtime.ts、world-story.tsx，以及 Studio Host 和 ActionSuggestionStore 的相关消费。
- story-history 对事件做明确分派，新的后置事件只更新独立反馈，主 Run reducer 明确忽略；历史初次加载期间缓存的事件同样处理。不能进入旧的未知事件/终态兜底分支，把 completed 改为 failed。
- 历史 Run 分组、分页和已有消息映射保持可用；旧 ext_data 中的 extensions 可以保留，新的历史投影忽略该字段，不据此显示等待状态。

## 4. Direct 输出协议的首版切换

### 4.1 单一协议：状态 JSONL，建议仍为 JSON 数组

示意中的“体力”“位置”假设是世界已声明、当前已激活的根，沿用现有 path 不带 scope 的规则：

~~~text
故事正文……

<state_update>
{"path":"体力","value":90,"reason":"长途跋涉"}
{"path":"位置","value":"城门"}
</state_update>
<action_suggestions>
["询问守卫城内的情况","查看城门旁的告示","寻找附近的旅店"]
</action_suggestions>
~~~

约定：

1. 两个块平级，不增加 sr_extensions 容器；标签独占一行，允许行首尾空白。
2. 每个非空物理行是一条完整的严格 JSON 对象；没有数组外壳、行间逗号或 Markdown 围栏。
3. 项字段维持 path、显式 value、可选 reason；字符串内换行使用转义的 \n，不能把一项展开到多行。
4. 无变化时使用空的 state_update 块，不输出 []。
5. 空行忽略；坏行记录行号并跳过，之后合法行继续处理。不会修复引号、猜测 JSON 或调用模型补救。
6. 合法项依原顺序应用，同一路径多次出现仍顺序处理；value 的完整替换语义、权限及 v2 规则不变。
7. 保留最多 100 项以及现有大小、深度和路径约束。上限按非空更新行计数，坏行也计入；超额行忽略并诊断，已处理项不清零。
8. 建议内容继续按自身严格 JSON 与三项约束校验，状态的 JSONL 规则不扩散到其他块。

### 4.2 帧层也逐块隔离

分帧器返回可识别块及局部诊断，不再返回一个会清空所有已解析结果的全局 error。

- 扫描以独占行的已知标签为边界，不把上一行未闭合的 JSON 引号状态带到下一行。
- 某块缺少结束标签、随后遇到另一个已知开始标签：用该边界结束前块候选并继续扫描后块；前块由自己的内容解析器判断能否使用。
- 最后一个块到达 EOF 时可隐式闭合；内容完整则可处理，内容不完整只影响它自己。
- 某一行 reason 引号坏了，不得吞掉后续建议标签。
- 同名块采用第一个可独立划界的片段；后续同名片段跳过并记录诊断，不合并、不覆盖。未知或多余标签局部记录，不推翻已确认兄弟块。
- 扩展区内无法识别的碎片不猜作正文或合法状态。
- 不再存在“任一帧错误 → 整个 postprocess 抛错 → 主 Run 失败”的调用路径。

### 4.3 隐藏流与截断也遵守同一边界

不能只改 parser，还保留 splitter 或 runner 的全局失败路径。

- 首个完整、合法且独占行的已知开标签才确认正文与尾部边界。标签跨 delta chunk 时先缓冲再判定，不能依赖 chunk 边界。EOF 的半个开标签不能单独作为正文完整的证据；正常正文的完成条件与该残片的局部诊断分别判断。
- splitter 与 parser 只把本版两个平级块视为合法边界。废弃的 sr_extensions 保留标记只作为需隐藏并诊断的协议碎片，不参与合法分帧，也不能证明正文完整；不把它恢复为第二种合法协议。
- 保留隐藏 tail 的 256 KiB 资源上限。
- 超限时保留已经划界的兄弟块和已完整捕获的状态行；不使用清空 raw 再返回 undefined 的方式丢掉此前结果。
- 可用有界增量解析，或保留上限内前缀并将其作为截断输入处理；达到资源上限后，不承诺恢复超出上限且尚未捕获的内容。
- 截断、残缺标签、隐藏尾部格式错误只产生局部诊断，隐藏内容不得补回可见正文。
- Provider 正常以 length/maxTokens 结束时：若已有合法扩展起始边界、正文已完整，可以将问题限定在尾部。若正文仍在生成而被截断，则保留主任务未完成语义。
- 识别到扩展开始不代表主 Run 当场完成；仍需完成主调用判定及正文保存。
- Provider/网络错误或用户取消保持主流程错误语义，不以“看过一个标签”为成功依据。
- 当前 delta/final 全量输出一致性检查不能因隐藏尾部差异单独否决已完成正文。若保留检查，应限于用户可见正文；正文差异仍需处理。

### 4.4 预设必须和解析器一起切换

真实默认文件是 apps/server/resources/presets/default.json；docs/default.json 只是文档镜像。数据库只有在预设为空时插入默认值，因此只修改资源文件不会更新已有预设。

P4 的同一发布批次必须包含：

1. 更新真实默认预设、文档镜像、协议说明和请求编译测试。
2. 盘点目标环境中所有准备继续使用的已存预设，包括暂未被会话选中的预设；核对实际编译后的完整模型请求，不只搜索仓库默认文件。
3. 对确认未改动的旧内置协议节点，使用既有预设管理能力替换对应节点，保留其他内容。
4. 用户自定义协议文本逐项审阅，明确改成 JSONL，或通过已有管理入口恢复该默认协议节点；不以正则猜测并覆盖整份自定义提示词。
5. 在准备继续使用的预设与 Server 协议一致后才完成切换。未验证的旧自定义数组提示词列为待处理项，不能标记切换完成；以后重新导入旧预设，也需检查或恢复对应协议节点，不承诺旧内容自动兼容。

不保留数组/JSONL 双协议解析，不建设新的预设迁移框架。首版维持当前 preset schema v3、model_parameters 和 context_strategy 的存储；ModelConfig 与多模态分型留给后续阶段。

本任务只编写计划，不执行上述用户配置变更。

## 5. 数据与历史策略

| 当前存储 | 首版归属 | 数据处理 |
|---|---|---|
| worlds.state_definition_json | World 保存世界卡内定义；StateService 负责校验与解释 | 保留 v2，创建流程不复制状态定义规则 |
| worlds.state | StateRepository；World 创建行可携带已校验初值 | 保留 global 数据 |
| sessions.state | StateRepository；Session 创建行可携带已校验初值 | 保留 session 数据 |
| entries.state | StateRepository；Session 开局创建行可携带已校验初值 | 保留 NULL 继承与 message 快照；Direct 按固定来源消息写 |
| sessions / entries 的会话、消息、parent_id、seq、tip | SessionRepository | 保留历史、分支与分页 |
| entries 中 compaction 内容 | SessionRepository | 保留已有摘要和上下文处理 |
| entries.ext_data 的主 Run 结果、run_preparations | TaskRepository | 拆清终态写入职责，不要求先拆表 |
| sessions / entries / run_preparations 的 usage | UsageRepository | 只负责统计，不能借结算写任务终态 |
| 旧 Run.extensions 元数据 | 旧数据保留，新读取忽略 | 不清历史，不为消除字段做全表迁移 |

首版数据库仍为 v7。不执行 reset:runtime，不清空世界、会话、消息、预设或标签，不创建新的状态 schema 迁移工具。

中断恢复必须从 database.ts 中现有 recoverInterrupted 调用链开始调整：任务恢复交给任务服务，不能漏掉 UsageStore.settleRun 隐含的终态职责。

用量的待结算判定改用计量自身的 metrics/accounted 等已有记录，不依赖 preparation.status === preparing。未结束主任务按原规则恢复；已 completed 但未结算用量的任务只补计量，不能改成中断任务。任务恢复和计量补结算不能因执行顺序不同而漏数据。

现有 sessions.usage_json.pendingRun 只有一个槽。P3 改为在主执行期间按 runId 将计量来源归属到现有 entry/preparation 记录，不能让新的 pendingRun 覆盖上一轮唯一的待结算记录；主任务完成时无需等待后台汇总来腾出这个单槽，实际统计可独立进行。沿用 v7 的计量字段，不新增队列或表。计量写入异常归计量问题，不翻转主 Run；未成功保存的数据不承诺重启补回。

同表不等于同职责。允许不同 Repository 读写现有同表中的各自字段，但不能互相覆盖不归自己管理的结果。

## 6. 可逐批合并的迁移顺序

每批结束都能运行当前产品。旧路径如暂留，只能转发到唯一实现；不同时运行新旧 Runtime。目录移动与行为改变尽量分批，必须一致的公共契约在同批提交。

| 批次 | 做什么 | 当批完成标准 |
|---|---|---|
| P0 基线 | 记录关键 API、事件、历史与当前测试；列出混合写入和预设配置 | 有可复核的回归范围，无数据库操作 |
| P1 事件服务 | 提取 EventHub，替换真实发布和 SSE 订阅源 | 旧流程可用，Run 终态后 SSE 仍接收事件 |
| P2 业务与存储 | Sessions / StateService / Task / Usage 的接口及仓储拆分，先适配原调用链 | 只有一套校验和 SQL 实现，行为暂按旧链路 |
| P3 主流程切换 | Narrative + TaskRuntime；主结果先完成；独立后置；前后端契约同步 | 状态保存失败不影响主 Run，建议不等待状态，下一轮可启动 |
| P4 输出协议切换 | JSONL、块级恢复、splitter/finishReason、实际预设同步 | 两个已知故障及截断场景全部通过，无新旧协议混用 |
| P5 清理与验收 | 删除临时入口、旧总 Runtime 和旧汇总契约，更新文档约束 | 唯一新链路、保留既有功能、完成针对性验证 |

### P0：先固定要保留的行为

- 核对 API 路径、Run 状态、会话 SSE、Host 的来源核验、历史分组和分页。
- 记录 Context 选择、token 预算、滚动摘要/滑动窗口、用量与取消语义。
- 将第 7 节的故障案例作为后续验收输入，先确认原测试覆盖及必要缺口。
- 不为搬目录编写镜像测试；仅补能验证真实失败边界和产品行为的测试。

### P1：把事件发布从总 Runtime 拿出来

- 装配单实例 EventHub，旧 emit/onEvent 暂转发。
- Session SSE 的订阅源切到 EventHub；当前组装 messages/publicResult 所需的 runtime.status 暂经只读查询适配保留，P3 迁到叙事查询后删除该依赖。
- 保持事件名称和现有主流程语义，让这一批只验证事件接入没有丢失。
- 暂不把同批扩为任务生命周期重写。

### P2：建立业务服务和 Repository 边界

- 把 RunStore 的消息、摘要、会话查询移入 Sessions，把状态规则与存储统一到 StateService。
- 建立 TaskRepository 和 UsageRepository，确定各自写入字段，逐一替换 SQL 调用。
- HTTP 状态路由改调用 StateService；世界、会话和消息的读取校验仍然完整。
- 接入 world-repository 的世界状态初始化，以及 session 创建/开局状态初始化；允许既有创建 INSERT 使用 StateService 的已校验初值，不复制初始化和覆盖规则。
- 本批若仍保留旧联合 finalize，仅作为已登记的临时编排，不能称为已完成独立保存。
- State HTTP 的 busy 限制可临时留到 P3，与主流程状态 hash 门槛一起撤掉，避免半切换。
- 当前 Context 算法与压缩行为先不改。

### P3：一次切清主结果和后置结果

- 将 Context 编排、Direct 与历史查询接入 NarrativeService；TaskRuntime 只管理主任务。
- 主流程只保存正文及主任务结果，不再向 finalize 传状态候选、状态基线或两个插件汇总。
- 主结果提交、完成事件发布、释放占用后，独立启动状态和建议；每个分支都有自己的异常收口。
- 状态明确保存到来源 assistantMessageId；不再查询最新 tip，不要求来源仍为最新消息。
- 移除 State HTTP 的 worldBusy 依赖，以及 start/prepareRun 的 worldRuns/worldBusy 跨会话排他；仅保留单会话主任务准入。主任务不因状态版本、变化或保存失败而被改为 failed。
- 将 UsageStore 中终态副作用迁到任务服务，同时改启动恢复调用链、独立的待结算判定及 pendingRun 单槽交接；计量汇总不阻塞或翻转已经完成的主任务。
- 同批修改 SDK/Host 的 phase/extensions、DEBUG 反馈、状态来源路由和晚到建议处理。
- 临时保留旧解析器时，其失败只能影响各后置结果；到 P4 再完成按行和按块挽救。
- 验收本批时注入状态保存异常与延迟，证明不是仅把 Run.status 提前设 completed、仍等待后台才释放占用。

### P4：切协议，修掉三层隔离漏洞

- 同时修改 FrameParser、状态 JSONL 解码、StreamSplitter 与 Direct 完成条件。
- 消除 processor 在任一全局 parse error 时直接 throw 的入口。
- 覆盖内容语法、标签边界、尾部上限/截断三层，不只修改 JSON.parse 的输入。
- 同批完成真实预设、文档、已选择配置和完整编译请求的切换核验。
- 不把“默认文件已更新”当成已有数据库预设已切换的证据。

### P5：删旧路径，形成首版稳定边界

- 删除 SRRuntime 旧职责、RunStore 混合 finalize、run-post-processor 薄封装及旧转发入口。
- 清理 Run.extensions 的生产者、消费者、持久化和旧扩展等待文案；历史数据本身保留。
- 按实际调用核对，移除旧内部 ReadableStream 双通道；会话 SSE 保持独立。
- 更新 docs/runtime/postprocess.md、docs/runtime/state-v2.md、真实默认预设和文档镜像。
- 更新或迁移原 runtime/AGENTS.md：明确“主结果保存失败”和“状态独立保存失败”的不同归属，删除与新边界冲突的规则，保留 DEBUG 与回归要求。
- 搜索导入和运行入口，确认没有第二套真实实现；再运行最终验证。

回退以批次为单位回退代码，不通过重置数据回退。涉及 P4 时，Server 与预设协议配置必须一起恢复到一致版本；不自动覆盖用户的其他自定义配置。

## 7. 验收矩阵

| 验收输入或故障 | 必须观察到的结果 |
|---|---|
| 10 行状态更新，第 9 行 reason 含未转义引号，其余行合法 | 其余 9 行独立处理，第 10 行仍执行；主 Run completed |
| 建议块缺少结束标签，状态块 7 项合法 | 状态 7 项保留；建议按 EOF/下一块边界及自身内容判断；主 Run 不因标签失败 |
| 状态行有未闭合字符串，后面有合法建议块 | 字符串错误不吞掉建议边界，建议可独立发布 |
| 一个扩展块格式错误或出现重复/未知标签 | 仅局部诊断，已识别兄弟块不清空 |
| 开标签跨 chunk，或 EOF 只有半个开标签 | 跨 chunk 正确重组；残片不泄露，也不被当作正文已完整的证据 |
| tail 超限、EOF 截断或残缺标签 | 保留上限内已完整捕获的有效结果；无隐藏内容泄露；正文完成条件单独判定 |
| 正文完整，Provider 正常在 tail 因 length 结束 | 主结果可完成，尾部按局部截断处理 |
| Provider 错误、正文截断、用户停止 | 保持对应 failed/stopped 和已显示正文的既有语义 |
| 状态最终快照校验失败 | 主 Run 保持 completed，建议不受影响 |
| 状态数据库保存失败 | 不调用主任务失败提交；主 Run 保持 completed，建议照常 |
| 状态处理挂起或较慢 | 建议可先到；主占用已释放，可开始下一轮 |
| 同世界两个不同 session 开始主任务 | 不因 worldRuns/worldBusy 互斥，后置不占主任务准入 |
| 新一轮开始后，上轮状态才保存 | 只写上轮来源消息，不误写新 tip；事件来源正确，SDK 刷新当前视图而非直接覆盖旧值 |
| 当前 Run completed 后建议到达 | Host 仍能展示当前建议；完成事件先于建议事件 |
| 新 Run 已接受，上轮建议才到达 | 不替换当前输入候选，不改绑来源 |
| 主 Run 完成后发布后置事件 | 原 SSE 继续接收，客户端保持 completed，不能被兜底分支改成 failed 或 running |
| 正文保存或主终态保存失败 | 主任务失败，不发布该轮建议或状态后置 |
| HTTP 更新与 Direct 更新 | 复用同一 v2 规则；权限差异明确；无 runtime.worldBusy 状态门槛 |
| 世界导入、创建会话与开局状态 | 三种 scope 初值、定义规则、开局覆盖语义保持一致，统一使用 State 初始化能力 |
| 新消息 state=NULL、缺失状态块或状态处理失败 | 沿来源消息的祖先链继承已有状态，不清空、不串分支、不改用当前 tip |
| 旧 v7 数据库、分支历史、摘要与分页 | 无清库；查询与压缩行为保留；旧 extensions 不造成等待 |
| 准备阶段中断、无正文失败、重启恢复 | 任务终态正确；已完成任务只补用量；不依赖 preparing 状态和结算先后顺序 |
| 上轮计量汇总延迟或失败，立即开始下一轮 | 已保存用量仍按来源 Run 归属，不因 pendingRun 覆盖而混轮或丢失 |
| 所有准备继续使用的数据库预设 | 编译请求明确要求 JSONL；包含暂未选中的预设，默认与自定义节点均核对，未双协议运行 |
| DEBUG 关闭 / 开启 | 普通用户无诊断；开启时按来源消息和处理器展示局部结果 |

测试不再断言旧的全局总顺序 message.final → state.changed → run.updated → suggestions。只约束必要的因果关系：主结果已保存、主完成已发布，再发布该任务的后置结果；状态与建议之间没有顺序依赖。

## 8. 验证命令与覆盖范围

当前基线的相关命令（目录移动后更新聚焦路径）：

~~~bash
pnpm --filter @sillyrealms/server exec vitest run src/runtime/postprocess src/domain/state/state-v2.test.ts src/routes/state-v2.test.ts src/runtime/context/state-materials-v2.test.ts
pnpm typecheck
pnpm lint
pnpm test
pnpm build
~~~

- pnpm test 当前运行 Server Vitest；SDK/Studio 契约还需要类型检查和前端构建。
- pnpm build 当前是 Studio 构建，不代表 Server 编译。
- Host/SSE 或建议展示有改动时，补充针对当前界面的集成检查；必要时使用既有 pnpm test:browser，不在每次纯目录移动后重复跑完整浏览器套件。
- 数据库测试使用内存或临时夹具。runtime-reset-v7.test.ts 的测试执行不等于对用户数据库运行 reset:runtime。
- 修改直接链路时遵循原 runtime/AGENTS.md 的回归、类型检查与构建要求；实施时同步更新与本方案冲突的旧生命周期条款。
- 不把未执行的测试标记为通过。本次文档任务只验证计划内容、引用、结构与写入结果。

## 9. 首版结束的判定

只有以下事实同时成立，才算本次迁移完成：

- 请求经 NarrativeService、TaskRuntime、Sessions、StateService 的真实新调用链。
- 任务完成不读取、保存或等待状态结果；用量不决定终态。
- 正文完成后会话主任务占用释放，后置不会锁住下一轮。
- 状态与建议的语法、帧、校验、保存及发布失败都按所属部分处理。
- Direct 晚到状态按固定来源消息写入，晚到建议遵循当前候选有效期。
- Server、SDK、Studio、真实模型预设输出协议一致。
- 历史与当前用户数据保留；上下文压缩及既有核心行为通过验证。
- 旧总 Runtime、混合 finalize 与临时兼容入口被移除，未创建未来能力的空架构。

下一阶段由产品优先级决定续写、帮答、Agent 或媒体能力；不能继续给本期 Direct 后置补一个“所有场景共用”的总处理器。
