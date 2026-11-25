# 世界卡格式参考

本页对应当前仓库的导入器。协议版本是 `spec_version: "0.1"`；状态定义另有 `schema_version: 2`。两者不是同一个版本号。

先做作品请读[第一张世界卡](../creator/first-world.md)；完整文件见[最小示例](../../examples/worlds/minimal/world.json)与[雾港来信](../../examples/worlds/fog-harbor/world.json)。字段校验以[世界卡校验器](../../apps/server/src/modules/worlds/validation.ts)、[状态校验器](../../packages/sr-sdk/src/state-validation.ts)为准；通过 `pnpm world:check` 使用实际契约检查。

## 目录

- [根结构](#根结构)
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
  "spec_version": "0.1",
  "data": {
    "name": "我的世界",
    "characters": [
      {"id": "traveler", "name": "旅人", "player_selectable": true}
    ],
    "openings": [
      {"id": "arrival", "name": "抵达", "content": "你来到了雾港。"}
    ]
  }
}
~~~

这是结构最小值。实际作品应补充角色 prompt 和世界资料，让模型知道应该怎样继续故事。

| 字段（位于 data） | 必填 | 类型 / 约束 |
| --- | --- | --- |
| `name` | 是 | 去掉首尾空白后非空的字符串 |
| `characters` | 是 | 角色数组，至少一项可扮演，数组内 ID 唯一 |
| `openings` | 是 | 至少一个开局，数组内 ID 唯一 |
| `description` | 否 | `{type:"component", component:"组件ID"}`；新卡不接受旧字符串简介 |
| `cover` | 否 | 图片地址字符串；包内素材用 sr-asset URI |
| `tags` | 否 | 非空字符串数组 |
| `lorebook` | 否 | `{entries: [...世界书条目]}` |
| `state` | 否 | 状态 v2 定义 |
| `components` | 否 | 组件声明数组，最多 100 项 |
| `stage_component` | 否 | 已登记的组件 ID |
| `message_render` | 否 | `{rules: [...显示规则]}` |
| `extensions` | 否 | 扩展元数据对象；不会自动获得执行行为 |

不要在世界卡中加入模型 Key、运行时会话数据或本机默认配置 ID。`data.ui` 不被接受。未定义的自创字段不构成平台能力，也不能保证原样往返；作者元数据放在 extensions，并在作品说明中解释。

## 角色

每项至少有非空 `id/name`。至少一项 `player_selectable` 必须显式为 true。

| 字段 | 类型 / 含义 |
| --- | --- |
| `id` | 稳定标识，角色数组内唯一 |
| `name` | 显示名称；选中身份名称用于 `{{user}}` |
| `description` | 可选字符串，玩家可读介绍 |
| `prompt` | 可选字符串，进入人物/玩家身份材料 |
| `avatar` | 可选图片地址 |
| `sprites` | 可选立绘素材数组；非空时必须含 ID 为 default 的素材 |
| `player_selectable` | 可选布尔，是否可被玩家选择 |
| `order` | 可选整数，角色材料排序；默认 0 |
| `load` | 可选加载条件 |

角色 prompt 支持精确 `{{user}}` 和本轮可见的 state 字段插值；不是任意模板执行器。选中角色通过其 load 后作为 persona 材料，其他激活角色作为 character 材料。详见[组织世界内容](../creator/world-content.md)。

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

目录包含全卡已声明的素材。角色 load 只控制角色 prompt 加载，不过滤立绘目录；素材说明是可被模型读取的选择资料，不应承担剧情解锁或隐藏信息的职责。节点启用后，模型材料只包含角色 ID/姓名、素材 ID/说明和当前玩家角色 ID，图片地址用于资源读取。

引用包内图片时，必须将文件放进 ZIP 的对应 assets/ 路径。导入、导出、`world:check` 与打包都会检查声明的包内资源；单独 JSON 导入不能引用包内文件。在线地址只校验 URI，不在导入时下载或探测。

