# 首发舞台 SDK：公开契约与作者用例

配套[架构方案](可组合舞台与薄宿主架构方案.md)与[实施任务](可组合舞台与薄宿主架构任务.md)。这是**待实现的首发 API**，不是当前安装包手册。下列为卡内可调用的完整边界。官方舞台也只从 `@sillyrealms/sdk` 包根和编译白名单导入。仓库工具的纯 schema/打包子路径保持工具用途；Host、Provider、端口对象、EventSource 和开发诊断器均不供作者导入。

## 1. 类型与约定

以下 TypeScript 定义用于冻结接口，分段属于同一声明模块。字段视图按只读值交付；禁止作者原地修改领域返回值。React hooks 只能在组件或自定义 hook 顶层调用；可在回调中调用其方法。显式查询支持 signal，组件卸载时内部 hook 自行取消。返回 Promise 的方法在传输、拒绝、锁或业务校验失败时 reject 一个 Error（有 code、可选 HTTP status 和可显示 message）；取消为 AbortError。状态批写还必须检查每行回执。所有方法绑定当前会话/世界，调用者不提供这两个目标 ID。

```ts
export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };
export type Scope = 'global' | 'session' | 'message';
export type Target = {scope: 'global' | 'session'} | {scope: 'message'; entryId?: string};
export type ReadOptions = {signal?: AbortSignal};
export type Field = {path: string; value?: Value};
export type Write = {path: string; value: Value};
export type WriteResult = {scope: Scope; path: string; success: boolean;
  errorCode: string | null; errorMessage: string; stateScope?: Scope; statePath?: string; rulePath?: string};
export type Execution = {runId: string; assistantEntryId: string};
export type UserMessage = {id: string; role: 'user'; content: string; timestamp: number};
export type Accepted = Execution & {userEntryId: string; userMessage: UserMessage;
  tipEntryId: string | null; deletedMessageIds: readonly string[]};
export type RetryTarget = {userEntryId: string; assistantEntryId: string | null};
export type Status = 'running' | 'stopping' | 'completed' | 'stopped' | 'unknown';
export type Position = 'left' | 'center' | 'right' | 'top' | 'topleft' | 'topright' | 'truecenter';
export type SpriteId = {position: Position; characterId: string; spriteId: string};
export type Sprite = SpriteId & {asset: string};
export type ToolCall = {index: number; id: string; type: 'function'; function: {name: string; arguments: string}};
export type Message = {id: string; runId: string; parentId: string | null; role: 'user' | 'assistant';
  content: string; reasoning_content?: string; tool_calls?: readonly ToolCall[]; timestamp: number;
  output?: Readonly<Record<string,Value>>};
export type Run = {runId: string; firstSeq: number; lastSeq: number; status: Status;
  assistantEntryId?: string; stopReason?: string; finishedAt?: number; messages: readonly Message[]};
export type PageQuery = ({cursor?: string; afterSeq?: never} | {cursor?: never; afterSeq?: number}) &
  {limit?: 1 | 2 | 3 | 4 | 5};
export type Page = {items: readonly Run[]; nextCursor: string | null; nextAfterSeq: number | null;
  hasMore: boolean; activeRunId: string | null};
export type ReadStatus = {loading: boolean; error: Error | null};
export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type AssetSource = 'world' | 'stage';
export type Totals = {inputTokens: number; outputTokens: number; totalTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number};
export type Usage = {knownUsage: Totals; recordedRequestCount: number; unknownUsageRequestCount: number;
  latestContext?: {inputTokens: number | null; contextWindowTokens: number | null; modelId: string;
    stale: boolean; contextComposition?: {systemBytes: number; summaryBytes: number; historyBytes: number} | null} | null};
```

`Run.messages` 只含普通消息，reasoning/tool_calls 为公开展示字段，永不执行工具。SDK 内部保留查询投影中的 seq/parentId 和 compaction 链接供恢复；作者侧查询与阅读返回同一种展示模型，避免公开整个存储行、会话配置或内部 metrics。Message.output 只投影当前已公开的 stateUpdate、actionSuggestions、characterSprite 处理结果；debug 只控制官方视图的显示。实时助手正文在完整持久消息元数据可用前使用下述 LiveReply，不虚构 parentId 或服务端时间。

## 2. 全部公开 hooks

