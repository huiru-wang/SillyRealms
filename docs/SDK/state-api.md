# 状态 API

状态是 Server 保存的世界／会话／剧情数据。React 局部状态和 SDK 内部缓存都不能代替持久化状态。先在世界卡 `data.state` 声明类型及 initial，再通过当前环境允许的 API 访问。

## 三个作用域

| scope | 归属与用途 | 会话 API | 世界详情 API |
| --- | --- | --- | --- |
| `global` | 当前世界共享值 | 可读写 | 只读 |
| `session` | 当前会话值 | 可读写 | 禁止 |
| `message` | 沿当前会话历史继承的剧情状态 | 可读写，默认作用域 | 禁止 |

`message` 并非每条消息重置为初值，也不是“当前渲染消息各自的局部状态”。历史消息里的组件调用 `useSRStateAPI`，仍操作当前会话状态，不能据此读写历史时点。若历史按钮不应再次生效，作者需要自行设计可用性限制。

开局 `initial_state` 覆盖已声明的 message 顶层状态项，JSON 值按整项替换；这与运行中的点路径修改不同。`load` 控制模型上下文激活，不是 SDK 状态访问授权。

## 会话状态 API

通过 `useSRStateAPI()` 获取 `SRStateAPI`。

| 方法 | 参数与返回 |
| --- | --- |
| `getState(path, scope?)` | Promise，返回 StateValue 或 undefined；默认 message |
| `batchGetState(entries)` | entries 为 `{ path, scope? }[]`；返回对应顺序的 `{ path, scope, value }[]` |
| `updateState(path, value, scope?)` | 返回结果数组，即使只修改一项也不是单个布尔值 |
| `batchUpdateState(entries)` | entries 为 `{ path, value, scope? }[]`；返回逐项结果数组 |
| `subscribe(listener)` | 订阅 `state.changed`，返回取消函数 |

`StateValue` 是 JSON 值：null、boolean、有限 number、string、数组或对象。undefined 只用于“查询不存在”，不能用作写入值；不支持函数、Date 或类实例作为状态。

### 显式查询与 Hook 缓存

`getState` 和 `batchGetState` 经过 Host 读取 Server 快照。一次 batchGetState 使用同一份读取结果；不存在的路径返回 undefined，不应自动当成网络错误。

`useSRState<T>(path, defaultValue, { scope? })` 返回 `[value, setValue]`：

- value 来自当前 iframe 共享缓存，随状态事件或成功写入响应刷新。
- 默认 scope 为 message。路径未在缓存中找到时使用 defaultValue，null 不会触发默认值。
- defaultValue 不写入数据库；泛型 T 只帮助类型检查，不执行运行时类型转换或校验。
- setValue 接收一个实际值，返回与 `updateState` 相同的 Promise 结果数组。它不是 React 的函数式 updater，不能传 `previous => next`。
- Hook 不暴露 loading/error；显式查询也不等同于刷新整个 Hook 缓存。初次连接与重连的刷新由 frame 管理。

## 更新语义

1. Server 验证请求格式、会话、世界和运行锁。同一世界正在生成时，写入会被拒绝。
2. 按输入顺序逐项校验、提交；一项失败不回滚前面已提交的成功项。
3. 返回每项的 `success`。Promise resolve 本身不代表全部成功；请求级失败仍可能 reject。
4. 只有真正改变且已经提交的值才发布 `state.changed`；写入相同值可成功而不发事件。

global 更新会通知同一世界的会话，session/message 更新只通知相应会话。订阅不是持久事件日志，不保证补发断线期间全部事件。

`getState` 后计算再 `updateState` 是两次操作，没有原子加减、compare-and-swap 或批次全有全无事务保证。不能把一次 read-modify-write 当成并发安全计数器。

### 点路径规则

- 第一段必须是该 scope 已声明并存在的状态项。
- 非 JSON 项只支持整项替换。
- JSON 项可替换自身，或修改已有对象父级中的属性；最终属性可以新增，中间对象不会自动创建。
- 不沿数组索引遍历；修改数组时替换数组所在项或属性。
- 不支持删除路径；null 是一个值，不是删除指令，且必须满足状态类型。
- 空路径段、包含点的键、`__proto__`、`constructor`、`prototype` 不合法；写入路径最多 32 段。
- 数字必须有限并符合 min/max；单项值有 1 MiB 限制，JSON 嵌套还受深度校验。

例如初值为 `profile = { inventory: [], location: { name: '码头' } }`：

