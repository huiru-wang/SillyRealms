# SillyRealms 会话 Token 统计实施方案

> 状态：**设计已确认，待实现**（2026-11-08）。
>
> **产品范围仅有两个维度：Session 累计消耗、最新上下文占用。**
>
> 继续采用 `entries.metrics_json` 和 `sessions.usage_json` 两个新增字段，不为统计新建 `runs` / `model_requests` 表；在 `AgentRuntime` 统一调用 `RunPostProcessor`，Run 结束后归集到 Session。仅统计 Token，**不计算费用**。首字、请求总耗时等如果保留，只作为 Entry/Run 运行诊断，不作为 Session 的第三类统计或顶栏核心指标。
>
> 与现有 `Session / Entry / Run` 生命周期、世界线分叉、历史压缩、取消和 Creator iframe 隔离兼容。本文件是待实施方案，**未修改业务代码或真实数据库**。

## 1. 两个维度的业务定义

### 1.1 Session 累计消耗（历史实际用量）

这是整个 Session 自创建以来**所有实际模型请求**的累计 Token，包含摘要模型、主生成、工具续写、隐藏的 `state_review`、失败前已报告用量的调用及废弃分叉。历史压缩、分叉切换、重新生成不会扣减此前已经产生的 Token。

| 字段 | 定义 |
| --- | --- |
| `inputTokens` | 会话所有模型请求的**总输入 Token**，包含未缓存输入、缓存读取和缓存写入 |
| `outputTokens` | 会话所有模型请求的输出 Token，包含 reasoning（不另加一遍） |
| `totalTokens` | 会话累计总 Token；保留 Pi/Provider 报告的总量口径，差异可诊断 |
| `cacheReadTokens` | 输入中复用了缓存的 Token，**是 inputTokens 的子集** |
| `cacheWriteTokens` | 输入中写入缓存的 Token，**是 inputTokens 的子集** |

按 **每次实际模型请求** 的 Pi Usage 归一化：

```text
requestInputTokens = usage.input + usage.cacheRead + usage.cacheWrite
requestOutputTokens = usage.output
requestTotalTokens = usage.totalTokens

runInputTokens   = Σ requestInputTokens
runOutputTokens  = Σ requestOutputTokens
runTotalTokens   = Σ requestTotalTokens
sessionInputTokens  = Σ runInputTokens
sessionOutputTokens = Σ runOutputTokens
sessionTotalTokens  = Σ runTotalTokens

sessionCacheReadTokens  = Σ usage.cacheRead
sessionCacheWriteTokens = Σ usage.cacheWrite
cacheHitRate = sessionCacheReadTokens / sessionInputTokens
```

- **缓存读写不再次加到 `totalTokens`**：它们已经包含在 `inputTokens`。`reasoning` 属于 output 子集；`cacheWrite1h` 属于 cacheWrite 子集，都不能重复加总。
- `usage.totalTokens` 有时与拆分字段求和存在 Provider 口径差异，应保留原值、在诊断中标识差异，而不是偷偷改写；UI 不应承诺所有 Provider 满足绝对等式。
- **不单独计算用户 Prompt 文本自身的 Token**。例如用户输入“继续”，但模型请求包含历史、预设、世界卡和工具时，统计的是该次真实请求的全部输入 Token；同一 Run 发生多次模型请求时重复发送的上下文会按每次实际消耗累加。
- `cacheHitRate` 是由会话累计字段**派生**的比例，不另建业务维度或存储百分比。分母为零或 Provider 缓存信息不可靠时返回 `null`，不能把未知伪装为 0%。
- 只有有效 `Usage` 才加到数值；无 Usage 的请求应保留内部完整性标识，不能当 0 Token。模型连接测试 `PiGateway.verify()` 不属于 Session Run，不纳入 Session 累计。

### 1.2 最新上下文占用（最近主生成输入快照）

**不是累计值，也不是对整个 Session 历史消息文本求和。**

```text
latestContextTokens = 最近一次 generation / continuation 请求的
                      usage.input + usage.cacheRead + usage.cacheWrite
contextWindowTokens = 该请求实际所用模型的 contextWindow
contextRatio = latestContextTokens / contextWindowTokens
```

