# Server

- 预设严格模式与世界卡宽容模式共用 Server 纯语法模块。只在候选组装时展开原始角色 prompt、世界书 content 和预设节点；状态字段仅读捕获的 tip 三域视图及当前候选可见根，不改变 message 写授权、不再次解析填入值。世界卡导入不验证提示词变量。

- 本期在 modules/usecases 管理能力上实施叙事首版：SDK 无关模型流、可选一次滚动摘要或滑动窗口裁剪（pi 适配实现）、核心提示词编译、统一 SSE、提交/停止、消息独立持久化、目录和连通性检测。通过 narrative/postprocess 实施模型输出的 message 状态更新与行动建议；不设计 runtime、engine、通用任务、Agent/tool loop 或执行恢复。Web 已按现有叙事与 state 契约接入独立运行页及 Stage SDK。
- 单域操作采用 `route → service → repository`；应用流程采用 `route → usecase → service → repository`。route 可以调用读写能力，跨模块只读展示投影可在 route 组合；跨模块写编排必须进入 usecases。route 不写 SQL、不管理事务。
- 业务模块统一位于 `modules/<name>`，以 `service.ts` 为唯一公开出口。Repository、存储 Row、schema、parser、validation、assets、archive、card、default、files 均为内部实现；公开领域类型从 service 显式 export type，不使用 export *。启动 services.ts/usecases.ts 显式装配依赖。
- Service 承担本域规则和持久化能力。跨模块只依赖显式 Reader 类型并调用其只读能力，服务本域校验与计算；不依赖对方完整 Service 或调用写能力。模块不能反向依赖 usecases、routes、http 或启动装配，不得循环依赖。
- usecases 是完整应用流程层：跨模块写入必须在这里；需要管理多步骤/资源生命周期的单域导入导出也可放这里。用例只调用模块公开 Service，禁止直接导入模块内部文件、写 SQL、打开或关闭数据库。
- Service 公共输入输出采用显式驼峰领域类型，存储行到领域对象的映射在 Service；Repository 负责存储 JSON 编解码并返回模块私有记录。不递归改名作者 JSON、状态键或正式文档协议。
- Repository 仅由本模块 Service 使用，不依赖任何 Service、其他模块 Repository 或 usecase。SQL 包括查询/JOIN/存在性检查只碰本模块属主表或列：presets→presets，models→api_model_configs，settings→app_settings，worlds→worlds/world_tags，sessions→sessions/entries。
- State 无表、无 Repository，StateService 负责 scope 读取、消息前驱继承、目标根校验及字段更新候选快照，不执行持久化或事务。完整 scope 和字段写入由 set-state 用例调用 World/Session Service；PATCH 的每项读取、计算及写入分别处于独立同步事务。worlds.state、sessions.state、entries.state 的 SQL 始终归表属主。普通内容更新不能覆盖运行 state。内部 getViews/evaluateWhen 继续用于叙事，不提供聚合 views HTTP。
- 连接由启动方创建和关闭，所有 Repository 借用同一连接；Service 仅在构造时把连接传给私有 Repository，不保留连接、不写 SQL、不执行事务。usecase 只接收装配方绑定好的 TransactionRunner，不接收原始连接。
- database、cache、events、model 契约与 pi 适配统一位于 infrastructure。业务和路由仅依赖 infrastructure/model 自有 ModelClient/消息/目录/用量/原因类型；SDK 导入限于 infrastructure/pi，具体 PiClient 仅在装配选择。pi/model 不反向依赖 modules/usecases/HTTP/数据库/EventHub。ESLint 同时约束 SDK 类型泄漏和具体适配器依赖。
- 叙事校验后立即保存 user，模型准备或生成失败不回滚。assistant 的 content/reasoning_content/tool_calls 完整或部分公开快照独立保存，只有推理或工具请求也保留；完全没有公开内容不造空助手。历史仅投影可见正文，不把推理/工具参数用于提示词或材料激活。两条消息无整体事务；单条 appendEntry/seq/tip 原子推进不变，迟到输出丢弃，正常关机先结算再关库。
- 跨模块写入及跨模块事务边界归 usecases；本域必要的多条 SQL 原子操作留在 Repository，例如世界内容+标签、entry追加+tip推进。database 负责 DDL/结构事务，显式维护 updated_at，不新增触发器。
- infrastructure/database/transaction.ts 的回调必须同步，不接受 Promise。事务中不做文件/网络/模型调用；文件与 DB 用暂存、发布、清理/补偿协调，不宣称强原子性。代表提交成功的事件在成功提交后发布。
- openDatabase 只建立/检查结构，不播种业务数据。每次启动装配后、监听 HTTP 前调用 initialize，在同一同步事务内按稳定 ID ensureDefault，再 settings.ensure。缺失的内置预设或设置记录自动补齐；已有内置预设内容、revision、用户默认选择和显式 null 均保持原值，重复启动不更新它们。恢复预设沿用名称避重规则，失败整体回滚重试。不创建虚假模型或凭据，也没有前端初始化向导。
- 本期只支持线性叙事存储：appendEntry 只能接当前 tip，显式 parent 不匹配时报错；追加、seq 分配与 tip 推进原子完成。不提供 setTip；内部 getHistory 只读取当前线性历史供 context 使用。GET /sessions/:id/history 已删除，HTTP 消息历史只使用 narrative/runs。写入只校验当前 tip，模型上下文按 seq 范围一次读取，消息状态按会话和 seq 取最近非 NULL 快照。
- 正文、历史关系、state、metrics 分别写入明确字段，禁止整行覆盖。state HTTP 统一前缀 /api/v1/state，仅提供 /global/:worldId、/session/:sessionId、/message/:sessionId/:entryId 各 GET/PATCH/PUT；旧 worlds/sessions 的 state 子路径删除，不保留别名。PUT/set 保存完整 scope 快照；消息 NULL 继承前驱，显式空数组终止继承。PATCH 接收 updates:[{path,value}]，按输入顺序独立处理：只替换已存在的根或对象点分路径，缺失路径成功忽略，不创建节点；数组整体替换。沿用共享 state-validation 的定义与值校验，不检查 rules 覆盖，只检查受影响根，不校验整个 scope。缺失路径及未变化值均不写库；消息继承值仅在实际变更时保存为指定条目的独立快照。StateWriteResult 逐项返回 success/errorCode/errorMessage 与可选字段诊断。
- 仅开放已实现校验的预设类型，类型与配置统一在 PresetService 校验；引用通过 Reader.require 和数据库外键保证，不恢复 assertNarrativePreset。默认模板与导入导出协议属于 presets 内部领域知识；凭据字节不进入模型配置表。
- 世界导入保留原始字节，不依赖上传原名；JSON/ZIP 验证卡和资源后发布，失败按明确阶段清理。导出由 DB 当前世界卡、当前标签与 package/ 当前资源构建，名称为当前 world.name.zip，原件不参与重建。卡协议与静态状态定义校验属于 worlds；state 定义、类型和 rules 校验复用既有共享 state-validation。rules 是可选的自然语言说明，导入或编辑定义时仅检查提供的路径与非空文本，不要求根或子字段覆盖。Prompt 组装不再校验规则格式；没有条目时省略规则段。
- worlds 内部按职责组织：parser 负责 JSON 解析、领域转换和初始值提取；validation 集中卡结构、引用、状态定义及 when 静态校验；assets 负责资源读取与完整性；archive 负责导入包和 ZIP 解压/构建；files 负责磁盘生命周期。parser/validation 不读文件，assets 不处理 ZIP，archive 复用解析与校验，不重复定义协议；这些实现仍只通过 service.ts 对外提供能力。
- 包内文件 HTTP 入口为 `/api/v1/worlds/:id/resources/*`，相对于磁盘 package/ 根目录，保留 assets/、components/ 等目录前缀；不能将其缩减为仅素材读取。存储目录和路径安全规则独立于路由名称。
- 世界管理删除由 delete-world 用例编排：有关联会话且未传 deleteSessions=true 时返回 WORLD_HAS_SESSIONS/409，并提示数量及删除后果；确认后在同一同步事务删除全部关联会话/消息与世界记录，复用会话运行写锁，任一步失败整体回滚。配置会话访问适配器时先授权全部关联会话，授权异步等待后在事务内拒绝任何未授权的新会话。提交后清理整个世界目录；文件失败报告 WORLD_FILES_DELETE_FAILED，重试允许清理 DB 已不存在的残留目录，不做 DB/文件强事务。原件写入/发布/删除按世界串行，路径校验拒绝不安全根目录和符号链接逃逸。
- 事件连接独立于业务执行，只负责传输；不得查询数据库或判断终态。SSE data 均为 JSON：run.created/run.summarizing/run.summarized/run.delta/run.usage/run.completed/run.stopped；失败统一 stop_reason，不含 error 对象/errorCode/errorMessage、不发裸 [DONE]。每个 accepted run 保存结算后只发一次总 usage 再唯一终态；无参与计量的调用为零、参与计量的任一次调用未知为 null；失败/中断摘要不保存记录也不计量。delta 定稿 snapshot 明确 replace，模型 finish 不等于 run 保存成功；终态带 savedMessageIds/tipEntryId。system/tool result 只预留类型，不生产；有效行动建议通过 action_suggestions.created 发布。state.changed 保持 state 模块公开的 {path,scope,value} 契约，由 set-state/append-entry/narrative 用例在实际变更成功提交后发布；PATCH 逐项提交后通知，再处理下一项。global 经 SessionService 查询全部所属会话广播；session/message 仅发所属会话。message 比较当前 tip 的有效继承对象，历史修改被后继快照覆盖则不发；PUT 或独立快照追加使用 path:"" 表示完整 scope 替换，{} 清空，null 是字段值而非删除。空 path 不对 PATCH 输入开放。读取、初始化、同值、缺失路径忽略、失败及回滚不通知。StateService 只计算变化，EventHub 不查库；新增改变状态的业务流程必须经用例编排提交后发布。叙事 null 状态追加不改变有效视图。SSE 传输入口仍属于 events 基建。
- 会话终态不关闭 SSE；断开只取消订阅。事件不持久化或回放，仅 event/data，无 SSE id。传输用 pull 保序分块，控制器缓冲 256 KiB、总未读预算 8 MiB，超限只关闭慢订阅，不阻塞执行或其他连接。
- 会话路由先经 SessionService 检查真实会话，再执行可选 canAccessSession；等待后先检查关闭信号，再确认会话仍存在。访问适配器不能代替会话存在性检查。
- 普通 HTTP 统一 `{ success, errorCode, errorMessage, data }`，错误集中 errors.ts 映射并保留正确状态码；未知异常不泄漏 SQL、路径或堆栈。SSE/文件下载保留原始正文，传输开始前错误仍用 JSON 失败包络。
- routes 使用 http/response.ts，HTTP 正文/query/游标处理留在传输层，业务校验留在 Service。跨模块列表/详情展示投影由 route 调公开 Service 组合。接口契约见 `../../docs/runtime/server-http.md`。
- V2 使用独立数据根目录和数据库，user_version=4；只迁移结构匹配的 V2 v1–v3 库，依次添加预设 revision、世界 revision、导入时间索引和消息状态快照索引，不自动改造/清空旧 Server 库，不导入旧 Server 的建表、恢复或执行逻辑。现有 V2 设置记录保留原值；缺失的 V2 内置预设与设置由启动 initialize 幂等补齐，不导入旧 Server 数据。
- 本轮仅做函数级测试、typecheck、lint，不启动真实服务或执行 HTTP/浏览器链路验证。函数测试使用内存或临时库、临时文件以及最小凭据替身，不访问真实 Keychain；架构测试检查入口/层级/SQL属主，类型测试检查 Reader 不具有写方法。关闭 HTTP/SSE 后再关库。

