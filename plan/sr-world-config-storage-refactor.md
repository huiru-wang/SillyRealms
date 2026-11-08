# SillyRealms 世界卡存储与配置关联重构计划

> 状态：**方案已确认，待执行代码重构**
> 类型：**破坏性重构（Breaking Change）**
> 范围：Server / SQLite / Agent / Web；World Card 外部规范 `world_card@0.1` 不变。
> 基准：2026-11-08 当前 SR V1 / SQLite / `agent/{runtime,context,model,tools,persistence}` 分层。
> 用户明确决定：**不兼容旧数据库、历史数据、旧代码调用、旧前端接口；允许彻底清理 SR 旧数据和重建数据库。**
>
> 本文档是执行计划，**仅保存计划本身不等于已执行重构或删除数据**。后续按本计划实施时，无须为旧格式编写迁移逻辑、双读双写、兼容路由或兼容前端。

## 0. 目标与决策总览

目标：把“预设绑定模型”的链式关联改成独立的“应用默认 → 世界卡默认 → 会话最终配置”，让导入世界卡、创建会话、Agent 生成始终具有一致明确的配置来源；同时将原世界卡文件保存到本地工作区，数据库按世界卡 `data` 顶层字段结构化存储。

### 核心决定（不可回退到旧方案）

1. **新增 `app_settings` 单例表**，直接保存应用默认 `default_preset_id` 和 `default_api_model_config_id`。不通过“当前列表首项”猜测默认；不另外引入通用 Key/Value 配置系统。
2. **Preset 不再存储或引用 API Model Config**。保留 Prompt 节点、摘要策略、上下文预算、输出预算和生成策略参数；`api_model_config_id` 从预设数据结构、导入导出和 Web 编辑器中完全移除。
3. **World 保存默认预设 + 默认模型两个独立引用**，导入时从 `app_settings` 拷贝初始值；世界关联变动只影响未来会话。
4. **Session 保存 `preset_id` + `api_model_config_id` 两个独立引用**；创建时从 World 复制，后续可在会话设置独立修改。**Agent 不再从预设或世界卡中推导模型**。
5. **World Card 原文件留档，DB 存结构化运行数据**。`data` 的固定顶层字段拆成独立 SQL 列，数组/对象分别存 JSON 列；不再保存整张 `data_json`。Tags 继续使用已有关系表。
6. **没有旧数据兼容义务**：直接替换表结构、API 请求响应和 Web 消费方；旧数据库通过显式重置/重建处理，不做 `ALTER TABLE` 升级、旧数据映射、旧文件重建或旧 API 别名。
7. **保留正确的运行时安全语义**：Local-first；SQLite/Server 为权威；运行中禁止改会话配置；流式消息先持久化再通知；事件和 iframe/SDK 边界不变。
8. **本次不做 Token 统计、世界卡版本体系、角色/世界书细粒度关系表、模型配置快照或新 Provider 架构**。后续功能利用本次建立的关联边界扩展即可。

### 关联关系

```text
app_settings（全局默认）
  ├─ default_preset_id ────────────┐
  └─ default_api_model_config_id ─┐│
                                  ││  导入世界卡时复制
worlds                           ││
  ├─ default_preset_id <──────────┘│
  └─ default_api_model_config_id <─┘
       │
       │ 创建会话时复制并验证，不保留动态继承
       ▼
sessions
  ├─ preset_id ────────────────> presets（Prompt/策略，不含模型 ID）
  └─ api_model_config_id ──────> api_model_configs（Provider/Model/Key Ref）
       │
       ▼
ContextManager → PreparedRun → AgentRunner / ModelClient
```

**关联 ID 与对象内容的语义**：世界修改关联不会修改既有会话；会话只保存 ID，不复制预设或 API 模型配置完整快照。编辑共享的预设或模型配置内容会影响引用它的会话的下一次 Run。这与“配置关联 ID 冻结”不同，必须在 UI 和测试中明确。

## 1. 数据存储设计

### 1.1 应用配置：`app_settings`

单例、固定 `id=1`。不另建 `global_defaults` 表，也不在 `World` 查询时做全局配置运行时回退。

