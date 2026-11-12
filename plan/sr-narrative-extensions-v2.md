# SR 单次叙事扩展实施方案 v2

> 日期：2026-11-12。状态：实施方案，运行时代码待实施。
>
> 源码核对基线：`main@c435f3b`。本方案以实际调用链、状态校验、数据库及所有对外消费者为依据，不把已有设计文档当作已实现行为。
>
> 本次交付只保存、审查、提交并推送方案及其索引，不实现功能、不调用付费模型、不迁移真实数据库。
>
> 本文替代 [旧状态尾块 v1 计划](./sr-narrative-state-tail-protocol-v1.md) 中与叙事协议、能力配置、处理流程及本次升级范围冲突的部分。旧计划的会话清空、删除 `sr_instruction`、删除预设节点内容、破坏性预设/世界书规范化不属于本方案的执行步骤。通用工具能力继续保留。

## 1. 要实现的用户体验与决策

每轮只用一次叙事模型请求，先流式展示故事，再由服务端处理隐藏的扩展尾块。首批仅支持状态更新和行动建议；用户可在会话中开关，运行中的切换从下一轮生效。

| 决策 | 本方案采用的行为 |
|---|---|
| 模型调用 | 裸调用 ModelClient 的单次事件流；不注册工具、不传 tool_choice、不进入 AgentRunner 工具循环 |
| 输出分区 | 未包裹的 Markdown 正文 + 一个 `<sr_extensions>` 尾块；尾块内分别放两个带标签的 JSON 数组 |
| 状态更新 | `[{path, value, reason?}]`；value 是完整替换值；有效项按原顺序应用，无效项跳过并报告 |
| 行动建议 | `string[]`；点击填入 Host 草稿，由玩家自行编辑和发送 |
| 更新依据 | 提示模型提供简短事实依据；运行时 reason 可选且非阻断，不要求输出隐藏思维链或长篇推理 |
| 默认能力 | 状态更新默认开启；行动建议默认关闭，启用后目标数量默认为 3 |
| 配置优先级 | 平台默认 → 当前预设配置 → 会话显式开关覆盖；本轮快照冻结后不随配置变化 |
| 执行优先级 | 状态完整性和能力执行稳定性优先，然后减少 token；不为减少 token 取消服务端校验 |
| 失败隔离 | 正文保留；可独立确定边界的建议错误不阻断合法状态更新；状态部分成功或失败时建议不发布 |
| 人物识别 | 用净正文/历史关键词做本地候选识别，不增加第三个模型能力，不等同于确定在场 |
| 扩展边界 | 两个内建处理器和一个注册表足够；不新增工作流平台、工具代理循环或外部插件执行器 |

“单次”指正文、状态更新、行动建议共用一个生成请求。现有上下文压缩可独立请求摘要模型，它不属于这三个输出的续轮，也不能用于修复协议。不得宣传为“每次 Run 在任何条件下都只有一次网络模型请求”。

### 1.1 不在本次实施范围

- 自动补救模型请求、尾块重试、状态二次评审、生成后再调用一次模型写建议。
- 多会话分支、多用户权限、云同步、通用插件安装系统、异步能力队列。
- 新建独立 runs 表，仅为这两个能力重写现有持久化体系。
- 清空 sessions/entries、重置自定义预设、删除世界源文件、重置浏览器全局偏好。
- 删除 `sr_instruction` 专用输入或改变现有普通旁白/话语输入语义。
- 同步改造 `apps/studio` 的静态原型；本次真实客户端范围是 Web + Server + SDK。
- 通过回读旧协议文本，给旧历史伪造能力执行结果。
- 自动追补“状态关闭期间”发生的全部故事事件。

## 2. 已核实的源码现状

下表是实施前的事实；“需要改造”不是已完成状态。

| 位置 | 当前实现 | 需要改造 |
|---|---|---|
| [agent-runtime.ts](../apps/server/src/agent/runtime/agent-runtime.ts) | 管理锁、准备、幂等、停止、运行释放，转交 AgentRunner | 保留协调层，叙事转交专用单次生成路径 |
| [agent-runner.ts](../apps/server/src/agent/runtime/agent-runner.ts) | while 循环请求模型、处理工具、追加工具结果再请求 | 保留通用实现；叙事不调用该循环 |
| [model-client.ts](../apps/server/src/agent/model/model-client.ts) | 单次模型事件、取消竞速、请求 Usage | 复用；增加对叙事结束原因及最终消息的明确检查 |
| [context-manager.ts](../apps/server/src/agent/context/context-manager.ts) | 准备上下文、独立压缩、激活状态并注册工具 | 解析本轮能力快照，叙事准备不注册工具 |
| [prompt-builder.ts](../apps/server/src/agent/context/prompt-builder.ts) | 按预设节点展开；worldState 注入状态工具说明 | 固定平台位置，改为尾块协议；不继续注入旧工具说明 |
| [system-main.ts](../apps/server/src/agent/context/system-main.ts) | 平台主指令仍提到状态工具 | 替换冲突指令，承载稳定的平台输出契约 |
| [state-tool.ts](../apps/server/src/agent/tools/state-tool.ts) / [atomic-state.ts](../apps/server/src/domain/state/atomic-state.ts) | 已有路径权限、类型、范围、深度及危险键校验 | 复用/提取领域校验，不用伪造 tool call 执行状态更新 |
| [run-store.ts](../apps/server/src/agent/persistence/run-store.ts) | 保存流式正文和最终消息；finalize 对 stopped 也写 workspace | 增加专用叙事最终提交门槛，禁止未提交候选状态随 stopped 落库 |
| [run-post-processor.ts](../apps/server/src/agent/runtime/run-post-processor.ts) | 当前主要结算 Usage | 不把它误当作已有扩展引擎；明确新扩展处理发生在 Run 终态之前 |
| [database.ts](../apps/server/src/infrastructure/database/database.ts) | 最高 user_version 为 1；历史 v1 迁移会重建预设 | 使用独立增量版本，绝不复用旧重建逻辑 |
| [presets.ts](../apps/server/src/routes/presets.ts) | strict schema 无 capabilities，导出逐字段选择 | schema、读写、PATCH 合并、导入和导出同时扩展 |
| [sessions.ts](../apps/server/src/routes/sessions.ts) | 普通 PATCH 运行中全部拒绝，且只允许现有字段 | 增加独立能力配置接口，保留模型/预设等配置的 busy 限制 |
| [run-contract.ts](../packages/sr-sdk/src/run-contract.ts) | Run 只有 id/status/messages；subscribe 接收事件 | 增加扩展结果和阶段事件；保持事件订阅语义 |
| [history-runs.ts](../apps/server/src/domain/session/history-runs.ts) | 历史 Run 只投影基础字段 | 首次加载、分页历史、单 Run 查询和终态事件返回同一权威结果 |
| [host.tsx](../apps/web/src/host.tsx) / [frame.tsx](../apps/web/src/frame.tsx) | 固定事件转发；已有 set-draft 通道 | 补充新事件白名单，复用 Host 草稿，不绕过 iframe 边界 |

实现前再检查分支及相关源码变化；本表不免除对新提交的核对。

## 3. 输出协议：标签分帧，标签内使用 JSON

### 3.1 标准输出示例

~~~text
守卫看过你的通行凭证，侧身让出门口。你接过钥匙，准备进入宅邸。

