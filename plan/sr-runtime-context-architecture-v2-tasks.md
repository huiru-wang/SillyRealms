# SRRuntime 与 Context 架构 v2 实施任务

> 日期：2026-11-13。状态：T0–T9 已实现并完成离线验收，执行记录见第 4 节。
> 主方案：[sr-runtime-context-architecture-v2.md](./sr-runtime-context-architecture-v2.md)。
> 本清单替代双 Runner v1 的任务顺序；叙事扩展 v2 的协议矩阵继续适用。
> 本次修订采用已确认的 `apps/server/src/runtime/` 目标目录和共享存储；首期用模块内函数完成配置、摘要和收尾，不新增独立服务类或策略注册平台。

所有任务由当前单一 Agent 负责执行、验证与复查，不委派子代理。

## 1. 实施顺序

```mermaid
flowchart LR
    T0[T0 基线与契约] --> T1[T1 目录更名与数据边界]
    T1 --> T2[T2 生命周期收尾]
    T1 --> T3[T3 Context 拆分]
    T3 --> T4[T4 当前请求测量]
    T4 --> T5[T5 摘要预算闭环]
    T2 --> T6[T6 双 Runner 集成]
    T5 --> T6
    T6 --> T7[T7 存储与公开契约]
    T7 --> T8[T8 UI 与兼容切换]
    T8 --> T9[T9 综合验收]
```

T2 与 T3 在契约稳定后依次处理，公共 types/Runtime 文件统一整合；未授权时不自动启动实现。T4 的 Provider/计数可行性验证前置到 T0，避免外围完成才发现主用路径不可用。

## 2. 任务定义

### T0：核对现状并锁定架构契约

- [x] 核对仓库、工作区、schema 版本、当前政策及消费者。
- [x] 固定 RuntimeConfig / ExecutionContext 字段与各模块写权限；PreparedRequest 为派生值。
- [x] 确认 Direct/Agent 共用 ContextManager、ModelClient、RunStore、UsageStore；不拆表、不新增 runs 表或按模式复制存储服务。
- [x] 固定模式迁移、Direct/Agent 停止政策、摘要持久化时机与公开恢复映射。
- [x] 在目标模型路径验证实际 payload 顺序及可用计数/估算方法，记录 exact/estimated/unknown 边界。
- [x] 固定窗口档位与压缩算法分离、unknown 行为、有界默认及新旧预算政策切换条件。
- [x] 固定摘要输入比例 R、独立输出上限和模型硬上限的关系；0.75 仅为待验证初始候选，不作为已经通过验证的默认。

验收：存在可执行的测量与适配路线；未解决问题明确记录，不用虚假兼容标志或字符/token 混用蒙混通过。目标变更与当前行为明确区分。

### T1：目标目录迁移、更名与两类运行数据

- [x] 先做独立机械变更：src/agent → src/runtime，AgentRuntime → SRRuntime，按方案第 11 节放置 runners/context/model/persistence/tools/narrative/shared。
- [x] 更新导出、app、路由、database 的 UsageStore 导入和全部直接导入测试；不在目录迁移中修改预算或提交语义。
- [x] 机械变更回归通过后，再调整下面的数据与配置边界。
- [x] 从 PreparedRun 拆出冻结配置与执行上下文，收拢现有 RunContext 计时/请求身份。
- [x] SRRuntime 通过现有读取方法取得配置，由 config.ts 普通函数合并/校验并冻结；不创建 ConfigResolver 类，移除 ContextManager 中与内容构建无关的配置重读。
- [x] 凭据仅保留引用，实际 key 留在调用局部；服务依赖不放进数据对象。

主要文件：旧 agent 目录及其导入消费者；目标 runtime/index.ts、sr-runtime.ts、types.ts、config.ts，app、routes、infrastructure/database/database.ts 和相关测试。

验收：保持旧 Agent 与预算行为；冻结后预设变化不影响本轮；原有 runtime/usage 回归通过；无明文凭据进入快照。

### T2：统一生命周期与最终化

- [x] AgentRunner 返回结果，移出最终化、Usage 收尾、终态通知和 release 调用权。
- [x] SRRuntime.finishRun 私有方法统一协调共享 RunStore、用量结算和终态通知；准备异常、执行异常均有唯一收敛路径，不创建 RunFinalizer 类。
- [x] 明确 Direct/Agent 提交政策，保留 Agent stopped/failed 现有差异。
- [x] 确认事务后通知失败不改写已提交结果，所有路径释放锁；Usage journal 幂等。
- [x] 暂保留 RunPostProcessor 包装，由 finishRun 调用；不为两个 Runner 各写一套结算，也不扩展成结束钩子框架。

