# Runtime v2：API、SDK 与存储契约

更新：2026-11-13。普通 HTTP 沿用四字段 envelope：`success / errorCode / errorMessage / data`。本文 JSON 示例省略外层 envelope。

## 会话模式与能力

新建会话返回 `executionMode: "direct"`。GET `/api/v1/sessions/:id` 返回模式和 activeRun；普通 PATCH 可设置 `executionMode: "direct" | "agent"`，运行中拒绝并返回 409 SESSION_BUSY，异步凭据校验之后写入前再次检查占用。切换模式保留原历史。

activeRun 为空或含 `id, status, phase, executionMode, capabilities`，覆盖还没有 user Entry 的 preparing。capabilities 是当前 Run 冻结的公开快照，不包含业务 prompt。

能力接口：

```http
GET   /api/v1/sessions/:id/capabilities
PATCH /api/v1/sessions/:id/capabilities
```

```json
{
  "expectedRevision": 3,
  "overrides": {
    "state_update": false,
    "action_suggestions": null
  }
}
```

布尔值显式覆盖，null 删除覆盖恢复继承；省略字段不变。仅允许这两个开关，不能提交 prompt/count。expectedRevision 必填；冲突为 409 CAPABILITY_REVISION_CONFLICT，成功 revision 加一。能力专用 PATCH 可在运行中保存，下一轮生效。

GET/PATCH 返回 revision、overrides、下一轮 effective（enabled 和建议 count）、sources（platform/preset/session）、availability（Direct applicable；Agent reason=agent_mode）及当前 activeRun。提示词从不进入会话能力 DTO。

预设 capabilities 支持状态 enabled/prompt、建议 enabled/count/prompt，prompt 最多 2,000 codepoint，count 为 2–4。导入、创建、读取、字段级 PATCH 和导出保留能力配置及关闭时的自定义文本。默认状态开启、建议关闭、count=3。兼容 warnings 根据 Direct 模式解释旧 postHistory、worldState 与内置顺序的实际编排，不删除原内容。

## 预设上下文配置

规范 `budget` 为 `{strategy, max_context_tokens, max_output_tokens}`。strategy 可为 rolling_summary 或 sliding_window，缺省 rolling_summary；新建内置预设为 32768 输入、2048 输出。保存时校验正安全整数；实际模型上限在 Run 准备期校验：`C <= min(floor(W*0.8), W-O-1024)`，`O <= model.maxTokens`，且 `floor(C*0.6)>0`。

旧 context_strategy 仅作为兼容输入。旧总窗口 compact=131072、standard=262144、extended=524288 转为窗口减 O 减 1024；内部保留 legacyWindow 来源，在运行时按模型夹紧。GET/创建响应/PATCH 响应/导出只返回规范数值，不返回来源标记。外部不能提交该标记，不能混合 context_strategy 与 strategy/C；PATCH 只改 O 时保留旧来源，显式改 C 后清除。导出后重新导入成为严格数值配置，模型过小时可能需调整。

任意数值不反推或伪造成旧档位。本期未改 Web/Studio 的档位编辑器：旧格式提交仍兼容，但旧表单无法正确表示任意新数值；将旧档位混入新数值结构的提交会被拒绝。数值/策略编辑及恢复按钮待前端另期接入。

## Run 的统一公开投影

历史 GET `/sessions/:id/runs` 保留按完整 Run 分页，limit 为 1–20；从当前 tip 向前读取所需 Run，返回页内按时间正序排列，不拆开输入与回复。旧 `/sessions/:id/history` 保留原有 1–100 上限、倒序 Run 和 entries 格式，两接口共用有界读取。nextCursor 的 sessionId/before 格式不变，新增消息后旧游标仍能读取更早内容。

分页只读取目标页和一条更早边界记录，不加载全部历史正文。游标归属校验可向前遍历 id/parent_id/run_id/seq 等头字段，不读取中间正文。页面范围内的断链、跨会话父指针或循环明确失败；不在每页读取时验证所有更早历史，完整链校验仍在 Run 准备等需要完整来源的操作中执行。前端和 SDK 返回契约不变。

GET `/sessions/:id/runs/:runId`、历史 Run 和终态 SSE 使用同一白名单投影。除既有 id/runId、status、净 messages 外，可附带：