<sr_extensions>
<state_update>
[
  {"path":"inventory.keys","reason":"守卫将一把钥匙交给了你。","value":1},
  {"path":"inventory.name","reason":"本轮获得的物品被称为宅邸钥匙。","value":"宅邸钥匙"}
]
</state_update>
<action_suggestions>
["向守卫询问宅邸内部的路线。","推门进入宅邸，观察大厅里的情况。","检查刚拿到的钥匙。"]
</action_suggestions>
</sr_extensions>
~~~

示例的路径和值只演示格式；必须以实际激活状态定义、当前值及本轮已经发生的事件为准。

这是应用自定义帧协议，不把整个输出交给 XML 解析器。标签负责识别区段，内部负载严格按 JSON 解析。无需为每条建议重复生成 id、type、label、description；runId + 展示索引足够定位当轮按钮。

### 3.2 语法约束

1. 标签大小写和拼写固定，不带属性；不使用 Markdown 代码围栏包裹实际协议。
2. 每个响应最多一个外层 `<sr_extensions>...</sr_extensions>`，位于正文之后；外层结束后只允许空白。
3. 子块顺序固定为 state_update、action_suggestions；未要求的子块不输出。标签之间仅允许空白。
4. 需要状态更新时，state_update 必须出现一次，无更新也必须输出 `[]`；“缺少块”和“无变化”不是同一结果。
5. 建议启用时，action_suggestions 必须出现一次；确实没有合适建议可以输出 `[]`。
6. 两项均不需要时，正常输出只有正文。即使模型擅自输出已关闭能力，服务端也不执行。
7. 允许 JSON 内正常换行和缩进；禁止注释、尾逗号、NaN、Infinity、非 JSON 值及对象重复键。
8. 正文中要展示协议保留标签时，使用 HTML 实体等不会产生原始标签的文本。识别不受 Markdown 代码区影响，不为代码区放行真实保留标签。
9. JSON 字符串内的 `<` 要求输出为 `\u003c`；服务端仍必须用理解 JSON 字符串/转义的分帧器，不能仅靠这条 prompt 保证安全。
10. reason 的属性顺序不构成语义。示例把 reason 放在 value 前，只作为生成时的简短依据提示。

计划版本为 v2；第一版嵌套协议的服务端标识为 `sr_extensions/v1`。该标识存于配置/结果元数据，不要求模型额外生成版本字段或标签属性。

### 3.3 大小限制

| 内容 | 硬限制 | 行为 |
|---|---|---|
| 整个隐藏尾块 | 262,144 UTF-8 字节，包含外层/子标签及空白 | 超限后不再累积原文，记录协议失败；继续以有界方式排空或取消，均不能提交扩展 |
| 状态更新数组 | 最多 100 项 | 超限拒绝该状态块，不截成前 100 项执行 |
| JSON / 状态嵌套 | 复用领域深度上限 32 | 超限拒绝相应负载/更新，不放宽已有约束 |
| 单项 reason | 存储最多 120 个 Unicode 码点 | 生成目标 12–60；超出截断并记警告，不影响合法更新 |
| 行动建议 | 原始数组最多 4 项，每项 trim 后 1–120 个 Unicode 码点 | 越界则该建议块失败，不截断句子后当作有效建议 |
| 能力业务 prompt | 每项最多 2,000 个 Unicode 码点 | API 保存时校验；不允许借此修改平台协议 |
| 状态值 | 继续遵守现有领域上限，包括单值大小约束 | 尾块总上限通常更早限制生成结果 |

不能用字符数代替 UTF-8 字节限制，也不能把以上限制称为精确 token 限制。100 项和 256 KiB 是保护上限，不是模型必须尽量填满的目标。

## 4. 状态更新契约

### 4.1 数据格式与权限

~~~ts
type StateUpdateInput = {
  path: string;
  value: JsonValue;
  reason?: string;
};
~~~

- 仅允许当前 Run 快照中已激活的 message 状态根；global/session 状态只读。
- 使用现有点路径语义；value 是目标位置的完整替换值，不是增量、表达式或补丁操作。
- 数值必须有限，并满足状态定义的 min/max；字符串、布尔值和 JSON 类型继续使用现有校验。
- 不开放 `__proto__`、`constructor`、`prototype` 等危险键，不支持借路径越权或执行代码。
- JSON 状态允许沿已有父对象写入终端键；数组整体替换，不把数组索引遍历当作新的能力。
- JSON 根内子字段目前没有独立强类型 schema。不能因为旧值是数字，就声称现有引擎会自动禁止把它改为字符串；若产品需要该约束，应另立状态 schema 需求。
- 每项只允许 path/value/reason。缺 path/value、非法路径、越权、类型/范围错误、未知业务字段等按项跳过。
- 缺失 value 和 `value: null` 必须区分；null 是否有效由相应状态定义判断。

### 4.2 保持有序、逐项接受的业务语义

只有完整数组通过 JSON/数量/分帧校验后，才进入处理：

1. 复制本轮权威状态到隔离 workspace。
2. 按原数组顺序校验并应用每项。
3. 合法项进入 accepted 报告；非法项进入 skipped 报告，包含原 index、稳定错误码和安全说明。
4. 重复路径按顺序执行；父路径与子路径的先后顺序不改写、不去重、不排序。
5. 在最终提交门槛满足时，一次事务保存该有效子集的结果和执行报告。

“业务上跳过坏项”和“数据库原子提交”可以同时成立。原子事务保证状态与报告一致，不表示遇到一个坏项就撤销所有合法项。

结果语义：

| stateUpdate.status | 条件 |
|---|---|
| disabled | 本轮开关关闭 |
| not_required | 开关开启，但没有激活的可写 message 状态 |
| pending | 已要求输出，但尚未完成终态处理 |
| unchanged | 合法数组且无 skipped，提交后的值未变化，包括 `[]` |
| applied | 合法数组且无 skipped，至少一个状态值实际改变 |
| partial | 合法数组中存在 skipped，包括全部项都被跳过 |
| failed | 缺块、重复块、负载无法接受或提交资格失败等 |
| cancelled | 提交前显式停止/请求被取消，候选结果未应用 |

accepted 表示该项合法且被顺序处理，不必然表示值发生变化；changed 表示最终实际变化的路径。reason 警告不得把 applied/unchanged 改为 partial。

### 4.3 短更新依据

平台 prompt 要求每个实际更新带一句“本轮哪件已经发生的事导致这个值”。禁止为了凑依据推演未来、引用尚未选择的建议，或输出逐步内部推理。

运行时策略固定：

- reason 缺失、空白或非字符串：接受合法 path/value，忽略 reason 并记非阻断诊断。
- reason 超长：按 120 个 Unicode 码点截断，仅存诊断，记录 reason_truncated。
- reason 不作为状态校验的授权来源，不交给另一轮模型评审，也不触发模型重试。
- 不把 reason 写入世界状态、可见正文、摘要或下一轮历史。
- `[]` 不要求统一 reason；不为“无变化说明”把数组改成包装对象。

本设计把 reason 视为可审计的简短事件依据。是否提升准确率需要固定案例评测，不能承诺“强制输出思考一定更稳定”。原生 reasoning/thinking 模式由模型适配器控制；普通 content 内的 reason 不能保证启用原生思考，也不承诺获得模型的隐藏推理。

## 5. 行动建议契约

~~~ts
type ActionSuggestionsInput = string[];
~~~

- 只描述玩家下一步可以尝试的输入，依照正文结束时的局面。
- 提供差异明确的选择，避免三句同义改写；不预先决定 NPC 回应、成功结果或隐含状态变更。
- 不泄漏正文尚未揭示的信息，不把建议写成已经发生的叙事。
- count 是生成目标，允许配置 2–4，默认 3。
- 运行时接受 0–4 条满足长度要求的字符串；数量不同于目标只记警告，仍展示实际可用数量。
- 每项 trim 后比较完全相同的文本，保留第一条并报告去重；不做语义相似度模型调用。
- 非字符串、空白字符串或长度越界使该建议块失败，不做 JSON 修复或类型强转。
- `[]` 为合法的 ready 空结果；UI 不展示伪造占位建议，不把空结果当作未返回。