主要文件：runtime/sr-runtime.ts、runners/agent-runner.ts、persistence/run-store.ts、usage-store.ts、run-post-processor.ts。

验收：取消、去重、tip 冲突、同世界互斥、数据库失败、重复最终化均回归通过。Runtime 不包含 SQL、工具执行或模型调用代码。

### T3：建立 Context 内部职责边界

- [x] 在共享 ContextManager 内组织来源/激活、模式编排、预算评估与压缩，复用现有函数，不为每项创建服务类。
- [x] 抽取现有上一轮 Usage 政策作内部兼容实现，保留回归证据。
- [x] 以来源映射、保护规则和固定激活权限形成 ContextDraft。
- [x] 直接调用 history-compactor.ts 压缩函数，限定输入与候选输出，验证保护内容和覆盖边界；首期只有 summarize_history，不创建 ContextStrategy 接口/注册表或 SummaryService。
- [x] 两种模式都经过统一首次准备；Agent 续轮复用同一 ContextManager，Direct 不复制上下文或压缩代码。
- [x] 明确模型请求与工具 schema 的计数入口，避免工具注入发生在测量之后。

主要文件：runtime/context/context-manager.ts、prompt-builder.ts、activation.ts、history-compactor.ts、budget.ts。

验收：模块拆分不改变旧策略结果；压缩不能扩大状态权限、改写配置、写状态或调用任意工具。

### T4：实现当前请求测量与预算评估

- [x] 在 budget.ts 中实现测量/判断函数及 method/quality/version/fingerprint 报告，至少支持目标主用适配路径；不新增 TokenMeter/BudgetEvaluator 服务类。
- [x] 覆盖编排后的 messages、tools、当前输入、平台协议与序列化开销；未知内容返回 unknown。
- [x] 实现 `input + output reserve + safety <= effective window`，不重复扣旧 2048 输入预留。
- [x] 构建不可变 PreparedRequest，发送前校验 fingerprint；任何追加内容重新测量。
- [x] 使用 mock transport 比较测量对象与实际 payload，解释无法精确计数的部分。
- [x] 估算报告独立于真实 Usage；首期不增加计数缓存，若以后需要缓存，必须按模型/适配/请求内容区分。

主要文件：context/budget、model/model-client、model/pi-gateway 的最小测量接缝、usage-store 的诊断投影。

验收：边界值、中文/emoji、工具 schema、变更模型/模式、当前输入突增、unknown 均有测试；不新增每轮网络计数调用；不伪造 token 精度。

### T5：实现摘要策略的预算闭环

- [x] 完整请求超预算后应用 summarize_history，再重建并重测。
- [x] 最近五轮、当前输入、平台约束和状态权限受保护；无法调整则明确失败。
- [x] 摘要每个分块计入旧摘要、指令、包装及输出预留；字符限制仅作辅助保护。
- [x] 实现 `summaryInputLimit = min(floor(W * R), W - O - S)`，校验有限的 `0 < R <= 1` 及模型输出上限；扣除固定内容选择片段后，重测完整请求。
- [x] 摘要输入比例与摘要输出压缩比例分开；75% 仅为初始候选，比例与输出上限先留内部配置，不新增必填 UI 设置。
- [x] 禁止摘要递归触发压缩；正常 stop、非空、取消及调用额度均检查。
- [x] 检测无进展，限制变换次数和全 Run 摘要调用数；不中途提交覆盖边界。
- [x] 摘要传递 stopped/failed/partial 的受控元数据，跨再摘要保留有界缺口摘要。

主要文件：runtime/context/history-compactor.ts、budget.ts、context-manager.ts、system-main.ts 摘要说明。

验收：覆盖比例为 0/负数/大于 1/非有限数、输出额度过大、固定内容耗尽预算和模型窗口小于配置窗口；压缩后仍超限不发送生成；摘要非正常结束不当作成功；保留原始历史；已发生 Usage 如实结算；既有摘要覆盖边界可验证。

### T6：集成 Direct 与 Agent 两种 Runner

- [x] Direct 执行一次 generation，接入叙事扩展 v2 splitter/parser/状态与建议处理器。
- [x] Agent 每次 continuation 都重新准备 Context；当前工具往返不被净叙事过滤或拆散。
- [x] 模式判别类型阻止 Direct 接收 tools/toolChoice；异常工具调用不执行、不切换模式。
- [x] 区分权威基准与候选 workspace；本轮权限固定，策略不可改变。
- [x] 接入初始/续轮摘要候选的不同持久时机，续轮候选仅覆盖当前 Run 之前历史。
- [x] Direct 和 Agent 使用同一 ModelClient 与计费 journal，summary/generation/continuation 分开记录。
- [x] 两个 Runner 通过同一 RunStore 保存正文/工具等记录，返回结果后统一 finishRun；请求用量仅由 ModelClient 写入共享 UsageStore。
- [x] narrative 只做正文/尾块分割、严格解析及候选处理；不调用模型、工具或数据库，状态校验复用领域逻辑。