- executionMode：direct / agent；
- phase：preparing / narrative / extensions / finalized；
- capabilities：revision、stateUpdate.enabled/required、actionSuggestions.enabled/count；
- extensions：protocol=sr_extensions/v1、stateUpdate 和 actionSuggestions；
- failure（可选）：stage 为 preparation / generation / continuation / commit；type 为 configuration / summary / context_window / context_integrity / provider / persistence / interrupted；
- recovery（可选）：inputSaved 布尔值，action 为 resubmit / adjust_configuration / inspect。

旧 Run 缺失新字段时保持缺省。interrupted 对外为 failed、RUN_INTERRUPTED、finalized，Direct 未决扩展不再 pending。reason、原始模型响应/尾块、完整 payload、私有 RuntimeConfig 和凭据不公开。

stateUpdate.status 为 disabled / not_required / pending / unchanged / applied / partial / failed / cancelled；附 acceptedCount、changedPaths、skipped（index/errorCode/errorMessage）和 warningCodes。actionSuggestions.status 为 disabled / pending / ready / blocked / failed / cancelled；附 items、warningCodes 和可选 blockedBy。部分状态成功阻止建议发布；建议单独失败不撤销合法状态。

新增 SSE `run.phase` 只有 `{runId, phase}`。既有 run.created/delta/completed/failed/stopped 名称不变。服务器不会重放断线期间事件。Host 重连重新 GET session 与已知/活动 Run；若终态已经落库，用完整净 messages 补齐；仍在运行则通过 SDK run.snapshot 补齐内存正文。准备输入在 202 前持久化；恢复后 GET 已知 Run ID 可得到 failed + RUN_INTERRUPTED。此前旧库只有 usage journal 的中断准备可能没有输入，此时 recovery.inputSaved=false，不伪造可恢复文本。

2026-11-14 增量协议：Server 的 `run.delta` 发送 `{runId,messageId,offset,text}`，offset 为该消息净正文中从零开始的 UTF-16 code unit 位置（JavaScript string.length 单位）。客户端验证重叠部分并只追加新后缀；缺口重新读取快照。SDK offset 暂保留可选以兼容旧 Host/作者测试，缺少位置的旧增量无法提供同等去重保证。

SDK 新增 `run.snapshot`：`{runId,status,messages,...RunMetadata}`，由 Host 重连查询后发布，不是持久 SSE 重放。普通 subscribe 和 includePhase 订阅均可收到此事件；作者的事件分派需识别新类型。运行中快照不覆盖更长的同前缀正文，旧阶段不得覆盖较新阶段；终态完整 messages 始终替换临时消息，即使为空，也清除无法保存的临时正文。迟到的运行中事件不覆盖终态。未增加 SDK 方法或 Host 的 Server 访问权限。

正文在每次模型响应结束、停止或失败时保存，生成期间的增量与运行中快照为临时内容；Server 崩溃时可能丢失。GET 最新历史页将已有活跃 Run 的 messages 替换为内存快照，尚无 user Entry 的 preparing 可额外返回无消息占位；不会返回准备 input。更早页与正式终态来自数据库。

准备失败/停止的 GET `/api/v1/sessions/:id/runs/:runId` 返回 `messages: []`、当前 tip 和可选 `input: {text}`。这些准备记录不进入正式历史列表。SSE 终态使用同一 failure/recovery，但不额外广播 input；正常正式 user 消息仍按原 run.created 协议发送。Usage API 和错误消息不携带准备输入。用户主动重试复用原文本，以新 requestId 和当前 expectedTipEntryId 走既有 POST；旧 requestId 返回 409，不启动第二次调用。没有专用重试 endpoint，也没有自动重试。

停止可返回 recovery，但不返回 failure，不发布 run.failed。已知 Provider 窗口错误为 PROVIDER_CONTEXT_WINDOW_EXCEEDED；完整摘要估算超预算为 SUMMARY_CAPACITY_EXCEEDED（零调用）；摘要 Provider/流异常为 SUMMARY_FAILED，空结果为 SUMMARY_EMPTY。摘要内部受控 causeCode 只存私有诊断。action 是建议，不保证原样重试成功。

## SDK 与界面兼容

