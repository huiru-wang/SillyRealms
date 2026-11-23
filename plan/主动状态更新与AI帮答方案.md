# 主动状态更新与 AI 帮答方案

状态：**方案待实施。本次只新增计划文档，不修改业务代码。**

日期：2026-11-23  
项目：SillyRealms  
核对基线：main / d250d23；当前目录为 apps/server、apps/web。

## 1. 结论与范围

将“主动更新状态”和“AI 帮答”做成两个明确的**会话辅助操作**：

- 各有独立预设模块、独立任务提示词和独立提交入口。
- 共同复用会话写锁、上下文材料、模型适配、结果解析、保存和事件通知机制。
- 每次受理最多进行一次目标模型调用，不生成新的故事回复或用户消息。
- 运行期间锁定会话写入，前端禁输入、发送、重新生成、消息编辑/删除和另一项辅助操作。
- 状态更新校正已经发生的故事所对应的当前状态；AI 帮答生成下一步候选行动，点击后仅填入草稿。

首版保持功能集中：使用当前会话模型和预设采样参数；预设新模块仅配置 prompt；不增加独立模型选择、启停开关、自动重试、任务队列或任务表。新增模块不会自动执行，也不改变日常叙事的状态更新和行动建议流程。

### 两项能力的边界

| 项目 | 主动更新状态 | AI 帮答 |
|---|---|---|
| 用户目的 | 自动更新遗漏、失败，或结果不符合故事事实时主动校正 | 自动行动建议失败，或用户想换一组选择 |
| 输入 | 最新历史、世界/角色信息、状态定义与规则、当前状态、最新回复前状态 | 最新历史、世界/角色信息、当前状态和已有候选 |
| 输出 | message 范围内已有可写路径的最终值 | 新的一组候选行动 |
| 生效对象 | 最新有效 AI 回复关联的状态快照 | 最新有效 AI 回复下的建议 |
| 不产生的副作用 | 不续写故事，不顺便重生成行动建议 | 不改变状态，不代替用户发送或执行行动 |
| 失败 | 保留旧状态和旧能力结果 | 保留原候选和草稿 |

**状态补偿的定位是“校正当前状态”，不是重放整段历史结算。** 首版与现有自动状态更新保持同一写入权限：global/session 只作只读背景，只有本次激活的 message 状态根及已有路径可写。状态 rules 是提示信息，不作为写权限；权限继续由声明、激活范围和结构校验决定。

## 2. 当前实现依据

以下是本方案核对过的当前源码，而非按旧版 serverV2 推测。

| 已有能力或限制 | 源码依据 | 对方案的影响 |
|---|---|---|
| 预设包含 nodes、contextStrategy、modelParameters，领域/存储/导出有显式映射 | [schema.ts](../apps/server/src/modules/presets/schema.ts)、[repository.ts](../apps/server/src/modules/presets/repository.ts)、[card.ts](../apps/server/src/modules/presets/card.ts) | 两个模块要贯通编辑、保存、复制、导入导出，不能只改 UI |
| 主叙事锁覆盖持久化到结算，全局状态也受同世界运行锁约束 | [cache/index.ts](../apps/server/src/infrastructure/cache/index.ts)、[narrative/index.ts](../apps/server/src/usecases/narrative/index.ts) | 扩展现有同一把会话锁，不另外建立互不相知的辅助锁 |
| prepareContext 固定编译叙事请求，可能调用摘要并推进 tip | [context/prepare.ts](../apps/server/src/usecases/context/prepare.ts)、[assemble/index.ts](../apps/server/src/usecases/context/stages/assemble/index.ts) | 复用内部材料与预算能力，增加两个具名辅助上下文入口 |
| 状态/建议有独立解析器，状态使用 JSONL 和绝对值替换 | [state-update.ts](../apps/server/src/usecases/narrative/postprocess/state-update.ts)、[action-suggestions.ts](../apps/server/src/usecases/narrative/postprocess/action-suggestions.ts) | 提取共享处理能力；主动调用额外要求目标标签必须存在 |
| output 目前随新助手追加，普通消息编辑不能伪造 output | [sessions/service.ts](../apps/server/src/modules/sessions/service.ts)、[output.ts](../apps/server/src/modules/sessions/output.ts) | 新增受控更新已有助手结果的保存入口 |
| 状态处理器无变化时返回 snapshot:null | [state-update.ts](../apps/server/src/usecases/narrative/postprocess/state-update.ts) | 补偿旧助手时不能把 null 直接写入，避免撤销现有快照 |
| 用量读取目前把最新 requests 最后一项当主请求 | [sessions/service.ts](../apps/server/src/modules/sessions/service.ts) | 追加辅助计量后必须修正主上下文引用 |
| 更多菜单当前只有重新生成；输入框仍传 disabled=false | [ComposerMoreMenu.tsx](../apps/web/src/features/sessions/ComposerMoreMenu.tsx)、[SessionPage.tsx](../apps/web/src/features/sessions/SessionPage.tsx) | 增加入口并真正禁编辑，不能只禁止发送 |
| run.created 清理旧建议；建议恢复依赖原助手 output | [suggestions/controller.ts](../apps/web/src/features/suggestions/controller.ts) | 独立操作不能冒充 run.created；成功结果要可持久恢复 |
| 浏览器显式注册 SSE 事件，Stage 只有现有叙事忙态 | [session-events.ts](../apps/web/src/transport/session-events.ts)、[stage-contract.ts](../packages/sr-sdk/src/stage-contract.ts) | 同步增加辅助操作事件、查询和忙态投影 |

