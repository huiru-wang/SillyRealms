# Server V2 存储方案 v1

- 日期：2026-11-18（Asia/Shanghai）。
- 状态：存储 Service 与业务 HTTP 路由已实施；目标 DDL 用于 V2 独立新库，不是旧 Server 的升级脚本。
- 实施位置：`apps/serverV2`，按业务模块逐步迁移，不预建 engine 或通用任务体系。
- 本版已确认目标 DDL、精简 metrics 结构、世界文件推导及导入导出语义；世界 ZIP 业务流程和叙事执行不在本期存储范围。
- 与旧文档的关系：`sr-server-architecture.md`、`sr-narrative-state-migration-v1.md` 中有关旧 v7 原样保留、engine/tasks 和事件目录的安排，不作为 V2 本次存储实施要求。当前事件模块位于 `apps/serverV2/src/events/`，不生成事件 ID。
- 本期已建立数据库连接、各业务 Service、模块私有 Repository 和启动装配；验证使用内存或临时库，不改造旧用户数据库。

## 1. 已确认决策

| 项目 | 本版决定 |
|---|---|
| worlds 来源信息 | 删除 `source_kind`、`source_sha256`、`source_file_path`、`warnings_json` |
| 世界卡标识 | 数据库及世界卡格式删除固定 `spec` 字段 |
| 世界文件定位 | 由配置的数据根目录、世界 ID 和固定目录规则计算，不保存可推导路径 |
| 消息计量 | 保留独立的 `entries.metrics_json`，不并入 `ext_data` |
| 准备阶段记录 | 暂不考虑把 `run_preparations` 表及其专门机制迁入 V2 |
| 额外执行表 | 此前提出的 `runs` 替代表未获确认，本版不建立；也不新增任务队列、模型调用表等替代体系 |
| 标签 | 只有世界支持标签，采用一张 `world_tags` 表；取消预设标签及原通用标签关联表 |
| 预设 | 增加 `type`；`context_strategy`、`model_parameters` 纳入各类型的 `config_json` |
| 更新时间 | 不使用触发器，由所属 Repository 显式更新 |
| 模块边界 | route → service → repository；跨模块仅通过 Service，Repository 仅操作本模块表 |
| 叙事范围 | 本期线性追加，不开放分支或独立切换 tip |

以下取舍已随本次目标 DDL 一并确认：

- 删除 `entries.branch_count`：当前实现只将前一个可见条目标记为 1，并非真实分支计数；保留父子历史关系。
- 保留三种状态 scope 与格式版本信息；本版沿用 `state`、`spec_version`。
- V2 使用独立数据库文件和独立结构版本，不让旧 Server 与 V2 对不同结构共用写入同一文件；旧数据导入单独安排。
- 同类型预设名称唯一，采用 `UNIQUE(type, name)`。

## 2. 模块及数据所有权

业务调用链固定为 `route → service → repository`。每个业务模块以 `service.ts` 对外提供能力；跨模块通过 Service 编排，Repository 是模块内部实现。Route 处理 HTTP 输入输出，Service 承担业务校验与规则，Repository 负责所属表的 SQL 和编码。Service 输入输出为显式驼峰领域对象，不直接公开存储行；按 Studio 契约需要的跨模块投影（世界 sessionCount、会话 cover/worldName）由 route 调各模块 Service 组合。

```text
apps/serverV2/src/
  app.ts                    # HTTP 装配
  server.ts                 # 数据库、Service 与 EventHub 生命周期
  services.ts               # 显式装配业务 Service 依赖
  routes/                   # 六个业务 HTTP 适配器，只调用 Service
  http/                     # 统一响应与会话访问检查
  errors.ts                 # 错误码、中文信息及 HTTP 状态
  events/                   # 事件传输基础设施，不依赖数据库
  database/
    connection.ts           # V2 连接、结构版本、DDL 与事务
  presets/
    service.ts              # 预设公开能力与配置校验
    repository.ts           # 内部预设存储
    schema.ts               # 已开放类型的配置和模板规则
    types.ts
  models/
    service.ts              # 模型配置公开能力
    repository.ts
    types.ts
  settings/
    service.ts              # 默认选择及预设/模型引用编排
    repository.ts
    types.ts
  worlds/
    service.ts              # 世界、标签、世界状态存取及文件基础能力
    repository.ts
    files.ts                # 内部文件存储与路径规则
    types.ts
  sessions/
    service.ts              # 会话、线性历史、消息、计量与状态存取
    repository.ts
    schema.ts
    types.ts
  state/
    service.ts              # scope 快照及继承，通过 World/Session Service 存取
```

