# Text Rendering：独立共享的文本解析与转换能力

> 2026-11-04 设计，尚未实现。文本变量、条件表达式、状态引用与受控脚本/文本转换**不属于 Agent Context**。它们是 WorldCard 详情、Prompt 预览、Agent 输入构建和未来状态栏渲染都要共享的基础能力。

## 1. 模块职责

建议代码位置：`packages/core/src/text/`（Monorepo Web/Server 可共享）。不要放在 `agent/context/`；不提供数据库访问、世界书筛选、状态更新、模型调用或 UI 渲染生命周期。

~~~ts
type RenderEnvironment = {
  variables?: Record<string, string | number | boolean | null>;
  state?: StateSnapshot;
  // 预览模式可传当前实例状态；编辑世界卡时使用默认状态或显式预览值
};
type TextTransform = {
  type: "replace" | "regex"; // 首期声明式安全转换
  // 具体字段由统一的安全文本转换协议定义
};
function evaluateCondition(expression: string, env: RenderEnvironment): boolean;
function renderText(source: string, env: RenderEnvironment, transforms?: TextTransform[]): string;
type TextPart = { text: string; template: boolean };
type RawMessage = { role: "system" | "user" | "assistant"; parts: TextPart[] };
function renderMessages(messages: RawMessage[], env: RenderEnvironment, transforms?: TextTransform[]): ModelMessage[];
~~~

首期支持 `{{user}}`、其它明确暴露的角色/世界变量、`{{state:/角色/字段}}`、安全只读条件 `if / else if / else`、受限表达式（布尔/比较/数值/字符串/null 和括号）以及受控替换/正则转换。静态渲染时缺少运行状态的字段可显示占位符或清晰诊断，不偷偷假设当前会话事实。

## 2. 三个主要使用场景

| 场景 | 输入来源 | 行为 |
| --- | --- | --- |
| AgentContext | 预设节点、世界书内容、角色正文、完整状态、历史 | 所有 NodeBuilder 输出带 `template:true/false` 片段的 RawMessages 后统一调用 `renderMessages` 一次，真实模型输入随之确定；用户原话、历史正文为 literal，不参与模板展开 |
| WorldCard 详情、摘要 Prompt 与创作者预览 | 世界卡正文、Preset.summary_prompt、变量示例、当前完整状态或编辑器提供的初始状态 | 使用相同的 `renderText`，不创建 Session，也不调用模型 |
| 状态栏/扩展 UI（未来） | UI 模板与当前活动分支全量状态 | 使用 `renderText` 安全渲染展示内容；状态变更来自 State Domain，不由模板执行修改 |

## 3. 条件加载的共享解析器

世界书 `load.when` 与状态根 `load.when` 调用**同一个** `evaluateCondition`，参数必须包含这一轮**完整 StateSnapshot**，不能使用筛选后的小状态片段进行判定；否则可能出现循环依赖。关键词/常驻加载的命中逻辑在 AgentContext/lorebook 和 State Domain 负责，表达式求值则复用此模块。

条件错误由调用方定位到世界卡条目或状态 Module；不直接把无效表达式变成“命中”或任意执行代码。

## 4. 脚本/文本转换边界

用户所说的「变量替换、脚本等」统一进入**文本处理阶段**，但首期不直接执行来源卡携带的任意 JS/EJS。可执行的受控规则限于明确支持的纯文本替换/正则、只读表达式与后续显式设计的受限脚本接口；导入的未知脚本保留原始数据但不运行。

对于安全的文本处理流水线，建议顺序：合并世界书 before/body/after + 系统/自定义 Node 输出（标记可渲染模板片段）→ 仅模板片段的只读条件与变量展开 → 受控文本转换 → 按顺序拼接 literal 原文和已处理模板 → 生成最终模型消息。**不得把历史用户/模型消息当作模板重新运行。**调用方可指定 `usage="prompt" | "preview" | "ui"` 的文本转换策略，以免「仅用于展示」的脚本意外改写模型 Prompt；共用的是引擎，实现可由场景提供不同规则。

## 5. 验收

- 同一表达式在 AgentContext、世界书 when、状态模块 when、世界卡详情和 UI 模板里一致。
- 完整状态可供只读变量，但渲染器没有写状态、网络、文件或任意 JS 执行能力。
- 节点统一渲染一次，literal 用户/历史原文不解析，无二次插值、转义偏差或循环执行；错误能定位具体模板来源。
- 全部功能独立于 Session/Provider/Pi，可单独测试。
