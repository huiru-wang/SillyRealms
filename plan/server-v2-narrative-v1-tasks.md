# Server V2 叙事首版任务拆解

依据 [技术方案](server-v2-narrative-v1-design.md)。本文件是待执行任务，保存方案不代表授权立即实施。全部任务在 ServerV2 内完成，不启动真实服务或模型，不迁移 StudioV2 运行 UI。

## T1：固定首版契约与模块公开类型

- [ ] 建立 `usecases/narrative/types.ts`、`events.ts`，定义提交、受理、取消、上下文快照和五类事件。
- [ ] 明确一次成功事务保存两条消息；失败/停止无消息；runId 与模型 requestId 不等于事件 ID。
- [ ] 从各模块 Service 显式导出需要的领域类型；不从 schema/repository 导入。
- [ ] 补充集中错误码：并发、模型能力、超限、不完整输出、取消/运行不存在等；复用已有 TIP_CONFLICT 和凭据错误。

验收：类型契约可检查，未引入 runs/preparations/schema 变更。依赖：无。

## T2：实现 pi 的最小底层适配

- [ ] ServerV2 添加与原 Server 相同的 pi-ai 1.5.0 依赖，不升级旧项目。
- [ ] `infrastructure/pi/client.ts` 提供目录、模型解析及单次流；显式密钥，maxRetries=0，无工具循环。
- [ ] 保留必要的消息顺序兼容检查，限定旧供应商特例；不增加 payload 预演/指纹系统。
- [ ] `usage.ts` 转换缓存/输入/输出口径，未上报用 null；实现错误脱敏和及时取消消费。
- [ ] 用有限异步迭代器及纯函数验证终态、异常、无 usage、缓存、取消和迟到结果。

验收：可在函数测试中完整消费一条流，不依赖 DB/EventHub/HTTP。依赖：T1。

## T3：读取领域快照与选择叙事材料

- [ ] `context.ts` 通过公开 Service 取得 session/world/preset/model/history/state，不回退应用默认项。
- [ ] 捕获 nullable tip 与空历史，校验角色和消息 payload；明确拒绝首版不支持的 compaction 历史。
- [ ] `materials.ts` 保留角色/世界书的 enabled、load、keywords、order 语义及 user 宏替换。
- [ ] StateService 增加必要的只读 when 求值能力，迁移受限 AST 规则；不依赖 worlds 私有文件或 eval。
- [ ] 函数测试验证条件选择、排序、三类状态视图、空 tip 和缺失引用。

验收：得到独立领域快照与材料，没有 SQL、模型调用或状态写入。依赖：T1。

## T4：实现首版提示词编译

- [ ] `compile.ts` 迁移原模板解析与节点展开，保持 system/user/assistant 的顺序和历史消息角色。
- [ ] 排除全部 postprocess 节点；history.summary 为空，完整历史不自动压缩或裁剪。
- [ ] 读取预设 token 限制和模型参数；校验模型输出上限与可用输入预算，明显超限直接失败。
- [ ] 明确有效能力 full-history/postprocess=false；检查 pi 是否支持编译后的消息顺序。
- [ ] 测试默认预设、自定义插入节点、模板转义、输入不重复、没有扩展指令、超限与能力拒绝。

验收：给定同一快照得到同一核心上下文，不发额外摘要或预演请求。依赖：T2、T3。

## T5：实现单轮执行与一次成功提交

- [ ] `execute.ts` 消费 pi 流，局部聚合正文并直接通过 EventHub 发布增量，不透传业务回调。
- [ ] 检查 done、stopReason、toolCall、空正文及 delta/最终正文一致性；无 delta 时支持最终正文。
- [ ] 用现有 TransactionRunner + 两次 SessionService.appendEntry 保存用户/助手、metrics 并推进 tip。
- [ ] 两条 entry 传明确 parentId，state=null，extData={}；不持久化运行状态、失败片段或 thinking。
- [ ] 提交后才 completed；失败/停止只有一个终态。测试成功、模型错误、提交失败整体回滚和 tip 冲突。

验收：从快照到成功历史形成最小闭环，失败没有半轮数据库记录。依赖：T4。

## T6：增加提交/停止与内存生命周期

- [ ] `index.ts` 在首次 await 前占用会话 Map；同会话拒绝并发，不同会话独立。
- [ ] submit 返回受理标识，管理执行 Promise 并收敛异常；不增加任务队列、持久化去重或状态查询。
- [ ] stop 按 sessionId/runId 匹配，取消消费并防止迟到提交；终态后释放占位。
- [ ] shutdown 阻止新提交、取消当前轮次并阻止关库后写入；不等待无响应供应商无限结束。
- [ ] 直接订阅 EventHub 测试会话隔离、退订不取消、终态唯一、停止与提交边界。

验收：调用方不拥有执行生命周期，断开事件连接不影响正在生成的轮次。依赖：T5。

## T7：接入 HTTP 与装配

- [ ] 增加 narrative 路由：提交与显式停止，复用现有会话访问检查/Origin/响应包络。
- [ ] 增加 pi 目录查询和 test-model 用例；模型检测只使用已保存配置、一次短请求，不创建叙事消息。
- [ ] usecases.ts/server.ts 注入同一 EventHub、PiClient、各模块 Service 与 TransactionRunner。
- [ ] 保持已有 SSE 和 entries 读取接口，不增加 run 查询、重放、恢复入口或独立正文 HTTP 流。
- [ ] 以参数解析、错误转换和装配类型检查验证边界；不运行 HTTP 注入测试或启动监听器。

验收：接口职责明确、无 SQL/供应商逻辑进入 route，静态检查通过。依赖：T2、T6。

## T8：函数级验收与事实文档

- [ ] 运行本次新增函数测试及受影响模块的已有函数测试、ServerV2 typecheck/lint。
- [ ] 核对没有导入旧 Server 内部模块、没有新增表或恢复逻辑、没有将业务回调逐层传递。
- [ ] 更新 `docs/runtime/server-v2-http.md`；新增叙事事实文档，说明原子提交、事件、失败丢弃及首版能力限制。
- [ ] 更新 ServerV2 和根 AGENTS.md 的已实现范围，保留 StudioV2 尚未接入运行页的事实。
- [ ] 汇报实现与验证结果、未实施的开局/摘要/后处理/UI，不把后续阶段混入本次交付。

验收：设计中的首版契约全部有实现或可验证证据，无服务启动/真实网络调用/新增端到端 mock 环境。依赖：T7。

## 推荐执行顺序

按 T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 推进。第一步只固定契约和 pi 最小能力；先让一次模型流能够被正确消费，再构建材料与持久化闭环，不先搭 runtime/engine 框架。
