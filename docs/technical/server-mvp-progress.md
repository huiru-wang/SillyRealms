# Server MVP：当前实现与验证状态

2026-11-06。Server MVP 的主要服务端路径已实现，当前仍需真实 Provider 冒烟；不能把假 Provider 测试结果当作真实模型兼容性结论。范围与实施任务见 [MVP 方案](../../plan/01-server-mvp-design.md)和[任务清单](../../plan/05-server-mvp-tasks.md)，可调用接口和使用顺序见 [Server API](server-api.md)。

## 已实现

- pnpm / TypeScript / Hono 单用户本地服务，SQLite 六张业务表，无数据库外键及版本迁移。默认使用用户数据目录，首次初始化提供可删除的纯文本内置预设；已删除的内置预设不会自动重建。
- 原生 WorldCard JSON 文件导入、标签名称去重、查询/导出/删除、会话及基于父链的 Run 分页、状态读取。会话可不选择预设，运行时才校验预设和模型。
- Pi 内置模型目录、独立 API 模型配置和 macOS Keychain 凭据、预设创建/导入/导出/删除与按节点局部更新。Keychain 使用临时独立钥匙串和虚拟密钥通过读写/删除测试；没有使用个人密钥。非 macOS 平台明确返回凭据存储不支持。
- 纯文本 Prompt、角色/世界书/状态根的 `always/on_mention/when`、固定摘要压缩、模型状态 Tool、普通 HTTP 文本流、先持久化再输出、停止后状态和部分文本结算。单 Session 互斥、数据目录进程锁、重启中断标记与显式级联删除已实现。
- 用户已确认：当模型不支持中途 system 消息时，允许 Pi SDK 将这些内容合并到前面。本地 Pi 模拟传输测试覆盖两种顺序行为、流式正文、ToolCall 和取消；不证明真实服务端的协议兼容性。

## 已知限制与操作提示

- 尚未使用真实 Provider/API Key 验证实际模型、Tool Schema、网络取消和摘要质量。调用 `POST /api/v1/api-model-configs/:id/test` 才会发送真实测试请求，可能产生费用；测试成功返回的 `toolVerified` 仅代表一次工具调用探测，并仅在当前 Server 进程内有效。带可写状态根的会话在工具能力未验证时返回 `MODEL_TOOL_UNSUPPORTED`；重启后需重新测试。
- `when` 仅支持实施方案中的受限表达式子集；Prompt 中脚本、状态 API、宏（包括 `{{user}}`）不执行、不替换。生成参数目前支持 `temperature`；不接受尚未实现的其他模型参数。
- 参考 `data-formats/world-card.json` 中 `$.data.lorebook.entries[5].load.keywords` 为空，不满足 `on_mention` 规则，当前导入会报定位错误；实现不会自动修改该文件。旧 `default-preset.json` 包含旧模型选择、脚本和内联状态模式，不是当前 API 的预设格式。使用 [MVP 世界卡示例](../data-formats/mvp-world-card.json)和[MVP 预设示例](../data-formats/mvp-preset.json)。
- 资产上传、打包和资源文件清理未实现，世界卡中的资产/来源正则保留为不执行的数据并发出警告；外链不由服务端请求。没有 Web、UI Runtime、事件协议、分叉或重新生成。
- 网络断开时服务端无法证明客户端究竟收到哪些字节：历史至少包含服务端已保存的已输出片段，可能多出尚未收到的尾部。进程崩溃后已落库文本标记 interrupted，未结算的内存 Tool 工作区不保证恢复。
- Node 22 的 `node:sqlite` 标记为实验特性。模型 Token 使用保守估算，仍可能被 Provider 拒绝；此时返回失败，不删除原始历史。已有数据库不做自动升级；以后 DDL 变更需手工执行，操作真实数据前先按工作区约定备份。

## 本地验证

在 SillyRealms 根目录执行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、`pnpm test`。测试使用临时 SQLite、假 Provider 和临时钥匙串；包含 JSON 导入/标签、无预设创建、模型配置、预设局部修改、Tool 更新、停止恢复、长消息摘要、跨会话父链、重启恢复和进程锁。`pnpm dev` 会启动服务并在 `SILLYREALMS_DATA_DIR` 或默认用户目录创建运行数据库，不要把运行数据当作可提交样例。
