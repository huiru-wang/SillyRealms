# 首发 Server Run 重构任务

目标契约、示例与取舍见[服务端 Run 实体与消息状态方案](服务端Run实体与消息状态方案.md)。以下任务共同构成一个独立的 Server 交付阶段。所有服务端读写、公开契约、负例、清理和回归都要在本阶段完成。Web / Stage / SDK 的改造从冻结后的服务端样例开始。

## 变更文件目录

同目录下的花括号列出同类文件，标记说明预期操作。继续用 sessions/repository.ts 承担 SQL，sessions/service.ts 是唯一对外模块入口，路由不直接操作数据库。

```text
.
├── AGENTS.md                                           修改 · 根目录首发运行、存储、恢复契约
├── apps/server/
│   ├── AGENTS.md                                       修改 · sessions 表属主、事务、结算和摘要边界
│   ├── eslint.config.mjs                               修改 · 仅为 sessions 的 SQL 白名单增加 runs
│   └── src/
│       ├── {server,app,usecases,errors}.ts             修改 · 启动前收尾、故障上报与 503、准入、SSE 关闭及装配
│       ├── infrastructure/database/connection.ts       修改 · v15 DDL、状态 CHECK、分页和唯一索引
│       ├── modules/sessions/
│       │   ├── run.ts                                  新增 · 内部 Run schema、停止枚举、计量聚合与 DTO 类型
│       │   ├── {schema,types,output}.ts                修改 · 消息完整性、能力结果与持久资源引用
│       │   ├── repository.ts                           修改 · 条目、轮次与摘要的事务写入、分页和显式删除
│       │   └── service.ts                              修改 · 公开轮次与计量读取、受控写入、精确消息立绘读取
│       ├── usecases/
│       │   ├── create-session.ts                       修改 · 初始化 Run 和开场消息的同一事务
│       │   ├── append-entry.ts                         删除 · 未挂载的通用业务追加入口，移除绕过轮次的路径
│       │   ├── narrative/
│       │   │   ├── {index,types,start}.ts              修改 · 受理、停止、执行身份及提交后通知
│       │   │   ├── {regenerate,execute,events}.ts      修改 · 替换、原子结算和事件字段
│       │   │   └── postprocess/{processor,character-sprite}.ts
│       │   │                                           修改 · 按能力写当前轮，附捕获目录的资源引用
│       │   └── context/
│       │       ├── {capture,types,prepare,candidate}.ts 修改 · 捕获输出、上下文输入和摘要记账
│       │       ├── stages/compact/index.ts             修改 · 摘要请求指标类型改为 RequestMetrics
│       │       ├── stages/assemble/index.ts            修改 · 将已捕获的能力输出交给模型 notes
│       │       └── stages/model-notes/{index,types,state-update,action-suggestions,character-sprite}.ts
│       │                                               修改 · 以已选助手定位其 Run 输出
│       ├── http/narrative-query.ts                     修改 · 轮级 cursor，严格校验参数
│       ├── routes/{sessions,narrative}.ts              修改 · 开场 201、精确读立绘、分页、详情、命令和计量
│       ├── testing/{fixtures,reader-contracts}.ts      修改 · 提供真实有效的轮次夹具及读写边界
│       └── 测试文件（下节列出）                          修改或新增 · 存储、用例、公开接口和故障回归
├── docs/runtime/
│   ├── {server-narrative,server-http,server-events}.md 修改 · 实际实现通过验收后记录公开契约
│   └── {state-v2,local-development}.md                 修改 · 生效状态与轮次结果、新库启动方式
└── deploy/README.md                                    修改 · 首发新数据根、旧库拒绝和回退说明
```

重点复核但可复用当前实现的路径为 usecases/delete-world.ts（通过 SessionService 清理会话）、http/session-access.ts（鉴权前后一致）、infrastructure/cache/index.ts（叙事、帮答、世界的会话/全局写锁）、context/stages/compact/saved-summary.ts（正文 hash）、context/stages/history/index.ts（完整轮边界）、prepare-reply-assist.ts（只读摘要）、usecases/model-outcome.ts（21 个原因映射）、infrastructure/model/collect.ts（原始请求指标）、infrastructure/events/session-events.ts（SSE 传输）。核实原因导出、服务类型、测试装配变动处再改。世界升级保留会话及所有 Run；额外覆盖此路径。

## 实施与验收

