# SR 预设统一 load 与 getConfig 设计 v3

日期：2026-11-15。状态：提案，未实施。任务：[执行清单](./sr-preset-load-config-v3-tasks.md)。

本提案替代 v2 中 composer 脚本、条目 when/enabledWhen 和跨节点变量方案。沿用八类固有节点、配置 schema/ui/values、所有提示可见、无损迁移与冻结请求原则。不修改旧方案或现有实现。

## 1. 已实现的动态加载契约

核查来源：`apps/server/src/domain/world-card.ts`、`domain/state/atomic-schema.ts`、`domain/state/when.ts`、`runtime/context/activation.ts`、`runtime/context/prompt-builder.ts`；以及 `docs/world/world-card.md`、`test/activation.test.ts`、`test/state.test.ts`、`test/context.test.ts`。

### 1.1 共享 load

| 字段 | 类型/枚举 | 当前默认与行为 |
| --- | --- | --- |
| mode | always / on_mention / never | 默认 always；never 不激活 |
| keywords | 非空白字符串数组 | on_mention 必须至少一个 |
| keyword_logic | any / all | 默认 any；all 可跨不同消息分别命中 |
| exclude_keywords | 非空白字符串数组 | 默认无；只在 on_mention 下参与判断 |
| when | 受限表达式字符串 | 省略表示无附加条件；表达式结果必须为 boolean |

加载顺序：外部 enabled 门控（若该对象支持）→ never → on_mention 的排除词/正向词 → when → 激活。always 不表示忽略 when，只表示不检查关键词；always 下排除词也不参与判断。无额外随机激活、正则、递归扫描或独立 scan_depth 配置。

关键词按区分大小写的字面子串匹配。扫描集合来自 preparation 候选历史（可含摘要）及当前输入，正式权限以最终摘要、保留历史与当前输入为准；经过 narrativeForActivation 处理，兼容输入中的 instruction 部分不作为故事触发文本。模板、配置值、示例、已加载的世界书正文和本轮生成内容不加入扫描，也不触发递归激活。

### 1.2 各对象差异

| 对象 | 可加载内容 | 开关与排序 | 专有 load 字段 |
| --- | --- | --- | --- |
| 当前玩家/其他角色 | prompt；description 不注入 | 没有正式 enabled，使用 mode=never；其他角色按角色顶层 order，默认 0，同值原索引 | 无 |
| 世界书条目 | content | enabled=false 先禁用；排序按 load.order，默认 0，同值原索引 | order、anchor、position |
| global/session/message 状态项 | 当前值、定义、说明 | 没有 enabled；沿 scope 与定义枚举顺序处理；模型写入只针对激活 message 根 | 无 |
| 现有预设条目 | 内容或特殊 source | 有 enabled/数组顺序，但当前不是统一 load；Direct 强制骨架并忽略部分配置，Agent 多数 system 节点也不按普通开关处理 | 尚未实现 load |

世界书 anchor 可取 personaInfo/characterInfo/worldState/userInput，默认 characterInfo；position 默认 after，可选 before/after。目前这两个字段只控制 Agent 插入位置，Direct 将所有激活 lore 按 load.order 聚合为 world_info。字段仍保存和导出，不能宣称已删除。

角色 order 位于角色顶层，世界书 order 位于 load 内，不能混写。load 控制模型材料激活，不等同于创作者 SDK 状态访问授权。

### 1.3 现有 when

允许字面量、括号、!、一元正负、严格相等/不等、大小比较、数值算术、&&/||/??、三元，以及 getState(path, {scope})。

路径可以是字符串或字符串数组；未指定 scope 时查找 global → session → message 的第一个存在路径，推荐显式 scope。缺失路径返回 undefined；可用 ?? 容错。最终非 boolean、直接拿缺失值比较/取反等会报错。现有 getState 从状态视图读取，不要求目标本身已激活；不能在本次重构时静默改变这一点。

禁止赋值、循环、函数定义、自由变量、任意调用和属性链；这不是完整 JavaScript。表达式最多 4096 UTF-8 字节、256 个 AST 节点、路径最多 32 段，禁止 __proto__/prototype/constructor。求值前现有实现还限制状态快照序列化大小为 1 MiB。

语法错误导入时拒绝；运行时求值失败该材料不激活并返回诊断。现有部分 reason 分类较粗，不把诊断名称当稳定的语法分类 API。

实现细节存在差异：角色/世界书关键词仅检查非空白但保留原字符串，状态 load schema 对关键词执行 trim；状态 load 使用 strict 对象，而世界卡相应对象当前会处理掉未知字段。本次抽取复用不能顺手改变旧数据解析行为，应记录差异并用兼容测试锁定。

## 2. 预设直接复用 load