| Hook | 环境 | 一个真实用途 |
|---|---|---|
| useSRWorld | 会话、预览 | 取当前世界角色名称、状态根和外观；介绍组件按路径只读 global |
| useSRAssetUrl | 会话、预览 | 为包内头像或官方默认舞台装饰生成正确的资源 URL |
| useSRSession | 会话 | 展示会话标题/连接情况、按需读取一期用量、独立查询历史或观察事件 |
| useSRNarrative | 会话 | 地图点击触发行动、停止当前执行、重新生成最新回复、自画流式正文 |
| useSRHistory | 会话 | 阅读器维护自己的窗口、向上翻页并恢复滚动位置 |
| useSRStateAPI | 会话 | 状态面板批量查根、按顺序更新字段或检查指定消息状态 |
| useSRState | 会话 | 余额、天气、线索等单字段的响应式视图 |
| useSRComposer | 会话 | 任意输入组件与建议区协作填写、提交同一份本地草稿 |
| useSRReplyAssist | 会话 | 输入工具条生成帮答草稿、取消和展示错误 |
| useSRActionSuggestions | 会话 | 作者将当前建议画成选项卡、地图按钮或普通列表 |
| useSRCharacterSprites | 会话 | 作者渲染选定的完整立绘画面、实现显隐和不同布局 |

预览只有表中前两项；会话专属 hook 在错误环境抛出可定位的环境错误。消息替换组件处于所在会话环境，适用相同权限；使用效果由作用域/挂载频率决定。同一绑定及参数的返回方法引用稳定；切换会话、目标字段或分页实例后，旧持有者不能向新绑定发送命令。没有订阅者且没有在途本地操作的领域释放监听和派生数据。草稿在该 frame 首次使用时创建，切换/收起输入部件后仍可取回，到整帧销毁时释放。已建立的会话连接由 Host 独立维护。

### 世界、素材、会话

```ts
export type WorldView = {id: string; name: string; releaseVersion: string;
  locale: 'zh-CN' | 'en' | 'ja'; fontSize: number; debug: boolean;
  characters: readonly {id: string; name: string; avatar?: string}[];
  stateRoots: Readonly<Record<Scope, readonly string[]>>;
  queryGlobal(paths: readonly string[], options?: ReadOptions): Promise<readonly Field[]>;
  assetUrl(ref: string | null | undefined, source?: AssetSource): string | null};
export declare function useSRWorld(): WorldView;
export declare function useSRAssetUrl(ref: string | null | undefined, source?: AssetSource): string | null;

export type SessionView = {id: string; worldId: string; title: string | null; connection: Connection;
  characterSpritesAvailable: boolean;
  queryRuns(query?: PageQuery, options?: ReadOptions): Promise<Page>;
  getUsage(options?: ReadOptions): Promise<Usage>;
  subscribe(listener: (event: SessionEvent) => void): () => void};
export declare function useSRSession(): SessionView;
```

- `world.queryGlobal(['weather.sky'])` 在预览和会话复用一张天气牌。限制显式路径，保持现有预览 100 项、每条 2048 个 JS 字符及 32 段上限；逐行按原顺序返回。预览未声明会话目标，任何 session/message 请求在桥前拒绝。展示根名不授予额外写权限。
- `useSRAssetUrl('sr-asset://assets/keeper.webp')` 默认使用游玩世界；`useSRAssetUrl('sr-asset://assets/paper.webp','stage')` 使用根组件代码来源。循环渲染时用 `world.assetUrl(row.asset)`，避免循环调用 hook。预览两者均绑定预览作品。空引用返回 null；非法 URI 报错，包内只允许安全 assets 路径，远程 HTTP(S) 复用现有解析/CSP。
- `session.queryRuns({limit:1})` 为摘要卡单独查询，或用 `{cursor}` 翻页、`{afterSeq}` 补查；不改变 WorldStory 的游标。普通读取失败可重试。 `session.getUsage()` 只在打开计量面板时读取；未知用量不估填，contextComposition 以字节计。
- `useEffect(() => session.subscribe(onEvent), [session.subscribe])` 接收**已绑定端口上的未来事件**，返回取消函数。无首项快照、无回放。运行时隔离监听器异常；不要把帮答草稿、Server 凭据或完整世界管理详情投递此通道。

