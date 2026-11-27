# 世界卡格式参考

本页对应当前仓库的导入器。世界卡只接受 `spec_version: "0.2"`，不兼容旧格式或旧字段；状态定义另有 `schema_version: 2`，公开版本目录使用 `schema_version: 1`。这些版本与作者的 `publication.release.version` 各自独立。

先做作品请读[第一张世界卡](../creator/first-world.md)；正式发行字段见 [0.2 示例](../world-card.json)，[最小示例](../../examples/worlds/minimal/world.json)与[雾港来信](../../examples/worlds/fog-harbor/world.json)均使用同一当前格式。字段校验以[世界卡校验器](../../apps/server/src/modules/worlds/validation.ts)、[状态校验器](../../packages/sr-sdk/src/state-validation.ts)为准；通过 `pnpm world:check` 使用实际契约检查。

## 目录

- [根结构](#根结构)
- [作品发行信息](#作品发行信息)
- [角色](#角色)
- [角色立绘](#角色立绘)
- [开局](#开局)
- [世界书](#世界书)
- [加载条件](#加载条件)
- [状态定义](#状态定义)
- [组件与挂载](#组件与挂载)
- [消息显示规则](#消息显示规则)
- [资源和大小限制](#资源和大小限制)
- [导入与运行边界](#导入与运行边界)

## 根结构

~~~json
{
  "spec_version": "0.2",
  "data": {
    "name": "我的世界",
    "publication": {
      "package_id": "8da0e392-2ea6-4ac1-a93a-b94abf6828a1",
      "authors": [{"name": "世界作者"}],
      "release": {
        "version": "1.0.0",
        "published_at": "2026-11-26T12:00:00+08:00",
        "notes": "首次公开发行。"
      }
    },
    "characters": [
      {"id": "traveler", "name": "旅人", "player_selectable": true}
    ],
    "openings": [
      {"id": "arrival", "name": "抵达", "content": "你来到了雾港。"}
    ]
  }
}
~~~

这是 0.2 正式卡的结构最小值，示例 UUID 应替换为自己作品首次生成并长期保留的值。实际作品应补充角色 content 和世界资料，让模型知道应该怎样继续故事。每张卡都必须声明 publication；不配置 update_url 即可作为离线作品使用。

| 字段（位于 data） | 必填 | 类型 / 约束 |
| --- | --- | --- |
| `name` | 是 | 去掉首尾空白后非空的字符串 |
| `publication` | 是 | 固定结构的作品发行信息 |
| `characters` | 是 | 角色数组，至少一项可扮演，数组内 ID 唯一 |
| `openings` | 是 | 至少一个开局，数组内 ID 唯一 |
| `presentation` | 否 | 世界介绍，使用 Markdown 文本或组件展示对象，见下文 |
| `cover` | 否 | 图片地址字符串；包内素材用 sr-asset URI |
| `tags` | 否 | 非空字符串数组 |
| `lorebook` | 否 | `{entries: [...世界书条目]}` |
| `state` | 否 | 状态 v2 定义 |
| `components` | 否 | 组件声明数组，最多 100 项 |
| `stage_component` | 否 | 已登记的组件 ID |
| `message_render` | 否 | `{rules: [...显示规则]}` |
| `extensions` | 否 | 扩展元数据对象；平台识别已约定的保留键，其余作者元数据原样保留 |

不要在世界卡中加入模型 Key、运行时会话数据或本机默认配置 ID。`data.ui` 不被接受。固定结构中的未知字段会在导入时报错。自定义作者扩展放在 extensions，并在作品说明中解释；正式作品身份、作者和发行版本使用 publication。

### 正文、展示与说明

世界卡使用三种明确的字段语义：

| 字段 | 含义 |
| --- | --- |
| `content` | 角色、开局、世界书的正文；是否进入上下文由各自业务规则决定 |
| `presentation` | 世界介绍、角色介绍和开局预览的展示配置，不自动注入模型 |
| `description` | 状态、立绘等对象的纯文本语义说明，可由对应模块组织进模型材料 |

三种介绍入口共用以下结构，不接受字符串简写、空对象或 HTML 类型：

~~~ts
type Presentation =
  | { type: 'markdown'; text: string }
  | { type: 'component'; component: string };
~~~

Markdown 的 text 必须非空且不超过 100000 UTF-8 字节，纯文本也使用这个分支；包内图片使用 sr-asset URI 并随 ZIP 分发。组件分支只接受已登记的组件 ID，不在这里内联源码。presentation 不执行角色正文的提示词变量替换。未提供时省略字段；已配置但加载失败时显示错误与重试，不静默回退到另一份正文。

世界没有 presentation 时显示暂无介绍；角色没有 presentation 时不展示可能含隐藏设定的 content；开局没有 presentation 时展示公开的 content。角色 content 不因有无介绍而改变原有 load、排序或变量规则。

旧 data.description、角色 prompt/description、开局平铺 type/component 和消息替换中的 content 均被拒绝，不静默丢弃。消息显示替换保留外层 replacement，舞台保留 stage_component；它们不改名为 presentation。状态与立绘的 description 仍为字符串。

### 封面马赛克

`data.extensions.cover_mosaic_enabled` 是可选布尔值，缺省为 `false`。设置为 `true` 时，平台对这张世界卡的封面启用马赛克显示；密度由应用的全局设置决定，不随世界卡携带。

~~~json
{
  "extensions": {
    "cover_mosaic_enabled": true,
    "author": { "version": "1.0" }
  }
}
~~~

管理界面修改开关只合并这一保留键，保留其他扩展数据。普通导出保存当前的显式 `true` 或 `false`，重新导入后沿用；下载原件返回当前安装版的原始字节；实际应用发行版后对应选中发行文件。开关不修改封面图片或包内素材，也不增加作者代码权限。该键只接受布尔值，不接受字符串、数字或 `null`。

## 作品发行信息

`data.publication` 对应公开类型 `WorldPublication`，只描述随卡分发的作品身份、署名、说明、当前发行版和公开更新入口。它不保存本地安装记录、检查状态、远端全版本目录、用户设置或运行状态。

~~~json
{
  "package_id": "8da0e392-2ea6-4ac1-a93a-b94abf6828a1",
  "authors": [
    { "name": "世界作者", "url": "https://creator.example.org/" }
  ],
  "creator_notes": "建议先阅读开局说明，素材致谢见作品主页。",
  "release": {
    "version": "1.2.0",
    "published_at": "2026-11-26T12:00:00+08:00",
    "notes": "新增港口角色，修复背包展示。"
  },
  "homepage": "https://creator.example.org/my-world/",
  "update_url": "https://cdn.example.org/worlds/my-world/releases.json"
}
~~~

| 字段 | 约束与含义 |
| --- | --- |
| `package_id` | 必填规范小写 UUID；标识作者作品，发版、改名与回退不变，不等于本机 worldId |
| `authors` | 至少一位，按数组顺序署名；每项 `name` 非空，`url` 可选 HTTP(S) |
| `creator_notes` | 可省略，缺省为空字符串；整体玩法建议、说明与致谢 |
| `release.version` | 稳定 `MAJOR.MINOR.PATCH`，三段均为非负安全整数，不允许多余前导零 |
| `release.published_at` | 带时区的 ISO 8601 发行时间 |
| `release.notes` | 本版更新说明，允许空字符串；与 creator_notes 分别保存和展示 |
| `homepage` | 可选 HTTP(S) 作品页面，面向人阅读 |
| `update_url` | 可选固定公开 HTTPS 全版本目录地址，面向程序，不使用用户凭据或 URL 片段 |

publication、authors 各项及 release 均拒绝未知键；其他作者扩展继续放在 `data.extensions`。作者署名不是账号认证。publication 不参与叙事提示词构建，不能用作者说明替代角色 content 或世界书。

`1.10.0` 大于 `1.9.0`，按数字段比较；不接受 `v1.2.0`、`1.2`、`01.2.0`、`1.2.0-beta`、`1.2.0+build` 或自由文本。作品 ID 与版本绑定不可变发行文件，包内内容变化应发布新版本。发布时间与本地管理的 revision 都不参与版本大小比较。

每张卡必须提供完整 publication；不接受 0.1 卡，也不从旧 `extensions.authoring.revision`、昵称或卡名猜测正式版本/身份。既有 extensions 保持自定义用途。普通导入和导出保留正式发行信息，导出不包含本地远端目录缓存。

完整历史及最终 ZIP 的 SHA-256/字节数放在包外版本目录，不嵌入 publication，避免 ZIP 包含自身哈希。目录获取、不可变性与指定版本覆盖见[开放 OTA 协议](world-updates.md)，可复制的发版命令见[作者发行指南](../creator/world-publishing.md)。

## 角色

每项至少有非空 `id/name`。至少一项 `player_selectable` 必须显式为 true。

| 字段 | 类型 / 含义 |
| --- | --- |
| `id` | 稳定标识，角色数组内唯一 |
| `name` | 显示名称；选中身份名称用于 `{{user}}` |
| `presentation` | 可选展示对象，玩家可读角色介绍；省略时不展示 content |
| `content` | 可选字符串，进入人物/玩家身份材料 |
| `avatar` | 可选图片地址 |
| `sprites` | 可选立绘素材数组；非空时必须含 ID 为 default 的素材 |
| `player_selectable` | 可选布尔，是否可被玩家选择 |
| `order` | 可选整数，角色材料排序；默认 0 |
| `load` | 可选加载条件 |

角色 content 支持精确 `{{user}}`、本轮可见的 state 字段插值，以及[作者正文条件模板](#作者正文模板)。选中角色通过其 load 后，在预设实际引用 `persona.content` 时渲染为玩家身份材料；其他激活角色在实际引用 `characters.content` 时渲染为人物材料。存储的 content 始终保留原始模板。详见[组织世界内容](../creator/world-content.md)。

### 角色立绘

在角色内声明素材。表情、姿态或服装的变化分别对应一张素材，由模型选择其 ID：

~~~json
{
  "id": "alice",
  "name": "爱丽丝",
  "sprites": [
    {
      "id": "default",
      "asset": "sr-asset://assets/characters/alice/default.webp",
      "description": "平静站立，适合日常交流。"
    },
    {
      "id": "restrained_smile",
      "asset": "sr-asset://assets/characters/alice/restrained-smile.webp",
      "description": "勉强微笑，适合掩饰担忧或安慰他人。"
    }
  ]
}
~~~

| 素材字段 | 约束 |
| --- | --- |
| `id` | 非空，角色内部唯一；非空素材数组必须有 default。不同角色可以各自使用 default |
| `asset` | 非空的 HTTP(S) URL，或安全的 sr-asset://assets/ 包内资源引用 |
| `description` | 非空文本，说明模型应在什么情境选择这张素材 |

素材对象只接受以上三个字段；`sprites` 可以省略或为 []。角色 ID 和素材 ID 是消息结果引用的稳定标识。立绘无需另设 emotion 字段，也不在素材中指定左右槽位、CSS 或组件名。

目录包含全卡已声明的素材。角色 load 只控制角色 content 加载，不过滤立绘目录；素材说明是可被模型读取的选择资料，不应承担剧情解锁或隐藏信息的职责。节点启用后，模型材料只包含角色 ID/姓名、素材 ID/说明和当前玩家角色 ID，图片地址用于资源读取。

引用包内图片时，必须将文件放进 ZIP 的对应 assets/ 路径。导入、导出、`world:check` 与打包都会检查声明的包内资源；单独 JSON 导入不能引用包内文件。在线地址只校验 URI，不在导入时下载或探测。

每轮显示哪些角色、使用哪张图和哪个语义位置，由立绘 prompt 与本轮故事决定。模型输出使用独立的 character_sprite JSONL 快照，见[预设中的角色立绘](../creator/presets-and-models.md#角色立绘)。七种位置可供不同前端布局消费，不依赖视觉小说模式。开局消息不会自动生成立绘快照。

会话宿主按消息结果展示悬浮立绘。建议使用自带透明轮廓的 PNG 或 WebP；图片保持原有比例和背景。玩家通过输入框左上方的「立绘」开关控制展示。

## 开局

| 字段 | 必填 | 类型 / 含义 |
| --- | --- | --- |
| `id/name/content` | 是 | 非空字符串；id 在开局数组内唯一 |
| `initial_state` | 否 | message 根名到完整初值的对象 |
| `presentation` | 否 | 开局预览展示对象；省略时展示公开的 content |

content 在创建会话时作为第一条助手消息保存，精确 `{{user}}` 替换一次；创建会话不生成模型开场。initial_state 只能覆盖已声明的 message 根，按整根替换并校验值；没覆盖的根使用定义初值。

presentation 只影响世界详情中的开局预览，不能替代首条助手消息，也不会作为独立节点在每轮重复注入。预览组件不能执行会话初始化、读取 session/message 或代替平台创建会话。

## 世界书

`lorebook.entries` 每项包含：

| 字段 | 类型 / 含义 |
| --- | --- |
| `id` | 必填非空字符串，数组内唯一 |
| `content` | 必填非空字符串，模型可用资料 |
| `title` | 可选字符串，用于阅读与管理 |
| `enabled` | 可选布尔；false 关闭条目 |
| `load` | 加载条件，额外允许整数 order |

order 默认 0，同值保留原数组顺序。条目 content 与角色 content 一样支持作者变量和条件模板，通过 load 后，在预设实际引用 `world.lore` 时渲染。资料被加载不意味着故事中对应事件发生或人物已经知情。

## 加载条件

角色、世界书、状态根使用同类 load。省略 load 默认激活；世界书的 enabled=false 可单独禁用。

| 字段 | 含义 |
| --- | --- |
| `mode` | always / on_mention / never；省略与 always 相同 |
| `keywords` | 非空字符串数组；on_mention 必须有至少一项 |
| `keyword_logic` | any / all，默认 any |
| `exclude_keywords` | on_mention 中，命中任意项就排除 |
| `when` | 与模式结果一起满足的只读状态条件 |
| `order` | 仅世界书 load 支持的排序整数 |

关键词是区分大小写的字面匹配，范围为当前准备的摘要、保留历史和本轮输入。always 仍受 when 约束；never 不加载。它不是在场人物识别或“仅匹配最后一句”的保证。

~~~text
getState('coins', {scope: 'message'}) >= 5
getState('route', {scope: 'session'}) === 'lighthouse'
~~~

when 仅允许安全子集：字符串、数字、布尔、null、`! + -` 一元运算、比较、算术、严格相等、`&& || ??` 和三元表达式。函数调用只允许 getState；路径可用字符串或字符串字面量数组。不提供赋值、循环、网络或其他 JavaScript 函数。详见[表达式参考](../sdk/tooling.md#sillyrealmssdkwhen-expression)及[实现](../../packages/sr-sdk/src/when-expression.ts)。

## 作者正文模板

适用字段仅为 `data.characters[].content` 和 `data.lorebook.entries[].content`。角色被选为玩家身份时同样适用。字段类型仍为字符串，主叙事与 AI 帮答在材料构建阶段使用同一渲染规则。原始 content 在导入、存储和导出时保留，不持久化本轮渲染结果。

### 条件与变量

~~~text
{% if getState('affinity', {scope: 'message'}) >= 80 %}
非常亲近{{user}}。
{% elif getState('affinity', {scope: 'message'}) >= 60 %}
已经信任{{user}}。
{% else %}
对{{user}}保持戒心。
{% endif %}
~~~

`if` 和 `elif` 必须带非空条件，`else` 和 `endif` 不接受参数。每组按顺序选择第一个结果为 true 的分支；else 可省略且最多一个，只能位于最后。支持连续多个条件组及嵌套，单份 content 最多 32 层、256 个 if/elif 条件。

条件复用[加载条件](#加载条件)的受限表达式，结果必须是 boolean；不允许赋值、循环、网络或任意函数调用。状态来源为本轮捕获的完整 global/session/message 视图，与 load.when 一致。建议总是显式指定 scope；省略时按 global、session、message 查找首个存在路径。

正文中的精确 `{{user}}` 和 `{{state.global.…}}` / `{{state.session.…}}` / `{{state.message.…}}` 沿用作者变量规则：状态根必须属于本轮可见根；不存在、无效或未加载的路径输出空字符串。字符串直接插入，其他 JSON 值序列化；未知普通 `{{…}}` 占位符保留原文。状态根的 load 不限制条件读取，但限制状态插值与原有 message 更新授权。

### 解析、执行与错误

- 导入和世界内容校验检查全部条件块的配对、指令、表达式及数量/深度上限，包括未执行分支；不会求值、初始化状态或展开普通变量。
- 运行时保留现有 load 筛选与状态根选择，仅在本候选实际编译的预设节点引用 `persona.content`、`characters.content` 或 `world.lore` 时解释对应材料的原始模板。关闭/跳过的节点和未引用变量不触发正文条件；启用的自定义节点同样可消费材料，不能按固定节点 ID 判断。同一候选内复用同一材料的渲染结果。每组只检查直到首个命中的条件，嵌套条件只在父分支选中时求值；仅选中分支执行变量替换。替换结果与组装后的消息不再扫描，状态值中带有模板语法也不会执行。
- 条件表达式异常会使本次上下文准备失败，不视为 false，也不跳到 else。允许缺失值时作者应显式使用 `??`，例如 `(getState('affinity', {scope: 'message'}) ?? 0) >= 60`。
- 新值从下一次上下文构建生效；渲染不写状态、不重写世界卡，也不改变模型状态更新范围。
- 未知 `{% … %}` 指令或未配对块是语法错误。需要字面起始标记时写 `\{%`，仅消耗紧邻标记的一个反斜杠，其他反斜杠保持原样；JSON 字符串写为 `"\\{% ... %}"`。条件内引号包围的 `%}` 属于字符串，不结束指令。
- 错误位置使用指令开头的 1-based 行/列。导入通过卡片错误的字段路径报告；运行期在服务端 `context.failed` 诊断保留来源字段与位置，主叙事沿用 `invalid_context` 停止原因。

开局 content、presentation、预设节点、历史与模型回复不执行此条件模板。开局仍只在创建时替换精确 `{{user}}`；预设继续使用自身严格变量语法。正文模板不执行 EJS，完整状态定义与用法见[创作教程](../creator/world-content.md)。

## 状态定义

~~~json
{
  "schema_version": 2,
  "scopes": {
    "message": {
      "coins": {
        "type": "number",
        "initial": 12,
        "description": "旅人的金币。",
        "min": 0,
        "rules": {"coins": "确认收支后更新余额；报价和计划不改变金币。"}
      }
    }
  }
}
~~~

scopes 可包含 global、session、message。每个根定义：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `type` | 是 | string / number / boolean / json |
| `initial` | 是 | 符合 type 的 JSON 值；json 可为数组或对象等安全 JSON |
| `description` | 是 | 非空字符串，说明含义 |
| `min/max` | 否 | 仅 number，有限数字，范围合法 |
| `rules` | 否 | 规则路径到非空文本的对象，可为空 |
| `load` | 否 | 同上加载条件 |

根名和对象字段允许中文，但不能含点号或方括号，不能使用 `__proto__/prototype/constructor`。规则路径可写 `hero.name`、`clues[]` 等；数组元素规则只描述语义，不成为可直接写入的路径，也不要求每个字段都有规则。

主叙事只更新本轮激活的 message 根。SDK 可按已有路径提交允许的作用域写入；生成期间受运行锁约束。数组按完整字段替换，不支持数组下标或 add/remove 操作协议。具体示例见[状态与规则](../creator/state-and-rules.md)，精确运行契约见[状态 v2](../runtime/state-v2.md)。

## 组件与挂载

组件声明形式：

~~~json
{"id": "HarborStage", "path": "sr-asset://components/HarborStage.tsx"}
~~~

或使用 `component` 字符串存放内联 TSX。至少提供 path 或非空 component；同时提供时 path 优先，读取失败不回退。组件 ID 满足 `^[A-Za-z_$][A-Za-z0-9_$-]*$`，数组内唯一。

| 挂载位置 | 引用 |
| --- | --- |
| 世界介绍 | `data.presentation: {type:"component", component:"Introduction"}` |
| 角色介绍 | `characters[].presentation: {type:"component", component:"CharacterIntroduction"}` |
| 开局预览 | `openings[].presentation: {type:"component", component:"OpeningPreview"}` |
| 会话舞台 | `stage_component: "HarborStage"` |
| 消息片段 | 显示规则的 replacement.component |

所有显式组件引用都必须存在；stage_component 也不例外。不指定 stage_component 才使用官方舞台。仅登记组件不会自动挂载。

每个模块必须默认导出；内部依赖通过 `./组件ID` 默认静态导入。允许的外部模块为 react、react-dom/client、react/jsx-runtime 和 @sillyrealms/sdk；通常只需 React 和 SDK。不支持任意 npm 包、SDK 子路径、动态 import、require、转发导出或循环依赖。[编译规则](../../packages/sr-ui-compiler/src/modules.ts)

世界介绍、角色介绍和开局预览只有受限只读 global API，舞台才有会话/历史/状态操作。两个环境不是同一权限集。具体接口见[SDK 手册](../sdk/README.md)。

## 消息显示规则

`data.message_render.rules` 最多 100 项，每项包含：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `id` | 是 | 非空，规则数组内唯一 |
| `name` | 否 | 显示名称 |
| `roles` | 是 | 非空数组，user / assistant |
| `pattern` | 是 | 正则字符串，长度 1–2000 |
| `flags` | 否 | 默认 g，只允许 g/i/m/s/u 且不重复 |
| `replacement` | 是 | markdown/html 的 text，或 component 的组件 ID |

replacement 为 `{type:"markdown",text:"..."}`、`{type:"html",text:"..."}` 或 `{type:"component",component:"..."}`。文本替换内容最多 100000 UTF-8 字节。组件接收 match、groups、namedGroups、message、runId；第一个捕获组是 groups[0]。

规则用于官方正文渲染链路。自定义舞台如果不使用相关正文组件，平台不会自动把规则插入作者布局。显示替换不改写持久正文或状态。[完整使用方法](../sdk/components.md)

## 资源和大小限制

| 对象 | 当前限制 |
| --- | --- |
| world.json | 10 MiB |
| 上传 ZIP | 256 MiB |
| ZIP 解压内容 | 1 GiB |
| ZIP 条目 / 文件目录总数 | 10000 |
| 单个组件源码 | 1 MiB |
| 组件源码合计 | 2 MiB |
| 组件 / 消息规则数量 | 各最多 100 |
| 状态值/定义大小与深度 | 由共享状态校验器检查；1 MiB、32 层 |
| when / 正文模板单个条件 | 4096 UTF-8 字节、256 个受检节点；状态路径最多 32 段 |
| 每份角色/世界书正文模板 | 最多 32 层条件嵌套、256 个 if/elif 条件 |

这些是上限，不是建议目标。不要为了状态显示把整段历史或大量媒体塞进 JSON 状态。

ZIP 只允许根 world.json、components/、assets/；拒绝重复或大小写/Unicode 冲突路径、符号链接、加密 ZIP 和特殊文件。路径使用原始 Unicode，不预先 URL 编码。单独 JSON 导入不能引用包内组件或 sr-asset 资源。[打包操作](../creator/packaging.md)

## 导入与运行边界

world:check 使用当前导入和模块检查能力，但不执行组件、调用模型、下载远程素材或评判剧情效果。声明式资源可检查，组件运行中动态拼出的路径仍需实际打开验证。

普通导入创建新世界副本；修改源码、重新打包不会自动更新既有世界或会话。带正式更新源的卡可由玩家明确选择并确认[应用指定发行版](world-updates.md#应用指定版本)，在同一 worldId 下替换作者内容并保留会话和运行状态。世界导出重建作者卡与资源，不是运行数据库备份。默认叙事预设、帮答预设和模型绑定由应用管理，不随世界卡导出；不能依赖作者本地 ID 让接收者自动取得同样模型。

参考来源：[解析/导出](../../apps/server/src/modules/worlds/parser.ts) · [资源校验](../../apps/server/src/modules/worlds/assets.ts) · [ZIP 处理](../../apps/server/src/modules/worlds/archive.ts) · [资源路径](../../packages/sr-sdk/src/asset-url.ts)。
