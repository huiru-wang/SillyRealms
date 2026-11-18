# SR Server 整体架构与渐进迁移方案

- 日期：2026-11-17（Asia/Shanghai）
- 状态：规划，待实施；本文写入不代表代码已迁移。
- 核对基线：commit `1cd4f62`（feat(state): add v2 rules and independent postprocessing）。
- 首版执行方案：[叙事与状态迁移首版](./sr-narrative-state-migration-v1.md)。
- 本文描述长期目标；首版只实施上述执行方案列出的范围。

## 1. 产品能力地图

| 能力域 | 可预见场景 | 主要产物 |
|---|---|---|
| 世界与内容管理 | 世界卡、角色、世界书、开局、预设、离线包 | 可以运行的世界及配置 |
| 故事推进 | 用户输入叙事、无用户发言续写、Direct、Agent | 新的故事内容及相关状态变化 |
| 行动辅助 | 自动行动建议、单次 AI 帮答 | 候选行动或输入草稿 |
| 媒体创作 | 角色图、场景图、CG、TTS | 可复用图片与音频 |
| 组合创作 | 多页漫画、视觉小说编排 | 页面、分镜、演出安排及素材引用 |
| 舞台呈现支持 | 文字阅读、漫画、听书、视觉小说 | Stage/SDK 可消费的业务内容 |

产品语义：

- 续写可以没有新的用户发言，不需要制造假的 user 消息。
- 帮答结果是尚未采用的行动，不自动成为故事事实。
- 图片、配音和漫画可以派生自某轮故事，不要求产生新的叙事轮次。
- 视觉小说需要自己的内容编排，可使用已有立绘、背景和声音；生图、TTS 是按需使用的素材能力。
- Run 记录一次工作如何执行；会话内容、状态、素材和作品分别保存产品结果。本文的 TaskRuntime/TaskRepository 管理这些 Run，不额外引入第二套 Task 生命周期。

## 2. 架构结论与约束

1. Server 按产品场景和业务所有权组织。不同场景可以有独立 Runner、ContextBuilder 和输出处理，不要求经过同一条通用流水线。
2. Direct 叙事的输出切分、扩展协议和后置处理属于 Direct。未来 Agent 使用工具调用业务服务，不经过 Direct 后置管道。
3. 本期不单设 domain/story、domain/actions。会话、正文、历史、摘要及必要的消息附属结果由 domain/sessions 管理；自动建议在叙事场景内处理。
4. State 是独立、完整的业务模块，供初始化流程、HTTP、Direct 及未来 Agent 共用，包含定义校验、初值与开局覆盖、读取、应用和保存。
5. 正文正常完成并保存主任务结果后，立即释放该会话的主任务占用；状态或建议尚未结束时，可以开始下一轮。状态解析、校验或保存失败都不改变叙事 Run 的终态；任何状态结果都不决定行动建议是否执行或发布。
6. 首版保留已有上下文压缩和自动建议，不实施 Agent、生图、TTS、漫画、视觉小说或新的帮答产品。
7. 不以新增原子性、冻结、状态锁、并发协调、线程池、持久任务队列或分布式架构作为本次重构前提。
8. 不保证下一轮读取到上一轮异步后置的最新状态，也不解决状态覆盖顺序；但必须把状态写到明确的来源消息，不能误写当前 tip。
9. 逐步替换模块，每个阶段保持可运行、可验收；临时转发只调用唯一实现，首版结束时清理旧路径。
10. 首版保持当前 state schema v2 和数据库 v7，不通过清空用户数据完成迁移。多模态预设与模型参数归属调整属于后续阶段。

## 3. 整体分层

建议采用模块化单体，核心为 api / scenarios / domain / engine / infrastructure，并用 bootstrap 统一装配。

~~~mermaid
flowchart TB
    CLIENT["Studio / Stage / SR SDK"] --> API["api：HTTP / SSE / 资源入口"]

    subgraph SC["scenarios：产品场景"]
        N["叙事与续写"]
        A["帮答与压缩"]
        M["图片、漫画、TTS"]
        V["视觉小说与内容编排"]
        P["世界包导入导出"]
    end

    subgraph DM["domain：业务所有权"]
        W["World / Character / Lore"]
        S["Sessions / State"]
        C["Preset / ModelConfig / Settings"]
        R["Asset / Voice / Works"]
    end

    E["engine：任务、推理、Agent、事件、计量"]

    subgraph INF["infrastructure：外部实现"]
        DB["Repository / Database"]
        PR["Text / Image / Speech Provider"]
        BS["Blob Storage"]
        CR["Credentials"]
    end

    API --> SC
    API --> DM
    SC --> DM
    SC --> E
    DM --> DB
    DM --> BS
    DM --> CR
    E --> DB
    E --> PR
    E --> CR