**SessionEvent 的闭集。** 采用现有[SDK 事件字段](../packages/sr-sdk/src/stage-contract.ts)和[Server 事件契约](../docs/runtime/server-events.md)的判别联合；对首发类型名 SessionEvent 保留这些分支：session.created（当前会话 ID、tip、公开开场消息投影）；run.created（用户消息、删除回执、tip）、run.summarizing、run.summarized（摘要条目 ID）、run.delta（messageId、增量/可选整条模型 snapshot）、run.usage、run.completed、run.stopped（停止原因）；message.deleted；state.changed（scope/path/value）；action_suggestions.created；character_sprite.changed（items 带 asset 或空数组）；world.updated。run.* 保留现有执行身份、计量、时间和终态回执。挂载时以 `session.connection` 读连接状态。reply_assist.* 仅由帮答领域处理。Host 仅向发起该请求的端口转交帮答消息；为待完成的流保留端口代次和 requestId，先绑定再发 HTTP，终态/失败/断线/撤桥释放。帮答正文、草稿版本和交互状态只存在于 SDK 及其组件。

```ts
export type EventFields = Execution & {sessionId: string; provider: string | null;
  model: string | null; timestamp: number};
export type Settled = EventFields & {savedMessageIds: readonly string[]; tipEntryId: string | null};
export type Delta = {content?: string; reasoning_content?: string; tool_calls?: readonly {
  index: number; id?: string; type?: 'function'; function?: {name?: string; arguments?: string}
}[]};
export type ModelMessage = {role: 'assistant'; content: string; reasoning_content: string;
  tool_calls: readonly ToolCall[]};
export type EventUsage = {input_tokens: number; output_tokens: number; total_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number};
export type SessionEvent =
  | {event: 'session.created'; data: {sessionId: string; tipEntryId: string; timestamp: number; entry: Message}}
  | {event: 'run.created'; data: EventFields & {messages: readonly [UserMessage];
      tipEntryId: string | null; deletedMessageIds: readonly string[]}}
  | {event: 'run.summarizing'; data: EventFields}
  | {event: 'run.summarized'; data: EventFields & {entryId: string}}
  | {event: 'run.delta'; data: EventFields & {messageId: string; messages: readonly [{
      role: 'assistant'; delta: Delta; snapshot?: ModelMessage;
      finish_reason?: 'stop' | 'length' | 'tool_calls' | 'deferred'}]}}
  | {event: 'run.usage'; data: EventFields & {usage: EventUsage | null}}
  | {event: 'run.completed'; data: Settled}
  | {event: 'run.stopped'; data: Settled & {stop_reason: string}}
  | {event: 'message.deleted'; data: Execution & {sessionId: string; messageId: string; tipEntryId: string | null}}
  | {event: 'state.changed'; data: {scope: Scope; path: string; value: Value}}
  | {event: 'action_suggestions.created'; data: {sessionId: string; runId: string; messageId: string; items: readonly string[]}}
  | {event: 'character_sprite.changed'; data: {sessionId: string; runId: string; messageId: string; items: readonly Sprite[]}}
  | {event: 'world.updated'; data: {sessionId: string; worldId: string; version: string; revision: number; timestamp: number}};
```

### 叙事和历史

```ts
export type LiveReply = Execution & {content: string; reasoning_content: string;
  tool_calls: readonly ToolCall[]; incomplete: boolean};
export type NarrativeView = ReadStatus & {active: Execution | null;
  phase: 'idle' | 'active' | 'preparing' | 'summarizing' | 'generating' | 'stopping';
  submitting: boolean; live: LiveReply | null;
  send(text: string): Promise<Accepted>;
  regenerate(target: RetryTarget): Promise<Accepted>;
  stop(target: Execution): Promise<void>};
export declare function useSRNarrative(): NarrativeView;
export type HistoryView = ReadStatus & {runs: readonly Run[]; hasMore: boolean; loadingMore: boolean;
  loadMore(): Promise<void>; refresh(): Promise<void>};
export declare function useSRHistory(options?: {limit?: 1 | 2 | 3 | 4 | 5}): HistoryView;
```