## 运行写入锁

- services.ts 为一个应用装配唯一 infrastructure/cache/RuntimeCache，SessionService、WorldService、set-state 与 narrative 共享此实例；只使用单进程内存锁，无额外存储或分布式协议。
- run 在用户持久化前 acquireRun，覆盖上下文/摘要/模型/后处理/结束结果；用户保存失败立即释放，结算后在通知前释放，finally 再按持有者身份幂等释放，不得解锁新 run。
- 会话修改、删除、普通追加、正文/扩展/计量/结束结果写入在 SessionService 拦截，返回 SESSION_WRITE_LOCKED/409。session/message state 及同一世界任何 run 活跃期间的 global state 写入返回 STATE_WRITE_LOCKED/409；set-state 对空 PATCH、同值、缺失路径也先拦截，每项事务前重查锁。
- 只有内部 run 持有的对象身份 permit 可追加本轮用户/摘要/助手和记录结束结果；不在 API、事件、AsyncLocalStorage 或 SDK 传播此权限。读取、SSE 与 stop 不受写锁阻断，其他会话的独立状态及其他世界不受影响。

## Web 管理接口

- 当前接入世界内容库、预设、模型配置、设置及基础会话。预设 CRUD 使用驼峰领域 config；文件导入导出协议由 presets codec 独立转换。列表返回摘要，详情按需加载；PATCH 必须带 expectedRevision，通过 Repository CAS 更新并递增 revision。
- 模型目录由 infrastructure/pi 读取固定版本 SDK，按 provider 分组；公开 contextWindow/maxTokens/reasoning/thinkingLevelMap/thinkingLevels/api/input/promptCache 等安全元数据。有效思考档位使用 SDK helper；缓存保留时长为 SDK 最佳估计秒数，缺失用 null，不推断实际支持或保留承诺。不返回 SDK headers/baseUrl 或密钥。
- 预设采样字段在文件和存储间共用显式映射。主叙事与摘要使用同一轮快照中的 modelParameters，Pi 根据真实路由和有效模式逐项过滤。缺省不覆盖，显式零保留；能力未知或越出模型范围只忽略该项，不通过 onPayload 改写请求。
- credentials 独立管理外部密钥存储，models 表只保存 credentialRef。model-config 用例协调写入、补偿和删除清理，按模型串行，不在 SQLite 事务内等待外部存储；HTTP 不接收引用或返回密钥，状态不冒充模型连通性验证。
- 默认凭据适配器是 macOS Keychain，引用按 V2 dataRoot 隔离；不复用旧 Server 凭据命名空间，不增加明文降级存储。跨资源补偿不等于崩溃原子性。
- 会话创建经 create-session 用例：要求 openingId，验证世界中的开局与可扮演角色，明确预设/模型引用；同一同步事务初始化 session/message 状态并保存首条 assistant entry、完成结果与 tip。首条消息的 output 按最终 message 快照逐根记录成功更新，行动建议为空。global 保持当前值，opening.initial_state 只整项替换 message 根；正文将全部 {{user}} 一次性替换为角色名。不执行组件/模型，不新增表或 kind/origin。成功仅发布 session.created，data 为 {sessionId,tipEntryId,timestamp,entry}，不发 run.* 或 state.changed。POST 返回 data:{item,entry}，GET 仍为 data.item。更新不允许改变 worldId/userCharacterId，已有会话不自动补写。初始化直接调用属主服务，不嵌套会发布事件的写用例。

