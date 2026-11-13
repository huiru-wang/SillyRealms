# SRRuntime 与 Context v2：实现状态

更新：2026-11-13。实现依据：[架构方案](../../plan/sr-runtime-context-architecture-v2.md)、[任务清单](../../plan/sr-runtime-context-architecture-v2-tasks.md)。代码在 `apps/server/src/runtime/`。本记录描述代码与离线验收，不表示真实用户数据库已升级或付费端点已验证。

## 运行边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| SRRuntime | 会话/世界占用、幂等与 tip 前置检查、冻结配置、分派、取消、私有 finishRun、释放 | SQL、Prompt 编排、模型/工具执行 |
| config.ts / RuntimeConfig | 同步合并平台/预设/会话配置，冻结本轮规则和凭据引用 | 保存明文 key、再次读取运行中配置 |
| ExecutionContext | 固定内容来源/激活权限/状态基准，本轮 workspace、续轮记录、测量与摘要候选 | 充当服务容器、扩大权限 |
| ContextManager | 首次与每次 Agent continuation 的编排、测量、受保护历史压缩、重建重测 | 状态提交、任意工具执行 |
| ModelClient / PiGateway | 最终 payload 预览、计量、fingerprint 校验、单请求事件/取消与真实 Usage journal | Run 最终化、自动修复或模式切换 |
| DirectRunner | 一次 generation，净正文流写入、隐藏扩展尾块、候选结果 | 工具注册、续轮生成、独立计费/提交 |
| AgentRunner | 原有模型—工具循环，每次 continuation 重新准备 Context | 自行最终化、释放锁、复制存储 |
| RunStore / UsageStore | 共用 sessions/entries、同步事务、公开投影、用量幂等结算 | 按模式新建表或数据分支 |

配置在首次 await 之前冻结；world 内容、激活集合与状态基准也在首次异步凭据读取之前固定。key 只在调用局部读取。SDK 或预设更改不能改写已开始的 Run。准备期占用已生效，session GET 可返回 activeRun；创建 user Entry 之前并不承诺持久 Run。

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
| Agent stopped / failed | 保留已落库叙事 | stopped 保存合法 workspace；failed 丢弃 | 不适用 |

finishRun 在最后一次停止检查至同步事务提交之间不 await。RunStore 重查 unfinished、tip、parent chain、基准 hash 和摘要覆盖边界，一次提交终态/状态/合格续轮摘要。事务成功后才通知。重复最终化不重复通知/结算；通知或 Usage 关联失败不改变已提交结果。数据库完全不可用时保留恢复线索，下次启动映射 interrupted。

## 支持的 Provider 与计量范围

生产当前请求测量首期仅覆盖：

- provider `deepseek`、model `deepseek-flash`，目录名称标识 V4.1；
- Pi `openai-completions`、官方 `api.deepseek.com`；
- 文本及 Agent 工具 schema；多模态和其他模型返回 unknown。

Direct 还要求中途 system 保持原位。Pi 1.5.0 的该模型目录缺少标志；适配只对上述官方路径开启，并以官方编码协议和实际 SDK payload 测试为依据，不对其他“OpenAI 兼容”服务泛化。

使用官方 V4.1 tokenizer，离线 BPE 计算最终序列化输入；加 15% 以及消息/工具包装预留。报告质量为 **estimated**，不是精确 chat-template token，也不是 Provider 计费用量；不能保证端点永远不会因窗口溢出拒绝。未知模型明确报 `CONTEXT_MEASUREMENT_UNSUPPORTED`，Direct 顺序不支持时报 `NARRATIVE_SYSTEM_ORDER_UNSUPPORTED`。没有静默回退旧 Usage 政策或自动换模型。

tokenizer 来源/哈希/许可证见 `apps/server/src/runtime/model/tokenizers/README.md`。参考：[官方用量说明](https://api-docs.deepseek.com/quick_start/token_usage/)、[官方 V4.1 编码说明](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/main/encoding/README.md)、[官方 tokenizer 仓库](https://github.com/deepseek-ai/deepseek-recipe/blob/main/docs/tokenizer.md)。离线验证检查真实 SDK payload 的顺序、tools 缺省、fingerprint 与发送一致，未发起付费请求。

## 验证入口与范围

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm test:browser`。根 test/lint 覆盖 Server 及其直接引入的 SDK/Host 契约；build 为 Web。浏览器使用独立 Chrome profile、fake API/SSE 和真实 sandbox iframe。

新增重点：narrative-extensions、direct-runtime、budget-v2、summary-budget、compaction-lifecycle、runtime-config-api、runtime-migration；原有 runtime/usage/state/history/SDK 回归继续运行。浏览器覆盖 375px/1280px、模式与能力设置、建议填草稿/撤销/失效、准备恢复、漏终态恢复和字号滚动锚点。

本次架构范围未实现独立的角色提及匹配 Hook、通用 Skill 执行平台、多 Provider tokenizer 注册、摘要质量在线评测或持久 SSE 重放。对应叙事扩展计划中的其他产品条目不因本次架构完成而自动标记完成。数据升级与回滚说明见 [公开契约与存储](../data-formats/runtime-v2-contract.md)。
