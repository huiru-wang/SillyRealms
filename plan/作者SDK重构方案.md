# 作者 SDK 重构方案

状态为待实施。本文定义拟冻结的世界卡作者契约。实施顺序与验收样例见[重构任务](作者SDK重构任务.md)。

## 数据归属

| 数据 | 负责方 | 作者如何使用 |
| --- | --- | --- |
| 已持久化的对话轮次 | Server 保存，Host 按游标查询 | 组件自行保存查询页、游标、错误和加载进度，决定追加或替换 |
| 当前执行与实时正文 | Host 维护，frame 读取投影 | 随时挂载都能观察当前执行，按消息 ID 与已保存正文交接 |
| 全局、会话、消息玩法状态 | 对应数据源保存，Host 绑定目标并执行读写 | 同一套状态 Hook 读取有效值、提交更新并获得逐项结果 |
| 草稿、当前行动建议、输入区布局 | Host | 作者可填写草稿、读取建议、声明按钮 |
| 表单未提交内容、展开状态、滚动位置 | 作者组件或官方阅读器 | 使用局部 React 状态，组件自行管理生命周期 |

作者从 `@sillyrealms/sdk` 根入口导入。首发提供 5 个 Hook、3 个展示组件和消息匹配参数。下方签名中的辅助类型说明可见字段，不要求把所有类型名都作为独立根导出。宿主负责会话绑定、资源定位、数据恢复与权限校验。

## 1. useSRSession

```ts
const session = useSRSession();
const status = useSRSession(s => s.status); // 可选选择函数，仅订阅所选值

session.connected;   // 事件连接状态，与执行状态独立
session.status;      // 'idle' | 'submitting' | 'generating' | 'stopping'
session.runs.active; // 当前执行的只读轮次投影，空闲时为 null
const page = await session.runs.query({ limit: 5, cursor });
const unsubscribe = session.runs.subscribe(onPersistedRunsChanged);
await session.setDraft(text);                 // Promise<void>，替换并展开可编辑草稿
const { runId } = await session.send(text);   // 受理后返回，生成结果由 runs 提供
```

- `idle` 表示没有提交或活动执行；`submitting` 表示等待受理；`generating` 涵盖受理后的上下文准备、摘要和生成；`stopping` 表示等待停止结束。按当前执行身份处理晚到的确认，不能让已开始生成的状态倒退到提交中。断线期间保留最近已知值，重连后由 Host 校准。
- `runs.active` 在尚无已受理执行时也可为 null。活动轮次和已查询轮次采用同一展示结构：`{ id, status, messages }`。轮次状态沿用 running、stopping、completed、stopped、unknown。消息字段为 `id、role、content、timestamp、saved`，角色为 user 或 assistant，时间为 Unix 毫秒。已可见的流式正文可以尚未保存。重新生成可以沿用轮次 ID，新的助手回复使用新的消息 ID。
- `runs.query({ cursor?, limit? })` 返回 `Promise<{ runs, nextCursor }>`。省略游标查询最近页，页内按从旧到新排列。下一页指向更早的轮次，到头返回 null。复用当前服务端页容量（1–5，默认 5），游标对作者不透明。返回字段只描述展示所需的数据；摘要条目、模型用量、原始扩展和服务端记录留在内部。
- 一次查询只返回一页。两个组件可以各查一页互不干扰；同一组件取两页各五轮，只有自行合并后才持有十轮。首发契约不提供 `session.history`、共享分页缓存、`revision`、`loadMore()` 或查询加载标志。
- `runs.subscribe(listener): () => void` 是持久化轮次失效通知。玩家消息或助手消息已提交、回复被删除或替换、持久化终态发生变化、重连完成校准时通知。通知可以合并；流式字符只更新 active。回调无原始 SSE 负载，订阅不隐式读取数据。
- 阅读器先订阅再查首页；查询未返回时收到通知，标记待刷新或忽略过期结果。重新生成、重连后使失效的旧分页退出当前视图。实时正文与已保存消息按消息 ID 去重，保留已显示的最后正文直至持久化读取接手或确认被删除。卸载时解除订阅，忽略晚到的异步结果。
- 命令引用稳定。对只订阅 status 或命令的组件，正文增量不应引起重渲染。停止与重新生成由宿主官方输入区承担。作者 SDK 不暴露停止、删除、重生成命令或事件总线。