- 世界列表直接读取摘要并批量取标签，以 createdAt/id 游标分页；管理 PATCH 只接受名称、标签、默认配置及 expectedRevision，CAS 原子更新，不重写作者内容或运行状态。HTTP 不开放 POST /worlds 或作者内容编辑。
- 组件读取复用 worlds/assets，path 优先且失败不回退 inline；按组件返回错误。API Origin 校验只信任服务同源和配置的 Web 来源，跨来源仅允许资源 GET/HEAD；这不是用户认证。

- HTTP multipart 从适配器提供的 headers/body 流解析并限制实际字节数；不能将 Node 适配器的轻量 Request 直接交给原生 new Request 克隆。保持超限与格式错误的独立错误码。

## Narrative 查询与部署配置

- 叙事提交、停止、查询与用量统一在 /api/v1/sessions/:id/narrative；旧 /runs 路径不保留别名。SSE 仍为 /sessions/:id/events；不新增 narrative/events 或 capabilities，提交响应不带 capabilities。
- runs 列表每页 1–5 轮，默认 5 轮。历史 cursor 按每轮首 entry.seq 倒序；afterSeq 按最后 entry.seq 升序查询受影响完整轮次。Repository SQL 仅操作本域 entries，不新增 runs 表。返回 nextCursor/nextAfterSeq/activeRunId；流式正文由会话 SSE 推送。
- 每个 run 首条 entry.extData.narrative 保存 completed+finishedAt，或 stopped+stopReason+finishedAt。助手保存后写结束结果，再发 usage/终态；失败保留消息，无结束记录且不活跃返回 unknown。通用 entry 编辑不能传入/删除 narrative，写结果保留其他扩展。该字段不是恢复日志，running 只在内存中。
- metrics.requests 移除 status，增加 provider（新记录为实际 providerId，旧数据未知为 null）。读旧 JSON 丢弃 status，不猜测供应商、不批量迁移；新写入严格校验。usage 汇总已记录的已知 token 并报告未知请求数，不写累计账本；latestContext 只投影最新已保存的主叙事 assistant 请求。metrics.context 保存 requestId、apiModelConfigId、真实 contextWindowTokens 与编译 contextComposition 字节数，摘要不附加该快照。未知输入为 null，旧无快照不推断窗口或组成；模型配置/模型变化或脱离当前父链标记 stale。
- /api/v1/runtime/config 返回隔离舞台的公开 origin/entryPath 与 debug，不重复 port。stageOrigin/debug 由装配提供，CLI 使用 SERVER_STAGE_ORIGIN/SERVER_DEBUG；不与 Web 同源，不允许 HTTPS 降级，不新增监听进程。

