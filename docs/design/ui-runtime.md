# SR Session UI Runtime：声明式组件与 SessionEventHub（V3 草案）

> **MVP 状态说明**：本文保留原有目标设计；若与本次 Server MVP 的已调整范围或实际行为冲突，以 [Server MVP 实施进度](../technical/server-mvp-progress.md)及其中链接的方案为准。文中的未来功能不代表已实现。

> **2026-11-05 设计稿，尚未实现。** V3 取代旧的“作者自行调用 get/subscribe”与“只读 useSRState + 单独 Mutation Hook”约定。仅设计 Session UI；Prompt 干预、任意 Agent Tool、直接数据库操作不开放。Session / State / Storage 的权威领域规范仍见 [session](session.md)、[state](state.md)、[storage](../technical/storage.md)，UI 状态写入的分支语义须先与它们协调，不可只改前端代码。

## 1. 原则与运行边界

世界卡创作者写 React/TSX 组件，允许嵌套与复用 SR 官方组件。SR 管状态订阅、实时输出、Run 游标历史、命令和 UI 生命周期。作者无需手动请求状态、处理 SSE 或刷新组件。

- **可信宿主** SR App Shell / SessionViewHost：负责当前 Session、状态快照、SSE、命令转发、授权、回退。
- **SessionEventHub（Server）**：统一发布/订阅领域事件；不是 SSE 工具。AgentRuntime、StateService、SessionService 是发布者，SSE Adapter、内部订阅者等是消费者。
- **隔离组件运行时**：世界卡的 JS 在受限 iframe 中运行，独立 React Root + SRProvider；作者组件、官方组件、SR Hooks 在同一个 iframe React 环境内自由组合。
- **Reactive Store**：接收 Host 授权的快照/事件，为 Hook 维护不可变、稳定的响应式快照。
- **唯一事实源**：SQLite + Session/StateService/AgentRuntime。React `useState` 管局部组件状态，`useSRState` 管 SR 持久状态。

~~~text
AgentRuntime / SessionService / StateService
               ↓ publish
         SessionEventHub
          ↙           ↘
     内部订阅       SSE Adapter
                      ↓
             SessionViewHost (可信)
                      ↓ MessageChannel
             sandbox iframe (不可信)
              └─ React Root + SR Store
                 ├─ 作者组件
                 ├─ SR.Chat / SR.Composer
                 └─ 三个声明式 Hooks
~~~

**不要把世界卡 JS/React 直接 import 到可信宿主 React Root**。React 组件树不是安全沙盒，iframe/隔离来源才是边界。内置 chat/chat-state 可使用同一 SDK 语义而直接运行于可信宿主。

## 2. SessionEventHub：统一事件协议

### 2.1 通用 Event Envelope

~~~ts
interface SessionEvent<T = unknown> {
  version: 1;
  id: string;                 // 事件 ID：去重，不是持久版本
  type: string;               // 业务事件名称
  scope: {
    kind: "session" | "world";
    id: string;
  };
  timestamp: string;          // ISO 8601
  runId?: string;
  requestId?: string;         // 对应某条前端命令
  revision?: string;          // 已提交快照版本（可选）
  data: T;                    // 事件专有数据
}
~~~

- `scope=session` 只路由到当前 Session；`scope=world` 用于同一世界卡的 Global 变更等通知，Host 仍需验证会话是否有权访问。
- `type` 用可扩展的命名空间；服务端按 discriminated union/schema 校验 `data`，客户端安全忽略未知事件并提示不兼容。运行时绝不把 data 当代码执行。
- `id` 代表事件唯一身份，`revision` 代表可验证的持久状态版本。`message.delta` 是瞬时事件，不要求 revision。不要把 SSE 的事件 ID 当成已持久的消息序号。
- 发布事件不等于数据库事务或可靠消息队列。**事务成功后发布提交事件**；进程崩溃可漏通知，重连/进入必须按 snapshot revision/tip 重新对账。以后需要严格重放时才考虑 outbox。
- Hub 是内部领域总线，外发至 iframe 前必须通过可信 UI Gateway 做权限和字段投影，不暴露 Prompt、Pi ToolCall、thinking、Provider Key 或未提交工作状态。

### 2.2 初版事件类型

| type | data（核心） | 说明 |
| --- | --- | --- |
| `run.started` | runId | 一轮生成开始 |
| `run.completed` / `run.failed` / `run.stopped` | runId、错误码可选 | 本轮终态 |
| `message.delta` | runId、text、临时片段序号 | 安全叙事流；不持久 |
| `message.committed` | runId、entryId、tipEntryId | 正式消息入库，对账临时文本 |
| `state.changed` | changedScopes、tipEntryId? | 状态已成功提交，客户端失效刷新 |
| `session.tip_changed` | tipEntryId、reason | 世界线选择或分叉 |
| `command.rejected` | code、message | 命令拒绝，按 requestId 关联 |
| `error.message` | code、message、severity | 给 UI 展示的错误/通知 |

