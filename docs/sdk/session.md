# 会话、展示快照与历史

[开发手册目录](README.md)。本章适用于会话 Stage 及其消息组件。示例中的 `session`、`history`、`snap` 分别由组件顶层调用 `useSRSession()`、`useSRHistory()`、`useSRStageSnapshot()` 获得。表中的 `await` 示例放在异步事件处理函数内，统一捕获异常并显示反馈。

## useSRStageSnapshot()

返回 `StageSnapshot`，随宿主更新触发组件重渲染。直接读取已加载的消息和正在生成的文本。示例：`const last = snap.runs.at(-1)?.messages.at(-1);`，显示 `last?.content ?? '等待消息'`。历史页尚未加载、断线或终态尚未同步时，应同时参考加载标志与 `saved`。

| 字段 | 类型和用法 |
| --- | --- |
| `sessionId`、`connected` | 会话 ID 与宿主事件连接状态。初始 ID 可能为空。 |
| `activeRunId`、`activeAssistantEntryId`、`sending` | 两个活动 ID 都可为 null。发送请求期间 `sending` 可先变为 true。停止时使用这两个活动 ID。 |
| `runs` | 按展示顺序排列的 `StageRun[]`。每轮有 `runId/status/messages` 和可选的 `assistantEntryId/phase/stopReason/finishedAt`。`RunStatus` 为 running、stopping、completed、stopped、unknown；`phase` 可为 preparing、summarizing、generating。 |
| `runs[].messages` | `StageMessage[]`。每条有 `id/runId/role/content/timestamp/saved`，可带 `seq/reasoning_content/tool_calls/output`。展示可早于持久化，保存状态看 `saved`。`output` 是处理记录，读取前检查字段。 |
| `streamIncomplete` | 可选，表示流片段可能不完整。显示等待同步提示，并使用后续快照或已保存历史。 |
| `history` | `loading/loadingMore/hasMore/error`，用于首次加载、翻页、重试按钮。 |
| `suggestions` | `ActionSuggestionsState`，仅含只读 `items` 字符串数组，初始为 `[]`；显示行动建议优先使用 `useSRActionSuggestions()`。不含消息归属或操作资格。 |
| `state/stateLoading/stateError` | 三域有效状态、加载和错误。见[状态读写](state.md)。 |

## useSRActionSuggestions()