当前主生成上下文的内容通常包括：

```text
预设 / 世界卡 / 系统内容
+ 历史压缩摘要（如有）
+ 压缩位置之后保留的历史聊天消息
+ 本轮用户输入
+ 工具定义、动态状态与其他运行时上下文
```

- **历史压缩边界必须遵守**。SR 现有 `ContextManager.prepare()` 按 `compaction` 的 `coveredThroughEntryId` 找到覆盖位置，使用摘要和覆盖位置之后的历史构建主模型上下文；统计直接取**压缩后主模型请求**的实际 Usage，不能把被摘要替代的旧历史重新算入最新上下文。
- 若历史摘要自身调用了模型，该摘要请求的 Token **计入 Session 累计消耗**，但**不覆盖最新主生成上下文快照**。
- `state_review` 隐藏检查的单独小 Prompt 也不能替代最新主生成上下文快照。
- 工具续写属于主生成链路，后续真实调用会更新快照；切换会话模型或世界线后，如尚未有新的对应请求，应标记快照 `stale` 或显示上次请求信息，不能套用新模型窗口。
- 这是**上一次实际请求时的输入快照**，不是“下一轮发起前”的精确预测。它不包括本次请求后来生成的输出 Token，也不表示预留输出额度后的安全可用空间。

**示例**：上一次主生成用了 12K 输入；本次 Run 为压缩调用消耗 10K 输入，随后压缩后的主生成用了 4K 输入。本次 Run 的输入累计至少 14K，最新上下文占用是 **4K**，此前 12K 消耗不会被扣除。

## 2. 数据存储：只新增两个字段

### 2.1 `entries.metrics_json`：一次模型调用的明细与一次 Run 的汇总

```sql
ALTER TABLE entries ADD COLUMN metrics_json TEXT
  CHECK(metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json)='object'));
```

**按 Entry 类型采用不同结构，不添加 `version` 字段，兼容变更通过 SQLite schema migration 管理。**

- **Assistant Entry**：`metrics_json` **直接是单个请求对象**，无需 `requests[]`。当前 `AgentRunner` 的每次完成的模型响应通常对应一个 Assistant Entry，工具续写会生成另一个 Assistant Entry。独立请求 ID 防止重复归属。
- **Compaction Entry**：因为一次压缩可能使用 N 次摘要模型请求，`metrics_json` 可以保存 `{ "requests": [...] }`；它们都参与 Run 累计。
- **User Entry**：`metrics_json` 保存 `{ "run": { ... } }`，只记录本轮汇总及运行诊断，不额外统计用户输入文本自身的 Token。**User Entry 汇总不能再与 Assistant/Compaction 明细相加**。
- **ToolResult / 其他 Entry**：没有独立模型调用时 `metrics_json=null`。
- `entries.payload.message.usage` 中已有的原始 Pi 信息继续保留，`metrics_json` 是归一化后的统计信息；不能把两份数据重复计入 Session。
- Partial 与最终 Assistant 可能形成多个 Entry 时，一个模型请求必须只有**唯一主归属 Entry**。无有效最终 Usage 的请求标记 unknown，不填 0。

Assistant Entry 示例：

```json
{
  "requestId": "model-request-1",
  "phase": "generation",
  "modelId": "example-model",
  "usageStatus": "reported",
  "inputTokens": 10000,
  "outputTokens": 800,
  "totalTokens": 10800,
  "cacheReadTokens": 7000,
  "cacheWriteTokens": 0,
  "timing": {
    "firstTextMs": 420,
    "durationMs": 2800
  },
  "contextWindowTokens": 128000
}
```

User Entry `metrics_json` 示例，表明它是汇总而非另一条模型请求：

```json
{
  "run": {
    "runId": "run-1",
    "status": "completed",
    "accounted": true,
    "inputTokens": 10000,
    "outputTokens": 800,
    "totalTokens": 10800,
    "cacheReadTokens": 7000,
    "cacheWriteTokens": 0,
    "unknownRequestCount": 0,
    "timing": {
      "firstVisibleTextMs": 1250,
      "totalDurationMs": 4500
    }
  }
}
```

