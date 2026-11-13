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

## Run 的统一公开投影

GET `/sessions/:id/runs/:runId`、历史 Run 和终态 SSE 使用同一白名单投影。除既有 id/runId、status、净 messages 外，可附带：

- executionMode：direct / agent；
- phase：preparing / narrative / extensions / finalized；
- capabilities：revision、stateUpdate.enabled/required、actionSuggestions.enabled/count；
- extensions：protocol=sr_extensions/v1、stateUpdate 和 actionSuggestions。

旧 Run 缺失新字段时保持缺省。interrupted 对外为 failed、RUN_INTERRUPTED、finalized，Direct 未决扩展不再 pending。reason、原始模型响应/尾块、完整 payload、私有 RuntimeConfig 和凭据不公开。

stateUpdate.status 为 disabled / not_required / pending / unchanged / applied / partial / failed / cancelled；附 acceptedCount、changedPaths、skipped（index/errorCode/errorMessage）和 warningCodes。actionSuggestions.status 为 disabled / pending / ready / blocked / failed / cancelled；附 items、warningCodes 和可选 blockedBy。部分状态成功阻止建议发布；建议单独失败不撤销合法状态。

新增 SSE `run.phase` 只有 `{runId, phase}`。既有 run.created/delta/completed/failed/stopped 名称不变。服务器不会重放断线期间事件。Host 重连重新 GET session 与已知/活动 Run；若终态已经落库，用完整净 messages 补齐。准备任务在重启前尚未落库且已不存在时，Host 解除临时 busy 状态、提示中断并保留当前草稿；这不创建持久 Run。

## SDK 与界面兼容

```ts
// 原有五类事件，旧消费者无需改动
session.subscribe((event: RunEvent) => { /* ... */ });

// 明确选择新阶段事件
session.subscribe((event: SessionRunEvent) => { /* ... */ }, { includePhase: true });
```

终态优先于迟到的 preparing/narrative/created/delta，不能被旧事件恢复为 running。官方 WorldStory 使用同一公开 SDK；未新增特权接口。

建议按钮只有最新 completed Run 可点击；新 Run 开始后旧建议禁用但保留历史显示。点击通过 session.setDraft 替换 Host 草稿，不自动发送；已有草稿可撤销，后续编辑使撤销失效。模式/预设/模型在 busy 时禁用，Direct 能力保存仍可用于下一轮；Agent 显示“不适用”。Creator iframe 的 sandbox、CSP、import allowlist 和 MessageChannel 边界保持原规则。

## 数据库版本 2

沿用 sessions、entries、ext_data、metrics_json、usage_json；无 runs 表，无 Direct/Agent 分表。sessions 增加：

| 字段 | 含义 |
|---|---|
| execution_mode | direct / agent |
| capability_overrides_json | 两个可选布尔覆盖 |
| capability_revision | 能力乐观并发版本 |

初始/续轮摘要继续使用 type=compaction 的 Entry，保留 coveredThroughEntryId 和有界 gaps。Run 用户 Entry 的 ext_data.run 保存公开结果，ext_data.runtime 保存必要配置快照/预算诊断与 finalized 标记；快照只存模型/配置引用，不存明文 key。

### 升级与保护

- 全新空库创建 v2；API 新建会话显式写 Direct。
- 支持的历史基线为 user_version=1。磁盘库先通过 VACUUM INTO 写一致性 `.backup-v1-<timestamp>` 备份，然后执行单一增量事务。
- 旧会话没有模式字段时默认 Agent；有 sr_extensions 历史证据的会话回填 Direct；已有合法显式模式保持。
- 保留 sessions/entries、世界与各 scope 状态、预设全文/节点、模型/credential_ref、标签/引用、app settings 和 world 源文件。能力 defaults 只补结构，关闭时的自定义 prompt 不被覆盖。
- 所有 schema/metrics/capability/default/version 变更在同一事务；失败回滚。版本与结构不匹配、不支持的旧 v0 和未来版本明确拒绝，不执行历史破坏性“修复”。
- 已为 v2 的库不重复迁移、不重置模式。启动时仍处理未完成 Run 和 Usage journal 的恢复。

本次开发只运行隔离临时库的迁移测试，未对真实用户库执行升级。测试覆盖备份可读、内容/引用保留、事务回滚、版本拒绝、模式推断和重复启动。

### 启动与人工回滚

重构前已停止监控源码的开发服务，避免开发过程中自动升级真实库。用户决定启用新版时，在仓库运行 `pnpm dev`；v1 磁盘库首次打开将自动备份并迁移。Web 开发服务命令为 `pnpm dev:web`。

如需要回滚，先停服务并确认无进程持有数据库；把当前库与 WAL/SHM 及迁移后的新增内容整体另存，再用升级前的一致性备份恢复到原路径并搭配旧代码。不要在运行中的数据库上覆盖文件；旧代码不要直接打开 v2 库。回滚后新产生的会话变更不会自动合并，需要单独导出/保留。本项目没有自动降级迁移。这里仅记录操作方案，没有执行回滚。