返回 `ActionSuggestionsState = Readonly<{items: readonly string[]}>`。在会话组件顶层调用 `const {items} = useSRActionSuggestions();`，按 items 非空条件挂载整个行动区。可以使用 `SR.ActionSuggestions`，也可以用 items 绘制自己的按钮或菜单，见[组件组合与完整示例](components.md#行动建议与舞台组合)。

Hook 只读宿主注入的数据，不提供消息 ID、setter、清空方法、pending、错误或发送资格。多个消费者共享同一份不可变快照；挂载、卸载或重新挂载组件不会清空建议，不另开事件连接，也不请求或扫描历史。详情介绍和开局预览没有会话环境，不能使用该 Hook。

宿主在本地发送取得 accepted 回执后，同批展示已保存用户消息并清空建议；run.created 负责确认或补偿，同一 assistantEntryId 的重复确认不会再次清空已经到达的新建议。新建议事件整体替换 items，run.completed 不无条件清空。请求明确未受理时保留原建议，未知结果通过既有同步确认，不自动重发。

进入、整页刷新和重连时，宿主复用已有历史加载，只检查最新轮最后一条普通 message，忽略隐藏摘要。最后是 user、执行未有效完成或助手没有有效建议时得到 `[]`，不会回找更早的助手。历史翻页不恢复建议；仅 iframe 重挂载时直接取得 Host 当前快照。

连接、提交、生成等通用状态仍从 `useSRStageSnapshot()` 读取。作者决定调用 setDraft 或 send，实际命令由 Host 检查；不要把这些通用状态和动作塞回建议数据。

## useSRSession()

返回 `SRSessionAPI`。异步命令的受理回执和最终生成结果分开到达。舞台只传消息或执行标识，宿主补上当前会话和 tip。

| 方法 | 调用示例 | 返回与注意事项 |
| --- | --- | --- |
| `setDraft(text)` | `await session.setDraft('向掌柜打听渡口');` | `Promise<void>`。替换并展开平台输入框，玩家可以继续修改；空串可清空草稿。 |
| `send(text)` | `const accepted = await session.send('推门进店');` | `Promise<AcceptedRun>`。直接提交新的用户轮次，受理不等于生成完成；不会先填入或清除现有草稿。文本须有非空白内容；send 和 setDraft 的桥接上限均为 100000 个 JS 字符串长度单位。生成中或提交中应禁用发送。 |
| `regenerate(input)` | `await session.regenerate({ userEntryId: user.id, assistantEntryId: reply.id });` | `Promise<AcceptedRun>`。仅最新普通用户轮次有效。已有回复传旧助手消息 ID；仅剩用户消息时传 `null` 重试。目标必须与当前历史一致。服务端先删除旧回复，生成失败也不会恢复它。 |
| `stop(runId, assistantEntryId)` | `if (snap.activeRunId && snap.activeAssistantEntryId) await session.stop(snap.activeRunId, snap.activeAssistantEntryId);` | 返回 `{runId, assistantEntryId, stopping: true}`。按执行身份停止；等待终态或快照反映完成。 |
| `subscribe(listener)` | `React.useEffect(() => session.subscribe(e => { if (e.event === 'run.stopped') console.info(e.data.stop_reason); }), [session]);` | 返回取消函数。回调收到当前会话的 `SessionEvent`；监听期间消费通知，重连时从快照和历史恢复。 |

`RegenerateRequest` 有 `userEntryId: string` 和 `assistantEntryId: string | null`。`AcceptedRun` 含 `runId/userEntryId/assistantEntryId/userMessage/tipEntryId/deletedMessageIds`。`userMessage` 带 `id/role/content/timestamp`。重新生成沿用原 `runId` 与用户条目，每次分配新 `assistantEntryId`；同一用户消息在界面只展示一次。

**完整示例 · 重新生成最新回复**

```tsx
import React from 'react';
import { useSRSession, useSRStageSnapshot } from '@sillyrealms/sdk';

export default function RetryLatest() {
  const session = useSRSession();
  const s = useSRStageSnapshot();
  const [error, setError] = React.useState('');
  const latest = s.runs.at(-1);
  const user = latest?.messages.find(m => m.role === 'user');
  const tail = latest?.messages.at(-1);
  const ready = user && s.connected && !s.sending && !s.activeRunId &&
    !s.history.loading && !s.history.error;
  async function retry() {
    if (!ready || !user) return;
    setError('');
    try {
      await session.regenerate({
        userEntryId: user.id,
        assistantEntryId: tail?.role === 'assistant' ? tail.id : null,
      });
    } catch (e) { setError(e instanceof Error ? e.message : '重新生成失败'); }
  }
  return <><button disabled={!ready} onClick={retry}>重新生成</button>
    {error && <p role="alert">{error}</p>}</>;
}
```

## useSRComposerButtons(buttons)

会话宿主自行展示官方「立绘」胶囊。作者可照常声明最多五个快捷按钮；立绘变化可通过现有会话事件订阅接收 `character_sprite.changed`。

在当前会话舞台顶层调用一次，按显示顺序传入完整的 `SRComposerButton[]`。每项提供稳定且唯一的 `id`、纯文本 `label`、可选的 `disabled` 和 `onClick()`。回调在舞台内运行，支持异步操作，回调抛出的错误会在会话页提示。下面的舞台在战斗时提供“防御”，并始终提供“查看状态”。

```tsx
import React from 'react';
import { SR, useSRComposerButtons, useSRSession, useSRState } from '@sillyrealms/sdk';

export default function StoryStage() {
  const [scene] = useSRState<string>('scene', '', {scope: 'message'});
  const [showState, setShowState] = React.useState(false);
  const session = useSRSession();
  useSRComposerButtons([
    ...(scene === '战斗' ? [{
      id: 'defend', label: '防御', onClick: () => session.setDraft('我举起盾牌防御。'),
    }] : []),
    {id: 'state', label: showState ? '收起状态' : '查看状态', onClick: () => setShowState(value => !value)},
  ]);
  return <SR.WorldStory showState={showState}/>;
}
```

示例中的 `scene` 来自世界卡声明的 message 状态。`setDraft` 会替换当前草稿，玩家可编辑后发送。按钮也可以只改变舞台局部状态。此例只演示输入区快捷按钮；需要模型生成的行动建议时，在 Stage 中另行[条件组合行动区](components.md#行动建议与舞台组合)。两者不共用列表或生命周期。

- 每次取前 5 项，忽略无效项和重复 ID 的后续项。ID 和标签须为非空白字符串，分别最多 128 和 256 个 JS 字符串长度单位。建议用短动词标签。
- 传入空数组可清空操作区。收起输入框会隐藏按钮，展开时显示当前声明。宿主统一处理每行居中、自然换行、固定高度和长标签省略。
- 宿主按舞台连接和声明版本回传点击。列表或回调更换、禁用、卸载后，过期点击失效。仅在会话舞台声明按钮，介绍和开局预览保持只读。

## useSRHistory()

返回 `runs`、`loading/loadingMore/hasMore/error` 和以下三个异步方法。想显示当前画面时订阅 Hook，独立检索记录时调用 `query`。

| 方法 | 调用示例 | 行为 |
| --- | --- | --- |
| `loadMore()` | `if (history.hasMore && !history.loadingMore) await history.loadMore();` | `Promise<void>`。宿主把更早的轮次并入列表。下一次渲染读 `history.runs`。 |
| `refresh()` | `await history.refresh();` | `Promise<void>`。从最近页重新同步历史、会话和状态，先前翻出的旧页可能被替换。 |
| `query(options?)` | `const page = await history.query({limit: 3});` | 返回完整轮次，仅供调用方使用。 |

`RunQuery` 可传 `limit`（1–5，默认 5）及 `cursor` 或 `afterSeq`，两种游标互斥。普通查询以最新轮次开头，`entries` 在每轮内按 seq 升序。增量查询用非负整数 `afterSeq`，按最后 seq 升序返回有变动的完整轮次。`RunPage` 返回 `items/hasMore/nextCursor/nextAfterSeq/activeRunId`。游标属于当前会话。删除和重新生成可能复用 seq，重连时用 `refresh()`。

```ts
import type { useSRHistory } from '@sillyrealms/sdk';

export async function readOlder(history: ReturnType<typeof useSRHistory>) {
  const first = await history.query({limit: 2});
  if (!first.hasMore || !first.nextCursor) return [];
  const older = await history.query({cursor: first.nextCursor, limit: 2});
  return older.items.flatMap(run => run.entries);
}
```

持久轮次含 `runId/firstSeq/lastSeq/status/entries` 及可选的助手 ID 和结束信息。`entries` 可含 `message` 和 `compaction`；读取正文前检查类型、role 和 `payload.message` 的结构。`history.runs` 提供适合直接绘制的 `messages`。

## SessionEvent 速查

用 `e.event` 缩窄事件类型后再读取 `e.data`。执行相关事件以 `runId` 和 `assistantEntryId` 标识本次执行；快照和原生事件可以在不同时间到达。以下示例均在订阅回调对应的事件分支内使用。

| 事件 | 示例读法与时机 |
| --- | --- |
| `run.created` | `e.data.messages[0].id` 是已保存的用户消息；`deletedMessageIds` 可含旧回复。 |
| `run.summarizing` | `e.data.runId` 对应正在整理上下文的轮次。 |
| `run.summarized` | `e.data.entryId` 是已保存摘要条目 ID。 |
| `run.delta` | `e.data.messages[0]?.delta.content` 是可选正文增量；也可含思考、工具片段和完整 `snapshot`。绘制正文优先使用 StageSnapshot，避免重复拼接。 |
| `run.usage` | `e.data.usage?.total_tokens`，未知时 usage 可为 null。 |
| `run.completed` | `e.data.savedMessageIds` 和 `tipEntryId` 用于识别已保存条目。 |
| `run.stopped` | `e.data.stop_reason` 区分停止原因，例如 `output_limit_reached`。中断也可能有已保存的部分回复。 |
| `message.deleted` | `e.data.messageId` 是被删除的消息。回执与事件可能描述同一删除。 |
| `action_suggestions.created` | 原生事件含建议字符串 `e.data.items` 和所属回复 `messageId`。显示建议使用 `useSRActionSuggestions()`，不按这个事件自行合并或恢复。 |
| `state.changed` | `e.data.scope/path/value` 描述有效变更；空路径表示整个作用域。 |
| `session.created` | `e.data.sessionId`、`tipEntryId` 和首条 `entry`；在会话创建之后挂载的组件应从初始快照读取开局。 |

`NarrativeEvent` 是上述 `run.*` 联合类型。`MessageDeletedEvent`、`SuggestionsCreatedEvent`、`StateChangedEvent` 可用于单类处理函数。所有公共字段与可空性见[契约定义](../../packages/sr-sdk/src/stage-contract.ts)。