```sql
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  default_preset_id TEXT REFERENCES presets(id) ON DELETE RESTRICT,
  default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- 初始化 DB 时插入唯一记录；服务端统一读取与修改 `id=1`。
- 首次使用：提供一个普通的“标准叙事预设”初始化选项（可在首次初始化时直接种入默认普通预设，不引入旧版 `is_builtin` 兼容字段），并关联为默认预设；**不生成假 API 模型配置或假密钥**。
- API 模型配置须由用户真实创建。创建首个有效 API 模型配置且应用默认为空时，可自动选为默认并在 UI 显示；后续新增配置不能擅自覆盖已有默认。
- 若某项默认仍为空，允许导入世界卡，但世界会标记“未配置完整”，创建会话前必须补齐。
- 修改应用默认只影响**之后导入**的世界卡，不自动改已有 World 或 Session。
- 应用默认关联对象被引用时，删除操作应拒绝并告知引用数量。不能无提示把默认值清空。
- 对外：`GET /api/v1/app-settings`、`PATCH /api/v1/app-settings`；响应字段 `defaultPresetId` / `defaultApiModelConfigId`。

### 1.2 预设：`presets`

保留 `presets(id,name,config_json,created_at,updated_at)` 作为 Prompt 与执行策略聚合，不为每个节点建立关系表。

```ts
type Preset = {
  name: string;
  description?: string;
  model_parameters?: { temperature?: number }; // 运行策略，不是模型关联
  budget: { max_context_tokens?: number; max_output_tokens: number };
  summary_prompt: string;
  nodes: PresetNode[];
  // 无 api_model_config_id
};
```

- 从创建、更新、读取、导入、导出接口及 Web 预设编辑器**彻底移除** `api_model_config_id`；严格 Schema 对旧字段直接拒绝即可。
- `temperature`、预算保留，属于预设的推理策略；实际模型的 `maxTokens/contextWindow` 仍须在 Run 准备阶段校验预算可行性。
- 删除预设：若被应用默认、任何 World 或任何 Session 引用，返回 409 `CONFIG_IN_USE`；未引用则删除。保留节点排序/校验约束。
- API 模型配置同理：被引用则拒绝删除；只有不再被引用时才删除配置及对应的 Keychain 凭据。应用设置持有的是模型配置 ID，不是密钥。

### 1.3 世界卡：`worlds`

采用“一张 World 表 + 各顶层复合数据 JSON 列”。**不再保存整个 `data_json`，也不把每位角色、世界书条目拆成独立表**。

目标逻辑表（完整建表时为所有 JSON 列添加 `json_valid`/类型 `CHECK` 和必要索引）：

```sql
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL CHECK(spec = 'world_card'),
  spec_version TEXT NOT NULL CHECK(spec_version = '0.1'),

  name TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  cover TEXT,

  characters_json TEXT NOT NULL,            -- data.characters
  openings_json TEXT NOT NULL,              -- data.openings
  lorebook_json TEXT,                        -- data.lorebook
  state_definition_json TEXT,                -- data.state（定义）
  message_render_json TEXT,                  -- data.message_render
  ui_json TEXT,                              -- data.ui
  extensions_json TEXT,                      -- data.extensions

  default_preset_id TEXT REFERENCES presets(id) ON DELETE RESTRICT,
  default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,

  state TEXT NOT NULL,                       -- World global 运行值，非定义
  source_file_path TEXT,                     -- 相对数据根目录的路径
  source_sha256 TEXT,
  source_kind TEXT NOT NULL,                 -- imported | generated
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

具体规则：

- `data.name`、`summary`、`description`、`cover`：直接标量列。
- `data.characters`、`openings`、`lorebook`、`state`、`message_render`、`ui`、`extensions`：各自 JSON 列；缺省值统一约定 `NULL`，导出时按规范恢复缺省或显式 `null`。
- `spec`/`spec_version` 单独保留；根对象 `data` 与 DB 字段由 Repository 双向转换。
- Tags 不重复存于 `worlds`，仍由 `tags` / `tag_assignments` 管理；卡片导入时 tags 分离，导出时组装回 `data.tags`。
- `state_definition_json` 是字段声明；现有 `state` 是 World global 当前运行状态；两者严格独立，创建 Session 时使用定义初始化 session/message 状态。
- 关联字段命名统一使用 `default_*`，避免误把 World 默认值当成当前 Session 的实际值。
- 可为默认预设、默认模型、更新时间建立索引。
- 保持现有 World Card 外部结构 `{spec,spec_version,data}` 和 `parseCard()` 校验；外部格式与内部物理存储不是一回事。

