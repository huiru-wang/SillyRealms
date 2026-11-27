# SillyRealms 创作者 SDK 开发手册

本手册对应当前仓库的 `@sillyrealms/sdk` 0.1.0。世界卡作者可以用 React TSX 编写会话舞台、消息组件、世界介绍、角色介绍和开局预览。生成世界卡的 Agent 应先确定组件运行的位置，再选择下表中的接口。包根导出的 TypeScript 类型描述会话舞台的完整能力，世界详情预览在运行时只注入其中的一部分。

从玩法开始请读[创作者手册](../creator/README.md)；查完整字段请读[世界卡格式参考](../reference/world-card.md)。本手册用于查接口，不要求第一次制作世界卡就通读全部章节。

## 按任务查阅

| 要完成的工作 | 章节 |
| --- | --- |
| 发消息、停止、重新生成、读历史、订阅事件、使用快照、声明输入区按钮 | [会话与历史](session.md) |
| 显示状态、修改已有字段、读取预览中的世界状态 | [状态读写](state.md) |
| 组合官方正文与行动建议、自定义行动视图、替换消息片段、显示文档和图片 | [组件与资源](components.md) |
| 在仓库工具或宿主项目中校验世界卡、解析资源路径或嵌入文档 | [包子路径与校验工具](tooling.md) |

## 运行环境与公开接口

| 从 `@sillyrealms/sdk` 导入的值 | 会话舞台、会话消息组件 | 详情页的介绍、开局预览 |
| --- | --- | --- |
| `useSRSession`、`useSRHistory`、`useSRStageSnapshot` | 当前绑定会话 | 无 |
| `useSRActionSuggestions` | 当前建议的只读 items | 无 |
| `useSRComposerButtons` | 当前舞台统一声明输入区快捷按钮 | 无 |
| `useSRState` | 三个作用域的响应式字段 | 无 |
| `useSRStateAPI` | 三个作用域的读、写、事件订阅 | 无 |
| `useSRWorldStateAPI` | 只读 global | 只读 global |
| `useSRAssetUrl` | 可用 | 可用 |
| `useSRAssetBaseUrl`、`SRAssetProvider` | 可用，宿主已提供资源地址 | 由宿主提供上下文，作者仅可调用 `useSRAssetUrl` |
| `SR.WorldStory`、`SR.ActionSuggestions` | 可用 | 无 |
| `WorldDocumentRenderer`、`WorldDocumentContent` | 可用 | 可用 |

Stage iframe 接收宿主投递的只读快照，并通过 SDK 命令与宿主通信。宿主负责会话身份、HTTP、事件连接和历史同步。作者组件应通过 Hook 获取所需数据；文件里的包子路径、任意 npm 包、直接请求 Server API 都不属于卡内导入接口。详情预览没有会话身份。类型导入请使用 `import type`。

## 第一个会话舞台

在 ZIP 中创建 `components/InnStage.tsx`。这个完整组件显示连接状态，组合负责正文/分页的 WorldStory 与独立行动区：

```tsx
import React from 'react';
import {
  SR, useSRActionSuggestions, useSRStageSnapshot,
} from '@sillyrealms/sdk';

const styles = `
.first-stage {
  box-sizing: border-box;
  height: 100%; min-height: 0; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden;
  padding-bottom: var(--sr-story-bottom-inset, 0px);
}
.first-stage-status { flex: none; }
.first-stage-reading {
  flex: 1; min-height: 0; min-width: 0;
  --sr-story-reading-bottom-space: 16px;
  --sr-story-content-bottom-inset: 0px;
}
.first-stage-actions {
  box-sizing: border-box; flex: none; min-height: 0;
  max-height: clamp(calc(var(--control-height, 36px) + 20px), 30%, 240px);
  overflow: auto; padding: 10px 16px;
}
`;

export default function InnStage() {
  const { connected } = useSRStageSnapshot();
  const { items } = useSRActionSuggestions();
  return <main className="first-stage">
    <style>{styles}</style>
    <p className="first-stage-status" role="status">
      {connected ? '已连接' : '正在连接…'}
    </p>
    <div className="first-stage-reading"><SR.WorldStory /></div>
    {items.length > 0 && (
      <div className="first-stage-actions"><SR.ActionSuggestions /></div>
    )}
  </main>;
}
```

行动区连同有留白的外层容器一起条件挂载，空数组时不占位置。Hook 只读宿主数据；完整生命周期与作者视图见[会话](session.md#usesractionsuggestions)和[组件组合](components.md#行动建议与舞台组合)。

在现有 `world.json` 的 `data` 对象中登记组件。以下是要合并的字段；保留卡片已有的角色和开局等内容。

```json
{
  "components": [
    { "id": "InnStage", "path": "sr-asset://components/InnStage.tsx" }
  ],
  "stage_component": "InnStage"
}
```

将 `world.json` 放在 ZIP 根部，导入世界卡并打开会话。详情中的世界介绍、角色介绍和开局预览分别通过 `data.presentation`、`characters[].presentation`、`openings[].presentation` 的组件分支引用对应 ID。三处也支持 `{type:"markdown",text:"..."}`；组件分支为 `{type:"component",component:"ID"}`。仅注册进 `components` 的模块不会自行挂载。组件可以用 `import Child from './Child'` 引入另一项已登记的组件 ID；卡内依赖使用默认导出、静态导入且不能成环。指定 `path` 时平台优先读包内文件，读失败会显示错误。[完整卡片示例](../../examples/worlds/fog-harbor/world.json) · [可运行示例说明](../../examples/worlds/README.md) · [组件挂载与预览契约](../design/world-components.md)

## 编写与排错

- 在 React 组件或自定义 Hook 顶层调用 Hook，将异步命令放在用户操作或 effect 中。界面用快照渲染，监听事件用 effect 注册并返回取消函数。将命令拒绝和状态写入的逐项结果分别处理。
- 组件提示缺少导出时，先按上表检查运行位置。跨两端使用的只读组件导入 `useSRWorldStateAPI`。
- 加载、离线和刚挂载都是正常状态。读取 `runs.at(-1)`、活动执行 ID 或可选资源前处理空值。命令超时或连接中断时先恢复同步再判断结果，避免重复发送消息。
- 作者预览在详情切换时可能保留 React 状态；隐藏时普通 JavaScript 仍可能运行。在 effect 清理函数中解除订阅、定时器，并避免在组件卸载后写回异步读取的结果。

维护 SDK 或生成工具时，以[包导出表](../../packages/sr-sdk/package.json)、[作者入口](../../packages/sr-sdk/src/stage/index.tsx)和[预览注入表](../../apps/web/src/world-component-frame.tsx)核对能力。
