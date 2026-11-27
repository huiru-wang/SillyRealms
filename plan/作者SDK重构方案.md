# 世界组件与舞台 SDK 目标方案

2026-11-27 · 目标版本，待实施。本文统一定义从 `@sillyrealms/sdk` 根入口导入的作者能力、允许挂载的环境，以及官方组件如何使用这些能力。实现顺序和验收在[重构任务](作者SDK重构任务.md)。当前可运行接口以[当前 SDK 手册](../docs/sdk/README.md)和[实际根导出](../packages/sr-sdk/src/stage/index.tsx)为准。

## SDK 服务哪些组件

**世界详情中，介绍、角色介绍和开局预览里的内容组件走 SDK；会话中，默认舞台、自定义舞台及消息匹配组件也走 SDK。官方和作者组件在同一环境中使用同一套业务接口、权限和已确认数据。** 例如，官方状态面板和作者背包组件通过同一套状态 Hook 读取金币，两者都能区分缺失值和零。

详情页导航、编辑世界元数据、创建会话，以及会话主站的输入框、停止、重新生成、立绘开关、用量和帮答草稿属于可信 Host。它们提供或管理能力，可以直接使用所属 feature。官方内容组件如需某项业务数据，先定义作者也能使用的公开能力；需要主站权限的操作留在 Host。主题、隔离 iframe、组件加载、正文清洗和消息规则匹配属于渲染基础设施，SDK 可在内部复用。参考[世界组件边界](../docs/design/world-components.md)。

## 公开能力清单

“详情”指当前绑定世界的内容预览。“舞台”含默认和作者舞台。“消息”指在会话里由消息规则挂载的组件。表中示例均为目标用法，Hook 在 React 组件顶层调用。

| 公开入口 | 详情 | 舞台 | 消息 | 简单示例 |
|---|---|---|---|---|
| `useSRSession(selector?)` | — | ✓ | ✓ | `useSRSession(s => s.status)`；读取当前执行、设置草稿、发送正文 |
| `useSRHistory()` | — | ✓ | ✓ | `await history.query({ limit: 3 })`；独立读取一页持久化历史 |
| `useSRState({ scope, path? })` | global 指定路径 | ✓ | ✓ | `useSRState<number>({ scope: 'message', path: 'coins' })` |
| `useSRStateAPI()` | get、batchGet，限 global 指定路径 | ✓ | ✓ | `await api.update({ scope: 'session', path: 'chapter', value: 2 })` |
| `useSREvent()` | — | ✓ | ✓ | `events.subscribe('run.delta', onText)` |
| `useSRAsset(uri)` | ✓ | ✓ | ✓ | `useSRAsset('sr-asset://assets/harbor.webp')` |
| `useSRActionSuggestions()` | — | ✓ | ✓ | `const { items } = useSRActionSuggestions()` |
| `useSRComposerButtons(buttons)` | — | 舞台统一声明 | — | `useSRComposerButtons([{ id: 'bag', label: '背包', onClick: openBag }])` |
| `SR.Content` | ✓ | ✓ | ✓ | `<SR.Content content="**雾港**" mode="prose" />` |
| `SR.WorldStory` | — | ✓ | — | `<SR.WorldStory showState={false} />` |
| `SR.ActionSuggestions` | — | ✓ | — | `<SR.ActionSuggestions />` |
| `MessageComponentProps`、组件静态属性 `srDisplay` | — | — | 规则挂载时注入 | `props.groups[0]`、`CoinLabel.srDisplay = 'inline'` |

### 一个详情组件

```tsx
import { SR, useSRAsset, useSRState } from '@sillyrealms/sdk';

export default function HarborIntro() {
  const sky = useSRState<string>({ scope: 'global', path: 'weather.sky' });
  const cover = useSRAsset('sr-asset://assets/harbor.webp');
  return <article>
    {cover && <img src={cover} alt="雾港码头" />}
    <SR.Content content="## 今日港口" mode="document" />
    <p>{sky.error ? '天气读取失败' : sky.loading ? '正在读取天气' : sky.value ?? '天气未记录'}</p>
  </article>;
}
```

