# Server V2

- 本期在 modules/usecases 管理能力上实施叙事首版：单次 SDK 无关模型流（pi 适配实现）、核心提示词编译、统一 SSE、提交/停止、消息独立持久化、目录和连通性检测。不设计 runtime、engine、通用任务、Agent/tool loop、恢复、摘要或扩展（状态更新/行动建议），不迁移 StudioV2 运行页。
- 单域操作采用 `route → service → repository`；应用流程采用 `route → usecase → service → repository`。route 可以调用读写能力，跨模块只读展示投影可在 route 组合；跨模块写编排必须进入 usecases。route 不写 SQL、不管理事务。
- 业务模块统一位于 `modules/<name>`，以 `service.ts` 为唯一公开出口。Repository、存储 Row、schema、parser、validation、assets、archive、card、default、files 均为内部实现；公开领域类型从 service 显式 export type，不使用 export *。启动 services.ts/usecases.ts 显式装配依赖。
- Service 承担本域规则和持久化能力。跨模块只依赖显式 Reader 类型并调用其只读能力，服务本域校验与计算；不依赖对方完整 Service 或调用写能力。模块不能反向依赖 usecases、routes、http 或启动装配，不得循环依赖。
- usecases 是完整应用流程层：跨模块写入必须在这里；需要管理多步骤/资源生命周期的单域导入导出也可放这里。用例只调用模块公开 Service，禁止直接导入模块内部文件、写 SQL、打开或关闭数据库。
- Service 公共输入输出采用显式驼峰领域类型，存储行到领域对象的映射在 Service；Repository 负责存储 JSON 编解码并返回模块私有记录。不递归改名作者 JSON、状态键或正式文档协议。
- Repository 仅由本模块 Service 使用，不依赖任何 Service、其他模块 Repository 或 usecase。SQL 包括查询/JOIN/存在性检查只碰本模块属主表或列：presets→presets，models→api_model_configs，settings→app_settings，worlds→worlds/world_tags，sessions→sessions/entries。
- State 无表、无 Repository，StateService 保留 scope 读取及消息前驱继承。完整 scope 写入由 set-state 用例调用 World/Session Service；worlds.state、sessions.state、entries.state 的 SQL 始终归表属主。普通内容更新不能覆盖运行 state。
- 连接由启动方创建和关闭，所有 Repository 借用同一连接；Service 仅在构造时把连接传给私有 Repository，不保留连接、不写 SQL、不执行事务。usecase 只接收装配方绑定好的 TransactionRunner，不接收原始连接。
- database、events、model 契约与 pi 适配统一位于 infrastructure。业务和路由仅依赖 infrastructure/model 自有 ModelClient/消息/目录/用量/原因类型；SDK 导入限于 infrastructure/pi，具体 PiClient 仅在装配选择。pi/model 不反向依赖 modules/usecases/HTTP/数据库/EventHub，不导入原 Server 实现。ESLint 同时约束 SDK 类型泄漏和具体适配器依赖。
- 叙事校验后立即保存 user，模型准备或生成失败不回滚。assistant 的 content/reasoning_content/tool_calls 完整或部分公开快照独立保存，只有推理或工具请求也保留；完全没有公开内容不造空助手。历史仅投影可见正文，不把推理/工具参数用于提示词或材料激活。两条消息无整体事务；单条 appendEntry/seq/tip 原子推进不变，迟到输出丢弃，正常关机先结算再关库。
- 跨模块写入及跨模块事务边界归 usecases；本域必要的多条 SQL 原子操作留在 Repository，例如世界内容+标签、entry追加+tip推进。database 负责 DDL/结构事务，显式维护 updated_at，不新增触发器。
- infrastructure/database/transaction.ts 的回调必须同步，不接受 Promise。事务中不做文件/网络/模型调用；文件与 DB 用暂存、发布、清理/补偿协调，不宣称强原子性。代表提交成功的事件在成功提交后发布。
- openDatabase 只建立/检查结构，不播种业务数据。每次启动装配后、监听 HTTP 前调用 initialize，在同一同步事务内按稳定 ID ensureDefault，再 settings.ensure。缺失的内置预设或设置记录自动补齐；已有内置预设内容、revision、用户默认选择和显式 null 均保持原值，重复启动不更新它们。恢复预设沿用名称避重规则，失败整体回滚重试。不创建虚假模型或凭据，也没有前端初始化向导。
- 本期只支持线性叙事存储：appendEntry 只能接当前 tip，显式 parent 不匹配时报错；追加、seq 分配与 tip 推进原子完成。不提供 setTip；getHistory 只读取当前线性历史。
- 正文、历史关系、state、metrics 分别写入明确字段，禁止整行覆盖。状态 PUT/set 保存完整 scope 快照；消息 NULL 继承前驱，显式空数组终止继承。本期不迁移按路径 PATCH 或状态规则执行。
- 仅开放已实现校验的预设类型，类型与配置统一在 PresetService 校验；引用通过 Reader.require 和数据库外键保证，不恢复 assertNarrativePreset。默认模板与导入导出协议属于 presets 内部领域知识；凭据字节不进入模型配置表。
- 世界导入保留原始字节，不依赖上传原名；JSON/ZIP 验证卡和资源后发布，失败按明确阶段清理。导出由 DB 当前世界卡、当前标签与 package/ 当前资源构建，名称为当前 world.name.zip，原件不参与重建。卡协议与静态状态定义校验属于 worlds；不执行状态规则。
- worlds 内部按职责组织：parser 负责 JSON 解析、领域转换和初始值提取；validation 集中卡结构、引用、状态定义及 when 静态校验；assets 负责资源读取与完整性；archive 负责导入包和 ZIP 解压/构建；files 负责磁盘生命周期。parser/validation 不读文件，assets 不处理 ZIP，archive 复用解析与校验，不重复定义协议；这些实现仍只通过 service.ts 对外提供能力。
- 包内文件 HTTP 入口为 `/api/v1/worlds/:id/resources/*`，相对于磁盘 package/ 根目录，保留 assets/、components/ 等目录前缀；不能将其缩减为仅素材读取。存储目录和路径安全规则独立于路由名称。
- 世界删除先删本模块 DB，外键拒绝时不碰文件；随后清理整个世界目录。文件失败报告 WORLD_FILES_DELETE_FAILED，重试允许清理 DB 已不存在的残留目录；不做 DB/文件强事务。原件写入/发布/删除按世界串行，路径校验拒绝不安全根目录和符号链接逃逸。
- 事件连接独立于业务执行，只负责传输；不得查询数据库或判断终态。SSE data 均为 JSON：run.created/run.delta/run.usage/run.completed/run.stopped；失败统一 stop_reason，不含 error 对象/errorCode/errorMessage、不发裸 [DONE]。每个 accepted run 保存结算后只发一次总 usage 再唯一终态；无调用尝试为零、尝试后未知为 null。delta 定稿 snapshot 明确 replace，模型 finish 不等于 run 保存成功；终态带 savedMessageIds/tipEntryId。system/tool result/state/actions 只预留类型，不生产。
- 会话终态不关闭 SSE；断开只取消订阅。事件不持久化或回放，仅 event/data，无 SSE id。传输用 pull 保序分块，控制器缓冲 256 KiB、总未读预算 8 MiB，超限只关闭慢订阅，不阻塞执行或其他连接。
- 会话路由先经 SessionService 检查真实会话，再执行可选 canAccessSession；等待后先检查关闭信号，再确认会话仍存在。访问适配器不能代替会话存在性检查。
- 普通 HTTP 统一 `{ success, errorCode, errorMessage, data }`，错误集中 errors.ts 映射并保留正确状态码；未知异常不泄漏 SQL、路径或堆栈。SSE/文件下载保留原始正文，传输开始前错误仍用 JSON 失败包络。
- routes 使用 http/response.ts，HTTP 正文/query/游标处理留在传输层，业务校验留在 Service。跨模块列表/详情展示投影由 route 调公开 Service 组合。接口契约见 `../../docs/runtime/server-v2-http.md`。
- V2 使用独立数据根目录和数据库，user_version=3；只迁移结构匹配的 V2 v1/v2 库，依次添加预设 revision、世界 revision 及导入时间索引，不自动改造/清空旧 Server 库，不导入旧 Server 的建表、恢复或执行逻辑。现有 V2 设置记录保留原值；缺失的 V2 内置预设与设置由启动 initialize 幂等补齐，不导入旧 Server 数据。
- 本轮仅做函数级测试、typecheck、lint，不启动真实服务或执行 HTTP/浏览器链路验证。函数测试使用内存或临时库、临时文件以及最小凭据替身，不访问真实 Keychain；架构测试检查入口/层级/SQL属主，类型测试检查 Reader 不具有写方法。关闭 HTTP/SSE 后再关库。