建议发布条件：

| 状态更新结果 | 合法建议是否发布 |
|---|---|
| disabled / not_required | 可以 |
| applied / unchanged | 可以，状态提交后发布 |
| partial | 不发布，status=blocked，原因 state_partial |
| failed / cancelled | 不发布，status=blocked/cancelled |
| 尚未结束或提交 | 不提前发布 |

如果状态合法而建议有误，照常提交状态，Run 可 completed，并在建议结果中记录 failed。两个子块不需要同时成功才能保留已验证的状态结果。

## 6. 配置：默认、预设、会话覆盖与本轮快照

### 6.1 预设 schema

~~~json
{
  "capabilities": {
    "state_update": {
      "enabled": true,
      "prompt": ""
    },
    "action_suggestions": {
      "enabled": false,
      "count": 3,
      "prompt": ""
    }
  }
}
~~~

- 平台默认如上；业务 prompt 空字符串表示没有额外要求。
- 旧配置缺整个 capabilities、缺某能力或缺某字段时，按字段补平台默认；显式 false 不能被缺省逻辑覆盖。
- 新写入只接受这两个已知 ID 和规定字段；未知 ID/字段返回 INVALID_CAPABILITY_CONFIG。
- 预设 PATCH 按能力及字段合并，修改 enabled 不重置 count/prompt；缺字段表示不改，null 在预设能力配置中非法。
- create/import/read/patch/export 都返回规范化配置；导出必须显式加入 capabilities。
- 不把用户自定义业务 prompt 用默认模板覆盖。新的模型协议不放进可编辑的 preset prompt。

### 6.2 会话覆盖

新增会话持久字段，最终列名在 T1 固定为：

~~~text
capability_overrides_json TEXT NOT NULL DEFAULT '{}'
capability_revision INTEGER NOT NULL DEFAULT 0
~~~

覆盖只控制开关，不开放会话级协议、reason 模式或任意能力参数：

~~~json
{
  "state_update": false,
  "action_suggestions": true
}
~~~

解析规则：session 中存在该键时采用其 boolean，否则继承预设，预设缺项再继承平台。创建会话默认为空覆盖；切换预设后显式会话覆盖仍保留。全局/世界默认仍只是选取预设 ID，不新增一套第三方能力默认系统。

### 6.3 会话 API

增加同一鉴权边界内的：

~~~text
GET   /api/v1/sessions/:id/capabilities
PATCH /api/v1/sessions/:id/capabilities
~~~

PATCH 示例：

~~~json
{
  "expectedRevision": 2,
  "overrides": {
    "state_update": null,
    "action_suggestions": true
  }
}
~~~

- overrides 中 true/false 设置显式覆盖，null 删除该键并恢复继承，未出现的键保持原值。
- expectedRevision 必填。事务比较当前 capability_revision；冲突返回 409 CAPABILITY_REVISION_CONFLICT；成功增一。
- capability-only PATCH 可以在 Run 运行中执行；既有模型、预设、玩家角色变更仍遵守原 busy 限制。
- GET/PATCH 返回 revision、overrides、下一轮 effective 配置摘要、各 enabled 的来源（platform/preset/session）、可用性原因，以及当前运行中的 public snapshot（若有）。
- 对外摘要不返回内部完整 prompt、原始尾块、reason 诊断或凭据。
- 新 API 由 Host 使用。创作者 SDK 本期只读取 Run 公开结果，不额外开放修改系统能力的直接 HTTP 权限。

### 6.4 冻结规则与暂停语义

- 在 Run 入场锁内解析预设配置及会话覆盖，冻结开关、参数、业务 prompt 和版本标识；异步准备/压缩期间发生的配置变更也不能改变该轮配置。
- preparing 期间快照先由内存 RunTask 持有，现有 startRun 建立 user entry 后再保存同一快照。准备期失败/停止且尚无 entry 时，沿用现有生命周期，公开终态允许 extensions 缺省，不伪造已执行结果，也不承诺重启后可从历史查到该 Run。
- 状态激活、权威值和 expected tip 在实际生成前完成快照，使用同一份冻结配置；写入 PreparedRun 和对应持久 Run 元数据。
- 快照保存 presetId、相关配置 hash、session capabilityRevision、有效开关/参数、激活的可写根及基准标识；不保存模型凭据。
- 重复 requestId 保留现有重复/占用拒绝语义（409 REQUEST_ALREADY_EXISTS，或入口已有的 SESSION_BUSY），不借重试重算能力快照或二次执行；客户端通过已有 Run/历史查询恢复。此计划不把幂等拒绝改成成功重放接口。
- UI 分别展示“当前轮使用的配置”和“下一轮设置”。运行中开关旁显示“下一轮生效”。

关闭状态更新时，权威 message 状态保持不变。之后重新开启仅恢复当前/后续轮的更新，不承诺补齐关闭期间的故事；下一轮动态提示明确以当前权威快照为准，不从旧建议或旧失败尾块推导补偿。保留每轮 disabled/failed/partial 报告，用户可看到暂停或未同步提示，不能在一次成功后宣称历史缺口已经修复。

## 7. Prompt 约束放置与消息编排

### 7.1 三层职责

| 层 | 放什么 | 不由它决定什么 |
|---|---|---|
| 平台 SR_SYSTEM_MAIN | 正文/尾块边界、标签及 JSON 语法、权限、禁止工具续轮、事实依据要求、只执行启用能力 | 不放每轮完整状态和重复动态值 |
| 平台动态块 | 本轮有效能力、目标数量、合法路径/状态定义、权威当前值、对应业务 prompt、本轮输出要求 | 不由预设移动到历史任意位置 |
| 预设配置 | 默认开关、建议 count、业务偏好、叙事风格 | 不修改平台标签、JSON schema、状态权限或失败策略 |

必须替换 system-main 及 prompt-builder 中现有“通过工具更新”“必须调用 update_state”“不得输出状态 JSON”等冲突的内建说明。不能只在旧规则后再追加一份新协议。通用 state-toolInstructions 仍可供工具路径使用，但叙事不导入它。

### 7.2 固定逻辑消息顺序

| 顺序 | 角色 | 内容 |
|---|---|---|
| 1 | system | SR_SYSTEM_MAIN，平台固定 |
| 2 | system | 叙事风格 |
| 3 | 原 role | 前置自定义文本，包括兼容的启用 postHistory 内容，保持内部相对顺序 |
| 4 | system | 玩家设定 |
| 5 | system | 激活角色设定 |
| 6 | system | 激活世界书 world_info，按 load.order / 原索引排列 |
| 7 | assistant | 摘要，存在时加入 |
| 8 | 原 user/assistant | 保留的净叙事历史 |
| 9 | system | 当前权威状态、本轮 capabilities 与 output_rules |
| 10 | user | 本轮玩家输入，仅一次且最后 |

本次采用非破坏性兼容映射：