Host 在生成请求前复核预览权限，显式传入已授权的 global 路径。省略 path 的整域读取、状态写入、session/message 以及事件流都超出预览权限。多实例可以复用同一绑定世界的已确认读取；卸载其中一个实例只解除该实例的订阅。详情资源 URL 由当前世界绑定解析，支持包内 URI、允许的 HTTP(S) 地址和 null。可用 URL 的返回不保证资源存在或已下载。

## 会话与历史

```tsx
const session = useSRSession();
const connected = useSRSession(s => s.connected);
const active = useSRSession(s => s.runs.active);
const history = useSRHistory();

// 在按钮回调中调用。setDraft 替换并展开草稿，send 返回服务端受理的身份。
async function investigate() {
  await session.setDraft('查看灯塔');
}
async function depart() {
  const { runId, assistantEntryId } = await session.send('前往灯塔');
  return { runId, assistantEntryId };
}

async function loadPages() {
  const first = await history.query({ limit: 5 });
  const older = first.nextCursor
    ? await history.query({ limit: 5, cursor: first.nextCursor })
    : null;
  return { first, older };
}
```

- `session.connected` 表示连接状态。`session.status` 为 idle、submitting、generating、stopping。`runs.active` 为当前执行的只读展示投影或 null。选择器只在所选值改变时驱动更新。正文增量不应使只关心连接或状态的组件重渲染。
- `send(text)` 兑现于受理，保留真实 runId、userEntryId、assistantEntryId。生成结束通过当前执行投影和事件观察。重新生成可复用 runId，每次执行以新的 assistantEntryId 区分。
- 历史查询入口收敛到 `useSRHistory().query({ cursor?, limit? })`。目标作者结果为 `{ runs, nextCursor }`，每页 1–5 轮，默认 5；单页内从旧至新。每个阅读器拥有自己的页、游标、加载状态与滚动位置。Host 保留用来校准业务状态的工作集。
- 作者展示轮次包含 id、status、messages；普通消息包含 id、role、content、timestamp、saved。active 另外提供本次执行身份。saved 取自持久化确认。重连或删除后由 Host 校准，再发 history.changed；阅读器按消息 ID 接手已保存正文。接口迁移须同时校验 Host、frame、类型和真实调用方，原始 Entry、metrics 与模型诊断由 Host 持有。

## 状态读取与更新

`StateScope` 为 global、session、message。会话中分别绑定本世界、本会话、当前 tip。作者显式声明 scope，Host 提供目标 ID。下例中的各 API 直接返回 JSON 原生值，数字、布尔、数组和对象均保留结构。

```tsx
const hp = useSRState<number>({ scope: 'message', path: 'player.hp' });
const ledger = useSRState({ scope: 'session' }); // 会话环境可订阅整域
const api = useSRStateAPI();

async function readInventory() {
  const bag = await api.get({ scope: 'message', path: 'inventory' });
  const fields = await api.batchGet([
    { scope: 'global', path: 'weather.sky' },
    { scope: 'message', path: 'player.hp' },
    { scope: 'message', path: 'player.gold' },
  ]);
  return { bag, fields };
}

async function heal() {
  const { changed } = await api.update({ scope: 'message', path: 'player.hp', value: 80 });
  return changed;
}

async function settle() {
  const rows = await api.batchUpdate([
    { scope: 'message', path: 'player.gold', value: 12 },
    { scope: 'session', path: 'chapter', value: 2 },
  ]);
  return rows.filter(row => !row.success);
}
```

