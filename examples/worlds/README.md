# 可复制的世界卡示例

从同一个故事，分别体验“先写出可玩的内容”和“再给世界加入自己的界面”。两个示例都叫《雾港来信》：旅人带着一封没有收件人姓名的旧信来到港口，沿着灯塔的印记寻找收信人。

| 示例 | 适合做什么 | 包含内容 |
| --- | --- | --- |
| [文字起步](minimal/world.json) | 制作第一份世界卡；直接导入 JSON | 两个角色、一个开局、少量世界书；沿用官方 WorldStory |
| [完整教学版](fog-harbor/world.json) | 学习状态、素材与自定义展示；导入 ZIP | 三个角色、两个开局、三个剧情状态、世界/角色/开局预览组件、定制舞台、消息插图及本地素材 |

两个示例均使用世界卡 0.2，包含教学用的 publication；不配置远端更新源。复制为自己的作品时，生成独立的 package_id 并填写实际署名与版本。

## 先玩起来

在仓库根目录安装依赖后，先校验示例：

```bash
pnpm world:check examples/worlds/minimal
pnpm world:check examples/worlds/fog-harbor
```

文字起步版可以直接在 SR 的世界库导入 `minimal/world.json`。完整教学版需要把源码和资源一起打包：

```bash
pnpm world:pack examples/worlds/fog-harbor --out build/worlds/fog-harbor.zip
```

命令成功后，在世界库导入生成的 ZIP。选择“旅人”和“渡轮靠岸”，使用已配置的模型及标准叙事预设，创建会话。已有同名输出文件不会被覆盖；重新打包时指定新的输出路径，或在确认不再需要后自行移走旧包。

初次导入、查看世界介绍和打开既定开局不需要模型生成。继续对话需要可用的模型配置。包内素材不依赖外链；这不代表模型能够离线使用。

先查看世界介绍、打开林舟的角色介绍，再切换两个开局，观察组件预览与正文预览的区别。随后可以按这个顺序试玩：

1. **询问信封。** 输入“我仔细查看信封上的地址与灯塔印记，再向林舟询问它的来历。”完整版输入区也有“看看信封”快捷按钮，只填入草稿，仍由你确认发送。
2. **看看手记。** 已确认的线索可以出现在手记中。桌面显示在侧栏；手机点击上方“旅人手记”展开。
3. **去茶摊。** 输入“我走到码头茶摊，确认热茶售价后买一杯。”如果故事实际完成交易，12 枚银币应变为 10 枚；只询价或提出计划不应扣款。
4. **循线探索。** 询问阿遥、查找旧登记簿，或去灯塔找林舟。界面展示平台已保存的状态；模型可能遗漏更新，不能把建议的动作当作已经发生。

也可以选择“灯塔下的约定”重新创建一局。这个开局预先知道“信封上的灯塔印记”，演示同一世界如何从不同状态开始。

## 从哪里改起

先复制整个示例目录到自己的工作目录，再修改文件。完整教学版的源码目录直接对应 ZIP 内容：

```text
fog-harbor/
├── world.json
├── components/
│   ├── Introduction.tsx
│   ├── KeeperIntroduction.tsx
│   ├── ArrivalPreview.tsx
│   ├── HarborStage.tsx
│   └── HarborScene.tsx
└── assets/
    ├── harbor.svg
    ├── lighthouse.svg
    ├── traveler.svg
    ├── keeper.svg
    └── courier.svg
```