SQL 表归属固定如下：

| 模块 | Repository 可操作的表 |
|---|---|
| presets | presets |
| models | api_model_configs |
| settings | app_settings |
| worlds | worlds、world_tags |
| sessions | sessions、entries |
| state | 无独立表，不建立 Repository |

- Repository 禁止依赖其他模块 Repository，也禁止直接实现其他模块属主表或列的 SQL，包括查询、JOIN、存在性检查和写入。Route 和启动入口同样不能导入 Repository。
- Service 之间按显式依赖编排：Settings/World 调用 Preset/Model；Session 调用 World/Preset/Model；State 调用 World/Session。禁止循环编排；公开类型从所属 Service 导出。
- 层级严格单向；Repository 不依赖 Service，Service 不依赖 route/http。Service 不保留连接或执行事务，构造时只把启动装配传入的连接交给私有 Repository。SQL 与 JSON 存储编码留在所属 Repository。
- 跨模块不做强一致性事务、全局回滚或事务回调。单模块多条 SQL 的必要原子操作留在所属 Repository；数据库初始化与 DDL 属于 database 基础设施。
- World 管理状态定义；State 管理 scope 与继承语义。worlds.state 由 WorldRepository 存取，sessions.state 和 entries.state 由 SessionRepository 存取；StateService 通过对应 Service 调用，不能绕过模块边界。
- 世界/会话首次创建可以同时保存状态初值。普通内容更新不覆盖运行 state；状态、正文和计量分别写入各自字段。
- 本期只做线性叙事。appendEntry 只接当前 tip，显式 parent 不匹配时报 TIP_CONFLICT；追加、seq 分配与 tip 推进原子完成。删除 setTip，getHistory 只读取当前线性历史。保留 parent_id、tip_entry_id 和 seq，不改 DDL。
- 会话拥有 entries 的内容、历史关系及计量；setMetrics 使用精简结构校验，不复制旧 UsageStore。
- 数据库由启动装配方创建和关闭，各模块共享同一连接；startServer 仅公开 services、events、server、close，不暴露数据库或 Repository。
- 模块内部测试可验证存储细节，业务功能测试经 Service 调用；lint 检查导入边界、SQL 分层和表归属。

当前 HTTP 已覆盖预设/模型/默认设置/世界/会话 CRUD、标签、消息历史、scope 快照、SSE 与原件/包资源下载。普通 JSON 统一响应包络，SSE 和下载保留原始格式；契约见 `../docs/runtime/server-v2-http.md`。模型执行、完整世界 ZIP 业务及按路径状态更新仍按后续用例迁移。

## 3. 世界文件：固定路径，不保存 source_file_path

世界文件完整导入导出业务不在本期范围。本期 `worlds/files.ts` 落实目录推导、原件字节保存、资源路径检查和世界目录清理，通过 WorldService 对外提供。

### 3.1 固定布局

```text
<dataRoot>/worlds/<worldId>/
  source/
    original.json           # JSON 原件；与 original.zip 最多存在一种
    original.zip            # ZIP 原件
  package/                  # 当前可用的组件和素材资源
```

- 世界目录由配置的数据根目录和服务端生成、校验后的世界 ID 推导；名称与上传文件名不参与定位。
- 世界文件模块统一校验资源相对路径及符号链接，路径必须留在所属世界目录。
- 不新增元数据文件来变相保存已删除的 path/kind/hash/warnings。
- 世界删除先删 DB，外键失败不动文件；成功后清理该世界 source/package 整个根目录。文件失败报 WORLD_FILES_DELETE_FAILED，重试可清理 DB 已不存在的残留目录；目录缺失视为已清理，不引入 DB/文件强事务。保存原件与删除按世界串行。
- Service 的 description 为已解码的描述值，支持 Studio 的组件对象；存储层显式 JSON 编解码，已有文本描述保持文本语义。
- 原件读取仅检查两个固定候选名；两者同时存在视为存储异常。没有原件仍可构成有效世界。
- 同格式原件通过临时文件和 rename 原子替换；失败保留旧原件。已有另一种格式时拒绝覆盖，跨格式替换不属于本期能力。

