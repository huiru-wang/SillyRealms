# State Hook 与 API 独立重构方案

状态：**设计已确认，待实施**  
日期：2026-11-26  
核对基线：`39994b3`，同时参考当前工作区。实施时保留其他任务对 publication、presentation、世界组件和文档的修改，不以旧版本整文件覆盖。

## 1. 目标、范围与方案优先级

本方案独立完成创作者状态访问能力的重构：

- `useSRState(query)` 负责响应式读取、订阅、读取状态与主动刷新。
- `useSRStateAPI()` 提供唯一的命令式状态入口：`get / set / setMany`。
- global、session、message 共用契约，通过显式 scope 区分。
- 删除 `useSRWorldStateAPI` 等重复作者入口，不保留位置数组查询、空数组仅写模式或旧 tuple Hook 签名。
- 官方状态展示组件与作者组件使用同一契约、同一宿主数据源。
- 写入由服务端确认；单项赋值与批量赋值分别提供清楚的成功、失败语义。

**本文覆盖 [作者 SDK 重构方案](作者SDK重构方案.md) 的 state 小节，以及 [前端目标架构](前端目标架构.md) 中与之冲突的状态接口设计。** 原方案“5 个 Hook”的数量说明应在实施时同步调整，不能据此再次合并这两个职责不同的入口。会话 runs、事件订阅、资源、行动建议等其他接口仍按各自方案处理。

本次保存只新增本文；不表示功能已实现。本项实施无需等待整个作者 SDK 或全局渲染器重构，也不顺带改造会话事件总线、阅读分页、通用组件运行时。必要的状态 Provider、桥接、Server 回执与消费方适配属于本项范围。

不引入通用事务、CAS、函数式远程 updater、任意历史消息寻址、任意 HTTP 代理或新的全局 SSE。数据库结构无需因此变化。

## 2. 当前问题与代码事实

| 当前设计或实现 | 问题与影响 |
| --- | --- |
| 原方案 `useSRState([{scope,path}])` 返回位置数组 `values` | 读取一个字段也要数组和下标；多字段顺序变化容易取错值。 |
| 原方案 Hook 的 `write` 可修改任意查询之外的字段 | 查询实例与命令服务职责混杂；仅写入被迫使用 `useSRState([])`。 |
| 当前 Hook 返回 `[value, setter]`，默认 scope 为 message | 与本地 React 状态过于相似，异步写入、缺失字段及服务端拒绝不够明显。 |
| 当前详情手工将 `useSRStateAPI` 指向只读 global 别名 | 同名 API 在两个环境中的签名和能力不一致。 |
| 当前 stage 状态 Hook 订阅完整 StageSnapshot | 状态展示会受无关叙事快照更新影响；公共状态能力依赖会话 Runtime。 |
| 当前 Host 将读取错误与写入错误汇总到同一个 state error | 一次按钮写入失败可能污染正常状态展示的读取错误。 |
| 当前服务端将缺失路径与同值都归为 `changed:false`，HTTP 成功回执没有结果分类 | SDK 不能可靠判断一次赋值是完成、无需改变，还是根本没写入。 |

核对入口：

- [现有 SDK Hook](../packages/sr-sdk/src/stage/context.tsx)、[Runtime](../packages/sr-sdk/src/stage/runtime.ts)、[状态契约](../packages/sr-sdk/src/state-contract.ts)。
- [详情 frame](../apps/web/src/world-component-frame.tsx)、[Host state controller](../apps/web/src/features/state/index.ts)。
- [状态 patch](../apps/server/src/modules/state/patch.ts)、[StateService](../apps/server/src/modules/state/service.ts)、[set-state 用例](../apps/server/src/usecases/set-state.ts)。

## 3. 作者公开契约

### 3.1 类型与签名

以下为本方案拟冻结的作者契约；辅助类型可按现有 SDK 导出规范组织。类型中的 `StateValue` 复用现有 JSON 状态值定义。