- `narrative.send('推开门')`。SDK 捕获实际 tip，提交原文；返回受理回执。非空且至多 100000 字符，UI 可预校验。tip 冲突后刷新相关事实，不重放玩家命令。两个同时挂载的输入部件共享 submitting 和执行身份。
- `narrative.regenerate({userEntryId,assistantEntryId})`。助手缺失传 null；由 Server 限定最新用户轮次，SDK 带 expectedTipEntryId。生成后同 run 不同执行；删除回执先使旧正文和立绘失效。
- `if (narrative.active) await narrative.stop(narrative.active)`。Promise 完成表示停止请求已送达；SSE 给出最终结果。busy 结束以 completed/stopped 为准。近期页仅能证明当前运行时使用 active 阶段，已有明确信号后才显示 preparing、summarizing、generating 或 stopping。面板 loading 表示正在同步活动身份；只有 limit=1 近期页确认空闲或接收到匹配的终态后才能把未知视为空闲。
- `history.loadMore()` 读取该实例更早一页。`history.refresh()` 重置该实例近期窗口、失效过时游标。两个阅读器可各自翻页；相同在途请求按键共享，其中一方卸载不会取消另一方的读取。单纯需要一页数据使用 queryRuns。
- **交接给 WorldStory 的精确定义。** history.runs 提供当前窗口，包含已受理的用户消息与已完成的本地展示结果；live 只提供当前助手临时态。卡组件按 runId 排列、按 messageId/assistantEntryId 放置 live，流式阶段不将其渲染两次。收到终态即结束对应 active。已挂载的阅读窗口用 savedMessageIds 移除未保存条目；如缺正文、parentId、时间或处理结果，合并一次近期读取。等待期间保留该窗口已有的已保存 ID 对应的临时展示，成功后以持久 Message 原子替换并释放；读取失败保留可见状态和重试入口。没有历史消费者时不保留上一轮全文。这里取得消息数据与确认 completed 是两件独立的事。
- 工具调用及思考字段按原生协议展示；模型 finish_reason 表示单次调用到达结束原因，不提前解锁界面。断流后不从后缀猜测前文，incomplete 由阅读器解释为“输出同步中”。

### 状态

```ts
export type StateAPI = {
  query(target: Target, paths?: readonly string[], options?: ReadOptions): Promise<readonly Field[]>;
  update(target: Target, updates: readonly Write[]): Promise<readonly WriteResult[]>};
export declare function useSRStateAPI(): StateAPI;
export type FieldView = ReadStatus & {value: Value | undefined;
  set(value: Value): Promise<WriteResult>; refresh(): Promise<void>};
export declare function useSRState(path: string, target?: Target): FieldView;
```

- `api.query({scope:'session'})` 返回所有已有根；`api.query({scope:'message',entryId},['coins'])` 查该条目的继承视图；`paths:[]` 是经过目标验证的空结果。缺失行无 value，显式 null 保留，不把数组索引当独立字段路径。
- `api.update({scope:'session'},[{path:'chapter',value:2}])` 按输入顺序返回每行结果；单行失败不回滚已成功项。target 仅代表一个作用域，跨作用域由调用者分次调用。显式 entryId 必须属于绑定会话；缺省 message.entryId 在调用开始解析当时的 tip，空 tip 时不发写请求。
- `const coins=useSRState('coins')` 默认 message 当前 tip；`coins.set(12)` 返回该行回执，`coins.refresh()` 只重读该字段；`coins.value ?? 0` 是 UI 的选择。绝不乐观创建缺失路径。随 tip 的订阅与指定旧消息的订阅分键；state.changed 没有 entryId，固定历史目标仅把相关变更当失效提示、重读该目标，不能直接应用当前 tip 的值。若历史写入未改变当前 tip，Server 可能没有推送；本帧成功的写回执使对应字段失效，跨标签的固定历史视图在 refresh 或重连时重新读取。
- 会话面板可 `session.subscribe` 筛选 state.changed，但常规组件用字段 hook 即可。预览复用 world.queryGlobal，不引入写能力。

### 草稿、帮答、建议和立绘

```ts
export type Composer = {text: string; setDraft(text: string): void; submit(): Promise<Accepted>};
export declare function useSRComposer(): Composer;
export type Assist = {available: boolean; busy: boolean; error: Error | null; start(): Promise<void>; stop(): Promise<void>};
export declare function useSRReplyAssist(): Assist;
export declare function useSRActionSuggestions(): ReadStatus & {items: readonly string[]};
export type Figure = Sprite & {name: string};
export declare function useSRCharacterSprites(options?: {enabled?: boolean}):
  ReadStatus & {available: boolean; messageId: string | null; items: readonly Figure[]};
```