现有 [WorldStory 消息操作方案](WorldStory-消息操作方案.md) 中的任意消息编辑/批删仍是另一个待实施范围。本方案要求其未来沿用统一写锁，不把那份计划当成已经上线的消息按钮，也不顺带实施整套编辑/批删能力。

## 3. 预设模块

### 3.1 页面组织

在预设详情中增加两个与“模型参数”“上下文”“提示词编排”同级的模块：

| 模块名称 | 说明 | 首版编辑项 |
|---|---|---|
| 状态独立更新 | 用户主动更新状态时使用 | prompt、恢复默认 |
| AI 帮答 | 用户主动生成候选行动时使用 | prompt、恢复默认 |

保留现有提示词编排里的 worldState、actionSuggestions 节点，供日常叙事尾部自动输出使用。独立 prompt 不加入 nodes，不参与节点排序，也不在每轮普通叙事中注入。

模块显示“使用会话当前模型”，不要求额外配置。共用预设的会话使用同一套辅助 prompt，但只在用户点击时执行；操作的状态和结果仍属于发起会话。

### 3.2 配置与兼容

领域和 HTTP 配置增加：

~~~typescript
config.standaloneStateUpdate = { prompt: string };
config.aiReply = { prompt: string };
~~~

- SQLite 的 config_json 沿用已有字段映射风格，增加 standalone_state_update、ai_reply。
- 便携预设文件增加同名 snake_case 模块，与 config_json/context_strategy/model_parameters 同级。
- 旧预设和旧导入文件缺少模块时，在读取/规范化时补默认；不批量覆写数据库、不增加 revision，也不清空历史。
- 用户显式保存空白 prompt 时校验拒绝，使用“恢复默认”回填有效内容。
- 编辑、另存/复制、导出再导入必须完整保留两个模块；保留 expectedRevision 冲突校验。
- 默认内容放在 initial-data/presets/标准叙事.json；default.ts 继续读取发行资源，避免复制一份完整默认模板。
- 兼容属于 JSON 配置扩展，首版不增加表或数据库列。

复用现有 PromptEditorDialog，但增加明确的独立任务编辑模式，不伪造 nodeId。使用现有严格模板语法，变量帮助只显示辅助上下文支持的纯文本变量；历史、摘要和输入由上下文入口统一装配，禁止引用 history.messages、history.summary、input.text。默认 prompt 不需要自行插入历史。

### 3.3 默认提示词建议

**状态独立更新：**

~~~text
你负责校正当前会话状态，不续写故事。

依据已保存的会话事实、状态定义、字段规则、最新回复前状态和当前状态，判断目前应有的最终值。重点检查最新 AI 回复造成的变化，较早历史只作为背景或明确事实依据。

区分已经发生的事实、用户的意图、行动建议和推测。不要把未发生的选项写成状态，也不要重复结算已经生效的变化。

对于金币、次数、数量等字段，结合变化前后的状态计算最终值，不在当前值上再次机械增减。已有处理记录仅供参考，不能因缺少某条记录就认定尚未结算。

只修改有充分依据且确实需要校正的可写字段；无依据的字段保持当前值。仅输出服务端要求的状态数据块，不输出故事、行动建议或分析过程。
~~~

**AI 帮答：**

~~~text
根据当前世界、玩家身份、最新会话和当前状态，为用户生成下一步可以选择的行动。

默认给出三个简洁、不同方向或不同推进速度的选项。贴合当前情境和玩家已知信息，不编造已经获得的线索，不替用户决定或执行行动。

已有候选仅供参考，尽量提供有差异的选择，避免只换一种说法重复原选项。每项可直接作为用户下一条输入，不附带解释。

仅输出服务端要求的行动建议数据块，不续写故事、不更新状态、不输出分析过程。
~~~

格式由平台固定协议保证可解析；用户可调整任务偏好，但不能靠 prompt 改变服务端写入范围和返回格式。

## 4. 入口与交互

