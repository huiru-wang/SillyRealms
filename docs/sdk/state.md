# 状态读写

[开发手册目录](README.md)。先在世界卡的 `data.state.scopes` 中声明要读写的根字段。以下示例假设已定义 `global.weather.sky`、`session.chapter` 和 `message.coins`，其中 coins 为数值。替换成自己卡片的实际字段。状态路径按点号逐层读取对象属性，作用域单独传参，例如 `getState('weather.sky', 'global')`。数组按整个字段读取或替换。

| `StateScope` | 值属于谁 | 典型用途 |
| --- | --- | --- |
| `global` | 同一世界的所有会话 | 各会话共享的世界天气 |
| `session` | 当前会话 | 本局章节 |
| `message` | 当前会话末端消息的有效视图，沿消息前驱继承 | 随回合变化的钱币 |

`StateValue` 为 JSON 值，可以是 null、布尔、有限数值、字符串、数组或对象。`StateSnapshot` 包含以三个 scope 命名的字段字典。缺失路径查询返回 `undefined`；已存在的字段可以存储 `null`。

## useSRState(path, defaultValue, options?)

在 Stage 组件顶层调用，返回只读快照中的当前值和一个异步设置函数。`options.scope` 默认 `message`。缺失路径时显示 `defaultValue`，此值不会建字段。泛型描述作者预期的字段类型，应与卡定义一致。设置函数接收具体的新值，返回 `Promise<StateWriteResult[]>`。

```tsx
import React from 'react';
import { useSRStageSnapshot, useSRState } from '@sillyrealms/sdk';

export default function Purse() {
  const [coins, setCoins] = useSRState<number>('coins', 0, {scope: 'message'});
  const s = useSRStageSnapshot();
  const [notice, setNotice] = React.useState('');
  async function reset() {
    try {
      const [row] = await setCoins(0);
      setNotice(row?.success ? '已处理，请以显示余额为准' : row?.errorMessage ?? '缺少写入回执');
    } catch (e) { setNotice(String(e)); }
  }
  return <><p>余额 {coins}</p>
    <button disabled={!s.connected || s.sending || !!s.activeRunId || s.stateLoading}
      onClick={reset}>清零</button><p role="status">{notice}</p></>;
}
```

## useSRStateAPI()

会话中返回 `SRStateAPI`。以下示例令 `const state = useSRStateAPI();` 位于组件顶层。用于按需读取、批量更新或接收变更通知，调用时的返回值与用于渲染的快照各有生命周期。

| 方法 | 示例 | 返回与注意事项 |
| --- | --- | --- |
| `getState(path, scope?)` | `await state.getState('chapter', 'session')` | `Promise<StateValue \| undefined>`，默认 message。需要持续显示时用 `useSRState`，避免每次 render 发请求。 |
| `batchGetState(entries)` | `await state.batchGetState([{path:'coins'}, {path:'weather.sky', scope:'global'}])` | 一次读取后按输入顺序返回 `{path, scope, value}[]`，每项可指定不同作用域。 |
| `updateState(path, value, scope?)` | `const [row] = await state.updateState('coins', 12);` | 单项也返回结果数组。按整项替换给定路径的值；检查 `row?.success`。 |
| `batchUpdateState(entries)` | `const rows = await state.batchUpdateState([{path:'chapter', scope:'session', value:'晚市'}, {path:'coins', value:12}]);` | 每项含 path、value、可选 scope。顺序对应，结果可能部分成功；不能依赖跨项或跨作用域回滚。 |
| `subscribe(listener)` | `React.useEffect(() => state.subscribe(e => console.info(e.data.scope, e.data.path, e.data.value)), [state]);` | 仅接收 `StateChangedEvent`；返回取消函数。`path === ''` 表示整个 scope 被替换。 |

**写入结果。** `StateWriteResult` 含 `scope/path/success/errorCode/errorMessage`，错误可能附带 `stateScope/statePath/rulePath`。先捕获桥接或请求拒绝，再逐项检查 `success`。有效写入仅修改已有路径；路径缺失可能得到成功但值未改变。同值或忽略项不会产生变更事件。UI 以宿主回读或快照显示的有效值为准。

**运行锁。** 当前会话生成时，session/message 状态写入会被拒绝。只要同一世界任一会话在生成，global 也可能返回 `STATE_WRITE_LOCKED`。界面检查 `activeRunId` 只能判断当前会话。有关范围、类型、写入路径的规则见[状态契约](../runtime/state-v2.md)。

## useSRWorldStateAPI()

在正式舞台和介绍、开局预览中都返回 `SRWorldStateAPI`，只有两个方法。适合需要在两种环境复用的只读组件。

| 方法 | 示例 | 注意事项 |
| --- | --- | --- |
| `getState(path, scope?)` | `await world.getState('weather.sky')` | 返回 `Promise<StateValue \| undefined>`，作用域固定 global，可显式传 `'global'`。 |
| `batchGetState(entries)` | `await world.batchGetState([{path:'weather.sky'}, {path:'weather.wind', scope:'global'}])` | 输入元素类型 `WorldStateQuery`，结果按顺序含 path、scope、value。预览每次最多 100 项，单路径最多 2048 个 JS 字符串长度单位、32 段。 |

**完整示例 · 介绍页读取天气**

```tsx
import React from 'react';
import { useSRWorldStateAPI } from '@sillyrealms/sdk';

export default function Introduction() {
  const world = useSRWorldStateAPI();
  const [sky, setSky] = React.useState('正在读取天气…');
  React.useEffect(() => {
    let mounted = true;
    world.getState('weather.sky')
      .then(value => { if (mounted) setSky(typeof value === 'string' ? value : '天气未记录'); })
      .catch(() => { if (mounted) setSky('天气暂时不可用'); });
    return () => { mounted = false; };
  }, [world]);
  return <p>{sky}</p>;
}
```

预览的每次显式查询读取当前 global 值，切换回已缓存的预览可能不会重新挂载。需要手动刷新时，将查询绑定到按钮。路径、数量与作用域会在宿主再次验证。[预览查询协议](../../apps/web/src/features/worlds/world-component-protocol.ts)
