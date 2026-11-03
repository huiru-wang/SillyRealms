# Preset：提示词预设、节点模型与编排配置

> 2026-11-03 目标设计，未实现。本文件是 **Preset 领域唯一规范**：只管配置模型、导入导出、持久化及向 AgentContext 提供不可变编排快照。**不负责**节点内容构建、世界书命中、变量替换、Token 裁剪、模型调用与 API Key。构建规则见 [AgentContext](agent-context.md)，模型连接见 [Provider](provider.md)。

## 1. 产品体验与边界

Preset 是可复用的“**模型输入编排清单**”，而非完整 Prompt 文本。创作者可查看、复制、编辑、导入、导出和选择预设；在一个有序列表中编辑各节点的标题、Prompt、角色、启用状态并拖动排序。界面明确区分 **系统节点（有稳定来源，内容由系统构建）** 与 **自定义文本节点（作者直接编辑 Prompt）**，并提供最终编排顺序、角色和预算规则预览。编辑 Preset 不直接改变既有 Run/Message。

首期提供一个持久化预设 `builtin/default`：**不可删除、不可改 ID，但可修改标题、节点顺序、内容、角色及预算**。恢复出厂配置须显式确认，不能在启动、升级或模型切换时自动覆盖用户修改。用户可复制、新建空预设（自动生成七系统节点）、从 JSON 导入预设。选择模型/API Key 属 Provider/Session，不写入 Preset。

## 2. 领域对象及不变量

`Preset`：`id`、`name`、`description?`、`schema_version`、`is_builtin`、`revision`、有序 `nodes[]`、`budget`、`scan_depth_runs`、时间信息。`revision` 用于乐观并发更新；导出的 schema_version 是文件**格式版本**，不同于预设修订号。

`PresetNode` 分两种：

| 字段 | 系统节点 `kind=system` | 自定义 `kind=text` |
| --- | --- | --- |
| `id` | 固定系统 ID | 预设内稳定唯一 ID（随机生成） |
| `name` | 可编辑展示名称 | 必填可编辑名称 |
| `role` | `system/user/assistant`，部分系统节点固定 | `system/user/assistant` |
| `enabled` | 可编辑，但必需节点不能关闭 | 可编辑 |
| `content` | 只允许 `main` 和 `postHistory` 声明可编辑基础文本；其余由 AgentContext 构建 | Prompt 正文，允许变量/状态只读模板 |
| `source` | 固定为系统 slot，与 id 一一对应 | 不提供 |
| `order` | **不存在**独立排序值；位置完全由 `nodes[]` 决定 | 同左 |

七个系统节点**每个恰好出现一次**，不得删除、复制、改 ID、改 kind 或改 source：

| ID | 本体来源 | 角色约束 | 配置行为 |
| --- | --- | --- | --- |
| `main` | 预设正文 `content` | 可选 | 全局基础指令 |
| `personaInfo` | 本局选中玩家角色资料 | 可选 | 支持 WorldBook 前/后挂钩 |
| `characterInfo` | 其它激活角色资料 | 可选 | 支持前/后挂钩 |
| `worldState` | 本轮已加载状态描述与值 | 可选 | 状态启用时必须 enabled；支持前/后挂钩 |
| `chatHistory` | 祖先 Run 内可见消息 | `auto`，保持消息原 role | 必需；没有 WorldBook 挂钩 |
| `userInput` | 当前 Run 的用户输入 | 固定 `user` | 必需；支持前/后挂钩；原始输入仅一次 |
| `postHistory` | 预设正文 `content` | 可选 | 默认关闭 |

仅 `chatHistory` 与 `userInput` 必须启用，且前者在后者之前；启用状态时 `worldState` 也必须启用。系统节点即使自身关闭，关联 WorldBook 前/后钩子仍可生效；禁用本体不等于禁止挂钩。系统节点的具体构建与钩子执行由 AgentContext 决定，Preset 不含脚本调度器。

自定义文本节点允许插在系统节点任意位置，支持自定义名称、role、Prompt 内容和启停；不允许伪装系统 `source`、自定义内部钩子或执行任意代码。自定义文本在运行时与其它节点使用同一安全只读模板引擎。

## 3. 排序与 Token 配置

有序 `nodes[]` 是**唯一编排权威**，UI 拖动直接改变数组顺序；不维护第二份独立顺序表。WorldBook 的 `before/after` 只附着固定系统锚点，跟随节点移动，不作为 Preset 节点持久化。

`budget` 保存**策略**而非实际消费：`max_output_tokens`（响应保留）、`safety_margin_tokens`、`max_input_tokens?`（额外输入上限）。模型上下文窗口从本轮调用配置提供给 AgentContext 的中立 `BudgetLimits`，不是 Preset 的模型引用。实际输入额度 = min(模型窗口 - 输出保留 - 安全裕量, 可选预设输入上限)。`scan_depth_runs` 默认 4，指**当前 Run + 至多 3 个祖先 Run** 的文本扫描，而非 4 条 Message。

