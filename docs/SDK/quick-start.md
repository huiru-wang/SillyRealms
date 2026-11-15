# 开发者入门

本文面向世界卡作者。组件使用 React TSX/JSX，源码作为字符串放入 `data.components[].component`，由 Studio 编译并在隔离 iframe 中运行。当前平台使用 React / ReactDOM 19.2，已经提供 SDK Provider、挂载根节点和官方故事样式；作者不需要自行建立会话连接。

## 1. 最小会话舞台

以下是组件 `WorldStage` 的源码。默认导出是必要的；把这个组件的 ID 写入 `data.stage_component`。

```tsx
import React from 'react';
import { SR } from '@sillyrealms/sdk';

export default function WorldStage() {
  return <SR.WorldStory />;
}
```

放入卡中后的相关字段如下。这是 `data` 内的局部片段，不是完整可导入世界卡：

```json
{
  "stage_component": "WorldStage",
  "components": [
    {
      "id": "WorldStage",
      "component": "import React from 'react'; import {SR} from '@sillyrealms/sdk'; export default function WorldStage(){return <SR.WorldStory/>;}"
    }
  ]
}
```

如果只使用官方舞台，可以省略 `stage_component`。组件库仍可提供消息正则组件。指定不存在的舞台 ID 会提示并回退；指定存在但损坏的组件会显示错误。

## 2. 添加“填入草稿”按钮

按钮让玩家先审阅、再发送；这里不调用模型。

```tsx
import React from 'react';
import { SR, useSRSession } from '@sillyrealms/sdk';

export default function WorldStage() {
  const session = useSRSession();
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <button type="button" onClick={() => session.setDraft('我仔细观察周围。')}>
        将“观察周围”填入草稿
      </button>
      <div style={{ flex: 1, minHeight: 0 }}><SR.WorldStory /></div>
    </div>
  );
}
```

`setDraft` 替换平台草稿并展开输入区，没有完成回执，也不自动发送。需要“立即发送”时使用 `await session.send(text)` 并处理失败，详见 [会话 API](session-api.md)。

## 3. 添加响应式状态展示

先在世界卡声明状态。例如下面片段放入 `data.state`：

```json
{
  "schema_version": 1,
  "scopes": {
    "message": {
      "hp": { "type": "number", "initial": 100, "min": 0, "max": 100 }
    }
  }
}
```

组件 `Health` 读取这一状态：

```tsx
import React from 'react';
import { useSRState } from '@sillyrealms/sdk';

export default function Health() {
  const [hp] = useSRState<number>('hp', 100, { scope: 'message' });
  return <p>体力：{hp}</p>;
}
```

第二个参数是本地显示默认值，不会创建或保存状态。初始状态快照尚未加载、路径不存在时都可能显示默认值；这个 Hook 没有独立的加载或错误字段。需要明确区分加载中、查询失败和不存在时，使用 `getState` 配合自己的加载状态。

在另一个组件中使用 `import Health from './Health'` 引入卡内模块。不要加 `.tsx` 扩展名，除非它本身就是组件 ID 的一部分；解析的是精确 ID，不是文件路径。

## 4. 编写只读世界介绍

详情组件使用另一种环境。下面组件假设卡中声明了 global 状态 `weather`，并通过 `data.description` 引用 `WorldIntroduction`。

```tsx
import React, { useEffect, useState } from 'react';
import { useSRWorldStateAPI } from '@sillyrealms/sdk';

export default function WorldIntroduction() {
  const state = useSRWorldStateAPI();
  const [text, setText] = useState('正在读取天气…');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setText('正在读取天气…');
    state.getState('weather', 'global').then(
      value => { if (active) setText(value === undefined ? '尚未定义天气' : String(value)); },
      () => { if (active) setText('读取失败，请重试'); },
    );
    return () => { active = false; };
  }, [state, revision]);

  return (
    <section>
      <h1>雾港</h1>
      <p role="status">{text}</p>
      <button type="button" onClick={() => setRevision(value => value + 1)}>刷新天气</button>
    </section>
  );
}
```

引用片段：

```json
{
  "description": { "type": "component", "component": "WorldIntroduction" }
}
```

该组件不能发送、写状态或查询 session/message。没有隐式订阅，所以示例明确提供刷新按钮。开局预览具有相同权限，通过开局的 `type: "component"` 和 `component` 字段引用；它不会获得 `groups` 等消息匹配参数。

## 模块与依赖规则

| 可使用 | 限制 |
| --- | --- |
| `react` | 复用平台提供的 React |
| `react-dom/client`、`react/jsx-runtime` | 编译器白名单中的模块；普通组件无需自行创建根节点 |
| `@sillyrealms/sdk` | 能力取决于会话或详情环境 |
| `./组件ID` | 仅静态默认导入，依赖必须在同一张卡中存在 |

不支持任意 npm 包、URL 模块、动态 `import()`、源码 `require()`、卡内命名导入、转发导出或循环依赖。SDK 的样式子路径虽然是工作区包导出，但不是作者源码的外部模块白名单项；官方样式由平台加载。

同一个 iframe 内共享模块会缓存；不同详情预览或会话 iframe 不是共享的全局对象。不要用模块变量代替持久化状态。

## 接入时检查

- 完整世界卡符合 [世界卡结构规范](../world/world-card.md)，组件 ID 与引用一致。
- 异步查询有加载、空态、失败反馈，并在卸载后停止更新组件状态。
- 所有订阅在 React Effect 清理函数中取消；操作按钮避免重复提交。
- 状态更新检查每一项的 `success`，不能把 Promise resolve 当作全部成功。
- 通过平台发送／停止测试实际流程；分别检查开局和后续消息。
- 在窄屏和桌面检查滚动、焦点、正文与平台输入区遮挡，不能仅凭源码推断视觉效果。

需要完整自定义历史列表前，先阅读 [运行逻辑](runtime-and-troubleshooting.md)。`SR.WorldStory` 已处理历史与事件竞争、流式偏移、终态覆盖及阅读位置；包入口没有导出这些内部 reducer。