输入框“更多”菜单包含：重新生成、更新状态、AI 帮答。沿用当前向上展开的菜单、图标、紧凑控件和移动端尺寸；补全多项菜单键盘焦点移动。

### 可操作的目标

两个操作都针对**当前最后一条普通消息**：该消息必须是 assistant，且自身具有可见正文；其后允许存在 state 严格为 null 的 compaction。若最后一条 assistant 只有推理而没有正文，不向前寻找其他助手代替。

- 开场 assistant 有可见正文时可以帮答；有可写状态时可以更新状态。
- 已停止但保存了有效正文的 assistant 也可以补偿，只依据其中明确成立的事实。
- 末尾只有尚未得到回复的 user 时，提示先生成/重试该轮回复；不自动跳过它去修改更早助手。
- 无有效 assistant 正文时不可用。前端在明确没有 message 状态定义时禁用“更新状态”并说明原因；本次实际激活和可写范围由服务端确定，不能在 Web 复制激活/预算逻辑。服务端发现没有可写根时，在模型调用前结束并提示。
- 目标由服务端根据最新历史确定；客户端不任意指定历史消息进行重算。

### 运行中

点击后立即进入本地提交中；受理后以服务端 operation 状态接管：

- 显示“正在更新状态…”或“正在生成行动建议…”。
- 输入框不可编辑，保留原草稿；发送、重新生成、编辑/删除消息及再次发起辅助操作不可用。
- 已有建议保持显示但不可点击，防止从 Stage 反向修改草稿。
- 提供停止；阅读、滚动、加载历史、查询状态不受影响。
- 帮答成功后整体替换现有建议，点击某项沿用原来的“填入输入框”交互，不自动发送。
- 状态更新成功后刷新状态展示；实际无变化时显示“当前状态无需调整”；部分成功提示有部分字段未能更新。
- 帮答失败或候选为空时提示未能生成新建议，保留原候选。状态失败保留旧状态。
- 不增加辅助操作聊天气泡，不自动滚到底，不清空用户草稿。

统一忙态由叙事发送/生成与辅助操作提交/运行共同组成。至少在辅助操作期间，原生输入框和宿主 composer.setDraft 都必须拒绝编辑；平台控件和 Stage 使用同一宿主快照，不能各自维护互相冲突的 loading。

## 5. 服务端接口与生命周期

建议统一挂在 /api/v1/sessions/:sessionId/operations 下：

| 方法与路径 | 用途 |
|---|---|
| POST /operations/state-update | 独立状态更新 |
| POST /operations/ai-reply | 独立 AI 帮答 |
| GET /operations | 查询当前辅助操作和最新目标上的最近操作回执 |
| POST /operations/:operationId/stop | 停止指定的辅助操作 |

两个提交接口请求体：

~~~json
{
  "operationId": "调用方本次生成的唯一标识",
  "expectedTipEntryId": "客户端看到的实际 tip"
}
~~~

客户端在提交前生成 operationId，服务端验证并沿用；这让 202 响应丢失时仍能准确匹配本次操作，不需要自动重发或完整幂等框架。禁止重复使用当前活跃或最近已记录的同一操作标识；不提供无限历史请求重放。

受理响应使用项目现有 HTTP 包络，状态码 202，data 至少包含 operationId、kind、sessionId、targetEntryId、tipEntryId。kind 固定为 state_update 或 ai_reply。两个提交路由只负责传输与访问校验，后续进入同一辅助操作用例。

### 生命周期

1. 校验会话访问、最新 tip、最新助手资格和运行状态；同步获得共享会话锁。
2. 在第一次异步等待前捕获会话、目标助手、预设/模型、历史、当前状态及必要的前置状态。
3. 创建内存执行句柄，返回 202，并发布 operation.started。
4. 构建目标上下文，调用一次模型，完整收集目标输出；不把半截 JSON 流给用户或用于状态写入。
5. 仅解析本次目标能力，在内存计算候选结果。
6. 在同步事务内重新检查许可、tip 和目标身份，提交状态/结果、实际计量和操作回执。
7. 按持有者身份释放锁，发布已提交业务变化，再发布唯一终态；finally 做幂等释放。

停止根据 sessionId + operationId 定位 AbortController。取消发生在提交前，保持旧业务结果；提交已经完成后不能把“停止”解释为回滚。服务关闭时等待两类运行结算，最后关闭数据库和 SSE，沿用现有关闭顺序。

### 事件

沿用现有会话 SSE 连接，增加：

- operation.started
- operation.completed
- operation.stopped

事件带 operationId、kind、sessionId、targetEntryId、timestamp；终态含实际 tipEntryId 和结果摘要，失败沿用 stop_reason 风格，不新增 error 对象。不要发布虚假的 run.created/run.delta 或改写原叙事 completed/stopped。