## StudioV2 管理接口

- 当前接入世界内容库、预设、模型配置、设置及基础会话。预设 CRUD 使用驼峰领域 config；文件导入导出协议由 presets codec 独立转换。列表返回摘要，详情按需加载；PATCH 必须带 expectedRevision，通过 Repository CAS 更新并递增 revision。
- 模型目录由 infrastructure/pi 读取固定版本 SDK，按 provider 分组；公开 contextWindow/maxTokens/reasoning/thinkingLevelMap/thinkingLevels/api/input/promptCache 等安全元数据。有效思考档位使用 SDK helper；缓存保留时长为 SDK 最佳估计秒数，缺失用 null，不推断实际支持或保留承诺。不返回 SDK headers/baseUrl 或密钥。
- credentials 独立管理外部密钥存储，models 表只保存 credentialRef。model-config 用例协调写入、补偿和删除清理，按模型串行，不在 SQLite 事务内等待外部存储；HTTP 不接收引用或返回密钥，状态不冒充模型连通性验证。
- 默认凭据适配器是 macOS Keychain，引用按 V2 dataRoot 隔离；不复用旧 Server 凭据命名空间，不增加明文降级存储。跨资源补偿不等于崩溃原子性。
- 会话创建验证世界中的可扮演角色，只建立基础记录。更新不允许改变 worldId/userCharacterId；不顺带初始化 opening、消息、执行或计量。详情统一返回 data.item。

- 世界列表直接读取摘要并批量取标签，以 createdAt/id 游标分页；管理 PATCH 只接受名称、标签、默认配置及 expectedRevision，CAS 原子更新，不重写作者内容或运行状态。HTTP 不开放 POST /worlds 或作者内容编辑。
- 组件读取复用 worlds/assets，path 优先且失败不回退 inline；按组件返回错误。API Origin 校验只信任服务同源和配置的 Studio 来源，跨来源仅允许资源 GET/HEAD；这不是用户认证。

- HTTP multipart 从适配器提供的 headers/body 流解析并限制实际字节数；不能将 Node 适配器的轻量 Request 直接交给原生 new Request 克隆。保持超限与格式错误的独立错误码。
