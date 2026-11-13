# SRRuntime 与 Context v2：实现状态

更新：2026-11-13。实现依据：[上下文整理方案](../../plan/sr-context-compaction-strategies-v1.md)、[架构方案](../../plan/sr-runtime-context-architecture-v2.md)、[任务清单](../../plan/sr-runtime-context-architecture-v2-tasks.md)。代码在 `apps/server/src/runtime/`。本记录描述代码与离线验收，不表示真实用户数据库已升级或付费端点已验证。

## 运行边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| SRRuntime | 会话/世界占用、幂等与 tip 前置检查、冻结配置、分派、取消、私有 finishRun、释放 | SQL、Prompt 编排、模型/工具执行 |
| config.ts / RuntimeConfig | 同步合并平台/预设/会话配置，冻结本轮规则和凭据引用 | 保存明文 key、再次读取运行中配置 |
| ExecutionContext | 固定内容来源/激活权限/状态基准，本轮 workspace、续轮记录、准备诊断 | 充当服务容器、扩大权限 |
| ContextManager | Run 准备期一次整理、最终激活；continuation 纯组装 | 状态提交、任意工具执行 |
| ModelClient / PiGateway | 最终 payload 预览、fingerprint 校验、单请求事件/取消与真实 Usage journal | Run 最终化、自动修复或模式切换 |
| DirectRunner | 一次 generation，净正文流写入、隐藏扩展尾块、候选结果 | 工具注册、续轮生成、独立计费/提交 |
| AgentRunner | 原有模型—工具循环，continuation 不再检查额度/压缩 | 自行最终化、释放锁、复制存储 |
| RunStore / UsageStore | 共用 sessions/entries、准备输入表、同步事务、公开投影、用量幂等结算 | 按模式新建表或数据分支 |

配置、world 内容、完整历史来源和状态基准在首次异步凭据读取之前冻结。最终激活集合在整理完成后，仅按摘要＋保留历史＋当前输入确定，再冻结本 Run 权限。key 只在调用局部读取。SDK 或预设更改不能改写已开始的 Run。准备期占用已生效；返回 202 前已在 run_preparations 保存输入和 pending journal，尚不创建 user Entry 或推进 tip。

Direct 与 Agent 共用一条历史。新建会话为 Direct，模式切换不清历史、不回放工具。Agent 中 Direct 的状态/建议开关不参与工具循环。

## Prompt 与 Direct 扩展

Direct 顺序：平台约束 → 风格 → 前置自定义文本（含启用的旧 postHistory）→ 玩家 → 激活角色 → world_info → assistant 摘要及原生历史 → 权威状态与能力规则 → 当前 user 输入。当前输入只出现一次。自定义节点保留 role 和相对顺序；worldState 旧文本保留存储但不再注入 Direct，lore 的旧 anchor/position 保留，Direct 按 load.order / 原索引集中编排。Agent 保留旧布局。

Direct 在一次正常结束的模型响应中接收净正文与唯一的 `<sr_extensions>`。splitter 跨分片识别标签，进入尾块后永久隐藏后续文本，限制 262,144 UTF-8 字节。解析器识别 JSON 字符串内的标签，拒绝重复键、异常层级/框架和多余尾部。纯 narrative 模块不调用模型、工具或数据库。

状态项最多 100 个，按顺序校验激活的 message 根，重复路径顺序处理；global/session 只读。无效项跳过并记录受控错误，reason 只作私有且非阻断的短诊断。建议接受 0–4 条，各 1–120 个 Unicode codepoint，去重与目标数量差异记警告。预设目标数量为 2–4，默认 3。平台默认状态更新开启、建议关闭。

| 结果 | 正文 | 状态 | 建议 |
|---|---|---|---|
| 正常且合法 | 保留 | 提交有效候选 | 发布通过校验的建议 |
| 状态部分有效 | 保留，Run completed | 仅提交有效项，partial | blocked |
| 缺失/无效的必需状态块 | 保留，Run failed | 不提交 | blocked/failed |
| 只有建议失败 | 保留，Run completed | 合法状态照常提交 | failed |
| 外框异常、超限、非正常模型结束 | 保留已确认正文，Run failed | 不提交 | 不发布 |
| Direct stopped | 保留已确认正文 | 丢弃候选 | cancelled |
| Agent stopped / failed | 保存当前已确认正文，保留此前已结束的模型响应 | stopped 保存合法 workspace；failed 丢弃 | 不适用 |