状态成功且有效值变化时，继续发布既有 state.changed；帮答有非空有效候选时，继续发布 action_suggestions.created，关联目标助手真实的原 runId/messageId，允许增加可选 operationId 供关联。

通知顺序为：**提交 → 释放锁 → 业务变化事件 → 操作终态**。发布失败不改变已提交结果；客户端通过读取恢复。

## 6. 会话锁与权限

复用 infrastructure/cache/RuntimeCache 的同一个会话互斥机制。内部许可支持“叙事执行拥有者”与“辅助操作拥有者”，仍按对象身份校验；许可不进入 HTTP、SSE 或 SDK。

- 叙事发送、重新生成、状态补偿和帮答彼此互斥，不排队。
- 所有已有会话写入，包括删除会话、普通消息写入/修改/删除、配置切换，继续由 SessionService 拦截。
- session/message 状态写入返回 STATE_WRITE_LOCKED；会话其他写入返回 SESSION_WRITE_LOCKED，均沿用 409。
- 同世界 global 状态继续遵守现有“任一相关会话运行期间禁止外部写入”的规则。
- 其他会话的独立写入可正常执行；不扩为整个世界或整个应用只能有一个模型调用。
- 受控结果保存必须携带本次内部许可，不通过暂时解锁或调用外部 PATCH 绕过保护。
- 读取、SSE 和停止不受写锁阻断。

当前 narrative 的 active Map 只能反映叙事，不能用 activeRunId=null 证明会话空闲。辅助操作有自己的小型执行句柄 Map，共享真正的写锁；不建设通用任务调度框架。

## 7. 上下文构建与一次调用

保留 prepareContext 作为原叙事入口，增加两个具名入口：

- prepareStateUpdateContext
- prepareActionSuggestionsContext

业务输入仍为 sessionId；signal、permit 等只是执行控制。调用方不传入拼好的历史、伪用户消息或“kind”来改造原叙事请求。两个入口在 context 内部复用捕获、历史投影、材料激活、模板渲染和预算能力。

### 本次实际模型输入

| 内容 | 状态更新 | AI 帮答 |
|---|---|---|
| 任务 prompt | standaloneStateUpdate.prompt | aiReply.prompt |
| 世界与角色材料 | 使用当前选中/激活材料 | 使用当前选中/激活材料 |
| 当前有效状态 | 提供当前可见范围、可写路径和字段规则 | 提供当前情境所需状态 |
| 历史 | 保留真实角色和顺序 | 保留真实角色和顺序 |
| 前置状态 | 提供目标助手之前的有效 message 状态 | 不额外需要 |
| 旧结果 | 状态处理记录仅作参考 | 当前候选作为换一组的参考 |
| 末尾任务协议 | 只允许状态数据块 | 只允许建议数据块 |

历史中的最新助手已经是完成保存的正文，保留其 assistant 角色，不伪装成新的 user 输入。未发送草稿不进入模型。固定任务说明与目标标记和真实历史分开装配，避免重复插入最新正文。

不直接复用完整主叙事 messages 再替换 main：主叙事还带有叙事风格、自动尾块和节点顺序约束，会让独立任务收到互相矛盾的指令。保留材料与事实，使用本次任务自己的请求结构。

### 历史预算

为了保证一次点击最多发起一次目标模型调用：

1. 复用当前有效已有摘要，继续校验覆盖范围和 sourceHash。
2. 超预算时裁剪完整历史轮次，每个候选重新计算材料、可写根和实际 token 估算。
3. 保护包含目标助手的最新可见轮次及必要事实；裁剪不得使待处理目标消失。
4. 固定材料、必需状态和目标轮次仍超限时，明确失败，不截断 JSON、不静默删除目标证据。
5. 首版辅助操作不生成新摘要、不追加 compaction；即使预设选择 rolling_summary，也只是复用已有摘要后进行本次只读裁剪。此区别在预设模块说明中简短写明。
6. 模型、思考设置和采样参数继承捕获时的当前配置；输出上限与输入预算沿用现有模型/预设约束。

这里的“最新历史”是以最新保存状态为准并保留最新必要轮次，不承诺把全部历史无限量发送给模型。原叙事摘要策略不受此方案影响。

## 8. 状态补偿的正确语义

### 8.1 前置状态、当前状态和最终值

例如本轮之前金币为 10，最新故事明确“获得 5 枚金币”：

| 当前金币 | 应有结果 |
|---|---|
| 15 | 已经结算，无需更改 |
| 12 | 校正为 15 |
| 20 | 如事实确实只支持增加 5，校正为 15 |
| 无法确认基数或发生事实 | 保持当前值，不猜测 |