预设新条目使用相同五个字段，不再提供并行的 enabledWhen、顶层 when 或 composer。

```json
{
  "id": "actionSuggestions",
  "name": "行动建议",
  "slot": "actionSuggestions",
  "role": "system",
  "load": {
    "mode": "always",
    "when": "getConfig('suggestionCount') > 0"
  },
  "provides": {
    "actionSuggestions": {
      "count": {"expression": "getConfig('suggestionCount')"}
    }
  },
  "content": "提供 {{getConfig('suggestionCount')}} 条不同的行动建议。建议应符合当前局面，不替玩家执行，不保证成功，不提前改变状态。"
}
```

新格式不增加 enabled 双重开关；手动禁用用 load.mode=never。界面切换为 never 时保留 keywords/when，重新选择 always/on_mention 时旧配置仍在。旧 enabled=false 转成 never，原值与 load 保留在兼容备份中；原 on_mention 不得因默认恢复操作被无意丢失。

预设条目按数组顺序编排，不引入 load.order/anchor/position 的第二套排序；这些是世界书当前专有布局字段，不是所有材料的公共激活字段。必要的自定义条目通过数组插入合法位置。

角色/世界书先根据自己的 load 形成材料，预设 source 节点再根据自己的 load 决定是否注入：两者都满足才出现；预设不能强制加载 mode=never 的角色或 lore。

main/chatHistory/userInput 是本 Direct 布局的结构节点，要求 load.mode=always 且不允许条件门控，避免丢失输入或只按未发送的历史授权。提示内容仍可编辑，约束只针对结构。其他节点可采用通用 load；状态能力与来源绑定不完整时拒绝请求，不偷偷重启节点。

## 3. 预设专用 getConfig

签名：`getConfig(path: string | string[]): JsonValue | undefined`。只读、一个参数。沿用 getState 的路径风格和禁用路径规则，不加 scope、不加任意默认值参数、不加 setConfig。

```text
getConfig('suggestionCount')
getConfig('narrative.style')
getConfig(['narrative', 'style'])
(getConfig('optionalTone') ?? 'neutral') === 'neutral'
```

读取本次冻结的有效配置：schema 默认值 → 预设已保存值 → 当前会话覆盖。编辑预览最后叠加未保存草稿，但不修改正式运行。false、0、空字符串保留原值；null 仅在 schema 允许时合法；删除覆盖代表恢复继承。

函数只能读取当前预设 schema 声明的字段，不读取 app settings、其他预设、凭据、世界状态或任意数据库数据。未知路径视为配置引用错误，保存/导入时定位；声明了但可选且无值的字段返回 undefined。通过 ?? 设置可选项的缺省处理，不能用 fallback 掩盖字段拼写错误。

返回值保留 schema 类型，不自动将字符串 "4" 转成数字 4。父对象/数组可用于明确 JSON 输出；普通文本插值只接收 string/finite number/boolean，null、undefined、对象、数组须由显式条件、默认值或 JSON 格式化处理，避免得到 [object Object] 或意外空白。JSON 插值只能编码数据，不能把其中的 {{...}} 再解释成表达式。

同一个值引用允许出现在：预设 load.when、预设 content 插值/条件段、结构化 capability expression。插值使用 `{{getConfig('key')}}`；不要再同时维护 `{{config.key}}`、vars、setvar 等多套正式语法。旧的 {{user}} 保留兼容。

## 4. 共享表达式内核，区分允许的函数

| 位置 | 可用函数 | 最终结果 |
| --- | --- | --- |
| 角色/世界书/状态的 load.when | getState | boolean |
| 预设条目 load.when | getState、getConfig | boolean |
| 预设文本插值 | getConfig | 可呈现标量；JSON 输出另行显式处理 |
| 预设 capability.expression | getConfig | schema 要求的准确类型，例如 count 的 integer 2–4 |
| 预设条件文本段 | getConfig，以及只读有效能力查询 | boolean |

有效能力查询沿用模板的具名 effective 条件，不暴露任意自由变量访问。例如 main 中的条件段绑定 stateUpdate.required/actionSuggestions.enabled，在完成所有条目激活和能力验证后再求值。它不能参与 load.when，否则产生“是否加载依赖于加载后能力”的循环。

将解析、路径读取和运算逻辑提取为纯表达式内核，按使用位置提供明确函数白名单和返回类型验证。现有 validateWhen/evaluateWhen 仍是仅接受 getState、必须 boolean 的包装，避免扩大世界卡能力。预设新增自己的 validator 与环境，不通过往世界 state 塞 config 来伪装配置。

不要把所有白名单函数传给所有调用点。现有 AST 只允许 getState，必须显式扩展，不能声称当前已经支持 getConfig。函数实现不调用网络或可执行脚本；不添加 eval、Function 或 VM，不新增脚本 worker/解释器工作流。

