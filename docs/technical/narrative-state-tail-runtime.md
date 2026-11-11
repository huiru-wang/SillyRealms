# 单次叙事与状态尾块：技术实施契约

> 状态：已确定的目标契约，待实施（2026-11-11）。本次只更新文档；现有运行时代码尚未切换，未清理真实会话。
>
> 规范详情与验收以 [实施方案](../../plan/sr-narrative-state-tail-protocol-v1.md) 为准；架构边界见 [持久决策](../decisions/narrative-state-tail-protocol.md)。

## 1. 当前实现与目标路径

| 位置 | 当前实现事实 | 实施目标 |
|---|---|---|
| agent/runtime/agent-runtime.ts | 管理会话与世界运行占用、停止、幂等与任务释放 | 保留协调职责，叙事交给单次生成路径 |
| agent/runtime/agent-runner.ts | 一轮内循环请求模型、执行工具并追加工具结果，检查必需状态工具 | 通用循环保留，叙事不调用它 |
| agent/model/model-client.ts | 单次事件流、取消竞速和 Usage 记录 | 复用；检查正常结束原因，不只判断 done |
| agent/context/prompt-builder.ts | 依照可配置节点顺序展开，世界书按锚点拼入节点 | 内置顺序固定，自定义区前置，世界书独立，状态在历史后 |
| agent/context/context-manager.ts | 激活状态后注册状态工具，独立处理压缩 | 叙事无工具；压缩保持独立 |
| agent/persistence/run-store.ts | completeAssistant 可能把原始响应作为可见项；finalize 对 stopped 也写 workspace | 专用净正文落库与显式状态提交资格，停止前未提交不写状态 |
| domain/session/history-runs.ts | 提供前端历史及终态消息投影 | 与模型历史、摘要输入一起过滤所有 raw/tail |

这些职责分离不要求删除 agent 目录或把生命周期逻辑搬进 Provider。update_state 和 ToolExecutor 保留；状态尾块调用领域校验，不伪造工具调用。

## 2. 消息、Provider 与 Usage

平台规则 → 风格 → 可选自定义消息 → 玩家设定 → 活跃角色 → 活跃世界书 → assistant 摘要 → 原生 user/assistant 历史 → 平台当前状态/输出协议 → 当前 user 输入。

内置设定是各自独立的 system；自定义区保留原 role、正文和内部相对顺序。角色及世界书激活机制保留，所有 lore 按 order/原索引进入 world_info。后置状态取本轮开始时的权威快照。

当前安装的 pi-ai 1.5.0 在 transcript/Provider 层可能折叠或移动 system。实施必须检查最终请求 payload，修正支持原位系统指令的适配路径；无法遵守顺序的叙事模式在请求前明确报错。工具能力测试不证明这种顺序可用。

正常生成只有一次请求，Usage 包含正文和不可见尾块。摘要 Usage 独立计入；通用循环若被其他功能使用，继续记录其真实请求次数。系统/摘要/历史的 UI 分类依据内容职责，后置状态仍属于系统。

## 3. 接收、校验、提交

1. story 阶段保留可能组成标签的尾部前缀，已确认正文先落库再发送。
2. 开始标签识别后不再发送后续模型文本；最多缓冲 262144 UTF-8 字节的 JSON 内容。
3. 唯一结束标签后只接受空白；不提前提交第一个尾块。
4. 等待 Provider 正常 stop。length、toolUse、deferred、错误或中断不满足提交条件，也不触发续轮。
5. 整个 JSON 解析为不超过 100 项的数组，再在隔离 workspace 中顺序处理。坏项跳过报告，重复/父子路径不重排；value 完整替换。
6. 最终提交前检查停止；检查至同步事务提交之间不 await。状态和 Run 结果原子保存后，才通知真实状态变化与 Run 终态。

正文的字面标签使用 HTML 实体，保持原 Markdown 解释；代码区域展示实体字面文本。JSON 内使用标准 Unicode 转义，由 JSON.parse 恢复状态值。协议识别前后不新增实体解码。

缺失、截断、JSON 无效、超限、重复尾块等使 Run failed，保留故事、状态不变并提示未同步。无可写状态时正常结束仍残留协议标记前缀，也按协议错误失败，结果保持 not_required；不补发前缀、不提示缺少尾块，且不覆盖原本的 Provider 错误或主动停止原因。单项无效不等于整轮失败；提交有效项后 completed，持久化 partial 报告。显式停止优先于尚未发生的提交，提交之后不回滚；SSE 断开仍只是断订阅。

## 4. 落库与对外契约

- 可见 assistant 只保存净故事并结束 streaming 状态。
- 原始完整/不完整响应若保留，始终 nonNarrative，即使没有 partial entry；不把 raw 回写可见消息。
- RunStore.narrative、history-runs、摘要输入、终态 messages 必须一致。
- 失败故事保留，下一轮仍读取权威状态快照；不从失败尾块补偿。
- 按方案在 ext_data.run.stateUpdate 持久化结果，并同步 Run 查询、终态事件及 Web/SDK 类型。
- 跳过项使用 index/errorCode/errorMessage；无虚构的 tool.failed/toolResult。
- run.failed 沿用统一错误字段，并为协议错误增加稳定领域错误码。state.changed 仅在提交之后且状态实际变化时发布。
- 现有通用循环的工具事件和停止语义保持独立。

## 5. 一次性升级契约

当前数据库会话关联只有 sessions 与 entries 两张表，Run、摘要、工具记录、消息状态及指标都在其中。entries.session_id 没有外键级联。

实施升级须在独占数据目录、Runtime 尚未创建及 HTTP 尚未开放时完成：一致性备份 → 新版本门槛 → 单一事务内规范化预设/世界书、先清 entries 再清 sessions、验证保护范围、推进版本 → 提交。失败回滚且不开放服务，成功后不会再次清理。

预设只去掉 worldState/postHistory 并规范化固定顺序、自定义前置区；世界书只去掉退役的 anchor/position，保留内容、激活和 order。旧导入采用同一明确规范化并报告，新编辑拒绝退役字段。

保护 worlds/global 状态、其他预设正文与配置、模型/凭据、app_settings、标签及世界源文件。当前无会话专属文件目录，不删除 DB/dataDir，也不调用 world 删除路径。版本 1 的旧迁移会重建预设，不能复用；新数据库和不支持的旧版本分别处理。

仅清理旧会话字号键 sr:session:<id>:reading-font-size 和失效视图，保留全局浏览器偏好和升级后新会话的偏好。移除 sr_instruction 专用输入/解析/展示，保留旁白、话语和通用输入功能。

**本次没有执行上述任何数据升级或删除。**

## 6. 实施与验收状态

待完成：单次叙事路径、解析器、状态结果契约、固定 Prompt 的真实 Provider 适配、节点/锚点规范化、旧输入移除以及明确授权后的会话清理。

实施验收必须覆盖完整计划中的分片/转义/限额、重复路径、结构与单项错误区分、停止竞争、失败故事持久化、实际 payload 顺序和临时数据库迁移保护。文档完成不代表代码或数据迁移已经完成。
