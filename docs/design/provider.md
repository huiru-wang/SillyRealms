# Provider：预置模型供应商与 Pi Agent 适配

> 2026-11-03 产品/领域/架构设计，尚未实现。Provider 与 Preset 完全分离：本模块只管预置 Provider、模型选择、API Key 及 Pi 调用适配；AgentContext 仅返回已编排好的 Messages，不持有连接、凭据或 Provider 实例。Pi SDK 当前文档的执行能力可参考 [官方 SDK](https://pi.dev/docs/latest/sdk) 与 [Provider](https://pi.dev/docs/latest/custom-provider)；具体版本、完整消息顺序与状态工具兼容必须真实 PoC。

## 1. 产品体验

MVP **不允许用户创建 Provider、编辑 API Base URL、编写 Header 或自行添加模型提供商**。设置页：选择内置 Provider → 选择该 Provider 的模型 → 输入 API Key → 保存/验证 → 将所选模型设置为默认或当前 Session 使用。只显示经过当前适配版本验证、可调用的模型；不可用模型明确标注，不自动选择其它供应商。Provider 列表由应用随版本发布的**静态声明文件**决定，不需要 `providers` 数据表。

候选首批内置提供商包括 OpenAI、Anthropic、Google Gemini、DeepSeek 等 Pi 已支持的供应商；最终启用名单以真实 API/流式/工具 PoC 和当前 SDK 支持为准。模型 ID、上下文长度和支持能力不在这份设计里硬编码为永久事实。

## 2. 领域对象与配置

- `ProviderDefinition`：`id`、`displayName`、`piProviderId`、`authMode=api_key`、`models[]` / 从固定 Pi 目录筛选规则、`capabilityProfile`、`adapterKind`。内置声明不可被用户改写。每个 Provider 是独立的内部模块/适配配置，不能把 Provider 分支散落在 Session/AgentContext 中。
- `ModelDefinition`：稳定 `providerId/modelId`、展示名称、上下文窗口、输出上限、tool/structured-output 能力标记、能力检测来源及更新时间。来源优先固定版本 Pi model registry 和产品验证白名单；升级时可刷新，但展示与本轮执行必须冻结一致的实际模型定义。
- `ProviderCredential`：`provider_id`、`credential_ref`、`updated_at`、`last_test_result?`。API Key 不出现在 Provider JSON、Preset、世界卡、Prompt、日志、Session 导出。凭据默认放 OS 安全凭据存储；如不得不使用数据库，必须有明确密钥加密/文件权限策略，不能在 SQLite 中明文存储。
- `ModelSelection`：`provider_id`、`model_id`、`generation_options?`。全局默认可保存到应用设置；一个 Session 可保存自身选择，优先于全局。**不属于 Preset**。运行中按调用冻结，模型切换只影响下一 Run。

内置声明文件（示意，具体 ID 与启用型号由版本化模型目录确定）：

~~~json
{
  "catalog_version": 1,
  "providers": [
    {"id":"openai","display_name":"OpenAI","pi_provider_id":"openai","auth_mode":"api_key","adapter_kind":"openai"},
    {"id":"anthropic","display_name":"Anthropic","pi_provider_id":"anthropic","auth_mode":"api_key","adapter_kind":"anthropic"},
    {"id":"deepseek","display_name":"DeepSeek","pi_provider_id":"deepseek","auth_mode":"api_key","adapter_kind":"deepseek"}
  ]
}
~~~

用户通过 `listSupportedProviders()` 和 `listModels(providerId)` 得到受支持的模型集合，而非任意输入模型名。未通过验证的新模型不会仅凭远端目录变化就自动开放核心功能。

## 3. Pi 适配架构

~~~mermaid
flowchart LR
  SessionService --> AgentContext
  AgentContext -->|Messages| AgentExecutor
  SessionService -->|ModelSelection| ProviderRegistry
  ProviderRegistry -->|Model + CredentialRef| ProviderAdapter
  AgentExecutor -->|Messages + ExecutionOptions| ProviderAdapter
  ProviderAdapter -->|Pi SDK/AI| ProviderAPI
  ProviderAdapter -->|Normalized Stream/Result| AgentExecutor
~~~

代码边界建议：`ProviderRegistry`（静态目录/实例解析）、`CredentialStore`（密钥读写/测试）、`ProviderAdapter`（某 Provider 的模型映射/差异）、`PiAgentExecutor`（统一执行生命周期）、`ModelCapabilityResolver`（返回模型限制，供编排层使用中立 BudgetLimits）。

- 每个内置 Provider 有独立适配单元（或独立注册实现），统一实现 `listModels`、`resolvePiModel`、`validateKey`、`normalizeGenerationOptions`、`supportsSubmitTurn`、`execute` 能力。平台特有参数、strict Tool Schema 子集、推理 token 参数、流式事件、错误码、限速/重试策略在 Provider 内消化。
- 共性执行器负责可取消的一次模型生成、统一 SSE 事件与成功/失败结果、终止回收；保留 Pi 的模型消息、usage、tool 生命周期，**禁用默认 coding tools、工作目录自动发现技能和外部副作用**。只有经验证的 SillyRealms 状态提交工具可按生成模式注册，不允许模型获得 shell/文件执行工具。
- `AgentContext.build()` 返回**真正有序的**中立 `ModelMessage[]`。Pi 适配必须测试如何在内存 Session/受控上下文中无损注入这些消息并保持 role/order；不能假设 `session.prompt()` 可直接接收完整任意角色数组，也不可以静默把所有内容塞到一个 system prompt 伪装等价。若当前 Pi 公共 API 不满足，先记录阻塞并考虑 Pi 提供的受支持底层执行接口，**不双写 Pi JSONL 和 SQLite**。
- 一次用户 Run 的模型调用在成功前不应在持久化数据库创建 AI 占位消息；内部 Pi Session /流式 token 是执行态。Provider 使用明确的 ModelSelection 与 CredentialRef，不读取 Preset 或 WorldBook。

## 4. 统一执行契约

~~~ts
type ModelExecutionInput = {
  messages: ModelMessage[];         // AgentContext 已完成的有序消息
  model: ModelSelection;            // Session/全局选择
  generationOptions: GenerationOptions;
  stateOutputContract?: StateOutputContract; // 状态模块生成的工具约束，非 Provider 自行决定业务
  requestId: string;
  abortSignal: AbortSignal;
};
type ModelExecutionResult = {
  narrative: string;
  stateChangePayload?: unknown;     // 待状态引擎校验
  usage?: TokenUsage;
  finishReason: string;
  diagnostics: ProviderDiagnostic[];
};
~~~

`ProviderRegistry.execute(input)` 输出统一事件 `started / text_delta / tool_delta / usage / completed / failed / cancelled`，返回上述结果。Provider 必须规范化平台格式差异和错误，且流式片段**不代表可以提交的最终消息或状态**。错误类型至少区分凭据无效、限额、速率限制、网络/超时、模型不支持、工具/格式错误、取消；重试仅对幂等且安全场景自动尝试，不在同一 Run 上重复提交变更。

### 状态工具策略

状态引擎给出 `StateOutputContract`，包含本轮可写目标及受限 ChangeSet；Provider 声明 `submit_turn` 结构化工具及长文本流式的**实测**支持情况。`tool` 模式需验证单次请求能获取叙事与状态；`inline` 模式保持正文流式并解析尾部 `<StateUpdate>`。Provider 仅负责把平台执行结果规范化，不负责解释状态业务、修改 Snapshot、跳过校验或决定“灵力应该减少多少”。模型缺乏严格工具支持时，可选择内联回退但不降低服务端强类型校验。用模型/适配版本记录能力，未知视为不支持。

## 5. 存储、接口和安全

建议 `provider_credentials`：`provider_id` 主键、`credential_ref`、`updated_at`、`last_verified_at` 可空、`status`；`app_settings` 只保存 `default_model_selection_json`，`sessions.model_selection_json` 保存本局模型选择；**不建用户自定义 providers/models 表**。模型目录为代码/只读资源与可丢弃缓存。

逻辑接口：`listSupportedProviders()`、`listModels(providerId)`、`saveApiKey(providerId, key)`、`testConnection(providerId, modelId)`、`deleteApiKey(providerId)`、`getDefaultModelSelection() / setDefaultModelSelection()`、`resolveExecution(modelSelection)`；API Key 不通过读取接口回显，UI 只拿 `configured: true/false`、尾部脱敏提示和验证状态。

安全：私有密钥服务端使用，禁止客户端持有明文；不允许 Provider 声明执行任意脚本、URL 或第三方插件；HTTP 请求必须使用可信内置 Endpoint/SDK，日志屏蔽密钥及原始个人聊天内容；网络连接失败不得修改 Run/State。

## 6. 验收和延期

- 用户只能选内置 Provider/模型并提供 API Key；不能创建自定义 Provider 或 Base URL；无凭据无法静默执行。
- 不同 Provider 在统一事件流和 Message 角色顺序契约上有可重复的真实测试；Provider 失败不会把 Run 结算为成功。
- 真实验证 Pi 模型映射、API Key 隔离、取消、流式、长输出、工具支持和状态提交差异；没有证据不声称已支持。
- Preset 和 AgentContext 不含 providerId/modelId/apiKey；模型的 Context 容量通过中立 `BudgetLimits` 输入，具体映射留在 Provider 层。
- 订阅 OAuth、OpenAI-compatible 自定义 Endpoint、用户注册新 Provider、多个账号轮换、模型自动切换等延后。

相关：[Preset](preset.md)、[AgentContext](agent-context.md)、[技术架构](../technical/architecture.md)、[存储](../technical/storage.md)。