**`sse` 是传输协议，不是事件类型**。`error.message` 可作为用户期望的 error_message 通知标准化形式。`command.rejected` 是机器可处理的结果；两者同 requestId 时 Host 去重，不弹两个错误。

### 2.3 领域事件实际时序

- AgentRuntime 产生候选变更 → StateService 校验并将 Global/Session/Message 及 Entry 状态按现有设计原子提交 → 发布 `state.changed`（成功时）。
- 消息落库成功 → 发布 `message.committed`；中间的 `message.delta` 仅展示草稿。
- Session 切换世界线 → 更新 tip 后发布 `session.tip_changed`；UI 清除旧历史游标/草稿并重取新 tip。
- Global 变更用 `scope=world` 广播给授权同世界卡 Session 的 Host，不依赖当前是否有 Agent Run。
- 每个数据消费者以数据库快照为权威，不以 EventHub 事件本身恢复消息历史。

## 3. 网络：SSE + HTTP Commands（暂不引入 WebSocket）

- SSE 本身就是**单向 HTTP 长连接**。宿主为当前活跃 Session 管理一条 SSE，订阅当前 Session 加同 World 的授权事件；Hook/组件不得各建连接。用户提交文本、停止、切换分支、状态写入使用 HTTP POST，经 iframe 的受限 MessageChannel 由宿主转发。
- SSE 可以统一发送 `event: session.event`，`data` 为完整 SessionEvent JSON；`id` 可以传事件 ID，但在未实现持久日志前不能宣称 Last-Event-ID 跨重启可重放。必要时使用 SSE 注释心跳；检查代理缓冲/超时。
- 建立订阅与拿快照必须有版本对账/订阅屏障，避免初始化时漏掉提交。断线和服务重启后重新拉取权威 Snapshot 与当前分支 Run 历史；不要求重放临时 token。
- 只有未来需要高频客户端双向帧、多人协作或其他明显 WebSocket 用例时，才替换传输适配器。Event Envelope/Hook/Store 不因此改变。HTTP/1.1 多 SSE 连接数限制提醒宿主不要按组件开连接。

## 4. 首版三个 Hook

### 4.1 useSRState：统一读写

~~~tsx
const [count, setCount] = useSRState<number>(
  "玩家.计数",       // 稳定持久字段路径，必填
  0,                 // 默认展示值，可省略
  { scope: "message" } // 可省略
);

await setCount(10);
~~~

约定：
- `useSRState(0,{scope:"message"})` **不能作为持久状态 API**：没有稳定路径。无 key 的 React `useState(0)` 只属于单个组件实例，组件重排/多实例/重载后不能映射到同一数据库字段。
- 第二个参数只是**显示默认值**，不因 React 组件挂载就修改 WorldCard/Session State。真实字段/初始值仍在世界卡 `data.state` 中声明；未知字段写入由服务器拒绝。
- `scope` 可省略。沿现有 StateReader 查找顺序 **global → session → message** 首次命中完整路径停止，命中 null 也不向下匹配。同名路径按第一命中决定，作者负责命名，开发期可警告。
- Setter 必须写入**与读取解析结果相同的路径与 scope**。内部请求含当前 tip/revision/idempotency requestId；服务端重校验解析对象、状态类型、范围和权限。缺省 scope 绝不等于可绕过 Global 写入授权。
- `setCount(nextValue)` 是**异步**、需要 Server 确认的命令，不等于 React 本地 `useState` 的同步 setter。返回 `Promise<{ok:true,revision:string}|{ok:false,code:string}>`。首期不做乐观更新，收到成功提交的 `state.changed` 后从权威 Snapshot 更新组件。
- 创作者**不必编写 StateEngine ChangeSet**：SDK 将 setter 映射为内部受限写入，StateEngine 仍在后端完成 Schema/Zod、路径、作用域、权限和并发校验。预期业务失败不必抛异常，但必须返回 ok:false、发送 `command.rejected`，必要时再发 `error.message`；不能完全静默吞掉错误。
- MVP 暂只支持值 setter。`setCount(prev=>prev+1)` 不能将 JS 函数直接跨 Bridge 发送；如果未来支持，须有 expectedRevision 的比较交换或后端原子 adjust 语义，避免异步 stale closure 覆写 Agent 更新。
- UI 写入需由世界卡与用户授权的 scope/path/操作白名单约束。Global 跨 Session 默认不可写，除非显式允许。

**重要领域前置条件**：现有 Message State 沿 Entry.parent_id 父链查找，`entries.state` 默认归最终 Assistant，Entry.type 只有三类。UI 发起写入时，**不得修改历史 tip 的快照**，必须定义追加到当前世界线的状态操作记录及完整状态快照，且同步修订 Session/State/Storage、Run 游标/分叉语义。UI 文件只提出目标 API，不擅自改变领域存储。在解决此前不应宣称 setter 已真正可用。

