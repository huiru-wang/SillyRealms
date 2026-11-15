# SR 预设分列与节点驱动后置处理 v7 任务

日期：2026-11-15。状态：待实施。以 [v7 方案](./sr-preset-node-processing-v7.md) 为准，替代 v6 任务中独立能力区/七系统节点的配置设计。当前单 agent 顺序执行；本轮仅保存设计。

| 任务 | 依赖 | 工作边界 | 验收 |
| --- | --- | --- | --- |
| T1 确认 schema 与默认记录 | 无 | presets 八列、config_json 节点 schema、默认种子 | 六系统节点＋两个默认启用 output 节点；没有 output_plugins/output_prompts 双重来源；context_strategy 为完整原 budget |
| T2 无损数据库与旧预设转换 | T1 | database.ts、转换模块、临时 DB 测试 | 新三列正确物化，config_json 仅节点配置；旧 summary/能力提示归位；备份/事务/幂等/失败回滚/引用和原文保留 |
| T3 CRUD 与所有消费者 | T2 | routes/presets.ts、domain/tags.ts、RunStore、runtime/config.ts、sessions 能力读取、Studio adapter/types/store | 八列一致读写；预算/参数从独立列读取；hash 覆盖所有执行字段；旧会话开关不覆盖新节点 |
| T4 节点编排与提示数据 | T3 | prompt-builder/direct-prompt/context-manager、默认节点模板 | 用户输入后顺序展开世界状态/行动建议；一节点一提示；值/规则同源；summary 与辅助用途隔离；关闭不注入 |
| T5 输出处理与新协议 | T4 | splitter/parser/DirectRunner/handlers/contracts、SDK 历史结果消费者 | 由相同节点快照派生处理集合；裸标签完整校验后提交；四组合/无可写根/失败矩阵/旧协议读取通过 |
| T6 Studio 节点 UI | T3–T5 | PresetLibraryPage/PromptEditorDialog/SessionSettingsDialog、相关 API | 独立列设置面板；两个输出节点行有唯一开关；完整提示可查看；无独立能力区；保存失败保留草稿、焦点与两个视口 |
| T7 复核、回归与文档 | T2–T6 | 定向及根检查、实际 Provider mock、docs/AGENTS | 独立复核发现并修复问题；正式说明与实现一致；记录覆盖边界，不提交或推送 |

测试包含：八列全部字段修改/导入导出/旧导入、非法 JSON 与原子保存、列表 description、新建默认、引用/标签保留、备份/幂等/回滚；节点非法身份/重复 ID/错误角色、开关四组合、无状态、编辑与 await 交错、输入预算、单次摘要；跨 delta 标签、UTF-16、字符串内标签、重复/乱序/半块/超限、stop/length/error、状态 partial 与建议失败隔离；建议三条与50码点；旧 SDK/Host 历史恢复；375px/1280px 与键盘流程。

实施前再次检查 scripts，然后按改动运行定向测试和根 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、适用 `pnpm test:browser`。当前 lint 只覆盖 Server、build 只构建 Studio，不扩大表述。只使用 mock Provider 和临时数据库，不运行 reset:data、真实用户 DB 迁移或付费模型调用。

核心链路实现完成后更新相关 docs 与 AGENTS；本轮提案阶段不修改事实文档。缺失的项目技能不能列作已执行，保持项目要求的单 agent 独立复核。
