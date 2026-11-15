# SR 预设产品与运行时 v2 执行任务

状态：提案，所有实施任务待执行。依据：[架构方案](./sr-preset-product-runtime-v2.md)。单 agent 顺序实施并独立复核。

| 任务 | 依赖 | 交付/文件边界 | 验收 |
| --- | --- | --- | --- |
| T1 确认基线与契约 | 无 | 重新检查工作区、routes/presets、runtime/config/context、Studio 预设模块及测试；定义八 slot、revision、配置值优先级 | 记录旧实际 payload、能力开关与用户值差异，避免覆盖既有改动 |
| T2 定义新预设与配置 schema | T1 | Server 预设领域类型、配置 schema/ui/values 校验、entries/变量/composer 契约 | 0/false 不误判为空；未知变量/字段、重复 ID、能力冲突均显式错误 |
| T3 八节点默认预设与模板编译 | T2 | Server 单一默认资源、材料提取、模板/when/locals/provides 编译和 sourceMap | 无脚本即可选 0/2/3/4；main 信封/示例与建议节点同步；无隐藏文案 |
| T4 纯编排脚本执行器 | T2、T3 | AST 白名单求值器、可终止 worker、资源限制、脚本返回计划验证 | 无任意 JS 执行；确定性、原型/全局访问、非法 AST、错误返回、超限回收等测试通过 |
| T5 Runtime 与预算接入 | T3、T4 | config/context-manager、Direct/Agent/Summary/辅助诊断、请求冻结 | preview/final 共用编译；最终材料权限；无额外摘要；continuation 不重跑脚本；失败矩阵不变 |
| T6 存储、迁移与 API | T2–T5 | preset routes、repository、DB 版本迁移、会话配置覆盖、导入导出/复制/revision | 临时 DB 备份与事务验证；ID/引用/原文/有效行为保真；不在用户 DB 执行未授权迁移 |
| T7 Studio 产品重构 | T6 | types/adapter/store/library/editor；配置面板渲染；条目/脚本高级编辑；候选/最终预览 | 普通用户只需选项；作者能诊断变量与入选原因；保存失败留草稿；并发冲突与模式差异明确 |
| T8 集成与浏览器验收 | T5–T7 | 扩展 context/direct-prompt/presets/studio-preset/budget/config/compaction/extensions 测试与浏览器流程 | 实际 mock Provider payload、压缩与冻结竞态、迁移 round-trip、375px/1280px 和键盘交互通过 |
| T9 独立复核与正式文档 | T8 | 逐项追踪所有模型文本来源、复核脚本隔离与数据保存；更新已实现产品 docs/AGENTS | 不保留第二套隐藏编排/强制开关，文档区分已实现与待实施；修复后复验 |

所有任务由当前 agent 承担，不委托子 agent。任务完成不自动授权 commit/push/部署、真实模型调用或用户数据迁移。

执行时检查根脚本，再运行 pnpm typecheck、pnpm lint、pnpm test、pnpm build 及相关浏览器流程。先分阶段验证，T9 单独审阅后按变更范围复跑。报告实际覆盖和跳过项目，不能用 mock 测试声称真实模型效果提升。

本轮仅保存这两个新提案文件；未覆盖前案、原始默认预设、源代码或用户数据库。
