# 02 · 数据库、领域对象与存储

前置：01。MVP 使用 SQLite、独立 JSON 列和服务层事务；禁止 DDL 中出现 `REFERENCES`、`FOREIGN KEY` 或级联约束，不依赖数据库外键。关系由服务层写入时检查；删除如何影响引用由本方案明确约定。

## 1. 初始化和 DDL 变更

启动时执行本期所需的幂等建表/建索引 DDL（如 `CREATE TABLE IF NOT EXISTS`），JSON 使用 TEXT 并校验；启用 WAL 和 busy_timeout。**不设置数据库版本、不使用 `PRAGMA user_version`、不建迁移表、不引入迁移工具**。以后有 DDL 变化时，维护者直接按变更需要执行 SQL；`CREATE TABLE IF NOT EXISTS` 不会更新既有表结构，需调整已有列时必须人工选择正确 DDL 和执行顺序，不能声称自动升级或对现有数据无风险。测试使用临时数据库；对已有真实数据执行 DDL 前遵守工作区备份和授权要求。

## 2. 表结构

沿用原设计的六个领域表中适合当前需求的字段，**将 provider_credentials 改为独立 api_model_configs，仍为六张业务表**：

| 表 | 关键列和职责 |
| --- | --- |
| `worlds` | `id,name,data_json,state,created_at,updated_at`。data_json 为 WorldCard，`state` 为 Global 完整对象；只通过 JSON 文件导入创建。 |
| `tags` | `id,type,name,sort_order,created_at`；`UNIQUE(type,name)`，世界标签使用 type=world。 |
| `api_model_configs` | `id,name,provider_id,model_id,credential_ref,created_at,updated_at`；每个 ID 对应独立的所选模型及 Key 引用。同一 provider/model 可以有多条配置。 |
| `presets` | `id,name,config_json,is_builtin,created_at,updated_at`；config 含 `api_model_config_id`、生成参数、budget、summary_prompt、nodes；内置标记仅展示，不限制删除。 |
| `sessions` | `id,world_id,preset_id,user_character_id,tip_entry_id,title,state,created_at,updated_at`；`preset_id` 可为 NULL 或保存尚不可用的引用；state 为 Session 完整对象，无世界快照或 opening ID。 |
| `entries` | `id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data`；保留 message/compaction/branch_summary，role 与 payload 一致；state 为 Message 完整根 key/value 数组或 NULL；ext_data 保存摘要、运行状态和流式元数据。 |

提供 `UNIQUE(session_id,seq)`、非空、JSON 形状和 type/role CHECK，以及 `(session_id,parent_id)`、`(session_id,run_id,seq)`、`(session_id,role,seq)`、标签排序与会话最近活动索引。业务层校验每个 parent、tip、摘要覆盖边界属于同一 Session/正确父链；写入与 tip 变更同事务，按预期 tip 比较并递增 seq，避免并发创建兄弟节点。线性链上可见消息的 branch_count 为 0/1，技术 Entry 固定 0；后续真正支持分叉时需补算法，不把字段存在视为分叉已实现。

## 3. World JSON 导入和标签

`importWorld` 接收上传的 JSON 文件，验证文件大小、JSON 与原生 WorldCard（包含名称、Opening、角色、状态定义及加载规则），不执行其中的脚本；保留非执行扩展。`data.tags` 缺省为空；非空时必须为字符串名称数组，去掉首尾空白，拒绝空名称；本期按**去空白后的精确名称**去重，区分大小写，不做隐式大小写折叠。每次导入生成新 World ID，避免覆盖已有世界。

同一个 SQLite 事务内：校验卡 → 对每个名称执行 `INSERT ... ON CONFLICT(type,name) DO NOTHING` → 读取对应标签 ID → 写 World 和初始 Global 状态。WorldCard `data.tags` 保存去重后的名称数组作为跨环境导出格式；关系查询可按名称匹配 tags 字典，不创建关联表。失败全部回滚，重复导入同名标签不会新增重复 tag。当前样例中的标签 ID 如果不是名称，本期不能猜测 ID 对应名称；导入诊断提示来源格式需要事先整理，不修改原文件。导出输出原生 JSON 和标签名称，不导出运行状态或凭据；单独备份运行数据需另行处理。

World 删除在事务中显式删除其所有 sessions/entries，最后删 world；先停止对应在途运行。删除标签时显式移除 World 的名称引用并删除字典项，保证操作在同一事务。只清理能确认归属的独占资源，不删除远端链接和共享资源。资源上传/打包不是本期重点；不支持的资源引用明确提示。

## 4. 模型配置及 Preset

每条模型配置由用户选择 Pi 可用目录中的 provider/model 并提交 API Key；数据库仅存凭据引用，Key 存安全凭据存储。列出配置返回 `id/name/providerId/modelId/credentialConfigured`，不返回 Key；可新建、更新名称/模型或替换 Key、删除、显式连接测试。相同 provider/model 的不同配置不可互相覆盖。不能使用安全存储时明确报错，不写 SQLite 明文。