不能把“获得 5”再在当前值上累加一次。服务端应用的是模型给出的绝对 value；不新增 add/subtract 之类增量指令，也不依据“某条 output 是否存在”判断事件是否结算。

前置状态通过目标助手之前的有效继承视图获得，当前状态通过真实 tip 获得。前置状态只用于模型理解变化；服务端必须以**当前有效状态**为底应用本次绝对值更新，未涉及的路径保留当前值，不能以旧快照整体覆盖当前状态。开场没有可靠前置状态时明确标记不可用；只处理有充分事实依据的字段，不虚构零基数。人工改过的当前状态也不能因旧记录缺失被盲目复原。

这能避免系统机械重复应用增量，但不保证模型永远理解正确；字段正确性仍受故事证据和模型判断影响。

### 8.2 输出格式与校验

目标格式沿用现有 state_update JSONL：

~~~text
<state_update>
{"path":"inventory.coins","value":15,"reason":"最新回复明确获得5枚金币，本轮前为10"}
</state_update>
~~~

无变化必须返回成对空块。主动调用与普通叙事不同：**完全没有目标标签、标签损坏、调用截断或未正常结束，都视为本次操作失败**，不能伪装为“无需更新”。

复用现有逐行校验和处理规则：仅激活的 message 根、已有路径、合法值；成功行按序应用，重复路径按序覆盖，不新增固定条数限制。允许部分成功并给出简短提示；全部无效时保留旧 output/state，失败信息记本次操作回执/日志。

只执行 state_update；即便模型偶然输出其他能力块，也不执行建议或正文。帮答亦如此，不能越界触发状态更新。

### 8.3 保存位置与无变化语义

补偿后的完整 message 快照与对应结果都保存到目标 assistant 上。正常后置 compaction 的 state=null，会继续继承该助手快照，因此真实 tip 的有效视图同步更新。

不把补偿快照常规写到 compaction：重新生成会删除旧 assistant 而保留摘要，这会残留旧回复的补偿状态。

首版要求目标之后每个 compaction 的 state **严格为 null**；显式空数组 [] 也是独立快照，会终止继承，同样拒绝。若检测到这一非常规情况，拒绝该目标并明确提示当前尾部状态不能直接补偿，不静默写入一个不会生效的历史快照。后续若支持特殊尾部状态，需与重新生成/删除语义一起扩展。

保存入口区分：

- changed=false：保持原 entry.state，不写 null，不创建多余快照。
- changed=true：写入计算后的完整有效快照。

不能直接把现有“为新助手追加而准备”的 snapshot:null 当成旧助手更新值。

## 9. AI 帮答的结果语义

使用 action_suggestions 字符串数组，默认请求三个选项，沿用既有每项不超过 50 个 Unicode 码点、过滤无效项和去重规则。三条是 prompt 目标，不是强制全部满足才成功。

~~~text
<action_suggestions>["询问守卫是否见过来访者。","先去庭院查看足迹。","留在原地观察片刻。"]</action_suggestions>
~~~

- 正常结束且至少保留一条有效候选：以整组方式替换旧建议。
- 部分候选无效：保留有效项，可提示部分生成成功。
- 空数组、全部无效、标签缺失/损坏、失败或取消：不清空旧建议，回执说明本次未得到新建议。
- 原草稿不变。用户主动点击候选时才沿用现有填入行为。
- 新建议持久化到目标 assistant 对应 output，重进页面仍应看到它。
- 恢复时以最新合法助手持久化的有效 actionSuggestions 为准，不再要求原叙事为 completed，也不要求最近一次操作回执为 completed。比如 stopped 助手先手动帮答成功、随后再次帮答失败，之前的有效候选仍应恢复。最近回执只描述最近尝试，不决定已有候选的有效性；原叙事终态保持不变。此项属于对现有建议恢复前提的明确调整，不能回退展示更早助手的建议。
- 下一轮普通叙事开始，继续沿用 run.created 清理旧建议的现有行为。

## 10. 持久化与计量

### 10.1 只保存一份能力结果

目标助手的 extData.output 定义为**各能力最近一次有效完成的处理结果**：

- 主动状态更新只替换 stateUpdate。
- 帮答只替换 actionSuggestions。
- 另一能力、正文、推理、原叙事终态及其他扩展字段保留。
- 有效的 no_updates 可以更新 stateUpdate 处理记录，但保持原状态快照。
- 失败/取消不替换原能力结果。

output 不是该消息所有处理次数的累积账本。旧成功行被替换后，后续模型旁注反映最近结果；实际有效状态继续以完整快照为准。不能通过重放旁注恢复状态。

原本中断的助手可能没有 output。存储层允许只出现本次已执行的能力字段；另一字段缺失代表没有处理记录，不能虚构“已经执行且无变化”。主叙事正常保存仍要求自己的完整双能力输出。读取归一化、model-notes 和前端投影同步支持字段缺失。