- 平台内置消息顺序不可由预设节点顺序改变；自定义文本仍保留 role、正文和相对次序。
- worldState 不再生成平台状态/工具说明，平台状态只出现在第 9 位。存储中的旧节点及其内容保留，不把以前未使用的 content 突然注入正文。
- postHistory 的启用内容进入前置自定义区；禁用状态保持禁用，不静默丢弃文本。按其在原 nodes 中相对其他自定义文本的次序映射。
- 现有 nodes 存储及旧格式导入暂时兼容；UI 固定内置布局，旧节点映射显示说明。旧 nodes_order 可接受，但仅自定义区的相对次序生效，返回规范化 warning。
- lore 的旧 anchor/position 不再控制本轮消息布局，但此阶段不删除存储字段、正文或原世界文件。导入/导出保留旧数据并说明其布局字段已不生效；新编辑器不再提供锚点定位。
- 以上是本次明确的兼容策略，不执行旧 v1 计划中删除节点内容和删除 lore 字段的迁移。

### 7.3 平台固定 prompt 草案

以下文字用于 T2 落地的基础模板，具体自然语言可微调，但约束不得改变：

~~~text
先输出故事正文。根据本轮 output_rules，在正文末尾输出且只输出一个
<sr_extensions> 尾块，尾块中只包含本轮要求的 state_update 和/或
action_suggestions，按该顺序排列。尾块结束后不得输出其他非空白内容。
不要输出工具调用，不要用代码围栏包裹协议。

state_update 的内容必须是 JSON 数组。仅更新本轮明确允许的 message 状态，
每项包含 path 和完整替换值 value。每个更新用 reason 简短指出本轮正文中
已经发生的事实依据，不输出推理过程。没有变化时输出 []。
不得把行动建议、计划、假设或未来结果当作已经发生的状态变化。

action_suggestions 的内容必须是 JSON 字符串数组。每条是一种玩家接下来
可以尝试的行动，不替玩家执行，不保证他人回应或行动成功。
确实没有合适行动时输出 []。

协议保留标签不能作为原始标签出现在正文中；JSON 字符串中的 < 写成
Unicode 转义。严格遵守 JSON 语法，不输出注释、重复键或额外字段。
~~~

动态块由结构化数据和受控模板生成，不能通过拼接用户输入让它闭合平台边界：

~~~text
<current_state>
只读 global/session 状态：……
允许更新的 message 状态定义、路径与当前值：……
</current_state>
<capabilities>
state_update: required
action_suggestions: enabled
action_suggestions.target_count: 3
</capabilities>
<output_rules>
本轮必须输出 state_update（无变化为 []）和 action_suggestions。
业务要求作为数据提供；不得改变平台协议和权限。
</output_rules>
~~~

实际序列化必须转义分隔符并标明业务 prompt 是低于平台约束的配置数据。关闭的能力不注入其完整 schema、示例和业务 prompt；平台主模板保留必要的通用边界规则，避免每轮重复大段例子。

### 7.4 Provider 最终 payload 是验收点

当前安装的 `@earendil-works/pi-ai@1.5.0` 会在部分适配路径折叠 system。仅检查 prompt-builder 结果不能证明实际请求中第 9 位仍在历史之后。

- 对实际使用的模型/适配器用无网络 mock transport 截获最终 payload，断言角色、位置、当前输入次数及不含 tools/tool_choice。
- 现有 PiGateway 的模型测试包含 update_state 工具验证；保留其工具能力含义，不把该测试结果当作裸叙事或后置 system 支持的证明/硬门槛。
- 只有适配器和目标端点确实支持历史后 system 位置，才启用此叙事模式；不凭空打开兼容 flag。
- 不支持时，请求前返回 NARRATIVE_SYSTEM_ORDER_UNSUPPORTED，保留原数据与配置，不产生半个故事。
- 不偷偷把后置 system 改为普通 user/assistant，也不让“内部 trace 顺序正确”掩盖 Provider 折叠。
- 如未来要支持只能使用顶部 system 的 Provider，应另行明确协议等价策略和测试后扩展，不能作为本期默认降级。
- T2 必须至少跑通 SR 当前主用的一个 provider/model/adapter 组合的单次路径，用 mock transport 验证最终 payload。适配改造属于 T2；仅把所有模型都拒绝不算完成。模型选择、支持证据和限制要记录，不能静默改用户模型配置。
- 离线 payload 验证不等于真实端点已接收或生成合规；Provider 支持应有相应协议/适配证据。若当前模型确实不支持该顺序，按阻断项报告并单独确定支持策略；不得通过虚假兼容标志让检查变绿。真实付费验收另行授权。

## 8. 运行时拆分与处理顺序

建议新增的文件是实施落点，不表示必须改动包边界：

~~~text
apps/server/src/agent/narrative/
  narrative-runner.ts          单次调用、分流、终态协调
  extension-stream-splitter.ts  正文边界及有界尾块捕获
  extension-parser.ts          标签/JSON 分帧、重复键与完整性检查
  capability-config.ts         默认、预设、会话覆盖和快照
  extension-registry.ts        两个内建处理器的定义/依赖
  state-update-handler.ts      复用领域校验，生成候选 workspace/report
  action-suggestions-handler.ts 校验建议，决定可发布结果
  extension-contract.ts        内部候选、结果和错误类型
~~~

注册表仅包含 ID、是否需要输出、prompt 片段构造、负载校验、处理和结果投影；不引入动态加载代码或通用 DAG 框架。依赖直接声明为“建议发布依赖本轮状态结果”。

协调流程：

1. AgentRuntime 保持已有锁、幂等、tip 和取消职责，冻结配置。
2. ContextManager 准备权威状态和上下文；压缩机制保持独立。
3. RunStore 建立本轮记录；叙事 Runner 调用 ModelClient.events 一次，不传工具。
4. 正文经过 splitter，只持久化和发送确认属于故事的增量。
5. 识别尾块后只接收隐藏内容，不向前端继续发送原始 token；可发 run.phase=extensions。
6. 等待正常结束及流完整消费，解析完整外层和子块，校验能力开关。
7. 在隔离 workspace 中处理状态候选，再判断建议是否可发布。
8. 最终门槛通过时走成功事务，保存可提交状态、公开结果、私有诊断和终态；不通过时走无状态最终化分支，保存错误/停止结果，不写候选状态。
9. 保持请求 Usage 幂等结算，发布真实状态变化、Usage 和 Run 终态事件，释放运行占用。尚未 startRun 的准备期失败沿用既有内存终态/错误路径，不伪造持久 Run。

扩展处理仍属于同一 Run；不能在正文结束时先宣布 completed、释放锁，再后台悄悄更新状态。暂不需要两个独立生命周期或持久化任务队列。

## 9. 流式分割和严格解析

### 9.1 正文阶段

- splitter 在任意 chunk 边界识别精确的 `<sr_extensions>`。
- 每次保留“当前末尾与开始标签前缀相同的最长后缀”，其余文本才是可确认正文。不得直接把每个 text_delta 原样发出。
- 处理 Unicode chunk 时，先使用 transport 的完整文本解码，不把 UTF-8 字节切分错误当作字符。
- 仅普通 content/text_delta 进入正文 splitter；原生 thinking/reasoning 事件不当作正文或 reason 自动拼接，仍按适配器规则记录 Usage。
- 已确认正文先落库，再发 run.delta；正文长度/顺序以持久化数据为准。
- 匹配完整开始标签后永久转入隐藏阶段，后续文本即使协议错误也不能重新进入正文。
- 正常结束时仍残留保留标签前缀，按协议不完整处理，不把该前缀补发到正文；主动停止或 Provider 错误时保留原终止原因。
- final.content 不能绕过 splitter 覆盖已经生成的净正文。若适配器只给最终文本，也必须走同一分割路径；避免同时消费 delta 和 final 造成重复正文。