1. **冻结用例与值域。** 从现有 Server 事件、HTTP、SDK 拟议稿抽取开场、成功、有部分回复的停止、无回复的停止、再生、摘要六组样例。定义 Run、Message、能力输出、计量与分页 DTO，收敛原始原因枚举到 sessions 模块单一导出。逐项比对 21 个原因在存储解码、详情、列表和事件构造中的相同值；单独保留底层错误到 Server 原因的模型映射测试。为会话创建的 HTTP 201 和 session.created 同时冻结 opening 字段及精确键集，和轮详情用同一个开场消息样例核对。完成标志是同一个 assistantEntryId 能贯穿受理、分片和结算，且不可用仅有用户消息来推断停止原因。
2. **落地 v15 和模块读写不变量。** 依赖 1。实现 runs DDL、消息状态约束、SQL 所有权规则。将首轮、普通轮、再生、摘要及结算写入收敛到明确入口；校验归属、角色、tip、当前执行身份和许可。保留低层 SQL 的复用，清除可以单独产出无归属 entry 的业务调用。写最新能力/计量必须以当前数据库值为基准。用全新内存库存取，确认无新 FK、跨会话拒绝、同会话并发最多一个活动轮、回滚不留半条记录。从全新数据根创建 v15 并重开。v14、其他版本及非 SR 库拒绝启动，原文件字节不变；对版本号正确但缺 runs 或索引的库验证结构错误，禁止启动后补表。
3. **开场、发送和重新生成。** 依赖 2。把开场的初始状态、能力结果和首轮一次提交；普通提交把创建 Run 与用户消息一次提交。实现 expectedAssistantEntryId 的再生前置条件，允许 user-only 轮再次生成。覆盖 opening-only、重复提交同 tip、陈旧 tip、同一用户多次失败后迟到的再生、不同会话、延迟停止、旧执行回调和旧助手已删除等情形。再生后的运行中立刻可查空能力、真实 tip 和新身份，旧状态值按实际父链回退。
4. **改造 Context、摘要和模型 notes。** 依赖 2，可与 3 独立开发，集成验收需要 3。摘要与其 Run 计量同事务，提交前复核 tip/source；成功摘要后的主调用失败、取消或再生均保留该摘要。保持裁剪完整轮、待答用户保护、摘要覆盖前缀校验和模型材料授权。以“最新两条助手一条无输出、一条有输出”的样例验证无历史回填。验证主叙事与只读帮答的输入、摘要、材料边界；查询次数不随候选数增加。连续提交两轮。第一轮只在 runs 写入能力结果；捕获第二轮传给主模型的 messages，核对第一轮助手正文后依次出现状态、建议、立绘块。再生后旧助手与旧输出均消失，缺少输出不能补取更早非空轮；检查摘要输入、帮答、激活与持久正文仍是干净文本。
5. **原子终态和计量。** 依赖 3、4。将后处理、实际有效状态、完整或部分助手、单个扩展字段、主请求指标和 Run 结论放进一次同步事务。对失败结果和缺键分别做存储往返。校验主调用无正文但有请求指标、未知 token、多次再生共用摘要、缓存分项、请求去重和 latestContext.stale。用故障注入分别卡在写助手、写能力、写终态、发送通知处，验证已回滚的数据不会被对外宣布，提交后的通知失败不能撤销事实。
6. **停止、异常退出与无 FK 清理。** 依赖 3、5。stop 先持久化 stopping；最小失败结算和启动前遗留活动轮收尾均要按身份执行。验证硬退出后只有已提交数据，重启不发送模型请求；停止/终态竞争、重启操作重复执行及新请求均有确定结果。用现有会话及世界删除入口验证锁、生效状态、entries 和 runs 原子清理，其他会话/世界不受影响；旧执行不得重建已删数据。在 app 层注入终态事务和最小失败事务连续失败：进程可响应时 /health、新请求均为 503 STORAGE_UNAVAILABLE，已开的 SSE 结束，无虚假终态；验证鉴权途中的请求不能在故障后提交。正常关机单测则须观测到先结算和通知、后关流和关库。
7. **发布轮次读接口与 SSE。** 依赖 2、5、6。GET 列表和详情复用同一 DTO，一次读快照批量取页内消息；会话计量和精确消息立绘入口只读 v15。核对开场 201 / SSE 使用相同 opening 投影，并断言响应没有顶层 entry。测试相同时间戳多轮、翻页间新增轮、再生、删除边界轮、非法和跨会话 cursor、无结果/尾页、limit=1、afterSeq 拒绝。EXPLAIN QUERY PLAN 应走 session/page 与 entries/run 索引，不应扫描整场 entries 来确定一页轮次。订阅者在终态回调内立即 HTTP 查询，核对状态、原因、保存 ID、能力与计量；同时验证错过通知后直接查库可恢复结论。
8. **删除旧实现并独立验收 Server。** 依赖 1–7。逐项执行下表清理；函数级测试走会话创建、连续生成、再生、停止、重连回读、持久故障和重启收尾。滚动摘要用例先通过正式入口准备足够历史轮，再触发压缩，覆盖待答用户与最近五轮保护。更新实际架构约束和服务端文档，执行全套 Server 测试、typecheck 和 lint。验收以 v15 API 为准，生产代码中残留任一替代读写路径，即使测试全绿也未完成。

