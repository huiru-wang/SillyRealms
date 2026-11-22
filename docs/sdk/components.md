# 组件、正文与资源

[开发手册目录](README.md)。本章示例从 `@sillyrealms/sdk` 导入。介绍和开局预览只使用标注为“舞台、预览”的接口。

## 公共组件

| API 与环境 | 调用示例 | 使用方法和限制 |
| --- | --- | --- |
| `SR.WorldStory` · 舞台 | `<SR.WorldStory showState={false} />` | 默认 `showState=true`。绘制当前会话、消息匹配组件、历史分页与行动建议。关掉状态面板适合已有自定义侧栏的舞台。点击建议填入宿主草稿；宿主仍拥有输入框。自定义舞台自行决定插入位置。 |
| `WorldDocumentRenderer` · 舞台 | `<WorldDocumentRenderer content={'## 店规\n先入座'} density="chat" className="notice" />` | `WorldDocumentRendererProps` 包含必填的字符串 content、可选 density（reading，默认；或 chat）和 className。舞台入口使用当前 iframe 内的内联文本渲染。 |
| `WorldDocumentContent` · 舞台、预览 | `<WorldDocumentContent content={'<h2>店规</h2><p>今日有雨</p>'} />` | 字符串可含 Markdown 或 HTML。使用文档清洗规则，可保留允许的作者样式。嵌入按钮、脚本和表单不能用来实现交互，交互请直接写 React 组件。 |
| `RichText` · 舞台、预览 | `<RichText text="**掌柜**推开了门。" />` | 参数名为 `text`，内联显示经过清洗的 Markdown/HTML，适合短说明和普通正文。需要保留文档级安全样式时用 `WorldDocumentContent`。 |
| `SRAssetProvider` · 舞台或宿主集成 | `<SRAssetProvider baseUrl={base}><Cover /></SRAssetProvider>` | `baseUrl: string \| null` 与 children 必需。平台已经为卡内组件提供上下文。开发独立渲染宿主时，用当前世界的资源端点包裹组件；覆盖上下文会影响其所有后代。 |

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