### 1.4 会话：`sessions`

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE RESTRICT,
  api_model_config_id TEXT NOT NULL REFERENCES api_model_configs(id) ON DELETE RESTRICT,
  user_character_id TEXT NOT NULL,
  tip_entry_id TEXT,
  title TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- `preset_id`、`api_model_config_id` 均为必填。**未配置完整就不允许创建 Session**，但允许导入 World。
- 创建 Session 时仅在 Server 内原子复制两个 World 默认 ID，并验证关联对象仍存在、模型凭据可读取。无需付费模型 API 探测。
- Session 创建成功后，它与 World 默认关联**脱钩**；后续 World 默认变化不会更新已有 Session。
- 会话设置可同时或独立更新两项关联；运行中返回 `SESSION_BUSY`，必须待当前 Run 结束/停止后才允许保存。
- 每次 Run 的 `ContextManager` 从 Session 分别读取预设和模型配置；摘要与主生成统一使用本次 PreparedRun 确定的模型。
- 不做“Session 为空就回退 World 或 App 默认”的兼容行为；Session 数据必须满足自身关联完整性。
- Session 当前分叉、Run 历史、Entries、状态快照等既有领域保持不变，除关联读取处以外不做重写。

### 1.5 DB 初始化与破坏性重建

- 直接重写 `openDatabase` 的新建库 Schema：`PRAGMA foreign_keys=ON`、WAL、检查约束、事务创建、索引；不编写升级旧表的迁移脚本。
- 移除只为旧结构服务的旧表检查、旧字段、旧代码分支及旧前端参数。**没有双读双写、旧数据导入、隐藏回退**。
- 旧数据库**必须显式停服后重置**，然后首次启动创建新表，不能每次启动“自动 DROP”已存在的数据。
- 可提供仅针对 `SILLYREALMS_DATA_DIR`/SR 管理目录的明确重置命令。重置 SQLite 时要处理 `-wal`/`-shm` 文件，并清理世界卡 `workspaces/worlds` 的关联文件；是否清理 Keychain 中原配置的凭据必须单独清晰提示并按已记录 credential_ref 定向处理，不能无差别擦除 Keychain。
- 不删除仓库外任意其他文件夹、项目源码、非 SR 文件。该授权仅针对 SR 旧数据与既有兼容层。
- 测试只能使用临时数据库和临时工作区，绝不依赖或破坏真实用户运行目录。
- 既然明确放弃历史数据，**不需要** `schema_migrations`、备份恢复/旧数据反填与 Legacy World `reconstructed` 来源记录。

## 2. 原始文件工作区

```text
SILLYREALMS_DATA_DIR/
├── sillyrealms.sqlite
└── workspaces/
    └── worlds/
        └── {worldId}/
            ├── source/
            │   └── original.json
            └── assets/          # 预留，不在本次增加媒体同步
```

- `original.json` 保存上传文件的**原始字节**，不保存 `JSON.stringify(parseCard(...))` 的重构内容；留档不可变。
- `source_file_path` 只存由 Server 生成的相对路径，不接受客户端任意路径；`source_sha256` 保存哈希校验值。
- 存储服务统一接受 `worldId` 和原始文件字节，做路径固定化、字节长度限制（沿用现有 10 MiB）、哈希、临时写入、原子重命名与权限限制（0700 目录、0600 文件）。
- 导入步骤：校验解析 → 生成 UUID → 原始文件安全写入临时目录并原子迁入 World 工作区 → SQLite 事务写 World 字段、关联默认值和标签 → 提交。数据库提交失败时尽量删除新建文件；崩溃留下的孤立文件采用受限清理机制，不影响已有 World 文件。
- 删除 World：沿用删除时停止关联 Run 的规则，先在事务中处理 Session/Entry/Tag/World，再安全删除专属工作区。文件删除失败要可检测、可重试；禁止按用户传入路径递归删除。
- `GET /v1/worlds/:id/export` **从数据库字段重建最新当前 World Card**，适用于编辑后导出。
- `GET /v1/worlds/:id/source` 下载原始导入文件；新创建的卡若尚无来源文件，返回明确的 404/状态错误。
- 原始文件不作为运行时读取来源；Server / Agent / Web 始终使用数据库结构化数据。
- 不在 Creator iframe、SDK 或浏览器响应中暴露本地绝对路径。用户创作 UI 的资源规则与 iframe 隔离仍保留。