### 3.2 已确认的导入导出契约

- **导入**：保留原始文件字节；当前业务尚无消费原件的流程，也不依赖原始上传文件名。
- **导出**：从 DB 读取当前世界卡和当前标签，结合 `package/` 中当前资源构建 ZIP。导出反映世界现在的内容，原件不作为导出数据源。
- **导出文件名**：`world_name.zip`，其中 world_name 为当前世界名称；仅处理路径分隔符、控制字符等不适合作为文件名的字符，不按原始文件名命名。
- 原件下载与包资源读取已通过 HTTP 提供原始文件流，原件固定名为 original.json/original.zip。ZIP 校验/编解码和 DB/文件导入导出用例后续实施，当前原件下载不等于按当前世界重建 ZIP。
- 删除 source_sha256 后不恢复旧持久化哈希比对；后续导入仍须做包结构、路径和内容校验，告警仅作为当次操作结果。

## 4. 状态字段的含义

| 字段 | 含义 |
|---|---|
| `worlds.state_definition_json` | 世界卡中的变量定义、初值、scope 和校验规则 |
| `worlds.state` | global scope 的当前值，同世界下会话共享 |
| `sessions.state` | session scope 的当前值 |
| `entries.state` | message scope 的历史状态快照；NULL 表示沿来源消息祖先链继承 |

本版不删除 global scope，也不将运行中的当前值反写为世界卡初值。用户询问 state 的用途，不等于确认取消该能力。

本版固定保留 worlds/sessions 的 JSON object 和 entries 的 JSON array。StateService 负责 scope 快照与消息前驱继承，通过 WorldService/SessionService 存取；SQL 位于相应模块的 Repository。显式空数组表示已记录的空快照，不继续继承。set 保存完整 scope 快照；状态定义解释、按路径更新、规则计算及模型状态更新随业务后续迁入。

本版删除固定类型标识 `spec`，保留世界卡格式版本 `spec_version`。数据库结构版本与世界卡格式版本分别管理；后续导入导出由世界模块按此契约解析。

## 5. metrics_json 为什么字段多，V2 怎么收敛

### 5.1 当前代码事实

旧版 `runtime/persistence/usage-store.ts` 的 RequestMetrics 混合了这些职责：

| 类别 | 现有字段举例 | 为什么出现 |
|---|---|---|
| 关联信息 | sessionId、runId、requestId、requestIndex、phase、apiModelConfigId、modelId | 请求归属、摘要/正文区分、模型来源 |
| 实际计量 | inputTokens、outputTokens、totalTokens、cacheReadTokens、cacheWriteTokens | 提供方返回的 token 数据 |
| 请求结果 | status、usageStatus | 区分成功、失败、取消，以及有无可靠计量 |
| 时间指标 | startedAt、finishedAt、firstTextMs、durationMs | 延迟、首字耗时、请求耗时 |
| 上下文计算 | contextWindowTokens、inputIdentity、contextComposition | 上下文比例展示和预算/压缩估算 |
| 整轮结算 | accounted、reportedCount、unknownRequestCount、run 汇总 | 防止重复累计，汇总一轮多个请求 |

字段多的主要原因是多种职责混在一起，并且相同列存在三种形状：

1. assistant entry：一个 RequestMetrics 对象。
2. compaction entry：`{ requests: [...] }`。
3. user entry：`{ run: { ..., accounted, timing, ... } }`。

因此不能只把它们原样搬到 ext_data，也不能因为字段多就全部删除。尤其 inputIdentity/baseline 还参与当前上下文估算，必须在迁移该算法时确定替代读取位置。

### 5.2 本版确定的边界

- 保留 `entries.metrics_json`，允许 NULL；NULL 表示没有记录，不等于调用消耗为零。
- `ext_data` 放消息附属元数据；计量不混入其中。
- 不把运行状态、准备阶段日志、重启恢复及结算控制字段视为消息计量必需内容。
- 已能从 entry 得到的 sessionId/runId，不必在每个 metrics 对象中重复。
- 当前模型配置可以被修改，因此实际调用的 modelId 不应简单依赖后来查询配置行得到。
- 提供方未报告 usage 时保持未知，不能填成 0；缓存 token 与输入 token 的口径必须延续明确规则，不能重复计数。