| 操作 | 结果 |
| --- | --- |
| 写 `profile.location.name` | 修改已有对象里的属性 |
| 写 `profile.location.visited` | 可新增最终属性 |
| 写 `profile.missing.name` | 中间对象不存在，失败 |
| 写 `profile.inventory.0` | 不支持数组索引，失败 |
| 写 `profile.inventory` 为新数组 | 可行，验证整个 JSON 状态项 |

## 当前类型声明与实际返回的差异

当前 `SRStateAPI` 将写入结果声明为 `{ path, scope, success, message }[]`。但实际 Studio → Server 路径返回 `{ path, scope, success, errorCode, errorMessage }[]`，Host 原样转发，没有转换成 `message`。

这是现有契约差异，不是两个可以任选的稳定版本。所有调用都先检查 `success`；需要显示失败详情时，对实际字段进行运行时检查并兼容旧 message。不要只显示 `result.message`，否则当前服务端失败可能没有说明文字。

下面组件先更新状态，再在所有项成功后填入草稿。假设已声明 `hp` 数值项和 `progress` JSON 项。**状态成功后如果后续动作失败，状态不会自动回滚。**

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { useSRSession, useSRStateAPI } from '@sillyrealms/sdk';

function resultMessage(result: unknown): string {
  if (result && typeof result === 'object') {
    if ('errorMessage' in result && typeof result.errorMessage === 'string' && result.errorMessage)
      return result.errorMessage;
    if ('message' in result && typeof result.message === 'string' && result.message)
      return result.message;
  }
  return '状态更新失败';
}

export default function PrepareDeparture() {
  const state = useSRStateAPI();
  const session = useSRSession();
  const live = useRef(true), locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  async function prepare() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setNotice('');
    try {
      const results = await state.batchUpdateState([
        { path: 'hp', value: 100, scope: 'message' },
        { path: 'progress.phase', value: 'departure', scope: 'message' },
      ]);
      if (!live.current) return;
      const failures = results.filter(result => !result.success);
      if (failures.length) {
        setNotice(failures.map(result => `${result.path}：${resultMessage(result)}`).join('；')
          + '。成功项已保存，未填入后续草稿。');
        return;
      }
      session.setDraft('准备完毕，我出发了。');
      setNotice('状态已保存，回应已填入草稿，请检查后发送。');
    } catch (error) {
      if (live.current) setNotice(error instanceof Error ? error.message : '请求失败');
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }

  return <div>
    <button type="button" disabled={busy} onClick={() => void prepare()}>准备出发并填入草稿</button>
    <p role="status">{notice}</p>
  </div>;
}
```

网络错误不一定证明 Server 未提交。如果提交结果未知，先重新查询相关值，避免盲目重复执行有副作用的组合操作。

## 状态订阅

```ts
type StateEvent = {
  event: 'state.changed';
  data: { path: string; scope: StateScope; value: StateValue };
};
```

订阅只接收后续事件，不自动返回初始值。若一个面板关心 `profile.location`，还需考虑整个 `profile` 被替换的事件，而不能只匹配完整路径相等。简单 UI 优先使用 `useSRState`；自行“先查询、再订阅”可能遗漏两者之间的变化，需要处理请求和事件竞争。

## 世界详情只读 API

`useSRWorldStateAPI()` 返回 `SRWorldStateAPI`：

```ts
type WorldStateQuery = { path: string; scope?: 'global' };

interface SRWorldStateAPI {
  getState(path: string, scope?: 'global'): Promise<StateValue | undefined>;
  batchGetState(entries: WorldStateQuery[]): Promise<Array<{
    path: string;
    scope: 'global';
    value: StateValue | undefined;
  }>>;
}
```

默认 scope 是 global。没有写方法、订阅、会话方法或自动刷新。Host 独立校验查询：单次最多 100 项，path 最长 2048、最多 32 段，拒绝危险键和非 global 范围；当前详情桥请求超时为 15 秒。生命周期结束会清理未完成请求。

详情运行时把 `useSRStateAPI` 映射为同一个只读 Hook，但通用包的 TypeScript 声明仍是完整会话 API。用 `useSRWorldStateAPI` 才能准确表达环境权限；类型断言不能绕过 Host 校验。

实现依据：[状态契约](../../packages/sr-sdk/src/state-contract.ts)、[Hook](../../packages/sr-sdk/src/atomic-context.tsx)、[StateRuntime](../../packages/sr-sdk/src/state-runtime.ts)、[状态写入路由](../../apps/server/src/routes/state-updates.ts)、[路径与类型校验](../../apps/server/src/domain/state/atomic-state.ts)、[详情权限](../../apps/studio/src/features/worlds/world-component-protocol.ts)。