主要文件：runtime/runners/direct-runner.ts、agent-runner.ts、runtime/sr-runtime.ts、narrative/、tools/tool-executor.ts、persistence/run-store.ts。

验收：Direct 一次生成、Agent 工具循环；大工具结果在下一请求前失败；无孤立 toolResult；模式对应停止/提交政策及 v2 失败矩阵通过。

### T7：存储、恢复与公开契约

- [x] 增量存储会话模式、必要配置快照/预算报告及摘要缺口信息，保留所有用户数据。
- [x] 复用 sessions/entries、ext_data、state、metrics_json/usage_json；不按模式拆表、不新增 Direct/Agent 专属 Store。
- [x] 按来源版本回填 mode；预算新旧字段兼容，冲突明确拒绝，重复启动不重置。
- [x] 查询/历史/终态使用统一投影；旧 Run 缺字段保持缺省。
- [x] session GET 的 activeRun 摘要覆盖 preparing；重启 interrupted 对外映射并结束 pending。
- [x] SDK/Host/frame 透传模式与受控结果，phase 显式订阅且终态优先。
- [x] 凭据、原始 payload、reason 不进入公共 DTO；estimated 不显示为真实 Usage。

主要文件：database、sessions/session-runtime、history-runs、SDK run-contract/session-runtime/story-history、host/frame。

验收：临时库迁移、刷新/断线恢复、事务前后崩溃、重复请求、摘要候选丢弃与用量恢复均通过。

### T8：UI、模式选择与预算政策切换

- [x] 会话 Direct/Agent 选择，busy 禁止切换，异步校验后写入前重查 busy。
- [x] 新会话默认 Direct，旧会话按来源版本保持模式；不支持的 Provider 明确提示，不自动降级。
- [x] 区分“上下文窗口档位”与“超限处理策略”，初期只展示已支持的摘要策略；不把内部参数全部暴露成设置项。
- [x] 区分准备/压缩、生成、扩展处理的用户提示；预算无法满足给出可操作错误。
- [x] Direct 的状态/建议设置在 Agent 中标明不适用；建议草稿/撤销/失效遵守 v2 与当前模式。
- [x] 两种 preset 布局解释、历史兼容 warnings 按模式表达。

主要文件：SessionSettingsDialog、PresetPage、PresetLibraryPage、Host、WorldStory、usage panel 相关消费者。

验收：375px/1280px 核心流程、键盘操作、错误/加载状态、跨模式与刷新草稿保护通过；target current_request 不静默回退兼容政策。

### T9：全链路验收与文档同步

- [x] 双模式、预算边界、摘要、迁移、终态/恢复和真实计费语义联合回归。
- [x] 更新 AGENTS.md 中预算现状和 Runtime 名称，技术状态、API/SDK、数据契约与新架构决策记录。
- [x] 同步叙事扩展 v2 的 Runtime/Runner 名称及新预算适用范围；历史 v1 保留历史标记。
- [x] 复查，修复阻断问题后按影响重新验证。

验收：核心路径无阻断缺陷；支持的计数/适配范围、估算局限和未实现扩展明确。提交、推送、真实迁移、付费模型验证需另有授权。

## 3. 验证矩阵与命令

| 领域 | 重点 |
|---|---|
| 当前测量 | 上次小、本次大；完整请求、工具 schema、缓存失效与未知计数 |
| 预算数学 | 窗口取小值、输出上限、余量、当前输入不重复扣除 |
| 变换闭环 | 超限、重测、无进展、受保护内容、有限次数 |
| 摘要 | 输入比例与硬上限取小值、非法比例、旧摘要累积、分块、正常结束、取消、无递归 |
| Agent | 每次续轮预算、工具调用/结果完整性、当前轮无法压缩 |
| 权限 | 压缩不改变激活权限；Skill/Tool 不绕过 mode 或预算 |
| 状态与持久化 | Direct/Agent 不同提交政策；初始/续轮摘要时机、tip 与原子性 |
| 共享实现 | 同一 ContextManager/RunStore/UsageStore，公共历史投影，跨模式查询，无重复计费或提交 |
| Usage | summary 独立、真实用量幂等、估算不计费、unknown 非零伪造 |
| API/SDK | mode/结果投影一致、preparing恢复、终态不回退、敏感数据不泄漏 |
| 数据保护 | 临时库非破坏性迁移、版本分流、原文件哈希和历史保留 |

