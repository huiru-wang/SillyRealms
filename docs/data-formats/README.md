# SR 数据存储与导出格式

> **职责与权威范围**：说明参考 JSON 对应的目标导出格式与 SQLite 存储列；字段行为分别以[世界卡](../design/world-card.md)、[预设](../design/preset.md)、[状态](../design/state.md)和[存储](../technical/storage.md)为准。SR 尚未实现；本目录的 JSON 是遵循目标契约的参考数据，不宣称来自已运行系统的真实导出。

本目录承载可供实现和验收使用的数据格式文件，文件内容描述实际设计的导入、导出或持久化形状；它们不是数据库、运行记录或备份，不能直接当作已保存的用户数据。新增格式应说明来源、归属、对应字段和脱敏规则。

| 文件 | 格式和含义 | 数据对应关系 |
| --- | --- | --- |
| [world-card.json](world-card.json) | 原生世界卡 JSON：顶层 `spec`、`spec_version`、`data` | `worlds.data_json` 保存世界卡定义，`data.state` 是各作用域的类型定义。该文件包含人工整理的素材，分享前需检查隐私和使用条件。 |
| [default-preset.json](default-preset.json) | 预设 JSON：标识、内置标记、schema、模型、节点与预算等 | 预设配置内容进入 `presets.config_json`，`id/name/is_builtin` 是表列；导入时按实现规则建立记录。不得包含 API Key。 |
| [entry-record.json](entry-record.json) | SQLite `entries` 单行的 JSON 表示 | 非空的 `payload`、`state`、`ext_data` 是 SQLite TEXT 中的 JSON 字符串；此 User 行无独立状态，`state` 为 SQL NULL；`payload` 和 `ext_data` 解析后分别为 Pi 消息对象和扩展对象。 |
| [message-state.json](message-state.json) | Message 完整状态数组 | 该文件内容序列化后可保存到最终 Assistant Entry 的 `state` TEXT 列；字段值需符合当前世界卡定义。 |

`worlds.state` 保存世界卡级 Global 的完整 JSON 对象，`sessions.state` 保存会话级 Session 的完整 JSON 对象，`entries.state` 保存当前消息级 Message 的完整状态数组；它们与世界卡 `data.state` 的**定义**不是同一份数据。每个 JSON 列实际以 SQLite TEXT 持有序列化文本。状态不可与用户可执行脚本、凭据或临时 Run 变量混存。

当前 WorldCard 导出契约是导出世界定义及可打包的自有资源，不包含 Session 或凭据；预设导出不包含凭据。Global、Session、Message 运行状态如何单独备份/恢复，当前未定义成导出格式，不应把世界卡配置导出当作聊天与状态的完整备份。导出数据和参考文件必须按隐私、大小与素材使用条件审查。