注意：`timing` 是可选的运行诊断，并非 Session 的第三个统计维度，平台首版不必展示。

### 2.2 `sessions.usage_json`：只暴露两组业务统计

```sql
ALTER TABLE sessions ADD COLUMN usage_json TEXT NOT NULL DEFAULT
  '{"cumulative":{"inputTokens":0,"outputTokens":0,"totalTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"latestContext":null,"pendingRun":null}'
  CHECK(json_valid(usage_json) AND json_type(usage_json)='object');
```

正常完成一轮后的示例：

```json
{
  "cumulative": {
    "inputTokens": 250000,
    "outputTokens": 32000,
    "totalTokens": 282000,
    "cacheReadTokens": 80000,
    "cacheWriteTokens": 15000
  },
  "latestContext": {
    "inputTokens": 4000,
    "contextWindowTokens": 128000,
    "modelId": "example-model",
    "runId": "run-1",
    "requestId": "model-request-1",
    "stale": false
  },
  "pendingRun": null
}
```

- **`cumulative` 与 `latestContext` 是唯一两个业务展示维度**。`pendingRun` 是服务端**内部恢复与幂等暂存区**，不是第三类指标，正常 Run 结束后为 null。
- 不在 Session 中再存 `lastRun`、`performance`、`cache` 之类平行业务统计对象。缓存读取和写入已经包含在 `cumulative`，缓存命中率从中计算。
- `latestContext.inputTokens` 同样包含缓存输入，最新一次请求的模型/窗口信息一起保存，便于切换模型后的快照识别。
- Session 累计统计全 Session 所有分支产生的真实请求；最新上下文则是最后一次相关请求的快照，切换分支时需结合 `run_id` / 祖先信息标记是否适用。
- 如果原有 Session 没有统计历史，新增字段中的 0 表示**新功能启用后归集的累计初始值**，不能伪称旧历史已被完整统计；如果旧 `payload.message.usage` 可可靠回填，应提供独立的迁移/重建逻辑或展示“历史未统计”提示。

## 3. Run 完成后的统计过程

**User Entry / Assistant Entry / Compaction Entry 是明细与归集锚点，`RunPostProcessor` 负责将一轮数据纳入 Session 累计。**

```text
玩家提交 Prompt
  → AgentRuntime 接受有效 Run、分配 runId
  → sessions.usage_json.pendingRun 记录本轮元信息
  → ContextManager.prepare()
      └─ 如有摘要：每个模型请求结束即暂存 Usage 到 pendingRun
      └─ 成功创建 Compaction Entry 后写 metrics_json.requests[]
  → 创建 User Entry
  → AgentRunner 生成与工具续写
      └─ 模型请求结束时写 Assistant Entry.metrics_json（单个请求对象）
      └─ 隐藏 state_review 同样计入请求明细
  → 统一 RunPostProcessor（completed / failed / stopped）
      └─ SELECT entries WHERE session_id=? AND run_id=?
      └─ 汇总 Assistant 对象 + Compaction.requests[] + 尚未挂 Entry 的 pending 请求
      └─ 按 requestId 去重；累计 input/output/total/cacheRead/cacheWrite
      └─ 得到本 Run 最新 generation/continuation 上下文快照
      └─ 一个 SQLite 事务内：
           ① 写 User Entry.metrics_json.run（若有 User Entry）
           ② sessions.usage_json.cumulative += 本 Run 消耗（仅一次）
           ③ sessions.usage_json.latestContext 更新
           ④ 清理 pendingRun，设置本轮 accounted 标记
  → 提交成功，再发送平台 usage.updated 和 Run 终态事件
```

### 3.1 稳定性原则

