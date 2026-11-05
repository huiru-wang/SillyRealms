# 内容加载判断

> **MVP 状态说明**：本文保留原有目标设计；若与本次 Server MVP 的已调整范围或实际行为冲突，以 [Server MVP 实施进度](../technical/server-mvp-progress.md)及其中链接的方案为准。文中的未来功能不代表已实现。

> **职责与权威范围**：角色、世界书与状态根的加载条件和关键词匹配算法的权威来源；执行脚本与状态 API 以脚本运行时规范为准。

> 2026-11-04 目标设计，尚未实现。角色、世界书条目和状态根共用本模块；条目排序、世界书锚点、节点组装和状态更新权限仍由各领域负责。

## 接口与职责

ContentActivation 是无副作用的统一判断能力：接收 `load` 规则、调用方准备的候选叙事文本、当前 User、完整三个作用域状态只读视图和来源，返回 `{active, reason, diagnostics}`。它不查数据库、不修改状态、不渲染正文、不写 Prompt，也不自行决定历史范围；AgentContext 决定当前分支和候选消息并编排调用。WorldCard 预览使用显式示例状态和扫描文本，不持久化。

```ts
type LoadRule = {
  mode?: "always" | "on_mention";
  keywords?: string[];
  keyword_logic?: "any" | "all";
  exclude_keywords?: string[];
  when?: string;
};
type ActivationResult = { active: boolean; reason: string; diagnostics: Diagnostic[] };
function evaluateLoad(rule: LoadRule, scanMessages: string[], state: ScopedStateViews): ActivationResult;
```

## 统一规则

- 缺省 `mode` 为 `always`。`always` 不检查正向或排除关键词；存在 `when` 时仍需满足。
- `on_mention` 需要至少一个非空正向关键词；`keyword_logic` 默认为 `any`，也可选 `all`。`any` 至少命中一词；`all` 要求每个关键词都在扫描集合中的某条消息命中，可以分别命中不同消息。
- 逐条消息做普通子串匹配，区分大小写、不做 Unicode 归一化；单个关键词不得跨消息边界。当前 User 与候选消息同等参与扫描。`exclude_keywords` 任一命中即否决。
- 全部 `when` 均先于任何 Prompt 执行，在 Run 初始只读状态视图上完成并冻结结果，只能调用 `getState`。`when` 是额外 AND 条件，使用[表达式引擎](script-runtime.md)基于三个作用域的完整状态视图以 JavaScript 表达式求值；缺省视为通过。`when` 不可写持久状态或 Run 变量，禁止动态获取/激活世界书；允许在正向条件未命中或排除词命中时短路，但编辑/发布时仍需静态验证语法。
- 返回原因至少区分 `matched`、`keyword_unmatched`、`excluded`、`when_false`、`invalid_rule`。非法规则、表达式错误或缺失状态引用视为不激活并返回带来源诊断，不隐式通过。禁用由所属领域处理并记录 `disabled`。

不支持 manual、递归扫描、概率和冷却。世界书、角色和状态根复用同一算法，但当前选中玩家角色资料的固定提供规则、禁用策略、排序、世界书锚点以及激活状态根关联的工具可写范围，仍由各自领域决定。

## 扫描时机

使用当前世界线、压缩前的候选叙事和当前 User。Window 先限制最近 N 条；Summary 使用已有最新摘要和其覆盖边界之后的候选叙事；本轮稍后新生成的摘要不参与本轮扫描。候选一经匹配即冻结激活结果；预算导致后续历史裁剪或摘要时不重新匹配、不重新渲染。Message 状态由父链独立读取，Global/Session 从对应记录读取，绝不取被激活状态的子集。具体预算与摘要顺序见[Context Strategy](context-strategy.md)。

## 验收

覆盖 always、any/all、多个消息命中、排除词、when 的组合，匹配大小写与消息边界；验证 null/缺失、错误诊断、预览/运行一致及三个领域共用算法。验证压缩前匹配一次、压缩后不重新匹配，分支及完整状态读取互不串线。
