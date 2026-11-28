# 首发 Server Run 重构任务

目标契约、示例与取舍见[服务端 Run 实体与消息状态方案](服务端Run实体与消息状态方案.md)。以下目录和任务均为待实施范围。本次交付为这两份计划文件。

## 变更文件目录

同目录下的花括号列出同类文件，标记说明预期操作。继续用 sessions/repository.ts 承担 SQL，sessions/service.ts 是唯一对外模块入口，路由不直接操作数据库。

```text
.
├── AGENTS.md                                           修改 · 根目录首发运行、存储、恢复契约
├── apps/server/
│   ├── AGENTS.md                                       修改 · sessions 表属主、事务、结算和摘要边界
│   ├── eslint.config.mjs                               修改 · 仅为 sessions 的 SQL 白名单增加 runs
│   └── src/
│       ├── server.ts、usecases.ts                       修改 · 启动前收尾、故障处理及装配
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
│       │       ├── stages/assemble/index.ts            修改 · 将已捕获的能力输出交给模型 notes
│       │       └── stages/model-notes/{index,types,state-update,action-suggestions,character-sprite}.ts
│       │                                               修改 · 以已选助手定位其 Run 输出
│       ├── http/narrative-query.ts                     修改 · 轮级 cursor，严格校验参数
│       ├── routes/narrative.ts                         修改 · 分页、详情、命令、会话计量
│       ├── testing/{fixtures,reader-contracts}.ts      修改 · 提供真实有效的轮次夹具及读写边界
│       └── 测试文件（下节列出）                          修改或新增 · 存储、用例、公开接口和故障回归
├── docs/runtime/
│   ├── {server-narrative,server-http,server-events}.md 修改 · 实际实现通过验收后记录公开契约
│   └── {state-v2,local-development}.md                 修改 · 生效状态与轮次结果、新库启动方式
└── deploy/README.md                                    修改 · 首发新数据根、旧库拒绝和回退说明
```

重点复核但可复用当前实现的路径为 usecases/delete-world.ts 和 routes/sessions.ts（都通过 SessionService 清理会话或读取消息）、context/stages/compact/saved-summary.ts（正文 hash）、context/stages/history/index.ts（完整轮边界）、prepare-reply-assist.ts（只读摘要）、usecases/model-outcome.ts（21 个原因映射）、infrastructure/model/collect.ts（原始请求指标）、infrastructure/events/session-events.ts（SSE 传输）。核实原因导出、服务类型、测试装配变动处再改。世界升级保留会话及所有 Run；额外覆盖此路径。

## 实施与验收