### 10.2 操作回执

同一目标助手的 extData.operations 只记录 stateUpdate / aiReply 各自最近一次终态：

~~~typescript
{
  operationId,
  kind,
  status,       // completed / stopped
  finishedAt,
  stopReason?,  // 失败或取消时
  requestId?    // 真正调用过模型才有
}
~~~

回执不再保存一份 output，不保留完整任务历史，不承担崩溃重放。运行中只存内存句柄。普通 extData 编辑禁止伪造/删除 operations，其他编辑原样保留。

新增 SessionService 的受控 commitOperation 能力，并由属主 Repository 原子写入：

1. 检查本次内部许可、expectedTip、目标仍是最新合法助手。
2. 合并本次能力结果；仅实际变化时写状态。
3. 追加实际请求计量，保存本次回执。
4. 不改消息 ID、seq、parent、runId、正文或 session.tipEntryId。

解析与网络调用不在事务中。失败/取消可只保存回执和实际计量；若提交本身失败则业务变更整体回滚，不发成功事件，也不能宣称已有持久回执。

目标消息被删除/重新生成时，其结果、回执、快照和辅助计量随该 entry 一并移除，沿用“现存 entries 统计”规则；这不代表供应商费用退款。

### 10.3 计量与主上下文

每次真正尝试的目标调用追加到目标助手 metrics.requests；调用前失败/取消不虚构 requestId 和计量。已经发生但 usage 未知时记录 null，不当成零。

建议给请求增加可选 purpose，区分 narrative、summary、state_update、ai_reply；新增请求写清用途，旧记录保持可读且不批量重写。

必须同步修正 recordedUsage：

- 累计用量包含真实辅助请求，不覆盖旧请求。
- 主叙事上下文按 metrics.context.requestId 找对应请求，不再直接取 requests.at(-1)。
- 跳过“只有辅助请求”的助手（例如仅对开场做过帮答），继续找最近有主叙事请求的条目。
- 旧记录没有 context 时保留既有未知组成/窗口的回退语义，但显式排除辅助请求。
- 辅助操作不覆盖原主叙事 context 快照，也不产生假的 run.usage。
- 操作终态后前端补读既有会话 usage 接口。

日志沿用单行时间、事件、数据结构，携带 sessionId、operationId、kind。记录请求、目标解析、结算结果与 stop reason；区分 prepared 与 committed，不新增重复 model.input。

## 11. 同步、刷新与异常

GET /operations 返回当前 active 辅助操作，以及最新目标的最近两项回执；真实结果仍从状态接口和 narrative/runs 读取。

前端在页面进入、SSE 重连、HTTP 受理结果不确定时查询。使用预先生成的 operationId 精确核对：

- 匹配 active：保持忙态并继续订阅。
- 匹配持久回执：按终态补读当前结果。
- 没有匹配：显示结果未确认/执行已中断，恢复以服务端真实忙态为准；不自动再次调用模型，不把上一条回执冒充本次成功。

操作更新已有 entry 不产生新 seq，结束后必须刷新包含目标助手的最近完整轮次；不能只查询 afterSeq > 原 seq，否则会漏掉 output/metrics 的变化。复用 bounded recent refresh 和现有覆盖式同步；旧页/迟到响应以操作身份、最新轮次和现有 checkpoint 保护。

| 场景 | 规定行为 |
|---|---|
| 叙事或另一辅助操作已在运行 | 返回现有忙/锁冲突，不排队、不启动第二次调用 |
| 客户端 tip 过期 | TIP_CONFLICT，刷新后由用户再发起 |
| 快速重复点击 | 本地 pending 禁用；服务端同一锁兜底 |
| 202 丢失或请求超时 | 查询本次 operationId，不自动重发 |
| 终态早于 202 到达 | 控制器按 operationId 去重，迟到受理响应不能把已结束操作重新置为运行 |
| 模型输出中断、坏标签、全部无效 | 不应用不完整结果；保留旧业务数据 |
| 部分状态/建议项有效 | 保存有效项并标记 partial_success |
| 停止请求 | 提交前取消保持旧结果；已提交结果不回滚 |
| SSE 断开/切换页面 | 不等于取消；服务端继续运行，回来查询状态和结果 |
| 服务进程重启 | 不恢复执行；读取已提交结果，不把缺失句柄当成本次成功 |
| 保存失败 | 不发业务成功事件；结束并释放锁，报告持久化失败 |
| 普通叙事随后开始 | 旧 operation 终态不能解除新运行的忙态或恢复旧建议 |

## 12. 模块职责

