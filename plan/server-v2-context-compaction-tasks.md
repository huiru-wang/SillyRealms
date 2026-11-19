# ServerV2 摘要与自动裁剪实施任务

状态：实现与文档已完成。最终约定：成功摘要保存记录及 metrics，未知 usage 为 null；失败/中断摘要不保存记录或计量。

方案：[server-v2-context-compaction-design.md](server-v2-context-compaction-design.md)。

以下按依赖顺序执行；每项仅做必要的函数验证，最后统一类型检查和 lint。

## 1. 拆分上下文编译与预算

- 从 compile.ts 拆出有效预算 B、整理目标 T 和摘要预算计算。
- 纯编译允许返回超预算候选，最终断言留给编排阶段。
- materials.ts 接收明确 summary/history，history.summary 不再恒为空；按候选历史重算激活。
- rolling_summary 运行时校验 history.summary 仅注入一次，不改变已有预设读取能力。

验收：1024 余量、60% 软目标、非正预算、固定材料过大、重复/缺失摘要变量；默认预设无需改动。

## 2. 历史分组与摘要有效性

- 新增 history.ts，捕获 entries 的 runId/seq，独立投影 message 和 compaction。
- 按完整 run 选择连续前缀/后缀，保护当前输入，不区分开场。
- 解码最新摘要元数据，校验覆盖边界和 sourceHash；失效摘要回退完整原文。
- 复用 roleplay 指令区段解析，摘要来源只包含可见故事内容。

验收：首条 assistant、只有用户的失败 run、reasoning-only 条目、交错 runId、旧/非法摘要、消息编辑与不相关 state 修改。

## 3. 滑动窗口

- 实现从旧 run 到新 run 的裁剪候选选择。
- 每个候选重新编译，满足 T 优先；达不到软目标时选择符合 B 的最长候选。
- 不修改或删除 entries，不生成 compaction。

验收：完整轮次不拆分、零历史、当前输入保留、材料激活非单调、软目标不可达但硬预算可用、固定内容超预算。

## 4. 模型调用复用与滚动摘要

- 提取已有可取消流读取/调用计量能力，保持 ModelClient 契约和 pi 隔离。
- 实现最近 5 个历史 run 的原文保护和前缀选择。
- 使用同一模型的一次摘要调用，限制输入与输出，摘要内部消费不发布聊天 delta。
- 以 final snapshot 为准，验证正常 stop、非空、无工具调用；一次摘要后重新编译，仍超限直接 summary_capacity_exceeded，不继续处理。

验收：旧摘要合并、整项保护、不足 5 轮、摘要输入超限、最终快照修正增量、失败/截断/取消、最多一次摘要且不自动降级。

## 5. compaction 保存与父链接入

- 在 user 已保存的前提下追加同 run 的 compaction；沿用属主服务原子追加与 tip 检查，保存摘要及其 metrics；不新增异步编辑冲突处理。
- assistant.parentId 根据本轮是否保存 compaction 决定，不再固定为 userEntryId。
- 内部服务保护摘要 payload/extData.summary；HTTP 禁止伪造/修改 compaction。
- 保持 state=null 继承、结果位于首条 user、分页最多 5 组、savedMessageIds 仅包含 message。

验收：摘要提交失败不丢用户、摘要后超限保留完整摘要及用量、正文失败保留有效摘要、tip 指向摘要时能继续下一轮、seq 补查与 run 分页。

## 6. 按消息保存调用计量

- 摘要调用 requests 存在 compaction.metrics；正文调用继续存在 assistant.metrics，user.metrics 保持 null。
- 保持现有 requests 结构，不增加 status/purpose，不新增 setRunMetrics，不调整用户消息计量禁写规则。
- run.usage 汇总成功保存的摘要和正文调用，参与统计的任一未知则总量为 null；历史接口累加全部 entry.metrics。
- 失败/中断摘要不保存 compaction、不计入用量、不发 summarized；不生成空摘要占位记录。

验收：摘要后超限仍有摘要 metrics、双调用不重复统计、取消未知 usage、零调用不伪造请求、历史汇总包含 compaction；失败/中断摘要无记录且不计量。

## 7. 生命周期、事件与会话执行锁

- execute 接入整理流程，保持用户先持久化、一次 usage 与唯一终态。
- EventHub 使用 run.summarizing/run.summarized，不增加 run.phase/generating 或 data.phase。
- 一次摘要后仍超限直接 stop_reason=summary_capacity_exceeded；新增原因仅 summary_capacity_exceeded、summary_failed。
- 复用 active Map 实现会话执行锁，覆盖摘要到结算准备，失败/停止/关闭均释放，同会话拒绝第二个 run。
- 编辑、删除等操作接入锁的并发准入留待后续，本轮不扩展为通用锁系统。

验收：摘要期间停止、摘要后超限即结束、两次调用之间停止、正常关闭、异常释放锁、跨会话并行、事件顺序、摘要没有聊天 delta。

## 8. 文档与最终检查

- 更新 server-v2-narrative.md、server-v2-http.md、server-v2-events.md 与 ServerV2/根 AGENTS。
- 明确预算、保护轮次、摘要有效性、按 entry 的指标归属、摘要事件、执行锁、失败与历史兼容边界。
- 更新受影响函数测试及路由测试的类型/契约声明；不执行 HTTP 测试。
- 运行 ServerV2 modules/usecases/infrastructure/http 工具函数/架构测试、typecheck、lint。

验收：当前单次生成相关测试继续成立，双调用分支已覆盖，原 Server 与 Studio 运行页面没有改动，无新表/新服务。

验证完成：ServerV2 函数测试共 352 项通过（32 个测试文件；完整函数集 351 项及新增旧摘要合并用例），typecheck、lint 与 git diff --check 通过。未启动服务、执行 HTTP/浏览器链路或访问真实模型。
