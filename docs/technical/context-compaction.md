# 当前请求预算与历史压缩

更新：2026-11-13。SRRuntime v2 的 Direct 首次 generation 与 Agent 每次 generation/continuation 都使用 `current_request`。旧的“上一轮 reported input + output 触发压缩”仅保留纯函数回归证据，不参与生产降级。前端 latestContext 继续表示最后一次真实模型请求的用量，不能用它代替本次准备的测量。

## 一次请求的预算

1. 冻结配置、内容来源、状态基准和激活权限。
2. 编排完整消息；Agent 的工具 schema、toolChoice、当前工具往返在测量前进入请求。
3. 使用模型适配器预览真实发送 payload，生成含 method、quality、version、fingerprint 的报告。
4. 仅当输入测量 + 本次输出预留 + 1,024 安全余量不超过有效窗口，才生成不可变 PreparedRequest。
5. 发送前再次验证请求 fingerprint；最终 SDK payload 与预览不一致时阻止发送。

有效窗口为预设档位与模型 contextWindow 的较小值。compact / standard / extended 分别为 131,072 / 262,144 / 524,288。当前输入已经包含在测量里，不再扣除旧的 2,048“下一轮输入”额度。输出不得超过模型上限。

生产计量仅支持官方 DeepSeek V4.1 Flash 文本适配，采用真实 BPE 加包装估算，标记 estimated；其他路径 unknown 明确失败。详细支持范围见 [Runtime 实现状态](runtime-context-v2.md)。测量不新增网络计数调用，不计入 Usage，不冒充供应商报告。

## 超限后的闭环

只有完整请求超限才尝试 summarize_history。保留最近五个旧 user turn；当前输入、平台约束、状态权限、当前 Agent 工具调用和结果始终受保护。只压缩更旧的净叙事及既有摘要，原始 entries 从不删除或改写。

候选生成后重建完整请求并重测；测量没有下降、覆盖边界不合法、仅剩不可压缩内容、达到每请求最多两次变换或每 Run 最多八次摘要调用时明确失败。预算仍不满足，不发送 generation/continuation；没有自动 Provider 溢出重试、递归摘要或改模式回退。每次 continuation 都重新走同一流程，不能在计量后追加工具结果。

激活规则只按压缩前的固定来源执行一次。摘要不能启用新状态根、替换本轮配置或执行任意工具。

## 摘要本身也有预算

设有效窗口为 W、摘要输入比例为 R、摘要独立输出上限为 O、安全余量为 S：

```text
summaryInputLimit = min(floor(W × R), W − O − S)
R = 0.75
O = min(2048, model.maxTokens)
S = 1024
```

R 必须有限且满足 0 < R <= 1。每个完整摘要请求包含旧摘要、摘要指令、缺口信息、来源包装和本批正文；选片段后重测完整请求。按 Unicode codepoint 切分。12,000 字符上限仅为辅助资源边界，不作为 token 换算。

0.75 已通过预算数学、分块、固定输入耗尽及小模型窗口的离线边界测试，作为本次内部初始值。它不是“摘要输出压缩到原文 75%”，也不是经过付费模型质量/成本调优的最优比例。没有新增必填 UI 参数。

摘要必须正常 stop、非空、没有工具调用；错误、length、取消、重复终态、终态后文本或 delta/final 不一致都不合格。每 Run 最多八次 summary 请求，第九次在 Provider 调用之前被拒绝。已发生请求的实际 Usage 仍结算，不能因准备失败清零。

## 提交时机与缺口

| 候选 | 落库时机 | 停止行为 |
|---|---|---|
| 初次准备的合格摘要 | 与本轮 user Entry 在 startRun 同一事务提交 | startRun 前停止丢弃；已经提交的不回滚 |
| Agent 续轮的合格摘要 | 非 stopped 最终化事务中提交，包括生成随后 failed | stopped 丢弃尚未提交的候选 |
| 不合格或预算仍不满足的候选 | 不提交 | 不改变原历史/覆盖边界 |

所有 coveredThroughEntryId 必须属于此前净叙事；续轮摘要的覆盖 seq 必须早于本轮 user。既有摘要再使用时重验 parent chain 与覆盖边界。

stopped、failed、interrupted 和状态 disabled/partial/failed/cancelled 的受控缺口被传入摘要，并保留有界去重标记（最多 32 项）。摘要 prompt 不得把未完成或未同步情节描述成已成功修复；sr_instruction 文本不作为摘要事实。状态权限与权威值始终来自基准快照。

## 用量与诊断

summary、generation、continuation 分开记入共享 ModelClient/UsageStore 的真实请求 journal。准备期失败且没有 user Entry 的用量进入 sessions.usage_json 的 unattachedTotals。崩溃恢复把已开始但无报告的请求标记 unknown，不伪造成零。

预算报告、调用次数和私有诊断保存在 ext_data.runtime；公开 DTO 不包含原始 Prompt、reason、key 或尾块。用量面板的 system/summary/history 字节比例仍只是结构示意，不参与计费或预算判定。

验证：budget-v2、summary-budget、compaction-lifecycle、usage、runtime 等测试；所有数据为临时 SQLite / fake Provider，实际 payload 验证使用离线 mock transport。
