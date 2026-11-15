# 组件与消息展示

SDK 的组件分为故事舞台、消息中嵌入的 React 组件，以及安全静态正文渲染。先选择需要的表面，再决定使用哪种 API；同一份字符串不会自动成为可执行的 React 或 MDX。

## 官方故事舞台

```tsx
import React from 'react';
import { SR } from '@sillyrealms/sdk';

export default function WorldStage() {
  return <SR.WorldStory showState={false} />;
}
```

当前公开 prop 只有 `showState?: boolean`，默认 true。设为 false 会移除官方状态入口和面板，适合作者自己提供状态 UI；不会删除状态数据或禁止状态 API。

WorldStory 使用与作者组件相同的 `useSRSession`、`useSRStateAPI`，由平台注入消息规则、已编译组件和状态定义。它负责：

- 分页读取叙事历史、订阅 Run 事件、合并快照与增量，并尊重终态权威。
- 展示用户／故事消息，处理正则替换与 React Portal 消息组件。
- 展示运行阶段、失败、状态扩展结果和行动建议。
- 按自身容器宽度在状态侧栏和弹层之间切换，管理阅读位置与回到最新。

它不包含平台输入框、模型配置、用量统计、发送／停止按钮。一个 Run 内相邻、同 origin 的 assistant 消息在显示时用空行合并，保留第一条的显示 ID；这只是展示投影，不改写存储记录。自定义列表不能把可见段落数当成底层消息条数。

### 布局和主题

为 WorldStory 提供有界高度，flex 容器中通常需要 `minHeight: 0`。布局尽量通过外层容器组织，不查询或修改 SDK 私有 DOM。

Studio 自动加载 `world-story.css`，并向会话 iframe 传入主题、阅读字号及平台输入浮层的遮挡量。当前官方组件使用的 CSS 变量包括：

| 变量 | 用途 |
| --- | --- |
| `--sr-story-bg`、`--sr-story-surface` | 背景与表面 |
| `--sr-story-text`、`--sr-story-muted` | 正文与辅助文字 |
| `--sr-story-line`、`--sr-story-accent`、`--sr-story-focus` | 边界、强调、焦点 |
| `--sr-story-danger` | 错误色 |
| `--sr-story-font-size` | 平台阅读字号，当前范围 13–21px |
| `--sr-story-bottom-inset` | 为底部平台浮层保留空间 |

这些是当前官方样式的集成入口，不是额外 React props。Host 会更新部分根变量；自定义面板要自行处理遮挡、滚动和焦点，也不能依赖 Host 页面 CSS 跨 iframe 继承。

当前还有一处命名差异：Host／frame 传入并允许的是 `--sr-story-border`，官方 CSS 实际读取 `--sr-story-line`，且 Host 未传递 danger。不要假定平台边框色或错误色已完整同步；上述变量表列的是 CSS 的实际消费名称。

## 正则消息组件

`data.message_render.rules[]` 选择消息中的文本，并将匹配位置替换为共享组件库中的组件。消息组件只有在实际渲染消息规则时才会出现；定义规则本身不会要求模型输出该标记。

下面是可作为 `Choice` 保存的组件源码。它把匹配出的动作填入草稿，没有发送副作用：

```tsx
import React from 'react';
import { useSRSession, type MessageComponentProps } from '@sillyrealms/sdk';

function Choice({ match, groups }: MessageComponentProps) {
  const session = useSRSession();
  const action = groups[0]?.trim();
  if (!action) return <span>{match}</span>;
  return <button type="button" onClick={() => session.setDraft(action)}>
    填入：{action}
  </button>;
}

Choice.srDisplay = 'inline';
export default Choice;
```

相应规则片段放入 `data.message_render`：

```json
{
  "rules": [
    {
      "id": "choice-button",
      "roles": ["assistant"],
      "pattern": "\\[选择:([^\\]\\n]+)\\]",
      "flags": "g",
      "replacement": { "type": "component", "component": "Choice" }
    }
  ]
}
```

普通 assistant 正文中的 `[选择:走向灯塔]` 会成为可点击按钮，前提是它不在代码等受保护区域。示例是卡字段片段；组件源码还必须存在于 `data.components`。

### Props 与显示类型

| prop | 含义 |
| --- | --- |
| `match` | 完整匹配文本 |
| `groups` | 捕获组数组；`groups[0]` 是第一组，不是完整匹配 |
| `namedGroups` | 命名捕获组；未匹配组可能是 undefined |
| `message.id`、`message.role` | 当前显示消息的标识和角色 |
| `runId` | 当前 Run 标识 |

没有自动注入整张卡、角色对象、状态 schema、原始模型输出或凭据。props 来自正则匹配，不要把内容拼成可执行源码。

默认以块级容器插入；`Component.srDisplay = 'inline'` 使用行内容器，`'block'` 可显式指定块级。其他值无效。行内组件应返回适合行内的元素，避免破坏段落结构。

WorldStory 使用稳定消息 ID 和 keyed Portal 槽位，正常流式追加尽量保留组件的 React 状态。切换会话、替换舞台、匹配位置变化或组件卸载仍可能重建，不能把局部 state 当作持久保存。

### 规则边界

- `roles` 为非空 user/assistant 数组；pattern 不写正则两侧 `/`，JSON 内反斜杠需要转义。
- flags 允许不重复的 `gimsu`；省略为 `g`，空字符串表示不带 flags。
- 重叠匹配结合规则顺序和结构保护选择；代码、链接目标、HTML 结构和用户指令区域不能任意插入组件。
- 零长度匹配、超限和超时规则会被限制或跳过。规则在 Host 的隔离 Worker 内匹配。
- 组件加载或显示失败时，尽量保留可展示的原文并提示。坏的消息模块不应自动替换整个舞台。
- 替换只影响展示，不改持久化消息或模型历史；用户叙事指令也不是执行脚本入口。
- `origin: 'opening'` 的首条开局正文跳过规则，不能依赖它初始化按钮或状态面板。

