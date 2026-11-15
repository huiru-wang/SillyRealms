# SR 无脚本预设配置方案 v4

日期：2026-11-15。状态：设计方案已保存，尚未实施。

- [完整默认预设配置](./sr-default-preset-v4.example.json)
- [实施任务](./sr-preset-declarative-v4-tasks.md)

## 1. 当前方案与历史提案的关系

本文保存本次讨论的最新结论，作为后续实施依据。配置文件是新格式设计示例，不是当前 API 可直接导入的文件。schemaVersion=2 是拟议的预设格式版本，与本文 v4、数据库版本、世界卡版本分别管理。

本文取代前面预设 v1/v2/v3 提案中与以下结论冲突的内容：

1. 不使用 composer、自定义脚本、变量赋值、脚本解释器或跨节点可变变量。
2. 预设加载条件、模板和能力表达式只能通过 getConfig 读取当前预设配置，不允许 getState、context.state、source 变量等状态访问途径。
3. 世界状态保留为 Server 管理的固定材料插槽。Server 注入状态供模型使用，不向预设表达式暴露状态值、路径或快照。
4. 新条目统一使用 load，不再引入 enabledWhen、顶层 when 或另一套 enabled 开关。
5. 第一版不允许配置值使用 null；恢复继承通过移除覆盖项表达。旧状态值中的 null 不受此限制影响。

历史文件保留以便追溯，不代表其中的脚本或预设 getState 设计仍有效。尤其 `sr-preset-load-config-v3.md` 中允许预设混用 getState/getConfig 的内容已被用户明确否定。

## 2. 产品结构与八类节点

预设包括名称、描述、上下文策略、模型参数、配置 schema/ui/values、有序提示词条目。所有 SR 编写的自然语言规则、包装和示例保存在预设中，不在编译器前后添加隐藏提示。

| 顺序 | ID | 作用与角色 |
| --- | --- | --- |
| 1 | main | system；基础叙事、文风、整体输出协议 |
| 2 | personaInfo | system；当前玩家角色通过世界卡 load 筛选后的 prompt |
| 3 | characterInfo | system；其他激活角色 prompt |
| 4 | worldInfo | system；激活世界书内容 |
| 5 | chatHistory | 原消息角色；摘要及保留历史 |
| 6 | worldState | system；Server 当前状态插槽、状态使用与更新说明 |
| 7 | actionSuggestions | system；行动建议规则和偏好，条件加载 |
| 8 | userInput | user；本轮输入原文 |

数组顺序就是编排顺序。允许添加自定义文本条目并插入合法位置；不增加另一套 order/anchor 排序。main/chatHistory/userInput 为布局结构节点，要求 always 且不允许条件门控；当前输入保持最后，历史角色和内部顺序保持原样，状态材料位于历史后。文字可编辑，结构约束不能被模板修改绕过。

普通用户使用配置面板；作者编辑 schema、面板和节点。预览展示入选条目、实际消息、配置来源、能力结果和未加载原因，不自动调用模型。保存失败保留草稿；进行中的 Run 使用冻结版本，编辑下一轮生效。

## 3. load 与当前世界卡保持一致

| 字段 | 值/默认行为 |
| --- | --- |
| mode | always/on_mention/never，默认 always |
| keywords | 字符串数组，on_mention 至少一个非空白关键词 |
| keyword_logic | any/all，默认 any |
| exclude_keywords | 字符串数组，仅 on_mention 生效，任一命中则不加载 |
| when | 受限表达式，结果必须是 boolean |

always 仍检查 when，但忽略关键词与排除词。关键词按区分大小写的子串匹配，all 可以跨消息命中。扫描 preparation 采用的摘要、保留历史、当前输入的叙事投影；不扫描所有数据库历史、不扫描配置或提示内容、不递归激活。最终权限仅由最终材料确定。

角色、世界书、状态已有 load 行为不改变：角色注入 prompt 而非 description，角色排序使用顶层 order；世界书有 enabled 和 load.order/anchor/position，anchor/position 当前仅作用于 Agent；状态加载不等于创作者 SDK 授权。角色/世界书/状态原有 when 可使用 getState，但预设的 when 不允许。

新预设手动关闭条目使用 mode=never，保留原 keywords/when。旧 enabled 转换时备份原值及原 load；不修改世界书现有 enabled 语义。旧关键词 trim 与 schema strict 差异需用回归测试保持，不随重构静默统一。

## 4. getConfig 与表达式边界

签名：`getConfig(path: string | string[]): JsonValue | undefined`。

