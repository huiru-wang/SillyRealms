# Server V2 存储方案 v1

- 日期：2026-11-18（Asia/Shanghai）。
- 状态：设计快照，未实施；DDL 是目标草案，不是当前数据库结构，也不是升级脚本。
- 实施位置：`apps/serverV2`，按业务模块逐步迁移，不预建 engine 或通用任务体系。
- 本版记录已确认的取舍，并明确仍需在对应模块实施前决定的细节。
- 与旧文档的关系：`sr-server-architecture.md`、`sr-narrative-state-migration-v1.md` 中有关旧 v7 原样保留、engine/tasks 和事件目录的安排，不作为 V2 本次存储实施要求。当前事件模块位于 `apps/serverV2/src/events/`，不生成事件 ID。
- 本次仅新增本方案文件；未修改业务代码、用户配置或数据库。

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

以下属于本版建议，不能误称为用户已单独确认的决定：

- 删除 `entries.branch_count`：当前实现只将前一个可见条目标记为 1，并非真实分支计数；保留父子历史关系。
- 保留三种状态 scope 与格式版本信息；命名在本版暂沿用 `state`、`spec_version`，不自行扩大重命名范围。
- V2 使用独立数据库文件和独立结构版本，不让旧 Server 与 V2 对不同结构共用写入同一文件；旧数据导入单独安排。
- 同类型预设名称唯一，采用 `UNIQUE(type, name)`。

## 2. 模块及数据所有权

Repository 放在所属业务模块内，提供具体的数据访问函数；不按表集中建立万能 Repository，也不先拆接口与多种实现。

```text
apps/serverV2/src/
  database/
    connection.ts           # 连接、结构版本与初始化入口
  worlds/
    repository.ts           # 世界定义、配置引用、world_tags
    files.ts                # 世界文件固定路径与读写规则，迁移时再建立
  sessions/
    repository.ts           # 会话、消息、摘要、历史关系
  presets/
    repository.ts           # 类型化预设
  models/
    repository.ts           # 模型连接配置
  settings/
    repository.ts           # 应用默认选择
  state/
    repository.ts           # 状态读写，迁移状态模块时再建立
  events/                   # 已实现；不依赖数据库
```

以上为模块归属，不要求下一批一次创建全部目录。当前实际运行情况以代码为准。

- 一个业务 Repository 可以跨表；同一表的不同字段可以归不同业务能力，但不得整行覆盖其他能力的数据。
- World 管理状态定义；State 管理解释规则和运行状态。世界/会话首次创建时，可以将状态模块算好的初值一起 INSERT。
- 会话拥有 entries 的内容和历史关系；计量字段的写入规则在计量能力迁移时确定，不因保留列就复制旧 UsageStore。
- 模块通过公开能力协作。世界页面的会话列表、预设详情、模型详情由接口用例组合，不放入 WorldRepository。
- 数据库连接由启动装配方创建和关闭，Repository 不自行持有另一份连接生命周期。

## 3. 世界文件：固定路径，不保存 source_file_path

### 3.1 可直接确定的部分

世界目录由服务端数据根目录和世界 ID 确定，例如：

```text
<dataRoot>/worlds/<worldId>/
  source/                   # 可选的原始导入文件
  package/                  # 提取或整理后的资源
```

- 目录规则统一收口在世界文件模块，不由路由、Repository 各自拼接。
- 使用服务端生成并校验的世界 ID；资源路径仍需限制在所属世界目录内。
- 世界名称、上传文件名不参与世界根目录定位。
- 导出包由当前世界内容和资源构建，不依赖原始文件名。
- 不增加一个 JSON 元数据文件来变相保存已经决定删除的 path/kind/hash/warnings。

### 3.2 源文件表示建议，待文件模块实施时定稿

如果继续保留“下载原始文件”能力，可采用固定文件名：

```text
source/original.json        # JSON 原文件
source/original.zip         # ZIP 原文件
```

同一世界最多保留其中一种；没有源文件也可以是有效世界。读取通过固定候选名确定格式，不能任意扫描后取第一个文件。两种文件同时存在应视为存储异常。原始上传文件名不再承诺保留。

删除数据库路径字段只要求固定定位，不自动意味着取消原始字节保存；是否继续提供原文件下载，在迁移世界文件模块时明确。不得把重新导出的包称为原始文件。

删除 source_sha256 后，不再执行旧的持久化哈希比对；导入时的包结构、路径和内容校验仍按实际需要保留。导入告警只作为当次操作结果，不长期挂在 worlds 上。

## 4. 状态字段的含义

| 字段 | 含义 |
|---|---|
| `worlds.state_definition_json` | 世界卡中的变量定义、初值、scope 和校验规则 |
| `worlds.state` | global scope 的当前值，同世界下会话共享 |
| `sessions.state` | session scope 的当前值 |
| `entries.state` | message scope 的历史状态快照；NULL 表示沿来源消息祖先链继承 |

本版不删除 global scope，也不将运行中的当前值反写为世界卡初值。用户询问 state 的用途，不等于确认取消该能力。

为了不顺带变更消息状态编码，DDL 草案暂保留 worlds/sessions 的 JSON object 和 entries 的 JSON array。未来是否统一编码、是否改名 `global_state_json`，在 State 模块迁移时决定。