这只能可靠隔离符合保留边界的输出。模型若完全省略/拼错开始标签并直接写 JSON，该文本可能在被识别前已成为普通正文；prompt 无法提供绝对格式保证。本期不增加第二轮模型修复，也不声称任意损坏输出均不会泄露。验收应分别统计正确协议隔离和模型遵循率。

### 9.2 隐藏阶段与分帧

- 捕获有界尾块，持续消费剩余模型输出；看到第一个外层结束标签不能提前提交。
- 用显式状态机扫描标签、JSON 字符串、反斜线转义及容器边界。字符串内部看起来像闭合标签的文本不得结束区段。
- JSON 解析同时检测同一对象内重复键；不能依赖 JSON.parse 静默接受最后一个值。
- JSON 值边界清楚、标签闭合且子块可唯一定位时，负载语法/schema 错误可以只记在该能力上。
- 未闭合字符串、无法确定的括号/标签边界、未知子标签、非法标签顺序、外层重复、外层未闭合、外层结束后的非空白或总大小超限，视为外层协议失败，不执行任何能力。
- 相同子标签重复且每个边界都可信时，该能力失败，不选择第一份/最后一份；其余能力按依赖规则判断。若重复导致边界不可信，升级为外层失败。
- 顺序按能力序号非递减检查：state_update、state_update、action_suggestions 只使状态重复失败；state_update、action_suggestions、state_update 属于倒序，按外层失败。建议块连续重复同理只使建议失败。
- 已关闭或 not_required 的已知子块在边界可信时忽略并记录 unexpected_disabled_block；不得因模型输出而启用它。
- 若任何超限触发流取消，该轮不得按正常 stop 提交；未知 Usage 如实标识，不伪装成 0。

### 9.3 哪些 Provider 结束能提交

| 结束情况 | 能否提交候选扩展 |
|---|---|
| 映射为 stop，流完整结束，且 final 无工具调用、无额外非法数据 | 继续检查其余提交门槛 |
| length / token limit | 否，即使前面看似已有完整尾块 |
| toolUse / tool calls | 否；不执行，不发工具结果，不续轮 |
| deferred / 未知原因 | 否，按非正常结束处理 |
| 错误、异常断流或缺失结束元信息 | 否 |
| 显式 stop/abort 在事务前生效 | 否 |
| 仅 SSE 订阅断开 | 不等于取消；服务端继续已接收的 Run |

适配器只能在充分证据下归一化为正常 stop，不能把“不认识的原因”默认视为 stop。

## 10. 最终提交、失败矩阵与恢复

### 10.1 提交门槛

必须同时满足：

- 有有效的非空净正文，Provider 正常完整结束。
- 外层协议不存在全局失败；所有需要提交的子块有可信边界。
- 当前 Run/generation 仍拥有本轮会话/世界占用，未被显式停止，未已终态提交。
- 当前 tip 是本轮最新持久 entry，所属 runId 和 parent 链仍归本轮，状态基准没有被其他写入替换。startRun 后追加 assistant partial/诊断 entry 会推进 tip，因此不能要求 tip 仍等于最初 user entry；维护本轮最后持久 entry 标识并在事务内比较。
- 能力结果符合快照中的开关和可用性，而不是此刻再次读取的新配置。
- 所有状态候选仅存在隔离 workspace；尚未写入可见权威状态。

实现以现有锁、Run 标识及 tip 检查为主，必要时记录状态基准 hash；不能凭空假定当前已有 revision 列。事务内重查本轮记录是否未完成，使用唯一的 runId 最终化标记防止重复 commit。

从最后一次取消/所有权检查到同步 SQLite 事务提交之间不得 await。事务同时保存候选状态、扩展结果和 Run 终态；事务失败回滚全部候选结果。之后才发权威状态事件。已经提交成功后到达的 stop 不回滚状态、不把已完成 Run 改成 stopped。

必须给叙事路径独立的“是否允许提交状态”参数/方法，不能沿用现有 finalize 对 stopped 无条件保存 workspace 的行为。通用工具路径保持自己既有语义。

上述门槛只决定能否提交候选状态/建议，不决定 Run 是否需要最终化。对于已经建立持久 entry 的 Run，失败/停止必须走独立的无状态最终化分支：丢弃候选 workspace，保存已确认正文、failed/cancelled/blocked 能力结果、安全诊断及 failed/stopped 终态；不写候选状态、不发布 state.changed、不把候选建议标为 ready。该分支也验证 Run 所有权及最终化标记，不能覆盖已完成的结果。能力已 disabled/not_required 时保留该状态，不伪造执行失败。

事务回滚后，数据库仍可写时执行无状态最终化；数据库持续不可写时，不能声称 failed 已持久化。报告事务错误，保留未终态记录供既有 interrupted 恢复流程处理，候选状态始终不生效。尚未建立 entry 的准备期异常按第 6.4 节例外处理。

### 10.2 失败矩阵

| 条件 | 正文 | 状态 | 建议 | Run 终态 |
|---|---|---|---|---|
| 两能力均不需要，正常正文 | 保留 | disabled/not_required | disabled | completed |
| 状态合法、建议合法 | 保留 | applied/unchanged | ready | completed |
| 状态合法、建议缺失或边界可信的坏负载 | 保留 | 提交合法状态 | failed | completed |
| 状态数组合法但有坏项 | 保留 | 提交有效子集，partial | blocked（若启用） | completed，显著提示部分状态未同步 |
| 活跃状态缺块/重复/坏根或坏 JSON | 保留 | failed，不提交 | blocked（若启用） | failed |
| 仅建议开启但缺少建议/尾块 | 保留 | disabled/not_required | failed | completed |
| 外层不完整、重复、顺序错误、越界或边界歧义 | 保留已确认部分 | 不提交 | 不发布 | failed |
| Provider 非正常结束 | 保留已确认部分 | 不提交 | 不发布 | failed |
| 事务前显式停止 | 保留已确认部分 | cancelled 或保持不需要 | cancelled 或 disabled | stopped |
| 净正文为空（仅尾块或空白） | 不用原始尾块补正文 | 不提交 | 不发布 | failed，NARRATIVE_EMPTY |
| 事务失败或所有权/tip 基准冲突 | 保留已确认部分 | 不提交 | 不发布 | failed；DB 不可写时以恢复流程收敛，见 10.1 |
| 提交后仅 SSE 发送失败 | 权威查询可读 | 已提交 | 已持久化 | 保持原终态 |

没有外层且需要状态时，错误归入缺少状态；只有建议需要时归入建议缺失。已经出现外层却损坏时，按全局协议失败处理，不把损坏外层降格成可接受缺省。

优先保留显式停止、Provider 错误或事务错误作为主错误，附加协议诊断不得覆盖原始失败原因。协议/状态错误使用稳定错误码，例如 EXTENSION_PROTOCOL_INVALID、EXTENSION_TAIL_TOO_LARGE、STATE_UPDATE_MISSING、STATE_UPDATE_INVALID、ACTION_SUGGESTIONS_INVALID；补充到项目统一 ErrorCodes，消息中不包含完整私有状态或原始 prompt。

### 10.3 重启与重试

- 对在途或已建立持久 Run，保持现有 requestId 去重；同一 runId 最终化不重复提交状态、建议和 Usage。准备期失败且未建立 entry 的再次请求沿用现有行为，不承诺这一窗口的跨重启成功重放或模型 exactly-once。
- 进程在最终事务前退出：保持已保存净正文，按现有 interrupted 恢复逻辑结束，不从未提交内存 workspace 恢复状态。
- 进程在事务后、事件发送前退出：查询返回已持久化终态和能力结果，不再补执行。
- 请求 Usage journal 的未结算标识不能因 Run 终态清理而丢失；重启扫描结算，未知/未收到的 Usage 标为 unknown。
- 不自动重发模型请求或在重连时重放猜测的 token；客户端通过历史/Run 查询恢复权威数据。