1. **Run 结束才更新 Session 累计，但不是结束才第一次保存 Usage**。每次 Provider 返回 `done.message.usage` / `error.error.usage` 时，就将指标持久化至 Entry；若还没有可用 Entry（例如摘要阶段、报错、取消），先存入 `pendingRun`。没有 Usage 的请求记录为 unknown。
2. Session 当前只允许一个活动 Run，但仍要通过 `runId` / 用户 `requestId` 校验 `pendingRun` 归属，新的 Run 不得覆盖尚未结算的旧 Run。
3. **幂等封账**：`RunPostProcessor` 在同一个 SQLite 事务内检查 `pendingRun.runId` 和 User Entry 的 `accounted` 标志，更新 Session 累计并清空 pending；相同 Run 重试不能加两次。无 User Entry 的失败 Run 也必须有可靠的一次性结算标识，不能仅依赖 `User Entry.accounted`。
4. **进程异常中断**：启动时 `recoverInterrupted()` 将未结束的 Run 标记 interrupted，用持久化的 Entry 与 `pendingRun` 重建已报告用量并封账；没有已知 Usage 不能补 0，总耗时未知不能按重启时刻推断。
5. **准备阶段失败**：摘要请求可能发生在 `RunStore.startRun()` 写 User Entry 之前，已报告用量必须仍计入 Session；无 User Entry 时不创建虚假的 Assistant 消息。为了实现仅两张表的取舍，异常无 Entry 的详细审计不保证无限期保留，但已入账的 Session 累计不得丢。
6. **聚合可恢复**：有 User Entry 的成功 Run 可从 `metrics_json.run` 重算；无 User Entry 的异常 Run 若已入账不能被“全量重算”随意丢掉，需保留最小的异常结算元数据或明确禁止不完整重建覆盖 Session 累计。不得通过重新扫描聊天正文计算 Token。
7. **世界线与压缩**：Session 累计不随着历史删改/分叉而减少。最新上下文应排除摘要覆盖的旧消息；如切换分支导致旧快照不适用，返回 `stale` 或等待新一次模型请求。
8. **不重复累加缓存**：总输入=普通输入+缓存读+缓存写；总输出已含 reasoning。任一 Provider 缓存信息不可靠时缓存命中率返回未知，而非伪造 0%。

### 3.2 统一运行后置处理

```ts
interface RunPostProcessor {
  process(runId: string, outcome: 'completed' | 'failed' | 'stopped'): Promise<void>;
}
```

- `AgentRuntime` 统一调度，覆盖准备失败、模型成功、失败、停止等所有终态；不能只依靠 `AgentRunner` 正常结束路径。
- 核心步骤：读取本轮 Entry 与 Pending 请求 → 请求去重 → 汇总 Token 与缓存 → 更新当前上下文 → 原子写回 User Entry 与 Session。模型请求级/Run 级 timing 可写在 Entry 用于诊断，但**不更新 Session 第三维度**。
- 可选后置 Hook 预留未来诊断/审计扩展，失败隔离，不能让辅助能力影响已完成的真实叙事状态；核心数据提交失败要可观测、可恢复。
- 先提交数据库，再发布 `usage.updated` SSE；SSE 不提供持久回放。运行时锁在 `finally` 释放，不得因统计异常永久占用 Session。

## 4. 平台 API 与显示

保留 `GET /api/v1/sessions/:id/usage`，只返回两组业务数据及必要完整性信息：

```json
{
  "code": "OK",
  "data": {
    "cumulative": {
      "inputTokens": 250000,
      "outputTokens": 32000,
      "totalTokens": 282000,
      "cacheReadTokens": 80000,
      "cacheWriteTokens": 15000,
      "cacheHitRate": 0.32
    },
    "latestContext": {
      "inputTokens": 4000,
      "contextWindowTokens": 128000,
      "ratio": 0.03125,
      "modelId": "example-model",
      "stale": false
    }
  }
}
```

以上为设计示例，非真实数据。

平台 Host 建议只用两组展示：

```text
[累计 282K · 输入 250K / 输出 32K · 缓存命中 32%] [上下文 4K / 128K (3.1%)]
```

- 缓存读写的原始数值（80K / 15K）在累计详情展示；不需要另外新增第三个“缓存统计”大类。
- 正在运行的未结算 Run 不提前增加累计，Host 可保持上次结算值；Run 终态提交后 `usage.updated` 通知刷新。首次进入/SSE 重连通过 GET 恢复。
- 没有任何已知主模型请求时 `latestContext=null`；无法可靠统计缓存或存在未知 Usage 时 API 提供相应完整性提示。
- 首字耗时、Run 总耗时如果以后需要平台展示，可独立设计诊断视图，不混进 Session 的两组核心统计。
- 创作者 iframe 不获得平台 Token 统计 API、`SRSessionAPI` 或 `SRStateAPI` 的额外权限。

