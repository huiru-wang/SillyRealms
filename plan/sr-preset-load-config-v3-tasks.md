# SR 预设 load/getConfig 执行清单

依据：[v3 设计](./sr-preset-load-config-v3.md)。状态：待实施。单 agent 顺序执行。

| 任务 | 依赖 | 范围与交付 | 验收 |
| --- | --- | --- | --- |
| T1 锁定现有 load 兼容基线 | 无 | world-card/atomic-schema/activation/when/prompt-builder 与已有测试；记录关键词 trim、strict、enabled 与排序差异 | 不更改角色/世界书/状态既有加载行为 |
| T2 配置值与 getConfig 契约 | T1 | 预设 schema/ui/values、有效值合并与冻结、声明路径检查、值类型与大小限制 | 默认/预设/会话覆盖、0/false/null/optional/未知路径均符合设计 |
| T3 共享表达式内核与预设 load | T2 | 保留世界 validateWhen/evaluateWhen 包装；新增预设白名单环境与五字段 load | 角色/世界书不接受 getConfig；预设可用两函数；无 eval/赋值/自由调用；原限额不退化 |
| T4 模板与能力接入 | T3 | getConfig 插值、条件段、provides expression、八节点默认配置与 runtime preparation | 0/2/3/4 启用结果/示例/信封/校验一致，候选重复能力拒绝，实际 payload 可追溯 |
| T5 Studio 与无损兼容 | T4 | 统一加载设置表单、条件编辑辅助、配置来源与激活预览；旧 enabled 和开关兼容 | 仅一个启停入口，保留旧条件；保存失败留草稿；无用户 DB 未授权迁移 |
| T6 回归、独立复核与文档 | T5 | activation/state/context/direct-prompt/config/compaction/preset 测试、实际 mock payload、相关浏览器流程；更新实施后的 docs/AGENTS | 预算与最终权限冻结、状态失败矩阵、数据保真和两个视口验收；报告实际检查与跳过项 |

按范围运行定向测试，再执行经核实的根 pnpm typecheck/lint/test/build 和相关浏览器检查。禁止真实付费 Provider 调用或默认执行用户数据库迁移。当前只保存方案和本清单，全部实施任务尚未开始。