```text
getConfig('suggestionCount')
getConfig('narrative.style')
getConfig(['narrative', 'style'])
(getConfig('optionalTone') ?? '自然') === '自然'
```

仅读取当前预设 schema 声明的配置。合并顺序：Schema 默认值 → 预设保存值 → 当前会话覆盖；编辑预览可额外叠加草稿。0、false、空字符串、空数组均保留原值。对象逐字段合并，数组整项替换；移除会话覆盖字段恢复继承。

字段未声明时报引用错误；已声明的可选字段无值时返回 undefined，可以使用 ??。不自动把 "4" 转成数字。配置值必须先经 schema 校验，再冻结为本轮只读快照。禁止读取其他预设、应用设置、凭据或任意数据库数据。

| 位置 | 允许内容/返回要求 |
| --- | --- |
| 角色/世界书/状态 load.when | 现有 getState 表达式，保持原样 |
| 预设 load.when | 只有 getConfig；必须返回 boolean |
| UI visibleWhen | 只有 getConfig；必须返回 boolean |
| 预设模板插值和条件 | 只有 getConfig；条件必须 boolean |
| provides.expression | 只有 getConfig；必须返回能力字段要求的类型 |

沿用有限字面量、括号、比较、数值算术、!、&&/||/??、三元表达式；无自由变量、赋值、循环、任意函数调用和属性链。与现有状态表达式共享纯求值基础设施，但函数白名单按调用位置隔离，不能将 getState 暴露给预设。保持表达式字节、AST、路径及原型访问限制，新增配置与输出独立大小上限。

模板支持：`{{getConfig('key')}}`、`{{#if 布尔表达式}}…{{else}}…{{/if}}`、`{{getConfig('array') | json}}`。普通插值仅接受字符串、有限数字和布尔值；数组/对象必须显式 JSON 序列化，undefined 必须处理。json 是固定格式化操作，不是任意函数调用。插入数据不进行二次模板执行，JSON 编码须处理边界字符与行分隔符。

保留旧 {{user}} 的兼容范围，不扩展成读取世界状态的入口。预设导入/保存中出现 getState 或其他非白名单调用直接拒绝。

## 5. 配置类型与参数

| 配置项 | Schema 类型 | 控件 | 主要参数 |
| --- | --- | --- | --- |
| 开关 | boolean | switch | default |
| 整数 | integer | number/slider | minimum、maximum、multipleOf、default |
| 小数 | number | number/slider | minimum、maximum、multipleOf、default |
| 单行文本 | string | text | minLength、maxLength、default |
| 多行文本 | string | textarea | minLength、maxLength、default |
| 单选 | string/integer + enum | select/radio | enum、default；UI options |
| 多选 | array，元素为枚举 string/integer | multiselect | items.enum、uniqueItems、minItems、maxItems、default |
| 分组容器 | object | 已声明字段分组 | properties、required、additionalProperties |

采用有版本的 JSON Schema 子集。required 属于对象，控制字段是否必须存在；default 由 SR 显式填充，不假设验证器自行写入。minimum/maximum 含边界，multipleOf 控制合法步进，小数校验不得因普通浮点误差错误拒绝合法输入。文本长度按 Unicode 码点，前后端一致。

不开放 null、任意 JSON 编辑、文件上传、可执行代码或任意对象列表。对象仅组织已声明字段；所有 schema 默认值和用户值都需验证。

### 使用示例

```text
开关条件：getConfig('stateUpdates') === true
数字插值：正文篇幅偏好约为 {{getConfig('targetLength')}} 字。
文本条件：getConfig('customInstructions') !== ''
单选条件：getConfig('style') === 'restrained'
多选输出：描写重点为 {{getConfig('focus') | json}}。
嵌套读取：{{getConfig('narrative.style')}}
可选默认：{{getConfig('optionalTone') ?? '自然'}}
```

数值没有隐含的模型行为。字数、细腻度等作为偏好需在提示中解释；实际模型温度/预算属于类型化运行设置，不能通过文字或任意配置字段悄悄覆盖。

## 6. UI 参数与用户值

| 参数 | 用途 |
| --- | --- |
| key | Schema 字段路径 |
| label | 显示名称 |
| description | 帮助说明，不自动进入提示词 |
| group | 页面分组 |
| control | 控件类型 |
| placeholder | 输入提示，不是默认值 |
| options | 单选/多选的 value 与 label，value 保留原类型 |
| unit | 数值显示单位，不改变数据 |
| visibleWhen | 只读配置条件，只影响界面显示 |