- **presets**：辅助 prompt 的配置、校验、默认内容和便携格式。
- **context**：从当前会话生成两类实际请求；保持材料、历史、预算能力内聚。
- **session-operations 用例**：受理、停止、锁生命周期、模型执行、目标结果结算和通知。
- **共享输出处理**：状态/建议标签、JSONL/JSON 解析与结果计算，供叙事和独立操作共用。
- **sessions**：目标资格所需领域读取、受控结果/回执/计量持久化；Repository 仍只操作本域表。
- **state**：有效视图与候选计算，不增加表，不发事件。
- **Web operations feature**：辅助操作状态与查询；workspace 组合，Stage 只接收快照并代理命令。

从 narrative/postprocess 提取真正共享的 parser、strict-json、state-update、action-suggestions 到 usecases/session-output，提供明确出口。叙事继续拥有正文流切分及叙事处理调度，两个辅助入口不依赖 narrative 私有执行流程。context 不反向依赖这些用例或 SSE。

这次共用的是已经出现的两种辅助操作及既有叙事解析能力，不设计插件注册中心、通用任务引擎或 Agent/tool loop。

## 13. 计划变更文件目录

以下为计划范围，**不代表已实施**。新增文件名可在实现时小幅调整；迁移文件在原位置删除后移入新目录，避免同时保留两份实现。

~~~text
SillyRealms/
├── initial-data/presets/标准叙事.json                 [修改] 两个默认 prompt
├── apps/server/
│   ├── AGENTS.md                                     [修改] 实施后更新事实契约，不放宽架构边界
│   ├── eslint.config.mjs                             [修改] 共享输出/具名 context 出口约束
│   └── src/
│       ├── app.ts                                    [修改] 路由注册和双类执行关闭
│       ├── usecases.ts                               [修改] 显式装配辅助用例
│       ├── errors.ts                                 [修改] 目标不可用/无可写状态/辅助停止原因
│       ├── infrastructure/cache/index.ts             [修改] 同一互斥许可支持辅助拥有者
│       ├── infrastructure/logging/run-logger.ts       [修改] 复用格式，支持辅助操作身份
│       ├── modules/presets/
│       │   ├── schema.ts                             [修改] 配置与模板校验
│       │   ├── service.ts                            [修改] 旧值补默认、领域映射
│       │   ├── repository.ts                         [修改] 存储字段映射
│       │   ├── card.ts                               [修改] 导入导出映射
│       │   └── service.test.ts                       [修改] 新旧配置与往返验证
│       ├── modules/sessions/
│       │   ├── service.ts                            [修改] commitOperation 与主请求计量读取
│       │   ├── repository.ts                         [修改] 原子合并结果/状态/回执/请求
│       │   ├── schema.ts                             [修改] 回执保护、请求 purpose
│       │   ├── types.ts                              [修改] 明确公开类型
│       │   ├── output.ts                             [修改] 存储能力字段可缺失、叙事输入仍完整
│       │   ├── stored-output.ts                      [修改] 新旧结果读取归一化
│       │   └── service.test.ts                       [修改] 原子性、保留字段、计量归属
│       ├── routes/
│       │   ├── session-operations.ts                 [新增] 两提交、查询和停止
│       │   └── session-operations.test.ts            [新增] 访问校验与 HTTP 契约
│       ├── usecases/context/
│       │   ├── index.ts                              [修改] 两个具名公开入口
│       │   ├── types.ts                              [修改] 辅助准备结果类型
│       │   ├── prepare-operations.ts                 [新增] 捕获、目标证据、只读预算裁剪
│       │   ├── prepare-operations.test.ts            [新增] 最新目标、摘要复用、一次调用边界
│       │   ├── stages/assemble/operations.ts         [新增] 两种请求与固定目标协议
│       │   └── stages/model-notes/                   [修改] 容忍单能力 output，保持事实旁注语义
│       ├── usecases/session-output/
│       │   ├── index.ts                              [新增] 共享解析/计算公开出口
│       │   ├── parser.ts                             [迁入] 自身标签匹配
│       │   ├── strict-json.ts                        [迁入] JSON/JSONL 解析
│       │   ├── state-update.ts                       [迁入并修改] 显式 changed 和候选结果
│       │   ├── action-suggestions.ts                 [迁入] 建议过滤和去重
│       │   └── 对应解析测试                          [迁入并修改] 维持叙事行为，覆盖独立协议
│       ├── usecases/session-operations/
│       │   ├── index.ts                              [新增] 受理、查询、停止、关闭
│       │   ├── execute.ts                            [新增] 一次调用与目标分支
│       │   ├── settle.ts                             [新增] 事务保存、通知、回执
│       │   ├── types.ts                              [新增] 两类操作与显式依赖
│       │   └── index.test.ts                         [新增] 锁、失败保持、停止、重复补偿
│       ├── usecases/narrative/
│       │   ├── postprocess/processor.ts              [修改] 调用共享计算，保留叙事调度
│       │   └── postprocess/上述四个原实现及对应测试     [删除/迁出] 不保留重复解析器
│       └── testing/architecture.test.ts              [修改] 验证新边界，保持 SQL/SDK 规则
├── apps/web/src/
│   ├── api.ts                                        [修改] 辅助接口与返回类型
│   ├── features/presets/
│   │   ├── types.ts / adapter.ts                     [修改] 新模块双向映射
│   │   ├── PresetStore.tsx                           [修改] 读取独立默认 prompt
│   │   ├── PresetLibraryPage.tsx                     [修改] 两个平级模块
│   │   └── PromptEditorDialog.tsx                   [修改] 辅助任务模式和变量帮助
│   ├── features/operations/
│   │   ├── controller.ts                            [新增] operationId、忙态、停止和补查
│   │   └── index.ts                                 [新增] feature 出口
│   ├── features/sessions/
│   │   ├── ComposerMoreMenu.tsx                      [修改] 两入口与键盘操作
│   │   ├── SessionPage.tsx                           [修改] 禁编辑、运行提示、停止分流
│   │   └── workspace.ts                             [修改] 统一忙态、事件和最近轮次刷新
│   ├── features/suggestions/controller.ts            [修改] 成功替换、失败保持、手动结果恢复
│   └── transport/session-events.ts                   [修改] 事件名白名单与字段验证
├── apps/web/tests/
│   ├── session-workspace.test.mjs                    [修改] 一致忙态与受理超时补查
│   ├── session-events.test.mjs                       [修改] 新事件分发及迟到事件
│   ├── suggestions.test.mjs                          [修改] 替换/保留/刷新恢复
│   └── stage-frame.test.mjs                          [修改] Stage 快照与写命令边界
├── packages/sr-sdk/src/
│   ├── stage-contract.ts                             [修改] 辅助状态和事件类型
│   └── stage/
│       ├── runtime.ts                                [修改] 只读快照与公开类型适配
│       └── world-story.tsx                           [修改] 忙态禁用建议点击
├── docs/runtime/
│   ├── server-http.md                                [修改] 实施后的接口事实
│   ├── server-events.md                              [修改] 实施后的事件事实
│   ├── server-narrative.md                            [修改] output 与计量的实际含义
│   └── web-runtime.md                                [修改] 忙态和辅助结果同步
└── AGENTS.md                                         [修改] 实施后更新真实契约与职责归属
~~~