| 能力 | 结果与生命周期 |
|---|---|
| `useSRState<T>(query)` | `{ value, loading, error, refresh }`。value 是只读值或 undefined；缺失是成功读取。首次失败记录带 code 的错误。刷新保留旧值，`await hp.refresh()` 返回确认值或抛出读取错误。目标身份变化立即切换到新目标，写错误只进入命令回执。 |
| `api.get<T>({ scope, path? })` | 一次确认读取，返回只读值或 undefined。省略 path 在舞台表示当前 scope 的完整根字典。泛型是调用方的静态声明。 |
| `api.batchGet([{ scope, path }])` | path 必填。按目标合并查询，返回同序、等长的 `{ scope, path, value }[]`。重复项保留，缺失为 undefined，显式 null 保留。空列表直接返回空数组。不同目标各自取快照。查询失败以 Promise reject 报告。 |
| `api.update({ scope, path, value })` | 给已有路径赋完整 JSON 值。成功返回 `{ changed: boolean }`，缺失抛 STATE_NOT_FOUND，其他拒绝保留相应错误码。写入 inventory 会替换完整对象，写 inventory.keys 只改该字段。 |
| `api.batchUpdate(updates)` | 先预检结构、值、权限和绑定。开始执行后只合并连续同目标的项，按输入顺序返回 `{ scope, path, success: true, changed }` 或 `{ scope, path, success: false, errorCode, errorMessage }`。空列表返回空数组。整次未取得可信回执时 reject，已提交项可能生效，调用方不得自动重试。 |

Hook 在值、loading 或读取错误变化时通知组件；祖先路径替换和整域事件会刷新受影响的子查询。相同 scope/path 的新对象字面量无需重新订阅。对象与数组以深只读值提供。get 不建立订阅，refresh 与挂起的同目标请求可合并；同目标刷新失败仍保留旧值。具备权限但缺少绑定时报告 STATE_CONTEXT_UNAVAILABLE。批量查询先校验所有项的环境权限，预览保留现有每次最多 100 项、每路径 2048 字符串长度单位和 32 段的 Host 约束。

