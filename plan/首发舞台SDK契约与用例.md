# 首发舞台 SDK：公开契约与作者用例

配套[架构方案](可组合舞台与薄宿主架构方案.md)与[实施任务](可组合舞台与薄宿主架构任务.md)。这是**待实现的首发 API**，不是当前安装包手册。下列为卡内可调用的完整边界。官方舞台也只从 `@sillyrealms/sdk` 包根和编译白名单导入。仓库工具的纯 schema/打包子路径保持工具用途；Host、Provider、端口对象、EventSource 和开发诊断器均不供作者导入。

## 1. 类型与约定

首发 SDK 不读取或公开平台语言，不提供翻译函数、翻译键或文案表。作品提供的正文、建议、胶囊 label 等字符串按原文传递。调用方使用错误码、停止原因及 setDraft 的结果分支处理失败；错误提示和平台输入框文案不属于本契约。

以下 TypeScript 定义用于冻结接口，分段属于同一声明模块。字段视图按只读值交付；禁止作者原地修改领域返回值。React hooks 只能在组件或自定义 hook 顶层调用；可在回调中调用其方法。显式查询支持 signal，组件卸载时内部 hook 自行取消。除 setDraft 的可预期结果见下文，其余返回 Promise 的方法在传输、拒绝、锁或业务校验失败时 reject 一个 Error（有 code、可选 HTTP status；调用方按 code 处理）；取消为 AbortError。状态批写还必须检查每行回执。所有方法绑定当前会话/世界，调用者不提供这两个目标 ID。

```ts
export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };
export type Scope = 'global' | 'session' | 'message';
export type Target = {scope: 'global' | 'session'} | {scope: 'message'; entryId?: string};
export type ReadOptions = {signal?: AbortSignal};
export type Field = {path: string; value?: Value};
export type Write = {path: string; value: Value};
export type WriteResult = {scope: Scope; path: string; success: boolean;
  errorCode: string | null; stateScope?: Scope; statePath?: string; rulePath?: string};
export type Position = 'left' | 'center' | 'right' | 'top' | 'topleft' | 'topright' | 'truecenter';
export type Sprite = {position: Position; characterId: string; spriteId: string; asset: string};
export type ReadStatus = {loading: boolean; error: Error | null};
export type AssetSource = 'world' | 'stage';
export type StopReason =
  | 'cancelled' | 'server_shutdown' | 'provider_aborted' | 'provider_error'
  | 'provider_context_window_exceeded' | 'model_not_found' | 'model_capability_unsupported'
  | 'credential_not_configured' | 'credential_unavailable' | 'context_budget_exceeded'
  | 'invalid_context' | 'output_limit_reached' | 'output_incomplete' | 'model_output_invalid'
  | 'tool_execution_unsupported' | 'summary_capacity_exceeded' | 'summary_failed'
  | 'message_persist_failed' | 'tip_conflict' | 'session_deleted' | 'internal_error';
export type ToolCall = {index: number; id: string; type: 'function';
  function: {name: string; arguments: string}};
export type Message = {id: string; content: string; timestamp: number} & (
  | {role: 'user'; status: 'complete'}
  | {role: 'assistant'; status: 'complete' | 'partial';
     reasoning_content?: string; tool_calls?: readonly ToolCall[]});
export type RunUsage = {knownUsage: {inputTokens: number; outputTokens: number;
  totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number};
  recordedRequestCount: number; unknownUsageRequestCount: number};
type Diagnostic = {errorCode: string};
type StateUpdateRow = {status: 'success'; path: string; value: Value; reason?: string}
  | {status: 'invalid_json' | 'invalid_update' | 'invalid_path' | 'invalid_value' | 'processing_error';
     path?: string; value?: Value; reason?: string; errorCode?: string; statePath?: string; rulePath?: string};
export type RunCapabilities = {
  stateUpdate?: {status: 'no_updates' | 'success' | 'partial_success' | 'invalid_updates' | 'invalid_tag' | 'processing_error';
    updates: readonly StateUpdateRow[]; errors?: readonly Diagnostic[]};
  actionSuggestions?: {status: 'no_suggestions' | 'success' | 'partial_success' | 'invalid_tag' | 'invalid_json' | 'invalid_suggestions' | 'processing_error';
    items: readonly string[]; errors?: readonly Diagnostic[]};
  characterSprite?: {status: 'success' | 'partial_success' | 'invalid_items' | 'invalid_tag' | 'processing_error';
    items: readonly Sprite[]; errors?: readonly (Diagnostic & {line?: number})[]};
};
export type Run = {id: string; assistantEntryId: string; createdAt: number;
  messages: readonly Message[]; capabilities: RunCapabilities; usage: RunUsage} & (
  | {status: 'running' | 'stopping'; stopReason: null; finishedAt: null}
  | {status: 'completed'; stopReason: null; finishedAt: number}
  | {status: 'stopped'; stopReason: StopReason; finishedAt: number});
export type RunQuery = {limit?: 1 | 2 | 3 | 4 | 5; cursor?: string};
export type RunPage = {items: readonly Run[]; hasMore: boolean; nextCursor: string | null;
  activeRunId: string | null; tipEntryId: string | null};
```

