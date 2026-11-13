# 2026-11-13：共享 Runtime、双 Runner 与当前请求预算

状态：已按批准方案实现并进行离线验证。源方案：[SRRuntime 与 Context v2](../../plan/sr-runtime-context-architecture-v2.md)。

## 决策

1. 以 SRRuntime 作为唯一生命周期协调器，DirectRunner / AgentRunner 只返回执行结果。冻结规则用 RuntimeConfig，运行事实/进度用 ExecutionContext；配置合并、摘要和最终化保留为所在模块内的函数，不引入额外服务层或策略平台。
2. 两种模式共用 ContextManager、ModelClient、RunStore、UsageStore 和 sessions/entries。切换模式不分历史，不复制持久化或用量实现。Direct stopped 丢弃状态候选；Agent stopped 保留合法 workspace，failed 丢弃。
3. 每个 generation/continuation 先测完整当前 payload，满足输出/安全余量后才发送。超限只压缩更旧净叙事，保留最近五轮，重建重测。unknown 明确失败，不依赖上一轮 Usage 预测。
4. 摘要独立预算、独立真实 Usage、无递归；R=0.75、输出 min(2048,model.maxTokens)、每请求最多两次变换、每 Run 最多八次摘要调用。R 是离线边界验证后的内部初始值，后续质量调优需要真实模型证据。
5. 首期仅支持有官方 tokenizer 和中途 system 协议依据的 DeepSeek V4.1 Flash 文本适配。实际 BPE 加包装预留只能标记 estimated；不为扩大表面支持而伪造 exact 或跳过 Provider 语义验证。
6. 初始合格摘要随 startRun 原子提交；续轮合格摘要只覆盖旧历史，随非 stopped 终态提交。状态/公开结果/摘要原子提交后通知；Usage journal 独立且幂等，准备失败也结算已发生调用。
7. v1 → v2 增量迁移先备份、单事务升级、保留数据。新会话 Direct；旧工具基线 Agent；已有显式模式或叙事扩展证据按来源保留。旧的清会话/重建预设方案不进入本次范围。
8. phase 为 SDK 显式订阅扩展，终态优先；公开投影统一且不泄漏私有尾块/Prompt/reason。恢复靠查询活动/持久 Run，不声称 SSE 持久重放。

## 取舍与后续

当前计量支持范围比模型目录小，用户选择未支持模型时会收到明确错误；这是可验证计量的边界，后续需要逐一新增 tokenizer、payload 和 Provider 语义证据。JSON BPE 及预留不能取代 Provider 精确模板计数，窗口溢出仍可能发生，当前不自动重试。

离线 mock transport 能证明 SDK 实际发送语义，不能证明端点已接受或真实生成能稳定遵守尾块格式。真实付费验收、生产数据库升级、提交/推送独立于代码实现，不随文档编辑发生。

实现与 API/存储规范见 [Runtime 状态](../technical/runtime-context-v2.md)、[预算闭环](../technical/context-compaction.md)、[契约](../data-formats/runtime-v2-contract.md)。
