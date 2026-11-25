# 组件、正文与资源

[开发手册目录](README.md)。本章示例从 `@sillyrealms/sdk` 导入。介绍和开局预览只使用标注为“舞台、预览”的接口。

## 公共组件

| API 与环境 | 调用示例 | 使用方法和限制 |
| --- | --- | --- |
| `SR.WorldStory` · 舞台 | `<SR.WorldStory showState={false} />` | 默认 `showState=true`。绘制当前会话正文、消息匹配组件与历史分页，不显示「故事」标题。`showState=false` 会同时移除状态面板入口及整条工具栏，适合已有自定义侧栏的舞台。行动建议由独立组件显示；宿主仍拥有输入框。 |
| `SR.ActionSuggestions` · 舞台 | `<SR.ActionSuggestions />` | 读取当前行动建议，点击后替换并展开宿主草稿。组件不定位消息、不读取历史，也不直接发送；在 Stage 顶层确认 items 非空后，连同整个行动区容器一起挂载。 |
| `WorldDocumentRenderer` · 舞台 | `<WorldDocumentRenderer content={'## 店规\n先入座'} density="chat" className="notice" />` | `WorldDocumentRendererProps` 包含必填的字符串 content、可选 density（reading，默认；或 chat）和 className。舞台入口使用当前 iframe 内的内联文本渲染。 |
| `WorldDocumentContent` · 舞台、预览 | `<WorldDocumentContent content={'<h2>店规</h2><p>今日有雨</p>'} />` | 字符串可含 Markdown 或 HTML。使用文档清洗规则，可保留允许的作者样式。嵌入按钮、脚本和表单不能用来实现交互，交互请直接写 React 组件。 |
| `RichText` · 舞台、预览 | `<RichText text="**掌柜**推开了门。" />` | 参数名为 `text`，内联显示经过清洗的 Markdown/HTML，适合短说明和普通正文。需要保留文档级安全样式时用 `WorldDocumentContent`。 |
| `SRAssetProvider` · 舞台或宿主集成 | `<SRAssetProvider baseUrl={base}><Cover /></SRAssetProvider>` | `baseUrl: string \| null` 与 children 必需。平台已经为卡内组件提供上下文。开发独立渲染宿主时，用当前世界的资源端点包裹组件；覆盖上下文会影响其所有后代。 |

## 行动建议与舞台组合