### 5.3 已确认并实施的精简结构

使用同一种形状记录附属于 assistant 或 compaction entry 的模型调用：

```json
{
  "requests": [
    {
      "requestId": "request-001",
      "modelId": "actual-model",
      "status": "completed",
      "usage": {
        "inputTokens": 1200,
        "outputTokens": 300,
        "totalTokens": 1500,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      },
      "durationMs": 2500,
      "firstTextMs": 180
    }
  ]
}
```

本期存储契约：

- requestId 区分真实模型调用，不是 SSE 事件 ID；同一 entry 内及同一会话所有 entry 之间不得重复归属。
- 整列 NULL 表示没有计量记录；requests 内 usage 为 null 表示调用存在但未取得提供方计量。缺失数据不补零。
- status 为 completed、failed、cancelled；durationMs、firstTextMs 按实际可用性记录，并校验非负有限数值及先后关系。
- inputTokens 延续旧归一口径，已包含 cacheReadTokens/cacheWriteTokens；缓存字段是其细分，不额外加总。totalTokens 保留提供方值，不由存储层重新推导。
- user entry 不保存同一请求的整轮副本。计量更新只写 metrics_json 和该 entry 的 updated_at，不修改消息 timestamp、正文、状态或会话排序时间。
- 本版不保留 phase、模型配置引用、时间戳、上下文预算和旧 accounted/pendingRun 等控制字段；实际 modelId 随请求保存。
- sessions.usage_json 保留可空列，目前默认 NULL，不填充旧汇总结构，也不建立累计缓存/恢复机制。

### 5.4 尚未解决，不能宣称已经保留的能力

模型请求可能在 entry 保存前失败，当前旧系统通过准备记录和会话日志承接这部分计量。由于本版不引入 run_preparations 或替代运行表，这类无 entry 请求的计量落点、受理后未产生消息的请求查询、去重及重启恢复，暂不定案。

这些问题在叙事与模型调用模块迁移前处理，不阻塞世界、预设等内容管理模块；也不能为了绕开它们制造空消息或伪用户消息。保留 metrics_json 这一列不等于迁移了完整计量功能。

## 6. world_tags 的产品语义

- 只有世界支持标签，按 `(world_id, name)` 唯一。
- 标签目录从已绑定标签中查询得到，不单独保留未绑定任何世界的空标签。
- 不再提供原通用标签 ID、预设标签和类型维度。
- `sort_order` 表示一个世界内部的标签展示顺序；不承诺原来的全局标签排序。
- 全局重命名若需要，是按名称更新多条绑定记录，须处理重名合并；不提前增加另一张标签字典表。

## 7. presets 的类型化配置

- `type` 保存程序值，例如 narrative、image；界面映射为叙事预设、生图预设。
- `config_json` 包含该类型的完整配置，context_strategy/model_parameters 不再是独立列。
- 叙事配置可以包含 nodes、context_strategy、model_parameters；生图配置无需声明 context_strategy。
- 具体配置由 type 选择校验规则，不能把所有类型的字段堆进一份可选字段集合。
- 仅开放已实现校验和执行能力的类型；增加 type 列不代表本期实现了生图。
- 本版叙事 config_json 使用 `schema_version: 1`，包含 nodes、context_strategy、model_parameters；配置和模板规则在 presets/schema.ts 按类型校验。
- 世界、会话、应用中的 preset 引用通过 PresetService 检查记录存在，并保留数据库外键约束；类型与配置统一在 PresetService 校验，引用写入不增加 narrative 类型断言；本版保持当前字段名。
- model_parameters 表示该预设的生成参数；模型连接、提供方及凭据引用仍归模型配置模块。

## 8. 目标 DDL（已实施）

共 7 张业务表：worlds、world_tags、sessions、entries、presets、api_model_configs、app_settings。没有 run_preparations、runs、tags、tag_assignments，也没有触发器。

以下 DDL 用于 V2 新库初始化。sessions.usage_json 当前允许 NULL，entries.ext_data 默认空对象；不套用旧执行元数据、准备记录或计量结算逻辑。