### 4.2 useUserPrompt：用户输入与 Run 控制

~~~tsx
const { submit, stop, status, error } = useUserPrompt();
await submit("前往森林");
~~~

- 仅代表**玩家输入文本**，不是 AgentContext/系统 Prompt 干预。命名沿用创作者约定；若未来与预设 Prompt 混淆，可再考虑更明确的 `useSessionInput`。
- `submit` 负责发送玩家输入，Host 校验 Session/分支和生成互斥；返回是否受理，不等于生成完成。`status` 根据 `run.started/completed/failed/stopped` 变化。`stop` 由宿主调用现有 AgentRuntime.stop。
- 官方 `<SR.Composer />` 复用同一 Hook，避免作者自己管理 SSE。

### 4.3 useSessionHistory：流式消息 + Run 历史

~~~tsx
const {
  runs, streaming, hasMore, loadOlder, status
} = useSessionHistory();
~~~

- `runs` 是当前 tip 的已提交 NarrativeProjection，按既有 `getSessionHistory` 的 Run 游标分页，不能拆开单 Run；无 ToolCall、ToolResult、thinking、compaction 技术记录。
- `streaming` 是当前 Run 的临时、已过滤 `message.delta` 缓冲。`message.committed` 到达后按 runId/entryId 读取或对账权威叙事并消除重复。**一轮可以有多条 Assistant**。
- `loadOlder` 自动由 `<SR.Chat />` 上滑阈值/IntersectionObserver 触发，插入旧消息时保留滚动锚点；用户停留历史时不强制滚到底。作者可用 Hook 自绘消息。
- 切换世界线/断线清掉过期流和游标，重新取新分支。SSE 只用于短期流和失效通知，不替代消息持久化。
- 流式 NarrativeProjection 需要确保跨 chunk 的状态标签和思考内容不会泄漏。若 `submit_turn` 的叙事在 ToolCall JSON 参数中，增量解析未验证时应等待完整数据校验，不能原样转发工具参数。

## 5. 世界卡与 Runtime 安全

- 世界卡 `data.ui` 可选 `{default_view:"custom",custom:{entry:"ui/main.js",api_version:1}}`，缺省内置 Chat，可选 chat-state。自定义入口是预编译 React 模块；CSS/图片随世界卡 assets。世界卡唯一当前版本，不保存 Session UI 快照；用户永远能回到内置聊天。
- 作者代码在沙箱 iframe 的独立 React Root 运行；React/ReactDOM 版本由隔离 Runtime 统一提供，避免双 React Hook/Context 问题；MVP 不允许在 Runtime 下载 npm/CDN 依赖，也不在 Server 执行作者的构建脚本。
- iframe 使用严格 CSP、受限资源 URL、最小 sandbox，默认禁止父 DOM、Cookie、Provider Key、原生 IPC、任意网络、弹窗、导航、文件。不要在同源 iframe 任意同时开放 `allow-scripts` 与 `allow-same-origin`。
- Bridge 握手绑定 iframe source、session、协议版本和 nonce/MessagePort，验证频率、大小、权限。Opaque origin 的 `origin === "null"` 并不代表可信。
- 作者 JS 不能证明它确实收到玩家点击；即使只允许调用 `useUserPrompt` 和 setter，也可能偷偷自动提交并消耗 Token。首次授权、速率/成本限制、宿主可用停止/回退入口和关键操作宿主确认仍是必须的。
- 传给 iframe 的任何 State 作者 JS 都可查看；如需 NPC 秘密，先有服务端可见性投影，不能靠“不显示”保护。恶意脚本耗 CPU/内存的风险须经浏览器/WebView PoC 验证，iframe 不是完整资源隔离。

## 6. MVP 落地与验收

1. SessionEventHub 通用 Envelope、内存订阅/路由、SSE Adapter 和连接/快照对账。
2. Runtime Store、`useSRState` 读取、`useUserPrompt`、`useSessionHistory`；官方 `<SR.Chat/>` / `<SR.Composer/>` / `<SR.StatePanel/>`。
3. 独立 React Root、世界卡预编译 UI 入口、Bridge/CSP/授权、失败退回官方 Chat。
4. **独立设计状态操作在 Message 父链中的持久化、审计、并发与权限**；完成领域改动后再打开 `useSRState` Setter（同一 Hook，无独立 Mutation Hook）。
5. 用 RPG 页验证：Agent 变更 HP 自动重渲染；状态写入失败不改旧值但通知错误；聊天 SSE 及 Run 上滑分页正确；分叉切换不串状态；断线对账正常；恶意作者代码无宿主权限。

不额外引入第二套状态引擎、第二套消息表、WebSocket、动态 UI DSL、可视化布局编辑器或 Prompt 干预。**创作者体验尽量简单，复杂的一致性与安全检查集中在 Host/Server。**