## 3. Repository 与代码边界

建议新增：

```text
apps/server/src/
├── domain/
│   └── world-card.ts                 # 规范 Schema、纯校验、WorldCard 类型
├── repositories/
│   └── world-repository.ts           # world row ↔ WorldCard；SQL CRUD/组装
├── infrastructure/
│   ├── database/database.ts          # 新 Schema 初始化，不兼容旧 DB
│   └── world-files/world-file-store.ts # 文件留档/读取/清理
├── routes/
│   ├── app-settings.ts               # GET/PATCH 全局默认
│   ├── worlds.ts                     # 导入、关联、导出、来源、删除
│   ├── sessions.ts                   # 创建、读写会话独立配置
│   ├── presets.ts                    # 移除模型字段
│   └── providers.ts                  # 模型配置关联删除保护与默认初始化
└── agent/
    ├── context/context-manager.ts   # 独立加载 session.preset_id / model_config_id
    └── persistence/run-store.ts      # 通过 WorldRepository 获取 World
apps/web/src/
├── main.tsx                          # 世界卡与预设编辑、全局应用设置入口
└── host.tsx                          # Session 设置中的模型/预设选择
```

职责要求：

- `WorldRepository` 是 WorldCard 对象和 SQLite 行转换的唯一入口；不能在 routes、`ContextManager` 或 `SessionHost` 再写 `JSON.parse(world.data_json)`。
- `WorldFileStore` 专管文件系统；不让 Hono route 直接拼装任意磁盘路径。
- `AgentContextManager` 通过 RunStore / WorldRepository 读有效世界卡，不感知物理 JSON 列。
- Server 运行时与 Hono 在现有 V1 上更新契约，**不保留旧字段别名**。
- 不引入额外 ORM、泛型 Repository 框架、DI 容器、复杂世界状态版本系统。

## 4. API 契约（新 V1 一次性替换）

| API | 目标 |
| --- | --- |
| `GET /api/v1/app-settings` | 读取 `defaultPresetId`, `defaultApiModelConfigId` 和关联有效性 |
| `PATCH /api/v1/app-settings` | 部分更新默认预设/模型，校验 ID；空值 `null` 表示未配置 |
| `POST /api/v1/worlds/import` | 校验卡、保存原始文件、按 `data` 顶层字段拆库存储，复制 App 默认关联 |
| `GET /api/v1/worlds` | 世界列表返回 `defaultPresetId`、`defaultApiModelConfigId` 和配置完整性（可选） |
| `GET /api/v1/worlds/:id` | 由 DB 重建 `item.data`，独立返回两个默认关联 ID |
| `PATCH /api/v1/worlds/:id` | 接受 `defaultPresetId?` / `defaultApiModelConfigId?`；修改仅影响未来会话 |
| `GET /api/v1/worlds/:id/export` | 由数据库字段重建并导出当前 World Card JSON（不携带本地关联 ID） |
| `GET /api/v1/worlds/:id/source` | 原始导入 JSON 下载 |
| `DELETE /api/v1/worlds/:id` | 删除关联会话/Entries/Tags/World 并清理工作区 |
| `POST /api/v1/sessions` | 仍接收 worldId / openingId / userCharacterId / title；服务端从 World 复制并校验两个关联，缺任一则 422 |
| `GET /api/v1/sessions/:id` | 返回 `presetId`、`apiModelConfigId` |
| `GET /api/v1/sessions` | 每项增加两个配置关联字段，列表封面来自结构化 `cover` |
| `PATCH /api/v1/sessions/:id` | 支持 `presetId?` / `apiModelConfigId?`；非空且必须存在；运行中 409 |
| `POST/PATCH /api/v1/presets` | Schema 删除 `api_model_config_id`；只处理 Prompt/策略 |
| `POST /api/v1/presets/import` | 新格式严格校验，不兼容含旧模型关联的预设导入 |
| `GET /api/v1/presets/:id/export` | 输出无模型关联的新预设结构 |
| `DELETE /api/v1/presets/:id` | 被 App、World、Session 任一引用时 409 `CONFIG_IN_USE` |
| `DELETE /api/v1/api-model-configs/:id` | 同样检测引用，允许删除时才处理凭据 |