## 2. useSRState

```ts
const state = useSRState([{ scope: 'global', path: 'weather.sky' }]);
state.values;            // 首次成功前为 null，之后按查询顺序提供只读值
state.loading;           // 本组件这组查询的读取进度
state.error;             // 最近读取错误，正常时为 null
await state.refresh();   // 回读同组查询，返回本次值并更新展示
const [row] = await state.write([
  { scope: 'global', path: 'weather.sky', value: '雨' },
]);
const { write } = useSRState([]); // 仅写入时，无须读取字段
```

详情、介绍、开局和会话共用读写签名。每一项显式指定 scope。global 定位当前世界，session 定位当前会话，message 定位当前会话末端的有效状态。详情有世界身份即可读写 global。请求没有绑定目标的作用域时明确报告缺少上下文；不回退到其他作用域。查询可省略 path 读取完整作用域，写入必须指定有效的非空路径。按目标上下文和已有授权在 Host 再次验证，组件不能通过输入任意世界或会话 ID 切换目标。

路径缺失返回 undefined，已存 JSON null 原样返回。支持账册按域读取、表单跨域批读写；相同查询内容的普通重渲染不会重复请求。对已挂载读者呈现宿主已确认的有效变化，可主动 refresh。写入列表独立于订阅的查询列表，单写与批写共用签名，按输入顺序返回逐项回执，允许部分成功。回执应区分实际修改、值相同、目标缺失、失败；判定来自持有写事务的数据源。复用现有锁与提交后事件，不通过两次外部回读猜测写入结果。

这项设计会扩展当前详情桥接的只读权限。实施时同步调整 Host 方法名单、详情读写桥接、Server 结果投影、作者文档和仓库约束。目标仅为当前绑定世界的状态操作，不开放通用 HTTP、跨世界访问或无会话身份的会话操作。

## 3. useSRAsset

```ts
const portrait = useSRAsset('sr-asset://assets/portraits/掌柜.png');
// (uri: string | null) => string | null
```

所有作者组件可用。解析包内资源 URI 或支持的 HTTP(S) 地址，null 返回 null，非法地址报告错误。包内路径校验与编码复用现有解析器。返回 URL 不代表资源已下载。基址和 Provider 属于宿主集成。

## 4. useSRActionSuggestions

```ts
const { items } = useSRActionSuggestions(); // readonly string[]，初始为空
```

会话内读取当前回复的建议，顺序即展示顺序。Host 负责恢复与清空。自绘视图复用 session.setDraft 或 session.send，不引入建议专属命令或第二份建议入口。

## 5. useSRComposerButtons

```ts
useSRComposerButtons([
  { id: 'inventory', label: '查看背包', disabled: false, onClick: openInventory },
]);
```

由当前舞台统一声明，最多五项，数组顺序即显示顺序。ID 稳定且唯一；disabled 可省略；回调可同步或异步。空数组清除，卸载自动注销。Host 布局与转发点击，回调留在作者 frame，过期点击失效。

## 展示组件与消息扩展

| 入口 | 行为 |
| --- | --- |
| `<SR.WorldStory showState={false} />` | 官方阅读器拥有自己的查询页、滚动位置、消息替换和实时交接。showState 默认 true。 |
| `<SR.ActionSuggestions />` | 点击后填入草稿。无建议时不显示内容，外层留白由作者随 items 一起条件挂载。 |
| `<SR.Content content={text} mode="prose" />` | 全环境静态 Markdown/HTML 渲染。默认 prose 使用正文清洗规则，document 使用允许文档级样式的规则。 |

消息规则挂载的组件接收 `MessageComponentProps`，包括 match、groups、namedGroups、message（id、role）和 runId。groups[0] 为第一个捕获组。默认导出组件的 srDisplay 为 inline 或 block，默认 block。只承诺文档列出的阅读主题变量、输入区避让和阅读区留白，官方组件内部 DOM 与动画属于实现细节。

## 旧卡、发布与验证