## 11. 持久化与公开契约

### 11.1 存储分层

继续使用 sessions/entries 和现有 user entry 的 Run 标识：

- 可见 assistant：只存净正文，含失败/停止时已确认的部分。
- `ext_data.run`：Run 公开生命周期字段及扩展结果；读取时仍必须使用白名单投影。
- `ext_data.narrative`：私有协议版本、冻结配置、基准标识、reason/解析诊断及最终化标记。
- 原始响应/尾块默认不持久化；若开发诊断显式保留，必须 nonNarrative、有界、访问受控且不进入普通日志。

现有 RunStore.status 不能继续无条件 spread 新内部字段；public projection 同时用于状态查询、历史和终态事件。服务端内部 debug trace 不能变成 SDK 可读数据。

旧 entry 没有 extensions 字段时，对外保持缺省（历史未记录），不补成 disabled/applied，也不从旧正文猜测。未来历史、摘要输入、角色关键词扫描全部使用净叙事投影，过滤 raw、工具消息、理由及建议。

已持久化且非空的净正文继续作为已接受的故事历史：即使 Run 因扩展错误为 failed，或因停止为 stopped，仍进入显示、后续模型历史、摘要及人物候选。Run 错误不撤销已接受的正文；未完成句子保持原样，不自动补全。无净正文的 Run 不制造 assistant 占位文本。状态同步缺口通过结果/UI和平台动态块提示，current_state 始终为权威；正文进入历史不意味着旧失败尾块获得补执行资格。摘要指令必须区分已写出的内容和未完成/未同步信息，不补造成功事件。

查询、历史与终态结果一致的保证适用于已建立持久 entry 且数据库可写的 Run。准备期失败或数据库故障的例外遵守 6.4/10.1，不能用不存在的 entry 拼一个看似可恢复的结果。

### 11.2 SDK 结果形态

以下是 T1 需要固定并落地的公开类型轮廓；字段都由 Server 生成，不由模型输出：

~~~ts
type StateUpdateResult = {
  status: "disabled" | "not_required" | "pending" | "unchanged"
    | "applied" | "partial" | "failed" | "cancelled";
  acceptedCount: number;
  changedPaths: string[];
  skipped: { index: number; errorCode: string; errorMessage: string }[];
  warningCodes: string[];
  errorCode?: string;
};

type ActionSuggestionsResult = {
  status: "disabled" | "pending" | "ready" | "blocked" | "failed" | "cancelled";
  items: string[];
  warningCodes: string[];
  errorCode?: string;
  blockedBy?: "state_partial" | "state_failed";
};

type RunExtensions = {
  protocol: "sr_extensions/v1";
  stateUpdate: StateUpdateResult;
  actionSuggestions: ActionSuggestionsResult;
};
~~~

在 Run 增加可选的 extensions、phase 和 capabilities 公共摘要；老 Run 缺省兼容。phase 取 preparing/narrative/extensions/finalized；Run 原有 preparing/running/completed/failed/stopped 状态枚举不变，不新造 Run.partial。

- run.created 可以带本轮公开能力摘要。
- 增加 run.phase 事件（runId、phase），仅改变阶段，不代表终态。它由 Host/iframe 转入新 SessionRuntime，但公共订阅必须显式选择接收阶段事件。
- 已持久化 Run 的 run.completed / run.failed / run.stopped 都带与查询相同的 extensions 和净 messages。准备期未建立 entry 的失败/停止允许 extensions 缺省，保持真实生命周期边界。
- 建议仅在终态结果发布；不增加独立 capability.* 公共事件通道。
- 保持现有 subscribe(listener) 只发送原五种 RunEvent（created/delta/completed/failed/stopped）；新增重载 subscribe(listener, {includePhase:true}) 接收 RunEvent | RunPhaseEvent，并保持 unsubscribe。官方 WorldStory 使用显式选项，不改成快照订阅，也不新建 EventHub。
- 新 SessionRuntime 按每个订阅的选项过滤 run.phase，避免既有创作者回调把它当终态。更新 story-history reducer 的显式分支和 mergeInitial 缓存类型，不能把未知 run.phase 落进 failed/stopped 分类。
- Host 的 SSE 事件名订阅、iframe 白名单、SessionRuntime 类型/处理、历史合并一起更新。
- state.changed 只在真实状态变化且事务成功后发出。服务端顺序为状态/Usage 通知后再发 Run 终态；客户端不依赖网络必然有序或 SSE 自动回放。
- 新增 DTO 字段可以被旧消费者忽略；新增事件变体本身并不天然兼容。平台 Host/frame/SDK 必须同步升级并执行上述默认过滤，已存在的创作者单参数订阅保持原事件集合；直接消费原始 SSE 的客户端需显式订阅新事件后才能使用该阶段。

### 11.3 建议按钮与草稿

- 复用 SRSessionAPI.setDraft → iframe set-draft → Host updateDraft。
- 点击建议替换当前草稿；输入区明确提示“填入草稿”，已有草稿时提供可撤销替换，不自动发送。
- 按钮与来源 runId 绑定；只有当前最新完成局面的建议可点击。新 Run 开始或旧 Run 不再对应当前 tip 时，旧建议保留作历史显示但禁用。
- 生成/扩展处理中不发布可点击候选建议；失败/blocked 不展示旧缓存冒充本轮结果。
- 保留 Host draftRevision 规则：不能让异步结果覆盖用户随后编辑的内容。
- 通过现有 composer undo/本次替换前快照提供一次撤销，撤销只在草稿未进一步编辑时生效。
- SSR/历史加载、SSE 终态竞态、刷新、iframe 重载均从持久结果恢复，不重复填草稿。

## 12. 在场人物：本地候选识别

本期不增加 on_scene 等模型标签。实现一个独立纯函数，输出“近期提及人物候选”，UI 使用“可能在场”而不是确定在场断言：

1. 按第 11.1 节投影输入最近 3 个有净正文的叙事 Run（包含已接受的 failed/stopped 片段）及其对应的已提交玩家输入；按时间连接后只取末尾最多 8,000 Unicode 码点，保留来源映射，不使用未来草稿。
2. 默认匹配角色 name，以及现有 load.keywords 中的非空字符串；排除玩家自身。暂不新增角色 aliases schema。
3. 执行 Unicode NFC 标准化；英文部分大小写折叠，并使用词边界避免英文名字子串误匹配；中文按关键词子串匹配。
4. name 和 load.keywords 可能包含并非姓名的触发词，所以结果记录 matchedKeyword/sourceRunId，仅作为候选提示。
5. 按最近匹配位置倒序排序，同角色去重；没有命中返回空，不把所有已加载角色当作在场。
6. 普通历史内的回忆、否定句、远程通信仍可能产生误报，UI 不用该结果决定状态权限或强制角色出场。

继续保留既有角色 prompt 加载/activation 机制；新函数只负责显示候选，不改写 load.mode、when 或当前上下文激活规则。

本期明确数据通道：Host 从已读取的世界数据中只投影 `{id,name,keywords}` 人物词典及 playerId，通过已有 render 消息传入 iframe；在 `story-types.ts` / `story-context.tsx` 的 StoryConfiguration 增加可选 characterMentions 配置，旧配置缺省为空。不得传完整角色 prompt、凭据或内部世界数据。iframe 校验字段和长度后将词典与净历史交给共享 roleplay 纯函数。