错误要求：

- 缺默认关联：`WORLD_CONFIG_INCOMPLETE`（422，指出 `presetId` / `apiModelConfigId` 缺失项）。
- 关联无效：对应 `PRESET_NOT_FOUND`、`API_MODEL_CONFIG_NOT_FOUND`（422/404 按端点语义）。
- 模型未配置凭据：`CREDENTIAL_NOT_CONFIGURED`（422）；不因此发起付费的测试调用。
- 有运行任务：`SESSION_BUSY` / `WORLD_BUSY`（409）。
- 删除被引用配置：`CONFIG_IN_USE`（409，返回 App/World/Session 的关联数量）。
- 旧字段传入：Schema 直接拒绝，不加静默兼容分支。
- 不改变已存在的 `Run`、SSE、State SDK 公开协议与 Creator iframe 安全边界。

## 5. Web 交互规格

### 5.1 应用设置（新增“默认运行配置”区域）

- 导航：在现有“设置”页（若目前只是占位则实现最小设置页）增加“默认预设”“默认 API 模型”两个下拉框。
- 数据来自 `GET /v1/app-settings` + 预设列表 + API 模型配置列表，保存到 `PATCH /v1/app-settings`。
- 首次没有模型时显示“尚未配置 API 模型”，提供跳转模型配置页；绝不能显示假的模型可用状态。
- 保存后说明“仅影响此后导入的世界卡；已有世界和会话不会自动改变”。

### 5.2 世界卡库与详情

- 导入时复制应用默认配置到 World，导入操作**不因默认不完整而失败**。
- 世界卡详情展示独立的“默认预设”“默认 API 模型”，从 World 字段读取，修改即保存。
- 明确标注“用于新建会话，不影响已有会话”。
- 缺任一配置时显示配置缺失提示；“开始会话”禁用并引导选择。Server 同步执行校验，避免 UI 绕过。
- 一旦配置完整，原开局/玩家角色选择和启动链路保持一致。
- 原世界卡/当前世界卡分别提供下载入口，避免混淆。

### 5.3 会话 Host

- 平台“会话设置”中展示标题、预设、API 模型两个独立控件；修改后调用 Session PATCH。
- 保存成功后继续当前 Session，无须重建/重载世界卡；下一轮 Run 使用新配置。
- Run 活跃或发送中禁用设置保存；错误时提示且不提前把 UI 当成已保存。
- 当前配置缺失不应存在于新会话；若运行时配置被破坏，则发送前明确错误，不能产生“已生成”假象。
- 官方 Creator UI 和自定义 iframe 不持有 Key 或修改配置的直接权限；设置属于 Host。

### 5.4 预设编辑页

- 移除模型选择器及相关状态、校验、保存参数。
- 保留模型参数中的温度及 Token 预算输入，但文案改为“生成策略”，不再描述为模型绑定。
- 预设管理中的导入导出只处理预设能力。

## 6. 运行时加载流程

在 `agent/context/context-manager.ts` 的一次 `prepare()` 中：

1. 从 `RunStore.session(sessionId)` 读取 Session；确认 `preset_id` / `api_model_config_id` 均非空且有效。
2. 从 Preset Repository / DB 读取 Prompt 编排、摘要策略、预算；不查询任何预设关联模型。
3. 从 `api_model_configs` 读取 `provider_id`、`model_id`、`credential_ref`，通过 CredentialStore 取密钥，`ModelClient.resolve()` 获取模型。
4. 通过 `WorldRepository` 获取 WorldCard data；原 context、激活、状态校验和历史压缩逻辑保持语义一致。
5. 根据模型实际 context window/max tokens 和预设预算校验可执行性。
6. 构造 `PreparedRun`，主生成与压缩都绑定同一选定模型；`AgentRunner` 不再从 World/预设推断模型。
7. 在运行期间禁止会话配置修改，从而避免同一个 Run 的多次模型请求漂移。

关联路径：`Session.preset_id → Preset` 与 `Session.api_model_config_id → ApiModelConfig` 独立查询、最终在 PreparedRun 汇合。

## 7. 破坏性重构执行任务（按依赖顺序）

> 所有任务属于同一个 Breaking Change，可按内部阶段逐步提交代码，但**不实现旧数据/旧客户端兼容**。每完成一阶段都确保可测试；测试全部使用临时数据目录。

