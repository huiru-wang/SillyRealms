# ServerV2 叙事输出块实施任务

状态：待执行。本轮只提交方案。

方案：[server-v2-narrative-output-design.md](server-v2-narrative-output-design.md)。

## 1. 定义输出结果存储契约

- 在 sessions 模块定义并公开 output 的领域类型：contextEligible、stateUpdate、actionSuggestions。
- 明确 accepted updates 与逐项 results 的结构、错误码和状态；metrics.requests 不变。
- 增加受控叙事助手保存能力；公共追加/编辑禁止伪造或删除 output。
- 编辑正文时使 contextEligible=false，保留结果记录；其他 extData 更新保留服务端字段。

验收：旧 entry 无 output 可读；用户不能伪造结果；编辑正文后不重建旧数据块；无新表或 schema version。

## 2. 完成流式分离与严格解析

- 增加 output/stream-splitter、parser、strict-json 纯实现，参考 V1 但不导入旧代码。
- 跨分片识别保留标签、隐藏尾部、不完整前缀、UTF-16 代理对及 256 KiB 尾部上限。
- 对最终 snapshot 重新分离，解析、保存、最终事件使用同一结果。
- 合法边界下两个数据块独立解析；歧义框架整体失败。

验收：delta/最终 snapshot/持久化正文不泄露数据块；坏 JSON 不影响清晰边界下的另一个块；取消不补发隐藏内容。

## 3. 扩展 StateService 的模型更新候选能力

- 新增 prepareMessageUpdates，复用现有路径/JSON/类型/rules 校验和继承快照处理。
- 限制 message scope 与最终 activeRoots；严格拒绝缺失路径，公共 PATCH 的忽略语义不变。
- 按顺序在副本上应用有效项，返回接受项、逐项结果、整体状态与候选快照。
- 保留其他根和条目元数据，不把自然语言 rules 当作可执行规则。

验收：同值、空数组、部分拒绝、全拒绝、重复路径、数组整体替换、null、非激活根、路径不存在和规则覆盖失败。

## 4. 启用本轮输出提示词与处理规则

- PresetService 提供内置输出提示词解析/默认补足，不让 usecase 依赖 presets 内部实现。
- 两项作为默认能力；旧 enabled 不再禁用执行，缺失/空提示词使用默认值；不批量更新预设。
- compile 纳入本轮实际状态材料、输出要求和固定格式示例；最终 activeRoots 随编译结果传给收尾。
- 解析建议数组并独立于状态结果处理；明确正常正文+坏数据块仍 completed，结果通过 output 查询。

验收：无激活状态不要求 state_update；行动建议始终要求；模型错误/截断/取消不执行块；不新增模型调用或重试。

## 5. 分开展示、激活、摘要和模型历史

- history/materials 明确纯正文投影与主模型投影，不把带 JSON 的历史喂给关键词扫描。
- 从 contextEligible 结果重建有效块；partial 只含已接受更新；不伪造缺失块或将失败改为空数组。
- 摘要输入与 sourceHash 继续仅使用干净正文；历史重建不触发任何写入。
- prepare-context 按重建后的实际消息及本轮完整输出契约估算候选，不在发送前偷偷追加内容。

验收：后续请求保留有效格式示例，UI 正文不含块，历史状态不会重复结算；建议不进入摘要事实；裁剪/摘要后预算包含真实发送内容。

## 6. 接入叙事提交与通知

- usecases.ts 为 narrative 注入同步 TransactionRunner。
- model-call 接入叙事专用分流，摘要纯文本调用保持既有行为；仍直接使用 EventHub。
- execute 在最终校验后同步读取当前前驱快照、计算状态、原子追加助手正文/output/state/metrics；用户和已存摘要不回滚。
- 首条 user 终态仍独立保存；形成通知后冻结收尾决策，释放执行锁并按序发布。
- 取消/失败保存干净部分内容，输出块 skipped；无正文不为数据块造空助手。

验收：助手追加失败无状态变化/建议 ready；tip 冲突不覆盖；终态记录失败保留已提交助手与状态；同会话执行锁覆盖处理与落库，不扩展编辑/删除锁。

## 7. 启用状态/建议事件及历史读取契约

- 状态实际变更提交后发既有 state.changed，path="" 表示完整有效 message 快照。
- action_suggestions.changed 使用 V2 扁平结构，清空时 messageId=null、items=[]，ready 时带助手 ID。
- run.created 后清空旧建议；完成提交后仅给完成且 ready 的轮次发可点击建议。
- 终态后的输出诊断通过已有单轮详情读取，不新增状态或建议 HTTP 端点，不增加 run.phase。

验收：事件只在对应提交后产生；清空/ready 顺序明确；活跃、停止和 unknown 轮次不恢复上一轮建议；终态后无本轮通知。

## 8. 函数验证与文档同步

- 为解析、模型历史、状态候选和收尾编排补充必要的函数测试，重点验证行为而非实现细节。
- 运行 ServerV2 相关 modules/usecases/infrastructure/http 工具函数/架构测试、typecheck、lint，不运行路由链路或真实服务。
- 更新 server-v2-narrative、server-v2-events、server-v2-http 与相关 AGENTS，删除“postprocess 一律跳过/仅预留建议”的过期描述。
- 文档明确默认能力、completed 与输出结果的区别、存储结构、历史投影、并发边界及用量不变。
- 实施完成后按用户授权提交并推送实现；本轮仅提交两份方案文件。

验收：原 Server/Studio 未改，StudioV2 舞台未假装完成适配；无新增表、任务框架、恢复逻辑或额外模型请求。
