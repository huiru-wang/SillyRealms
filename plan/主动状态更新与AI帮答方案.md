# 主动状态更新与 AI 帮答方案

状态：**方案待实施。本文按 2026-11-23 的最新定义修订：AI 帮答生成输入框草稿；一份预设包含三个独立场景编排。本次只修改计划文档。**

日期：2026-11-23
项目：SillyRealms
源码核对基线：main / 4ca2e99；当前目录为 apps/server、apps/web。
本文整体替代此前“AI 帮答刷新行动候选”和“单 nodes 数组按 scenes 筛选”的方案。

## 1. 结论与功能边界

建议实施两个独立的会话辅助能力，并同时调整预设结构：

1. **AI 帮答**：独立构建上下文、单次调用模型，将正文流式写入发起页面的输入框；结果只作为临时草稿，不保存，不计入会话 usage。
2. **独立状态更新**：独立构建上下文、单次调用模型，复用主叙事的状态解析、校验和更新计算；结果提交到当前有效助手的状态快照。
3. **预设**：保留一个预设资源，在其中提供“叙事 / AI 帮答 / 状态更新”三个独立节点编排。每个场景独立排序、启停和编辑正文。
4. **模型**：叙事继续使用会话选定的模型；两个辅助场景各自可选“跟随会话模型”或指定已有模型配置。模型绑定属于场景，不属于节点。
5. **用例**：辅助能力进入独立 session-operations 用例，与 narrative 分开；共用锁、context 内部构建能力、模型适配和确实通用的状态后处理。

### 1.1 AI 帮答与行动建议的区别

| 项目 | 主叙事中的行动建议 | AI 帮答 | 独立状态更新 |
|---|---|---|---|
| 目的 | 主叙事结束后给出下一步候选 | 帮玩家拟一条准备发送的回复/行动输入 | 补偿遗漏、失败或不满意的状态更新 |
| 调用 | 主叙事同一次调用的自动能力 | 独立的一次目标模型调用 | 独立的一次目标模型调用 |
| 输出 | action_suggestions 字符串数组 | 一段用户输入草稿正文 | state_update JSONL |
| 展示 | 助手消息的候选项，点击填入草稿 | 直接流式填入输入框 | 状态面板及完成提示 |
| 持久化 | 保存在原助手 output | **不保存结果、消息、output 或操作回执** | 保存有效状态、处理结果及最近回执 |
| 会话 usage | 已包含在主叙事调用内 | **不计入** | 计入独立状态调用的实际用量 |
| 对当前候选的影响 | 正常生成/恢复行动建议 | 不替换、不清空现有候选 | 不重新生成行动建议 |
| 用户后续动作 | 选择候选并自行发送 | 编辑、确认并自行发送 | 查看更新结果，继续会话 |

AI 帮答不再使用“换一组建议”、三选项、50 字限制或 action_suggestions 协议。用户以后发送生成草稿，按普通用户消息进入叙事；这不补记先前帮答调用的 usage。

独立状态更新与主叙事的更新权限和应用规则一致：global/session 只读，只有本次激活的 message 根及已有路径可写，使用绝对值替换。独立之处在于请求和调用，不是另造一套状态引擎。状态规则是提示信息，不是写入授权。

## 2. 当前源码依据

下表区分当前事实与拟议变更；本方案没有把旧目录或其他计划当成已实现能力。

| 当前事实 | 源码依据 | 本次影响 |
|---|---|---|
| 预设只有一套 nodes，内置节点具有固定相对顺序；配置与便携格式有显式映射 | [schema.ts](../apps/server/src/modules/presets/schema.ts)、[repository.ts](../apps/server/src/modules/presets/repository.ts)、[card.ts](../apps/server/src/modules/presets/card.ts) | 改为三个场景节点数组，贯通校验、编辑、复制、导入导出 |
| worldState 同时包含状态资料与更新指令，后处理 prompt 解析忽略 enabled | [postprocess.ts](../apps/server/src/modules/presets/postprocess.ts)、[标准叙事.json](../initial-data/presets/标准叙事.json) | 新默认模板拆开资料和规则，运行时必须真正遵守能力开关 |
| narrative 公共入口包含 submit/regenerate/stop/list/usage/shutdown | [narrative/index.ts](../apps/server/src/usecases/narrative/index.ts)、[routes/narrative.ts](../apps/server/src/routes/narrative.ts) | 保持叙事接口边界，不把辅助任务塞入 submit 的 mode |
| context 捕获会话模型，叙事 prepare 可能发起摘要调用并追加 compaction | [capture.ts](../apps/server/src/usecases/context/capture.ts)、[prepare.ts](../apps/server/src/usecases/context/prepare.ts) | 在捕获时解析场景模型，辅助入口采用只读历史准备 |
| 预算根据所选模型窗口、输出上限和 1024 预留计算 | [budget.ts](../apps/server/src/usecases/context/lib/budget.ts)、[assemble/index.ts](../apps/server/src/usecases/context/stages/assemble/index.ts) | 实际辅助模型必须在编译和预算前确定 |
| collectModel 已提供 onDelta、最终 snapshot 和取消处理 | [collect.ts](../apps/server/src/infrastructure/model/collect.ts) | AI 帮答复用模型基础设施，不经过叙事 run.delta 流 |
| 状态与建议有独立后处理函数；状态无变化返回 snapshot:null | [state-update.ts](../apps/server/src/usecases/narrative/postprocess/state-update.ts)、[action-suggestions.ts](../apps/server/src/usecases/narrative/postprocess/action-suggestions.ts) | 只提取真正共用的状态处理；更新旧消息时不能将 null 当作覆盖值 |
| 会话写锁由 RuntimeCache 统一管理，许可按对象身份校验 | [cache/index.ts](../apps/server/src/infrastructure/cache/index.ts) | 三种调用使用同一会话锁 |
| 普通消息编辑不能伪造 output；usage 从保存的请求计量聚合 | [sessions/service.ts](../apps/server/src/modules/sessions/service.ts)、[output.ts](../apps/server/src/modules/sessions/output.ts) | AI 分支不进入保存链；状态分支新增受控提交 |
| 模型删除及凭据清理由用例协调，预设 JSON 内引用不受现有外键保护 | [model-config.ts](../apps/server/src/usecases/model-config.ts)、[services.ts](../apps/server/src/services.ts) | 增加固定场景模型的保存校验与删除引用检查 |
| 日志会过滤凭据，但不会自动删除生成正文 | [run-logger.ts](../apps/server/src/infrastructure/logging/run-logger.ts) | AI 日志仅保留元信息，不注册完整 response/snapshot 记录 |
| 更多菜单目前只有重新生成；composer 仍传 disabled=false，setDraft 没有辅助忙态保护 | [ComposerMoreMenu.tsx](../apps/web/src/features/sessions/ComposerMoreMenu.tsx)、[SessionPage.tsx](../apps/web/src/features/sessions/SessionPage.tsx) | 增加入口、草稿流写入所有权及真实禁编辑 |
| 会话 SSE 显式注册事件，Stage 目前只有叙事运行投影 | [session-events.ts](../apps/web/src/transport/session-events.ts)、[stage-contract.ts](../packages/sr-sdk/src/stage-contract.ts) | 补辅助运行元信息和统一忙态，不广播帮答正文 |

