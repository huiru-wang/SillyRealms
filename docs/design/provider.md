# Provider：模型目录、API Key 与连接测试

> **职责与权威范围**：模型目录、凭据与 Provider 接口约定的权威来源；未经 PoC 验证的行为不视为已支持。

> 2026-11-04 目标方案，未实现。ProviderService 面向**设置页配置 Provider、预设页选择模型、AgentRuntime 解析模型**这三条链路；只统一产品操作，不复制 Pi SDK 已存在的模型定义和 API 协议。

## 1. 用户在产品里怎么使用

1. **设置页**调用 `listProviders()`：展示内置可选供应商，以及每个供应商的 `credentialConfigured: boolean`。仅展示本地已配置与否，不展示 Key 原文、不承诺网络连通。
2. 用户选择供应商，调用 `listModels(provider)`：展示名称、上下文窗口 `contextWindow`、输出上限 `maxTokens`、模型能力、是否已配置本地凭据。用户可以浏览模型，不要求先保存 Key。
3. 用户保存或清除 Key，分别调用 `saveApiKey` 和 `deleteApiKey`；只有点击“测试连接”时，`testConnection` 才会真实访问模型服务，可能产生费用。
4. **预设页**把 `{provider, modelId, parameters}` 写入 Preset，不重复保存 Key。模型在列表里可发现但缺 Key 时可保存配置，实际调用时明确提示。
5. **运行时**调用内部 `resolveModel(selection)` 校验 Pi 目录、当前凭据和模型参数，不允许静默改选其他模型；调用/stream/SSE 交给 PiExecutor。

### 服务签名与职责

~~~ts
type ModelSelection = { provider: string; modelId: string };

interface ProviderService {
  listProviders(): Promise<ProviderSummary[]>; // Provider + credentialConfigured
  listModels(provider: string): Promise<ModelSummary[]>; // Pi 目录、上下文/输出硬上限及当前可用认证标记
  saveApiKey(provider: string, key: string): Promise<void>; // 安全保存/覆盖
  deleteApiKey(provider: string): Promise<void>; // 删除凭据，不修改 Preset
  testConnection(selection: ModelSelection): Promise<ConnectionTestResult>; // 用户明确触发真实最小请求

  // Runtime 内部依赖，不是 HTTP 公开查询：
  resolveModel(selection: ModelSelection): Promise<ResolvedPiModel>; // 验证支持、解析认证与 Pi Model
}
~~~

**删除独立的 `hasApiKey`、`getModel`、`getAvailableModels`**：配置状态已经通过 `listProviders/listModels` 返回；目录元数据不需要第二个 `getModel` 包装，`resolveModel` 是运行时唯一校验入口。不能把“已配置 Key”或“目录存在”冒充“模型在线且能力已验证”。详细调用关系见 [领域 Service](domain-interfaces.md)。

## 2. 依赖和数据归属

- 仅开放当前选定版本 `@earendil-works/pi-ai` 的内置 Provider / Model，MVP 可有轻量允许列表，不允许用户自定义 Endpoint/Provider/Header；不建 `providers` 或 `models` 业务表。
- `ModelSummary` 直接从 Pi Model 映射 `provider / id / name / contextWindow / maxTokens / reasoning / input` 等所选版本确实支持的字段；对外模型可选，不代表会通过实际工具调用验证。
- 使用应用的 `CredentialStore` 适配 Pi `read/list/modify/delete`。用户密钥只保存在安全凭据存储中；`provider_credentials` 最多保存凭据引用，不保存密钥明文。用户关闭密钥后所有使用该供应商的 Preset 保留 ID，下次运行失败并提示配置。
- API Key 和 Provider 目录与 WorldCard/Session 解耦；Session **只关联 preset_id**。每次 Run 读取当前 Preset 模型选择，`resolveModel` 确定实际 Model 和凭据。
- 任何连接失败应返回脱敏错误，日志和导出不包含密钥；测试才发生真实远程请求，平时查询配置状态不产生费用。

## 3. Pi SDK 复用与验证

Fanto 使用的 `@earendil-works/pi-ai@0.85.1` 已有内置模型目录与 CredentialStore 对接能力：

~~~ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels({ credentials: credentialStore });
const providers = models.getProviders();
const list = models.getModels("deepseek");
const model = models.getModel("deepseek", "deepseek-v4-flash");
~~~

上面展示的是**Pi 的内部复用方法，不是 ProviderService 需要照搬的全部外部接口**。正式依赖锁定时核实函数签名，不要与不同版本 pi-agent-core / pi-coding-agent 混用。只有真实协议差异在 Pi 无法解决时才考虑单个小型适配，不预建 `openai.ts/deepseek.ts/anthropic.ts` 等一系列重复文件。

已知的 SDK PoC 风险：OpenAI-compatible 模型可能把后置 system 重排；`session.prompt(text)` 也可能自动添加 User。正式实现需在 HTTP 层验证最终请求的 role/order、tool calling、SSE 与取消，确保本轮 User 恰好出现一次，不能误把 SDK 方法名当成可任意输入 ModelMessage[] 的签名；原本地实验记录当前不可用，相关行为应重新通过 PoC 验证。

## 4. 与 Token 预算的关系

用户只能在 Preset 设置 `max_context_tokens` / `max_output_tokens`；Provider 的 `contextWindow` / `maxTokens` 是不可突破的硬上限。内部 Token 估算误差余量由 AgentContext 实现持有，不是用户设置，也不是 ProviderService 公开 API。[Context Strategy](context-strategy.md) 给出裁剪规则。

## 5. 验收

- 设置页能列出供应商、模型能力和本地配置状态；Key 可安全写、替换、删除且不会泄漏。
- “测试连接”与“已配置”明确区分；测试由用户显式触发。
- 预设模型选择只有 provider/modelId；运行时验证失败明确报错，不偷偷切换模型。
- 不在 ProviderService 维护第二套模型目录或每个供应商的重复 HTTP 适配。
