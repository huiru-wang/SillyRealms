# 世界卡组件与展示权限

## Web 内容库边界

- V2 世界卡使用 `spec_version/data`；HTTP 管理详情使用顶层驼峰领域字段，不包含运行 state。已有文本 description 如实展示；新卡导入仍按组件描述协议校验。
- 世界内容库只读展示作者角色、开局、世界书及状态定义。世界详情沿用原 Web 的折叠概览、角色条、六个图标 Tab、开局导航及弹窗。角色在头部选择并带入创建确认，弹窗允许选择配置；V2 创建请求携带开局 ID，由服务端初始化状态并保存首条消息；不执行作者组件或调用模型。
- 图片、音频、字体及组件文件来自 `/api/v1/worlds/:id/resources/*`，SDK 从该资源根目录解析包内地址。
- 作者介绍与开局组件使用独立预览来源的 `world-component.html`，开发默认 127.0.0.1:5177；Web 默认 127.0.0.1:5176。预览来源不得与管理来源相同。构建及部署配置见 [Web 管理](../runtime/web-management.md)。
- 预览保留 sandbox、CSP、窗口/来源/nonce 校验。宿主只允许读取当前世界 global 路径，从状态响应 `data.item` 投影，不提供完整状态、写操作或会话能力。主题按 appearance 契约传递。组件错误局部展示并允许重试；详情内切换保留有界预览实例，淘汰、重试和离开详情时销毁对应文档与连接。
- 组件 path 优先，读取失败不回退 inline。世界管理不启动 Stage，不执行消息展示规则或状态规则。


世界卡保持 `spec_version / data` 包装。组件相关字段位于 `data` 根层：

```json
{
  "stage_component": "WorldStage",
  "components": [
    { "id": "WorldIntroduction", "component": "export default function Introduction(){ return null; }" },
    { "id": "OpeningPreview", "component": "export default function Preview(){ return null; }" },
    { "id": "CGImage", "component": "export default function CGImage(props){ return null; }" },
    { "id": "WorldStage", "component": "import {SR} from '@sillyrealms/sdk'; export default function Stage(){ return <SR.WorldStory/>; }" }
  ],
  "description": { "type": "component", "component": "WorldIntroduction" },
  "openings": [{
    "id": "opening-1", "name": "开局 1", "content": "咚咚咚……",
    "initial_state": {}, "type": "component", "component": "OpeningPreview"
  }]
}
```

## 展示规则

- `components` 是共享源码库，组件 ID 唯一；仅支持 `@sillyrealms/sdk` 与世界卡内部 `./ID` 默认静态导入。旧 SDK 名称不兼容。
- `stage_component` 未指定时使用官方默认 Stage，组合 `SR.WorldStory` 与按 items 条件挂载的 `SR.ActionSuggestions`；消息规则仍可引用共享组件库。新卡显式引用不存在的舞台组件时，导入校验拒绝；运行时为缺失目标保留的显示兜底不构成可供作者使用的有效格式。已登记目标编译或执行失败时显示错误，不回退；平台不检查、插入或自动执行作者未使用的正文或行动组件。
- 官方 `WorldStory` 不显示「故事」标题；`showState=false` 时完全省略状态工具栏。作者舞台同样不增加「故事」「正文」等重复顶栏，日期、地点和必要操作按需放入紧凑场景栏。
- `description` 可省略，指定时必须是有效组件引用，不接受旧字符串。介绍组件没有消息匹配参数。
- 开局的 `type`、`component` 成对提供，必须引用存在的组件。省略时只展示 `content` 的静态文本。预览组件与实际会话正文独立；图片、音频等由作者在预览源码中直接引用。
- V2 将 `content` 中全部精确的 `{{user}}` 替换为所选玩家角色名称后保存为普通 assistant 消息；`initial_state` 保持消息状态整项覆盖语义。开局预览独立于消息渲染。会话内所有消息统一适用 `message_render` 正则与组件替换，不按开场身份分支；Web 会话渲染在独立来源的 frame 内执行。
- `message_render.rules[].replacement.component` 引用 `components[].id`。`CGImage` 若依赖 `groups`，只作为正则消息组件使用，不自动成为介绍或开局预览。
- 缺失引用在导入时拒绝，包括 `stage_component`；源码编译/运行错误在具体视图内显示重试，不阻止使用有效的其他入口。