[WorldStory 消息操作方案](WorldStory-消息操作方案.md) 中尚未实施的消息编辑/批删不纳入本次实现；现有与未来消息写入均须遵守统一服务端锁。

## 3. 预设结构：接受三个编排，保留一个资源

### 3.1 为什么不继续使用 nodes + scenes

用户新增的独立编排要求包括：顺序可不同、节点可不同、同类节点的正文也可不同。单一 nodes 数组加场景标签只能选择子集，不能自然表达三个独立顺序和正文。

| 配置方式 | 独立顺序与正文 | 维护特点 | 选择 |
|---|---|---|---|
| 一份 nodes 加 scenes | 共享顺序和正文；要独立就继续加变体 | 初期简单，后续例外不断增加 | 不采用 |
| 一个预设内三个独立 nodes | 直接支持 | 编辑当前场景只影响当前场景 | **推荐** |
| 共享节点库、场景引用、局部覆盖 | 可以支持 | 要解释共享修改、覆盖优先级、脱离引用、删除影响 | 当前收益不足，暂不做 |
| 三个各自管理的预设资源 | 可以支持 | 会话要配三份，复制/导入/保存生命周期分裂 | 不采用 |

担心“又变成三个预设”有道理：**编排层面确实有三份配置**，不能同时要求任意独立修改和完全没有模板重复。这里保留的是统一的资源管理：一个 presetId、一个名称、一次选择、一次保存、一个 revision、一套复制和导入导出流程。

不引入共享节点引用、节点变体、继承链或自动联动。以后若确实出现大量跨场景长文本同步需求，再单独评估显式复用；不预先建设节点库。

### 3.2 复用与独立的边界

| 内容 | 设计 |
|---|---|
| 玩家身份、角色、世界书、历史、状态的实际数据 | 来自同一会话/世界，运行时按当前材料规则读取，不复制到预设 |
| 系统变量、材料激活、历史窗口、预算和模型适配 | 共享代码 |
| 初始模板 | 由统一默认模板构造三个场景；创建后各自编辑 |
| 节点顺序、enabled、角色与 prompt 包装文字 | 所属场景独立保存 |
| 自定义约束长文本 | 首版各场景独立；需要复用时显式复制，复制后不联动 |
| 公共参数、上下文策略 | 预设保留公共默认；辅助场景可有单层参数/限额覆盖 |
| 预设资源身份与版本 | 三场景统一 |

例如三个场景都使用 {{world.lore}}，重复的是几行包装模板，不是三份世界书数据。角色、历史和状态亦如此。运行时材料还会受保留历史、激活条件和所选模型预算影响，三个请求不承诺恰好注入相同的材料集合。

### 3.3 配置示意

~~~typescript
type Scene = 'narrative' | 'ai_reply' | 'state_update';

type PromptNode = {
  id: string; // 只在所属场景内唯一
  name: string;
  kind: 'system' | 'postprocess' | 'text';
  role: 'system' | 'user' | 'assistant' | 'auto';
  enabled: boolean;
  prompt: string;
};

type PromptFlow = {
  nodes: PromptNode[];
};

type AuxiliaryFlow = PromptFlow & {
  apiModelConfigId: string | null; // null = 跟随会话模型
  modelParameters?: Partial<ModelParameters>;
  limits?: {
    maxContextTokens?: number;
    maxOutputTokens?: number;
  };
};

type PresetConfigV2 = {
  schemaVersion: 2;
  contextStrategy: ContextStrategy; // 保留当前公共配置
  modelParameters: ModelParameters;
  scenes: {
    narrative: PromptFlow;
    ai_reply: AuxiliaryFlow;
    state_update: AuxiliaryFlow;
  };
};
~~~

这是建议的领域结构；存储/便携字段继续遵循项目各自的编码约定。不同时保留一份可写顶层 nodes 和三份场景 nodes，避免双重事实源。preset.type 可继续使用现有 narrative，类型更名不作为本功能前提。

两个辅助场景的参数覆盖全为 optional，仅一层缺省合并；没有覆盖就用公共默认。必须保留显式 0 和 false，不能把当前 thinkingEnabled.default(false) 直接用于覆盖 schema。narrative 的模型仍由 session.apiModelConfigId 决定，不再设置第二个叙事模型来源。

## 4. 三个场景需要哪些节点

### 4.1 默认完整节点矩阵

下表的同名节点属于各自场景，**没有共享引用或编辑联动**。“必需”指结构必需；“默认”可按依赖规则调整；“可选”控制叙事自动能力。

| 节点 | 叙事 | AI 帮答 | 独立状态更新 |
|---|---|---|---|
| main | 必需：叙事任务 | 必需：生成一条玩家输入草稿 | 必需：补偿当前状态 |
| personaInfo | 默认 | 默认，确定以谁的身份回复 | 默认，理解主体及身份 |
| characterInfo | 默认 | 默认，符合互动人物与知情范围 | 默认，理解行为与归属 |
| worldInfo | 默认 | 默认，符合背景和世界规则 | 默认，判断事实及规则 |
| chatHistory | 必需 | 必需 | 必需 |
| userInput | 必需，本轮已保存用户输入 | 不包含 | 不包含 |
| worldState | 默认；启用自动更新时必需 | 默认，只作为背景 | 必需 |
| stateUpdateRules | 可选，自动状态更新 | 不包含 | 必需 |
| actionSuggestions | 可选，自动行动建议 | **不包含** | 不包含 |
| 自定义 text 节点 | 可增删、排序、修改 | 可增删、排序、修改 | 可增删、排序、修改 |

默认节点数分别为 9 / 6 / 7。三个 main 各自定义任务，不再使用全局 aiReplyMain/stateUpdateMain ID。恢复默认通过 (scene, nodeId) 定位。

默认顺序如下，用户可以在各场景内调整节点顺序：

- 叙事：main → personaInfo → characterInfo → worldInfo → chatHistory → userInput → worldState → stateUpdateRules → actionSuggestions。
- AI 帮答：main → personaInfo → characterInfo → worldInfo → chatHistory → worldState。
- 状态更新：main → personaInfo → characterInfo → worldInfo → chatHistory → worldState → stateUpdateRules。

平台在最后补入本场景固定输出协议，在请求预览中可见且只读；它不是用户必须额外配置的节点。

### 4.2 开关和结构校验

节点不再保存 scenes 字段，也没有跨场景总开关：

