# WorldStory 运行时 v1

平台会话页负责标题、预设设置、连接提示和默认展开的输入区；输入区可收起。普通段落中 Enter/Shift+Enter 换行，Cmd/Ctrl+Enter 发送；既有话语/叙事指令块内 Enter 退出到旁白。运行时可停止生成，生成期间仍可编辑下一份草稿。输入草稿属于平台页面，作者组件的 `session.setDraft` 通过 MessageChannel 替换草稿，不会自动发送。`session.send` 与平台输入使用同一 Host 发送流程；202 表示服务端接受，不表示生成成功。

Host 输入复用 Lexical `RoleplayComposer` 的 `value`、`disabled`、`onChange`、`onSubmit` 四 props。2026-11-14 起移除话语/叙事指令快捷按钮及其专用代码，保留节点、HistoryPlugin、粘贴、序列化、IME 防护、100000 字符限制及发送时的尾空行清理。普通段落手打或粘贴引号、整行 `sr_instruction` 标签仍经既有 `escapeText` 规则转义；初值、外部 value 和 `session.setDraft` 中的既有协议文本仍解析为语义块，解析/规范化不保证字节级原样发送。发送被接受后只清理未发生后续编辑的草稿 revision；拒绝发送保留草稿，终态事件不会恢复已提交草稿。

静态文档 iframe 的根文档随内容自动增高，由外层阅读区域负责纵向滚动；文档根节点的固定高度和滚动被约束，以免形成嵌套阅读滚动条。文档仍使用原有无脚本 sandbox、CSP 和净化规则；正文内部作者显式设置的局部滚动区域不改变。

`WorldDocumentRenderer` 的 `showStyleWarning` 可选，默认显示样式过滤提示；Studio 的世界详情显式关闭提示。此选项仅控制提示文案，不改变 CSS 净化或隔离策略。

无自定义页面时，隔离 iframe 加载系统 `SR.WorldStory`；有 `ui.source` 时加载作者页面，作者可在其中组合 `SR.WorldStory`。Host 按会话缓存世界卡的静态配置、页面和消息组件编译产物，并将规则、状态声明传入 iframe；Host 不缓存状态值或消息历史。状态 Hook 使用 iframe SDK 本地快照，显式读取仍通过 Host 向 Server 请求。

系统界面通过 Run 历史及事件显示消息，状态面板按 global、session、message 展示；WorldStory 实际容器宽度达到 960px 时默认内嵌展开，小于 960px 时默认关闭并通过弹层打开。2026-11-14 起，首次查询前先订阅并缓冲事件，查询完成后按消息 ID 与 UTF-16 offset 合并重叠片段，不再丢弃已有 Run 的所有缓冲增量。缺口或重叠内容不一致时，重新读取最新历史页修复；失败显示重试入口。服务端不重放断线事件：Host 重连查询 session 和已知/活动 Run，终态用完整净正文校准，运行中通过 SDK `run.snapshot` 补齐内存正文。Server 进程退出会丢失尚未结束的正文，重启后只恢复持久记录和中断终态。

WorldStory 同一动画帧内合并增量，终态立即处理；隐藏页面有定时刷新兜底。历史 Run 与正文组件 memoize，活跃消息保留 ID；净化后的 DOM 增量协调保留稳定段落和 React Portal 插槽，不反复替换整个正文容器。当前仍解析活跃消息全文，没有引入增量 Markdown 解析器或虚拟列表。向前加载保持阅读锚点，用户上翻后不自动跟随；底部跟随同时响应图片和异步组件高度变化。旧会话的未完成历史请求不能写入新会话。


WorldStory 的历史和流式事件使用同一故事投影，已有相邻 assistant 叙事的展示合并规则仍属于显示职责。原始模型记录、可见故事与权威状态分别保存。

Host 的 Token 面板在 `usage.updated`、SSE 首次连接和重连后重新读取 `/usage`；请求与响应均使用 `no-store`。上下文输入和累计消耗显示精确整数，避免 K/M 四舍五入掩盖增长；刷新失败时保留上次统计并明确提示、提供重试，移动端收起摘要也提示失败。上下文仍指最近一次叙事调用的真实输入，分母为模型窗口，不代表下一轮估算或预设压缩额度；累计包含已结算的摘要与工具续轮调用。没有真实用量的调用不伪造计数。

2026-11-13 已实现 [SRRuntime v2](runtime-context-v2.md)：新会话默认 Direct，一次 generation 输出正文与隐藏扩展尾块；Agent 模式保留通用工具循环。状态与行动建议按冻结能力校验，状态部分有效时保存有效项并阻止建议；Direct 停止丢弃未提交状态候选。原始会话、预设、状态及 sr_instruction 内容保留，增量迁移不清历史。

WorldStory 显式订阅 run.phase，区分准备、正文生成和扩展处理；终态优先于迟到阶段。最新 completed Run 的建议可填入 Host 草稿，已有草稿提供一次撤销，后续编辑使撤销失效；新 Run 开始后旧建议禁用。运行中能力设置仅影响下一轮，Agent 模式标明不适用。准备阶段重启且尚无持久 Entry 时，恢复解除临时 busy 状态并保留草稿。API/SDK 细节见 [Runtime 契约](../data-formats/runtime-v2-contract.md)。