~~~

图示为主要运行时调用关系；具体数据库、文件系统及 Provider 通过接口注入。

### 3.1 各层的内聚职责

| 部分 | 内聚于什么问题 | 主要内容 |
|---|---|---|
| api | 用户或客户端如何访问产品能力 | 请求校验、HTTP 响应、SSE 适配、资源访问 |
| scenarios | 如何完成一个具体产品目标 | 输入选择、Context、Runner、结果组织、跨业务服务编排 |
| domain | 某类业务数据和规则由谁负责 | 世界、会话、状态、预设、模型配置、资产、作品 |
| engine | 如何提供可复用执行机制 | Run、文字/图像/语音调用、Agent 接入、事件、计量 |
| infrastructure | 如何连接外部系统 | Provider SDK、SQL、存储、凭据、归档与资源处理 |
| bootstrap | 如何组装上述模块 | 创建服务、注册实现、依赖注入、应用启动 |

domain 和 engine 是并列能力，不是每个请求依次经过的两步。

- 简单管理操作可以 api → domain → repository。
- 生成任务通常 api → scenario → domain + engine。
- engine 不根据 sessionId 自行读取世界、预设、历史并推断任务。
- domain 不依赖 Runner、HTTP 对象或 Provider SDK。

### 3.2 依赖规则

1. API 调用场景入口或简单业务服务，不直接执行 SQL 或拼装模型上下文。
2. 场景拥有流程编排权；每个场景可以有不同的 Runner、Context 和结果结构。
3. 业务模块提供公开服务和数据契约，不暴露具体表结构给其他模块。
4. 仓储接口跟随数据所有者，具体实现位于 infrastructure。
5. 引擎消费准备好的输入和工具，不包含世界书、角色状态和漫画分页等业务规则。
6. Context 材料读取属于场景应用层。首版留在 narrative/context；出现实际复用后再抽 scenarios/shared。
7. bootstrap 可以了解各模块的实现；其他模块不能反向依赖 bootstrap。
8. shared 只放少量通用错误、日志与基础类型，不承接业务服务。
9. domain 不直接依赖 engine；领域服务返回业务变更结果，或通过本模块定义的事件接口发布，由装配层接入统一事件服务。

## 4. 业务模块的所有权

| 模块 | 拥有的数据和能力 | 关键边界 |
|---|---|---|
| worlds | 世界定义、角色、世界书、开局、组件及原始资源引用 | 定义世界；ZIP 结构语义属于世界业务 |
| sessions | 会话身份与配置、消息、历史、分支、摘要、消息关联结果 | 本期完整承接会话内容，不拆 Story 或 Actions 领域 |
| state | 定义校验、初始化、三种 scope 的读取、更新、保存和变更结果 | 创建流程、HTTP、Direct、未来工具共用；不认识输出标签 |
| presets | 预设生命周期、类型、版本、校验、默认内容、导入导出 | 预设描述配置，不执行模型流程 |
| models | 服务连接引用、模型能力目录、调用配置 | 与实际 Provider 调用实现分离 |
| assets | 素材身份、元数据、来源、用途与业务引用 | 与文件字节存储分离 |
| voices | 声音资源、提供方声线映射、参考音频及角色绑定 | 不把角色声音身份复制到每套 TTS 预设 |
| works | 漫画页面、分镜、演出脚本和素材组合 | 保存作品结构，不组织模型执行 |
| settings | 应用默认选择与产品偏好 | 不成为所有业务配置的任意 JSON 容器 |

domain/assets、voices、works 是后续目标，不因本次目录迁移提前建立空实现。现有世界包资源功能继续保留。

## 5. 场景和共享能力

| 场景 | 自有 Context 与流程 | 复用能力 |
|---|---|---|
| Narrative Direct | 叙事预设、材料编译、裸调、流式分离、后置解析 | Sessions、State、文字推理、事件、用量 |
| Narrative Agent | 叙事目标、工具说明、Agent 执行 | 同一 State/Sessions 等业务服务 |
| Assistance | 帮答主指令、玩家视角、相关世界书与历史 | 材料读取、文字推理 |
| Continuation | 当前故事位置和续写要求 | 通常复用 Narrative，输入语义独立 |
| Compaction | 旧摘要、待处理历史、保留要求 | 历史策略、摘要调用；首版作为叙事前置能力 |
| Illustration | 画面、角色外观、场景、风格、参考图 | 图片推理、Asset |
| Comic | 情节、人物连续性、分镜、页面组织 | 文字和图片能力、Asset、Works |
| Speech | 正文或对白、说话者、声音与表达配置 | 语音推理、Voice、Asset |
| Visual Novel | 分人物内容、出场、场景与演出安排 | 叙事、素材选择、按需生图和配音、Works |

