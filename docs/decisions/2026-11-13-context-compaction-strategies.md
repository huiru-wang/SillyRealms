# 数值输入额度与一次 Run 准备

日期：2026-11-13。状态：已实现（Server）。依据：[批准方案](../../plan/sr-context-compaction-strategies-v1.md)。

## 决定

1. context_strategy 容量档位退出规范配置，统一 C=max_context_tokens、O=max_output_tokens；strategy 只选择 rolling_summary/sliding_window。C 是完整输入软阈值，至多为模型窗口 80%，同时预留 O 与 1024；达到 C 触发，目标 floor(0.6C)。
2. Run 准备期只整理一次。滚动摘要单次提交完整选中旧历史及旧摘要，先检查独立摘要预算；不分批、不切片、不递归重试。滑窗按固定预留选连续后缀；原始历史永久保留，切换策略/扩大额度可恢复。
3. 全量固定文本/包装估算不依赖专用 tokenizer。只有可证明纯追加且输入前缀完全一致时复用真实 reported input；默认零对象不等于已报告零用量。估算与真实计费分开。
4. 配置和内容来源先冻结，最终激活/状态权限从整理后的可用上下文确定，再保持整个 Run 不变。Agent continuation 不重复检查额度或摘要；请求身份与支持适配器的 wire 校验仍执行。超软目标继续，Provider 硬窗口拒绝正常失败。
5. v3 增量增加 run_preparations。返回 202 前，准备输入和 usage journal 同事务提交；准备成功后摘要/user/删除准备记录同事务交接；失败保留输入、终态及已发生用量，不进入正式历史。不能持久化终态时不发布成功/失败通知，等待恢复。
6. Server 查询提供可选失败阶段/类型、恢复建议及准备输入；SSE 和 Usage 不额外携带输入。用户使用新 requestId/当前 tip 主动重试。无自动重试、专用重试端点或持久 SSE 重放。

## 取舍

80/100/60 是本项目决定，不是通用最优参数或模型质量保证。固定粗估可能偏差，五轮保护/固定指令/激活变化可能导致达不到目标；Run 内工具增长也可能触发 Provider 窗口拒绝。完整历史过大而摘要一次装不下时明确失败，保留输入供用户调整。

旧档位兼容输入转换时私有记录来源；规范导出成为严格数值，再导入不携带隐式夹紧权限。前端仍只有旧档位编辑器，不能表示任意新数值；本期不改 Web/Studio/SDK，不宣称恢复 UI 可用。

迁移只增加存储，不清理会话/预设/世界文件。v1/v2 磁盘升级先备份、事务迁移，旧程序拒绝 v3；人工回滚须停服并保留升级后数据，不能自动合并。此实现只在隔离库和离线 Provider 验证，未迁移真实库或发起付费调用。

## 验证依据

compaction-strategies、compaction-lifecycle、run-preparation、model-usage-evidence、summary-budget、runtime-migration 及原有全量 Server 回归；实际 Pi mock transport 验证 payload、明确零 usage 和结构化窗口错误。现状和公开契约分别见 [上下文整理](../technical/context-compaction.md)、[Runtime 契约](../data-formats/runtime-v2-contract.md)。