```ts
type StateScope = 'global' | 'session' | 'message';

type StateQuery = {
  scope: StateScope;
  path?: string; // 省略时读取完整 scope
};

type StateTarget = {
  scope: StateScope;
  path: string; // 写入必须是非空有效路径
};

type StateSetInput = StateTarget & {
  value: StateValue;
};

type ReadonlyState<T> =
  T extends readonly (infer V)[] ? readonly ReadonlyState<V>[] :
  T extends object ? { readonly [K in keyof T]: ReadonlyState<T[K]> } :
  T;

interface SRStateError extends Error {
  readonly code: string;
}

interface StateQueryResult<T = StateValue> {
  readonly value: ReadonlyState<T> | undefined;
  readonly loading: boolean;
  readonly error: SRStateError | null;
  refresh(): Promise<ReadonlyState<T> | undefined>;
}

type StateSetResult = {
  changed: boolean;
};

type StateSetManyResult = StateTarget & (
  | { success: true; changed: boolean }
  | { success: false; errorCode: string; errorMessage: string }
);

interface SRStateAPI {
  get<T = StateValue>(
    query: StateQuery
  ): Promise<ReadonlyState<T> | undefined>;

  set(update: StateSetInput): Promise<StateSetResult>;

  setMany(
    updates: readonly StateSetInput[]
  ): Promise<readonly StateSetManyResult[]>;
}

declare function useSRState<T = StateValue>(
  query: StateQuery
): StateQueryResult<T>;

declare function useSRStateAPI(): SRStateAPI;
```

约束：

1. scope 必填，不再默认 message；不接收任意 worldId、sessionId、messageId。
2. 读取省略 path 表示整个作用域；显式空字符串不是省略。写入禁止空路径，不向作者开放整 scope PUT。
3. 路径与 JSON 校验复用既有规范；不增加通配符、表达式或新的路径语法。读缺失路径返回 undefined，写入 value 不接受 undefined、函数或其他非 JSON 值。
4. 返回值只读；泛型是作者的静态类型声明，不替代世界定义或运行时数据校验。
5. Hook 不提供任意路径的 write/set；API 不提供另一套公开 subscribe。普通展示订阅统一由 Hook 管理。
6. 不新增 `useSRStateActions`、`useSRStates` 或 world/session/message 专用别名。首版不提供位置数组或具名批查询重载。
7. `useSRStateAPI` 返回对象及其方法在同一绑定环境内保持稳定，可传给普通业务函数使用；它不是跨世界共享的无绑定全局单例。

### 3.2 常见用法

单字段展示：

```tsx
const hp = useSRState<number>({
  scope: 'message',
  path: 'player.hp',
});

hp.value;
hp.loading;
hp.error;
await hp.refresh(); // 在异步事件处理函数中调用
```

读取整个对象或整个作用域：

```tsx
type Player = { hp: number; gold: number };

const player = useSRState<Player>({
  scope: 'message',
  path: 'player',
});

const worldState = useSRState({ scope: 'global' });
```

少量固定字段分别调用 Hook；多个 Hook 复用宿主的读取协调，不等于每个 Hook 都发独立 HTTP。动态列表将单项查询放在子组件内，或读取其共同对象，不在条件或可变循环中调用 Hook。

只执行操作：

```tsx
const stateApi = useSRStateAPI();

async function changeWeather() {
  return stateApi.set({
    scope: 'global',
    path: 'weather.sky',
    value: '雨',
  });
}
```

一次性读取与批量赋值：

```ts
const gold = await stateApi.get<number>({
  scope: 'message',
  path: 'player.gold',
});

const results = await stateApi.setMany([
  { scope: 'message', path: 'player.hp', value: 80 },
  { scope: 'message', path: 'player.gold', value: 120 },
]);

const failures = results.filter(item => !item.success);
```

`get` 是一次性读取，不建立组件订阅；`setMany` 的逐项结果应由调用方检查。字段示例假定世界已经定义并持有相应路径，赋值不自动创建缺失路径。

## 4. 读取、刷新与订阅语义

### 4.1 value / loading / error

| 情况 | value | loading | error |
| --- | --- | --- | --- |
| 首次读取尚未完成，且无可复用数据 | undefined | true | null |
| 首次读取成功，路径存在 | 已确认值，包括合法的 null | false | null |
| 首次读取成功，路径不存在 | undefined | false | null |
| 首次读取失败 | undefined | false | 明确读取错误 |
| 同一查询正在刷新 | 保留上次已确认值 | true | 本次读取开始时清除旧读取错误 |
| 刷新失败 | 保留上次已确认值 | false | 本次读取错误 |

Hook 挂载时优先复用当前绑定环境内已经确认的数据；需要读取时通过共享状态服务协调。普通重渲染中即使创建了新的 query 对象，只要 scope/path 内容不变，也不重复读取或重建订阅。