```sql
CREATE TABLE api_model_configs (
    id             TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL,
    provider_id    TEXT NOT NULL,
    model_id       TEXT NOT NULL,
    credential_ref TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE presets (
    id          TEXT PRIMARY KEY NOT NULL,
    type        TEXT NOT NULL CHECK(length(trim(type)) > 0),
    name        TEXT NOT NULL CHECK(length(trim(name)) > 0),
    description TEXT,
    config_json TEXT NOT NULL
                CHECK(json_valid(config_json) AND json_type(config_json) = 'object'),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(type, name)
);

CREATE TABLE worlds (
    id                          TEXT PRIMARY KEY NOT NULL,
    spec_version                TEXT NOT NULL,
    name                        TEXT NOT NULL,
    description                 TEXT,
    cover                       TEXT,
    characters_json             TEXT NOT NULL
                                CHECK(json_valid(characters_json) AND json_type(characters_json) = 'array'),
    openings_json               TEXT NOT NULL
                                CHECK(json_valid(openings_json) AND json_type(openings_json) = 'array'),
    lorebook_json                TEXT CHECK(lorebook_json IS NULL OR json_valid(lorebook_json)),
    state_definition_json       TEXT CHECK(state_definition_json IS NULL OR json_valid(state_definition_json)),
    message_render_json         TEXT CHECK(message_render_json IS NULL OR json_valid(message_render_json)),
    components                  TEXT CHECK(components IS NULL OR (json_valid(components) AND json_type(components) = 'array')),
    stage_component             TEXT,
    extensions_json             TEXT CHECK(extensions_json IS NULL OR json_valid(extensions_json)),
    default_preset_id           TEXT REFERENCES presets(id) ON DELETE RESTRICT,
    default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    state                       TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
);

CREATE TABLE world_tags (
    world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK(length(trim(name)) > 0),
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(world_id, name)
);

CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY NOT NULL,
    world_id            TEXT NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
    preset_id           TEXT NOT NULL REFERENCES presets(id) ON DELETE RESTRICT,
    api_model_config_id TEXT NOT NULL REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    user_character_id   TEXT NOT NULL,
    tip_entry_id        TEXT,
    title               TEXT,
    state               TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
    usage_json          TEXT CHECK(usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE TABLE entries (
    id           TEXT PRIMARY KEY NOT NULL,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_id    TEXT,
    run_id       TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    type         TEXT NOT NULL CHECK(type IN ('message', 'compaction')),
    role         TEXT,
    timestamp    INTEGER NOT NULL,
    payload      TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'),
    state        TEXT CHECK(state IS NULL OR (json_valid(state) AND json_type(state) = 'array')),
    ext_data     TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ext_data) AND json_type(ext_data) = 'object'),
    metrics_json TEXT CHECK(metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json) = 'object')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE(session_id, seq),
    CHECK(
        (type = 'message' AND role IN ('user', 'assistant') AND role IS NOT NULL)
        OR (type = 'compaction' AND role IS NULL)
    )
);

CREATE TABLE app_settings (
    id                          INTEGER PRIMARY KEY CHECK(id = 1),
    default_preset_id           TEXT REFERENCES presets(id) ON DELETE RESTRICT,
    default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
);

CREATE INDEX idx_worlds_updated ON worlds(updated_at, id);
CREATE INDEX idx_world_preset ON worlds(default_preset_id);
CREATE INDEX idx_world_model ON worlds(default_api_model_config_id);
CREATE INDEX idx_world_tags_name ON world_tags(name, world_id);
CREATE INDEX idx_presets_type_created ON presets(type, created_at, id);
CREATE INDEX idx_sessions_world_updated ON sessions(world_id, updated_at, id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at, id);
CREATE INDEX idx_session_preset ON sessions(preset_id);
CREATE INDEX idx_session_model ON sessions(api_model_config_id);
CREATE INDEX idx_entries_parent ON entries(session_id, parent_id);
CREATE INDEX idx_entries_run ON entries(session_id, run_id, seq);
CREATE INDEX idx_entries_role ON entries(session_id, role, seq);
```

已落实文本主键 NOT NULL、entries 所属 session 外键、world_tags 随世界级联删除、Repository 显式时间写入。上述结构只在 V2 独立库生效。

parent_id、tip_entry_id 的同会话、祖先链与无环约束由历史操作校验，单个外键不能替代这些规则。run_id 暂作为条目分组标识，没有隐含 runs 表；其最终生命周期在叙事模块迁移时定义。