实施前检查 scripts；完整变更后运行：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:browser
```

根 test/lint 主要覆盖 Server，build 为 Web；须确认新增 SDK/Host 测试被实际入口发现。优先扩展 context/summary/usage/runtime/pi-poc/history-runs/sdk-session-runtime/story-history 与现有 Host/browser 测试。所有自动化使用 fake provider、mock transport 和临时数据库。

下列执行记录对应实际实现与验证；未恢复历史删除的决策文件，仅新增本次日期的决策记录。未清理或升级真实用户数据。

## 4. 2026-11-13 执行与验收记录

实施基线为 `f25d452`（工作区初始干净）。完成 `src/agent → src/runtime`、SRRuntime/双 Runner、冻结配置、共享 Context/Model/Store、当前请求测量、独立预算摘要、Direct 扩展、增量迁移、公开投影及 UI。无 ConfigResolver/SummaryService/RunFinalizer 类或 runs/模式分表。

### 已执行检查

| 命令/检查 | 结果 |
|---|---|
| `pnpm typecheck` | Server 与 Web 通过 |
| `pnpm lint` | Server src/test 通过 |
| `pnpm test` | 43 个文件，205 项通过 |
| 末次日志脱敏影响回归 | context/activation 11 项通过 |
| `pnpm build` | 通过；保留 Vite >500kB 分包提示 |
| `pnpm test:browser` | Composer、Host、runtime-v2、200 消息字体回归整套通过 |
| 末次 runtime-v2 浏览器回归 | 26 项断言通过，含当前/下一轮配置分离与跨会话握手 |
| `git diff --check` | 通过 |
| 视觉验收 | 已查看 375px/1280px 的故事与设置实际截图 |

测试使用隔离内存/临时 SQLite、独立测试 Keychain、fake Provider 与离线 mock transport；没有真实付费模型请求。Provider payload 测试不是线上端点验收。

### 关键回归证据

- Direct 正常路径恰好一次 generation，不含 tools/tool_choice；隐藏尾块不进入公开正文。Unicode 分片、字节上限、重复 JSON key、正常/异常结束与失败矩阵通过。
- 真实 SDK payload 保持 Direct 的历史后 system 与末尾单次 user；发送 fingerprint 与预览一致，变更拒绝。中文/emoji 使用真实官方 BPE，未知及非法计量拒绝。
- 六个摘要生命周期集成用例验证初始摘要/user 原子提交及回滚；续轮候选在请求期间不落库；completed/failed 保存合格摘要、stopped 丢弃；Agent stopped 保存合法状态、failed 不保存；第九次摘要调用在发送前拒绝，前八次真实 fake Usage 不丢失。
- 临时 v1 库升级前备份，历史/引用/源内容保留；已有模式不重置；失败事务回滚；不支持版本拒绝；interrupted 公开映射及用量恢复通过。
- GET/历史/终态采用统一公开投影，SDK phase 显式订阅、终态优先；准备/已结束断线恢复保留草稿。
- 模式 busy 限制与异步校验后的重查通过；运行中能力保存只影响下一轮。界面显示本轮冻结快照和下一轮设置。
- 建议仅填入草稿，可撤销；编辑后撤销失效，新 Run 后旧建议禁用。iframe 初始监听提前安装，切换会话按 nonce 重挂载，安全边界未放宽。

### 复查后修复

修复了模型最终文本与分片一致性/Unicode hash、凭据读取取消、Usage 关联失败隔离、重复最终化通知、摘要异常终态、准备期重启恢复和会话切换握手。日志只记录受控元数据，激活关键词与 when 原文不输出。

视觉复查发现建议按钮文字偏淡，已改用正文色；字号改变时的中部/底部锚点已通过实际 iframe 回归。设置在两种视口内可滚动，Escape/保存/撤销流程通过。浏览器测试将目标页置前并等待真实响应式 DOM 状态，避免固定延时造成误判；必须完整收集全部断言。

### 支持边界与交接

当前生产计量只支持官方 DeepSeek V4.1 Flash 文本适配；BPE 加包装预留为 estimated，其他模型明确失败。R=0.75 经离线预算边界验证，但未经过真实模型质量/成本调优。独立角色提及 Hook、通用 Skill 平台、多 Provider 计量与 SSE 持久重放未纳入本次架构实现。

已同步 `AGENTS.md`、`docs/technical/runtime-context-v2.md`、`docs/technical/context-compaction.md`、`docs/data-formats/runtime-v2-contract.md` 及 `docs/decisions/2026-11-13-runtime-context-v2.md`。旧 v1 资料保留历史标记。

未提交、推送、部署或升级真实用户数据库。为避免开发期间自动迁移，原监听源码的服务已停止，保持停止状态。后续执行 `pnpm dev` 启用新版时，v1 磁盘库将先创建一致性备份再做 v2 增量升级；回滚流程见公开存储契约。