查询或绑定身份改变时，立即切换到新查询的数据状态；不可把旧世界、旧路径或旧 message tip 的值当作新目标的结果。新目标已有可靠缓存时可以复用，否则进入首次读取状态。

### 4.2 get 与 refresh

- `get(query)` 发起一次该目标作用域的确认读取，可合并同目标的并发在途读取；成功返回选定值，不保留调用者订阅。
- `refresh()` 对当前查询执行确认读取，成功后更新展示并返回本次值；失败保留同一查询的旧值，更新读取 error，Promise reject。
- 同一次确认读取所得真实数据可以更新宿主共享数据源，从而通知已挂载的相关读者。
- 读取过程中收到更晚的真实事件，或当前 tip/查询改变时，旧结果不得覆盖新事实。复用现有 generation/event 保护，按需要补读。
- 对已经发出的 Promise，以发起时绑定的查询为对象；查询切换或卸载后，其迟到完成不得回写当前组件。解除一个组件不能取消其他读者共享的请求。
- 写入失败通过对应 Promise 或批量回执处理，不写入 Hook 的读取 error。

### 4.3 更新来源与范围

会话内继续消费既有会话 SSE 的 `state.changed`，由 Host 更新已确认值。SDK 只维护不可变展示投影和订阅，不重复实现业务恢复，不按提交值乐观赋值。

单字段订阅只在对应值或其读取状态变化时通知；祖先路径替换和内部 `path:""` 整 scope 事件应使受影响后代查询正确更新。读取整个对象的订阅观察该对象的变化。正文 token、行动建议等无关变化不应驱动状态 Hook 重渲染。

详情中同一世界的多个作者实例共用宿主 global 状态服务；本页面写入确认或主动读取得到的变化同步给相关实例。本项不增加全局事件连接，不承诺详情实时获知其他浏览器的修改；页面现有刷新或 `refresh()` 用于再次确认。

## 5. 写入结果与错误契约

### 5.1 单项 set

`set` 表示将指定路径设置为给定的 JSON 值，不做浅合并，不接受函数式 updater。

| 服务端结果 | set 行为 |
| --- | --- |
| 目标存在且实际修改 | resolve `{ changed: true }` |
| 目标存在且值相同 | resolve `{ changed: false }` |
| 目标路径不存在，底层未修改 | reject，`code = STATE_NOT_FOUND` |
| 参数非法、上下文缺失、权限拒绝、写锁、服务端执行失败 | reject，提供稳定 code 与可显示 message |

`STATE_NOT_FOUND` 是作者层对“未完成赋值”的表达，不要求底层创建字段或改变原有缺失路径忽略规则。

Promise 兑现代表收到可信的已提交/无变化回执，不保证 React 界面已经完成下一次渲染。写入之后的回读失败不能把已经提交成功的写入改报为失败；展示由实际事件或补读接手。

不提供 `set(prev => ...)`。客户端根据旧值计算新值仍然是绝对赋值，不能承诺服务端原子增减。具有扣费、发放等一致性要求的行为需要对应业务命令，不通过此 API 假装完成事务。

### 5.2 setMany

- 返回数组与输入等长且同序，每项包含原 scope/path。
- 成功项使用 changed 区分修改与同值；缺失项映射为 `success:false / STATE_NOT_FOUND`；其他失败保留相应错误码和信息。
- 允许部分成功，不回滚之前已提交的项；底层沿用每项事务。
- 按输入顺序执行。连续同 scope 的项可以复用现有批请求，但不跨组重排；重复路径及父子路径按顺序作用于当时实际值，不额外去重或增加拒绝规则。
- `setMany([])` 返回空数组且不发请求；这不恢复空数组 Hook 模式。
- 整个调用的结构、scope/path/value 合法性以及所需绑定上下文，在执行前完成校验；此类预检失败 reject，且不开始任何写入。
- 执行开始后的逐项业务失败通过逐项结果返回。桥接断开等无法形成完整可信回执的整次失败可以 reject；这不意味着已提交的项被撤销，也不能据此自动重试写操作。
- 批量接口不承诺“扣金币和发道具同时成功”。方法名称、文档和示例不得暗示跨项或跨 scope 原子性。

### 5.3 错误传递

作者侧统一得到带 `code` 的 Error；Hook 的 error 与命令 Promise 使用相同错误结构。

新增作者语义至少明确：