1. **冻结用例与值域。** 从现有 Server 事件、HTTP、SDK 拟议稿抽取开场、成功、有部分回复的停止、无回复的停止、再生、摘要六组样例。定义 Run、Message、能力输出、计量与分页 DTO，收敛原始原因枚举到 sessions 模块单一导出。逐项比对 21 个原因在存储解码、详情、列表和事件构造中的相同值；单独保留底层错误到 Server 原因的模型映射测试。完成标志是同一个 assistantEntryId 能贯穿受理、分片和结算，且不可用仅有用户消息来推断停止原因。
2. **落地 v15 和模块读写不变量。** 依赖 1。实现 runs DDL、消息状态约束、SQL 所有权规则。将首轮、普通轮、再生、摘要及结算写入收敛到明确入口；校验归属、角色、tip、当前执行身份和许可。保留低层 SQL 的复用，清除可以单独产出无归属 entry 的业务调用。写最新能力/计量必须以当前数据库值为基准。用全新内存库存取，确认无新 FK、跨会话拒绝、同会话并发最多一个活动轮、回滚不留半条记录。v14 拒绝启动，原文件不变。
3. **开场、发送和重新生成。** 依赖 2。把开场的初始状态、能力结果和首轮一次提交；普通提交把创建 Run 与用户消息一次提交。实现 expectedAssistantEntryId 的再生前置条件，允许 user-only 轮再次生成。覆盖 opening-only、重复提交同 tip、陈旧 tip、同一用户多次失败后迟到的再生、不同会话、延迟停止、旧执行回调和旧助手已删除等情形。再生后的运行中立刻可查空能力、真实 tip 和新身份，旧状态值按实际父链回退。
4. **改造 Context、摘要和模型 notes。** 依赖 2，可与 3 独立开发，集成验收需要 3。摘要与其 Run 计量同事务，提交前复核 tip/source；成功摘要后的主调用失败、取消或再生均保留该摘要。保持裁剪完整轮、待答用户保护、摘要覆盖前缀校验和模型材料授权。以“最新两条助手一条无输出、一条有输出”的样例验证无历史回填。验证主叙事与只读帮答的输入、摘要、材料边界；查询次数不随候选数增加。
5. **原子终态和计量。** 依赖 3、4。将后处理、实际有效状态、完整或部分助手、单个扩展字段、主请求指标和 Run 结论放进一次同步事务。对失败结果和缺键分别做存储往返。校验主调用无正文但有请求指标、未知 token、多次再生共用摘要、缓存分项、请求去重和 latestContext.stale。用故障注入分别卡在写助手、写能力、写终态、发送通知处，验证已回滚的数据不会被对外宣布，提交后的通知失败不能撤销事实。
6. **停止、异常退出与无 FK 清理。** 依赖 3、5。stop 先持久化 stopping；最小失败结算和启动前遗留活动轮收尾均要按身份执行。验证硬退出后只有已提交数据，重启不发送模型请求；停止/终态竞争、重启操作重复执行及新请求均有确定结果。用现有会话及世界删除入口验证锁、生效状态、entries 和 runs 原子清理，其他会话/世界不受影响；旧执行不得重建已删数据。验证写库持续失败时不会放行新生成，也不会向客户端报告已完成。
7. **发布轮次读接口与 SSE。** 依赖 2、5、6。GET 列表和详情复用同一 DTO，一次读快照批量取页内消息；接回会话计量和既有精确消息立绘入口。测试相同时间戳多轮、翻页间新增轮、再生、删除边界轮、非法和跨会话 cursor、无结果/尾页、limit=1、afterSeq 拒绝。EXPLAIN QUERY PLAN 应走 session/page 与 entries/run 索引，不应扫描整场 entries 来确定一页轮次。订阅者在终态回调内立即 HTTP 查询，核对状态、原因、保存 ID、能力与计量；同时验证错过通知后直接查库可恢复结论。
8. **收口与交接。** 依赖 1–7。清除旧分组 SQL、首条 extData.narrative、助手 extData.output、entry.metrics 和 afterSeq 的生产读写路径，更新 Server 和根目录规范。用新库完整执行 Server 的函数级回归、typecheck 与 lint，输出经过验证的 HTTP / SSE 样例给下一阶段。前端需要替换的数据点为 entry 聚合、三桶原因、再生输入、用量事件与旧补读参数；切换前暂缓新旧版本混部署。

### 回归文件与判定

| 计划文件（相对 apps/server/src） | 操作与覆盖 |
| --- | --- |
| infrastructure/database/connection.test.ts、testing/architecture.test.ts | 修改。新旧库、CHECK、索引、无新 FK，其他域访问 runs 仍被禁止。 |
| modules/sessions/run.test.ts | 新增。精确原因、能力缺键/空/损坏、请求计量、分页和无孤儿不变量。 |
| modules/sessions/service.test.ts、modules/sessions/character-sprite-output.test.ts | 修改。复用现有条目、计量与立绘回归，验证消息完整性与 run 所有权。 |
| usecases/create-session.test.ts、usecases/narrative/{index,regenerate,write-locks,compaction,postprocess,character-sprite.integration}.test.ts | 修改。真实用例写入、身份隔离、原子结算、摘要费用与提交后事件。 |
| usecases/context/{context,prepare}.test.ts、usecases/context/stages/model-notes/{index,character-sprite}.test.ts、usecases/reply-assist/index.test.ts | 修改。保护轮、摘要复用、最近两条助手、有无输出、资源入模边界和帮答无副作用。 |
| routes/{narrative,character-sprites,sessions-state,worlds}.test.ts、server.test.ts | 修改。公开响应和资源、鉴权、停止/重启、删除、分页、终态可回读。 |
| modules/state/service.test.ts、usecases/state.test.ts、usecases/world-updates/index.test.ts | 修改夹具并回归。父链/作用域读写与升级保留已有轮次。 |

实施验收命令为 `pnpm --filter @sillyrealms/server test`、`pnpm --filter @sillyrealms/server typecheck`、`pnpm --filter @sillyrealms/server lint`。复用函数、内存 SQLite 和现有路由测试，不需要外部模型调用或另建端到端环境。只有 Server 契约测试通过并发布样例后，才据此修订前端方案。