**Server 对接。** 已实现的 `POST /api/v1/state/query` 用正文定位目标。整域省略 paths，返回各根的 `{path,value}` 行；字段查询传 paths 数组，仅缺失行省略 value。Host 对整域结果构建完整字典，对局部结果只更新所查字段。事件先到或 tip 变化时，迟到的读取不能覆盖更新值。读取协调和重连由 Host 负责；SDK 维护按选定值与读状态订阅的不可变投影。[状态接口](../docs/runtime/server-http.md#状态接口)

**写入实施依赖。** 现有 `POST /api/v1/state/update` 已逐项提交，但成功行尚不能区分 changed、unchanged、missing。由 state module 在计算候选时判定，统一 state 用例在事务成功后返回 outcome。SDK 将 missing 映射为作者层 STATE_NOT_FOUND；保留服务端原有成功忽略及模型更新的独立规则。同值和缺失不物化继承快照。一个历史条目的字段实际修改时，即使 tip 未变化、没有 SSE，回执仍须为 changed。命令受理时捕获 message tip，作者写入需要在每项事务内核对此绑定，过期报 STATE_CONTEXT_CHANGED；通用 HTTP 调用仍可显式操作历史条目。写入已确认后回读失败只影响展示刷新。

## SREvent 订阅

`useSREvent()` 返回当前会话绑定的稳定对象。唯一显式事件订阅为 `subscribe(name, listener): () => void`，回调参数按事件名推导。订阅返回后接收新通知，解除订阅或 frame 销毁即停止。每个会话复用现有 SSE，Host 先投影公开字段再发往 frame；帮答草稿、推理、工具调用、用量和提供商诊断只在宿主侧处理。重连依靠快照与历史查询恢复。[服务端事件](../docs/runtime/server-events.md)

| 作者事件 | 回调可见字段 | 简单用途 |
|---|---|---|
| `run.created` | runId、assistantEntryId | 为新执行建立演出状态 |
| `run.delta` | runId、assistantEntryId、mode、text | append 追加可见正文；replace 用完整正文替换 |
| `run.completed` | runId、assistantEntryId | 结束本次执行的演出 |
| `run.stopped` | runId、assistantEntryId、stopReason | 区分主动停止与输出长度上限等原因 |
| `history.changed` | 无业务字段，Host 合成的失效通知 | 重新查询当前阅读器需要的历史页 |
| `state.changed` | scope、path、value | 对某个状态变化播放动画；空 path 表示整域替换 |
| `action_suggestions.created` | runId、messageId、items | 新建议到达时提示；当前列表由建议 Hook 提供 |
| `character_sprite.changed` | runId、messageId、items（position、characterId、spriteId） | 按本条消息的完整立绘列表触发转场；空数组表示清空 |

```tsx
const events = useSREvent();
useEffect(() => events.subscribe('run.delta', ({ assistantEntryId, mode, text }) => {
  drawText(assistantEntryId, mode, text); // 当前组件的演出回调
}), [events]);

useEffect(() => events.subscribe('history.changed', invalidatePages), [events, invalidatePages]);
```

delta 只有可见正文时才追加。带正文定稿快照时每帧只派发一次 replace，空正文也可清空之前的演出；纯推理分片跳过。定稿与持久化终态分开。中途挂载若需此前生成的文字，直接读取 session.runs.active。history.changed 可合并，纯 delta 不触发；用户消息提交、助手保存、删除或替换、终态落库、重连校准后可触发。阅读器先订阅，再查首页；通知与在途查询交错时舍弃过期页或补读。列表中的事件为本版目标清单，新增作者事件须定义用途和最小载荷。

## 官方组件如何使用 SDK

| 消费方 | 使用的能力 | 组件自主管理 |
|---|---|---|
| 官方阅读器 `SR.WorldStory` | useSRSession 观察活动正文，useSRHistory 查询已保存页，useSREvent 订阅 history.changed；状态面板通过 useSRState 读取已授权状态 | 分页、焦点、阅读位置、流式正文与已保存消息的交接 |
| 官方行动区 `SR.ActionSuggestions` | useSRActionSuggestions 提供当前 items，点击后调用 session.setDraft | 按钮与交互反馈；自绘行动可显式调用 send |
| 详情介绍、角色和开局预览中的官方内容 | SR.Content、useSRAsset、受限的 global 状态读取；静态 Markdown 可共用底层清洗与资源解析 | 排版和空值占位；Host 掌管导航与开始会话 |
| 作者消息组件 | MessageComponentProps 和允许的会话 Hook | 展示捕获内容、局部交互；message.id 标识展示位置，message scope 的状态始终绑定当前 tip |

**自定义舞台组合。** 官方阅读器与行动区是兄弟组件。showState 默认 true。建议为空时整块行动区退出布局。快捷按钮只由当前舞台统一声明，最多五项，id 稳定唯一；Host 保存展示描述与版本并转发点击，回调留在 frame，卸载注销，过期点击失效。

```tsx
import { useState } from 'react';
import { SR, useSRActionSuggestions, useSRComposerButtons } from '@sillyrealms/sdk';

export default function HarborStage() {
  const [open, setOpen] = useState(false);
  const { items } = useSRActionSuggestions();
  useSRComposerButtons([{ id: 'log', label: '航海日志', onClick: () => setOpen(v => !v) }]);
  return <>
    <SR.WorldStory showState={false} />
    {open && <SR.Content content="今日靠岸。" mode="prose" />}
    {items.length > 0 && <aside><SR.ActionSuggestions /></aside>}
  </>;
}
```

**消息扩展示例。** groups[0] 是第一个捕获组；命名组可从 namedGroups 取值。布局默认为 block，行内片段声明 inline。

```tsx
import type { MessageComponentProps } from '@sillyrealms/sdk';

export default function CoinLabel({ match, groups, namedGroups, message, runId }: MessageComponentProps) {
  return <span title={message.role} data-message={message.id} data-run={runId}>
    {namedGroups.amount ?? groups[0] ?? match}
  </span>;
}
CoinLabel.srDisplay = 'inline' as const;
```

SR.Content 默认 prose，document 允许受限文档样式；两种模式均通过对应清洗和资源解析流程。阅读主题、输入区避让和阅读尾部留白遵守[组件契约](../docs/sdk/components.md)。完整宿主快照、底层 Provider、模型原始负载和官方组件内部 DOM 属于集成实现。

## 现有调用如何迁移

| 工作区现有用法 | 目标用法 |
|---|---|
| `useSRState(path, fallback, options)` 和 tuple setter | `useSRState({scope, path}).value`，展示层自行设置缺省值，赋值调用 StateAPI.update |
| `getState / batchGetState / updateState / batchUpdateState`、详情 `useSRWorldStateAPI` | `useSRStateAPI().get / batchGet / update / batchUpdate`，两种环境由 Host 校验各自权限 |
| `session.subscribe`、`state.subscribe` 与原始 SSE 事件对象 | `useSREvent().subscribe(name, listener)`，按公开事件读取回调数据 |
| `useSRStageSnapshot()`、历史的共享翻页操作 | 会话选择器、领域 Hook 和 `useSRHistory().query`，各读者自行保存页 |
| `useSRAssetUrl`、文档渲染别名 | `useSRAsset` 和 `SR.Content`；资源基址、Provider 与加载动画转为集成细节 |

## 发布与变更范围

当前 Host 仍有读取旧 state 路径的调用点。先迁移到两个 POST，验证旧作者接口在新传输上可用，再切换公开 Hook、事件投影和组件。切换前盘点雾港、状态示例、内置 ZIP 与已导入副本；仅当实际引用变更时重新打包。通过可识别的版本处理分发中的旧卡，或明确迁移受影响作品。缺少可靠标识时先解决识别问题，保留用户已有内容和运行数据。源码检查、构建、实际导入和游玩分别记录。

以下为**预计实施范围**。花括号表示同目录文件。旧符号退出新版作者清单，源文件中仍供宿主使用的实现按实际依赖保留。

```text
SillyRealms/
├── packages/sr-sdk/src/
│   ├── author-contract.ts                         新增 · 根导出、类型及环境清单
│   ├── state/{context.tsx,runtime.ts}              新增 · 状态订阅与受限命令
│   ├── {state-contract,stage-contract}.ts          修改 · 目标值、回执、公开事件投影
│   ├── {asset-context,world-state}.tsx             修改 · 资源与详情入口
│   └── stage/{index.tsx,context.tsx,runtime.ts,world-story.tsx,state-panel.tsx,action-suggestions.tsx,document.tsx}
│                                                  修改 · 根导出及官方组件消费
├── packages/sr-ui-compiler/src/modules.ts          修改 · 两种 frame 导入与挂载校验
├── apps/web/src/
│   ├── {frame.tsx,world-component-frame.tsx,stage-frame-protocol.ts}  修改 · 注入与结构化错误
│   ├── stage-host/{StageHost.tsx,commands.ts}      修改 · 已绑定命令与事件白名单
│   └── features/{state/index.ts,history/controller.ts,sessions/workspace.ts,worlds/WorldComponentView.tsx,worlds/world-component-protocol.ts}
│                                                  修改 · 目标绑定、真实数据与预览权限
├── apps/server/src/
│   ├── modules/state/{types,patch,service}.ts      修改 · 产生并传递字段 outcome
│   ├── usecases/state.ts                          修改 · 事务回执和可选 tip 前置条件
│   └── routes/state.ts                            修改 · 校验受条件约束的消息更新
├── apps/{server/src,web/tests}/                    修改 · 相关状态、路由、事件及桥接测试
├── packages/sr-sdk/test/                          新增 · Hook 生命周期与官方消费者测试
├── scripts/{world-card.mts,world-card.test.mts}    按需修改 · 制卡校验
├── examples/、initial-data/worlds/                 按需修改 · 示例和已验证需迁移的发行资源
└── docs/{sdk,runtime,design,creator}/、AGENTS.md、apps/{web,server}/AGENTS.md
                                                   修改 · 实施后同步正式规范与入口
```