SDK 导出纯函数和 `useCharacterMentions` 只读 hook，官方 WorldStory 与自定义 UI 使用同一结果 `{characterId,name,matchedKeyword,sourceRunId}`。角色候选不写成模型扩展，也不作为未来 prompt 的新事实；本期不把这条传递路径留待未来再确定。

## 13. Usage、延迟与 token 控制

- 一次 generation 请求同时产生正文和隐藏尾块；实际 output tokens 包括标签、JSON、reason、建议和适配器归一化后的相应模型输出。
- 不因正文隐藏尾块而扣除 Usage；只使用 Provider 报告和已有规范化逻辑，不根据显示字数伪造真实 token。
- 同一请求无法可靠按 state_update/action_suggestions 精确拆分计费；可以记录字节数/字符数作诊断，不能标为精确分能力 token。
- 保留请求 journal、requestId 幂等、unknown 标识和累计 Usage；latestContext 仍只由 generation/continuation 更新，摘要单独计入总量。
- 新叙事路径正常只有一个 generation，不制造 state_review 或 continuation；其他保留能力使用这些阶段时照实记账。
- max_output_tokens 是正文和尾块共享上限。给正文目标长度留余量，限制更新项、reason 和建议长度；没有服务端办法把同一请求的剩余 token 硬性保留给尾块。
- 关闭能力时不注入其动态 schema/例子/业务 prompt；不把过去建议、理由或原始尾块塞回模型上下文。
- 尾块期间前端显示“正在整理状态与建议”，正文已经可读；总延迟中尾块仍占时间，不能宣称正文完成即 Run 完成。
- 首次实现只做无付费 fake-provider 测试。上线前如要比较 reason 有无/模型模式，另用固定样本、同参数、重复试验报告协议通过率、状态正确率、partial 比例、建议可用率、真实 Usage 和延迟，不能以少量示例承诺提升幅度。

## 14. 非破坏性迁移与兼容策略

当前支持基线为 user_version=1。实施前重新确认最新版本，使用下一个独立版本（当前应为 2），不要把“计划 v2”和数据库版本永久绑定。

1. 在 Runtime/HTTP 启动之前持有既有数据目录独占锁；按现有数据库生命周期完成一致性备份，考虑 WAL。
2. 新数据库直接创建新列及新的默认 capabilities。
3. 支持的旧库使用增量事务添加 capability_overrides_json/capability_revision；补预设的缺省能力配置，不覆盖显式配置或自定义 prompt。
4. 保留所有 sessions、entries、world/global/session/message 状态、用户预设/标签、模型与凭据、app settings、原始世界文件。
5. 原节点和 lore 字段采用第 7.2 节的兼容视图，不在此迁移中删除其内容。保存旧世界原始源及哈希，不能为了新 prompt 布局覆盖原文件。
6. 在同一事务中校验保护数据、更新版本；失败回滚，不推进版本、不开放半迁移服务。重复启动不重复迁移。
7. version/schema 不一致或不支持的更旧基线明确失败；不能通过重跑历史 v1 的预设重建迁移“修好”。
8. 新程序拒绝高于自身支持范围的 DB 版本。不宣称旧二进制必然已有该保护；降级必须停服并恢复一致性备份/匹配版本，不直接让旧程序写新库。
9. 旧 Run 保留原有历史，扩展结果缺省；新的协议隔离只对新生成负责，不把任意旧内容当作可执行补丁。
10. 不清浏览器 localStorage，不使既有会话失效；UI 新能力设置缺省继承即可。

迁移测试只使用临时数据库。是否在真实用户库执行升级属于后续功能实施/发布操作，本次文档提交不执行它。

## 15. 实施任务、依赖与文件边界

全部任务当前未执行。由当前单一 Agent 按下列顺序实施小批次变更，统一整合公共文件并执行验证与复查，不委派子代理。

| 任务 | 依赖 | 工作与主要文件 | 完成条件 |
|---|---|---|---|
| T0 基线/契约锁定 | 无 | 重新检查源码及所有消费者；固定本计划中的公共类型、错误码、配置默认和 migration version | 与新源码差异有记录；不以旧文档代替现状 |
| T1 配置和增量存储 | T0 | routes/presets.ts、routes/sessions.ts、common/error-codes.ts、database.ts、新 capability-config.ts、runtime/types.ts | 预设全链路往返、能力错误码分流、会话覆盖/revision/运行中切换、快照与临时库迁移通过 |
| T2 提示词与 Provider 门槛 | T1 | system-main.ts、prompt-builder.ts、context-manager.ts、模型适配器、预设编辑布局、routes/worlds.ts 的兼容提示 | 无旧工具冲突；至少一条当前主用路径通过最终 payload 验证；其他不支持路径请求前拒绝；world 导入/详情/导出提示正确且原源文件未改 |
| T3 分割/解析/处理器 | T0 | 新 narrative 目录、atomic-state 复用边界、extension-contract.ts | 任意 chunk 分割、严格帧/JSON、逐项状态语义、建议依赖均有纯测试 |
| T4 单次 Runner 与最终化 | T1/T2/T3 | agent-runtime.ts、新 narrative-runner.ts、run-store.ts、RunPostProcessor/Usage | 一个 generation；正文先持久化；停止/事务/幂等/恢复一致 |
| T5 API/SDK/历史闭环 | T1/T4 契约 | session-runtime 路由、history-runs、旧 history 投影、run-contract、session-runtime、story-history、host/frame | 查询/分页/三种终态结果一致，不泄漏私有快照/理由 |
| T6 Web 预设/会话/建议 UI | T1/T5 | PresetPage、PresetLibraryPage、SessionSettingsDialog、host、world-story、RoleplayComposer | 默认/继承/下轮生效清楚；建议只填草稿、可撤销、旧建议禁用 |
| T7 关键词候选人物 | T5 | 共享 roleplay 纯函数、story-types/story-context、SDK hook/export、Host/frame 安全词典投影、官方 UI | 不增加模型调用，不改变角色激活；候选误报边界和实际数据通道明确 |
| T8 集成验收与文档同步 | T1–T7 | 下节测试矩阵及相关 API/SDK/数据格式文档 | 核心负例通过，质量门槛通过，复查无阻断问题 |

T1 预设改造必须覆盖以下容易遗漏的消费者：

- presets.ts 的 create/import/read/patch/export、normalizeStored 和 strict schema；当前 catch 统一转 INVALID_PRESET，必须明确分流 INVALID_CAPABILITY_CONFIG，不能让新错误码被吞掉。
- database.ts 的 defaultPreset、新数据库种子、现有库补缺省；不得覆盖用户定制 prompt。
- PresetPage.tsx 的 blankPreset、读取与显式 PATCH 字段白名单。
- PresetLibraryPage.tsx 的导入 normalization warnings 展示。
- test/fixtures/preset.json 与 db-seed.ts，同时保留缺 capabilities 的旧输入测试。
- ContextManager 每轮读预设的位置；冻结一次后各阶段不得重新读取配置。
- 普通会话设置 busy 保护与能力 PATCH 分离，Host 也要分离，不能只放开后端。

T2 同时更新 worlds.ts 的 import/read/export 兼容提示路径，替换固定空 warnings 的假设。详情/导入通过现有响应 warnings 报告旧 lore 布局不生效；导出保留原字段，UI 在发起下载时说明当前编排语义，不向世界文件塞入非 schema 字段。原始 source 下载字节与哈希必须保持不变。

T5 必须一起修改的文件：