作者组合自己的状态栏时可使用 `<SR.WorldStory showState={false} />` 隐藏系统状态按钮和面板；省略该属性时仍显示系统状态面板。世界介绍与角色介绍都可在无脚本隔离 iframe 中展示完整 HTML 和 Markdown。

消息组件模块编译失败、缺失或局部渲染失败时，相关匹配回退原文；作者自定义页面整体编译、求值或根组件运行失败时，平台显示“世界卡数据异常”并阻止继续会话，不切换系统界面。已发往 Server 的请求不能承诺撤销。Worker 执行正则设有单规则与总时间预算，处理失败会展示原文或保留已完成的匹配；它不运行作者组件。

iframe 保留 opaque-origin sandbox、CSP、受限 import 和 MessageChannel 边界。`connect-src 'none'` 不代表完全无网络：当前 CSP 仍允许 HTTPS 图片和媒体。DOMPurify 负责 HTML 清理，不负责 CSS 白名单；系统对内联 style 另行筛选。事件处理器的异步异常和组件死循环不保证被 React 错误边界捕获。

世界详情的世界介绍、角色介绍、开局和世界书正文使用 SDK 的 `WorldDocumentRenderer` 静态文档表面。世界详情通过角色列表选择可扮演角色，在开局页切换开局并创建会话；运行配置页设置此世界的新会话默认预设与模型。初始状态检查器展示 message scope 的默认值与当前开局覆盖合并后的全部状态，不写入状态。JSON 覆盖替换整个状态项，global/session 状态不受开局覆盖。静态预览不运行会话的消息展示规则或作者组件，创建会话后的首条消息仍经过正常消息渲染流程。

静态文档在无脚本 iframe 中呈现；会话消息继续留在既有会话 iframe 中，通过共享解析和净化管线生成行内内容，以保留组件插槽和流式更新。静态与会话的 sandbox 和权限边界各自保持独立。完整 HTML 文档与 Markdown/HTML 混排均可作为字符串输入；可用 `data-sr-markdown="true"` 显式标识需要解析 Markdown 的 HTML 容器。作者 HTML、CSS 与资源受净化和 iframe CSP 的限制，不支持脚本和表单；源码及持久化消息不会因展示而改写。

## 官方阅读表面的样式与容器

宿主构建的会话 iframe 入口显式导入：

```ts
import '@sillyrealms/sdk/world-story.css';
```

该 CSS 由 SDK 的 `./world-story.css` 子路径导出，Web frame 与 Studio preview 共用；不改变作者代码的 `@sr/sdk` import 白名单。样式限定在 `.sr-story`，不会给文档根或作者外围舞台施加平台布局。Host 可传入 `--sr-story-font-size` 和受限色彩变量（如 `--sr-story-bg`、`--sr-story-text`、`--sr-story-accent`），缺省时使用 SDK 回退色。

布局判断读取 `.sr-story.clientWidth >= 960` 并观察实际容器变化，不读取浏览器视口宽度。作者将组件放在宽屏页面的窄列时仍使用状态弹层。`showState={false}` 移除官方入口、面板和弹层，作者可用公开状态 Hook 自行组合外围界面。

Host 给 iframe 和舞台提供有界高度，SDK 内部 `.sr-chat-messages` 负责正文滚动，状态内容另有自己的滚动区；正文采用来源标识加单列阅读流。状态栏切换、Host 输入区伸缩、容器尺寸和字号改变都沿用消息锚点/底部跟随恢复；作者媒体或组件异步增高继续通过既有增量渲染与尺寸观察处理。未增加虚拟列表或新的 Markdown 引擎。

## Studio 的隔离本地预览边界

Studio 会话样例运行真实 SDK、SessionRuntime、StateRuntime 及消息 Portal，但传输由本地 `PreviewTransport` 提供内存历史、确定性事件和状态快照。官方样例直接渲染 `SR.WorldStory`，作者组合样例通过 `SR.WorldStory showState={false}` 与公开 Hook/API 组合页面。它们是仓库内受信样例，不是任意世界卡源码的编译执行入口。

平台输入仍在 Host 文档中复用同一 Lexical 组件，预览只导入 SDK 官方 CSS 与自身局部样式。预览 iframe 使用 opaque-origin `sandbox="allow-scripts"`、来源/nonce 检查、受限消息和 MessageChannel；切换样例或卸载会关闭连接、取消定时事件和待处理请求。

本地发送、停止及状态事件不访问 Server、数据库或 Provider；不代表正式业务的锁、校验、幂等、持久化或恢复契约已经接入。草稿、预览消息、模拟状态与字号仅保留在当前浏览器文档内，刷新恢复样例；上下文组成明确标注示意。正式 Web 的会话、用量和字号存储策略保持原有契约，后续 Studio 真实会话接入需另行对齐 Server 权威边界。
