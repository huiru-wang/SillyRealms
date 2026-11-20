# ServerV2 上下文独立与模型旁注方案

状态：已完成（实现与验证）。2026-11-20 按确认的单入口、场景编排、内部阶段和条目级模型旁注方案完成实现、验证与文档核对。

任务：[server-v2-context-tasks.md](server-v2-context-tasks.md)。输出处理契约继续见[叙事后处理方案](server-v2-narrative-output-design.md)。

## 1. 范围与目标

上下文准备从 narrative 独立为 usecases/context，外层只使用 prepareContext 及公开类型。模块内部完成输入快照、历史投影、材料选择、旁注、预算、压缩、摘要保存和最终消息组装。外层 narrative 继续负责受理用户、会话运行锁、主模型调用、输出后处理、保存助手及 run 结算。

本期只修改 ServerV2 与相关文档、架构约束。不迁移 Studio/StudioV2 或 SDK transport，不新增 runtime/runner、通用工作流框架、HTTP、表或数据库版本。

迁移分两步实施：先独立既有上下文能力并保留行为，再接入条目级 model-only notes 和两个内置来源；两步在本次交付中完成并分别验证。

## 2. 目录与依赖

```text
usecases/context/
  index.ts
  types.ts
  narrative.ts
  capture.ts
  candidate.ts
  lib/
    template.ts
    estimate.ts
    budget.ts
  stages/
    history/index.ts
    materials/index.ts
    model-notes/
      index.ts
      state-update.ts
      action-suggestions.ts
    compact/
      index.ts
      plan.ts
      summary-request.ts
      saved-summary.ts
    assemble/
      index.ts
      protocol.ts
```

- index.ts 是唯一公开出口，显式导出入口及领域类型，禁止 wildcard 和外部 deep import。
- narrative.ts 是叙事场景编排器，内部组合阶段并经 SessionService 保存成功摘要。未来确有不同输入或编排需求时新增场景编排器；新增材料/旁注来源可复用当前流程。
- capture.ts 在首次异步等待前读取并克隆本轮数据，捕获用户消息的真实前驱状态，排除当前用户消息的历史投影。
- candidate.ts 组合历史投影、材料选择和实际消息编译，提供 compact 使用的候选评估函数；compact 不反向依赖叙事场景数据。
- stages 通过明确输入输出协作，不依赖完整 NarrativeDependencies/Execution，不管理 run 或 SSE。
- lib 只放模板、估算和预算计算。assemble 产出实际模型消息，不能把尚待编译的 prompt nodes 交回外层。
- context 生产代码不能依赖其他 usecases、EventHub/SSE；summary 调用经窄端口。中立模型流收集归 infrastructure/model/collect.ts，提供 collectModel、raceAbort 及快照复制等函数，不依赖业务模块、状态更新、叙事 splitter 或传输。narrative/model-call.ts 继续承担输出分离、公开事件与停止原因映射。
- ESLint 在现有 architecture/boundaries 中新增 contextEntry/contextDependency，覆盖静态、重导出、动态、require 和类型导入；外部测试也遵守唯一入口，内部阶段测试放在 context。

## 3. 唯一入口与准备结果

公开调用为 prepareContext(dependencies, input)，当前 input.kind 固定为 narrative。prepareContext 可能执行一次摘要调用、保存 compaction，因此是准备操作而非普通读取。调用时同步冻结输入后再等待凭据/模型，确保异步期间的配置或历史正文编辑不改变本轮输入。摘要进度必须在 run.created 之后；实际保存成功才报告 summary 完成。

准备结果至少表达以下信息，具体字段采用实现的显式领域类型：

| 信息 | 消费方 |
| --- | --- |
| 最终模型消息与调用参数 | 外层发起主模型请求 |
| 最终激活状态根 | 本轮输出状态更新约束 |
| 后续 parentEntryId | 助手接在当前用户或成功摘要之后 |
| 已保存摘要最小回执与计量 | 外层汇总 run 总 usage |
| 准备失败信息 | 外层映射既有 stop_reason 并结算 |

PreparedContext 使用 ok 判别：成功分支返回 request，失败分支返回 failure.code；两者都有 parentEntryId，可附 summary:{entryId,metrics}。request 包含最终消息、预算、模型、生成参数、激活根和 credentialRef，不包含凭据字节。摘要与正文通过本轮闭包复用同一凭据读取结果，凭据不进入 context 的返回值或持久化内容。

narrative/index.ts 先排入执行微任务，再同步调用 prepareContext 完成捕获；prepareContext 的后续异步阶段在 run.created 之后运行。ContextProgress 使用 summary_started / summary_saved，前者由摘要端口在凭据就绪、实际调用前触发，后者仅在 compaction 保存后触发，由外层映射既有 run 事件。

摘要草稿、内部 candidate/stage 状态不暴露给外层保存；不返回用于恢复运行的可变对象或新增执行日志。外层不会再次查内部阶段决定摘要是否提交。

## 4. 候选构建和预算

阶段可以重复组合，不是各执行一次的固定流水线。compact 选择历史范围时使用候选评估函数，每个候选重新：