`spec` 固定类型标识可以删除；格式版本仍有识别导入格式的用途。本版暂保留 `spec_version`，是否改名 `format_version` 未定稿。数据库结构版本与世界卡格式版本分别管理。

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

### 5.3 精简结构候选，尚未冻结

优先采用一种形状表示附属于该 entry 的调用，而不是按 user/assistant/compaction 使用不同外壳：

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

这是讨论用的精简候选，不是已批准的最终 JSON Schema：

- requestId 用于区分真实模型调用；它不是 SSE 事件 ID。
- usage 可为 null，表示未取得提供方计量；耗时字段按实际可用性记录。
- 不在 user entry 再保存一份相同请求的整轮汇总，避免多个副本重复计费。
- phase、模型配置引用、时间戳、上下文预算等字段是否保留，需要由具体展示、查询和算法消费者证明用途。
- 总量可以由关联记录求和；如确有累计缓存需求，再明确失效和重算规则。本版不复制旧 pendingRun/accounted 机制。

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
- 本版建议配置内部保留 schema_version，以独立演进不同类型的配置。
- 世界、会话、应用中现有 preset 引用暂仍表示叙事默认选择，写入时检查 type=narrative。具体字段是否重命名，迁移该模块时处理。
- model_parameters 表示该预设的生成参数；模型连接、提供方及凭据引用仍归模型配置模块。

## 8. 目标 DDL 草案

共 7 张业务表：worlds、world_tags、sessions、entries、presets、api_model_configs、app_settings。没有 run_preparations、runs、tags、tag_assignments，也没有触发器。

DDL 只用于审阅。除上述明确变更外，未评估字段暂保留；保留列不代表照搬旧逻辑。特别是 sessions.usage_json 的内容及 entries.ext_data 中原执行元数据尚未定稿，不能直接套用旧 JSON 默认值。

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

DDL 中额外建议的结构收敛：文本主键明确 NOT NULL；entries 增加所属 session 外键；world_tags 删除世界时级联清理；时间值由 Repository 在实际写操作中提供。上述建议仍需随模块验收，不作为修改旧库的授权。

parent_id、tip_entry_id 的同会话、祖先链与无环约束由历史操作校验，单个外键不能替代这些规则。run_id 暂作为条目分组标识，没有隐含 runs 表；其最终生命周期在叙事模块迁移时定义。

## 9. 数据库生命周期与兼容边界

- 建议 V2 独立目录、独立数据库文件及自己的 user_version。初始版本号在真正落地时确定，不冒充旧 v7。
- 旧库只读查询可用于核对或后续导入，但不再将“所有模块原样兼容旧 v7”作为本次目标。
- 连接初始化启用外键，版本不兼容时明确报错；不自动重置、清空或改造旧用户数据库。
- 不通过导入旧 Server 的 createSchema/recoverInterrupted 获取新库能力，它们包含已被本版否决或暂缓的逻辑。
- 数据库与世界文件的导入、更新、删除一致性，在对应模块实现时设计，不借本次计划引入通用事务协调体系。
- 普通业务内容变更显式更新 updated_at；计量更新是否影响消息内容的显示时间，应由对应查询语义决定。

## 10. 后续任务与验收（按批推进）

1. **数据库基础**：按已定稿部分建立 V2 连接与结构版本机制；临时数据库验证 DDL、外键与约束。不得对旧库直接执行本文件。
2. **预设模块**：落实 type 与分型 config 校验；迁入 context_strategy/model_parameters，移除预设标签；验证叙事默认引用不能指向其他类型。
3. **世界模块**：落实已确认字段删除、world_tags 和固定文件布局；同步世界卡导入导出契约，验证无数据库路径仍能正确定位资源。
4. **会话与消息模块**：迁移会话读取及历史关系，再接实际 SSE 会话检查；实现前确定 branch_count 删除、状态编码和 metrics_json 的相关待决项，不加入准备任务表。
5. **计量与配置收口**：按实际消费者冻结 metrics JSON、决定无 entry 调用的处理方式；模型配置与设置随各自使用场景迁移。验证未知用量、关联归属和累计口径，不能把暂未支持的恢复能力标为已完成。

每批只推进当批模块，遇到实际边界问题再决策；不以本版 DDL 一次建全表或搬完整 Server 作为完成标准。

## 11. 当前实现依据

- `apps/server/src/infrastructure/database/database.ts`：旧 v7 表、约束和更新时间触发器。
- `apps/server/src/runtime/persistence/usage-store.ts`：RequestMetrics、entry 计量三种形状、pendingRun 与结算副作用。
- `apps/server/src/runtime/context/context-manager.ts`：latestContext.baseline 参与上下文准备。
- `apps/server/src/runtime/persistence/run-store.ts`：branch_count 写入、准备记录与消息间交接。
- `apps/server/src/infrastructure/world-files/world-file-store.ts`：旧原始文件名与路径保存规则。
- `apps/server/src/routes/worlds.ts`：原始文件下载、校验及导出命名。
- `apps/server/src/domain/preset/schema.ts`：旧叙事预设专属结构。

本版不声称这些旧实现已经修改；后续以 V2 实际代码、类型与测试为实现事实。