- `composer.setDraft('追问守灯人')` 同步设置 frame 的共享草稿；`composer.submit()` 捕获当前文字并调用叙事发送，已受理且修订未变才清空。作者可用自己的 useState 搭配 narrative.send。没有输入框时无需注册虚拟工具条。扩展按钮通过 React children/props 或根布局直接组合，没有全局按钮登记、数量配额或 Host 回调。
- `assist.available` 表示已配置可用的帮答预设，组件可隐藏或禁用入口；会话设置和应用默认值均未配置时为 false。执行时如配置已变化，以 Server 响应更新提示。
- `assist.start()` 以**调用时的共享草稿**启动；Promise 表示受理。`assist.stop()` 取消本实例的活动请求。通过 requestId 对齐 HTTP/SSE、保留已知原稿，终态校准，不自动发送。busy 期间拒绝 setDraft/submit/send/regenerate 等会覆盖该草稿或抢占执行的操作；帮答更新草稿走 frame 内同一所有者。停止请求早于受理时在匹配受理后补一次取消。全部入口遵循同一 SDK 前置条件，最终准入仍属 Server。页面离开或断线尽力停止；丢失整个 frame 时允许 Server 独立结算。
- `useSRActionSuggestions().items` 来自当前轮的可用建议，空数组时根不占位。点击时调用 setDraft 或 send。无订阅则不扫描历史，为恢复建议只查最新轮，最后普通消息不是有效助手输出时保持空。
- `useSRCharacterSprites({enabled:show})` 控制是否消费/恢复；show 来自组件本地的按会话偏好，与 Server 的 available 分离。关闭或无素材时返回空显示且不发起恢复；再次启用按 tip 恢复。实时 asset 优先，历史按游玩世界的角色/立绘 ID 解析；已被当前发行移除的素材跳过显示。空画面可有 messageId，没找到有效画面为 null。窄屏选择一人、宽屏左右槽位等策略属于组件。 `world.assetUrl(item.asset)` 负责加载地址。

## 3. 公共渲染原语和普通组件

下表穷举 SDK 的运行时非 hook 导出；`SR` 是对象，仅包含列出的三个成员。作者卡根默认导出 React 组件；消息替换组件同样默认导出，接受 MessageComponentProps，可以声明 srDisplay 为 inline 或 block。注入 React 与 SDK 自身完成渲染所需的 Provider 属于 frame 内部。

| API 和完整 props | 可用环境 | 用例 |
|---|---|---|
| SR.MessageBody({message, runId})：message 取 Message 的 id、role、content，runId 为 string | 会话 | 官方和自定义阅读器用同一公开原语渲染正文、世界 message_render 匹配、替换组件与安全富文本。匹配失败局部回退；不生成状态写入、不执行模型原文 |
| SR.RoleplayEditor({value,onChange,onSubmit,disabled?})：value 为 string，两个回调均接收 string，返回 void；disabled 为 boolean | 会话 | 重用现有角色扮演块、IME、粘贴和键盘操作。只受控编辑与提交意图；不读取会话、不替作者发送。自定义文本框也能调用同一 send |
| SR.Document({content,density?,className?})：string、'reading' 或 'chat'、string | 两者 | 清洗和显示世界介绍中的 Markdown/允许的 HTML，作用域化样式；交互控件通过 React 编写 |
| MessageComponentProps（类型） | 消息匹配组件 | match 整段原文、groups 捕获组、namedGroups 命名捕获、message:{id,role}、runId。例：将匹配金额渲染为标签；不能修改持久正文 |

```ts
export type MessageComponentProps = {match: string; groups: readonly (string | undefined)[];
  namedGroups: Readonly<Record<string, string | undefined>>;
  message: Pick<Message, 'id' | 'role'>; runId: string};
export declare const SR: {
  MessageBody: (props: {message: Pick<Message, 'id' | 'role' | 'content'>; runId: string}) => import('react').ReactElement;
  RoleplayEditor: (props: {value: string; onChange(text: string): void; onSubmit(text: string): void;
    disabled?: boolean}) => import('react').ReactElement;
  Document: (props: {content: string; density?: 'reading' | 'chat'; className?: string}) => import('react').ReactElement;
};
```