- 当前场景中的 enabled 只控制当前场景。
- main、chatHistory 以及该场景其他必需节点固定启用。
- 关闭叙事 stateUpdateRules，停止叙事自动更新，不影响手动状态更新。
- 关闭叙事 actionSuggestions，停止自动行动建议，不影响 AI 帮答。
- 不增加“启用整套 AI 帮答”的额外开关；入口、节点与模型配置已足够表达首版行为。

解除当前所有系统节点必须保持同一固定相对顺序的限制，保留真正的语义约束：一个 main、一次历史、叙事一次已保存输入、辅助场景没有 userInput、所需状态资料和规则齐全。chatHistory 仍以 auto 展开真实消息角色；内置语义节点角色仍受约束，自定义 text 节点可用 system/user/assistant。

history.messages 只在本场景 chatHistory 中出现一次，input.text 只在叙事 userInput 中出现一次；使用已有摘要时 history.summary 只注入一次。不允许通过复制一个历史节点造成重复注入。自定义节点不获得绕过这些约束的能力。

kind=postprocess 可暂保留为“能力规则”类别，但不再是运行时强制补回或偷偷追加的特殊通道。新默认 worldState 作为资料节点；stateUpdateRules/actionSuggestions 作为能力规则。所有有效节点按当前场景列表顺序编译。

### 4.3 资料、规则和输出授权

worldState 默认只展示 global/session/message 状态资料，不再混入“续写正文后更新状态”。stateUpdateRules 描述有证据的变化、已有路径和最终绝对值；actionSuggestions 描述候选质量。固定标签和输出格式由平台协议统一提供。

| 场景 | 实际允许能力 |
|---|---|
| narrative | 叙事正文；按本场景规则节点及运行条件启用 state_update/action_suggestions |
| ai_reply | 玩家草稿正文；没有状态或建议执行能力 |
| state_update | state_update；不生成叙事或行动建议 |

context 产生一份最终能力集合，供协议生成和执行器共用。关闭某规则后，运行时 fallback 不能重新启用；模型偶然输出被关闭的能力也不执行。

AI 帮答和状态更新默认不读未发送草稿，不制造空 user 消息，不把历史 assistant 改成 user。最新 assistant 保持原角色；叙事尾部已保存 user 通过 userInput 注入一次。历史中的候选或计划不算已发生事实，辅助场景不必注入 action_suggestions 旁注。

状态更新的当前有效状态、目标定位、目标回复前参考状态均由 context 构建。参考材料在预览可见、在预算前计入；它不覆盖 {{state.message}} 的当前值，也不要求用户维护另一套数据节点。

### 4.4 默认任务提示词示例

**AI 帮答 main：**

~~~text
你负责以当前玩家身份，拟写一条可直接发送给叙事者的回复或行动输入。
依据最新会话历史、玩家身份、人物信息、世界资料和当前状态，选择合理的回应。
只表达玩家的对白、意图或尝试，不替其他角色决定结果，不把计划写成已经确认的世界事实。
输出一条连贯的玩家草稿，不列多个候选，不附解释、标题或分析过程。
遵守本次平台协议。最终是否发送由用户决定。
~~~

**独立状态更新 main：**

~~~text
你负责依据已经发生的故事，补偿当前会话状态。
重点检查最新已保存的助手回复，结合历史、字段定义、当前值与回复前参考状态，判断有可靠证据的最终值。
已执行的状态更新记录仅供参考；不重放整段历史，不在已结算的当前值上重复累加。
不续写剧情，不执行玩家尚未发送的行动。证据不足的字段保留当前值。
按照状态更新规则和平台协议提交结果。
~~~

**共享的默认状态规则模板：**

~~~text
区分已发生事实、计划、建议、猜测和未知信息。
仅处理本次允许的已有路径，输出字段最终绝对值，保留无关字段。
依据变化前后证据判断数量与计数，避免对同一事件重复结算。
没有可靠证据时不猜测，不为状态变化编造故事。
~~~

最后一段由默认模板生成到叙事和状态场景，生成后两份正文独立。叙事 main 保留叙事职责，并改为遵守“本次启用能力”的协议，不无条件要求所有尾块。

## 5. 模型设置、预算与编辑界面

### 5.1 场景模型

| 场景 | 默认 | 可配置内容 |
|---|---|---|
| 叙事 | 会话当前模型 | 继续由会话设置管理 |
| AI 帮答 | 跟随会话模型 | 可指定已有模型配置；可选参数及输入/输出限额覆盖 |
| 独立状态更新 | 跟随会话模型 | 可指定已有模型配置；可选参数及输入/输出限额覆盖 |

支持独立模型是合理的：三个任务的输出长度、生成风格和结构化输出要求不同。默认继承可让普通用户只选一次；高级用户才展开覆盖。模型配置选择已有 apiModelConfigId，不在预设中复制 provider、URL、API Key 或凭据。

参数面板采用“公共默认＋当前辅助场景可选覆盖”，只有一层。UI 显示有效值和是否跟随，允许清除覆盖。首版不新增三套摘要策略或三套完整上下文配置；两个辅助入口始终使用已有有效摘要与只读裁剪。

有效模型必须在 context 捕获阶段选定，随后预算、参数能力校验、凭据读取和实际调用均使用该模型。禁止先按主模型的大窗口编译、发送前再换小模型。

沿用当前预算原则：

~~~text
inputBudget = min(
  当前场景有效 maxContextTokens,
  实际模型 contextWindow - 当前场景有效 maxOutputTokens - 1024
)
~~~

模型缺失、配置本身非法、输出上限超过实际模型允许值或预算非正时，在请求模型前给出明确错误并提示调整该场景；不静默换模型。合法配置中不受所选模型支持的采样/思考选项，继续遵守现有适配器的过滤或降级规则，并通过 sampling_omitted 等诊断说明有效行为，不因换辅助模型而整体改成硬错误。模型元信息与请求诊断记录实际选中的配置，不能继续硬写 session 的模型 ID。

### 5.2 引用与可移植性

- 本机保存时，PresetService 经只读 ModelReader 校验固定引用；模型被引用时，模型删除用例查询 PresetService 的只读引用能力后阻止删除。JSON 查询留在 PresetRepository，不增加跨模块 SQL。
- 默认跟随时不新增固定引用。异常情况下固定引用失效，执行明确失败，不悄悄改用主模型。
- 本机复制预设保留固定绑定。
- 便携导出保存三个场景的节点、参数和限额，**不携带本机 apiModelConfigId 或凭据**；导出说明明确“导入后跟随会话模型”，导入按 null 初始化。
- 不按名称猜测同款模型，不建立占位引用或自动匹配系统。需要固定模型时在目标环境重新选择。

这是有意的便携边界：提示词及参数可移植，本机连接绑定不可移植。导入导出测试不能错误要求本机模型 ID 也往返不变。

### 5.3 预设界面

“提示词编排”顶部切换为三个编排页签：**叙事｜AI 帮答｜状态更新**。它们是三个独立列表，不再提供混在一起的“全部节点”视图。