finishRun 在最后一次停止检查至同步事务提交之间不 await。RunStore 在 startRun 事务重查摘要边界/来源并与 user Entry 原子提交；finishRun 重查 unfinished、tip、parent chain 和基准 hash，一次提交终态/状态。没有续轮摘要。状态与终态在事务成功后通知；流式正文事件是明确的内存预览。重复最终化不重复通知/结算；通知或 Usage 关联失败不改变已提交结果。数据库完全不可用时保留恢复线索，下次启动映射 interrupted。

## 正文持久化与查询（2026-11-14）

StoryWriter 为正文预分配稳定 ID，在 RunTask.liveMessage 内累计净文本，只发送带 UTF-16 offset 的临时增量，不创建或更新流式 Entry。Direct 一次响应结束后保存净正文；Agent 每次模型响应结束后保存该响应及工具记录。停止或失败时，当前已确认正文在最终化事务中保存，状态仍按既有失败矩阵处理。数据库写入失败不保证保留临时正文，最终公开结果以持久化内容为准。

输入、摘要提交和 Usage journal 的持久化规则不变。GET 当前 Run 与最新历史页叠加内存正文；更早页只读数据库。准备中的活跃 Run 可作为最新页额外的无消息占位，准备输入不进入历史。重启只恢复已落库记录，未结束正文丢失；浏览器断线不取消后台生成。无需数据库迁移或持久流日志。

新增可见消息寻找最近可见父节点时沿链就近读取并停止，不再为了这一查询加载完整祖先链；准备和最终提交的完整链校验保留。

## 上下文与 Provider 范围

模型配置删除检查引用后，在同步 SQLite 事务内先执行配置 DELETE，再通过 CredentialStore.deleteSync 删除 Keychain 凭据，然后提交，全程不 await。SQL DELETE 失败不触碰密钥；密钥删除失败回滚配置删除。macOS 删除命令最长等待 10 秒，等待期间阻塞当前 Server 进程的事件循环。此改动消除请求交错窗口，不承诺 SQLite 与 Keychain 的跨存储原子性：密钥已删后遇到进程退出或数据库 COMMIT 失败仍有一致性限制。凭据读取和写入仍为异步，公开 HTTP 契约不变。

两策略共享数值配置 max_context_tokens / max_output_tokens。前者至多为模型窗口 80%，并满足输出和 1024 安全预留；100% 触发、60% 目标。每 Run 一次准备，摘要至多一次调用，不分批、不重试；滑窗无摘要调用。提示词等计入完整输入，但只有旧净叙事被摘要/裁剪。合法配置下超目标继续，Provider 硬窗口拒绝为正常失败。详见 [上下文整理](context-compaction.md)。

生产估算采用固定文本/包装规则，支持 Pi 模型目录内的文本请求，不再依赖专用 tokenizer。非文本图片等无法估算时明确失败。可证明完整前缀一致且纯追加时，允许复用真实 reported input；否则全量估算。未知 usage 不伪造成零。

Direct 仍要求中途 system 保持原位，当前只允许声明 supportsMidConvoSystemMessages 的 openai-completions 适配。Pi 1.5.0 的官方 deepseek/deepseek-flash 目录缺少标志；仅对既有官方路径适配，不把顺序保证泛化给全部 OpenAI 兼容服务。顺序不支持时为 NARRATIVE_SYSTEM_ORDER_UNSUPPORTED。

PreparedRequest 始终核验完整请求指纹；具备离线 fetch 注入的 Pi 适配器另核验 wire payload。预览没有网络请求。旧 DeepSeek BPE 资源、计量接口、预算 fits 报告及 @huggingface/tokenizers 依赖已删除；测试直接验证 preview 与发送 payload 一致。DeepSeek 的已验证消息顺序适配独立保留在 PiGateway，不依赖 tokenizer。

## 验证入口与范围

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm test:browser`。根 test/lint 覆盖 Server 及其直接引入的 SDK/Host 契约；build 为 Web。浏览器使用独立 Chrome profile、fake API/SSE 和真实 sandbox iframe。

上下文策略新增重点：compaction-strategies、run-preparation、model-usage-evidence，以及 compaction-lifecycle、summary-budget、runtime-migration。原有 narrative-extensions/direct-runtime/runtime/usage/state/history/SDK 回归继续运行。本次 Server 交付不新增前端配置与重试操作，不执行浏览器/视觉验收；此前架构的浏览器覆盖 375px/1280px、模式与能力设置、建议填草稿/撤销/失效、准备恢复、漏终态恢复和字号滚动锚点。

本次架构范围未实现独立的角色提及匹配 Hook、通用 Skill 执行平台、多 Provider tokenizer 注册、摘要质量在线评测或持久 SSE 重放。对应叙事扩展计划中的其他产品条目不因本次架构完成而自动标记完成。数据升级与回滚说明见 [公开契约与存储](../data-formats/runtime-v2-contract.md)。