## 5. 实施步骤与验收

### P0：存储协议及迁移
- [ ] 新增 `entries.metrics_json` 与 `sessions.usage_json` 两列，**无数据内 version 字段**；SQLite schema migration 负责结构变化，不能清空已有真实用户数据。
- [ ] 约定 Assistant 单请求对象、Compaction 多请求数组、User Run 聚合；为 Session 定义 `cumulative`、`latestContext`、内部 `pendingRun`。
- [ ] 建立可重入迁移、历史缺失用量识别、Session 删除/世界线切换测试。

### P1：请求采集和运行后置
- [ ] 每次 ModelClient 请求采集 Pi 最终 Usage 与可选 timing，确保摘要/主生成/工具续写/隐藏 `state_review` 全覆盖，取消和无 Usage 也记录状态。
- [ ] 在没有对应 Entry 时及时将已报告数据持久化到 `pendingRun`，进入 Entry 后再绑定请求，按 Request ID 去重。
- [ ] `RunPostProcessor` 汇总本轮所有实际请求；User Entry 写 Run 统计；Session 一个事务累计 `inputTokens`、`outputTokens`、`totalTokens`、`cacheReadTokens`、`cacheWriteTokens`，更新最新主生成上下文。
- [ ] 验证重复终态/重复后置、准备阶段摘要失败、Provider 中止、异常重启均不会重复累计或丢失已报告用量。

### P2：API 与平台
- [ ] `GET /api/v1/sessions/:id/usage` 仅两组业务维度：`cumulative` 与 `latestContext`；缓存命中率作为累计派生值。
- [ ] Host 用两组简洁指标显示，SSE 仅在提交完成后发 `usage.updated`；在 375px/1280px 实测布局。
- [ ] 使用 FakeGateway 测试，不接真实付费 Provider；验证统计前后现有 Run、Entry、状态、工具、分叉与摘要行为无回归。
- [ ] 实施阶段运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`。

### 验收情形

| 场景 | 预期 |
| --- | --- |
| 输入“继续”，上下文历史约 1500 Token | Run 输入是模型实际收到的**完整输入**，不只是“继续”，也不只是历史 1500 |
| 1 个 Run 有多个 Model Requests | 所有请求的输入/输出/缓存相加，只计一次；摘要和隐藏请求也包含 |
| 1 个 Assistant Entry | `metrics_json` 是**单个对象**，不是数组，没有 `version` |
| 历史压缩包含 N 次摘要 | Compaction 使用 `requests[]`；摘要耗用记入 Session 累计，但不覆盖 `latestContext` |
| 压缩后主生成输入从 12K 降到 4K | Session 累计仍增长，最新上下文快照更新为 4K |
| 缓存读写非零 | 二者包含在输入内，不能重复加入总量；命中率按缓存读取 / 总输入计算 |
| 失败、取消、停机恢复 | 已报告 Token 尽量持久化；未知用量标记未知；Session 最终只入账一次 |
| 切换世界线/模型 | Session 累计不回退，最新上下文关联上次主调用，必要时 stale |
| 无 Usage 的老数据 | 不编造历史 Token 值；无法补全要告知统计可能不完整 |

## 6. 不在首版做

- 不新建 `runs` / `model_requests` / `run_metrics` 统计表。
- 不单独统计 UserPrompt 文本自身的 Token。
- 不计算费用、价格、Credit、缓存节约金额。
- 不在 Session 中设置独立的性能、缓存第三维度；不做 TPS、P95、跨 Session 性能排行榜。
- 不对下一轮尚未发送的 Prompt 实时精确预测 Token，也不借历史文字长度推算已消耗 Token。

---

**最终标准**：Session 的两个核心统计维度分别回答“整个会话累计消耗多少 Token（输入、输出、缓存读写）”以及“最近一次主生成请求的上下文有多大”；Run 结束后统一、幂等入账，同时保留 Entry 级请求明细与压缩后上下文的准确口径。