Schema 是类型、边界、默认值的唯一来源，UI 不重复存储 min/max/step/default。UI options 必须与 schema enum 对应。隐藏字段保留值，不自动停用功能；真正的节点启用由 load 判断。UI 的分组仅排版，不产生作用域。

config.values 单独保存用户选择，不与面板定义混存为同一个对象。导出定义和预设值，不带会话覆盖、世界快照、历史或凭据。保存使用 revision 冲突检查，配置 schema 改动保留旧值备份并定位不兼容字段，不能静默丢弃。

## 7. 固定 source 插槽与能力

source 是 Server 识别的固定绑定，不是表达式变量。为 source 节点先渲染预设 before/after，再由 Server 直接插入材料。角色/世界书来自自身 load 结果，不能被预设强制激活；历史保持原始角色与叙事投影；输入原样插入，不模板化。

`state.current` 插槽直接生成 current_state/writable_state/readonly_state 的结构化 JSON 数据。Server 根据最终激活范围及有效状态更新开关划分可写和只读；关闭更新时 message 状态也归只读。数据 serializer 不添加自然语言规则，全部说明在预设 before/after 中。

预设不能通过 {{source}}、getState、context.state 或其他间接函数取得这些状态数据。最终请求预览由 Host 展示，不能作为预设表达式输入，不向创作者 iframe 增加访问权限。

provides 是结构化能力声明，不从自然语言猜测：

```json
{
  "load": {
    "mode": "always",
    "when": "getConfig('suggestionCount') > 0"
  },
  "provides": {
    "actionSuggestions": {
      "count": {"expression": "getConfig('suggestionCount')"}
    }
  }
}
```

先确定入选节点和能力，再渲染。建议关闭时不加载对应节点，也不要求该子块；状态 required 仍由 Server 根据有效开关与最终激活 message 根确定。默认文案明确“可写列表为空则不输出 state_update”，不通过预设查询状态来判断。

main 定义单信封、顺序、JSON 和闭合规则，worldState/actionSuggestions 各自说明本轮子块要求。无子块时仅故事；两个子块同时存在时状态在前。相同能力多个提供者报错，不采用后者覆盖。

自由编辑提示不能保证语义自动正确。应验证实际展开提示与 mock 输出的协议组合，严禁靠运行时隐藏补丁修复文案。保留严格信封、状态权限、逐项验证、建议失败隔离及取消提交边界。

## 8. 运行与兼容

冻结来源和有效配置 → 准备候选历史材料 → 计算世界材料 load 与预设配置 load → 按条目数组筛选 → 验证能力 → 渲染完整请求 → 估算 → 必要时一次压缩 → 按最终历史重算 → 冻结权限和 Provider 请求。

保留当前输入上限、100% 触发/60% 目标、rolling summary 最多一次完整调用、连续历史后缀、preparation journal 原子交接和失败结算。Direct 不注册工具，Agent continuation 不重新压缩/加载。不支持历史后 system 的 Provider 继续按现有契约拒绝，不能暗中改序。

旧 Agent 保持独立执行和工具说明，不因这份 Direct 默认预设被删除或改造成 Direct；迁移将其说明物化进可见模式配置，保留旧工具语义和 lore 锚点。摘要规则由预设 contextPolicy.summary 管理，不加第九个主节点；保留 gap 与来源信息。模型诊断提示也须显式管理，不能成为隐藏故事提示。

旧默认 main 为空、Direct 固定顺序、平台强制开关、summary_prompt 前后硬编码等在实施时统一迁入可见预设定义。保留 IDs、引用、原文、未生效兼容内容、标签、预算、模型参数、会话和状态。Direct 保存 false 而实际 true 的旧会话需要迁移报告及显式保真覆盖，不能静默改变行为或继续隐藏强制 true。

## 9. 验收与本轮交付

验证 schema 类型、默认值、覆盖、0/false/空字符串/空数组、Unicode 长度、小数步进、未知引用、UI 显示条件与功能开关独立性；验证所有预设入口拒绝状态读取和非白名单调用，状态只由固定 source 注入；验证建议 0/2/3/4 与状态开启/关闭/无可写根的组合；验证同名 scope、mode=never、压缩后的激活变化、await 期间配置编辑和实际 Provider payload。

检查迁移保真、导入导出 round-trip、保存冲突、保存失败留草稿，以及 375px/1280px、键盘/加载/空/错误状态。运行相关定向测试、根 typecheck/lint/test/build 与浏览器流程，仅用临时 DB 和 mock Provider。

本轮只保存方案、完整示例 JSON 和任务清单。未修改源代码、正式 docs、AGENTS 或用户数据库，也未执行测试、迁移、提交或真实模型调用。