角色选择位于头部角色列表：进入详情默认选中第一个可扮演角色，点击“可扮演”切换当前选择，选中项显示“已选中”及边框高亮。选择不持久化。开始会话弹窗显示当前开局名称和角色名称，只提供“取消”“确认开始”，弹窗内不能重新选择。

## 行动建议组件与布局

`useSRActionSuggestions()` 在会话舞台提供只读 `{items: readonly string[]}`，初始为空。Host 负责接受新执行时清空、SSE 注入与现有历史恢复；Hook 不读取历史、不扫描正文、不带消息定位或操作资格。`SR.WorldStory` 只承担正文、分页和阅读，行动区由 Stage 显式组合；`SR.ActionSuggestions` 默认点击 `session.setDraft(text)`，作者可用同一 Hook 编写视图并选择普通 setDraft 或 send。

默认布局中正文与行动区是兄弟组件，行动区位于阅读区下方、宿主输入框上方。items 为空时整个有视觉样式的 wrapper 不挂载，不能残留空边框、padding、最小高度或预留网格行。正文占剩余高度，行动区限高且可独立滚动；外壳统一处理宿主输入区 inset，WorldStory 用公开 CSS 变量调整局部尾白，详见 [SDK 组件组合](../sdk/components.md#行动建议与舞台组合)。

自定义 Stage 掌握自己的布局，也负责条件挂载整个行动区；平台不会自动补入作者没使用的组件。世界卡仍沿用 components、普通静态导入和 stage_component，不增加专用 renderer 字段或注册类型。行动建议来自结构化快照，不走 message_render.rules 的正文正则、match/groups 或替换锚点。它与输入区作者快捷按钮、AI 帮答分别拥有自己的数据和生命周期。

行动 Hook 和组件仅可用于会话环境。介绍、开局预览没有会话 Provider，不提供这一能力，也不以静默空数组伪装可用。

## 介绍与开局权限

两者从稳定的独立资源来源加载 `world-component.html`，使用 `sandbox="allow-scripts allow-same-origin"` iframe，只提供查询世界当前全局状态的能力：

```tsx
import React from 'react';
import {useSRWorldStateAPI} from '@sillyrealms/sdk';
export default function Preview() {
  const state = useSRWorldStateAPI();
  const [sky, setSky] = React.useState<string>('');
  React.useEffect(() => {
    let active = true;
    state.getState('weather.sky', 'global')
      .then(value => { if (active) setSky(String(value ?? '')); });
    return () => { active = false; };
  }, [state]);
  return <p>{sky}</p>;
}
```

`getState(path, scope?)` 默认 global；`batchGetState([{path,scope?}])` 返回对应查询值。没有事件订阅或隐式实时刷新。详情运行环境中的 `useSRStateAPI` 是相同只读 API 的别名；作者使用 `useSRWorldStateAPI` 可获得准确的只读类型。

禁止 session/message 状态、状态写入、Session API、事件订阅和直接 Server HTTP。权限由 Host 再次校验，不能靠伪造 iframe 请求绕过。组件不接收原始世界卡、状态定义、会话对象、凭据或底层 transport。Web 使用 `GET /api/v1/state/global/:worldId`，仅供可信 Host 查询当前 global 状态，再按路径返回结果给组件。初始消息状态查看器仍由平台 UI 提供，不能被预览组件读取。

iframe 使用 CSP `connect-src 'none'`，Server 拒绝来自该独立资源来源的 API 请求。详情内切换 Tab/开局仅隐藏缓存中的 iframe；淘汰或离开详情才销毁文档、终止该实例未完成的状态请求。隐藏时暂停 HTML 音视频和 CSS 动画，阻止隐藏媒体继续播放；重新显示不自动恢复音视频。作者计时器、Web Audio 和任意 JavaScript 不承诺暂停。安全的旧 prose 可使用 `WorldDocumentContent` 渲染在已有隔离文档中。

## 存储和兼容性

世界表的 `components` 列保存组件数组，`stage_component` 保存舞台组件 ID。卡片导入和 HTTP 详情字段见 [Server HTTP 契约](../runtime/server-http.md)。

## 会话图片与页面隔离

会话 Stage 使用稳定的独立来源，保留 sandbox 和原有 CSP。符合源站缓存条件的图片在重新进入会话和普通刷新时可复用浏览器缓存，无需修改世界卡图片地址。世界卡详情的介绍和开局组件也复用该独立资源来源，但保留单独的只读入口与权限校验；角色、世界书及无组件开局的静态文档保持原渲染方式。

舞台连接失败时显示重试入口。重试只重建舞台，保留平台输入草稿和已提交历史，不重新发送消息；已被服务端接受的生成继续按原生命周期处理。作者组件仍通过 SR SDK 访问当前会话，不能直接操作主界面或访问业务 HTTP。

## 详情切换与缓存

介绍、开局之间切换，离开详情再进入以及普通刷新时，符合源站缓存条件的图片可以复用浏览器 HTTP 缓存。媒体按浏览器及源站策略加载，不保证完整下载、离线使用或永久缓存。

同一应用运行期间，详情预览按世界 ID 和完整组件源码复用编译结果（包括进行中的编译），最多保留最近使用的 4 张世界卡。源码、组件 ID 或组件集合变化会重新编译；有编译错误或失败的结果不保留，以便重试。刷新应用会清空编译缓存。此缓存仅用于详情，不改变会话舞台的编译流程。

当前世界详情最多保留 10 个已访问的作者预览实例，介绍占一个，开局按 opening ID 各占一个；不同开局引用同一组件也不共享交互状态。首次打开才挂载，加载中和失败的实例也计入上限。超过上限淘汰最早打开的实例（FIFO）；重访、标题变化或重试不调整顺序。切回保留原 iframe、连接与 React 局部状态，不重新握手、读取源码或初始化；开局选择在详情内保留。iframe 始终保持原 DOM 位置，隐藏实例不占布局且不可聚焦；重新显示时重新报告高度。

源码与进行中的读取/编译由当前详情共享，单个实例淘汰不取消其他实例的共享加载。读取失败或存在模块错误时不保留该次源码结果。重试刷新源码并仅重建被重试的实例，不主动重载其他已挂载预览，也不会创建会话或发送消息。世界 ID 或组件声明内容变化会重建预览池；仅保存名称、标签、默认配置或产生新数组引用不重建。包内文件在外部被修改时，通过重试或重新进入详情读取，不提供文件变更推送。

组件自行读取的 global 值可能保留在其局部状态中；切回预览不重新执行初始化，也不隐式刷新全局状态。每次显式状态查询仍读取服务端当前值。离开详情、切换世界或刷新页面释放全部实例、连接及当前详情的共享请求；不会缓存其他 Tab 的业务数据或会话舞台实例。

## 会话 WorldStory 消息操作

官方悬浮立绘由会话宿主叠加在舞台视口上，人物层穿透鼠标与触摸操作。WorldStory 和作者自定义舞台共用这一展示。人物显示框高度为输入区上方可用舞台高度的 50%，单个人物宽度不超过舞台的一半并保留边距；图片按比例完整容纳，保留透明度和原有背景，换图与胶囊开关不改变正文布局。宽舞台可左右各显示一位，优先使用本侧位置，中轴人物优先补右侧；紧凑宽度采用快照中第一位并靠右显示。人物底部避开实测输入区，键盘导致可用高度不足时暂时隐藏人物。减少动态效果时直接切换图片。

会话宿主页在输入框的“更多操作”上拉菜单中提供重新生成，作用于最新用户轮次，无 AI 回复时重试同轮。开局、生成中、提交中、离线或历史未同步时禁用。

SDK session.regenerate({userEntryId,assistantEntryId}) 通过受限 Host 命令提交，assistantEntryId=null 表示同轮无回复重试。stop(runId,assistantEntryId) 精确指定当前执行。SDK 不删除本地消息、不重复请求或自行恢复业务；Host 在服务端删除确认后更新历史镜像，失败不恢复旧回复。StageSnapshot 暴露 activeAssistantEntryId/sending 供按钮判断，原生事件可包含 message.deleted。