当前场景显示任务说明、模型选择和节点列表；高级参数折叠。编辑弹窗标题注明场景，例如“AI 帮答 · 主提示”。在当前场景添加、排序、关闭或编辑，只影响该场景，不出现共享影响范围或场景复选框。

三个场景共享一次预设保存和 expectedRevision；切换保留尚未保存的修改，页签可标记有修改。移动端只显示一套列表，沿用现有紧凑节点与弹窗，不做三列并排。恢复默认支持当前节点/当前场景，恢复节点不会偷偷重置模型绑定。

## 6. 上下文构建与服务端边界

### 6.1 继续使用具名入口

context 通过 index.ts 公开三个入口，业务输入仍只有 sessionId，permit/signal/progress 等为执行控制：

| context 入口 | 固定场景 | 历史策略 | 返回目的 |
|---|---|---|---|
| prepareContext | narrative | 现有叙事摘要/裁剪策略 | 主叙事请求 |
| prepareAiReplyContext | ai_reply | 复用有效已有摘要，只读裁剪 | 玩家草稿请求 |
| prepareStateUpdateContext | state_update | 复用有效已有摘要，只读裁剪 | 状态更新请求和目标证据 |

不保留旧方案的 prepareActionSuggestionsContext 名称。调用者不能传入任意 prompt、历史数组或把 prepareContext 的 mode 切成其他任务。scene 在入口内部固定，context 内部复用捕获、材料激活、节点编译、估算与诊断。

一次辅助操作最多发起一次目标模型调用，不自动重试、不调用模型补摘要、不追加 compaction。若一次调用未成功，交还用户决定是否重试。

### 6.2 编译顺序

1. 持有会话锁后，在首次异步等待前捕获会话、实际 tip、最新普通消息、预设 revision、对应场景节点及所选模型配置。
2. 解析有效参数与限额，读取当前有效状态；状态场景额外捕获目标助手及其回复前状态。
3. 选取已有且 sourceHash/覆盖范围有效的摘要，以及保留历史候选。
4. 按候选的干净历史和适用输入重新激活身份、角色、世界书与状态根。历史旁注不参与摘要源文或材料激活。
5. 按该场景自己的顺序渲染启用节点；历史保持真实角色，当前叙事输入只出现一次。
6. 附加所需目标证据和固定平台协议；派生最终有效能力集合。
7. 对完整实际请求计算预算；若需裁剪，回到历史候选阶段重新激活和编译，不沿用第一次的 activeRoots。
8. 返回 request、实际模型/参数、诊断及必要目标信息。API Key 仍由执行用例按 credentialRef 读取，不进入 prompt 配置或 context 明文结果。

保护最新必要轮次和状态目标，不能把待处理助手裁掉。固定材料、必需状态与目标轮次仍超限时明确失败；不截断状态 JSON、不改写真实消息角色、不静默移除必需证据。

context 不发送 SSE，不保存辅助结果，不反向调用 narrative/session-operations。narrative 执行器必须把 context 的最终能力集合传给后处理，使 prompt、执行和保存一致。

### 6.3 叙事接口与辅助用例的归属

| 模块 | 职责 |
|---|---|
| routes/narrative.ts → narrative/index.ts | 提交叙事、重新生成、停止、读取叙事运行和用量 |
| routes/session-operations.ts → session-operations/index.ts | 发起帮答/状态更新、查询辅助运行、停止与关闭 |
| context/index.ts | 三个具名请求准备入口，共享内部编译 |
| 共享状态后处理 | 状态标签、JSONL 校验、候选更新结果；不负责执行模型或发事件 |
| StateService | 读取有效状态、计算候选快照和变化；不增加表或 Repository |
| SessionService | 状态补偿的受控持久化及现有会话读取 |
| ModelClient / collectModel | 模型适配、正文流、终态与取消 |
| Web operations feature | 辅助运行状态、私有草稿流与状态完成同步 |
| Stage | 接收宿主快照并代理命令，不承担模型调用或结果恢复 |

辅助用例内部保留两条明确流程：ai-reply 和 state-update，共用受理、互斥、句柄与停止的小部分代码。不要为了统一接口，把 AI 草稿接入状态持久化或行动建议结算，也不增加通用任务引擎、Agent loop 或任务表。

共享提取以实际消费者为准：状态处理被 narrative 与辅助状态调用共同使用；action-suggestions 和正文流切分仍归 narrative。通用标签/严格 JSON 解析可移到不含领域依赖的 lib；状态处理通过一个明确出口供两处使用，不从辅助用例跨目录导入 narrative 私有文件。

## 7. 独立入口、传输与互斥

### 7.1 API

建议挂在 /api/v1/sessions/:sessionId/operations 下：

| 方法与路径 | 语义与响应 |
|---|---|
| POST /operations/ai-reply | 200 私有 NDJSON 响应流；只向发起请求的页面传草稿 |
| POST /operations/state-update | 202 标准 HTTP 包络；后台执行，通过会话 SSE 通知结果 |
| GET /operations | 当前内存运行元信息、最新有效目标的最近状态更新回执；没有 AI 帮答持久结果 |
| POST /operations/:operationId/stop | 停止指定运行；统一标准 HTTP 包络 |

提交请求均包含调用方生成的 operationId 和 expectedTipEntryId。operationId 用于关联/取消，不承诺永久幂等或历史重放；客户端不能在结果不确定时自动重新调用模型。

在打开私有流前完成访问、tip、基本目标资格、配置和锁校验；失败沿用标准 HTTP 错误包络。流已开始后的失败通过终态帧表示，不能再尝试返回普通 JSON 包络。

AI 私有流最少包含 started / delta / completed / stopped，携带 operationId；delta 只有正文 text。completed 可携带最终 text snapshot，供前端**替换校准**，不能再次追加。stopped 使用既有 stop_reason 风格；正文已收到但中断时交由用户继续编辑。

设置不缓存流响应；路由负责 NDJSON 编解码和请求断开取消，用例只产生类型明确的文本/状态事件。流内容不写服务端事件回放或浏览器持久缓存。

### 7.2 目标资格

首版两项入口都从最新保存的会话上下文工作：最后一条普通消息应为有可见正文的 assistant，包括开场和停止后保存的有效正文。若末尾是未获回复的 user，先完成/重试叙事；不跳过该 user 操作更早轮次。没有有效助手正文时入口不可用。

AI 帮答只读取该上下文，不把目标消息当作结果保存位置，也无需满足状态继承链的特殊限制。

状态更新还需要本次激活的可写 message 根，并满足第 9 节的目标状态继承条件。前端可以做基本提示，最终资格和激活范围由服务端决定，不在 Web 复制 context 的判断逻辑。

### 7.3 同一把会话锁

沿用初始需求，两个辅助操作运行时均锁住会话。AI 帮答虽然不写结果，仍需要稳定的生成上下文和草稿写入时段。

