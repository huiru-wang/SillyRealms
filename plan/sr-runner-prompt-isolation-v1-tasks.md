# SR Runner Prompt 构建隔离执行任务 v1

> 日期：2026-11-15。状态：待实施，以下任务均未完成。
> 方案：[Runner Prompt 构建隔离方案](./sr-runner-prompt-isolation-v1.md)。
> 本次仅保存文档，不修改代码；执行前需获得明确实施指令。
> 所有任务由同一 agent 顺序完成，复核作为单独步骤进行，不使用子 agent。

## 任务顺序

```mermaid
flowchart LR
    T1[核对基线与隔离回归] --> T2[显式类型与材料提取]
    T2 --> T3[拆分三类 Prompt]
    T3 --> T4[接入统一请求组装]
    T4 --> T5[模式与预算回归]
    T5 --> T6[独立复核与修正]
    T6 --> T7[清理旧入口与最终验收]
```

## T1 — 核对基线并建立隔离回归

依赖：无。负责人：当前 agent。

- [ ] 检查 git status 和相关文件，记录其他未提交变更，禁止覆盖。
- [ ] 对照方案记录的提交及当前文件历史，确定 Agent 基础提示和摘要指导的恢复文本。
- [ ] 记录当前 Direct 已确认的规则、示例、能力策略和请求顺序，作为本次保留项。
- [ ] 建立受控夹具，覆盖 Direct、Agent、Summary 的提示归属与模型请求结构。
- [ ] 检查所有 buildContext、SR_SYSTEM_MAIN、摘要指导和类型推导消费者。

文件边界：Server 测试；读取相关源文件及历史，不改数据库或真实配置。

验收：基线明确区分“当前 Direct 要保留”与“Agent/Summary 要恢复”，测试能发现模式串用，不能仅断言字符串存在。

## T2 — 提取显式类型和共享材料

依赖：T1。负责人：当前 agent。

- [ ] 新建 prompts/types.ts，定义预设节点、状态项、材料、trace、构建结果等必要契约。
- [ ] 用显式契约替换 runtime/types.ts 和统计函数对具体 buildContext 的 Parameters/ReturnType 依赖。
- [ ] 将公共筛选和材料提取移入 context/materials.ts；输入必须包含本次候选历史，保持无 I/O。
- [ ] 保留角色 prompt 加载、load.mode=never、状态激活、世界书原始顺序及 anchor/position 元数据。
- [ ] 让材料与激活结果配对返回，避免不同历史之间交叉复用。

文件边界：runtime/types.ts、context/materials.ts、context/activation.ts、prompts/types.ts 和对应测试。

验收：材料层无 Direct/Agent 输出文案；不丢失只读 scope、状态约束或 Agent 预设兼容字段；相关类型检查通过。

## T3 — 拆分 Direct、Agent、Summary Prompt

依赖：T2。负责人：当前 agent。

- [ ] Direct system/builder/extensions/example 分别持有基础提示、布局、协议与示例。
- [ ] 保留 Direct 每行一个 JSON 状态对象、代码块空骨架、一个完整 few-shot 和明确的实际输出格式要求。
- [ ] Agent system/builder 独立持有恢复后的基础提示及现有预设/工具说明逻辑。
- [ ] 新建 prompts/summary.ts，恢复确认的摘要指导；summary-generator 保留模型调用与失败处理。
- [ ] prompts/shared.ts 只提取必要纯函数，不重新共享大段系统提示。
- [ ] Direct 有效开关继续来自冻结配置；不在 Prompt builder 中修改配置，也不引入插件框架。

文件边界：prompts/**、原 context/prompt-builder.ts、direct-prompt.ts、system-main.ts、compaction/summary-generator.ts 及相关测试。

验收：Direct、Agent 和 Summary 可独立构建；Direct 示例通过执行侧解析和数据校验；Agent/Summary 不依赖 Direct 文案。

## T4 — 接入统一候选请求与最终请求构建

依赖：T3。负责人：当前 agent。

- [ ] ContextManager 只根据冻结的 execution.mode 选择一次叙事 builder，拒绝隐式回退到其他模式。
- [ ] preview/final 共用“提取材料 → builder → 实际工具声明/选项”路径。
- [ ] 保留首次 await 前来源冻结；最终历史确定后重新计算材料和激活，再冻结执行权限。
- [ ] 将最终 messages/trace 和请求指纹关联保存，保持估算和实际 Provider payload 一致。
- [ ] Agent continuation 复用最终冻结的基础消息并追加工具调用/结果，保留原有 toolChoice 变化，不重新估算或压缩。
- [ ] 保留 Direct 固定开启策略、有效来源报告和无激活可写状态时 not_required 的行为。

文件边界：context/context-manager.ts、runtime/types.ts；只在必要处调整 runners/agent-runner.ts 的内部契约使用，不重写 Runner。

验收：选择的提示模式和 Runner 来自同一冻结配置；完整请求预算没有遗漏系统提示、few-shot 或工具声明。

## T5 — 验证模式隔离、压缩和协议兼容

依赖：T4。负责人：当前 agent。

- [ ] 用 mock Pi 请求验证 Provider 实际 payload 的消息顺序、角色、工具及指纹。
- [ ] 覆盖可写/只读状态、无可写根、两项能力的构建组合、建议数量 2/3/4 和业务偏好转义。
- [ ] 覆盖最终摘要/保留历史/当前输入激活，以及被丢弃历史不得授予权限。
- [ ] 覆盖配置在 await 期间变化、本轮配置冻结和 Agent continuation 工具消息配对。
- [ ] 回归缺失信封、畸形 JSON、状态部分失败、建议失败、停止和取消，不放松失败矩阵。
- [ ] 若提示长度改变压缩测试触发条件，记录夹具调整依据，保留对生产阈值和目标的断言。

文件边界：Server 测试；生产代码仅修复本次拆分引入的问题。

验收：测试同时验证成功路径和关键负向边界，不调用真实付费 Provider，不访问用户数据库。

## T6 — 独立复核并修正

依赖：T5。负责人：同一 agent，切换到独立复核步骤。

- [ ] 按源文件和实际 payload 复核 Direct 优化未再改变 Agent/Summary 文案。
- [ ] 检查类型依赖方向、共享模块内容和是否存在重复可调用的主实现。
- [ ] 复核候选材料与最终权限的绑定、一次压缩约束和 continuation 行为。
- [ ] 复核原始配置保存、API effective/sources 和执行策略一致。
- [ ] 将发现的问题明确记录并修复，按影响范围重新验证。

验收：无未解释的测试失败，无未解决的模式串用或权限冻结问题；不能以“测试都绿”替代范围复核。

## T7 — 清理旧入口与最终验收

依赖：T6。负责人：当前 agent。

- [ ] 检查全部引用后，移除已完成迁移的旧入口和临时转发，保留其他用户改动。
- [ ] 按实际结果更新 AGENTS.md 的相关说明；正式 docs/ 仅更新实际变化的产品/SDK 行为。
- [ ] 在项目根目录运行 pnpm typecheck、pnpm lint、pnpm test、pnpm build。
- [ ] 记录实际命令、结果、未执行检查及原因；有修正则重跑受影响检查。
- [ ] 将本清单中完成项标记，并附最终变更摘要、风险和验证记录。

验收：方案中的关键标准通过，旧引用无遗漏，不执行提交、推送、部署或真实数据库操作。未做真实模型对比时明确提示遵循率尚未实测。
