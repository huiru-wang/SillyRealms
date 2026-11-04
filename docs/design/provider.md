# Provider：模型目录、模型选择与 API Key 服务

> 2026-11-04 精简设计，尚未实现。Provider **仍是独立业务 Domain**，提供用户可见的供应商/模型查询、API Key 管理与模型选择校验；不自行维护每个供应商的 SDK 适配器。**模型目录、认证解析和真实模型调用尽量直接复用 Pi**。

## 1. 职责与非职责

- **ProviderService** 是设置页、Preset 模型配置与 AgentRuntime 的统一业务入口，负责 `listProviders / listModels / getModel / getAvailableModels`、配置/验证/删除用户 API Key、解析可调用的模型选择与能力信息。
- 内置 Provider/Model 集合来自项目锁定版本的 `@earendil-works/pi-ai`（或统一选定的兼容 Pi 版本）。MVP 可以采用应用级**允许列表**决定在 UI 中开放哪些 Pi 内置 Provider；这只是过滤和产品配置，不是为每个供应商编写一套 Adapter。
- API Key 属于用户可管理配置。`ProviderService` 通过应用实现的 `CredentialStore` 持久化凭据，向 Pi 的 `Models` 注入该 Store；私密值不写到 Session、Preset、世界卡、日志或导出内容。
- Provider Domain **不构建 Prompt、不创建 Session/Entry、不负责 SSE、不应用状态 ChangeSet**。PiAgentExecutor 负责调用和事件转发；状态工具与校验归 State Domain。

## 2. 模型与凭据契约

`ModelSelection` 仅保存 `{ provider: string, modelId: string }`，按需另存普通生成参数；`provider` 和 `modelId` 必须以运行时选定的 Pi 模型目录实际值为准。Preset 的 config_json.model 持久化该选择及生成参数；Session 只引用 preset_id，每轮读取当前 Preset 模型。不建 app_settings 表。

模型展示信息直接从 Pi `Model` 映射，尤其将 `contextWindow` 提供给 [Token 预算](context-strategy.md) 作为模型硬上限：`provider`、`id`、`name`、`contextWindow`、`maxTokens`、`reasoning`、`input`、`api` 等（以锁定依赖版本的字段为准）。模型在目录中存在**不代表**已配置 API Key、远端仍可调用或支持当前的状态工具 Schema；因此要区分：

1. **支持的模型**：`models.getModels(provider?)` 可发现，且符合本产品允许列表。
2. **已配置的模型**：`models.getAvailable(provider?)` 根据当前 CredentialStore / 授权上下文筛选；这只是本地认证完整性检查，不等于云端请求成功。
3. **已验证能力**：针对实际 Provider/模型做 SSE、取消、完整 Messages 角色顺序和状态 Tool Call 验证。未验证的不承诺可执行复杂状态工具。

MVP 不允许添加自定义 Provider、Endpoint、Header 或模型定义；没有必要维护 `providers` / `models` 用户表或每供应商文件。

## 3. ProviderService 核心接口

~~~ts
type ModelSelection = { provider: string; modelId: string };

interface ProviderService {
  listProviders(): ProviderSummary[];
  listModels(provider?: string): ModelSummary[];
  getModel(selection: ModelSelection): ModelSummary;
  getAvailableModels(provider?: string): Promise<ModelSummary[]>;
  hasApiKey(provider: string): Promise<boolean>;
  saveApiKey(provider: string, key: string): Promise<void>;
  deleteApiKey(provider: string): Promise<void>;
  testConnection(selection: ModelSelection): Promise<ConnectionTestResult>;
  resolveModel(selection: ModelSelection): PiModel;
}
~~~

全部领域接口的逐项用途见 [领域 API 清单](domain-interfaces.md)。`getModel/resolveModel` 验证模型是否在本产品支持目录内，不返回密钥；`testConnection` 才真实发起最小模型调用，可能产生成本，返回脱敏错误。`hasApiKey` 表示本地凭据存在，不宣称其有效。`saveApiKey` 校验 Provider 支持 API Key，并交给安全凭据存储；无凭据/模型不支持应显式报错，不隐式改选其它模型。

