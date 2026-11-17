# 后置处理独立性

状态更新和行动建议共享模型输出尾部的标签分帧，但分别解析 JSON、校验内容并返回各自结果。状态插件不向行动建议插件传递结果；行动建议失败也不回滚有效的状态更新。

- 状态更新逐项校验。有效项按顺序应用；出现无效项仍沿用 `partial`（包括全部条目无效）。缺失必需状态块、JSON 无效、顶层格式错误等返回 `failed`。JSON 括号或深度错误只影响所属插件。
- 行动建议只依据自己的启用状态和内容校验：三个不同的非空字符串，每条不超过 50 个字符。合法建议返回 `ready`，不依赖状态插件的任何结果。
- 正文正常完成时，插件失败不会把 Run 改成 `failed`。最终状态快照校验失败（包括 v2 rules 覆盖失败）时，只把状态插件设为 `failed`，保留基线状态及建议结果。
- 整体尾部大小限制和可信标签分帧仍为公共协议约束；标签不完整、字符串未闭合导致边界不可信等协议错误仍拒绝尾部。正文不完整、提供方错误等继续遵循 Run 失败规则。

## 提交与发布

`SRRuntime.finishRun` 在提交成功后，按 `completed`、存在正文消息 ID、建议为 `ready` 的条件发布 `action_suggestions.changed`。Host 在收到终态后核验建议对应当前 Run 的已保存 assistant 消息，WorldStory 展示该消息下的建议。

取消会将插件结果设为 `cancelled` 并清空建议。提交返回未成功、数据库提交失败或正文未正常完成均不发布建议。不能为了绕过状态插件失败而移除这些门禁。

## DEBUG 展示

服务端只在 `SILLYREALMS_DEBUG=1` 时启用诊断展示。`/api/v1/runtime/web-config` 返回 `debug`，SessionHost 经可信 iframe 桥传给 `StoryConfiguration.debug`；缺省为关闭，与前端开发/生产构建模式无关。

WorldStory 仅在 DEBUG 模式展示状态部分失败、状态失败和行动建议失败文案。状态错误文案不再宣称行动建议被禁用。Host 同样在普通模式隐藏后置处理协议/校验错误通知，保留提供方、连接、正文生成及数据库提交失败等运行错误。

## 验证

运行 `pnpm --filter @sillyrealms/server exec vitest run src/runtime/postprocess`，覆盖各插件独立校验、真实内存数据库提交、建议事件与 Host 接收、取消/未提交/提交失败、最终状态校验失败以及 DEBUG 开关。运行 `pnpm typecheck` 和 `pnpm build` 检查前后端契约。

## 状态 v2 诊断

每项失败保留仅内存的索引、更新路径、错误码、scope 和缺失规则路径，DEBUG 日志不附状态值、reason 或原始尾部。完整快照失败同样只记录状态模块诊断。persistableExtensions 继续仅保存插件 status。状态完整契约、材料与重置见 [状态 v2](./state-v2.md)。