Preset 只验证预算数字的基本合法性；实际 Token 计量、必需/可选内容与历史裁剪归 AgentContext 主流程，不属于本模块。

## 4. 可序列化配置示例

~~~json
{
  "schema_version": 1,
  "name": "叙事默认",
  "description": "基础角色扮演预设",
  "nodes": [
    {"id":"main","kind":"system","name":"主指令","source":"main","role":"system","enabled":true,"content":"遵循世界设定，连贯地推进叙事。"},
    {"id":"personaInfo","kind":"system","name":"玩家角色","source":"personaInfo","role":"system","enabled":true},
    {"id":"characterInfo","kind":"system","name":"其他角色","source":"characterInfo","role":"system","enabled":true},
    {"id":"worldState","kind":"system","name":"世界状态","source":"worldState","role":"system","enabled":true},
    {"id":"custom-style","kind":"text","name":"叙事风格","role":"system","enabled":true,"content":"叙事细致、保持角色一致性。"},
    {"id":"chatHistory","kind":"system","name":"历史消息","source":"chatHistory","role":"auto","enabled":true},
    {"id":"userInput","kind":"system","name":"用户输入","source":"userInput","role":"user","enabled":true},
    {"id":"postHistory","kind":"system","name":"后置指令","source":"postHistory","role":"system","enabled":false,"content":""}
  ],
  "budget":{"max_output_tokens":4096,"safety_margin_tokens":1024},
  "scan_depth_runs":4
}
~~~

`id / is_builtin / revision / created_at` 是库记录元数据；导出 JSON 不携带内置身份、用户 ID、密钥或运行时内容。导入后按目标库分配新 `id`；自定义节点重复 ID 可拒绝并提示修复，不能隐式丢节点。

## 5. 持久化与 API

SQLite 一张 `presets` 表即可：`id TEXT PK`、`name`、`description`、`is_builtin`、`schema_version`、`revision`、`config_json`、`created_at`、`updated_at`；配置包含完整 nodes/budget/scan_depth_runs。`builtin/default` 由首次初始化创建，出厂默认值作为应用只读资源，不另建历史版本表。修改时要求 `expected_revision`；所有规则校验通过才整体替换 `config_json`、递增 revision。Session 保存 `preset_id`；每次生成开始时冻结一份 `PresetSnapshot`，中途修改只影响后续 Run。

管理接口（逻辑契约，路由可依实际风格统一）：

- `listPresets() / getPreset(id)`：列表/编辑详情；
- `createPreset(input) / clonePreset(id) / updatePreset(id, expectedRevision, input) / deletePreset(id)`；
- `importPreset(json, conflictPolicy) / exportPreset(id) / restoreDefault(confirmed)`；
- **供 AgentContext 的唯一读取口**：`getPresetSnapshot(id): PresetSnapshot`，返回已验证、深度只读、有序的 `nodes[]`、`budget`、`scan_depth_runs`、`revision`，不拼 Prompt、不访问 WorldBook、不提供模型连接。

建议对外 REST：`GET /presets`、`GET /presets/:id`、`POST /presets`、`PUT /presets/:id`、`DELETE /presets/:id`、`POST /presets/import`、`GET /presets/:id/export`。状态查询应复用读取口，不另造运行时“动态预设”存储。

## 6. 导入、导出与兼容

导入：解析 JSON → 检查文件格式版本 → 验证七系统节点唯一性/角色/必需性/顺序 → 校验自定义 ID/文本、预算上下限 → 预览差异 → 新建预设。旧格式如果含 `api_connection_id`、`model_id`、`credential_ref` 等提供**迁移提示但不自动写入 Preset**。未知执行字段、脚本或任意注入角色标记不得悄悄生效。导出只含可移植配置，首期单预设文件，无资源或引用文件打包。

不同世界卡可以引用同一 Preset；不存在运行时自动继承/覆盖、自动版本合并及双重节点顺序。未来如引入预设共享市场，独立设计版本和来源。

## 7. 验收与非目标

- 拖动前/后系统节点和自定义文本节点后，`nodes[]` 顺序、role、enabled、content round-trip 一致；七基础节点无法丢失。
- 自定义节点的名字、角色、正文可分别编辑；恢复默认需确认；并发 revision 不覆盖他人更改。
- JSON 导出→导入后除本地 ID/revision 外语义相同；非法/旧格式报清晰诊断，任何凭据不会出现在导出。
- AgentContext 接口读取到的仅是不可变配置；Preset 领域**完全不处理** WorldBook 扫描、Hook 内容、变量、Token 裁剪或 Provider。

相关：[Provider](provider.md)、[AgentContext](agent-context.md)、[WorldInstanceContext](world-instance-context.md)、[存储](../technical/storage.md)。
