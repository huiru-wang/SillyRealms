# SR 简化状态提示与双输出插件 v6 实施任务

日期：2026-11-15。状态：待实施。方案见 [v6 完整设计](./sr-output-plugins-prompts-v6.md)。单 agent 顺序执行；本轮只新增这两个方案文件，不代表修改源码或运行迁移已获授权。

| 任务 | 依赖 | 文件边界与内容 | 验收 |
| --- | --- | --- | --- |
| T1 固定新合同与兼容边界 | 无 | 检查 AGENTS、当前工作区、既有 plans、protocol 消费者；确定新 preset schema 与 sr-output-blocks/v1 | 删除 worldState 系统节点、其余七节点保留；世界状态/行动建议能力默认开启；三条/50码点、后置能力提示、输出块失败表冻结 |
| T2 预设与数据资源 | T1 | 默认预设资源、routes/presets.ts、runtime/config.ts/types.ts，旧预设物化与转换 | schema 不再要求 worldState 节点；旧内容迁入能力并保留原文；全部提示来自预设；两个开关默认 true 但无强制覆盖；旧 count 不影响新协议 |
| T3 状态材料与后置 prompt | T2 | context/prompt-builder.ts、direct-prompt.ts、context-manager.ts，前端预览响应 | 开启才注入对应完整能力提示；worldState 为能力来源、actionSuggestions 节点引用能力且不重复；值与规则同源、无 scope/readonly；user 后 system；预算一致 |
| T4 双标记流式切分和顺序解析 | T1 | narrative/extension-stream-splitter.ts、extension-parser.ts、相关单元测试 | 有界缓存、跨 delta、JSON 引号/转义、两个裸块顺序与完整性；不能补信封或逐块提前提交 |
| T5 执行接入与能力结果 | T3–T4 | runners/direct-runner.ts、narrative/action-suggestions-handler.ts、extension-contract.ts | normal stop 后校验/提交；状态逐项语义不变；建议三条/50码点；局部失败与整体结构失败可区分 |
| T6 历史结果与 SDK 兼容 | T5 | domain/session/run-result.ts、packages/sr-sdk/src/run-contract.ts、DB/version 检查、相关 API/SDK 消费者 | 两种历史协议读取；新旧 Run 按显式版本选择；不重写历史或放宽 iframe 权限；旧 SQL 只按实际需求改 |
| T7 Studio 查看与设置 | T2–T6 | features/presets、api.ts、SessionSettingsDialog.tsx、相关显示和 browser suite | 七节点列表不含世界状态；能力区两个开关默认开启，可查看完整模板；行动建议单一来源；无 count 选项；模板/候选/冻结明确；失败保留草稿、键盘与两个视口 |
| T8 验证、独立审查与文档 | T2–T7 | 定向测试、根脚本、产品/设计 docs 和 AGENTS | 核对实际 Provider payload；覆盖四组合、空状态、失败矩阵和迁移；修复后复验；正式文档只记已实现行为 |

## 验证矩阵

- 状态：值/规则/授权根一致；initial 不冒充当前值；min/max=0；JSON description 中的子路径不成为额外 schema；global/session 只作背景；关闭插件仍不授权。
- 解析：两个标签任意 delta 切片；普通正文遇到类似前缀；UTF-16 与 emoji；字符串内闭合标签；重复/乱序/未知块；JSON 不完整与边界可信的 JSON 错误区分；超过总尾部字节上限。
- 执行：状态块缺失、空数组、部分失败、重复路径、建议失败但合法状态保留、建议未闭合导致整体丢弃、取消、输出长度截断、Provider error、流式/终值不一致、拒绝提前提交。
- 建议：0/2/3/4 条、空字符串、trim 后重复、50/51 Unicode 码点，关闭时不发布；不自动补齐或截断。
- 兼容：旧 sr_extensions/v1 结果、SDK/Host 状态恢复、新协议结果、旧预设转换报告、用户文字不覆盖、备份/幂等/事务失败，全部临时 DB。
- UI：七节点不含世界状态；能力区世界状态/行动建议默认开启；开关影响完整提示注入且各一次；行动建议节点无第二开关；模板查看、真实展开、无数据、保存冲突与失败草稿、375px/1280px、键盘和焦点，无 console error；不修改 creator API 权限。

相关现有测试入口：direct-prompt.test.ts、narrative-extensions.test.ts、atomic-state.test.ts、session-runtime.test.ts、runtime-config-api.test.ts、roleplay-context.test.ts、budget-v2.test.ts、compaction-lifecycle.test.ts、presets.test.ts、studio-preset.test.ts；按实际覆盖补充新的协议/历史恢复用例。

实施时先定向检查，再执行根 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、适用的 `pnpm test:browser`。当前 typecheck=Server+Studio，lint=Server，test=Server Vitest，build=Studio，不能以命令名字声称覆盖全部包。检查 package scripts 后再运行；只用 mock Provider 和临时存储，不执行付费调用、真实 DB 迁移、reset:data、提交或推送。

本轮检查仅涉及源码阅读与设计文档自检，不把上述待执行用例列为已通过。项目所列但当前不可用的 kickoff/product-design/fullstack/quality-review 技能不作为已执行项；按单 agent 发现、设计、独立复核完成本轮。