Direct 与 Agent 的公共点是业务服务，而不是 postprocess：

- Direct：输出协议适配后调用状态、建议等处理能力。
- Agent：通过工具调用业务服务，遵循正常 Agent 工具执行流程。
- 具体工具适配归场景；通用工具执行机制归 engine/agent。

## 6. Preset、Model、Asset、Repository

### 6.1 Preset：统一管理，内容分型

公共部分管理名称、说明、用途、版本、保存、复制、引用、导入导出。具体内容使用独立 Schema，不给一份叙事节点列表不断增加空字段。

| 用途 | 预设内聚内容 |
|---|---|
| 叙事 | 风格、提示词组织、材料策略、生成能力选择 |
| 帮答 | 玩家视角、主指令、草稿/候选形式 |
| 摘要 | 保留目标、摘要组织与长度要求 |
| 图像 | 视觉风格、构图、画幅、提示词组织、参考素材策略 |
| 语音 | 朗读、对白与旁白组织、语速、停顿、情绪和声音分配规则 |
| 漫画 | 作品偏好、阅读方向、分镜组织、子能力配置引用 |
| 视觉小说 | 分段与演出偏好、素材和声音策略、子能力引用 |

边界：

- 温度、深度思考等模型调用参数归 ModelConfig；首版不顺带迁移当前全部配置存储。
- 人物外貌和角色参考图归 World/Character/Asset。
- 声音身份归 Voice 与角色/会话绑定；TTS 预设管理演绎方式。
- 图像画幅等产品要求由预设拥有默认值，模型声明支持范围和适配方式，避免两处保存同名默认值。
- PromptTemplate 可以先作为预设的内容组件，出现真实共享需求再独立管理。
- 续写通常复用叙事预设；帮答有自己的主指令；滑动窗口是 Context 策略，不建立虚假的提示词预设。
- 组合预设只保存固定能力位置的引用和作品偏好，不保存任意流程连线。实际流程由 Comic/VisualNovel Runner 实现。

默认选择按场景解析：应用默认 → 世界默认 → 会话选择 → 本次操作覆盖。只合并明确允许的选择和选项，不深度混合所有领域数据。

### 6.2 Model：配置、调用、适配分开

| 所属 | 职责 |
|---|---|
| domain/models | 连接引用、模型能力、模型调用配置 |
| engine/inference | 平台文字、图像、语音调用接口与执行机制 |
| infrastructure/providers | 具体供应商协议和 SDK 实现 |

模态共享凭据、配置和计量基础，不强制图片和 TTS 使用聊天 messages 结构。

### 6.3 Asset：素材目录与字节存储分开

- domain/assets：素材是谁、来自哪里、属于谁、有什么用途、如何被业务引用。
- AssetRepository：素材元数据的持久化。
- BlobStore：文件字节读写与访问，具体实现在 infrastructure/storage。
- worlds：世界包清单、引用及导入导出规则。
- works：页面、分镜和演出结构；这些结构引用素材。

### 6.4 Repository：接口随所有者，实现集中

SessionRepository、StateRepository、PresetRepository 等接口归所属 domain 模块；TaskRepository、UsageRepository 接口归相应 engine 模块。SQLite 实现集中到 infrastructure/persistence/sqlite。

职责拆分不要求立即拆表。首版仍使用现有数据库与列，不建立包揽所有表的公共 RepositoryService。

## 7. 长期目标目录

以下是目标分类。标注“后续”的能力按产品落地创建；首版目录以配套执行方案为准。