## 上下文整理

- 上下文独立于 narrative，外部只经 usecases/context/index.ts 使用 prepareContext 和显式公开类型。业务输入只有 sessionId，signal/permit/progress 仅用于执行控制；不接收调用类型、runId、userEntryId、previousTipEntryId 或输入文本，也不保存用户消息。首次异步等待前同步捕获 session 的世界、预设、模型配置、完整历史和实际 tip 状态；prepareContext 完成准备并返回最终请求、激活状态根、后续 parentEntryId、已保存摘要回执及准备失败信息。外层 narrative 保留用户保存、会话运行锁、主模型、后处理和最终结算。
- context/prepare.ts 组合阶段并经公开 SessionService 保存成功摘要；stages/compact 完成纯计划、旧摘要复用、必要摘要调用和最终候选复核，不写库、不认识 EventHub/SSE 或 run 终态。摘要通过窄端口调用；上下文进度 summary_started/summary_saved 由外层映射到 run.summarizing/run.summarized。PreparedContext 使用 ok/request 或 ok/failure.code，均携带 parentEntryId（捕获的实际 tip 或新摘要 ID；空会话/捕获前失败为 null）及可选摘要回执；凭据字节只在本轮 narrative 闭包内复用，不进入返回值。模型流收集、取消和原始调用指标归 infrastructure/model/collect.ts，不能依赖业务模块或叙事输出分离。
- 每个压缩候选重新投影干净历史、激活材料、选择保留条目的旁注、组装实际模型消息并估算。不得假定估算随裁剪单调下降，不沿用初始候选的 activeRoots，不在估算后偷偷追加旁注。candidate.ts 组合场景候选评估，assemble 产出可直接调用模型的消息；lib 仅放模板、估算、预算计算。
- 输入硬预算 min(preset.maxContextTokens, model.contextWindow-maxOutputTokens-1024)，软目标 60%。sliding_window 只裁剪完整 run；rolling_summary 保护最近 5 个历史 run，末尾普通消息为 user 时额外保护该完整 run，每次构建最多一次摘要。候选包含完整 entries，按自身消息顺序映射变量：仅尾部普通 user 移至 input.text；assistant 尾部（含空正文）或空会话保持原历史顺序，input.text 为空且 userInput 节点不输出包装文字。末尾 compaction 不作为普通消息判定。history.summary 恰好注入一次，history.messages 保持原角色。默认后处理提示词通过 PresetService 解析；固定协议覆盖旧数组/强制标签/固定条数要求，禁止引用 input.text、history.messages 或 history.summary。
- model-notes 为按 entryId 关联的本次内存旁注，不修改正文或数据库。通用来源可服务 user/assistant；叙事内置来源先取最近两条有可见正文的 assistant，再读取已保存 output，没有 output 不向更早条目补足。状态只取 stateUpdate.updates 中 status=success 的行，并仅回填 path/value/reason；建议只取有效 items。partial_success 的有效项保留，行状态和失败诊断不进入旁注，各来源失败独立跳过。历史正文后空一行，依次直接追加 state_update JSONL 块和单行 action_suggestions 数组块。缺少 output 或某项没有有效数据时仍渲染两块：状态块为零行 JSONL，建议块为 []。JSON 字符串中的标签继续转义。
- 材料关键词和摘要只使用干净正文及适用摘要，旁注不参与激活和摘要；最终 assemble 才渲染到保留消息并计入输入预算。裁剪/摘要覆盖的条目旁注随之移除，不重复拼接，不重执行状态更新，不新增 notes 表、持久化 schema 或 contextEligible。正文编辑保留原 output，旁注表示当时的处理记录，不宣称已按新正文重算。
- 仅摘要正常 stop、非空且无工具请求时产生摘要草稿；context 编排器在捕获的实际 tip 后追加 compaction，state=null，runId 从该 tip 派生；保存前同步复核 tip 和完整捕获原文指纹，变化返回 TIP_CONFLICT，不提交过期摘要。普通发送时仍与 user/assistant 同 run，保存完整文本、覆盖边界、sourceHash 和 metrics。最终候选超限或编译失败不能丢失成功摘要草稿；保存成功后回传父 entry 和计量回执，即使准备最终失败也保留摘要。失败/取消摘要不保存、不计量；成功摘要未知 usage 为 null。
- run.summarized 只在实际保存成功后发布；失败、取消或保存失败不能伪造完成通知。仍超限 summary_capacity_exceeded 结束并保留用户、摘要和用量，不重试或继续裁剪。上下文不决定 run 终态；savedMessageIds 只列 message，tip 可指向 compaction。执行句柄 active Map 负责停止与查询；锁权限由同一 RuntimeCache 管理，覆盖用户保存到最终结算，取消与异常释放，在能力通知、usage 和终态前释放。
- saved-summary 从新到旧选择最新有效摘要，拒绝覆盖末尾受保护 user run 的摘要；校验覆盖完整 run 边界及原文 id/seq/runId/role/content 的 sourceHash，排除动态旁注、state、metrics。后续历史编辑或旧元数据无效时尝试更早有效摘要，无可用摘要则回退原文，不新增异步编辑锁/版本恢复。HTTP 禁止创建 compaction 或伪造 summary 元数据。
- ESLint 强制 context 唯一出口、公开类型出口及生产代码无其他 usecase/EventHub 反向依赖；内部阶段测试位于 context。不得为迁移放宽现有模块、SDK、SQL 或数据库属主规则。
## 叙事后处理