### 必须删除的旧路径

| 检查面 | 删除项与验证方式 |
| --- | --- |
| 会话域、数据库、Context | 移除 EntryRun / EntryRunPage / EntryRunListOptions、entryRunListSchema、NarrativeOutcome 与其 schema、getNarrativeOutcome、setNarrativeOutcome、listEntryRuns、旧 projectRun 和 entry 上的 appendNarrativeAssistant 写法；清掉旧 Row、Service 导出、SQL 与调用方。保留一个低层 entry 插入实现，业务写入只从受控的受理、摘要和结算入口到达。删除未挂载通用 append-entry 及仅供旧入口使用的公开编辑/追加代码。 |
| 计量与扩展 | 删除 entries.metrics_json 及其查询 listMetrics / latestNarrativeMetrics 的旧实现、entry.metrics、基于 entry 的唯一性检查。摘要及主调用共用请求指标类型，删除 EntryMetrics 的旧导出和别名。检查 SQL、JSON 解码和所有模型 notes，确保没有 ext_data / extData 的 narrative、output 读写或兜底；compaction 的 ext_data.summary、建模用 entries.seq 与真实 tip 仍有现行职责。 |
| 路由、类型与事件 | 删除 afterSeq / beforeSeq 轮次分支、旧 cursor scope、nextAfterSeq / nextBeforeSeq / firstSeq / lastSeq 历史页字段、旧响应 entries、旧再生体、开场 entry 直出和旧 usage 序列化。正式的消息 ID 立绘查询只从当前 Run 取值。HTTP 与 SSE 各只有一套序列化和键集，禁止重复事件、包装旧 DTO 或增加版本开关。 |
| 审计范围 | 在 apps/server 的生产源码、SQL、测试夹具、类型检查夹具、Server 规范和运行文档搜索上述符号，并沿调用链检查改名后的等价逻辑。检查旧列不存在，验证嵌套 JSON 没有隐藏双写；负例、退役说明与有现行业务含义的同名字段分别核对。旧前端中的命中登记给下一阶段，不作为 Server 提供兼容逻辑的依据。 |

### 不兼容契约的负例

- 对受权会话，GET 轮次列表携带旧 afterSeq、原始 beforeSeq、旧 scope/position 的 cursor、未知参数或新旧混传，均为 400 INVALID_REQUEST。旧再生体和“新体加旧字段”也为 400。逐例断言请求没有新建 Run、改动 tip 或发出 run.created。
- 断言已删除的 GET /sessions/:id/history、POST /sessions/:id/entries、PATCH /sessions/:id/entries/:entryId 均未注册。对照有效 v15 详情、立绘与 state API，避免把去除通用写入口误作移除正式读取能力。
- 对 v15 返回值做精确对象键断言，覆盖开场 201 / session.created、受理 202 / run.created、轮次页/详情、run.usage 和终态。页包含新 cursor、活动 ID 和真实 tip；历史中没有旧 entries 和 seq 补读字段。轮状态只来自持久 Run。对同一结算回执参数化检查全部 21 个原因的详情、分页与事件投影；对会话已删除的真实异常路径另断言不会重建孤儿 Run。
- 将 usecases/state.test.ts 与 usecases/narrative/compaction.test.ts 中的 createAppendEntry 夹具改用新写入入口，保留原有关于状态继承、摘要与写锁的断言。不得为测试或旧客户端保留可创建孤儿 entry 的服务入口。

### 回归文件与判定