- 叙事发送、重新生成、AI 帮答、独立状态更新互斥，不排队。
- 会话输入、发送、已有的消息编辑/删除、配置切换及其他会话写入被统一忙态与服务端锁阻止。
- AI 私有流拥有者可以程序化写入自己的草稿；普通输入事件和 Stage composer.setDraft 不能绕过该忙态。
- SessionService 继续使用 SESSION_WRITE_LOCKED；状态外部写入使用 STATE_WRITE_LOCKED。沿用现有 409 契约。
- 同世界 global 状态继续遵循现有运行期外部写入限制；其他会话的独立写入按原规则运行。
- 许可仍是内部对象身份，不经过 HTTP/SSE/SDK；只由持有者释放。
- 读取、滚动、加载历史、SSE 和停止保持可用。

RuntimeCache 扩展运行拥有者类型即可，不增加另一把辅助锁。narrative 的 active Map 不足以证明会话空闲，辅助用例需要自己的小型句柄 Map，但真正互斥仍只有一个来源。

### 7.4 共享通知与两种生命周期

共享会话 SSE 增加 operation.started / operation.completed / operation.stopped，只包含身份、kind、时间、阶段、停止原因及必要目标 ID。**AI 帮答正文只能出现在发起 POST 的私有流，不能广播给其他页面。**

- AI 帮答：请求取消、响应断开或离开发起页面时 abort；结束后清理句柄、释放锁。不存在结果恢复或断点续传。
- 状态更新：受理后可继续后台运行，SSE 断连或页面离开不等于取消；用户可明确停止，回来后查询持久结果。
- 服务关闭要同时取消/等待两类辅助流程及叙事结算，再关闭数据库和会话事件连接。
- 任意失败路径都要 finally 释放本次锁；旧运行的 finally 不能释放后续运行持有的许可。

发起帮答的页面必须等**自己的私有流终态或关闭**后结束本地生成忙态。共享 SSE 的完成元信息可能先到，不能据此提前解锁输入，再让晚到的最终 snapshot 覆盖人工编辑。

## 8. AI 帮答：草稿流与不留存

### 8.1 运行过程

点击“更多 → AI 帮答”后：

1. 本地立即进入 pending，保留原草稿的临时快照，建立本次 operationId 和草稿写入所有权。
2. 服务端独立 prepareAiReplyContext，选择实际模型并调用一次 collectModel。
3. 仅将正文 content 流向发起页面；reasoning_content、tool_calls 不进入输入框，也不触发工具或其他能力。
4. 第一个有效正文片段到达时替换原草稿，后续片段连续更新。最终 snapshot 按替换语义校准。
5. 正常完成后恢复编辑，由用户决定是否修改、发送或放弃；不自动发送、不创建消息气泡。
6. 生成期间显示“正在帮你拟写…”，停止按钮路由到当前辅助操作；已有行动建议可以显示，但点击填草稿被禁用。

AI 分支自己判定业务完成：只有收到正常终态、finishReason=stop、正文有效、没有工具调用且没有失败/停止原因，才发送 completed。长度截断、工具请求、缺少终态等均发送 stopped，保留已到达草稿，不执行工具。collectModel.failed=false 本身不足以证明业务成功，不能依赖叙事专用包装替本分支作判断。

这里选择“生成一份新草稿”，不是“接着旧草稿续写”；首版不向模型发送未发送草稿。原草稿在页面内可一键恢复，不增加确认弹窗。恢复备份只在当前页面内保留，发送、切换会话或下一次生成后按草稿生命周期清理。

### 8.2 失败与取消

| 情况 | 输入框处理 |
|---|---|
| 第一个正文片段之前失败/取消 | 保留原草稿 |
| 已收到部分正文后失败、超长截断或取消 | 保留已收到的部分草稿，说明生成中断，可继续编辑或恢复原草稿 |
| 正常完成且正文非空 | 保留最终草稿 |
| 模型正常结束但没有有效正文 | 提示未生成有效内容，保留原草稿 |
| 用户停止后仍收到迟到 delta/snapshot | 丢弃，不能再修改草稿 |
| 切换会话或当前 operationId 已变化 | 丢弃旧流写入 |
| 页面刷新/关闭 | 取消本次调用；不从历史恢复此次帮答文本 |

宿主单独维护本次生成的写入身份和草稿版本，只允许对应生成器更新；内部流更新不能误判为人工修改。Stop 立即撤销写入权，服务端锁何时释放仍以服务器状态为准。其他页面只看到忙态，不收到也不填入此次正文。

平台要求输出一段草稿，不请求结构化尾块；若模型违规把列表或标签写进普通正文，它也只是可编辑的异常草稿，不能被解析为行动建议或状态指令。不为了修复模型格式再发起第二次调用。

### 8.3 不留存与 usage 的硬边界

AI 分支不调用 SessionService 的任何结果保存方法，不写：

- user/assistant/compaction entry。
- extData.output 或 extData.operations.aiReply。
- metrics.requests、主叙事 context 快照或会话 usage。
- action_suggestions.created、state.changed、run.created、run.delta、run.usage。
- 包含生成正文、最终 snapshot、raw response 的持久日志或诊断。

collectModel 可以在请求期间临时收集 snapshot 与供应商 usage；AI 分支在结束后丢弃，不把 usage 伪造为 0 写入会话。允许记录 operationId、模型标识、耗时、完成/取消/失败原因等元信息，日志使用字段白名单，不能把包含正文的错误对象整体输出。

Web 只维护当前页面的内存草稿，不增加 localStorage/IndexedDB 生成结果缓存。刷新后不可恢复是该功能的约定，而不是待补齐的持久化缺口。

## 9. 独立状态更新：同一更新语义，独立执行

### 9.1 执行链

锁定会话 → prepareStateUpdateContext → 一次独立模型调用 → 完整接收 state_update → 共享状态后处理 → 受控事务提交 → 释放锁 → state.changed（若有变化）→ operation 终态。

不调用 narrative.submit，不重生成正文，不复用本轮主叙事的模型输出，也不连带运行 actionSuggestions。context 中允许使用已经保存的历史与状态处理旁注，但它们是证据，不是重放指令。

沿用现有 state_update JSONL：

~~~text
<state_update>
{"path":"inventory.coins","value":15,"reason":"本轮前为10，已发生的故事明确获得5枚金币"}
</state_update>
~~~

无变化使用完整成对空块。主动调用缺失目标标签、标签损坏、模型未正常结束或截断时失败；不能把“没有按协议回答”当成无需更新。普通叙事继续保留其原有缺省语义，独立入口在共享处理前增加目标完整性校验。

### 9.2 避免重复结算

若本轮前金币为 10，故事明确获得 5：