### P0：数据结构与纯模型

- [ ] 重写 `database.ts` 目标 Schema：`app_settings`、结构化 `worlds`、独立 `sessions.api_model_config_id`、必要外键和索引，`PRAGMA foreign_keys=ON`。
- [ ] 初始化 `app_settings(id=1)`，定义标准预设首次创建策略；默认模型空值合法但新会话必须完整。
- [ ] 实现 `WorldRepository` 行数据 ↔ WorldCard 的唯一映射，保留 `parseCard` 校验与 tags 组装，不再使用 `data_json`。
- [ ] 实现 `WorldFileStore`，数据根目录可注入以支持测试，不暴露任意路径。
- [ ] 清理旧 Schema 检查、`api_model_config_id` 预设字段及所有旧模型关联逻辑。

### P1：Server 世界、默认配置、会话

- [ ] 新建 App Settings GET/PATCH 接口并在 `app.ts` 注册。
- [ ] World import / detail / list / export / source / patch / delete 迁入 Repository + FileStore，支持双默认引用。
- [ ] Session 创建时校验配置完整和凭据，原子复制 World 两个关联；Session GET/List/PATCH 统一携带模型 ID。
- [ ] Preset API 严格移除模型字段；模型配置与预设删除增加 App/World/Session 引用保护。
- [ ] 更新任何硬编码 `data_json`、旧 `presetId` 世界关联的使用点，包括 session state、字符选择、封面、运行历史。

### P2：Agent

- [ ] 修改 `ContextManager` 的预设与模型独立加载；不调整生成/摘要/工具调用顺序。
- [ ] 修改 `RunStore` 世界读取，统一转为 WorldRepository。
- [ ] 验证同一 Run 的 summary + 主生成 + 工具续写都使用 Session 的模型，World 默认变化不会影响 Run。
- [ ] 保留既有停止、错误、状态快照提交与事件顺序。

### P3：Web

- [ ] 应用设置页增加 App 默认预设/模型选择器，支持加载/保存/校验/空值。
- [ ] 世界卡详情增加独立预设、模型选择器，说明只影响新会话；不完整时禁止进入启动。
- [ ] 新建会话调用原参数即可，创建后两个关联由 Server 返回并持久化。
- [ ] Session Host 设置面板增加模型选择器并支持同时保存两种关联。
- [ ] 预设编辑器移除模型配置选择器、表单字段及旧 UI 逻辑。
- [ ] 列表数据、封面字段、关联显示文案同步适配新 API；保持 iframe/SDK 不变。

### P4：重置与验证