Preset 通过 `api_model_config_id` 引用配置；每轮读取一次并固定本轮模型与密钥。创建或显式修改该引用时校验配置存在；模型配置被删除后原 Preset 保留悬空 ID，下次解析返回 `API_MODEL_CONFIG_NOT_FOUND`，绝不自动替换。配置导出不包含任何 Key；Preset 导出包含配置 ID 但 ID 在其他安装中不保证可用，导入时缺失则保留该引用并提示重新选择，真正运行前校验。

`updatePreset` 接收有明确边界的局部字段：`name/description/api_model_config_id/model_parameters/budget/summary_prompt/nodes`。`nodes` 按节点 ID 提交局部 patch，例如 `{"nodes":[{"id":"main","content":"新 Prompt"}]}` 仅更改该节点 content，不清空其它节点或属性；不允许通过 patch 更改系统节点 id/kind/source，不允许未知节点 ID 或重复 ID。若需新增/删除/排序自定义节点，另以 `nodes_order` 和显式 `add_nodes/remove_node_ids` 操作，校验系统节点不删除、七节点唯一及必须顺序；未出现字段保持原值。`null` 仅对明确可清空的可选字段生效；其他字段拒绝。一次 patch 在内存构建新配置并完整校验，成功才事务保存，失败无部分修改。

Preset 的导出不做内置/引用检查；删除时不检查内置/引用，直接删除记录，Sessions 保留 preset_id，之后运行或依赖预设的操作返回 `PRESET_NOT_FOUND`；Session 可切换到其他可用 Preset，不修改历史。已有会话的历史仍可读取。禁止在删除时悄悄替换 Preset、删除会话或其他配置。正在执行的 Run 已在内存固定配置；删除不使其读取另一配置，后续 Run 明确失败。

## 5. 会话、Raw Entry 和工作区状态

Session 创建只校验 World、Opening 和可扮演玩家角色；`presetId` 可缺省或为 null，非空时只验证其为合法 ID 字符串并保存，即使引用不存在也不阻止创建；不检查 Preset、API 模型配置、Key 或模型能力。在事务中创建 Session、独立 Opening Run、根 Assistant、初始 Message 状态和 tip。无可选玩家角色时失败，不暗中修改 World。Session 更新 presetId 同样允许清空或保存暂不可用引用；每次 Run 开始重新读取该引用及其配置并验证，缺少或失效时返回明确错误，不插入本轮 Summary/User，不调用模型。每次玩家输入创建新 run_id，Summary/User/Assistant/toolCall/toolResult 属同一 Run。沿 tip 的 parent_id 找祖先，再按 run_id 分组分页，limit 计 Run；历史只投影 user/assistant 正文，Raw Entry 保留实际工具交换和技术摘要。

状态的 Global、Session、Message 分别保存在 worlds.state、sessions.state、本轮最终状态锚点 Entry 的 entries.state；类型和 Opening 覆盖按原状态设计。每轮复制完整状态为工作区，Tool 只允许更新已激活的 Message 路径（Global/Session 本期只读），每次操作即时验证并修改工作副本；在正常完成或主动停止时，以初始状态为基底合并本轮已成功 Tool 改动并校验完整状态，事务写入完整 Message 快照和 Run 终态。无 Tool 调用时仍保存继承的完整状态。失败的 Tool 调用不影响工作区，模型可基于明确的工具错误继续；异常造成无法结算时保留输出并标失败，不提交不合法状态。既有状态与 Schema 不兼容时原样保留并返回诊断，不自动重建。

## 6. 停止与部分文本持久化

每条正在输出的 Assistant 文本使用同一个可更新 Entry，先事务追加到存储中的正文，再向 HTTP 响应写出同一块；`payload.message` 保存可恢复的 Assistant 结构，`ext_data.origin=stream_partial` 与 `status=streaming` 标识尚未完成，不能伪装成 Pi 已完成消息。SDK 最终完整消息能取得时，以原始消息保存或在独立 Raw Entry 保存，并避免与 partial 产生双重叙事；不能取得时保留标记明确的部分消息。ToolCall/ToolResult 按产生顺序单独写 Raw Entry，不以正文替代。

stop 要停止接受新的模型片段，等待正在进行的“落库→写出”操作完成，触发 AbortController、等待任务退出；若 SDK 超时仍可阻断迟到片段。将 partial Entry 标 `stopped`，合并已成功的 Tool 修改并保存完整状态，再响应 stop 成功。停止时若模型已经开始另一段 Assistant，按每段分别保留 Entry 和顺序，不覆盖先前段；没有任何正文则不伪造空 Assistant，必要时以本轮最后一个已持久化 Entry（包括 User 或 toolResult）的 state 列作为状态锚点，不能将状态伪装成叙事。重复 stop 幂等。随后 history 返回已保存的正文与 stopped 标记；下轮 Context 包含该部分叙事及其对应 User，保证模型看到的已发生剧情与用户可见一致。

服务端进程崩溃与主动停止不同：已落库文本可恢复并标 `interrupted`，内存中未结算的 Tool 工作区不承诺恢复；不得声称崩溃后状态已经同步。为减少依赖，本期只支持同一 Session 一个在途 Run；锁保护完成/停止和显式删除。失败终态的已输出文本照常在历史中显示，Tool 工作状态是否可用由实际结算结果明确标识。