| 当前状态 | 应有处理 |
|---|---|
| 已经是 15 | 无实际变化 |
| 错记为 12 | 校正为 15 |
| 错记为 20，且证据明确只发生上述变化 | 校正为 15 |
| 基数或事实不确定 | 保留当前值，不猜测 |

服务端仍应用绝对 value，不新增增量指令，也不根据有没有旧 output 判断事件是否已结算。

前置状态来自目标助手之前的有效继承视图，仅供模型理解。**实际候选计算必须以当前有效状态为底**，保留本次未涉及的字段，不能把旧快照整体恢复后再算。人工修改过的当前状态不能因为旧处理记录缺失就盲目撤销。开场缺少可靠前置状态时明确标记不可用，不虚构零基数。

### 9.3 状态权限和部分成功

复用 StateService.prepareMessageUpdates：

- global/session 仅背景，message 仅本次激活根和已有路径。
- 类型、值约束、路径权限与主叙事一致。
- 逐行隔离；有效行按顺序应用，重复路径按顺序覆盖。
- 允许部分成功，显示部分字段未更新；全部无效时保留旧状态和旧有效结果。
- 字段 rules 不扩大写权限，不为补偿场景增加越权写入入口。

模型理解错误仍可能导致不合适的最终值；共享校验保证结构和权限，不声称自动证明所有叙事判断正确。

### 9.4 保存位置与无变化

将有效快照与处理结果保存到最新目标 assistant。目标之后只允许 state **严格为 null** 的 compaction；它们会继承助手状态。显式 [] 也是独立快照，同样阻断继承，需要拒绝本次补偿并说明当前尾部状态不满足条件。

不常规把补偿快照写到 compaction，否则重新生成删除旧助手后可能残留与旧回复绑定的状态。

- changed=false：保留原 entry.state，不能写 null。
- changed=true：写入以当前有效状态为基底计算出的完整快照。
- no_updates 可以更新处理记录，但不改变已有快照。
- 不改助手正文、推理、原叙事终态、seq、parent 或 session.tipEntryId。

现有处理函数的 snapshot:null 表示“新消息不需要新快照”；提取共享处理时应明确返回 changed，让新消息追加和旧消息补偿各自选择正确保存方式。

## 10. 状态结果、回执和计量

本节只适用于独立状态更新；AI 帮答不走这些保存路径。

### 10.1 原子提交

新增 SessionService.commitStateOperation 一类受控入口，通过本次内部许可，在同步事务内：

1. 重查 actual tip、目标助手身份、许可和状态继承条件。
2. 仅替换 extData.output.stateUpdate，保留 actionSuggestions、正文及其他扩展字段。
3. changed=true 时保存状态快照。
4. 追加确实发生的目标调用计量，保存最近一次状态更新回执。
5. 一次提交完成；发布业务成功事件必须在提交和释放锁之后。

网络调用、模型解析不放在事务内。取消发生在提交前则保留旧有效结果；已提交后取消不回滚。失败或取消可以只记录状态操作回执与实际计量；提交失败则整体回滚，不宣称有持久成功回执。

output 各字段表示该能力最近一次有效完成的处理结果，不是所有处理次数的账本。原助手没有 output 时，只写实际状态字段，不能伪造一份 actionSuggestions。

### 10.2 最近回执与稀疏结果

extData.operations.stateUpdate 只保存最近一次状态尝试的 operationId、status、finishedAt、stopReason 及实际存在的 requestId，不重复保存输出正文，不保留 AI 回执，不建立任务历史表。

普通消息编辑不能伪造/删除受保护回执。删除或重新生成目标助手时，相关状态结果、回执和计量随该助手一起移除，沿用现存 entries 的统计口径。

叙事 output 也只保存实际启用能力的记录：未启用字段缺失，两项都未启用则不产生 output。读取归一化与 model-notes 必须支持缺失字段；缺失不能被补成“已执行且无变化”。只为实际保存的有效 no_updates/no_suggestions 渲染对应空旁注。历史恢复不依赖 AI 帮答结果，因为没有这类持久结果。

### 10.3 状态调用 usage

独立状态调用追加实际 metrics.requests；调用前失败不虚构 requestId，发生调用但 usage 不明时保持 null。请求可增加 purpose 区分 narrative/summary/state_update，旧记录仍可读；不创建 AI 帮答的持久 metrics 项。

recordedUsage 需要同步修正：

- 累计用量包含独立状态请求。
- 主叙事上下文按 metrics.context.requestId 定位原请求，不能再默认取 requests.at(-1)。
- 只有状态辅助计量的开场助手不能冒充主叙事请求。
- 旧记录缺少 context 时保留历史回退，同时排除已明确标记为 state_update 的请求。
- 状态操作不覆盖主叙事 context，不发假的 run.usage；完成后 Web 主动补读会话 usage。

## 11. 页面状态与异常恢复

输入框更多菜单提供：重新生成、AI 帮答、更新状态。辅助运行期间统一禁用输入、发送、重新生成、已有编辑/删除、建议填草稿及再次发起辅助操作；保留阅读和停止。

工作区忙态应综合：叙事发送/运行、辅助提交/运行、发起页尚未结束的 AI 私有流。Stage 与原生组件使用同一宿主快照，不各自维护另一套业务 loading。

| 情况 | AI 帮答 | 独立状态更新 |
|---|---|---|
| tip 过期或会话已锁 | 请求失败，刷新状态，用户决定重试 | 同左 |
| 重复点击 | 本地 pending 与服务端同一锁防重入 | 同左 |
| 受理响应不确定 | 不自动重发；关闭/取消本次流，查询真实 busy | 按本次 operationId 查询 active 或状态回执 |
| SSE 元信息断连 | 私有流若仍健康可继续；恢复连接后补查 busy | 后台可继续，重连补查运行与结果 |
| 私有响应断连 | 取消；保留页面已收到的部分草稿，不补发 | 不适用 |
| 刷新或离开发起页面 | 不恢复帮答结果 | 读取已提交状态和回执 |
| 服务进程重启 | 运行中断，无结果恢复 | 不恢复执行，仅读取已提交结果 |
| 终态比 HTTP 受理响应先到 | 以本次流身份/终态为准，不能重新置忙 | 按 operationId 去重，迟到 202 不能复活任务 |
| 旧事件晚到、新运行已开始 | 不解锁新运行，不写新草稿 | 不解锁新运行、不覆盖新状态投影 |
| 提交失败 | 没有结果提交链 | 不发成功事件，释放锁并报告保存失败 |

状态更新修改的是已有助手，不新增 seq。完成后必须刷新包含目标的最近完整轮次及状态/usage，不能只查 afterSeq > 原 seq。复用当前最近历史覆盖同步及身份保护，避免旧请求覆盖新页面。

GET /operations 对 AI 只返回当前 active 元信息；active 不存在不等于“上一次帮答成功”。对状态操作，只有匹配 operationId 的持久回执才能证明那次尝试的终态。两种能力的恢复承诺应在控制器中分开。

