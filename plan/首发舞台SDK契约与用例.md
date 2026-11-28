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
export type Position = 'left' | 'center' | 'right' | 'top' | 'topleft' | 'topright' | 'truecenter';
export type Sprite = {position: Position; characterId: string; spriteId: string; asset: string};
export type ReadStatus = {loading: boolean; error: Error | null};
export type AssetSource = 'world' | 'stage';
export type Message = {id: string; role: 'user' | 'assistant'; content: string; timestamp: number};
export type Run = {id: string; messages: readonly Message[]};
export type RunQuery = {limit?: 1 | 2 | 3 | 4 | 5; cursor?: string};
export type RunPage = {items: readonly Run[]; hasMore: boolean; nextCursor: string | null};
```

**Session** 是一次游玩，**Run** 是其中一轮。开场可能只有助手话语，刚受理的一轮可能只有玩家话语；重生成仍属于同一轮。Run.messages 只含该轮可见的玩家和助手内容，稳定的消息 ID 可定位替换组件或查询消息状态。Server 的摘要条目、计量、原始处理结果、思考与工具调用、父链和执行回执不进入作者视图。

## 2. 全部公开 hooks

| Hook | 环境 | 作者用例 |
|---|---|---|
| useSRWorld | 会话、预览 | 读取角色、语言及资源地址，预览天气牌按路径查询 global |
| useSRSession | 会话 | 发送地图行动、停止或重生成，按轮次查询，自选事件做演出 |
| useSRState | 会话；预览限显式 global 路径只读 | 订阅余额、场景或线索字段 |
| useSRStateAPI | 会话 | 批量查询或修改状态字段、读取指定消息状态 |
| useSRComposer | 会话 | 任意输入框和建议区共享草稿，按需调用帮答 |
| useSRActionSuggestions | 会话 | 把当前建议绘制成地图选项或按钮 |
| useSRCharacterSprites | 会话 | 恢复当前立绘、控制显隐、按位置演出 |

同一 frame、同一绑定的命令函数、runs 和 events 对象引用稳定。切换绑定时撤销旧引用、监听和读取。收起输入区保留本 frame 草稿；退出或重载释放。其余可选领域由消费者按需启动。预览不可创建会话或订阅会话事件。

### 世界和素材

```ts
export type WorldView = {id: string; name: string; locale: 'zh-CN' | 'en' | 'ja';
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
export type SessionView = {
  readonly status: SessionStatus;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  regenerate(): Promise<void>;
  readonly runs: {query(params?: RunQuery, options?: ReadOptions): Promise<RunPage>};
  readonly events: {subscribe<K extends keyof ContentEvents>(
    types: readonly [K, ...K[]], listener: (event: StageEvent<K>) => void
  ): () => void};
};
export declare function useSRSession(): SessionView;
```

- **状态。** 首次挂载、断线和重新确认期间为 unknown。SDK 根据已匹配的受理回执、run.created 或近期轮次查询确认 generating；当前执行完成、中断或读取确认空闲后为 idle。停止请求受理后仍处于 generating，直到收到终态。已受理后即使一字未产生也可能结束。生成中途挂载可按需用近期一轮取得活动身份；只把它用作身份校准，不为每个按钮创建阅读列表。帮答 busy、某次发送在途和某页读取失败分别属于草稿、命令及读取方。
- **命令。** `send('推开北门')` 发送非空原文（上限 100000 字符）。`regenerate()` 捕获调用时最新可重试的玩家轮；只有玩家输入时同样可重试，纯开场不能重新生成。`stop()` 捕获调用时的当前执行。SDK 内部使用 tip、runId、assistantEntryId；身份未确认或已过期时拒绝，不能将旧动作改投后来执行。Promise 表示命令已受理，最终正文从事件或查询取得。Server 裁决并发与冲突，超时不自动重发。草稿只在对应版本已受理时清空。
- **查询。** `session.runs.query({limit: 3})` 取最近三轮；再次传上页 nextCursor 取更早一页，游标不透明。limit 是轮数，1–5，缺省 5；对外页内按时间从早到晚排列，轮内消息也按先后排列。适配层将 Server 的近期优先顺序转成阅读顺序，并原样保留 Server 生成的游标。hasMore 为 false 时 nextCursor 为 null。查询只返回该次结果，不建订阅也不移动其他组件的窗口。WorldStory 持有列表、游标、加载/重试与滚动位置；视觉小说可只取一轮，在组件内翻对白。首发无需独立 History、消息分页端点或视觉小说专属 API。

### 唯一的内容事件订阅

```ts
type Reply = {runId: string; replyId: string};
export type ContentEvents = {
  'run.created': Reply & {user: Message & {role: 'user'}; removedIds: readonly string[]};
  'run.delta': Reply & ({mode: 'append'; text: string} | {mode: 'replace'; text: string});
  'run.completed': Reply;
  'run.stopped': Reply & {replySaved: boolean; reason: 'cancelled' | 'length_limit' | 'interrupted'};
  'message.deleted': {runId: string; messageId: string};
  'state.changed': {scope: Scope; path: string; value: Value};
  'action_suggestions.created': {runId: string; messageId: string; items: readonly string[]};
  'character_sprite.changed': {runId: string; messageId: string; items: readonly Sprite[]};
};
export type StageEvent<K extends keyof ContentEvents = keyof ContentEvents> =
  {[P in K]: {type: P; data: ContentEvents[P]}}[K];
```

`session.events.subscribe(types, listener)` 作用于当前会话绑定。非空类型列表决定回调可见的判别联合；重复类型按一个处理，未知名称、空列表和通配符拒绝。返回的取消函数可重复调用。订阅只交付未来到达的内容变化，无隐式查询、初始通知或回放。一条会话 SSE、每个允许的事件过桥一次，SDK 在当前 iframe 内按类型分发；一个回调抛错不影响其他监听者。例如 `events.subscribe(['run.completed', 'run.stopped'], onEnd)` 只接收两类终态，回调通过 event.type 收窄 data。立绘和建议等便捷 hook 消费同一分发器。

| 内容事件 | 作品如何使用 |
|---|---|
| run.created、message.deleted | 按 runId 定位轮次，按 user.id 合并已受理的话语，幂等移除旧消息。replyId 是本次助手回复 ID；重新生成保留轮 ID、更换回复 ID |
| run.delta | append 追加可见正文，replace 覆盖该回复全文（Server 给最终完整输出时优先投影 replace）。只有思考或工具变化的分片不过桥。缺失前缀的阅读器显示“输出同步中”，收到 replace 或终态补读后恢复 |
| run.completed、run.stopped | 结束对应回复；completed 已包含 Server 的结算保证。中断时 replySaved 区分保留部分回复与没有该回复。用户停止、长度上限映射为 cancelled、length_limit，其他原因映射为 interrupted；技术详情留给平台 |
| state.changed | 展示订阅字段的有效变化，空 path 表示替换该 scope；固定历史目标按需重读 |
| action_suggestions.created、character_sprite.changed | 根据所属消息更新建议或整幅立绘，立绘 asset 直接解析，空数组清场 |

**平台与端口。** 平台顶栏直接读取已记录的用量并可展示摘要进度。Host 按事件名和字段白名单做投影。run.usage、run.summarizing、run.summarized、provider/model、token 计数与诊断不进入 iframe。session.created 属于运营创建流程，world.updated 交给装载器核对发行。端口连接变化用于 SDK 恢复；reply_assist.* 仅投递发起端口的帮答操作，公开内容监听收不到草稿。

**WorldStory 的读写时序。** 先安装所需类型的监听，再发近期页查询。组件保存查询代次与查询期间的相关变化；以持久页为基线，按 runId、消息 ID 对齐更新。对已经包含最终回复的页不再追加旧 delta，已删除或被替换的回复不复活。若执行切换或终态与查询交错且无法判断基线，新读一次近期页；连续 delta 不逐字触发查询。断线进入 unknown，使在途页和旧 cursor 失效，连接恢复后重建近期窗口；卸载取消查询与监听。SDK 内部按执行身份过滤迟到事件；Host 不缓存事件或正文。阅读器拿不到缺失前缀时，首发只承诺恢复最终可读内容。

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

### 草稿、帮答、建议和立绘

```ts
export type Composer = {text: string; setDraft(text: string): void; assist: Assist; submit(): Promise<void>};
export declare function useSRComposer(): Composer;
export type Assist = {available: boolean; busy: boolean; error: Error | null; start(): Promise<void>; stop(): Promise<void>};
export declare function useSRActionSuggestions(): ReadStatus & {items: readonly string[]};
export type Figure = Sprite & {name: string};
export declare function useSRCharacterSprites(options?: {enabled?: boolean}):
  ReadStatus & {available: boolean; messageId: string | null; items: readonly Figure[]};
```

- `composer.setDraft('追问守灯人')` 同步设置 frame 的共享草稿；`composer.submit()` 捕获当前文字并调用叙事发送，已受理且修订未变才清空。作者可用自己的 useState 搭配 session.send。没有输入框时无需注册虚拟工具条。扩展按钮通过 React children/props 或根布局直接组合，没有全局按钮登记、数量配额或 Host 回调。
- `composer.assist.available` 表示已配置可用的帮答预设，组件可隐藏或禁用入口；会话设置和应用默认值均未配置时为 false。执行时如配置已变化，以 Server 响应更新提示。
- `composer.assist.start()` 以**调用时的共享草稿**启动；Promise 表示受理。`composer.assist.stop()` 取消本实例的活动请求。通过 requestId 对齐 HTTP/SSE、保留已知原稿，终态校准，不自动发送。busy 期间拒绝 setDraft/submit/send/regenerate 等会覆盖该草稿或抢占执行的操作；帮答更新草稿走 frame 内同一所有者。停止请求早于受理时在匹配受理后补一次取消。全部入口遵循同一 SDK 前置条件，最终准入仍属 Server。页面离开或断线尽力停止；丢失整个 frame 时允许 Server 独立结算。
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

WorldStory、Composer、ActionSuggestions、Portraits、StatePanel、加载提示和默认根是**世界组件源码**，不是第二套特权 SDK。可按普通 ./ID 默认导入，也可完全重写。官方 WorldStory 负责加载、滚动锚点、消息规则、可读中断反馈和轮次分页；独立状态面板与建议区由根决定是否挂载。主题取公开语义 CSS token、字号 CSS 变量、浏览器 reduced-motion；三语文本由组件读取 world.locale。工具包的校验/发行函数仍供仓库工具使用，不在卡内额外注入 npm 子路径。

## 4. 作者用例

下面每段 TSX 都是独立的卡内模块。四个会话组件分别演示命令、输入、查询、订阅；最后一个模块也能用于世界预览。

**只有一扇门的地图。** 命令的在途状态归发起按钮。即使另一标签同时提交，组件也会收到可显示的错误。

```tsx
import React from 'react';
import {useSRSession} from '@sillyrealms/sdk';

export default function Door() {
  const session = useSRSession();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  async function enter() {
    setPending(true);
    setError('');
    try { await session.send('推开北门'); }
    catch (e) { setError(String(e)); }
    finally { setPending(false); }
  }
  return <section><button disabled={pending || session.status !== 'idle'} onClick={enter}>
    推开北门
  </button><span role="status">{error}</span></section>;
}
```

**可替换输入区。** 受控编辑器提交最新序列化文本。停止生成与停止帮答各自绑定原请求。

```tsx
import React from 'react';
import {SR, useSRSession, useSRComposer} from '@sillyrealms/sdk';

export default function Composer() {
  const session = useSRSession(), draft = useSRComposer(), assist = draft.assist;
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState(false);
  async function act(action: () => Promise<void>) {
    setPending(true);
    setError('');
    try { await action(); }
    catch (e) { setError(String(e)); }
    finally { setPending(false); }
  }
  function submit(text: string) {
    if (pending || session.status !== 'idle' || assist.busy || !text.trim()) return;
    void act(() => { draft.setDraft(text); return draft.submit(); });
  }
  return <section>
    <SR.RoleplayEditor value={draft.text} onChange={draft.setDraft} onSubmit={submit} disabled={assist.busy}/>
    <button disabled={pending || session.status !== 'idle' || assist.busy || !draft.text.trim()}
      onClick={() => submit(draft.text)}>发送</button>
    {session.status === 'generating' && <button onClick={() => act(session.stop)}>停止生成</button>}
    {assist.busy ? <button onClick={() => act(assist.stop)}>停止帮答</button> :
      assist.available && <button disabled={pending || session.status !== 'idle'}
        onClick={() => act(assist.start)}>帮我起草</button>}
    <span role="status">{error || assist.error?.message}</span>
  </section>;
}
```

**逐页回看。** 这个面板由玩家点开后查询，每次展示一页。它自己保存 cursor，关闭时中止读取；即时阅读器另按上节时序监听内容变化。

```tsx
import React from 'react';
import {SR, useSRSession, type RunPage} from '@sillyrealms/sdk';

export default function Journal() {
  const {runs} = useSRSession();
  const [page, setPage] = React.useState<RunPage | null>(null);
  const [error, setError] = React.useState('');
  const request = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => request.current?.abort(), [runs]);
  async function read(cursor?: string) {
    request.current?.abort();
    const ac = new AbortController();
    request.current = ac;
    setError('');
    try {
      const result = await runs.query({limit: 3, cursor}, {signal: ac.signal});
      if (!ac.signal.aborted) setPage(result);
    } catch (e) { if (!ac.signal.aborted) setError(String(e)); }
  }
  const earlier = page?.nextCursor;
  return <section>
    <button onClick={() => read()}>最近三轮</button>
    {page?.hasMore && earlier && <button onClick={() => read(earlier)}>更早三轮</button>}
    {page?.items.map(run => <article key={run.id}>{run.messages.map(message =>
      <SR.MessageBody key={message.id} message={message} runId={run.id}/>)}</article>)}
    <span role="status">{error}</span>
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

**其他组合。** 建议区取 useSRActionSuggestions().items，选中后调用 composer.setDraft 或 session.send；立绘区用 world.assetUrl(item.asset) 取得图片；状态面板用 stateAPI.query/update 并逐行报告结果。视觉小说读 limit: 1 最新轮，按 replyId 展示正文变化，通过本地状态实现翻对白；只有玩家采取新行动才调用 send。打开“重新生成”菜单时作品可用最近一轮的可见角色判断展示方式，最终目标与并发校验交给 SDK 和 Server。

## 5. 端口操作和 Server 映射

S 表示 /api/v1/sessions/:boundSession。下表是基础设施契约。作者只调用上文的对象，Host 为请求补入绑定，并在入帧之前裁剪回执。

| 端口操作 | Server 来源 | 范围 |
|---|---|---|
| session.read | GET S | 会话；内部读取 tip，去除模型配置、凭据和私人帮答目标 |
| runs.query | GET S/narrative/runs | 会话；复用现有按轮分页。桥上只保留内容、活动身份、恢复建议/立绘所需的条目 ID、父链和有效处理结果；摘要链如需遍历仅保留链接。SDK 返回 RunPage，游标与 afterSeq 等内部补读参数分开 |
| session.send / regenerate / stop | POST S/narrative/runs、S/narrative/runs/regenerate、S/narrative/runs/:runId/stop | 内部捕获 tip 和执行身份，去重受理回执；对作者返回 Promise<void> |
| state.query / update | POST /api/v1/state/query、/api/v1/state/update | 会话三域；预览只读绑定世界 global 的显式路径 |
| sprites.readMessage | GET S/entries/:entryId/character-sprites | 精确读该会话的一条消息，素材走游玩世界的 resources 端点 |
| assist.start / stop | POST S/reply-assist、S/reply-assist/:requestId/stop | 操作与发起端口绑定，回执和草稿按 requestId 隔离 |
| init、ready、appearance、connection、内容事件、操作回执及撤销 | Host 会话连接及 frame 生命周期 | preview 无会话 SSE，订阅和取消订阅在 frame 内完成 |

用量查询 GET S/narrative/usage 保留给平台顶栏。会话桥无计量操作。SDK 的包根提供本契约的七个 hook 和 SR 的三个原语；原有快照、Host 按钮登记及读写整页的接口随首发实现移除。
