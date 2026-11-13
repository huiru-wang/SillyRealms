# SR 上下文压缩策略模块 v1 — 实施任务

> 更新：2026-11-13。状态：T1–T8 已完成；Server 离线验收通过。
>
> 唯一设计依据：[技术方案](sr-context-compaction-strategies-v1.md)。80% 模型配置上限、100% 触发、60% 整理目标；摘要单次调用、不分批、不重试；压缩后激活；准备失败保存输入；本期无前端工作。

## 执行约束

- 所有任务由同一 agent 顺序负责，实现后另做独立 review pass；不分派子 agent。
- 先检查工作区、适用 AGENTS.md、相关现状文档与测试；不覆盖无关用户修改。
- 用户后续已明确授权执行代码方案；仍未授权真实数据库迁移、付费调用、提交或推送。
- 不改 Web、Studio、Host、iframe 或 SDK；新增 Server 字段以可选契约交付，不宣称 UI 已接入。
- 临时 SQLite、fake Provider、离线 transport 验证；不访问真实用户数据。

## 任务与依赖

| ID | 任务 | 依赖 | 主要文件边界 |
|---|---|---|---|
| T1 | 统一数值配置、模型上限与兼容规则 | 无 | domain/preset-budget.ts、runtime/config.ts、types.ts、routes/presets.ts |
| T2 | 准备输入持久化与增量迁移 | T1 | database.ts、run-store.ts、usage-store.ts、run-post-processor.ts |
| T3 | 完整历史、预算预览及最终激活分离 | T1 | context-manager.ts、prompt-builder.ts、activation.ts、compaction/history.ts |
| T4 | 固定估算与请求身份解耦 | T3 | compaction/estimator.ts、budget.ts、model-client.ts、pi-gateway.ts |
| T5 | 百分比摘要与滑窗策略 | T3、T4 | compaction/index.ts、types.ts、rolling-summary.ts、sliding-window.ts、summary-generator.ts |
| T6 | Runtime 一次准备、原子交接与终态恢复 | T2、T5 | sr-runtime.ts、run-store.ts、usage-store.ts、runners/*、database.ts |
| T7 | 失败类型、输入查询与重试契约 | T6 | error-codes.ts、run-result.ts、session-runtime.ts、Server 契约测试 |
| T8 | 综合验收、独立复核与现状文档 | T1–T7 | Server tests、相关 docs 与 AGENTS.md |

以上源码路径均相对 `apps/server/src/`；测试相对 `apps/server/test/`。

## T1 — 统一数值配置

- [x] 两策略使用同一 budget 结构，规范结果删除 context_strategy；strategy 只表示算法。
- [x] C 表示完整输入额度，O 表示每次主输出；校验 C ≤ min(floor(0.8W), W-O-1024)。
- [x] 触发 E ≥ C、目标 floor(0.6C)；验证正安全整数及比例边界。
- [x] 实现旧档位输入＋输出窗口到新输入额度的适配、内部来源标记及显式数值的严格校验。
- [x] PATCH 只更新 O、策略切换、混合旧／新字段拒绝、导入导出不丢其他预设内容。
- [x] 明确旧 UI 无法表示任意数值的交付限制；不用伪造档位解决，不扩大为前端工作。

验收：80% 等值与多 1、输出预算收紧、模型切换、旧格式及规范数值往返均确定；输出参数实际进入每次主模型请求。

## T2 — 准备输入与数据库

- [x] 增量增加 run_preparations 表、索引与唯一约束；准备输入不进入 usage_json 或叙事 entries。
- [x] 采用升级前备份、事务迁移、结构与版本校验；明确旧程序拒绝新版本库、备份回滚边界。
- [x] 准备记录和 pending usage journal 同事务创建，输入提交后才允许接受 Run。
- [x] 准备失败保留输入、终态及已结算指标；零调用也有记录，不按 64 条淘汰。
- [x] status／duplicate 可查准备记录；所属会话删除沿用既有明确删除流程清理记录。

验收：临时数据库验证升级失败回滚、原数据完整、超过 64 次失败仍可恢复、并发／重复封账不破坏幂等；旧版缺输入如实标记不可恢复。

## T3 — 历史与激活边界

- [x] 读取当前有效祖先链完整净叙事；区分完整来源、策略可用历史和当前输入。
- [x] 开场 assistant 单独分组；完整 user 回合及工具关联不拆坏；失败准备输入不进入历史。
- [x] 拆出无权限副作用的 previewContext，初始预览仅用于触发和固定费用预留。
- [x] 最终只按选定摘要＋保留历史＋当前输入匹配角色、世界书、状态；保留 never／when／玩家规则。
- [x] 最终匹配完成后创建 active、工具定义、状态可写根及扩展 required；本 Run 内冻结。
- [x] 不从条目自身文本递归激活；状态不激活不等于删除权威值。

验收：仅在被裁原文中的关键词／排除词不生效；保留原文、摘要或当前输入中的可以生效；实际 Provider payload、工具及 Server 状态权限一致。

## T4 — 估算与请求身份

- [x] 固定版本字符／包装估算，统计完整请求；不支持内容明确失败。
- [x] 复用 usage 时证明输入原样覆盖与纯追加；模型、system、状态、激活、工具或历史变换不匹配即全量估算。
- [x] 区分 reported 零值、SDK 默认零对象和 unknown；缓存 input 只计一次，未回填尾块／thinking 不计。
- [x] 主 PreparedRequest 与 fits 报告解耦，保留身份及 wire payload 一致性检查。
- [x] 报告 before／after、预留和实际激活费用差异，不写入真实计费用量。

验收：省略预算报告不会阻止合法主请求，篡改 payload／权限仍被阻止；不依赖模型专用 tokenizer，Direct 顺序限制仍生效。

## T5 — 策略实现

- [x] 单一入口一次触发；用 60% 目标扣除固定预留选择完整连续后缀。
- [x] 滚动摘要保护至少五个近期旧回合；仅覆盖后缀之前连续前缀和旧摘要。
- [x] 一次提交旧摘要和全部选中的待摘要历史；删除分批、切片、12000 codepoint 限制及八次调用额度。
- [x] 完整摘要请求估算超过独立预算则零调用失败；单次请求异常立即结束，不提交部分摘要、不重试、不缩小覆盖范围补救。
- [x] 无收益使用原投影并重新确定其最终激活；有收益但仍超目标继续。
- [x] 滑窗零摘要调用，无永久裁剪水位；实现策略切换及扩大额度后的历史恢复。

验收：摘要请求数只能为 0 或 1；预算内的有效完整请求一次成功，估算超预算零调用失败，Provider 拒绝或结果异常后不再请求摘要／主生成；失败输入和已发生费用保留；保护内容超目标有诊断，历史无遗漏／重复，滑窗不会跳过相邻大回合。

## T6 — Runtime 与原子交接

- [x] 同步预检之后持久接受输入，再冻结来源快照并准备上下文；最终激活后才冻结执行权限。
- [x] 同一 startRun 事务保存合格摘要、user Entry 并移除 preparing 记录，接管输入与幂等身份。
- [x] 最后取消检查至提交不 await；失败回滚后保留输入和原 tip，不发主请求。
- [x] Direct／Agent 首次请求共享准备结果；Agent continuation 纯组装并使用自身 fingerprint。
- [x] 删除 continuation 预算循环、续轮摘要候选／提交及发送 fits 门槛。
- [x] 准备终态、一次用量结算、清 pending 同事务；提交后才通知，重启恢复 preparing 和正式 Run 各自路径。

验收：多工具往返仅一次准备；停止／错误／重启不丢输入或真实费用；交接故障无双重权威记录、不重复通知、不提前推进摘要覆盖。

## T7 — Server 失败及恢复契约

- [x] 增加受控容量／窗口错误；统一 Provider 错误分类，各 runner 不泛化已知错误。
- [x] 公共投影增加可选 failure.stage／type 和 recovery.inputSaved／action；终态 phase 不覆盖失败阶段。
- [x] GET Run 可返回准备输入，messages 保持空；SSE 仅给分类和恢复建议，不附加输入全文。
- [x] 不把用户输入放进错误消息、debug 日志或 Usage API；HTTP／SSE 继续使用既有错误协议。
- [x] 用户读取输入后，以新 requestId 和当前 tip 通过现有 POST 提交；原失败记录保持，重复 requestId 不再次执行。
- [x] 现有客户端可忽略可选元数据；无需新增 SDK 方法或重试 UI。

验收：Server transport 集成测试覆盖零调用配置失败、摘要失败、容量失败、停止、断连与重启；GET／SSE 分类一致，恢复输入仅出现在授权查询，重新提交恰好出现一次。

## T8 — 综合验收与独立复核

- [x] 跑方案 §9 全部验收，尤其百分比边界、最终激活、跨策略大历史和准备输入原子性。
- [x] 检查 package scripts 后执行 `pnpm --filter @sillyrealms/server typecheck`、`pnpm --filter @sillyrealms/server lint`、`pnpm --filter @sillyrealms/server test`，按需要核对根 typecheck 的既有跨层契约。
- [x] 同一 agent 独立复核 diff、API 消费者、迁移与费用路径；修复后只重跑受影响验证。
- [x] 实现通过后更新 context-compaction.md、runtime-context-v2.md、runtime-v2-contract.md、error-protocol-v2.md、AGENTS.md；记录持久存储与配置语义的耐久决定。
- [x] 交付说明已实现 Server 行为、验证结果、旧 UI 编辑限制和未实现前端操作；不把浏览器／视觉测试记为通过。

通过标准：没有关键数据丢失、权限来源偏差、重复计费、重复输入、已知失败被伪报成功或未解释的回归。不得以剩余时间不足将未完成验收标为完成。

## 验收结果

- 根 typecheck（Server/Web）、lint、test、Web build 通过；最终 Server 复验为 46 文件、244 测试通过。Web build 有既有 chunk 体积提示，无构建失败。
- 新增 compaction-strategies、run-preparation、model-usage-evidence；补充 compaction-lifecycle、summary-budget、presets、runtime-migration 等回归。
- 同一 agent 完成独立复核；修正已知 Provider HTTP 错误包装、终态写入失败通知、旧摘要边界和安全原因留存，复验通过。
- 未执行浏览器/视觉验收（本期无前端工作），未迁移真实库、发付费调用、提交或推送。Studio 的并行修改未触碰。
- 新字段仅为 Server 契约。旧档位编辑器和输入恢复按钮未接入，详见技术方案 §10 与现状文档。

### 后续清理：旧 tokenizer 路径

按用户追加指令，删除 model/tokenizers 的词表/许可证/说明、@huggingface/tokenizers 依赖与锁文件记录、旧 BPE measure 接口、Measurement/BudgetReport/fits 检查及 fakeMeasurement 测试桩。保留摘要独立预算、请求身份与离线 payload 预览；DeepSeek 消息顺序适配移至 PiGateway 独立判断。相关回归直接验证 preview/发送一致性和 Direct 顺序。

清理后根 typecheck、lint、test、build 通过；46 个文件、239 项测试通过（移除已删除计量接口的 5 个参数化结果检查）。独立复核确认生产/测试无旧接口残留，锁文件仅删除 tokenizer 记录；未改前端、SDK 或真实数据。
