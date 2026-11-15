# SR 全提示词预设化执行任务

日期：2026-11-15。状态：待批准、待实施。依据：[完整方案](./sr-preset-owned-prompts-v1.md)。

全部任务由同一 agent 顺序执行；复核为独立阶段，不使用子 agent。方案保存不授权执行代码或用户数据库迁移。

| 任务 | 依赖 | 文件边界/交付 | 验收 |
| --- | --- | --- | --- |
| T1 确认版本和行为基线 | 无 | 重新检查 git status；枚举所有模型请求及自然语言来源；记录现有 Direct/Agent/Summary/verify payload 夹具 | 不覆盖工作区改动，明确新旧方案冲突、既有失败与全部提示入口 |
| T2 定义 v2 预设契约 | T1 | Server 预设 schema/types；program、四种节点、source/变量/条件清单、布局校验和 errors | 无 eval/副作用，未知引用报错，角色与唯一 source 约束明确，旧格式可识别 |
| T3 完整默认资源 | T2 | presets/defaults 中 Direct/Agent/Summary 完整文案及中性示例，独立模型诊断预设 | 无隐藏继承；协议/业务/示例均可导出；骨架、示例与真实 parser/handler 相容 |
| T4 纯材料与节点编译器 | T2、T3 | 从 prompt-builder 提取材料；prompts/compiler/types；sourceMap | 原 load/排序/只读边界不变，动态数据不二次展开，节点顺序直接决定消息 |
| T5 预设 API 与保真转换 | T2–T4 | routes/presets、配置存储、导入导出和 compat；迁移备份与事务机制 | 旧 IDs/引用/标签/预算/原文无损；共享 preset 的不同会话开关差异显式保留；round-trip 通过 |
| T6 Direct preparation 接入 | T4、T5 | config、context-manager、Direct 编排和预算；删除隐藏 Direct 注入路径 | 默认两能力开启而用户覆盖真正生效；四种组合；完整请求估算；最终权限冻结；journal 与结算不变 |
| T7 Agent、Summary、诊断接入 | T4–T6 | summary-generator、state-tool、Agent 编译、Pi verify 与调用入口 | 工具说明可编辑而 schema 不变；Agent 语义明确；continuation 不重建权限；摘要只一次；诊断无隐藏指令 |
| T8 Studio 完整节点编辑 | T5–T7 | types/adapter/store/编辑器/列表/能力表单/本地预览接口 | 模式页签、真实顺序、group 编辑、source 来源、错误定位、草稿保留、模板与请求预览区别清楚 |
| T9 集成与迁移验证 | T6–T8 | 扩展现有 direct-prompt、context、budget-v2、roleplay-context、presets、studio-preset、runtime-config-api、compaction-lifecycle、narrative-extensions 等测试 | 实际 mock Provider payload、冻结竞态、load never、跨 scope、失败矩阵及迁移保真全部通过 |
| T10 文档与独立复核 | T9 | 更新批准后相关 AGENTS、docs 中产品/设计约定和 plan 状态；独立检查实现差异与提示来源审计 | 旧固定平台文案约定已明确替代；没有新增隐式 fallback；只将已实现事实写入正式文档 |
| T11 最终复验与交付 | T10 | 根命令、相关浏览器流程、375px/1280px截图与键盘交互结果；交付报告 | 无关键缺陷；报告实际通过、失败和跳过项目；不默认提交/推送/执行用户 DB 迁移 |

## 每阶段的特别约束

- T3 先将现有有效文本完整物化建立等价基线，再加入方案建议的事实/意图、状态基线、路径说明改进；两类差异分开审阅。
- T5 不直接改用户 DB。先对临时 DB 完成验证，记录迁移前后行数、引用、原始配置和实际请求差异。最终执行需有用户明确授权。
- T6 不以更换提示编译入口为由改变预算阈值、单次压缩、Run concurrency、幂等、取消或历史语义。
- T7 全面检查工具错误消息和 Provider 适配器是否含有指导语；动态错误事实可留代码，行为指令必须进预设。诊断预设修改不得被当作标准工具认证通过。
- T8 不修改创作者 SDK/iframe 权限。最终请求预览只属于 Host 管理面；普通日志不含故事正文。
- T10 与 T11 发现缺陷后修复并重跑对应检查；不通过删除断言或弱化状态校验来过测试。

## 可复现检查命令

从根目录执行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`。按受影响浏览器流程执行 `pnpm test:browser` 或经核实的定向脚本；先检查脚本实际覆盖范围，避免重复无关检查。全程不使用真实付费 Provider 调用；真实模型效果评估如另行授权，应单独记录模型、参数、样本与协议成功率，不能由 mock 测试推断。

## 本轮交付记录

仅新增方案与本任务清单，未改源代码、原始默认预设 Markdown、现存方案或正式 docs，未运行迁移或模型请求。完成了基于源码、已有测试、世界/SDK 文档和预设设计原型的架构评估；所有实施任务仍为待执行。