## 12. 旧配置迁移与兼容

当前领域 schemaVersion 为 1，便携 config_json 版本为 3；建议分别升级为 2 / 4，保持显式编码，不把两个版本号误当成同一层。

迁移规则：

1. 将旧 nodes 放入 scenes.narrative.nodes，保留旧自定义节点、正文与顺序；为辅助场景初始化各自完整默认节点。
2. 已知标准 main/worldState/actionSuggestions 可确定性升级为职责更清楚的新模板，并加入 stateUpdateRules。
3. 用户改写过的混合 worldState/main 保留原文，仅留在叙事场景，提示可整理；不自动复制进 AI 帮答/状态场景，不声称能无损拆分自然语言。需要的默认状态规则单独加入，避免必须人工拆完旧文才能使用新辅助场景。
4. 原 state/action 规则显式 enabled=false 映射为叙事对应自动能力关闭；虽然当前实现曾忽略它，新版应尊重明确配置。缺失旧规则时按现有默认行为规范化一次，不能以后每次运行再强制补回。
5. 辅助模型默认 null，参数/限额无覆盖。现有会话 presetId、apiModelConfigId 均不改变。
6. 读取/导入可先在内存规范化，保存时写新版本并使用 expectedRevision；不批量覆盖用户原记录，也不生成额外预设资源。

旧自定义 prompt 可能仍要求某个已关闭能力，平台能力集合必须兜住实际执行，不能因此重新开启。新默认规则不会自动共享到旧自定义节点；后续修改默认模板也不静默更新用户已经保存的场景正文。

复制/导出再导入应保留三场景节点、局部顺序、开关、正文和参数/限额；本机模型绑定按第 5 节约定处理。默认模板继续保存在 initial-data，恢复默认按 scene 与 nodeId 定位。

不增加业务表或数据库列；数据结构变更落在现有预设 JSON 和既有 entry 的受控 output/metrics 扩展中。

## 13. 计划变更文件目录

以下均为**待实施范围**，本次实际只更新本计划。共享处理只提取实际共用部分，文件名可在实现时小幅调整；迁移后不保留两份状态算法。

~~~text
SillyRealms/
├── initial-data/presets/标准叙事.json                 [修改] 三场景完整默认节点及公共参数
├── apps/server/
│   ├── AGENTS.md                                     [修改] 功能落地后同步事实契约
│   ├── eslint.config.mjs                             [修改] 明确用例出口及共享处理依赖
│   └── src/
│       ├── app.ts                                    [修改] 辅助路由注册、关闭流程
│       ├── services.ts                               [修改] ModelReader 注入 PresetService
│       ├── usecases.ts                               [修改] 辅助用例装配、模型删除依赖
│       ├── errors.ts                                 [修改] 目标/配置/流式终态错误映射
│       ├── infrastructure/
│       │   ├── cache/index.ts                        [修改] 同一会话锁支持辅助拥有者
│       │   └── logging/run-logger.ts                 [修改] operation 日志身份；AI 元信息白名单
│       ├── lib/
│       │   ├── model-output.ts                       [新增/迁入] 无领域依赖的标签及严格 JSON/JSONL 解析
│       │   └── model-output.test.ts                  [迁入/修改] 保留解析边界回归
│       ├── modules/presets/
│       │   ├── schema.ts                             [修改] 三场景 schema 与逐场景依赖
│       │   ├── types.ts                              [修改] 场景及辅助模型覆盖类型
│       │   ├── scenes.ts                             [新增] 固定场景、默认节点及能力规则
│       │   ├── model-parameters.ts                   [修改] 完整参数与全 optional 覆盖分别编解码
│       │   ├── postprocess.ts                        [修改] 移除运行时无条件启用行为
│       │   ├── default.ts                            [修改] 按 scene/nodeId 恢复默认
│       │   ├── service.ts                            [修改] 规范化、ModelReader、只读引用查询
│       │   ├── repository.ts                         [修改] JSON 映射与本域模型引用查询
│       │   ├── card.ts                               [修改] 便携新版本，移除本机模型绑定
│       │   └── service.test.ts                       [修改] 迁移、独立编辑、往返与引用校验
│       ├── modules/sessions/
│       │   ├── service.ts                            [修改] commitStateOperation、主请求 usage 读取
│       │   ├── repository.ts                         [修改] 状态结果/回执/计量原子合并
│       │   ├── schema.ts / types.ts                  [修改] 状态回执保护、请求 purpose
│       │   ├── output.ts / stored-output.ts          [修改] 能力字段按实际执行保存与归一化
│       │   └── service.test.ts                       [修改] 原子性、无变化、usage 归属
│       ├── routes/
│       │   ├── session-operations.ts                 [新增] AI 私有流、状态提交、查询、停止
│       │   └── session-operations.test.ts            [新增] 访问、断连取消、传输契约
│       ├── usecases/model-config.ts                  [修改] 删除前检查预设固定模型引用
│       ├── usecases/model-config.test.ts             [修改] 引用阻止删除且保留凭据
│       ├── usecases/context/
│       │   ├── index.ts / types.ts                   [修改] 两个具名辅助入口及明确结果类型
│       │   ├── capture.ts                            [修改] 捕获场景节点、实际模型/参数/限额
│       │   ├── candidate.ts                          [修改] 三场景候选材料与能力
│       │   ├── lib/budget.ts                         [修改] 使用实际模型及有效场景限额
│       │   ├── prepare-operations.ts                 [新增] 只读摘要复用、裁剪与目标证据
│       │   ├── prepare-operations.test.ts            [新增] 单次调用、角色、预算与目标保护
│       │   ├── stages/assemble/index.ts              [修改] 按当前场景独立 nodes 编译
│       │   ├── stages/assemble/protocol.ts           [修改] 草稿/状态/叙事协议与能力一致
│       │   └── stages/model-notes/                   [修改] 缺失能力不补假结果，辅助按需选旁注
│       ├── usecases/state-output/
│       │   ├── index.ts                              [新增] 共享状态后处理公开出口
│       │   ├── state-update.ts                       [迁入/修改] 现有状态算法，显式 changed
│       │   └── state-update.test.ts                  [迁入/修改] 叙事与补偿的共同状态规则
│       ├── usecases/session-operations/
│       │   ├── index.ts / types.ts                   [新增] 受理、active、停止、关闭与依赖类型
│       │   ├── ai-reply.ts                           [新增] 一次模型调用、临时正文流、无保存链
│       │   ├── state-update.ts                       [新增] 一次调用、共享处理、事务提交与通知
│       │   └── index.test.ts                         [新增] 互斥、取消、无留存、状态结算
│       ├── usecases/narrative/
│       │   ├── execute.ts                            [修改] 传递最终有效能力集合
│       │   ├── postprocess/processor.ts              [修改] 按能力执行、调用共享状态出口
│       │   ├── postprocess/action-suggestions.ts     [修改] 仅迁移纯解析依赖，业务仍归叙事
│       │   └── postprocess/state-update、parser、
│       │       strict-json 及对应迁移测试            [删除/迁出] 避免重复实现
│       └── testing/architecture.test.ts              [修改] 验证新公开边界及 SQL 属主约束
├── apps/web/src/
│   ├── api.ts                                        [修改] 辅助 API 类型与私有流请求入口
│   ├── features/presets/
│   │   ├── types.ts / adapter.ts                     [修改] 三场景映射、默认/覆盖
│   │   ├── PresetLibraryPage.tsx                     [修改] 独立场景页签及同一次保存
│   │   ├── PromptEditorDialog.tsx                    [修改] 当前场景独立编辑和恢复默认
│   │   ├── sampling.ts / SamplingRow.tsx             [修改] 可选参数覆盖，保留 0/false
│   │   └── Presets.module.css                        [修改] 紧凑页签、模型行与高级参数
│   ├── features/operations/
│   │   ├── controller.ts                            [新增] 运行身份、状态查询、两种生命周期
│   │   ├── ai-reply-stream.ts                        [新增] 私有流、最终 snapshot、取消/迟到保护
│   │   └── index.ts                                 [新增] feature 出口
│   ├── features/sessions/
│   │   ├── ComposerMoreMenu.tsx                      [修改] 帮答/更新状态入口及键盘操作
│   │   ├── SessionPage.tsx                           [修改] 草稿生成所有权、真实禁编辑、恢复原草稿
│   │   └── workspace.ts                             [修改] 统一 busy、停止分流、状态结束补读
│   └── transport/session-events.ts                   [修改] 辅助元信息事件白名单与校验
├── apps/web/tests/
│   ├── session-workspace.test.mjs                    [修改] 草稿/状态生命周期与共享 busy
│   ├── session-events.test.mjs                       [修改] 元信息分发、迟到事件
│   ├── ai-reply-stream.test.mjs                      [新增] 分片、最终替换、取消及无持久恢复
│   └── stage-frame.test.mjs                          [修改] 宿主草稿命令受忙态限制
├── packages/sr-sdk/src/
│   ├── stage-contract.ts                             [修改] 辅助运行元信息与忙态
│   └── stage/
│       ├── runtime.ts                                [修改] 只读投影适配
│       └── world-story.tsx                           [修改] 辅助运行期禁用候选填草稿
├── docs/runtime/
│   ├── server-http.md                                [修改] 落地后的私有流与状态接口
│   ├── server-events.md                              [修改] 辅助元信息事件，无 AI 正文广播
│   ├── server-narrative.md                           [修改] 自动能力、稀疏 output 与 usage
│   └── web-runtime.md                                [修改] 草稿流、状态恢复与 busy 契约
└── AGENTS.md                                         [修改] 实施后同步真实职责和接口
~~~