模块中的其他文件只在类型/调用链确有依赖时同步调整，不以此扩成全局重构。首版不需要新增数据库表、state Repository、SDK 作者主动调用 API 或新的消息删除 UI。源码根目录相关文档更新在功能实际落地后完成，本次仅保存此计划。

## 14. 实施顺序与验收

建议分三步完成同一功能：

1. **服务端基础与预设配置**：配置往返、两个 context 入口、共享输出处理、同一会话锁和受控保存能力。
2. **端到端业务契约**：两提交/查询/停止接口、事件、计量、失败/取消以及有效结果恢复。
3. **Web 与 Stage**：预设编辑模块、更多菜单、禁编辑和统一忙态、建议替换与重连补读。

验证遵循当前仓库约束：函数级测试、typecheck、lint；不启动真实服务、不调用真实模型、不增加模拟端到端环境。

必须覆盖的行为：

- 旧预设自动获得可用默认，新预设复制/导出再导入不丢字段。
- 两个辅助操作与叙事互斥；直接 HTTP/Stage 写入不能绕过锁。
- 单次辅助操作不新建 user/assistant/compaction，不修改 tip/seq，不触发新摘要模型调用。
- 10 + 5 已是 15 时无实际变化；当前 12 时写 15；再次执行不能由服务端机械累加。
- 无变化绝不把已保存 state 写成 null；部分成功只应用有效值，失败/取消保留旧结果。
- 中断助手原无 output 时只写实际能力，不伪造另一能力。
- 补偿/帮答成功后删除或重新生成目标，旧状态/建议/回执不残留。
- 辅助请求累计计量可见，主上下文面板仍关联原主请求；开场辅助计量不冒充主叙事。
- 帮答成功整体替换，失败/空结果保持；对 stopped 助手先手动成功、再重试失败，刷新后仍恢复上次有效候选。
- 202 超时、SSE 断连、终态先于受理响应、旧终态迟到，不导致自动重发、假空闲或覆盖新结果。
- 数据提交前不发业务成功事件，提交失败释放锁且不留下半份状态/结果。

完成标准：用户在输入框更多菜单能主动校正状态或换一组行动建议，运行期间会话写入被可靠锁定；结果可查询、可恢复，并与原叙事和当前状态保持清晰关系。
