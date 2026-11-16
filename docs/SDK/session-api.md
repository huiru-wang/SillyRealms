# 会话 API

适用：会话舞台和消息组件。通过 `useSRSession()` 获取当前会话的 `SRSessionAPI`。不传 session ID，不自行连接 HTTP/SSE；世界介绍和开局预览不提供该 API。

## 方法一览

| 方法 | 返回 | 用途 |
| --- | --- | --- |
| `setDraft(text)` | `void` | 替换平台输入草稿，不发送 |
| `send(text)` | `Promise<{ runId, requestId }>` | 请求启动一次生成 |
| `getHistoryRuns({ cursor?, limit? }?)` | `Promise<HistoryRunsResult>` | 按完整 Run 向前分页 |
| `subscribe(listener)` | 取消订阅函数 | 接收 Run、临时行动建议与连接状态事件 |
| `subscribe(listener, { includePhase: true })` | 取消订阅函数 | 额外接收 `run.phase` |

没有公开的 `stop()`、读取／订阅草稿、切换会话、修改模型或直接调用工具的方法。停止和配置入口由可信 Host 提供。

## 草稿与发送

`setDraft(text)` 是发给 Host 的单向指令：替换当前草稿并展开输入区。它不添加 SDK 自己的撤销提示，不返回持久化或执行成功凭据；编辑器自身的撤销历史由平台管理。

`send(text)` 直接发送给当前会话，不需要先 `setDraft`。Host 检查连接和舞台是否就绪、文本是否非空、长度是否超过 100000 个 JavaScript 字符单位、当前会话是否正在生成。它读取最新会话 tip，生成 `requestId`，再向 Server 提交。Server 继续执行并发、幂等、tip 等校验。

返回的 `runId` 用于关联后续事件；`requestId` 用于标识该请求。**Promise resolve 表示已受理，不表示模型生成或状态提交已经完成。** 每次新的 `send()` 调用由 Host 生成新的请求 ID，不能把重复调用视作 SDK 自动去重或安全重试。

下面按钮演示直接发送及请求级错误处理。请求被受理后，本轮是否仍在运行由平台判断；再次点击可能被拒绝为忙碌。若需要全程禁用，请结合历史／恢复快照和 Run 事件维护运行状态。

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { useSRSession } from '@sillyrealms/sdk';

export default function SendAction() {
  const session = useSRSession();
  const live = useRef(true);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNotice('');
    try {
      await session.send('我走向灯塔。');
      if (live.current) setNotice('已受理，等待故事回应。');
    } catch (error) {
      if (live.current) setNotice(error instanceof Error ? error.message : '发送失败');
    } finally {
      inFlight.current = false;
      if (live.current) setPending(false);
    }
  }

  return <div>
    <button type="button" disabled={pending} onClick={() => void send()}>
      {pending ? '正在提交…' : '直接发送：走向灯塔'}
    </button>
    <p role="status">{notice}</p>
  </div>;
}
```

SDK 直接 `send()` 不经过平台输入框提交后的草稿清空逻辑，也不把参数文本自动同步到输入框。调用方需要自行明确按钮语义。

## 历史分页

```ts
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  origin?: 'opening';
};