| 计划文件（相对 apps/server/src） | 操作与覆盖 |
| --- | --- |
| http/narrative-query.test.ts | 修改。替换旧 afterSeq 合法的正例，验证 v15 游标、未知参数与旧格式拒绝。 |
| infrastructure/database/connection.test.ts、testing/architecture.test.ts | 修改。新旧库、CHECK、索引、无新 FK，其他域访问 runs 仍被禁止。 |
| modules/sessions/run.test.ts | 新增。精确原因、能力缺键/空/损坏、请求计量、分页和无孤儿不变量。 |
| modules/sessions/service.test.ts、modules/sessions/character-sprite-output.test.ts | 修改。复用现有条目、计量与立绘回归，验证消息完整性与 run 所有权。 |
| usecases/create-session.test.ts、usecases/narrative/{index,regenerate,write-locks,compaction,postprocess,character-sprite.integration}.test.ts | 修改。真实用例写入、身份隔离、原子结算、摘要费用与提交后事件。 |
| usecases/context/{context,prepare}.test.ts、usecases/context/stages/model-notes/{index,character-sprite}.test.ts、usecases/reply-assist/index.test.ts | 修改。保护轮、摘要复用、最近两条助手、有无输出、资源入模边界和帮答无副作用。 |
| routes/{narrative,character-sprites,sessions-state,worlds}.test.ts、server.test.ts | 修改。开场 HTTP/SSE 同源，公开响应及资源、鉴权、正常关机与持续故障时的 /health、在途鉴权和 SSE、重启、删除、分页、终态可回读。 |
| modules/state/service.test.ts、usecases/state.test.ts、usecases/world-updates/index.test.ts | 修改夹具并回归。父链/作用域读写与升级保留已有轮次。 |

实施验收命令为 `pnpm --filter @sillyrealms/server test`、`pnpm --filter @sillyrealms/server typecheck`、`pnpm --filter @sillyrealms/server lint`。复用函数、内存 SQLite、临时文件数据库及现有路由测试；旧库拒绝、重开和启动收尾使用临时文件数据库。

**Server 完成记录**应包含通过的测试与三条命令结果、退役符号及 SQL 检查结果、旧库/旧请求拒绝结果，以及从测试核对过的开场、分页、再生、计量、终态 HTTP / SSE 样例（随 docs/runtime 交付）。交接时列出 Web 传输、会话历史/立绘/用量和 packages/sr-sdk/src/stage-contract.ts 中的旧消费点。Server 可以独立签收，整站上线需等待下一阶段适配。

## Server v15 执行记录

- Server 的 69 个测试文件、995 条用例通过，`pnpm --filter @sillyrealms/server typecheck` 与 `pnpm --filter @sillyrealms/server lint` 通过。
- SQLite 临时文件覆盖新建、重开、旧版本与损坏结构拒绝、遗留 running/stopping 收尾和重复启动。拒绝旧库后比对文件字节。查询计划覆盖 idx_runs_session_page 和 idx_entries_run。runs 无外键，会话和世界删除测试核对实际清理。
- 真实受理与提交后的读取覆盖成功、部分助手、只有用户的停止、再生、已提交摘要及其计量。连续两轮的模型流测试检查第二轮主请求中三类能力旁注的内容与顺序。21 个停止原因逐一核对持久化回执、详情、页和事件值。
- 从终态订阅者中发起 HTTP 详情查询，回读已提交消息和用量。故障注入覆盖主结算与最小结算连续失败、SSE 关闭、在途鉴权、健康检查与新请求的 503。正常关闭验证终态先于关流。
- 生产路径已移除旧 entry outcome/output、entry 计量列、通用业务追加/编辑、seq 补查与旧 DTO。公开契约测试验证旧参数、旧再生体和跨会话游标均拒绝。实际协议与示例见 [HTTP 契约](../docs/runtime/server-http.md#叙事查询与用量)、[会话事件](../docs/runtime/server-events.md#运行事件契约) 和 [Server 叙事](../docs/runtime/server-narrative.md#消息与计量)。

### 前端交接

Web 的 `transport/session-events.ts`、`features/history/controller.ts`、`features/narrative/controller.ts` 需要消费新的轮次页、单轮详情和执行身份。会话工作区与 `SessionPage.tsx` 对接再生请求及开场回执，`SessionTokenUsage.tsx` 对接整轮计量。建议与立绘控制器改读最新轮的 capabilities，立绘使用结果中的 asset。Host 命令和 `packages/sr-sdk/src/stage-contract.ts` 的作者侧投影由前端重构阶段统一处理。
