# 小饭馆 · 离线世界卡

最终导入文件：[xiaofanguan-world.zip](../xiaofanguan-world.zip)。

这张世界卡由 `data/角色卡/小饭馆/小饭馆.png` 的 Character Card V3 元数据转换，保留原卡的大离京城、小饭馆掌柜、李鱼儿与李鸟儿，以及平静市井日常的叙事要求。介绍页与人物图片复用同目录下已有的“世界介绍”成果，并改为包内资源。

## 导入与开始

1. 在支持世界卡 ZIP 的 SillyRealms 中打开“世界卡”，选择“导入世界卡”，上传 `xiaofanguan-world.zip`。
2. 在介绍页了解背景与三位人物。掌柜是唯一可扮演角色；李鱼儿、李鸟儿为常驻角色。
3. 打开“开局”，从三个原始开局中选择一个，再点击“开始会话”。
4. 若尚未配置模型，在应用设置或世界卡“运行配置”中选择可用模型和预设。

组件源码、封面与头像均在包内，无需访问原始 `data/` 目录或外部图片网站。故事生成使用应用配置的模型；“离线资源”指本卡的介绍组件与图片能够本地加载。

| 开局 | 来源 | 正文字数（JS 字符数） |
| --- | --- | ---: |
| 小馆的一天 | 原 `first_mes` | 10 |
| 开门营业 · 掌柜 | 第一个 `alternate_greetings` | 4,000 |
| 开门营业 · 老板 | 第二个 `alternate_greetings` | 3,993 |

三个标题是为选择器补充的展示标签。正文、顺序与原有换行全部保留，包括两个长开局之间的细小措辞差异。

## 内容如何保留

原卡的常规 description、personality、scenario、示例对话和系统提示字段为空，主要设定来自五条启用且常驻的世界书。转换后每段原始设定只注入一次：

| 原世界书 | 世界卡中的位置 | 保留内容 |
| --- | --- | --- |
| 0 · 江湖 | 常驻世界书 `source-lore-0` | 高武世界背景、大离京城、其他地域与原文描写禁令 |
| 1 · 江湖路远 | 常驻世界书 `source-lore-1` | 武力体系、江湖与日常隔离、不得擅自引入冲突 |
| 2 · 三十年纵横终归淘米，五十载无敌到头买菜 | 常驻世界书 `source-lore-2` | 普通掌柜身份、日常描写原则、正反示例及不得提起往事的要求 |
| 3 · 小二 | 李鱼儿与李鸟儿各自的完整 `prompt` | 两人的身世、及笄之年、外貌、完整性格层次、行为例子与限制 |
| 4 · 三十年纵横，五十载无敌 | 常驻世界书 `source-lore-4` | 封存的历史背景、与当前日常的隔离约束 |

掌柜的简短角色提示只提取原卡已有身份和家庭关系。两姐妹的详细设定进入模型使用的 `prompt`，角色列表的 `description` 仅作简要展示。

有三项明确的格式适配：

- 原提示词与世界书中的 29 个 `<user>`、7 个裸 `user`，用一次替换归一为 SR 的 `{{user}}`。运行时会替换为所选玩家姓名“掌柜”。开局正文没有改动。
- “小二”条目按两个完整人物区块拆分，各自保留外层 `<character>` 包装。去掉两份包装并拼接后，等于原条目去包装、完成宏归一化后的全部正文。
- SillyTavern 的 `before_char / after_char` 插入位置记录在来源映射中。SR 使用当前的 `persona.prompt / characters.prompts / world.lore` 材料位置；四条世界书保留原顺序值 1、2、3、101，不仿造 ST 的插入槽。

原卡没有状态变量或 MVU，也没有经营数值。此卡不声明 `state`，不增加金钱、好感度、任务或剧情。省略 `stage_component`，使用官方 `WorldStory` 展示开局和后续消息。

原文内部的措辞与条件性例外也保留：例如“客栈 / 饭馆”的混用，以及日常不得回忆往事与“必须情况下”描述背景的条件。转换没有替原作者改写这些规则。李鸟儿护短中的冲突场景仍只是性格例子，原文“不应刻意安排此类插曲”的限制完整保留。

## ZIP 与本地资源

ZIP 根目录直接包含以下五个文件，没有外层包装目录：