每轮显示哪些角色、使用哪张图和哪个语义位置，由立绘 prompt 与本轮故事决定。模型输出使用独立的 character_sprite JSONL 快照，见[预设中的角色立绘](../creator/presets-and-models.md#角色立绘)。七种位置可供不同前端布局消费，不依赖视觉小说模式。开局消息不会自动生成立绘快照。

会话宿主按消息结果展示悬浮立绘。建议使用自带透明轮廓的 PNG 或 WebP；图片保持原有比例和背景。玩家通过输入框左上方的「立绘」开关控制展示。

## 开局

| 字段 | 必填 | 类型 / 含义 |
| --- | --- | --- |
| `id/name/content` | 是 | 非空字符串；id 在开局数组内唯一 |
| `initial_state` | 否 | message 根名到完整初值的对象 |
| `type` | 条件必填 | 使用预览组件时固定为 component |
| `component` | 条件必填 | 与 type 同时提供，引用已登记组件 |

content 在创建会话时作为第一条助手消息保存，精确 `{{user}}` 替换一次；创建会话不生成模型开场。initial_state 只能覆盖已声明的 message 根，按整根替换并校验值；没覆盖的根使用定义初值。

预览组件与实际会话开场是不同入口。预览组件不能执行会话初始化、读取 session/message 或代替平台创建会话。

## 世界书

`lorebook.entries` 每项包含：

| 字段 | 类型 / 含义 |
| --- | --- |
| `id` | 必填非空字符串，数组内唯一 |
| `content` | 必填非空字符串，模型可用资料 |
| `title` | 可选字符串，用于阅读与管理 |
| `enabled` | 可选布尔；false 关闭条目 |
| `load` | 加载条件，额外允许整数 order |

order 默认 0，同值保留原数组顺序。条目 content 与角色 prompt 一样支持有限的作者变量。资料被加载不意味着故事中对应事件发生或人物已经知情。

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
| 世界介绍 | `description: {type:"component", component:"Introduction"}` |
| 开局预览 | 开局内同时写 `type:"component"` 与 `component:"OpeningPreview"` |
| 会话舞台 | `stage_component: "HarborStage"` |
| 消息片段 | 显示规则的 replacement.component |

所有显式组件引用都必须存在；stage_component 也不例外。不指定 stage_component 才使用官方舞台。仅登记组件不会自动挂载。

每个模块必须默认导出；内部依赖通过 `./组件ID` 默认静态导入。允许的外部模块为 react、react-dom/client、react/jsx-runtime 和 @sillyrealms/sdk；通常只需 React 和 SDK。不支持任意 npm 包、SDK 子路径、动态 import、require、转发导出或循环依赖。[编译规则](../../packages/sr-ui-compiler/src/modules.ts)

介绍/开局预览只有受限只读 global API，舞台才有会话/历史/状态操作。两个环境不是同一权限集。具体接口见[SDK 手册](../sdk/README.md)。

## 消息显示规则

`data.message_render.rules` 最多 100 项，每项包含：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `id` | 是 | 非空，规则数组内唯一 |
| `name` | 否 | 显示名称 |
| `roles` | 是 | 非空数组，user / assistant |
| `pattern` | 是 | 正则字符串，长度 1–2000 |
| `flags` | 否 | 默认 g，只允许 g/i/m/s/u 且不重复 |
| `replacement` | 是 | markdown/html 的 content，或 component 的组件 ID |

replacement 为 `{type:"markdown",content:"..."}`、`{type:"html",content:"..."}` 或 `{type:"component",component:"..."}`。文本替换内容最多 100000 UTF-8 字节。组件接收 match、groups、namedGroups、message、runId；第一个捕获组是 groups[0]。

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
| when | 4096 UTF-8 字节、256 个受检节点；状态路径最多 32 段 |

这些是上限，不是建议目标。不要为了状态显示把整段历史或大量媒体塞进 JSON 状态。

ZIP 只允许根 world.json、components/、assets/；拒绝重复或大小写/Unicode 冲突路径、符号链接、加密 ZIP 和特殊文件。路径使用原始 Unicode，不预先 URL 编码。单独 JSON 导入不能引用包内组件或 sr-asset 资源。[打包操作](../creator/packaging.md)

## 导入与运行边界

world:check 使用当前导入和模块检查能力，但不执行组件、调用模型、下载远程素材或评判剧情效果。声明式资源可检查，组件运行中动态拼出的路径仍需实际打开验证。

普通导入创建新世界副本；修改源码、重新打包不会自动更新既有世界或会话。世界导出重建作者卡与资源，不是运行数据库备份。默认预设和模型绑定由应用管理，不能依赖作者本地 ID 让接收者自动取得同样模型。

参考来源：[解析/导出](../../apps/server/src/modules/worlds/parser.ts) · [资源校验](../../apps/server/src/modules/worlds/assets.ts) · [ZIP 处理](../../apps/server/src/modules/worlds/archive.ts) · [资源路径](../../packages/sr-sdk/src/asset-url.ts)。