如果需要从开局起始就存在的面板，应直接挂在舞台上。如果需要开局详情中的图片或交互，应使用独立预览组件。

规则也支持 `{ type: 'markdown' | 'html', content }` 文本替换，支持 `$$`、`$&`、编号和命名捕获组模板。替换结果仍经过消息清洗，并不会作为任意 HTML 脚本执行。

## WorldStory 消息正文与对白

消息的显示链路为：原文 → 受保护的消息展示规则（开局跳过）→ Markdown/GFM 解析 → HTML 安全清洗 → 对白装饰 → 稳定 DOM 与组件 Portal 更新。它不是把整段文本作为 React/MDX 执行；显示变换不修改持久化原文、模型历史或 SR-RP 输入协议。

- 支持一至六级标题、段落与换行、粗体／斜体／删除线、引用、嵌套有序／无序列表、链接、HTTPS 图片、行内代码、围栏代码块、分隔线及 GFM 表格。
- GFM 任务列表 `- [x]` / `- [ ]` 显示为只读勾选标记；不会开放表单控件或修改消息。数学公式、脚注等额外扩展及 MDX 不属于当前语法契约。
- 正文中成对的 `“中文引号”` 和 `"英文双引号"` 使用橘黄对白色，深色主题提高明度，浅色主题使用较深的橙色以保持可读性。可通过 `--sr-story-speech` 覆盖颜色。
- 引号可以包含普通换行及完整的行内强调；空行分段、不完整的引号、转义的字面引号不会跨段推测。流式输出在配对闭合后着色。
- 代码、HTML、图片语法、链接目标、用户叙事指令以及作者替换／组件区域不自动着色。跨越受保护结构的引号保持原样；不会改写 URL、图片属性或组件 DOM。图片语法与表格单元格中的受保护区域同样参与消息规则的结构保护。
- 普通 `RichText` / `WorldDocumentContent` 继续只负责安全静态正文，不自动套用会话对白装饰。

## 安全静态内容组件

| 组件 | Props | 行为与适用环境 |
| --- | --- | --- |
| `RichText` | `{ text: string }` | 使用 inline 消息清洗策略展示 Markdown/HTML；会话和详情环境都提供 |
| `WorldDocumentContent` | `{ content: string }` | 在已有隔离组件文档内展示 document 策略的正文和允许样式；会话、详情均提供 |
| `WorldDocumentRenderer` | 见下表 | 包导出；平台用它生成隔离静态文档或 inline 正文，详情 SDK 子集不提供 |

`WorldDocumentRenderer` 的参数：

| prop | 默认值 | 说明 |
| --- | --- | --- |
| `content` | 必填 | Markdown/HTML 字符串 |
| `title` | `文档` | 隔离 iframe 的可访问标题 |
| `presentation` | `isolated` | `isolated` 使用无脚本文档 iframe；`inline` 在当前文档内渲染 |
| `density` | `reading` | `reading` 或 `chat`，inline 表面的密度标记 |
| `className` | 空字符串 | 传给渲染容器 |
| `showStyleWarning` | true | 隔离模式中提示被移除的样式 |

普通世界卡详情内容优先使用 `WorldDocumentContent` 或 `RichText`；不要自行创建嵌套文档来代替平台的组件隔离机制。

```tsx
import React from 'react';
import { WorldDocumentContent } from '@sillyrealms/sdk';

export default function IntroductionText() {
  return <WorldDocumentContent content={'# 雾港\n\n渡轮在清晨靠岸。'} />;
}
```

### 正文清洗与组件源码不是同一种权限

Markdown/HTML 正文经过解析和清洗，不执行脚本、事件属性或 MDX 表达式。当前实现移除嵌套 iframe、表单控件、SVG、音视频等元素，图片只保留 HTTPS src；内联样式按属性和值白名单过滤，拒绝 CSS 变量、资源引用和定位等能力。document 策略可保留经过过滤的样式表，message 策略移除样式表。

需要在 HTML 容器的直接文本节点里解析 Markdown 时，可写 `data-sr-markdown="true"`；它不启用 JavaScript。

会话中的 React 作者组件及详情的介绍、开局预览均在独立来源的 `allow-scripts allow-same-origin` 隔离 iframe 中执行；详情保持单独的只读运行环境。直接 JSX 媒体受所在 iframe 的 CSP 约束，图片允许 HTTPS/data/blob，音视频允许 HTTPS/blob。会话和详情组件中的图片保持原 URL，可按源站缓存策略复用浏览器缓存；不保证离线可用或永久命中。**正文里的图片规则与 JSX 媒体规则不同。** 两者都不提供任意 Server 访问、外部脚本加载或离线资源缓存保证。

现有 `plan/` 中的 MDX 方案不代表运行时已经支持 MDX；当前消息渲染使用 Markdown/HTML 清洗与显式消息组件。

实现依据：[WorldStory](../../packages/sr-sdk/src/world-story.tsx)、[消息内容](../../packages/sr-sdk/src/message-content.tsx)、[规则匹配](../../packages/sr-sdk/src/message-matching.ts)、[安全渲染](../../packages/sr-sdk/src/world-document/render.ts)、[文档组件](../../packages/sr-sdk/src/world-document/WorldDocumentRenderer.tsx)、[会话 CSP](../../apps/studio/frame.html)。
