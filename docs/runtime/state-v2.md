# 状态 v2

世界卡的 `data.state.schema_version` 必须为 `2`。不接受 v1 定义、旧状态数据或旧预设变量。定义和规则保存在世界卡；消息快照仅保存根名及当前值。

## 定义和覆盖

每根状态必须声明 `type`、`initial`、非空 `description` 和非空 `rules`。类型为 string / number / boolean / json。只有 number 根支持有限 min / max。json 根允许任何安全 JSON 值；嵌套类型、必填、枚举、业务条件仍由作者规则指导模型。

规则路径包含根名，不包含 scope。对象用句点，数组元素用 `[]`，嵌套数组支持 `[][]`。根名及对象字段不得为空，不得包含 `.`、`[`、`]`，不得使用 `__proto__`、`prototype`、`constructor`。允许中文。

完整根值中的根、对象容器、数组容器、数组元素模板及实际子字段都必须有规则。空数组也需要 `[]`；可预声明未来字段。rules 覆盖不检查字段必填或嵌套业务类型，规则文本不会执行为程序。

初始化、每个开局覆盖、三个 scope 快照读取、每项模型或 SDK 更新后的完整根值，以及模型提交前 message 快照均使用同一校验链。失败项不污染后续项。开局只接受 message 根名，逐根完整替换，不深合并。

`STATE_RULE_MISSING` 返回缺失模板路径；`INVALID_STATE_RULE_PATH` 返回非法规则路径。诊断保留 scope、字段路径及 rulePath，并通过导入、会话创建、读取和 SDK 写入的现有 HTTP envelope 传递。SDK 写结果的 scope/path 对应请求，stateScope/statePath/rulePath 定位实际校验失败的位置。

## 材料和权限

唯一状态模板变量为 `state.entries`。每个激活 message 根的当前已提交值仅序列化一次，并紧邻 type、min/max、description 和规则。number 边界为 0 时仍输出。

规则原始文本及存储顺序不被改写；材料按确定性路径层级排序，根规则在先。数组模板明确标为元素规则，不可当更新路径。只对 description 和规则文本展开一次精确 `{{user}}` 宏，再转义；根名、规则路径和当前状态值不展开宏。插入材料不再次解析预设模板。

根级 load、冻结来源、候选预算和最终编译继续共用原有链路；材料和可写根来自同一次选择。无激活根省略 worldState 节点并标记 not_required；节点关闭为 disabled。不单独截断值或规则。

模型只能写本轮激活 message 根；SDK 可写所有声明的授权 scope 根，不受 load 激活限制，同世界存在活跃 Run 时拒绝。Creator stage 只获得各 scope 的根名清单，通过 SDK 读取实际值，不获得初始值、完整状态定义或规则映射。世界详情组件仍只有只读 global 接口。

## 更新与独立结算

每轮一个叙事模型调用，正文后一个 `<state_update>` JSON 数组；无变化输出空数组。每项仅有 path、显式 value 和可选 reason，最多 100 项。value 是完整新值；不接受数组索引或模板 `[]` 路径；父对象须存在；null 不表示删除。

- 已完成正文的 Run 不受任何状态更新结果影响。
- 块级解析/格式失败为 stateUpdate.failed，不写候选快照。
- 项级失败为 partial，保留有效项；全部项非法也为 partial。
- 最终 message 快照校验失败只使状态插件 failed，并继续继承上次提交值。
- 行动建议仅由自身配置、解析校验和公共提交/取消条件决定，不依赖 stateUpdate 的任何结果。
- 公共标签分帧不可信、尾部超限、正文未正常完成、Provider 错误、取消或终态事务提交失败，仍按各自 Run 生命周期处理。

正常完成先以独立事务保存干净正文（state=NULL），再由 finishRun/finalize 事务核验 tip、Run 归属、祖先链及 baselineHash，并原子保存允许的完整候选快照和终态。停止或失败不写候选。正文失败路径仍可保存已经显示的干净正文。

提交成功后，业务事件相对顺序为 message.final → state.changed → run.updated → action_suggestions.changed，中间允许用量事件。模型 state.changed 按最终净差异逐根发出，value 为完整根值；SDK 事件沿用提交路径及该路径新值，global 广播至世界内会话。

持久 Run 元数据只记录两个插件状态；建议内容、reason、原始扩展及字段诊断不进入持久元数据。字段诊断只用于即时响应与 SILLYREALMS_DEBUG=1 日志。普通玩家模式不展示后置校验诊断；DEBUG 下 partial 文案不假设一定有有效更新。

## 大小与深度

定义总量与单根值分别最多 1 MiB。根值以根为深度 0，每个对象属性或数组元素增加一层，最大 32。更新路径最多 32 段。

模型整个隐藏 tail 最多 256 KiB；块内 JSON 深度从更新数组外壳开始计数，最大 32。更新数组和项对象占用层级。存储上限不保证所有合法值均能由模型整根提交：需要整体替换的数组须连同外壳和其他扩展满足 tail 限制。JSON 语法/深度错误在分帧可信时仅影响所属插件。

## 数据库重置

数据库 user_version 为 7。空数据库自动初始化；旧版本启动时明确拒绝，不进行自动迁移。

v6 数据库使用显式命令：

```bash
pnpm --filter @sillyrealms/server reset:runtime
```

服务持有数据目录锁时不能重置，应先正常停止服务。自定义数据目录可设置 SILLYREALMS_DATA_DIR。

重置先创建 before-runtime-v7 时间戳数据库备份；存在 workspaces/worlds 时，将源卡与离线资源另存到数据库备份同名的 .world-files 目录，位于数据目录根部。资源备份不跟随符号链接，任何复制失败都不会进入数据删除。备份完成后，事务清理旧世界、状态、开局、会话、消息、预设、标签和准备记录，初始化新默认预设。保留模型配置、credential_ref 和应用默认模型，不访问或删除凭据存储。重置本身不删除原资源；后续服务启动会清理运行区的孤立资源，.world-files 备份不受影响。失败回滚数据和版本。命令返回 backup 与 worldFilesBackup 路径。世界卡需按 v2 重新导入；不提供状态或预设迁移工具。

## 验收

pnpm typecheck、pnpm lint、pnpm test、pnpm build。测试仅使用内存 SQLite、临时目录和模拟 Provider；覆盖 rules、HTTP 字段诊断、Server/Studio 开局一致、模型与 SDK 权限、独立结算、事件顺序、冲突/取消/提交失败及显式重置。