- `STATE_NOT_FOUND`：目标路径不存在，赋值未发生。
- `STATE_CONTEXT_UNAVAILABLE`：缺少所请求 scope 的绑定对象，例如详情没有 session。
- `STATE_CONTEXT_CHANGED`：命令捕获的 message 上下文已经失效。

参数校验、权限、服务端锁与执行错误优先沿用现有明确错误码，例如 `STATE_WRITE_LOCKED`。桥接传递可序列化的错误 code/message，在 SDK 端还原 Error；不能在中间层只保留一段字符串而丢掉错误分类。

## 6. 环境、权限与 message 绑定

| 环境 | 目标能力 |
| --- | --- |
| 世界详情中的介绍、角色介绍、开局等作者组件 | 绑定当前 world；使用 global，不能访问无上下文的 session/message |
| 会话舞台及其消息组件、官方状态组件 | 绑定当前 world、session 与有效 tip；使用授权范围内的三个 scope |
| 无对应绑定的环境 | 明确报告缺少上下文，不自动回退其他 scope |

**详情 global 读写目标沿用原作者 SDK 方案。** 当前代码及 AGENTS 仍规定详情只读；实施时必须显式修改 Host 方法白名单、状态命令、文档与仓库约束，验证仅能操作当前世界。只改 TypeScript 名称或替换注入对象不会完成这项权限变化。此目标不扩展模型配置、会话创建或跨世界操作能力。

一次命令进入 Host 时捕获所需身份；message 使用该时点的有效 tip，不由作者指定历史消息。排队和跨 scope 批次期间，不得重新取 tip 后悄悄把同一次命令写到另一个消息。message 写入应在现有写用例的事务/锁边界内核对绑定仍有效；过期则明确失败。若需补充内部上下文字段，仅用于这一目标核验，不向作者新增 revision/CAS 协议，也不把作者限制错误地施加到模型内部写入流程。

Hook 卸载意味着停止观察；已送达服务端的写请求不会因此自动撤销。

## 7. 服务端回执必须补齐的最小链路

当前缺失与同值的原因在 patch、StateService 和 set-state 之间丢失，不能靠 SDK 写前读取、写后读取或“有没有 SSE”反推结果。

拟在内部成功写回执中增加：

```ts
type StateWriteOutcome = 'changed' | 'unchanged' | 'missing';
```

已有 `success/errorCode/errorMessage` 格式继续作为 HTTP/内部回执结构；成功项补 outcome。作者 API 再映射为本方案的 set/setMany 结果。

必须打通：

1. `modules/state/patch.ts` 与类型：在实际目标判断时区分 missing、unchanged、changed。
2. `StateService`：保留判定，包括 message 继承快照；缺失或同值不物化无必要的 message 快照。
3. `usecases/set-state.ts`：从事务内取得 outcome 并按项返回；只在实际提交变化后发布事件。
4. HTTP 路由与 DTO：传递结果，更新相关契约验证；没有必要变化的路由实现不为目录整齐而重写。
5. Host `writeResults` 校验与投影：保留 outcome，不按旧字段白名单丢弃它。
6. 桥接与 SDK：严格校验回执并映射作者结果；缺少 outcome 时明确报告无效回执，禁止猜成 changed 或 unchanged。

`modules/state/message-updates.ts` 也调用共享 patch，且使用 `requireExisting:true`。改造不得把模型后处理原有的缺失路径错误变成普通忽略，不改变提示词、规则覆盖、模型更新协议或实际写授权。

## 8. 前端内部实现边界

- 从 stage 中抽出独立的状态 Context/Runtime 最小单元，使详情与会话注入同一套作者 Hook/API；不要求世界详情创建空会话 Runtime。
- 复用现有 `api()`、状态 scope endpoint 和会话事件通道。读取按需要的 scope 协调，不为一个路径无条件刷新三个 scope。
- Host 拥有服务端访问、权限、有效状态和读取竞态；frame 保存授权投影并通知订阅。
- 查询复用以实际绑定目标、scope、path 为依据，message 的有效 tip 属于身份；不跨世界或跨 tip 误用值。
- 以被选值和读取元信息判断是否更新订阅，避免每次完整舞台快照的新对象引用造成无关重渲染。
- 详情实例复用 Host global 读取和已确认值，不共享 React 树、作者回调或组件局部状态。
- 写命令与读取状态控制器分开；不把写错误汇入整个 state 读取 error。
- 官方 StatePanel 迁移为公开 Hook；状态 API 不再要求作者直接依赖 StageSnapshot。
- 本项可以沿用两个 frame 入口和既有桥接框架；全局 Renderer/Bridge 抽取不作为先决条件。