API 建议：

- `GET /providers`、`GET /providers/:providerId/models`：支持的目录和能力、配置状态。
- `GET /providers/available-models`：本地认证完整的模型（非实时云端可用性）。
- `PUT /providers/:providerId/api-key`、`DELETE /providers/:providerId/api-key`：用户 Key 配置/删除，不提供明文读取。
- `POST /providers/:providerId/test`：指定模型、显式执行连接验证。
- 用户在编辑 Preset 时选择模型，创建 Session 时通过 Preset 的模型校验 Provider/API Key；不在 Session 保存模型或参数。

## 4. Pi 复用方式

Fanto 当前使用的 `@earendil-works/pi-ai@0.85.1` 已提供以下 API；正式 SillyRealms 采用哪套版本及与 agent-core/coding-agent 的兼容关系，应先固定并测试，而不是混用实验版本。

~~~ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels({ credentials: credentialStore });
const providers = models.getProviders();
const allModels = models.getModels();
const providerModels = models.getModels("deepseek");
const selected = models.getModel("deepseek", "deepseek-v4-flash");
const available = await models.getAvailable();
~~~

`CredentialStore` 适配 Pi 的 `read/list/modify/delete` 约定，应用实现可以接 OS Keychain/安全密钥存储；通过依赖注入供 Pi 请求时读取。环境变量只作为明确配置的开发/部署方式，生产用户 Key 不默认明文写入 SQLite。

ProviderService 对外使用 Pi 目录，**不重复定义**每个模型的最大上下文、stream 参数、错误转换或 API 协议。确有版本级兼容/允许列表时，可以在一个 `models.ts` 中集中声明薄配置；不建 `openai.ts` / `anthropic.ts` / `deepseek.ts` 等同构适配器。若某内置模型需要 Pi 不支持的差异处理，先验证并记录真实问题，再做最小的隔离修复。

## 5. 与一次 Agent 执行的关系

`runAgent()` 通过 `AgentContext.create(sessionId, parentEntryId, userInput)` 构建本轮消息，`ProviderService.resolveModel` 从 Session 引用的**当前 Preset** 解析模型与凭据；`PiAgentExecutor` 负责调用与 SSE 转发。是否开启状态 Tool 由本轮 Session/状态配置和已验证的模型能力共同决定，ProviderService 只提供查询与校验信息。

**已知限制**：SillyRealms 在 2026-11-01 对 `@earendil-works/pi-coding-agent@1.4.0` 的离线 mock 实测发现：`prepareRequest` 可以覆盖发送的 Messages，但 OpenAI-compatible 路径会把历史后方的 `system` 节点规范化到头部。`session.prompt(text)` 也不能直接当成「接受完整任意数组」的 API；正式实现必须以实际 HTTP 请求为准验证 role/order、避免重复追加当前 User。必要时使用受支持的更底层 Pi Agent / Pi AI 接口，**不静默重排**。参考 [实验报告](../../experiments/pi-sdk-feasibility/REPORT.md)。

## 6. MVP 验收

- 列表直接映射 Pi 支持的模型，允许列表与 SDK 升级行为明确；未知模型拒绝。
- API Key 可以安全保存、覆盖、删除、显示「已配置」和显式测试；接口/日志不回显敏感值。
- `getAvailableModels` 不把认证完整误称远端健康；状态工具能力必须在模型级经真实 PoC。
- Preset 保存 provider/model ID 与参数；Session 只保存 preset_id，下一轮从最新 Preset 重新解析模型和当前凭据。
- 不存在按 Provider 重复实现模型 HTTP/stream 适配或第二套模型目录。

相关：[技术架构](../technical/architecture.md)、[AgentContext](agent-context.md)、[Session](session.md)。