- 处理目录为 usecases/narrative/postprocess，持久化仍使用 extData.output。共享正则辅助逻辑按能力名独立检查自身标签，大小写不敏感；完整缺失或空标签为 no_updates/no_suggestions。自身起止标签缺失、损坏或配对错误为 invalid_tag，整个该能力不执行，不从其他能力标签截断或恢复内容。
- state_update 为 JSONL，每个非空物理行一项；仅 message scope、本轮最终激活根和已有路径。prepareMessageUpdates 只计算候选、成功更新、逐项结果及变化，不写库或发事件。每行解析/校验/规范化异常独立，成功行按序保留，重复路径按序覆盖。公共 PATCH 缺失路径忽略契约不变。
- 状态整体使用 no_updates/success/partial_success/invalid_updates/invalid_tag/processing_error；stateUpdate.updates 按 JSONL 行序保存全部成功/失败记录，每项 status 使用 success/invalid_json/invalid_update/invalid_path/invalid_value/processing_error。成功项必须有 path/value，可含 reason；失败项保留可用的 path/value/reason 及错误诊断，不虚构缺失字段。建议整体使用 no_suggestions/success/partial_success/invalid_tag/invalid_json/invalid_suggestions/processing_error，只保存有效 items 与可选能力级 errors；空项和无效项被过滤，三条只是提示词目标，保留每条 50 个 Unicode 码点和去重规则。两类 output 均不存 results，也不持久化 blockIndex、line 或额外 index。
- PresetService.resolvePostprocessPrompts 补齐缺失/空内置提示词，忽略旧 enabled，保留非空配置且不改 revision。服务端固定协议明确当前格式与状态更新无固定条数上限。用量采用模型实际 usage，包含隐藏数据块；不增加能力 token、更新条数或全尾部配额，输入上下文继续既有预算流程。
- 仅正常 stop、无工具请求且干净正文有效时执行能力；模型中断/失败只保存部分公开内容，不生成 output。能力独立兜底，状态内部逐行隔离，能力失败不改变正常 completed。公开 delta/最终 snapshot/持久化正文都隐藏能力块，最终快照重新分离，reasoning/tool_calls 不作为能力输入。
- 用例经同步 TransactionRunner 校验实际 tip，准备状态候选和变化信息，再原子追加助手正文/output/state/metrics。变化必须在追加前计算，避免读取更新后的视图漏发事件。SessionService.appendNarrativeAssistant 是 output 受控保存入口，新写严格接受精简结构，普通 append/update 禁止伪造或删除，编辑其他扩展保留结果，正文编辑不重执行或回滚。SessionService 读取投影兼容旧 output：按旧 results 顺序配对成功 updates，保留重复 path 和各自 reason，失败不提升为成功；旧 action results 仅移除。归一化不回写数据库，无 output 的旧消息不补造结果。
- 提交和锁释放后、唯一终态前，独立发布实际 state.changed 与非空有效 action_suggestions.created，再发布一次总 usage/终态。run.created 驱动清理旧建议，无空 created 或 cleared。每条能力通知异常不能跳过后续通知或终态。助手保存失败无未提交通知；用户终态保存失败保留已提交状态并通知，但不发布可点击建议。
- 聊天、持久化正文、关键词及摘要保持干净；主模型历史可由 context 的 model-notes 附加独立旁注。postprocess 不承担历史重建，不重放状态或引用 context 内部阶段。结果通过 narrative/runs 分组内的 entries 读取，不新增表或接口。


