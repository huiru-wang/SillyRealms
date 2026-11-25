# 呈现与交互

同一份世界内容可以用官方正文界面游玩，也可以增加状态面板、插图、角色资料或自定义布局。本章先保留官方叙事能力，再逐步加入作者界面。

完整示例：[雾港来信组件](../../examples/worlds/README.md)；精确接口：[SDK 手册](../sdk/README.md)。

## 先决定组件出现在哪里

| 位置 | 注册方式 | 可以做什么 |
| --- | --- | --- |
| 世界详情介绍 | `data.description` 引用组件 ID | 展示作品介绍、包内素材，按需只读 global |
| 开局预览 | 开局的 `type/component` | 展示这一开局的气氛和玩法说明，按需只读 global |
| 会话舞台 Stage | `data.stage_component` | 读取会话/历史/状态，组合官方正文，自定义交互 |
| 消息中的局部组件 | `message_render.rules` 匹配文本 | 把标记显示为图片、卡片或行内提示 |

仅登记到 `components` 不会让组件自动出现；必须有上述挂载引用。详情预览没有会话身份，不能在那里读取玩家银币、写状态、发送消息或创建会话。

## 1. 在官方正文旁边显示银币

创建 `components/MyStage.tsx`：

~~~tsx
import React from 'react';
import { SR, useSRState } from '@sillyrealms/sdk';

export default function MyStage() {
  const [coins] = useSRState<number>('coins', 0);
  return <main style={{minHeight: '100%', padding: 16}}>
    <aside aria-label="旅人状态">银币：{coins}</aside>
    <SR.WorldStory showState={false} />
  </main>;
}
~~~

这要求已有 message.coins 定义，见[状态教程](state-and-rules.md)。在 `data.components` 数组中添加注册项，并把 `data.stage_component` 指向该 ID：

~~~json
{
  "components": [
    {"id": "MyStage", "path": "sr-asset://components/MyStage.tsx"}
  ],
  "stage_component": "MyStage"
}
~~~

片段合并到 `data`，保留原有组件。打包、导入并进入新会话，应该同时看到银币和官方正文。平台仍负责输入框、会话设置和事件同步，无需作者另建一套发送栏。

不指定 stage_component 时使用官方舞台。指定的组件必须已登记；新卡引用不存在的组件会在导入时拒绝。已登记组件编译或运行失败会显示错误，不能依赖静默回退。

## 2. 使用包内图片

把图片放在 `assets/`，在组件中通过资源 Hook 解析：

~~~tsx
import React from 'react';
import { useSRAssetUrl } from '@sillyrealms/sdk';

export default function Introduction() {
  const cover = useSRAssetUrl('sr-asset://assets/harbor.svg');
  return <section>
    {cover && <img src={cover} alt="雾港与灯塔" style={{maxWidth: '100%'}} />}
    <h1>雾港来信</h1>
    <p>带着一封未署名的信，寻找灯塔旧印记的来历。</p>
  </section>;
}
~~~

`useSRAssetUrl` 解析地址，不检查文件是否存在。不要把 `sr-asset://...` 原样赋给普通浏览器 img.src，也不要假定 iframe 与管理页同源。图片、音频、视频和字体的包内布局见[打包与分享](packaging.md)。

## 3. 将正文标记变成插图

「雾港来信」的 `HarborScene` 组件识别 `[CG:harbor]` 和 `[CG:lighthouse]`。在 `message_render.rules` 中，规则的 `pattern` 捕获场景键，`replacement.component` 指向已注册组件。

完整示例已给出可运行规则与组件。你只需核对三件事：

1. 模型的设定或输出要求允许在合适场景输出该标记。
2. 规则只匹配需要处理的角色，例如 assistant。
3. 组件把捕获值映射到已知素材，未知值有清晰的退路，不直接拼接任意远程地址。

`groups[0]` 是第一个捕获组，整段命中内容在 `match`。消息展示替换不会改写已保存正文，也不会更新银币或任务。想存剧情事实，应使用状态更新。

JSON 中的反斜线需要转义；可先复制示例规则再改场景键。完整参数和 Markdown/HTML 替换方式见[消息组件参考](../sdk/components.md#消息组件与-messagecomponentprops)。

## 4. 按钮填入行动草稿

会话舞台可以向平台输入区声明快捷按钮：

~~~tsx
import React from 'react';
import { SR, useSRComposerButtons, useSRSession } from '@sillyrealms/sdk';

export default function MyStage() {
  const session = useSRSession();
  useSRComposerButtons([
    {id: 'ask-keeper', label: '询问信件',
      onClick: () => session.setDraft('我拿出信封，请林舟辨认印记。')},
  ]);
  return <SR.WorldStory />;
}
~~~

点击后草稿被替换，玩家可以修改再发送。每个舞台最多提供五个有效按钮；组件只在会话中声明。按钮直接发送消息会发起一次真实模型调用，只有作品明确需要这种交互时才使用 send。

## 组件编写约束

- 舞台直接呈现正文，不另加「故事」「正文」等重复标题栏。日期、地点、当前目标和必要操作可放在紧凑场景栏中。已有自定义状态栏或账页时使用 `<SR.WorldStory showState={false} />`，官方正文不会保留空工具栏。
- 每个模块默认导出一个组件。卡内模块通过已登记 ID 引用，例如 `import Panel from './Panel'`；这不是磁盘相对文件路径解析。
- 普通组件使用平台提供的 React 和 `@sillyrealms/sdk` 包根。不能从卡内导入任意 npm 包或 SDK 子路径；不支持动态 import、require、转发导出或循环依赖。
- 在组件或自定义 Hook 顶层调用 Hook。订阅、定时器和异步查询要在 effect 清理；详情切换可能隐藏并保留组件，隐藏不等于卸载。
- Stage 与管理页独立来源。通过 SDK 操作当前会话；不要访问父页面 DOM、直接请求业务 HTTP、读取模型凭据。
- 新组件先处理空历史、状态加载、连接中断和错误。排错信息只写真正失败的部分，不要让一张图片失败阻断全部故事。

## 桌面与手机一起检查

先确定阅读正文和输入行动的主路径。桌面可以用侧栏显示状态，窄屏改为可收起面板或弹层；不要覆盖平台输入区。图片限宽，长线索换行，按钮要能触摸，键盘能关闭弹层。

「雾港来信」演示响应式状态布局；[已有响应式状态示例](../../examples/responsive-state-ui.tsx)可用于研究更完整的弹层处理。状态值、可访问名称和焦点行为比只缩小字号更值得检查。

最后运行 `pnpm world:check <目录>`，然后实际打开介绍、开局和会话。工具能检查模块语法与依赖，不能证明渲染布局、媒体行为或点击逻辑正确。出现问题见[排错](troubleshooting.md)。