保留旧 state 大小限额与表达式限额；新增单独的预设有效配置大小上限（建议 256 KiB UTF-8 JSON，进入正式契约前核对现有合法预设样本）。不将状态与配置混成一个 1 MiB 限额，以免原有世界突然不可运行。模板总大小/渲染结果还需独立资源限制与完整 token 预算。

## 5. 示例与一致性

### 单个参数化建议条目

config.suggestionCount 取 0/2/3/4。上面的 load.when 在 0 时为 false，不产生建议节点和能力；其他值加载并绑定相同 count。main 的信封/示例根据最终有效能力展开。无隐藏 platform=true。

### 多候选条目

```json
[
  {
    "id": "suggestions2",
    "name": "2 个行动建议",
    "slot": "actionSuggestions",
    "role": "system",
    "load": {"mode": "always", "when": "getConfig('suggestionCount') === 2"},
    "provides": {"actionSuggestions": {"count": 2}},
    "content": "提供两条行动建议：一个稳妥的方向，一个具有探索性的方向。"
  },
  {
    "id": "suggestions4",
    "name": "4 个行动建议",
    "slot": "actionSuggestions",
    "role": "system",
    "load": {"mode": "always", "when": "getConfig('suggestionCount') === 4"},
    "provides": {"actionSuggestions": {"count": 4}},
    "content": "提供四条不同的行动建议，覆盖交流、观察、探索和推进目标。"
  }
]
```

此例展示候选写法，完整候选方案还需同构的 suggestions3；不能与单条目方案同时作为默认启用项。一个请求最多一个 actionSuggestions 提供者，冲突报错而非后者覆盖。

### 关键词、配置和状态共同控制

```json
{
  "mode": "on_mention",
  "keywords": ["战斗", "攻击"],
  "keyword_logic": "any",
  "exclude_keywords": ["战斗结束"],
  "when": "getConfig('combatHints') === true && (getState('体力', {scope: 'message'}) ?? 0) > 0"
}
```

这要求 combatHints 在当前预设 schema 声明为 boolean。现有语义下“战斗结束”在扫描历史中出现会抑制激活，即使当前输入再次提到战斗；本次不悄悄改为仅扫描当前输入或正则状态机，应在 UI 清楚展示匹配来源。

## 6. 准备、错误和预览

冻结原始预设/有效配置/世界/状态/历史/输入 → 准备候选叙事扫描集合 → 分别计算世界材料与预设 load → 按数组顺序选条目 → 验证 provides 并计算有效能力 → 渲染模板 → 完整预算估算 → 按需一次压缩 → 以最终材料重算 → 冻结权限与请求。

getConfig 同一 Run 不随 await 或编辑改变；压缩后 getState 仍读冻结状态快照，关键词则按最终摘要/历史/输入重新判断。当前状态条件的既有语义不因模板渲染改变。

load.when 返回 false 是正常未加载；可选条目运行时条件求值错误沿用 fail-closed 并给出诊断；配置整体验证失败、未知引用、结构节点缺失、能力冲突或已选节点内容渲染失败则 preparation 失败。缺失协议文本不得回退到隐藏默认；已接受输入按现有 preparation journal 保存和失败结算。

预览展示：条目模式、关键词命中来源、排除原因、when 结果、getConfig 所读字段的默认/预设/会话来源、实际节点与能力。普通日志只输出安全诊断，不输出私有配置文本、故事或状态值。配置/预设节点不进入激活扫描，不存在加载自激活。

保留完整输入预算、100% 触发/60% 目标、单次 rolling summary、连续后缀及 Direct/Agent 分离；Agent continuation 不重算 load/getConfig。原扩展验证和权限、取消/提交语义不变。

## 7. 迁移与验收

v2 只是未实施提案，composer 无须作为既有生产格式进行数据迁移；若实际发现外部草稿依赖旧示意，应明确拒绝或人工转换，不运行它。真实旧预设 enabled/节点内容/能力开关按无损方案映射，保留原始数据与引用，Direct 历史强制开关差异需显式记录。

验收包括五字段跨对象行为一致、always 排除词忽略、never、跨消息 all、关键词大小写、压缩前后激活、玩家 never、词条 trim 差异；配置 0/false/null/缺失/拼写错误、冻结覆盖、路径数组及原型禁用；世界卡仍拒绝 getConfig；预设同时支持 getState/getConfig；插值不二次执行；0/2/3/4 的条目/骨架/示例/运行时能力完全一致。

实际 Provider payload 通过本地 mock 验证，不仅检查 trace。方案实施后才更新正式 docs 与 AGENTS。当前仅源码/文档/已有测试审阅与方案文件检查，未运行测试或修改实现。