## 运行日志

- 叙事按 run 记录 `[yyyy-MM-dd HH:mm:ss] [事件] [紧凑JSON对象]`，时间为服务器本地时间，runId/sessionId 固定在数据开头；每条只占一行，正文不截断。默认 stdout，日志异常不得影响业务。只记录非 delta 生命周期、真实模型请求/完整 SDK 终态、后处理及结算，不重复 model.input。
- context 成功结果独立返回最终候选 diagnostics：节点、角色和世界书名称、条件与真实匹配结果，不含正文，不重新执行条件，不向 context 注入叙事或日志依赖。模型 raw 只经可选诊断钩子传给观测方，SDK 类型和原始数据不进入业务事件或持久消息。
- state/actions 原始块和完整处理结果分别记录；坏标签可记录整段原文用于诊断，不能用于恢复执行。结果 phase:prepared 与事务成功的 postprocess.completed/persisted:true 分开，保存失败不能宣称已提交。保留完整 usage 和终态字段，API Key/鉴权等明确凭据先脱敏。契约见 ../../docs/runtime/server-narrative.md#run-单行日志。

## 最新回复重新生成

- narrative.regenerate 只接受最新用户轮次的指定 AI，或无 AI 的用户轮次重试；开局和历史目标拒绝。使用当前配置、原 userEntryId/runId 和新 assistantEntryId，不增加 mode/attemptId。
- Session.deleteEntry 是通用原子删除：预期 tip、许可校验、直接后继衔接、tip 修正；不清终态、不发事件。Narrative 在同一事务内删除并清理旧结果，提交后持锁发布 message.deleted/实际 message state.changed，再进入 send 共用 start/execute。失败不恢复旧 AI，Context 不识别调用来源。
- run 事件、当前执行查询、结束结果及 stop 均关联新 assistantEntryId；stop 精确匹配两种 ID。run.created/202 携带真实 tipEntryId/deletedMessageIds，用户消息 ID 幂等。每次受理执行各有一次 usage 与唯一终态，不能以 runId 推断仅执行一次。
- 删除不引入账本：recordedUsage 继续汇总保留 entries.metrics，保留摘要及其计量；seq 可复用，消息身份以 ID 为准。
