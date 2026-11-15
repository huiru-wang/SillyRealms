# SR 无脚本预设 v4 实施任务

状态：待实施。依据：[方案](./sr-preset-declarative-v4.md)、[完整默认预设](./sr-default-preset-v4.example.json)。单 agent 顺序完成并独立复核。

| 任务 | 依赖 | 范围/交付 | 验收 |
| --- | --- | --- | --- |
| T1 固定 schema 与兼容基线 | 无 | 当前 routes/presets、config、load、Studio 和测试审阅；新 schema/ui/values/entries/source/provides 定义 | 记录旧排序、enabled、平台强制开关、关键词解析差异；明确 v4 取代旧脚本/getState 提案 |
| T2 配置解析与受限表达式 | T1 | 默认/预设/会话覆盖合并、冻结、getConfig、预设独立白名单、load.when/visibleWhen/插值 | 所有预设表达式拒绝 getState、状态别名、任意调用；类型与大小限制、路径错误、无二次执行通过 |
| T3 八节点与固定材料绑定 | T2 | 单一默认资源、before/after、Server source 插入、历史/输入保持、provides 能力解析 | 预设表达式拿不到状态材料；0/2/3/4 与状态组合一致；无隐藏指令和双重启停入口 |
| T4 Runtime 与存储/API | T3 | preparation/预算/摘要/Agent 兼容、API、revision、导入导出与迁移 | 最终历史决定权限、冻结不受编辑影响、保留失败矩阵和 journal；临时 DB 无损迁移 |
| T5 Studio 配置与预览 | T4 | 类型化表单、节点 load 编辑、来源/能力/实际请求预览、草稿与冲突处理 | 普通用户无需代码；隐藏字段不误当停用；保存失败留草稿；两个视口和键盘流程 |
| T6 独立复核与文档交付 | T5 | 安全边界、所有提示来源审计、实际 mock Provider payload、回归与正式文档/AGENTS 更新 | 无预设状态访问或隐式提示；根检查与相关浏览器验收通过，说明实际覆盖/跳过项 |

检查命令在执行前核对脚本：pnpm typecheck、pnpm lint、pnpm test、pnpm build，另跑相关 Studio 浏览器流程。不得默认执行用户 DB 迁移、付费模型请求、commit/push 或部署。

本轮仅持久化文件，全部实施任务尚未开始。