**Session** 是一次游玩，**Run** 是一轮。分页中的每项和单轮详情共用上述类型。毫秒时间、明确的 null、部分消息状态、轮次能力结果及用量都沿用 Server v15。开场是已完成的单助手轮。生成失败也可能只留下用户消息，预留的 assistantEntryId 仍标识这次执行。messages 按保存顺序只列普通消息，tipEntryId 则可能指向摘要。即使助手正文为空，也应保留已保存的思考或工具内容。存储及 HTTP 的字段来源见 [Server 会话读取](../apps/server/src/modules/sessions/service.ts) 和 [HTTP 示例](../docs/runtime/server-http.md#叙事查询与用量)。

## 2. 全部公开 hooks

| Hook | 环境 | 作者用例 |
|---|---|---|
| useSRWorld | 会话、预览 | 读取角色及资源地址，预览天气牌按路径查询 global |
| useSRSession | 会话 | 读会话开关、发送行动或填入平台草稿，按轮查询和订阅演出事件 |
| useSRState | 会话；预览限显式 global 路径只读 | 订阅余额、场景或线索字段 |
| useSRStateAPI | 会话 | 批量查询或修改状态字段、读取指定消息状态 |
| useSRComposerButtons | 会话 | 为平台输入区声明胶囊的文字与点击回调 |
| useSRActionSuggestions | 会话 | 把当前建议绘制成地图选项或按钮 |
| useSRCharacterSprites | 会话 | 读取最新普通消息产出的立绘，由作品决定显隐和演出 |

同一 frame、同一绑定的命令函数、runs 和 events 对象引用稳定。切换绑定时撤销旧引用、监听和读取。收起输入区保留本 frame 草稿；退出或重载释放。会话 SDK 从绑定到撤销持续维护只读 status，阅读、状态字段、建议和立绘按需启动。预览不可创建会话或订阅会话事件。

### 世界和素材

```ts
export type WorldView = {id: string; name: string;
  characters: readonly {id: string; name: string; avatar?: string}[];
  stateRoots: Readonly<Record<Scope, readonly string[]>>;
  queryGlobal(paths: readonly string[], options?: ReadOptions): Promise<readonly Field[]>;
  assetUrl(ref: string | null | undefined, source?: AssetSource): string | null};
export declare function useSRWorld(): WorldView;
```

`world.queryGlobal(['weather.sky'])` 按传入顺序返回行，沿用预览限制（最多 100 项、每条最多 2048 个 JS 字符及 32 段）。`world.assetUrl(item.asset)` 默认以游玩的世界为基址，官方舞台装饰可显式选 `'stage'`；预览中两者同源。空缺引用返回 null，非法路径拒绝，远程素材遵守已有解析与 CSP。主题和字号通过 CSS 外观变量应用。

### 会话、命令与轮次查询

```ts
export type SessionStatus = 'unknown' | 'idle' | 'generating';
export type SessionCapabilities = {
  readonly characterSprites: boolean;
  readonly actionSuggestions: boolean;
  readonly replyAssist: boolean;
};
export type SetDraftResult = {ok: true} |
  {ok: false; reason: 'assist_active' | 'draft_too_long' | 'session_closed'};
export type SessionView = {
  readonly status: SessionStatus;
  readonly capabilities: SessionCapabilities;
  send(text: string): Promise<void>;
  setDraft(text: string): Promise<SetDraftResult>;
  readonly runs: {query(params?: RunQuery, options?: ReadOptions): Promise<RunPage>;
    get(runId: string, options?: ReadOptions): Promise<Run>};
  readonly events: {subscribe<K extends string>(
    types: readonly [K, ...K[]], listener: (event: StageEvent<K>) => void
  ): () => void};
};
export declare function useSRSession(): SessionView;
```

- **挂载即校准。** 会话 iframe 绑定端口时，SDK 先安装连接及运行事件接收器，立即通过桥读取 GET S/narrative/runs?limit=1。每个会话 frame 只有一个状态所有者；空舞台、只展示天气和同时挂载多个 useSRSession 的舞台均执行同一流程。子组件挂载、卸载或翻页不会触发额外校准。预览没有会话绑定。校准保留活动身份、真实 tip 和只读状态，作品读页及游标独立。
- **重连即重校准。** 断线后立即发布 unknown。每次 SSE 重新连通，SDK 主动重读 limit=1。若首次校准发生在 SSE 连通前，到首次连通时也要补读，覆盖中间的事件空档。可恢复的读取失败由 SDK 退避重试；尚无可信结果时保持 unknown。同代次最多一个校准在途，撤桥或切换会话即取消。作者只读 status，无需调用 runs.query 或手动刷新。
- **状态如何裁决。** 已连通的当前代次中，校准结果 activeRunId 为 null 表示 idle；匹配活动轮和回复身份且状态为 running/stopping 表示 generating。身份不一致时保持 unknown 并重新校准。在线期间匹配的受理回执或 run.created 进入 generating，对应终态回到 idle，停止请求本身仍为 generating。校准开始时记录连接代次和运行事件修订号；旧响应不能覆盖较新的开始、终态或重新生成，无法确定先后时由 SDK 补读。迟到的受理回执不能复活已结束的执行。帮答 busy 与单次命令、翻页的在途状态归各自调用方。
- **会话配置。** capabilities 逐项返回存储在当前会话的三个开关原值，只读、响应式。设置保存后由平台下发，重连重读。即使世界没有包内立绘，开关为 true 就返回 true。作品可使用云端素材、自行决定呈现；模型预设、素材数量、最近输出和配置错误均不改写这些值。平台 Composer 根据 replyAssist 展示帮答入口，实际执行失败由平台处理。
- **直接行动。** `send('推开北门')` 发送非空原文（上限 100000 字符），Promise 表示命令已受理；最终内容通过事件或查询取得。SDK 捕获 tip，Server 裁决并发与冲突，超时不自动重发。作品发起的行动保留输入框中的草稿。平台 Composer 自己提交草稿时，只有受理的草稿修订仍相同才清空。
- **填入草稿。** `await session.setDraft(text)` 返回 SetDraftResult。成功时 frame 本地共享草稿已写入，其他视图在下次渲染可见。空字符串用于清空。帮答持有草稿写权、超过 100000 字符、旧会话绑定已销毁分别返回 assist_active、draft_too_long、session_closed；失败保留原文。生成中、暂时断网或输入区收起时仍可填写。写入判定和应用按调用顺序完成，不发 HTTP 或端口消息，不自动发送。作者 SDK 不提供读取草稿、代提交草稿或取得编辑器实例的接口。
- **查询。** `session.runs.query({limit: 3})` 取最近三轮；再次传上页 nextCursor 取更早一页，游标不透明。limit 是轮数，1–5，缺省 5；对外页内按时间从早到晚排列，轮内消息也按先后排列。适配层将 Server 的近期优先顺序转成阅读顺序，并原样保留 Server 生成的游标。hasMore 为 false 时 nextCursor 为 null。查询只返回该次结果，不建订阅也不移动其他组件的窗口。WorldStory 持有列表、游标、加载/重试与滚动位置；视觉小说可只取一轮，在组件内翻对白。首发无需独立 History、消息分页端点或视觉小说专属 API。

- **单轮读取。** `session.runs.get(runId)` 直接返回 Run，同一绑定内缺失或不属于本会话时返回 RUN_NOT_FOUND。终态后缺正文、原因或能力结果可精确补读。若期间同轮已被重新生成，详情返回最新执行，消费者必须核对 assistantEntryId。整页的 activeRunId、tipEntryId 是该次查询时的会话事实，翻旧页不会回退 SDK 的当前状态。cursor 始终按 Server 返回值传回，摘要或同轮重生成均不移动轮次的分页位置。

### 唯一的会话事件订阅

端口交付 Server 已公开的 SSE 信封 `{event, data}`。event 保持原名，data 保留完整解析后的 JSON，包括新加的字段。已知事件具有判别联合，未来命名事件也可按名称订阅，未知载荷须由使用者收窄。以下类型说明目前实际产生的事件。

```ts
type Execution = {runId: string; assistantEntryId: string; sessionId: string;
  provider: string | null; model: string | null; timestamp: number};
type Saved = Execution & {savedMessageIds: readonly string[]; tipEntryId: string | null};
type Output = {role: 'assistant'; delta: {content?: string; reasoning_content?: string;
  tool_calls?: readonly {index: number; id?: string; type?: 'function';
    function?: {name?: string; arguments?: string}}[]};
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'deferred';
  snapshot?: {role: 'assistant'; content: string; reasoning_content: string; tool_calls: readonly ToolCall[]}};
type SourceMessage = {sessionId: string; runId: string; messageId: string};
type Assist = {sessionId: string; requestId: string; timestamp: number};
export type SessionEventData = {
  'session.created': {sessionId: string; tipEntryId: string; timestamp: number;
    opening: {runId: string; message: Message}};
  'world.updated': {sessionId: string; worldId: string; version: string; revision: number; timestamp: number};
  'run.created': Execution & {messages: readonly [Extract<Message, {role: 'user'}>];
    tipEntryId: string | null; deletedMessageIds: readonly string[]};
  'run.summarizing': Execution;
  'run.summarized': Execution & {entryId: string};
  'run.delta': Execution & {messageId: string; messages: readonly [Output]};
  'run.usage': Execution & {usage: RunUsage};
  'run.completed': Saved;
  'run.stopped': Saved & {stop_reason: StopReason};
  'message.deleted': SourceMessage & {assistantEntryId: string; tipEntryId: string | null};
  'state.changed': {scope: Scope; path: string; value: Value};
  'action_suggestions.created': SourceMessage & {items: readonly string[]};
  'character_sprite.changed': SourceMessage & {items: readonly Sprite[]};
  'reply_assist.delta': Assist & {delta: {content: string}};
  'reply_assist.completed': Assist & {snapshot: {content: string}};
  'reply_assist.stopped': Assist & {snapshot: {content: string}; stop_reason: string};
};
export type StageEvent<K extends string = keyof SessionEventData> =
  K extends keyof SessionEventData ? {event: K; data: SessionEventData[K]} : {event: K; data: unknown};
```

`session.events.subscribe(types, listener)` 接收当前绑定未来到达的所选名称。列表非空，按名称精确匹配，重复名只回调一次，取消函数幂等。Host 每帧只转发一次完整会话事件，多个回调在 iframe 内分发，单个回调抛错不影响其他监听者。监听类型说明、作品的筛选或领域状态归并均不能改写公共事件流。原始顺序以本连接的到达次序为准。连接状态、心跳注释及重连校准属于传输生命周期。

| 事件 | 作者与平台如何消费 |
|---|---|
| run.created、message.deleted | 按 messages[0].id 合并受理用户，按 deletedMessageIds 或 messageId 幂等移除旧助手。runId 标识轮，assistantEntryId 标识本次执行 |
| run.delta | 读 messages[0].delta 的 content、reasoning_content、tool_calls，包括只有工具或思考的分片。snapshot 存在时用其完整内容覆盖临时输出。保留 finish_reason，等运行终态再结束忙态 |
| run.completed、run.stopped | 用 savedMessageIds 判断预留的助手是否保存，以 tipEntryId 更新实际 tip。停止事件的 stop_reason 与该次执行历史 Run.stopReason 的值相同。可以直接按 output_limit_reached、summary_failed 等原因编排 |
| run.summarizing、run.summarized、run.usage | 作者按需订阅。顶栏展示压缩进度和用量，普通阅读器无需订阅。usage 是本次 Run 汇总，按执行替换 |
| state.changed、action_suggestions.created、character_sprite.changed | 空 path 替换整域。建议和立绘按 messageId 使用整组 items，立绘使用其中的 asset |
| session.created、world.updated | 开场用 opening.runId 和 opening.message。装载器可用发行信息核对内容版本 |
| reply_assist.delta、reply_assist.completed、reply_assist.stopped | 同会话作品（包括另一标签页）可以观察模型生成的帮答文本。仅发起操作的 Composer 按 requestId 与本地绑定修订匹配后写入草稿。事件订阅不赋予调用帮答、停止或读取编辑器的权限 |

例如执行 `a1` 遇到输出上限，组件收到 `run.stopped`，其 `data.stop_reason` 是 `output_limit_reached`。若 `savedMessageIds` 含 `a1`，重新打开该轮能读到同一原因、`status: "stopped"` 和助手消息的 `status: "partial"`。若只有用户消息，轮次仍可查询原因。若玩家已重新生成，轮 ID 不变，当前执行 ID 已变成 `a2`，阅读器应采用新执行的结果。

**WorldStory 的读写时序。** 先安装所需类型的监听，再发近期页查询。组件保存查询代次与查询期间的相关变化；以持久页为基线，按 runId、消息 ID 对齐更新。对已经包含最终回复的页不再追加旧 delta，已删除或被替换的回复不复活。若执行切换或终态与查询交错且无法判断基线，新读一次近期页；连续 delta 不逐字触发查询。断线进入 unknown，使在途页和旧 cursor 失效，连接恢复后重建近期窗口；卸载取消查询与监听。阅读器和 SDK 自有状态分别按执行身份忽略过期更新，原始订阅仍交付迟到事件；Host 不缓存事件或正文。阅读器拿不到缺失前缀时，首发只承诺恢复最终可读内容。

### 状态

```ts
export type StateAPI = {
  query(target: Target, paths?: readonly string[], options?: ReadOptions): Promise<readonly Field[]>;
  update(target: Target, updates: readonly Write[]): Promise<readonly WriteResult[]>};
export declare function useSRStateAPI(): StateAPI;
export type FieldView = ReadStatus & {value: Value | undefined;
  set?: (value: Value) => Promise<WriteResult>; refresh(): Promise<void>};
export declare function useSRState(path: string, target?: Target): FieldView;
```

- `api.query({scope:'session'})` 返回所有已有根；`api.query({scope:'message',entryId},['coins'])` 查该条目的继承视图；`paths:[]` 是经过目标验证的空结果。缺失行无 value，显式 null 保留，不把数组索引当独立字段路径。
- `api.update({scope:'session'},[{path:'chapter',value:2}])` 按输入顺序返回每行结果；单行失败不回滚已成功项。target 仅代表一个作用域，跨作用域由调用者分次调用。显式 entryId 必须属于绑定会话；缺省 message.entryId 在调用开始解析当时的 tip，空 tip 时不发写请求。
- `const coins=useSRState('coins')` 默认 message 当前 tip；会话内调用 `coins.set?.(12)` 可取得该行回执，`coins.refresh()` 只重读该字段；`coins.value ?? 0` 是 UI 的选择。绝不乐观创建缺失路径。随 tip 的订阅与指定旧消息的订阅分键；state.changed 没有 entryId，固定历史目标仅把相关变更当失效提示、重读该目标，不能直接应用当前 tip 的值。若历史写入未改变当前 tip，Server 可能没有推送；本帧成功的写回执使对应字段失效，跨标签的固定历史视图在 refresh 或重连时重新读取。
- 会话面板可 `session.events.subscribe(['state.changed'], listener)` 观察变化，但常规组件用字段 hook 即可。预览只允许显式 global 路径，字段视图省略 set，会话中提供 set。预览需要刷新时通过显式查询或字段 refresh，预览没有 SSE。

### 平台输入区的扩展点、建议和立绘

```ts
export type ComposerButton = {readonly label: string; onClick(): void | Promise<void>};
export declare function useSRComposerButtons(buttons: readonly ComposerButton[]): void;
export declare function useSRActionSuggestions(): ReadStatus & {items: readonly string[]};
export type Figure = Sprite & {name: string};
export declare function useSRCharacterSprites():
  ReadStatus & {messageId: string | null; items: readonly Figure[]};
```

- **胶囊声明。** hook 每个挂载实例拥有自己的一组声明，同一组按数组顺序，多组按登记顺序。可重名，React 注册实例与组内位置确定回调归属。重渲染更新当前标签和回调，仅回调引用变化时不重新登记或改变位置，避免内联函数引起重复渲染。卸载仅撤销本组；同一 frame 内直接调用最新回调。注册器和回调引用属于 frame 本地 React 状态。平台不识别“立绘胶囊”，不检查配置决定是否登记、禁用或点击；没有跨端口的按钮列表、版本或点击指令。按钮数量超过可见区域时全部保留。
- **胶囊布局。** 输入区统一渲染固定宽度的单行滚动区域（窄屏最大为 Composer 可用宽度），胶囊等宽且不压缩。容得下时整组居中；溢出时从第一项开始，裁切视口外部分，左右滑动可达最后一项。Tab 聚焦时滚入视口，长标签截断并保留完整可访问名称。作者仅声明 label 和 onClick。收起时保留登记和草稿，展开仍是同一实例。
- **建议与立绘。** 两个 hook 都只读最新一轮的最后一条普通消息，跳过内部摘要；玩家消息也算最新。建议区取 items，点击可填草稿或直接发行动。立绘 hook 无参数，返回结果中无 available。挂载、重连从最新 Run 的 messages 定位该消息，直接使用同一 Run.capabilities。缺失终态时可按 runId 补读整轮。messageId 指向用于判断的最新消息，无普通消息时为 null。最新为玩家输入、助手未产出立绘、无效输出或显式清场均返回空数组；success / partial_success 返回该消息有效项。提交被受理、重生成删除旧助手时立即丢弃旧画面，迟到事件/查询不能复活旧图。没有父链回溯、旧页查找或继承。实时事件可直接解析 asset。作品可另用云端资源或在组件内实现留场演出。
- **固定平台 Composer。** 它与作者根共用 frame 实例，由 FrameShell 强制挂载在作品错误边界之外。收起仍保留展开与活动生成的停止入口。停止、重新生成、帮答及后续输入功能仅由平台输入区触发；私有控制器取得执行身份或帮答 requestId。作者能从事件看到执行 ID 和 requestId。私有命令只在平台控制器内可调用。帮答启动后只写本地所属草稿，断线尽力停止，旧帧回执不写新会话。预览不挂载输入区。这个边界约束受支持的接口；同一 JS 环境中的作品与平台输入区不构成浏览器级安全隔离。

## 3. 公共渲染原语和普通组件

下表穷举 SDK 的运行时非 hook 导出；`SR` 是对象，仅包含列出的两个成员。作者卡根默认导出 React 组件；消息替换组件同样默认导出，接受 MessageComponentProps，可以声明 srDisplay 为 inline 或 block。注入 React 与 SDK 自身完成渲染所需的 Provider 属于 frame 内部。

| API 和完整 props | 可用环境 | 用例 |
|---|---|---|
| SR.MessageBody({message, runId})：message 取 Message 的 id、role、content，runId 为 string | 会话 | 官方和自定义阅读器用同一公开原语渲染正文、世界 message_render 匹配、替换组件与安全富文本。匹配失败局部回退；不生成状态写入、不执行模型原文 |
| SR.Document({content,density?,className?})：string、'reading' 或 'chat'、string | 两者 | 清洗和显示世界介绍中的 Markdown/允许的 HTML，作用域化样式；交互控件通过 React 编写 |
| MessageComponentProps（类型） | 消息匹配组件 | match 整段原文、groups 捕获组、namedGroups 命名捕获、message:{id,role}、runId。例：将匹配金额渲染为标签；不能修改持久正文 |

```ts
export type MessageComponentProps = {match: string; groups: readonly (string | undefined)[];
  namedGroups: Readonly<Record<string, string | undefined>>;
  message: Pick<Message, 'id' | 'role'>; runId: string};
export declare const SR: {
  MessageBody: (props: {message: Pick<Message, 'id' | 'role' | 'content'>; runId: string}) => import('react').ReactElement;
  Document: (props: {content: string; density?: 'reading' | 'chat'; className?: string}) => import('react').ReactElement;
};
```

WorldStory、ActionSuggestions、Portraits、StatePanel、加载提示和默认根是**世界组件源码**，不是第二套特权 SDK。可按普通 ./ID 默认导入，也可完全重写。官方 WorldStory 负责加载、滚动锚点、消息规则、可选的思考文本展示、可读中断反馈和轮次分页；独立状态面板与建议区由根决定是否挂载。主题取公开语义 CSS token、字号 CSS 变量、浏览器 reduced-motion。工具包的校验/发行函数仍供仓库工具使用，不在卡内额外注入 npm 子路径。

## 4. 作者用例

下面每段 TSX 都是独立的卡内模块。示例中的文字仅为作品内容。五个会话组件分别演示行动、胶囊与草稿、轮次查询、内容订阅和流式思考展示；最后一个模块也能用于世界预览。

**只有一扇门的地图。** 命令的在途状态归发起按钮。并发提交失败后，组件仍能处理下一次玩家行动。

```tsx
import React from 'react';
import {useSRSession} from '@sillyrealms/sdk';

export default function Door() {
  const session = useSRSession();
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  async function enter() {
    setPending(true);
    setFailed(false);
    try { await session.send('推开北门'); }
    catch { setFailed(true); }
    finally { setPending(false); }
  }
  return <section data-failed={failed}><button disabled={pending || session.status !== 'idle'} onClick={enter}>
    推开北门
  </button></section>;
}
```

**登记两个胶囊。** “角色”始终登记，组件自己选择点击行为。“追问”只填写玩家草稿；失败时保留 SDK 返回的原因码。两个回调都在本 frame 执行。

```tsx
import React from 'react';
import {useSRComposerButtons, useSRSession} from '@sillyrealms/sdk';

export default function StoryActions() {
  const session = useSRSession();
  const [view, setView] = React.useState('');
  const [reason, setReason] = React.useState<string>();
  useSRComposerButtons([
    {label: '角色', onClick: () => setView(session.capabilities.characterSprites ? 'portraits' : 'characters')},
    {label: '追问', onClick: async () => {
      const result = await session.setDraft('追问守门人');
      setReason(result.ok ? undefined : result.reason);
    }},
  ]);
  return <section data-view={view} data-draft-error={reason}/>;
}
```

**逐页回看。** 这个面板由玩家点开后查询，每次展示一页。它自己保存 cursor，关闭时中止读取；面板展示每轮状态、原始停止原因和每条消息的完整性。即时阅读器另按上节时序监听事件。

```tsx
import React from 'react';
import {SR, useSRSession, type RunPage} from '@sillyrealms/sdk';

export default function Journal() {
  const {runs} = useSRSession();
  const [page, setPage] = React.useState<RunPage | null>(null);
  const [failed, setFailed] = React.useState(false);
  const request = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => request.current?.abort(), [runs]);
  async function read(cursor?: string) {
    request.current?.abort();
    const ac = new AbortController();
    request.current = ac;
    setFailed(false);
    try {
      const result = await runs.query({limit: 3, cursor}, {signal: ac.signal});
      if (!ac.signal.aborted) setPage(result);
    } catch { if (!ac.signal.aborted) setFailed(true); }
  }
  const earlier = page?.nextCursor;
  return <section data-failed={failed}>
    <button onClick={() => read()}>最近三轮</button>
    {page?.hasMore && earlier && <button onClick={() => read(earlier)}>更早三轮</button>}
    {page?.items.map(run => <article key={run.id}>
      <header>{run.status}{run.status === 'stopped' && <code>{run.stopReason}</code>}</header>
      {run.messages.map(message => <section key={message.id} data-status={message.status}>
        <SR.MessageBody message={message} runId={run.id}/>
      </section>)}
    </article>)}
  </section>;
}
```

**监听一次立绘换场。** 此组件专门呈现挂载后的换场提示。初次打开也需要还原当前画面时，使用 useSRCharacterSprites；它在同一个内容分发器上监听，并按需读取。

```tsx
import React from 'react';
import {useSRSession} from '@sillyrealms/sdk';

export default function CastNotice() {
  const {events} = useSRSession();
  const [notice, setNotice] = React.useState('');
  React.useEffect(() => events.subscribe(['character_sprite.changed'], event => {
    setNotice(event.data.items.length ? '角色换场' : '角色退场');
  }), [events]);
  return <span role="status">{notice}</span>;
}
```

**展示当前回复的流式思考。** 此面板演示一次已观察到开始的执行。持久化阅读器在挂载及重连时还需读最近页并按执行身份交接，已保存文本取 message.reasoning_content。

```tsx
import React from 'react';
import {useSRSession} from '@sillyrealms/sdk';

export default function ReplyThought() {
  const {events} = useSRSession();
  const [thought, setThought] = React.useState('');
  React.useEffect(() => {
    let activeId: string | undefined;
    return events.subscribe(['run.created', 'run.delta', 'run.completed', 'run.stopped'], e => {
      if (e.event === 'run.created') {
        activeId = e.data.assistantEntryId;
        setThought('');
      } else if (e.data.assistantEntryId === activeId) {
        if (e.event === 'run.delta') {
          const {delta, snapshot} = e.data.messages[0];
          if (snapshot) setThought(snapshot.reasoning_content);
          else if (delta.reasoning_content) {
            const part = delta.reasoning_content;
            setThought(previous => previous + part);
          }
        } else {
          if (!e.data.savedMessageIds.includes(e.data.assistantEntryId)) setThought('');
          activeId = undefined;
        }
      }
    });
  }, [events]);
  return thought ? <details><summary>思考</summary><p>{thought}</p></details> : null;
}
```

**预览与游玩共享的天气牌。** 显式绑定 global 路径，同一资源在两个环境中都以作品为基址。

```tsx
import React from 'react';
import {useSRWorld, useSRState} from '@sillyrealms/sdk';

export default function WeatherCard() {
  const world = useSRWorld(), sky = useSRState('weather.sky', {scope: 'global'});
  const cover = world.assetUrl('sr-asset://assets/harbor.svg');
  return <figure>{cover && <img src={cover} alt="港口"/>}
    <figcaption>{typeof sky.value === 'string' ? sky.value : '天气未知'}</figcaption></figure>;
}
```

**其他组合。** 建议区取 useSRActionSuggestions().items，选中后调用 session.setDraft 或 session.send；立绘区用 world.assetUrl(item.asset) 取得图片；状态面板用 stateAPI.query/update 并逐行报告结果。视觉小说读 limit: 1 最新轮，按 assistantEntryId 展示正文变化，通过本地状态实现翻对白；只有玩家采取新行动才调用 send。重新生成由平台输入区锁定最新可重试目标，作品监听该轮的新回复。

## 5. 端口操作和 Server 映射

S 表示 /api/v1/sessions/:boundSession。下表是基础设施契约。作者只调用上文的对象，Host 为请求补入绑定，并解开 HTTP 的 data 包络。

| 端口操作 | Server 来源 | 范围 |
|---|---|---|
| session.read | GET S | 会话；读取 tip 和持久化的三项开关原值，去除模型配置、凭据和私人帮答目标 |
| runs.query | GET S/narrative/runs | 会话；完整 RunPage，SDK 绑定和重连自动 limit=1 校准，作者独立翻页 |
| runs.get | GET S/narrative/runs/:runId | 与页项同型的完整 Run，按绑定检查归属 |
| session.send | POST S/narrative/runs | 发送 {input:{text},expectedTipEntryId}，用 202 与 run.created 中相同的消息和执行身份去重 |
| 平台内部 regenerate / stop | POST S/narrative/runs/regenerate、S/narrative/runs/:runId/stop | 仅固定 Composer 的私有控制器调用；再生传 {runId,expectedAssistantEntryId,expectedTipEntryId}，停止传 {assistantEntryId} |
| state.query / update | POST /api/v1/state/query、/api/v1/state/update | 会话三域；预览只读绑定世界 global 的显式路径 |
| 平台内部 assist.start / stop | POST S/reply-assist、S/reply-assist/:requestId/stop | 仅平台 Composer 触发，操作与发起端口绑定，回执和草稿按 requestId 隔离 |
| init、ready、appearance、connection、会话原生事件、操作回执及撤销 | Host 会话连接及 frame 生命周期 | preview 无会话 SSE，订阅和取消订阅在 frame 内完成 |

用量查询 GET S/narrative/usage 保留给平台顶栏。会话桥无计量操作。setDraft、胶囊登记与点击均在 frame 本地完成。SDK 的包根提供本契约的七个 hook 和 SR 的两个原语；原有快照、Host 按钮登记及读写整页的接口随首发实现移除。