1. 投影范围内的干净历史及有效旧摘要；
2. 按原关键词/when 语义重新激活角色、世界书和状态根；
3. 选择该范围实际保留条目的模型旁注；
4. 按预设组装最终消息、固定输出协议及旁注；
5. 估算完整实际请求。

最终结果使用最终候选的 activeRoots，不沿用初始材料。删历史可能改变材料激活，不能假定估算单调下降；不能在预算通过后额外追加未计量旁注。

沿用当前输入预算、软目标、滑动窗口完整 run 边界、滚动摘要保护最近五轮及每轮最多一次摘要。粗估与实际 usage 分开，实际计量采用模型返回值，包含旁注输入和隐藏输出。

## 5. 压缩阶段闭环与持久化

compact 内部拥有 plan、summary-request、saved-summary，负责计划、复用校验、必要的摘要调用和实际摘要后的候选复核。阶段不写库，不发 run 事件；通过 summarize 端口执行模型。

成功摘要草稿包含完整文本、覆盖末条 entry、sourceHash 和调用 metrics。最终复核失败不能丢弃成功草稿；阶段返回候选、草稿及准备失败信息。

context/narrative 保存成功摘要并形成已提交回执。状态快照为 null，属于当前 run，parent 为当前用户；外层助手后续 parent 使用实际摘要 ID。保存成功后再通知摘要完成。准备最终失败仍保留已提交摘要及用量，不让外层接手草稿保存。

| 场景 | 结果 |
| --- | --- |
| 无新摘要 | 没有新增摘要计量，后续 parent 保持当前用户 |
| 摘要失败、截断或取消 | 不保存摘要、无摘要计量 |
| 成功摘要保存 | 返回已提交回执，未知 usage 为 null |
| 最终上下文仍超预算或编译失败 | 保存成功摘要并返回准备失败；不调用主模型 |
| 摘要保存失败 | 不伪造回执/完成事件，保留用户并沿既有原因结算 |
| 保存成功后取消 | 保留摘要与计量，不开始正文调用 |

saved-summary 校验覆盖范围为完整 run 边界，并根据覆盖原文 id/seq/runId/role/content 计算 sourceHash。动态旁注不进入摘要，也不进入 hash；旧摘要元数据无效或原文被编辑时回退原文。不新增异步编辑锁、指纹恢复或摘要修复重试。

## 6. 条目级模型旁注

model-notes 用 entryId 关联独立旁注和原始正文。通用来源支持 user/assistant，不以 state/action 两个能力固定抽象；本期叙事只安装这两个内部来源。无需插件注册器、notes 表或持久化 schema。

### 选择与来源

在本轮捕获的历史中先取最近两条有可见正文的 assistant，再逐条读取其 output；没有 output 不向更早条目补足。两个来源异常分别跳过，不能相互影响。

- state-update：只使用已接受的 updates，包含 partial_success 中的成功项。
- action-suggestions：只使用有效 items，包含 partial_success 的有效项。
- 不加入逐项错误、损坏原文或失败标签，不从当前快照倒推历史更新。

状态旁注明确是当时已应用的记录；行动建议是尚未执行的选项；当前状态以本轮状态快照为准。JSON 内容中的保留标签转义，避免混淆本轮输出边界。

### 不同用途的投影

| 用途 | 内容 |
| --- | --- |
| 材料关键词激活 | 干净历史、有效摘要和当前输入 |
| 摘要请求 | 干净正文，沿用 instruction 剥离 |
| 主模型消息 | 干净正文与选中、最终保留的旁注 |
| 输入估算 | 最终消息全部内容，包括旁注 |

旁注在压缩前构建关联，最终 assemble 才渲染。被裁剪或摘要覆盖的条目不渲染旁注；多次候选评估始终从干净正文重建，不重复追加。

正文编辑仍保留当时 output；旁注是原处理记录，不宣称已根据新正文重算。读取/渲染不执行状态更新、不触发状态事件、不修改数据库正文。HTTP 和聊天仍只读取已保存的正文与结果，不增加旁注接口或 contextEligible。

## 7. 验证与交付

只做函数测试、typecheck、lint，使用内存/临时 SQLite、模型流与凭据替身，不启动真实服务、HTTP/浏览器链路或真实模型请求。

验证应覆盖单入口捕获时点、取消及事件顺序、候选重新激活、摘要复用、保存回执与后验失败、最近两条选择、旁注来源隔离/幂等/转义、真实输入预算、摘要与材料不受旁注影响、历史编辑语义和原有输出处理回归。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @sillyrealms/server-v2 exec vitest run src/modules src/usecases src/infrastructure src/http src/testing` | 39 个测试文件、465 项测试全部通过 |
| ServerV2 typecheck | 通过，exit 0 |
| ServerV2 lint | 通过，exit 0 |
| `git diff --check` | 通过 |
| 独立集成评审 | 快照、事件顺序、取消、摘要回执、模型收集边界无阻断问题 |

运行文档、两级 AGENTS 及输出方案当前边界已同步。交付按本轮授权提交推送全部变更，并核对远端提交和干净工作区；Git 结果以提交历史及本轮交付记录为准。