`useSRActionSuggestions()` 返回只读的 `{items: readonly string[]}`，初始为空数组。详情介绍和开局预览没有会话 Provider，不能使用这个 Hook 或行动组件。宿主负责建议更新、接受新执行后的清空和历史恢复；组件只读取最终数据，具体生命周期见[会话与历史](session.md#usesractionsuggestions)。

无自定义 Stage 时，平台使用正文与行动区的默认组合。有自定义 Stage 时，平台只渲染作者入口；仅放入 `SR.WorldStory` 不会自动出现行动建议。作者可以按下面的完整示例组合官方组件：

```tsx
import React from 'react';
import { SR, useSRActionSuggestions } from '@sillyrealms/sdk';

const styles = `
.story-stage {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: var(--sr-story-bottom-inset, 0px);
}
.story-reading {
  flex: 1;
  min-height: 0;
  min-width: 0;
  --sr-story-reading-bottom-space: 16px;
  --sr-story-content-bottom-inset: 0px;
}
.story-actions {
  box-sizing: border-box;
  flex: none;
  min-height: 0;
  max-height: clamp(calc(var(--control-height, 36px) + 20px), 30%, 240px);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 10px 16px;
}
`;

export default function StoryStage() {
  const { items } = useSRActionSuggestions();
  return <main className="story-stage">
    <style>{styles}</style>
    <div className="story-reading"><SR.WorldStory /></div>
    {items.length > 0 && (
      <div className="story-actions"><SR.ActionSuggestions /></div>
    )}
  </main>;
}
```

WorldStory 与行动区是兄弟组件。整个带背景、边框、padding 或高度的行动区都要放在条件里；items 为空时没有容器、空框或占位。正文占剩余空间并保留自己的滚动。行动区限高通常按容器的 30%，最高 240px；可用高度很小时，限高允许至少一行标准按钮加外层留白，避免只露出无法操作的窄条。这只是 max-height 的下限，不是常驻 min-height。长内容独立滚动，不增加「故事」或行动项顶栏。完整作者 Stage 可以自行调整布局，也可以用同一 Hook 编写自己的视图；无需新增世界卡字段、renderer 绑定或正则。

组合布局由外壳一次性避让宿主输入区。两个公开 CSS 变量控制 WorldStory 的局部留白：

| 变量 | 默认值与用途 |
| --- | --- |
| `--sr-story-reading-bottom-space` | 独立使用时默认 128px。已由外壳避让输入区的组合可设为 16px，保留小段阅读尾白。 |
| `--sr-story-content-bottom-inset` | 默认跟随 `--sr-story-bottom-inset`。组合外壳已避让时设为 0px，正文局部控件不重复抬高；fixed 状态对话框仍按原舞台视口 inset 避让。 |

行动组件使用公共主题变量，样式独立于 WorldStory。平台 frame 已加载 `@sillyrealms/sdk/action-suggestions.css`，世界卡不要导入 CSS 子路径；外部宿主集成时才需要自行加载该样式。官方组件自身没有外层 margin/padding，行动区高度、留白和滚动由组合决定。

## 自定义行动视图

作者组件可以直接读 Hook，然后选择调用现有 `session.setDraft(text)` 或 `session.send(text)`。以下视图显示「直接行动」，提交普通文本，不先填入草稿；若希望玩家先编辑，将调用改为 setDraft，并同步改按钮文案。

```tsx
import React from 'react';
import {
  useSRActionSuggestions, useSRSession, useSRStageSnapshot,
} from '@sillyrealms/sdk';

export default function DirectActions() {
  const { items } = useSRActionSuggestions();
  const session = useSRSession();
  const snapshot = useSRStageSnapshot();
  const busy = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const disabled = pending || !snapshot.connected ||
    snapshot.sending || snapshot.activeRunId !== null;

  async function choose(text: string) {
    if (busy.current || disabled) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await session.send(text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '行动提交失败');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (!items.length) return null;
  return <section aria-label="行动建议">
    {items.map((text, index) => (
      <button key={index} type="button" disabled={disabled}
        onClick={() => void choose(text)}>
        直接行动：{text}
      </button>
    ))}
    {error && <p role="alert">{error}</p>}
  </section>;
}
```

上层 Stage 仍按 items 条件挂载整个行动区。pending、错误和防双击锁属于视图局部状态，不进入建议 Hook。通用连接、运行和提交状态从现有快照读取；实际命令仍由 Host 检查，异步失败需要反馈。send 成功表示已受理，不表示模型完成，也不会覆盖或清空玩家现有草稿。不要在挂载 effect 中自动发送，或通过事件订阅另建建议缓存。

## 资源 Hook

- `useSRAssetUrl(uri: string | null): string | null`（舞台、预览）。例如 `const cover = useSRAssetUrl('sr-asset://assets/cover.png');`，随后渲染 `cover && <img src={cover} alt="饭馆门面" />`。null 表示无资源。包内素材放在 ZIP 的 `assets/`，使用原始 Unicode 路径；SDK 会校验路径并编码 URL。有效的绝对 HTTP(S) 地址也可解析，最终加载受 iframe CSP 与资源来源限制。URL 转换不检查文件是否存在。
- `useSRAssetBaseUrl(): string | null`（舞台）。例如 `const base = useSRAssetBaseUrl();`，得到当前世界的 `…/api/v1/worlds/<id>/resources/`。它适合要给通用渲染器传基址的场合；显示单张图优先使用 `useSRAssetUrl`。不要按 iframe 的 `location.origin` 推测主站地址。

**完整示例 · 包内封面与图注**

```tsx
import React from 'react';
import { RichText, useSRAssetUrl } from '@sillyrealms/sdk';

export default function Cover() {
  const src = useSRAssetUrl('sr-asset://assets/cover.png');
  return <figure>{src && <img src={src} alt="饭馆门面" />}
    <figcaption><RichText text="**晚市**开始了。" /></figcaption></figure>;
}
```

## 消息组件与 MessageComponentProps

将组件登记在 `data.components`，由 `data.message_render.rules` 的 `replacement.component` 引用。下面是规则片段，数组放在 `rules` 字段内。只有在使用官方正文渲染链路时，这条规则才会把助手正文里的 `[银钱:12]` 替换成组件。

```json
[
  {
    "id": "coin-label",
    "roles": ["assistant"],
    "pattern": "\\[银钱:(\\d+)\\]",
    "flags": "g",
    "replacement": {"type": "component", "component": "CoinLabel"}
  }
]
```

```tsx
import React from 'react';
import type { MessageComponentProps } from '@sillyrealms/sdk';

export default function CoinLabel({ match, groups, message }: MessageComponentProps) {
  return <span title={match} data-message-id={message.id}>银钱 {groups[0] ?? '未知'}</span>;
}
CoinLabel.srDisplay = 'inline' as const;
```

| 输入或配置 | 含义及用法 |
| --- | --- |
| `match` | 整段匹配原文，如 `[银钱:12]`。在 JSX 中按普通字符串显示。 |
| `groups`、`namedGroups` | `groups[0]` 是第一个捕获组，命名捕获用 `namedGroups.amount`。可选组未命中时为 undefined。 |
| `message`、`runId` | `message.id`、`message.role` 和本轮 `runId` 标识展示位置。消息组件同样可使用会话 Hook；仅凭历史消息 ID 不能重新生成历史轮次。 |
| `srDisplay` | 默认按块级组件处理，行内标记设为 `'inline'`；另一合法值为 `'block'`。将它设在默认导出的组件上。 |

正则需要产生非空匹配。可用 flags 为 `g/i/m/s/u`，每个最多一次，默认 g。可用 `roles` 限定用户或助手。渲染器还支持 `{type:"markdown", content:"…"}` 和 `{type:"html", content:"…"}` 静态替换。消息替换只改变显示，正文和状态的持久化由宿主负责。[展示与组件契约](../design/world-components.md)