type HistoryRunsResult = {
  runs: Run[];
  nextCursor: string | null;
  hasMore: boolean;
};
```

- `limit` 按 Run 计数，允许 1–20 的整数；省略时当前 Server 默认 20，官方故事界面每次请求 5。
- 不带 cursor 获取最近一页；页内按历史从早到晚排列。传入 `nextCursor` 获取更早一页，将更早数据前置并按 Run ID 去重。
- cursor 是当前会话历史的分页凭据，不解析、不自行构造，也不跨会话复用。
- 一个 Run 不会被拆到两页。开局也会作为历史中的一组消息返回。
- 只投影用户和 assistant 叙事消息，过滤工具消息、非叙事记录及内部实现数据；它不是完整模型上下文。
- 不带 cursor 的最新页会合并当前活动 Run 的内存快照；如果该 Run 尚未出现在持久历史中，会额外追加，所以返回数量可能比 limit 多一个。更早页不追加活动 Run。
- 最新页中的运行中正文仍是查询时的临时快照，需结合后续实时事件与 Host 恢复快照；不能把它当成已经落库的完整正文。

会话有新数据时，较慢的历史响应可能晚于事件到达。自定义列表不能简单用一次 HTTP 返回覆盖整个页面，也不能把所有增量重复追加到已经包含它们的快照后面。

## Run 与生成阶段

`Run` 包含 `id`、`status`、`messages`，以及可选的 `phase` 和 `extensions`。

| `status` | 含义 |
| --- | --- |
| `preparing` | 准备输入与上下文 |
| `running` | 正在执行本轮，包括正文与扩展处理 |
| `completed` | 本轮完成 |
| `failed` | 本轮失败，可能仍有已保存正文 |
| `stopped` | 本轮已停止 |

`phase` 为 `preparing → narrative → extensions → finalized`，来自运行中内存或终态推导，用来解释当前工作阶段，不替代 `status`。失败或停止不保证逐阶段通知；准备失败也可能在没有 `run.created` 的情况下到达。

Run 查询及事件不携带能力配置快照。Studio 会话设置从独立的会话能力接口读取当前预设的两个开关。

状态更新和行动建议由会话绑定预设的 worldState/actionSuggestions 节点 enabled 决定，不提供会话覆盖或 Agent 模式。状态更新仅在本轮有激活的可写 message 根时 required；无可写根时省略整个世界状态提示。

## 事件

所有 Run 事件的 `data` 都包含 `runId`。

| 事件 | 关键数据 | 处理原则 |
| --- | --- | --- |
| `run.snapshot` | status、messages、可选元数据 | Host 恢复或同步的快照，可能是运行中或终态 |
| `run.created` | messages、可选元数据 | 本轮已创建的消息，不保证包含完整 assistant 正文 |
| `run.delta` | messageId、text、可选 offset | 为指定消息合并文本增量 |
| `run.phase` | phase | 仅 `includePhase: true` 的订阅接收 |
| `run.completed` | messages、可选元数据 | 使用权威终态消息集合 |
| `run.failed` | messages、errorCode、errorMessage、可选元数据 | 保留最终返回的正文，展示失败原因 |
| `run.stopped` | messages、可选元数据 | 使用最终停止结果，不继续追加迟到增量 |

`run.delta.offset` 是 UTF-16 code unit 偏移，与 JavaScript 字符串索引一致，不是 UTF-8 字节数。缺口、重复和重叠不能当作普通字符串追加。终态消息可以覆盖此前临时显示的正文。

订阅不重放 Run 历史，也不立即返回 Run 快照；订阅时会收到当前连接状态，以及已收到且尚未失效的临时建议投影（如有）。读取历史前先订阅并暂存事件，再按 ID、偏移与终态权威合并。`SessionRuntime` 分发事件并保留当前临时建议和连接状态，完整合并逻辑位于官方 WorldStory 内部。

下面示例仅观察挂载之后收到的事件，不用于判断页面刚打开时是否忙碌：

```tsx
import React, { useEffect, useState } from 'react';
import { useSRSession } from '@sillyrealms/sdk';

export default function RunEventNotice() {
  const session = useSRSession();
  const [notice, setNotice] = useState('等待后续运行事件');
  useEffect(() => session.subscribe(event => {
    if (event.event === 'run.phase') setNotice(`当前阶段：${event.data.phase}`);
    else if (event.event === 'run.failed') setNotice(event.data.errorMessage);
    else if (event.event === 'run.completed') setNotice('本轮已完成');
    else if (event.event === 'run.stopped') setNotice('本轮已停止');
  }, { includePhase: true }), [session]);
  return <p role="status">{notice}</p>;
}
```

## 扩展结果

`RunExtensions` 只包含两项处理状态：

| 结果 | 字段 |
| --- | --- |
| `stateUpdate` | status：disabled / not_required / pending / unchanged / applied / partial / failed / cancelled |
| `actionSuggestions` | status：disabled / pending / ready / blocked / failed / cancelled |

部分状态成功会阻止建议发布；建议单独失败不撤销已经通过的状态。接口不返回协议版本、数量、变更路径、逐项错误或诊断快照。Run 失败时通过顶层 `errorCode`、`errorMessage` 表达原因，不提供 failure/recovery 分类。

SDK 提供这些结果供 UI 展示，不解析模型尾块，也不负责提交状态。正式 Direct 路径由 Server 解析和验证叙事扩展，不能将它描述为 SDK 内的工具循环。

## 临时行动建议

`action_suggestions.changed` 的 data 为 `{ sessionId, suggestions: { runId, messageId, items: string[] } | null }`。items 恰好三条，依次对应缓慢、中速、快速推进；绑定指定 assistant 消息展示。null 表示立即清除当前批次。

`session.connection` 的 data 为 `{ connected: boolean }`。断线或正在核对最新 Run 时禁用建议按钮；连接确认后可继续选择仍有效的批次。点击建议只调用 setDraft，不自动发送。

新一轮受理时清除建议；发送被拒绝时保留。已受理的新轮失败或取消，不恢复旧建议。建议文本只在 Host/SDK 当前内存中，历史、Run 查询、终态事件均不包含 items；刷新、离开或切换会话不会恢复。服务端事件不重试、不持久回放，提交成功后也可能因断线而没有展示建议。

## 错误处理边界

方法调用失败通过 Promise rejection 暴露。当前 iframe 桥把请求错误转换成普通 `Error(message)`，不保证保留 HTTP 的 `errorCode`；不要给所有 `catch` 值假定 `ApiError` 类型。`run.failed` 事件则显式包含 `errorCode` 和 `errorMessage`。

发起一次 send、随后收到一次失败事件，是两个不同阶段的结果。前者 resolve 后仍要观察终态；断线后也不能仅凭尚未收到完成事件就自动再次发送。

实现依据：[公开类型](../../packages/sr-sdk/src/run-contract.ts)、[SessionRuntime](../../packages/sr-sdk/src/session-runtime.ts)、[Host](../../apps/studio/src/host.tsx)、[Run 路由](../../apps/server/src/routes/session-runtime.ts)、[历史投影](../../apps/server/src/domain/session/history-runs.ts)。