| 想修改的内容 | 修改位置 | 需要一起检查 |
| --- | --- | --- |
| 世界名称、标签与人物设定 | `world.json` 的 `data.name/tags/characters[].content` | 玩家角色介绍另在 characters[].presentation；介绍和舞台里的标题也需要修改 |
| 第一段故事 | `data.openings[id=arrival].content` | 保留非空正文；本地素材和场景标记必须有对应资源 |
| 第二个开局 | `data.openings[id=lantern]` | `initial_state` 按完整根覆盖，不是逐叶合并 |
| 初始银币 | `data.state.scopes.message.coins.initial` | 本例两个开局都显式覆盖 `coins`，要同步调整对应 `initial_state.coins` |
| 线索与任务规则 | `clues.rules`、`quest.rules` | 它们是给模型的说明；字段类型与有效值仍由平台校验 |
| 作品介绍 | `data.presentation` 与 `components/Introduction.tsx` | 它在详情预览运行，没有会话或状态写入权限 |
| 守灯人介绍 | `characters[id=keeper].presentation` 与 `components/KeeperIntroduction.tsx` | 只展示玩家可读资料，不从 content 回退 |
| 渡轮开局预览 | `openings[id=arrival].presentation` 与 `components/ArrivalPreview.tsx` | 只改变预览，首条消息仍由 content 生成 |
| 状态面板 | `components/HarborStage.tsx` | 三个 `useSRState` 路径与世界卡中的根名称一致 |
| 消息插图 | `components/HarborScene.tsx`、`data.message_render.rules`、`assets/` | 新场景需要同时登记允许的标记和对应资源；不根据任意正文拼接文件路径 |

教程使用的稳定标识：

| 对象 | ID 或路径 |
| --- | --- |
| 玩家身份 | `traveler` |
| 守灯人 | `keeper` |
| 信使（完整版） | `courier` |
| 码头开局 | `arrival` |
| 灯塔开局（完整版） | `lantern` |
| 银币 | `message.coins` |
| 线索 | `message.clues` |
| 当前目标 | `message.quest` |
| 码头 / 灯塔插图标记 | `[CG:harbor]` / `[CG:lighthouse]` |

SDK 将 scope 和 path 分开传递。例如 `useSRState('coins', 0)` 默认读取 message；不要把 `message.coins` 整串当成默认 scope 下的字段路径。

## 为什么这样拆

**世界卡写内容。** 角色、开局、世界书与状态定义都在 `world.json` 中。剧情状态只有 message scope，便于观察同一局故事中已发生的变化。没有长期记忆、视觉小说演出协议或自动角色代理等未实现功能。

**组件负责展示。** `Introduction`、`KeeperIntroduction` 和 `ArrivalPreview` 分别演示世界、角色和开局的组件展示；旅人仍用 Markdown 介绍，灯塔开局未提供 presentation，直接预览其公开 content。`HarborStage` 用官方 `SR.WorldStory` 显示消息，再用 `useSRState` 显示平台提供的状态。它不另写消息历史、不模拟银币扣减、不创建输入框。

**插图只改变显示。** `[CG:harbor]` 和 `[CG:lighthouse]` 由 `message_render` 匹配后显示成 `HarborScene`。标记本身不移动人物、不消费银币、不完成任务；状态仍依据实际叙事独立更新。

**包里只有作品。** `world.json` 位于 ZIP 根目录，组件位于 `components/`，素材位于 `assets/`。本说明、迁移夹具、开发依赖和模型密钥都不放入世界包。

## 原创素材与使用说明

本目录中的雾港剧情、三个角色徽像、两幅场景 SVG 和 TSX 组件均为这次文档建设新编写的原创教学内容，没有复制其他世界卡、商业游戏素材或外部图片。SVG 不含脚本、外部字体或网络资源，可直接打开查看并修改源码。

这些场景图是作品内的插图，不是 SR 界面截图或真实照片。README 等位置展示的实际软件画面应另外从运行中的 SR 截取。

你可以从示例复制结构，换上自己的世界、角色与素材。素材来源说明不替整个项目设定许可证；对外发布自己的作品时，请明确作品及所用素材的授权，并遵循仓库已公布的适用条款。

## 给 Agent 的迁移练习

[fixtures/tavern-letter.json](fixtures/tavern-letter.json) 是本次原创的 Tavern V2 格式迁移输入，含角色、两条开场白、世界书、一个需人工确认的变量宏和一个未知扩展。它**不是 SR 世界卡，不能直接导入 SR**。预期行为和检查点见 [fixtures/README.md](fixtures/README.md)。

接口细节继续查阅 [创作者 SDK](../../docs/sdk/README.md)。展示代码使用当前公开的 `@sillyrealms/sdk` 根入口，不依赖平台内部模块。