实现可使用现有外部 store 订阅方式；不可变快照与稳定订阅引用遵循 [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) 的要求。作者无需理解这层实现。

## 9. 作者出口、样例与独立交付

需要退出新版作者出口：

- 旧 `useSRState(path, defaultValue, options)` tuple 签名。
- 原待实施方案的数组查询、位置 values、Hook.write 与空数组仅写模式。
- `useSRWorldStateAPI`、`SRWorldStateAPI` 以及详情里的同名只读别名。
- 旧状态 API 方法名 `getState/batchGetState/updateState/batchUpdateState/subscribe`，统一使用 get/set/setMany；仅作者状态 API 的 subscribe 退出，不改会话 runs 或事件方案。

检查实际作者导入、官方组件、示例、内置世界源码及制卡环境校验，统一迁移到新契约。不为未发布的作者接口保留永久别名。世界展示与静态文档能力沿现有路径演进；`world-state.tsx` 还包含文档组件，删除状态别名不等于删除整个文件。

本文不授权清理数据库、静默覆盖用户修改的已导入卡或批量改写无关世界数据。版本、presentation 和现有其他工作区变更不属于本项回滚范围。正式实施时再同步上层 SDK 方案及公开手册，避免文档继续并存两套 state 签名。

## 10. 预计变更文件树

以下描述未来实现范围，非已完成变更。新增文件只用于使状态能力独立于会话 Runtime；允许按实际代码合并合理的内部小文件，不新增平行状态服务。

```text
SillyRealms/
├── plan/
│   ├── state-hook-api-refactor.md                 新增 · 本独立方案
│   ├── 作者SDK重构方案.md                        修改 · 实施时同步state及入口清单
│   ├── 作者SDK重构任务.md                        修改 · 同步任务与验收
│   └── 前端目标架构.md                          修改 · 同步状态职责
├── packages/sr-sdk/
│   ├── src/
│   │   ├── state-contract.ts                    修改 · 公共类型及内部写回执
│   │   ├── stage-contract.ts                    修改 · 受限状态命令/投影
│   │   ├── state/
│   │   │   ├── context.tsx                      新增 · 公共Provider与两个Hook
│   │   │   └── runtime.ts                       新增 · 独立状态代理与查询订阅
│   │   ├── stage/
│   │   │   ├── context.tsx                      修改 · 移出旧状态Hook与别名
│   │   │   ├── runtime.ts                       修改 · 复用独立状态能力
│   │   │   ├── index.tsx                        修改 · 统一公开导出
│   │   │   └── state-panel.tsx                  修改 · 官方消费者迁移
│   │   └── world-state.tsx                      修改 · 清除状态别名，保留文档能力
│   └── test/state-hooks.tsx                     新增 · 读取/订阅/生命周期契约验证
├── apps/web/
│   ├── src/
│   │   ├── frame.tsx                            修改 · 会话状态注入
│   │   ├── world-component-frame.tsx            修改 · 详情统一Hook/API
│   │   ├── stage-frame-protocol.ts              修改 · 状态请求与错误传递
│   │   ├── stage-host/StageHost.tsx              修改 · 结构化状态错误回传
│   │   ├── stage-host/commands.ts               修改 · 校验与绑定身份
│   │   └── features/
│   │       ├── sessions/workspace.ts            修改 · 共享状态与投影接入
│   │       ├── state/index.ts                   修改 · 读取协调/回执/读写错误分离
│   │       └── worlds/
│   │           ├── WorldComponentView.tsx       修改 · 共享world状态及受限读写
│   │           └── world-component-protocol.ts  修改 · 详情状态契约
│   └── tests/
│       ├── state.test.mjs                       修改 · 请求复用/真实值/回执
│       ├── stage-frame.test.mjs                 修改 · 注入与请求生命周期
│       ├── stage-host.test.mjs                  修改 · 绑定/权限/错误分类
│       ├── worlds.test.mjs                      修改 · 详情global能力
│       └── session-workspace.test.mjs           修改 · tip/事件与查询协调
├── apps/server/src/
│   ├── modules/state/
│   │   ├── types.ts                            修改 · patch outcome
│   │   ├── patch.ts                            修改 · 事务目标的判定结果
│   │   ├── service.ts                          修改 · 保留outcome和继承语义
│   │   ├── message-updates.ts                  核对 · 保持模型缺失路径语义
│   │   └── service.test.ts                      修改 · changed/unchanged/missing
│   ├── usecases/
│   │   ├── set-state.ts                         修改 · 逐项事务回执/目标核验
│   │   └── set-state.test.ts                    修改 · 回执与部分成功
│   └── routes/
│       ├── state.ts                            核对/按需修改 · 传递结果与绑定
│       └── sessions-state.test.ts               修改 · HTTP契约与锁
├── packages/sr-ui-compiler/src/modules.ts        按需修改 · 实际作者导出/环境检查
├── scripts/world-card.mts                       按需修改 · 复用既有制卡检查
├── examples/                                   修改 · 官方状态示例及世界组件
├── initial-data/worlds/                         按需修改 · 已迁移源码重新打包
├── docs/sdk/{README,state}.md                   修改 · 正式调用契约与示例
├── docs/design/world-components.md              修改 · 详情权限与作者边界
├── docs/runtime/{state-v2,server-http,web-runtime}.md
│                                               修改 · 结果、同步与运行边界
└── AGENTS.md、apps/{web,server}/AGENTS.md         修改 · 实施后同步正式约束
```