- apps/server/src/routes/session-runtime.ts
- apps/server/src/domain/session/history-runs.ts
- apps/server/src/routes/sessions.ts 中旧 history 投影
- packages/sr-sdk/src/run-contract.ts、index.tsx、session-runtime.ts、story-history.ts
- packages/sr-sdk/src/world-story.tsx
- apps/web/src/host.tsx、frame.tsx

## 16. 验证矩阵

### 16.1 纯函数和 fake-provider 必测

| 场景 | 必须证明 |
|---|---|
| 开始标签在每个可能位置拆 chunk | 正文无标签泄漏、无丢字/重复字；结果与单 chunk 相同 |
| JSON 字符串内含标签/转义/中文/emoji | 不误切分，字节和码点限制分别正确 |
| 原生 thinking/reasoning 事件与普通 text 交错 | 不混入正文或自动生成 reason，Usage 保持真实 |
| 空数组、正常数组、最大项数边界 | 无更新与缺失块明确区分，数量限制不被截断绕过 |
| malformed JSON、未闭合字符串、重复对象键、外层重复、子块重复 | 分清局部错误与全局歧义；不选择“看起来最合理”的一份执行 |
| 相同路径、父子路径不同顺序 | 严格原序语义；坏项跳过后后续项基于当前候选 workspace |
| 危险键、只读 scope、未激活根、类型/范围/深度错误 | 不越权，报告原 index，不放宽现有领域校验 |
| reason 缺失/错类型/超长 | 合法状态照常接受，warning 不导致 partial |
| 建议数量偏离目标/重复/空数组/坏元素 | 可用数据与失败策略符合第 5 节，绝不触发第二次模型调用 |
| 外层完整但结束原因为 length/toolUse/deferred | 无状态/建议提交，无工具执行、无续轮 |
| stop 在正文、尾块、解析后、提交前、提交后 | 前四者无候选状态落库；提交后不回滚已完成结果 |
| SSE 断开、重复 finalize、重复 requestId | 服务端继续/幂等，保持现有重复请求拒绝语义，不重复调用和写入 |
| 正常正文创建 assistant entry / 外部 tip 改变 | 本轮 tip 正常推进仍可提交；非本轮 tip/祖先基准变化才拒绝候选 |
| preparing 失败、终态事务可重写/不可写 | 无 entry 时不伪造结果；可写时保存无状态终态，不可写时恢复为 interrupted |
| 没有 partial entry、只有最终文本、空正文 | 不把 raw/tail 当作可见 assistant 兜底 |
| 生成中修改预设/会话开关 | 本轮使用旧快照，下轮采用新配置，false/null/缺省语义准确 |
| 状态合法+建议错误 / 状态 partial+建议合法 | 前者提交状态；后者 blocked，不发布假定全部更新成功的建议 |
| 最终提交前后进程恢复 | 不补写内存候选；已提交结果和未结算 Usage 可恢复 |
| failed/stopped 净正文后续投影 | 显示/模型/摘要/人物使用相同已接受正文；状态缺口不被当成自动补执行 |
| 角色关键词匹配 | 不扫草稿/建议/理由，窗口边界确定；Host→iframe 只传安全词典、旧配置缺省为空，候选不改变 activation |

### 16.2 现有测试扩展位置

| 领域 | 文件 |
|---|---|
| 配置与迁移 | presets.test.ts、database.test.ts、world-session.test.ts、world-config-refactor.test.ts；新增 session-capabilities.test.ts，并覆盖 world 导入/导出 warnings 与原源文件哈希不变 |
| Prompt / 上下文 | context.test.ts、roleplay-context.test.ts；新增最终 Provider payload fixture 测试 |
| 运行时与领域 | runtime.test.ts、atomic-flow.test.ts、worldstory-run-flow.test.ts；新增 splitter/parser/handler 测试 |
| 历史 / 事件 / SDK | history-runs.test.ts、session-runtime.test.ts、sdk-session-runtime.test.ts、story-history.test.ts；覆盖默认订阅不收到 phase、显式订阅收到 phase、卸载清理及 HTTP/SSE 合并 |
| 错误和用量 | error-protocol.test.ts、usage.test.ts |
| Web 草稿与开关 | apps/web/test/host-roleplay/test.tsx；现有 composer/WorldStory 浏览器测试入口 |

同时检查 catalog-flow、usage、runtime 等测试内手写 preset fixture，不能只更新一个 fixture 后留下旧 strict schema 假设。

### 16.3 实施阶段的质量命令

按当前根 package.json：

~~~sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:browser
~~~

执行前仍需核对各 package scripts：当前根 test/lint 主要覆盖 server，不能据此声称全部 Web/SDK 行为已经自动覆盖。Host-roleplay、SDK 和新增 Provider payload 测试必须确认被实际 test 入口发现。浏览器测试使用 fake provider/临时数据；不得顺手调用真实付费模型或真实库做迁移测试。

本次仅写计划时只做文档 diff、引用路径、示例 JSON、术语/契约一致性和复查，不把未执行的上述代码验证标为通过。

## 17. 完成定义与交付顺序

实施交付必须同时满足：

- [ ] 叙事路径没有 AgentRunner/tool loop/tool_choice；一个 generation 同时完成正文和两种输出。
- [ ] 正文、隐藏尾块、私有理由、公开能力结果和权威状态分别存储/投影。
- [ ] 开关继承和运行中下一轮生效可验证，未开启能力绝不执行。
- [ ] 状态逐项语义保持；候选在最终门槛前不生效，停止/重启/重复请求不破坏一致性。
- [ ] 建议 string[] 能被持久化、刷新恢复和安全填入草稿，状态 partial/failed 不误发布。
- [ ] Prompt 无冲突，实际 Provider payload 顺序符合约定；不支持时请求前明确失败。
- [ ] API、SSE、SDK、Host、iframe、历史 reducer 和官方 UI 全链路一致。
- [ ] 人物候选仅用净历史关键词，不增加第三次/第三类模型输出。
- [ ] 用量包含隐藏输出，unknown 不冒充零；无自动修复调用。
- [ ] 增量迁移保留用户数据及预设内容，重复启动幂等；未执行旧计划的破坏性清理。
- [ ] 全部阻断测试通过，浏览器核心流程验收，复查通过。
- [ ] docs/decisions、技术实施状态、配置/API/SDK 文档更新为实际完成状态，并注明仍有限制的 Provider/候选人物识别。

优先把 T1–T5 的服务端契约和稳定性闭环完成，再交付 T6 的交互；T7 是可单独安排的确定性功能。不得为了提前展示建议按钮跳过状态提交、持久化和历史恢复。

## 18. 与旧方案和后续扩展的关系

- 继承旧方案的单次生成、固定平台约束、服务端状态校验、正常终止后提交、Usage/锁/幂等保留。
- 替换单独的 `<state_update>` 尾块为嵌套 `<sr_extensions>`；新增建议和动态开关。
- 明确短 reason 为非阻断依据；不新增长思考块。
- 用非破坏性兼容视图处理旧预设节点和 lore 布局，不继承删除内容及清空会话作为本次前提。
- 旧 `sr_instruction` 删除及其他独立清理仍需独立实施范围；不能因旧文档仍有历史段落就混入本次任务。
- 将来新增能力时，需要增加受控 ID、schema、prompt、依赖/失败策略、持久化投影和消费者测试；外层分帧、单次调用和最终提交门槛不必重写。
- 若将来某能力必须在正文生成前执行、需要实时外部数据或必须反馈模型再生成，它不适合直接塞入本期后置尾块，应另作调用预算与生命周期决策。