| 包内文件 | 用途 |
| --- | --- |
| `world.json` | 当前世界卡配置 |
| `components/WorldIntroduction.tsx` | 文件型世界介绍组件 |
| `assets/images/keeper.jpg` | 原封面的既有 JPG 显示副本，兼作掌柜头像 |
| `assets/images/li-yuer.jpg` | 既有李鱼儿介绍头像 |
| `assets/images/li-niaoer.jpg` | 既有李鸟儿介绍头像 |

`components[].path` 指向 `sr-asset://components/WorldIntroduction.tsx`，不提供内联回退。介绍组件通过 SDK `useSRAssetUrl` 解析图片 URI；文件源码交给现有编译器执行。旧介绍页的 data URL 和默认导出数据对象 `Portraits` 没有带入组件表。

本包的介绍页保留纸色、灶火色调、三位人物切换、头像、认识店里的人按钮与窄屏排版。只有资源接入改为当前 SDK；React 使用当前编译链注入的全局对象。

导入后使用平台管理的世界卡 package 目录；运行时配置以数据库为准。以后修改世界卡配置时，应使用应用“导出世界卡”得到包含最新数据库配置的 ZIP。

## 来源与复现

- [source/character-card.json](source/character-card.json)：从原 PNG 文本块解码得到的原始 JSON 字节；`chara` 与 `ccv3` 的内容相同。
- [source/provenance.json](source/provenance.json)：原 PNG、原介绍组件及三张既有图片的路径、大小与 SHA-256。
- [source-map.json](source-map.json)：原条目、开局与新字段的逐项对应，以及已知语义差异。
- [package/world.json](package/world.json)：可直接审查的完整配置。
- [build-report.json](build-report.json)：最终 ZIP 和每个包内文件的大小、SHA-256。

原 PNG 的 SHA-256：

```text
b1c013334d30fb1181aa97250f71dc20a09a1a65f9728c3d25535f6c97e51f4f
```

原始解码 JSON 的 SHA-256：

```text
53a8728a50f08805ccd3255c583b4b8a9e67f2460ead87960953f9ffe92dc9e4
```

在仓库根目录、安装锁定依赖后运行：

```sh
node plan/xiaofanguan-world/build.mjs
```

构建器从已提交的来源快照生成 `world.json`、来源映射、构建报告与最终 ZIP，校验图片散列；文件排序、权限与 ZIP 时间戳固定。不需要被忽略的原始 `data/` 文件、数据库或网络。最终 ZIP 的 SHA-256 以构建报告为准。

## 验收

隔离服务端验收：

```sh
pnpm --filter @sillyrealms/server exec tsx ../../plan/xiaofanguan-world/verify-server.mts
```

实际 Studio 浏览器验收：

```sh
node plan/xiaofanguan-world/verify-browser.mjs
```

浏览器脚本需要现有 `apps/studio/dist` 构建产物；若不存在，先在仓库根目录执行 `pnpm build`。默认使用 macOS 的 Google Chrome，可通过 `CHROME_PATH` 指定其他 Chromium 可执行文件。它会启动并清理自己的临时 Host、独立 Stage 与 Chrome 用户目录。

验收围绕最终交付 ZIP，覆盖：

- ZIP 文件清单与原资源散列、三个原文开局、四条常驻世界书和两个完整 NPC 提示。
- 真实导入路由、包内源码解析与编译、图片 Content-Type、ETag 条件请求。
- 三个开局分别创建会话、发送用户消息；在 fake gateway 捕获实际模型上下文，确认各条原设定进入请求且玩家宏已替换。
- 从数据库导出 ZIP 再导入，确认配置、文件组件与资源保持完整。
- Studio 文件选择器导入最终 ZIP；真实只读 iframe 编译执行；角色选择与三张头像；介绍页人物切换和按钮焦点；三个开局预览。
- 在 Studio 创建会话，使用官方 WorldStory 完成一轮消息与行动建议；1280 / 375 宽度、无横向溢出、无外部资源请求或浏览器异常。

结果见 [verification/server-report.json](verification/server-report.json) 与 [verification/browser-report.json](verification/browser-report.json)，页面截图保存在同一 `verification/` 目录。

验收只替换模型传输为固定的日常回复，使用内存数据库与临时文件，不读取真实凭据、不调用付费模型、不改动真实世界和会话数据。它证明导入、内容装配、组件资源与交互链路可用；实际模型的长期叙事表现仍取决于用户的模型和预设。