actionSuggestions 的持久化/恢复业务无需因 AI 帮答新增一套逻辑。collectModel 已具备所需流式与取消能力，优先复用，不预先复制或重写。其他文件仅在实际类型依赖需要时调整；docs/design 继续只描述已实现事实，不把本计划写进去。

## 14. 实施顺序与验收

### 14.1 实施顺序

1. **配置与 context**：三场景 schema/迁移/默认模板、逐场景编译、两个具名入口、实际模型解析及预算。
2. **共享状态与服务端流程**：统一锁、状态后处理提取、受控提交、AI 私有流、状态后台接口、模型引用检查与关闭。
3. **Web/Stage**：预设页签/模型设置、更多菜单、草稿流和停止、统一忙态、状态回执与最近轮次同步。

以上是同一功能的实施顺序，不是先让用户长期使用一套不能独立编辑的过渡配置。

### 14.2 必须验证的行为

验证采用函数级测试、typecheck、lint；不启动真实服务或真实模型，不建设模拟端到端环境。测试覆盖实质边界，不为每个字段映射另造重复测试。

**预设与模型：**

- 三场景可独立排序、启停和改正文；改一个场景不会改另一个。节点 ID 可跨场景重用，但场景内唯一。
- 历史/输入按各自角色仅注入一次，固定协议与有效能力一致；关闭叙事自动能力后不能被 fallback 补回。
- 已知标准旧预设可升级；用户改写的混合文本保留在叙事，辅助场景不继承旧叙事指令。
- 本机复制保留模型绑定；便携往返保留节点/参数/限额并明确重置本地模型绑定。
- 在捕获阶段使用所选辅助模型；小窗口、输出上限、缺失模型、凭据失败均按实际配置处理。
- 参数覆盖中缺省、0、false 含义不同；不支持的采样/思考选项保持既有适配器过滤或降级契约。被固定引用的模型无法删除，凭据也不能误删。

**AI 帮答：**

- 只调用一次模型，不新增 user/assistant/compaction，不改 tip/seq、状态或原行动建议。
- 私有流只有发起页面写草稿；其他页只更新忙态。reasoning/tool 字段不进入草稿；length、工具请求、缺终态等不能误报 completed。
- 第一个片段前失败保留原草稿；之后失败/停止保留部分草稿。最终 snapshot 只替换一次，不重复追加。
- 共享 SSE 终态先到不能解锁发起页；停止、换会话或新生成后旧 delta/snapshot 不能覆盖草稿。
- 对 Sessions 持久化接口的调用次数为零；没有 output/回执/metrics 写入，会话 usage 保持不变。
- 日志/诊断无生成正文或 raw snapshot，Web 无新增结果持久缓存；刷新后没有伪造恢复。
- 请求断开/取消最终释放同一会话锁；直接 HTTP 和 Stage 写命令不能绕过锁。

**独立状态更新：**

- 使用独立 context 和模型调用，共享相同路径/值/权限规则；不执行建议或续写正文。
- 完整空块为 no_updates；缺失/损坏标签、截断或未正常结束不当成功。
- 10 + 5 已为 15 时不重复累加；当前为 12 时按证据校正为 15。
- 无变化保留原快照；部分成功只提交有效变化；全失败/取消保留旧有效状态和结果。
- 尾部 compaction.state=null 可继承，[] 或独立快照明确阻断；目标删除/重新生成后补偿不残留。
- 状态/结果/回执/计量同事务，提交前不发成功事件，提交失败释放锁。
- 原助手缺失另一能力时不补伪记录；历史旁注不把缺失当作无变化。
- 状态调用计入会话 usage，主上下文仍关联原叙事 request；更新旧 seq 后页面能正确刷新。

### 14.3 完成标准

用户只管理一份预设，在三个页签分别调整编排和辅助模型。AI 帮答流式生成可编辑草稿，不留存调用结果、不计入会话 usage；独立状态更新使用新请求和共用状态处理准确提交补偿。三种运行共享可靠的会话互斥，各自的传输、保存和恢复边界明确。

本次交付仅为上述方案及计划，不包含业务代码实现、提交或发布。