## 11. 实施顺序

1. 冻结本文作者类型、结果映射与环境契约；清点真实调用点。
2. 在 Server patch/service/usecase 贯通 outcome，验证缺失/同值/实际变化与模型原有行为。
3. 修改 Host 状态协调与回执校验，分离读取错误和写命令失败，固定命令上下文。
4. 实现独立状态 Provider、两个 Hook 与三个 API 方法，接入会话和详情。
5. 迁移官方状态组件、作者样例、内置世界源码和导出/制卡检查，移除旧作者入口。
6. 同步关联方案、正式手册和 AGENTS，完成针对性验证及静态构建。

不需要先完成全局渲染器重构或其他 SDK Hook 的治理。

## 12. 验收标准

### 调用与读取

- 单字段读取不需要数组和下标；对象与完整 scope 读取可用。
- 两个入口职责明确：Hook 自动观察，get 不订阅，写按钮不声明空查询。
- 首次加载、缺失路径、JSON null、读取失败和刷新失败可区分。
- 刷新保留旧值；Promise 返回新值，失败 reject；写错误不污染读取 error。
- query 字面量普通重渲染不重复请求；同目标并发读取可复用。
- 单字段未变化时，无关字段及叙事 token 不使该 Hook 重新发布值。
- query/世界/session/tip 切换和卸载后，迟到读取不能覆盖新目标。
- 整对象替换与整 scope 事件正确更新后代订阅。

### 写入

- set 的 changed=true/false 来自事务内真实判定。
- 缺失路径：底层不创建、不发变化事件；set 抛 STATE_NOT_FOUND。
- setMany 同序、等长、逐项结果；缺失项明确失败，其他有效项仍可成功。
- 预检失败不开始写入；执行中失败不回滚之前提交的项。
- 重复和父子路径按输入顺序处理，不通过重排分组改变结果。
- 同值/缺失不物化无必要的 message 快照；模型 requireExisting 行为不变。
- 写入提交后同步失败不改报写失败；未取得回执的传输异常不自动重试。
- 队列等待期间 tip 改变，不把旧操作写向另一个 tip。

### 环境与集成

- 详情 global 目标能力在 Host 实际实现；session/message 和跨世界越权被拒绝。
- 官方 StatePanel、作者组件和两种 frame 使用相同公开契约。
- 不增加 SSE 连接，不让 iframe 直接发业务 HTTP。
- 旧状态别名从作者类型、运行时注入、官方样例及文档一致退出。
- 不回退工作区既有 publication/presentation 等改动。

实现阶段按实际风险运行 Server 状态函数/路由测试、Web 状态/桥接/工作区测试、新 Hook 生命周期验证，以及 `pnpm typecheck`、`pnpm lint`、`pnpm build`；涉及制卡改动时运行对应检查。复用现有测试命令与注入端口，不为本项启动真实服务、模型或新增浏览器 mock 环境。源码检查、类型/构建通过、世界卡静态检查与实际导入游玩分别记录，不能互相代替。

本文保存阶段只验证文档完整性、相对链接与实际文件落盘，不声称已通过上述实现验收。