WorldStory、Composer、ActionSuggestions、Portraits、StatePanel、UsagePanel、加载提示和默认根是**世界组件源码**，不是第二套特权 SDK。可按普通 ./ID 默认导入，也可完全重写。官方 WorldStory 负责加载、滚动锚点、消息规则、思考/工具/错误显示和历史分页；独立状态面板与建议区由根决定是否挂载。主题取公开语义 CSS token、字号 CSS 变量、浏览器 reduced-motion；三语文本由组件读取 world.locale。工具包的校验/发行函数仍供仓库工具使用，不在卡内额外注入 npm 子路径。

**收敛既有导出。** 移除 useSRStageSnapshot、useSRComposerButtons、StageSnapshot、作者侧 SRAssetProvider 与舞台写权限 Provider；useSRAssetBaseUrl 的用途由 world.assetUrl 覆盖；预览 useSRWorldStateAPI 收敛为 world.queryGlobal；历史原始读取用 session.queryRuns，草稿从 session.setDraft 移到 composer。本项目自带源码一起改写。WorldDocumentRenderer/WorldDocumentContent 统一到 SR.Document；旧 UI 导出名不设别名。

## 4. 作者写出来是什么样

下面每段 TSX 都是一个独立的卡内模块，有默认导出；例子使用目标接口。

**地图根组件。** 只发行动并读一个状态字段。没有 WorldStory、输入框和行动建议区。

```tsx
import React from 'react';
import {useSRNarrative, useSRState} from '@sillyrealms/sdk';

export default function MapStage() {
  const room = useSRState('room', {scope: 'session'});
  const run = useSRNarrative();
  const [notice, setNotice] = React.useState('');
  async function enter() {
    try { await run.send('推开北门'); }
    catch (e) { setNotice(String(e)); }
  }
  return <main>
    <h1>{typeof room.value === 'string' ? room.value : '门厅'}</h1>
    <button disabled={run.loading || !!run.active || run.submitting} onClick={enter}>推开北门</button>
    <p role="status">{notice}</p>
  </main>;
}
```

**可替换的输入区。** 下面共用草稿，却不依赖官方 Composer。submit 处理受理后的修订检查。原语的快捷键回调携带编辑器最新序列化文本，避免 React 渲染延迟时发出上一帧文字。

```tsx
import React from 'react';
import {SR, useSRComposer, useSRNarrative, useSRReplyAssist, useSRSession} from '@sillyrealms/sdk';

export default function MiniComposer() {
  const draft = useSRComposer(), run = useSRNarrative(), assist = useSRReplyAssist();
  const {connection} = useSRSession();
  const [error, setError] = React.useState('');
  const locked = connection !== 'connected' || run.loading || run.submitting || !!run.active || assist.busy;
  async function submit(text: string) {
    if (locked || !text.trim()) return;
    try { draft.setDraft(text); await draft.submit(); }
    catch (e) { setError(String(e)); }
  }
  function act(job: Promise<unknown>) { void job.catch(e => setError(String(e))); }
  return <section>
    <SR.RoleplayEditor value={draft.text} onChange={draft.setDraft} onSubmit={submit} disabled={assist.busy}/>
    <button disabled={locked || !draft.text.trim()} onClick={() => submit(draft.text)}>发送</button>
    <button disabled={locked || !assist.available} onClick={() => act(assist.start())}>帮我起草</button>
    {assist.busy && <button onClick={() => act(assist.stop())}>停止帮答</button>}
    {run.active && <button onClick={() => run.active && act(run.stop(run.active))}>停止叙事</button>}
    <p role="status">{error || assist.error?.message}</p>
  </section>;
}
```

**只读近期记录。** 这是一个回看组件，所以只读 history，不订阅 live。官方完整阅读器将 useSRNarrative().live 放入相应轮次，按前述规则处理缺段和终态。

```tsx
import React from 'react';
import {SR, useSRHistory} from '@sillyrealms/sdk';

export default function Journal() {
  const h = useSRHistory({limit: 3});
  return <section>
    {h.hasMore && <button disabled={h.loadingMore} onClick={() => h.loadMore().catch(() => {})}>更早</button>}
    <p role="status">{h.error?.message}</p>
    {h.runs.flatMap(r => r.messages.map(m =>
      <article key={m.id}><SR.MessageBody message={m} runId={r.runId}/></article>))}
  </section>;
}
```