完整快照、旧状态别名、资源基址、原始记录查询、原生事件订阅、重复文档渲染器和加载动画退出新作者清单。宿主和制卡工具继续使用适合自己的内部接口及包子路径。作者类型、环境注入表与制卡检查共同验证同一清单，包括经共享组件间接挂载的情况。

先盘点已有卡片及分发状态，再选择按可识别版本加载旧适配器或一次迁移已知作品。仅修改内置 ZIP 不会更新已导入副本；不得直接覆盖用户修改的卡或将旧别名永久加入新作者入口。缺少可靠版本标识时先解决识别问题，再启用破坏性切换。具体回归样例与验证命令列于[任务清单](作者SDK重构任务.md)。

## 预计变更文件树

下列为计划范围。`新增` 和 `修改` 指未来实现；退出作者导出的源码可继续供宿主使用，本方案无计划物理删除文件。花括号中的名称代表同目录下分别存在的文件。

```text
SillyRealms/
├── AGENTS.md                                      修改 · 作者边界、运行契约和详情读写
├── packages/
│   ├── sr-sdk/src/
│   │   ├── author-contract.ts                     新增 · 作者字段、环境及运行时导出清单
│   │   ├── {stage-contract,state-contract}.ts      修改 · 桥接投影、命令和逐项回执
│   │   ├── {asset-context,world-state}.tsx         修改 · useSRAsset、统一状态入口与内容展示
│   │   └── stage/
│   │       ├── {index,context}.tsx                 修改 · 根导出、订阅选择与查询生命周期
│   │       ├── runtime.ts                         修改 · 活动轮次、游标查询和失效通知
│   │       └── {world-story,action-suggestions,state-panel,document}.tsx
│   │                                              修改 · 官方视图与内容模式
│   └── sr-ui-compiler/src/modules.ts               修改 · 按实际挂载环境检查作者导入
├── apps/web/
│   ├── src/
│   │   ├── {frame,world-component-frame}.tsx       修改 · 两端注入作者清单，绑定上下文
│   │   ├── stage-frame-protocol.ts                 修改 · 传递投影、失效通知与回执
│   │   ├── stage-host/{StageHost.tsx,commands.ts}  修改 · 路由受限命令、解除监听
│   │   └── features/
│   │       ├── sessions/{workspace.ts,SessionPage.tsx}  修改 · 会话状态与持久化通知
│   │       ├── history/controller.ts              修改 · 分页查询适配与展示投影
│   │       ├── state/index.ts                     修改 · 有效状态与写入结果协调
│   │       └── worlds/{WorldComponentView.tsx,world-component-protocol.ts,WorldDetailPage.tsx}
│   │                                              修改 · 详情 global 读写和宿主资源入口
│   └── tests/{stage-frame,session-workspace,history,state,action-suggestions,worlds}.test.mjs
│                                                  修改 · 订阅、竞态、状态与环境边界
├── apps/server/src/
│   ├── modules/state/{patch,service}.ts            修改 · 区分实际修改、相同值和缺失目标
│   ├── usecases/{set-state,set-state.test}.ts      修改 · 事务内逐项回执与锁语义
│   └── routes/{state.ts,sessions-state.test.ts}    修改 · HTTP 回执兼容与验证
├── scripts/{world-card.mts,world-card.test.mts}    修改 · 挂载环境与旧卡检查
├── examples/
│   ├── responsive-state-ui.tsx                    修改 · 响应式状态示例
│   └── worlds/fog-harbor/components/{HarborStage,Introduction,HarborScene}.tsx
│                                                  修改 · 舞台、介绍和消息组件样例
├── initial-data/worlds/小饭馆.zip                  修改 · 从迁移后的作品源码重新打包
├── docs/
│   ├── sdk/{README,session,state,components,tooling}.md   修改 · 正式作者手册
│   ├── design/world-components.md                 修改 · 挂载环境与权限契约
│   ├── runtime/{web-runtime,state-v2}.md           修改 · 运行时与状态回执
│   └── creator/{presentation,state-and-rules,troubleshooting}.md
│                                                  修改 · 创作示例与排错
└── skills/sr-world-author/SKILL.md                修改 · 创作入口与验证指引
```