## 9. 数据库生命周期与兼容边界

- 默认数据根目录为仓库下 `runtime/server-v2/`，CLI 可通过 `SERVER_V2_DATA_ROOT` 指定；库文件为 `<dataRoot>/database.sqlite`。
- V2 使用 `user_version=1` 和独立 `application_id=0x53525632`，打开既有库时检查标识、版本与目标结构。
- 只有全空且未设版本/标识的数据库可以初始化。旧库、其他应用库或缺损 V2 结构明确报错，不自动重置、修复或迁移。
- 连接启用外键、WAL 和 busy_timeout；所有 Repository 借用启动装配方持有的连接。仅在所属 Repository 内对本模块数据做必要原子写入，不建立跨模块强一致性事务。
- 会话 Route 经 SessionService 检查 SSE 会话存在性；事件传输层仍不查询数据库。自定义访问适配器可接入额外权限规则，但不能代替真实会话检查。
- 监听启动失败会关库；服务关闭时先结束 SSE 和 HTTP，再关闭数据库，close 可重复调用。
- 新库仅初始化空默认选择的 app_settings 单例，不复制旧预设、用户配置、UsageStore 或 recoverInterrupted。
- 内容变更显式更新 updated_at；状态写入只更新目标 scope 所在行，计量写入不改显示 timestamp 或会话列表时间。
- 世界删除已实现 DB 先删及文件清理重试；导入、更新与文件协作随后续世界业务实施，不引入通用事务协调体系。

## 10. 本期实施结果与后续边界

已完成：

1. **数据库基础**：独立 V2 版本、目标 7 表、默认设置单例、外键/JSON 约束、事务及无损 JSON 编码。
2. **预设、模型、设置**：各模块 Service、类型化叙事配置、模型凭据引用、默认选择与引用编排；Repository 模块内私有。
3. **世界**：世界内容、配置引用、world_tags、目录推导、原件字节基础操作及安全删除清理；内容更新不覆盖运行状态。
4. **会话与消息**：会话 Service、消息/摘要和线性历史；仅当前 tip 可追加，entry、seq 分配与 tip 推进原子完成。
5. **状态与计量**：StateService 编排三种 scope 快照及 NULL 沿前驱继承，状态 SQL 归所属 World/Session Repository；独立计量写入及同会话 requestId 唯一归属。
6. **启动装配与边界**：显式 Service 依赖图、严格三层单向调用、启动连接生命周期、重启读取和 HTTP/SSE 集成；lint 检查唯一模块出口、反向依赖、事务位置和 SQL 归属。
7. **HTTP**：六个业务适配器及统一 success/errorCode/errorMessage/data 响应；Service 返回驼峰领域对象，route 按 Studio 消费契约构建列表/详情及跨模块投影，HTTP 游标与领域分页分离；错误码与中文信息绑定，SSE/文件成功响应保留原始流。

验证命令：`pnpm --filter @sillyrealms/server-v2 test`、`typecheck`、`lint`。测试只使用内存或临时 SQLite、临时文件目录与回环 HTTP，不访问真实模型或旧用户数据库。

后续仍需独立实施：世界 ZIP 导入导出业务、世界卡领域解析、状态规则解释及按路径更新、叙事/模型调用迁移、无 entry 请求的计量落点与查询、累计计量及上下文估算读取位置、旧数据导入和 Studio 切换。这里没有通过建表承诺这些能力已完成。

## 11. 旧实现核对依据

- `apps/server/src/infrastructure/database/database.ts`：旧 v7 表、约束和更新时间触发器。
- `apps/server/src/runtime/persistence/usage-store.ts`：RequestMetrics、entry 计量三种形状、pendingRun 与结算副作用。
- `apps/server/src/runtime/context/context-manager.ts`：latestContext.baseline 参与上下文准备。
- `apps/server/src/runtime/persistence/run-store.ts`：branch_count 写入、准备记录与消息间交接。
- `apps/server/src/infrastructure/world-files/world-file-store.ts`：旧原始文件名与路径保存规则。
- `apps/server/src/routes/worlds.ts`：原始文件下载、校验及导出命名。
- `apps/server/src/domain/preset/schema.ts`：旧叙事预设专属结构。

旧实现保持原状；本期实现事实以 `apps/serverV2/src/` 的代码、类型与测试为准。