~~~text
apps/server/
  src/
    server.ts
    app.ts
    bootstrap/
    api/
      routes/
      events/
      resources/
      middleware/

    scenarios/
      narrative/
        service.ts
        context/
        direct/
          runner.ts
          postprocess/
        agent/                    # 后续
      assistance/                 # 后续
      illustration/               # 后续
      comic/                      # 后续
      speech/                     # 后续
      visual-novel/               # 后续
      world-package/
      shared/                     # 有真实第二个使用者后提取
        materials/
        context/
        configuration/

    domain/
      worlds/
      sessions/
      state/
      presets/
        schemas/
        templates/
      models/
      assets/                     # 后续通用素材管理
      voices/                     # 后续
      works/                      # 后续
      settings/
      tags/

    engine/
      tasks/
      inference/
        text.ts
        image.ts                  # 后续
        speech.ts                 # 后续
      agent/                      # 后续
      events/
      usage/

    infrastructure/
      persistence/
        database.ts
        migrations/
        sqlite/
      providers/
      credentials/
      world-files/                # 首版保留现有能力
      storage/                    # 后续通用 BlobStore 实现
      archives/
      media/
      stage/

    shared/
  resources/
    presets/
  scripts/
  tests/
    integration/
~~~

## 8. 分阶段迁移路线

| 阶段 | 产品与架构目标 | 结束条件 |
|---|---|---|
| M1：叙事与状态首版 | 分开事件、Sessions、State、任务；迁移 Direct；修复输出隔离；更新必要客户端契约 | 主结果与状态真正分责，现有功能可用，旧链路清理完成 |
| M2：新增文字场景与配置整理 | 无用户发言续写、单次帮答；按需接 Agent；整理 Preset/Model 配置 | 新场景不修改通用 Run 流程，材料在真实复用点提取 |
| M3：通用媒体底座与独立能力 | Asset/Voice、图像调用、TTS、图片/语音预设 | 媒体可独立生成并关联故事，素材可复用 |
| M4：组合创作与演出 | 漫画、视觉小说、作品结构 | 组合已有场景和素材，不扩充一个总 Runtime |

这些阶段表达依赖关系。静态素材版视觉小说可以提前开展；Agent、帮答、图片、TTS 的具体产品优先级不由架构强制决定。

### 8.1 渐进迁移原则

1. 先拆接口与数据所有权，再切调用链；避免先大范围重命名。
2. 每一批只允许一个实际执行实现。旧方法可短期转发，不允许两套 Runtime 双跑。
3. 需要改变协议的 Server、SDK、Studio 在同一批提交中切换，不能把前端适配留到最后。
4. 文件移动批与行为变更批尽量分开，使验收和定位问题明确。
5. 首版不重建数据库，不重做多模态预设，不提前实现未来 Runner。
6. 临时转发层逐项登记，在首版清理阶段删除；不作为长期兼容架构。
7. 后续每个新场景都应有明确输入、Context、执行与产物落点，不能继续向总 Runtime 添加业务分支。

## 9. 首版完成后应该成立的事实

- 当前 Direct 叙事由 scenarios/narrative 完整承接。
- HTTP 状态更新和 Direct 状态更新使用同一个 StateService。
- 任务终态写入不包含状态写入；计量服务也不决定任务终态。
- Sessions 拥有正文、历史和摘要，不存在独立 Story/Actions 领域。
- Direct 后置独立于主 Run，两个处理器相互独立。
- SSE 连接属于会话入口，事件发布者不属于某个 Run。
- JSONL、分帧与实际模型请求中的协议一致。
- 现有历史、压缩、自动建议、取消、用量及主 Run 中断恢复仍可用；本期异步后置不保证进程重启后续跑。
- 新增 Agent 或媒体场景时，可复用业务服务和执行接入，不依赖 Direct 的输出协议。

## 10. 本次核对的实现依据

本节是迁移基线，不能视为目标行为已经实现。

- apps/server/src/runtime/sr-runtime.ts：当前主编排、事件发布、终态及后处理发布。
- apps/server/src/runtime/persistence/run-store.ts：当前会话写入、摘要、正文、Run 终态与状态的混合存储。
- apps/server/src/runtime/persistence/usage-store.ts：当前统计与 preparation 终态写入耦合。
- apps/server/src/runtime/postprocess/：当前整体 JSON、分帧与处理器。
- apps/server/src/routes/state-updates.ts：当前 State HTTP 与 SQL/runtime busy 耦合。
- apps/server/src/domain/preset/schema.ts：当前固定叙事节点的配置结构。
- apps/server/resources/presets/default.json：真正的默认预设资源。
- apps/server/src/routes/providers.ts：当前模型配置管理。
- apps/server/src/infrastructure/world-files/：当前世界包与文件服务。
- packages/sr-sdk/src/run-contract.ts：当前 phase/extensions 公共契约。
- apps/studio/src/features/sessions/action-suggestions.ts：当前建议展示门槛。

详细步骤、协议切换、数据策略、验证命令和验收矩阵见[首版执行方案](./sr-narrative-state-migration-v1.md)。
