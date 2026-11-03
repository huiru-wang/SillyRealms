# Preset：模型、摘要 Prompt、系统节点和自定义编排

> 2026-11-04 目标设计，未实现。Preset 管理**本局使用的模型、生成参数、状态更新模式、摘要 Prompt 和所有提示词节点**。Session 只保存 preset_id，ProviderService 负责模型目录/API Key，AgentContext 负责实际拼装与筛选。

## 1. 配置归属

- `model`：`provider`、`modelId`、`parameters`，通过 ProviderService 校验当前 Pi 内置模型，**不在 Session 重复保存 model_selection_json**，Preset 导出不得包含 API Key。
- `state_update_mode`：`off / inline / tool`，由 Provider 模型实际能力确认；StateEngine 验证变更。
- `summary_prompt`：用户可编辑的历史摘要指令模板，仅世界卡设置 `context.strategy=summary` 且达到阈值时使用。模板允许通过共享 TextRenderer 读取 `{{state:/...}}`、`{{user}}` 等只读变量与条件，使用当前完整世界状态作为环境。
- `nodes[]`：七个系统节点与任意自定义文本节点，单个有序数组决定角色、启停、先后顺序，不额外保存 order 列。
- `budget`：`max_output_tokens`、`safety_margin_tokens`、`max_input_tokens?`；只做实际模型窗口校验，不额外改变 WorldCard 的上下文策略。
- **不保存 `scan_depth_entries`**：所有 WorldBook、状态根和角色的关键词匹配范围就是经过世界卡 Context 策略处理的**当前实际叙事历史 + 当前 User**。

默认持久化 `builtin/default` 预设可编辑但不可删除；允许复制、新建、导入、导出、恢复默认。配置变更从旧 Session 下一轮开始立即生效，不回写已保存 Entry。

## 2. 七个系统节点

| ID | 本体来源 | 角色规则 | 额外约束 |
| --- | --- | --- | --- |
| `main` | 预设可编辑基础 Prompt | 可选 system/user/assistant | WorldBook 不可挂钩 |
| `personaInfo` | 当前世界卡玩家角色（当前 Session.user_character_id） | 可选 | 支持 WorldBook before/after |
| `characterInfo` | 其它命中的角色，按 order 升序 | 可选 | 支持 before/after；不重复玩家角色 |
| `worldState` | 被激活的状态根的当前值/描述 | 可选 | 状态更新启用时需要；支持 before/after |
| `chatHistory` | 当前 WorldCard 策略得到的 NarrativeProjection | 自动保留 user/assistant 角色 | 必需，无挂钩 |
| `userInput` | 本轮 User 原文 | 固定 user | 必需且恰好出现一次；支持 before/after |
| `postHistory` | 预设可编辑后置 Prompt | 可选 | 默认关闭 |

每个系统节点有固定 `id/source/kind=system`，恰好出现一次，不能重命名 ID 或删除。自定义 `kind=text` 有独立 ID、名称、role、content、enabled，可以在系统节点之间任意拖动排序；不伪装系统 source。`chatHistory` 必须先于 `userInput`，必需节点不能关闭。系统节点本体关闭时，其 WorldBook before/after 仍可按规则注入。

**保留七个独立系统 NodeBuilder**，每个从 WorldBook 的 `anchor/position/order` 索引取得 before 条目 → 拼自身正文 → 追加 after 条目。全部节点构建完后，统一让独立共享 TextRenderer 展开模板。历史消息和当前 User 作为 literal，不二次执行表达式。

## 3. 预设 JSON 示例

~~~json
{
  "schema_version": 1,
  "name": "叙事默认",
  "description": "基础角色扮演预设",
  "model": {
    "provider": "deepseek",
    "modelId": "deepseek-chat",
    "parameters": {"temperature": 0.8}
  },
  "state_update_mode": "inline",
  "summary_prompt": "总结已有剧情、人物关系、重要事件、承诺和未解决线索。当前世界时间：{{state:/世界/当前时段}}。",
  "nodes": [
    {"id":"main","kind":"system","name":"主指令","source":"main","role":"system","enabled":true,"content":"遵循世界设定，连贯推进叙事。"},
    {"id":"personaInfo","kind":"system","name":"玩家角色","source":"personaInfo","role":"system","enabled":true},
    {"id":"characterInfo","kind":"system","name":"其他角色","source":"characterInfo","role":"system","enabled":true},
    {"id":"worldState","kind":"system","name":"世界状态","source":"worldState","role":"system","enabled":true},
    {"id":"custom-style","kind":"text","name":"风格","role":"system","enabled":true,"content":"叙事细致，保持角色一致性。"},
    {"id":"chatHistory","kind":"system","name":"历史消息","source":"chatHistory","role":"auto","enabled":true},
    {"id":"userInput","kind":"system","name":"用户输入","source":"userInput","role":"user","enabled":true},
    {"id":"postHistory","kind":"system","name":"后置指令","source":"postHistory","role":"system","enabled":false,"content":""}
  ],
  "budget":{"max_output_tokens":4096,"safety_margin_tokens":1024}
}
~~~

真实用户可修改模型 ID，示例默认 ID 不代表本机 API Key 已配置或真实可调用；ProviderService 必须在运行时校验。摘要 Prompt 的状态引用仍按只读完整 State 展开，摘要文本来自 user/assistant 叙事，**不包含工具调用或工具结果**；具体流程见 [Context Strategy](context-strategy.md)。

## 4. 存储与领域 API

SQLite `presets` 表：`id TEXT PK, name, config_json, is_builtin, created_at, updated_at`。`config_json` 保存完整 ModelSelection、参数、状态更新模式、`nodes[]`、`budget`、`summary_prompt`，不存 API Key，不设置乐观 revision 矩阵。

领域接口：`listPresets/getPreset/createPreset/clonePreset/updatePreset/deletePreset/importPreset/exportPreset/restoreDefault/getPresetSnapshot`。首期只需验证系统节点唯一、角色合法、必需节点启用和顺序、模型可被 ProviderService 发现、预算合法。摘要 Prompt 由创作者自己编辑，导出时跟随预设。

Preset 不负责 WorldBook 匹配、实际摘要执行、文本模板渲染、状态结算或 Pi HTTP 调用。`getPresetSnapshot` 是 AgentContext 的配置读取口，返回当前有序节点、模型、摘要 Prompt 和预算。

## 5. 验收

- 模型与摘要 Prompt 在 Preset 中可编辑，当前 Session 下一轮读取最新配置；Session 不存模型/参数。
- WorldCard 的 none/window/summary 策略不归 Preset，但 summary_prompt 在 Preset，并支持只读状态引用。
- 七个系统 NodeBuilder 保留，before/body/after 和自定义节点顺序生效，最终统一模板展开。
- 聊天历史节点只展开 user/assistant 叙事，不插入旧工具消息。
- 导入导出不包含密钥，不存在手动条目激活或独立 scan_depth。

相关：[Provider](provider.md)、[AgentContext](agent-context.md)、[Context Strategy](context-strategy.md)、[TextRenderer](text-rendering.md)、[Storage](../technical/storage.md)。