- [ ] 提供显式的 SR 旧数据重置路径/命令，限定 SR 数据根目录，安全处理 SQLite sidecars + world 工作区；无需历史 Schema 迁移。
- [ ] 更新 Server Vitest fixture 和 Web 消费方，全部使用目标新字段，直接删除旧格式测试，不保留旧格式分支。
- [ ] 执行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`。
- [ ] 在全新临时 DB 和临时工作区完成端到端覆盖；核查外部文件访问隔离。
- [ ] 检查敏感凭据不出现在日志、World Card 导出、iframe 消息或文件工作区。
- [ ] 检查 `git diff` 只包含本次预期变更，保留与本任务无关的工作区改动；无明确要求不 commit/push。

## 8. 测试矩阵与验收标准

| 场景 | 期望 |
| --- | --- |
| 全新安装没有 API 模型配置 | App 默认模型为空；可导入世界卡；创建会话时明确缺失提示 |
| 创建第一个可用模型配置 | App 默认可设为该模型；后续导入世界卡拷贝默认 |
| 全局默认 A/X，导入 World1 | World1 默认 A/X |
| 更改应用默认 B/Y | World1 仍为 A/X，随后导入 World2 为 B/Y |
| 从 World1 创建 S1 | S1 固定关联 A/X，两个外键有效 |
| 改 World1 默认为 B/Y，再创建 S2 | S1 仍 A/X，S2 为 B/Y |
| 将 S1 设置为预设 C / 模型 Z | 下一轮 S1 用 C/Z，S2 不变 |
| 正在生成的会话尝试修改配置 | 409 SESSION_BUSY；本次 Run 的模型与摘要不变化 |
| App、World、Session 任一引用预设/模型 | 删除被引用的配置返回 409 CONFIG_IN_USE |
| API 模型 Keychain 凭据不存在 | 创建会话前或发送前给出明确错误，无付费测试调用 |
| 导入字节含格式差异的 World JSON | `source` 下载字节与上传一致；`export` 则是当前 DB 重建结果 |
| 导入后编辑 World（如配置关联） | 原始 source 不变，当前导出反映世界内容编辑；关联 ID 不混入 World Card 外部规范 |
| import DB 提交失败 / 磁盘写入失败 | 不留下可被读取的半成品 World；孤立文件可安全清理 |
| 字段级世界数据读取 | 世界详情、会话创建、状态查询、列表封面、Agent、导出无 `data_json` 残留 |
| 旧预设格式/旧 API 参数 | 明确失败，不静默适配旧字段 |
| 全新 DB 重建并重启 | `app_settings` 存在且恰好一行；Schema 完整，真实数据根目录不被测试触碰 |
| 自定义 Creator iframe | UI/SDK 消息与安全策略不变，无凭据和本地绝对路径泄露 |
| Run 与分支回归 | 历史、Run 并发锁、SSE、状态提交、停止语义均通过原有核心用例 |

### 验收清单

- [ ] 应用默认仅由 `app_settings` 管理，读取路径和 UI 不再藏有列表首项兜底。
- [ ] `presets` 中无 `api_model_config_id`，其导入导出与 API 无旧字段。
- [ ] `worlds` 无 `data_json`，各固定顶层字段均独立落库；独立默认预设与模型引用有效。
- [ ] `sessions` 预设、模型引用完整且创建原子化；Agent 只读取 Session 配置。
- [ ] 原始文件安全留档，可原样下载；当前导出来自结构化数据库。
- [ ] 新会话不会出现因遗漏关联而“进入页面、首次发送才发现无预设/模型”的问题。
- [ ] 设置页、世界卡详情、会话设置、预设编辑全部使用新字段。
- [ ] 既有 Session/Run/State/SSE/iframe 关键行为测试全部通过。
- [ ] 没有旧数据库、旧 API、旧客户端、旧预设格式的兼容逻辑或迁移代码。
- [ ] 测试环境不删除真实用户目录，不操作非 SR 数据。

## 9. 非目标、执行边界与潜在风险

- **不实现历史数据迁移和兼容层**；这是明确的产品决定，不需要“渐进读写兼容”方案。
- **允许重置旧 SR 数据**不等于无条件删除仓库文件、任意目录或 Keychain；实施重置时依然必须限定作用范围、停止服务并确保测试不使用真实数据目录。
- **配置引用 ID 是 Session 的稳定关联，不是不可变模型/预设内容快照**；后续若要生成完全可复现，另行设计 Run 参数快照。
- **文件系统不是 SQLite 事务的一部分**；通过固定路径、原子写入、补偿清理和垃圾文件检测保持最终一致性。
- **模型凭据存在性不能保证远端可调用**；远端无权限、限额、网络故障仍应按 Provider Error 处理。
- 本次不新增 Token Usage、模型价格规则、角色/世界书独立表、通用工作流引擎、云端多用户或额外的跨端客户端。

## 10. 关键代码定位（2026-11-08）

- Schema：`apps/server/src/infrastructure/database/database.ts`。
- World Card Schema/读取：`apps/server/src/domain/world-card.ts`。
- World Import/关联/导出：`apps/server/src/routes/worlds.ts`。
- Session 创建/设置/状态：`apps/server/src/routes/sessions.ts`。
- Preset CRUD：`apps/server/src/routes/presets.ts`。
- API Model Config CRUD、Keychain：`apps/server/src/routes/providers.ts`、`apps/server/src/infrastructure/credentials/store.ts`。
- Agent：`apps/server/src/agent/context/context-manager.ts`、`apps/server/src/agent/persistence/run-store.ts`。
- Web：`apps/web/src/main.tsx`、`apps/web/src/host.tsx`。
- 服务注册与数据根目录：`apps/server/src/app.ts`、`apps/server/src/server.ts`。

最终成功标准：**应用设置保存全局默认，世界卡留档并结构化存储，导入后自动得到默认预设与模型，新建会话复制并锁定自身关联，会话可以单独修改两个关联，Agent 使用会话选定的模型，无旧格式和兼容分支残留。**