```ts
// 原有五类事件，旧消费者无需改动
session.subscribe((event: RunEvent) => { /* ... */ });

// 明确选择新阶段事件
session.subscribe((event: SessionRunEvent) => { /* ... */ }, { includePhase: true });
```

终态优先于迟到的 preparing/narrative/created/delta，不能被旧事件恢复为 running。官方 WorldStory 使用同一公开 SDK；未新增特权接口。

建议按钮只有最新 completed Run 可点击；新 Run 开始后旧建议禁用但保留历史显示。点击通过 session.setDraft 替换 Host 草稿，不自动发送；已有草稿可撤销，后续编辑使撤销失效。模式/预设/模型在 busy 时禁用，Direct 能力保存仍可用于下一轮；Agent 显示“不适用”。Creator iframe 的 sandbox、CSP、import allowlist 和 MessageChannel 边界保持原规则。

## 数据库版本 3

沿用 sessions、entries、ext_data、metrics_json、usage_json；无通用 runs 表，无 Direct/Agent 分表。v2 已引入 sessions 字段：

| 字段 | 含义 |
|---|---|
| execution_mode | direct / agent |
| capability_overrides_json | 两个可选布尔覆盖 |
| capability_revision | 能力乐观并发版本 |

准备成功的摘要使用 type=compaction 的 Entry，保留 coveredThroughEntryId 和有界 gaps；不再创建续轮摘要。Run 用户 Entry 的 ext_data.run 保存公开结果，ext_data.runtime 保存必要配置快照/预算诊断与 finalized 标记；快照只存模型/配置引用，不存明文 key。

新增 `run_preparations`：run_id 主键，session_id 外键 ON DELETE CASCADE，(session_id, request_id) 唯一；保存 expected_tip_entry_id、input_text、status、created_at/finished_at、result_json、metrics_json、accounted。status 为 preparing / failed / stopped / interrupted；仅旧版无输入恢复记录允许 input_text=null。

准备记录和 pending usage journal 同事务创建；成功时同事务提交摘要和 user Entry 并删除准备记录；失败时同事务保存终态/指标、累计真实用量并清 pending。零调用失败也保留输入，不按 64 条淘汰、不把输入塞进 usage_json。准备记录随所属会话的既有显式删除级联清理。

### 升级与保护

- 全新空库创建 v3；API 新建会话显式写 Direct。
- 支持历史 user_version=1/2。磁盘库先通过 VACUUM INTO 写一致性 `.backup-v1-<timestamp>` 或 `.backup-v2-<timestamp>` 备份，再执行单一增量事务。v2→v3 只增准备表及索引/约束，不重写现有业务行；v1 继续执行既有模式/能力迁移。
- 旧会话没有模式字段时默认 Agent；有 sr_extensions 历史证据的会话回填 Direct；已有合法显式模式保持。
- 保留 sessions/entries、世界与各 scope 状态、预设全文/节点、模型/credential_ref、标签/引用、app settings 和 world 源文件。能力 defaults 只补结构，关闭时的自定义 prompt 不被覆盖。
- 所有 schema/metrics/capability/default/version 变更在同一事务；失败回滚。版本与结构不匹配、不支持的旧 v0 和未来版本明确拒绝，不执行历史破坏性“修复”。
- 已为 v3 的库不重复迁移、不重置模式；校验版本与准备表结构。启动时仍处理未完成 Run 和 Usage journal 的恢复。

本次开发只运行隔离临时库的迁移测试，未对真实用户库执行升级。测试覆盖备份可读、内容/引用保留、事务回滚、版本拒绝、模式推断和重复启动。

### 启动与人工回滚

重构前已停止监控源码的开发服务，避免开发过程中自动升级真实库。用户决定启用新版时，在仓库运行 `pnpm dev`；v1/v2 磁盘库首次打开将自动备份并迁移至 v3。Web 开发服务命令为 `pnpm dev:web`。

如需要回滚，先停服务并确认无进程持有数据库；把当前库与 WAL/SHM 及迁移后的新增内容整体另存，再用升级前的一致性备份恢复到原路径并搭配旧代码。不要在运行中的数据库上覆盖文件；旧代码拒绝高于其支持版本的库，不要绕过检查直接打开 v3 库。回滚后新产生的会话变更不会自动合并，需要单独导出/保留。本项目没有自动降级迁移。这里仅记录操作方案，没有执行回滚。