**同一张天气牌用于世界介绍和正式舞台。** 卸载时取消，独立资源基址由 SDK 解析。

```tsx
import React from 'react';
import {useSRAssetUrl, useSRWorld} from '@sillyrealms/sdk';

export default function WeatherCard() {
  const world = useSRWorld(), cover = useSRAssetUrl('sr-asset://assets/harbor.svg');
  const [sky, setSky] = React.useState('…');
  React.useEffect(() => {
    const ac = new AbortController();
    world.queryGlobal(['weather.sky'], {signal: ac.signal})
      .then(([row]) => { if (!ac.signal.aborted) setSky(typeof row?.value === 'string' ? row.value : '未知'); })
      .catch(() => { if (!ac.signal.aborted) setSky('暂时读不到天气'); });
    return () => ac.abort();
  }, [world.id, world.queryGlobal]);
  return <figure>{cover && <img src={cover} alt="港口"/>}<figcaption>{sky}</figcaption></figure>;
}
```

**其余交互验收用例。** 建议区用 useSRActionSuggestions().items，选择“再问一次”调用 composer.setDraft 或 narrative.send；立绘区调用 useSRCharacterSprites，按 position 布局并用 world.assetUrl(figure.asset) 加载，空 items 隐藏整个区域；状态编辑器调用 state.update，逐行显示失败并刷新对应字段；最新回复菜单从最近轮次取用户和助手 ID，调用 regenerate；用量弹层只在打开时 getUsage 并检查 unknownUsageRequestCount；自定义 HUD 使用 session.subscribe 筛选 run.usage，并在 effect cleanup 取消。以上用例都不需要 Host 添加卡名、官方分支或新消息类型。

## 5. SDK 到代理的完整映射

会话前缀缩写 S=/api/v1/sessions/:boundSession；世界查询的两个 ID 绑定由装载器确定，作者无法选择其他世界。RPC 操作只覆盖下表；React 端的展示与草稿方法不会被自动提升为 RPC。

| 端口操作 | Server 契约或数据源 | 环境及约束 |
|---|---|---|
| session.read | GET S | 会话；SDK 取得 tip 和必要展示身份，端口 response 只含 SDK 所需的公开字段，剔除私人帮答目标等。设置写入仅运营端 |
| history.query | GET S/narrative/runs | 会话；页大小及游标约束；代理投影保留 SDK 恢复所需的 seq、父链、compaction 链接和允许的 output 字段，丢弃原始 extData、metrics 及 state 列；作者按 Page 读取。不得以启动预取代替订阅 |
| narrative.send / regenerate / stop | POST S/narrative/runs、S/narrative/runs/regenerate、S/narrative/runs/:runId/stop | 会话；绑定会话，send/regenerate 带 expectedTipEntryId，stop 带 assistantEntryId，返回原受理或停止回执 |
| state.query / state.update | POST /api/v1/state/query、/api/v1/state/update | 会话三域；预览仅 query+绑定 worldId/global+显式路径。scope/updates/paths 验证前不发请求；缺省消息目标由 SDK 解析到明确 entryId |
| sprites.readMessage | GET S/entries/:entryId/character-sprites | 会话；供立绘 hook 精确补读指定助手，拒绝越会话。历史角色映射来自已加载世界的公开素材声明 |
| usage.read | GET S/narrative/usage | 会话；只读 Usage。GET /runtime/config?sessionId=… 由可信装载器读取，SDK 仅取得必要的展示能力布尔值 |
| assist.start / assist.stop | POST S/reply-assist、S/reply-assist/:requestId/stop | 会话；使用帧生成的唯一 requestId，草稿上限同 Server；隔离不同请求和会话，不允许客户端覆写模型或预设 |
| init/render、appearance、connection、event、ready/error、response/cancel | 端口控制；SSE 只由 Host 建立一次 | 组件没有 raw port；init 只含绑定、模块/规则、展示数据及资源根。世界展示素材和组件来自装载器的受限投影，不给作者 world 管理详情代理 |

公开 API 与桥操作有意不是一一对应。例如多个组件可用 composer.setDraft，而端口不会看到草稿；一次 useSRState 查询只需一条 state.query；SDK 可以用已有 history.query 和 sprites.readMessage 实现多种立绘恢复策略。没有隐藏的官方 write、万能 fetch、按包名提升权限或事件重播 RPC。
