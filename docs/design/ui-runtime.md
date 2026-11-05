# Session UI Runtime：可替换会话视图与自定义 HTML

> **状态**：2026-11-05 讨论草案，尚未实现。这里仅设计会话展示与玩家交互，不开放 UI 对 Prompt、Preset、AgentContext、世界书激活、模型工具或状态结算的干预。会话/Run/世界线及状态的权威规则分别见 [Session](session.md)、[State](state.md)、[领域接口](domain-interfaces.md)。

## 1. 定位和原则

会话页面是可替换的 View，不等于聊天消息列表。聊天、聊天+状态栏是 SR 内置视图；世界卡也可提供完整自定义 HTML/CSS/JavaScript 页面，支持互动小说、图文叙事、地图、背包、RPG 面板与交互选项。所有视图消费同一 Session，切换视图不生成新的历史、状态或世界线。

必须保持三个职责边界：

- **Session / AgentRuntime / StateService 是权威业务端**：决定本轮输入、生成、分支、持久化、状态结算及权限校验。
- **SessionViewHost 是受信任的 UI 宿主**：加载视图、提供稳定数据与事件桥、转发经过允许列表校验的玩家命令、处理失败/恢复。
- **SessionView 是可替换的呈现层**：可拥有自己的页面布局、局部 UI 状态、动画和输入方式，但不能直接写持久状态或伪造原始 Entry，也不能执行或改写 Prompt。

「SR API」在本设计中专指 **Session UI Bridge API**；它与 [script-runtime.md](script-runtime.md) 中运行于 EJS/Prompt 阶段的 getState/setState 不是同一 API、进程或权限集。UI 只读权威状态，不能调用脚本环境的 setState。

## 2. 组件边界

~~~text
SR App Shell（导航、世界线、用户设置、错误恢复）
  └── SessionViewHost（当前 session + view 的受信任控制器）
        ├── builtin/chat          → SR UI SDK
        ├── builtin/chat-state    → SR UI SDK
        └── custom/html           → 沙箱 iframe + Message Bridge → SR UI SDK
                       │
           SessionView API / 事件分发器
                       │
          SessionService / StateService / AgentRuntime
                       │
             Entries / State / Pi SSE
~~~

- 首期 H5 Web + Server。内置视图可使用 React 实现；自定义页面不要求 React/Vue，允许作者打包静态 HTML/CSS/JS。
- UI Host 在同一个 Session 中统一建立实时连接；**自定义页不自行直连后端的身份认证 API 或 Pi SSE**。自定义页只能通过 Bridge 获取必要数据和提交命令。
- App Shell 仍掌管退出/返回、会话切换、权限提示、加载失败时退回内置聊天、基础诊断和用户主动的视图切换。作者页面可以完全自定义会话内容区域，但不能覆盖宿主的安全与恢复控制。
- UI 局部状态（选中标签、面板展开、动画进度）由页面维护，不能被误认为持久世界状态。

## 3. 视图声明和世界卡资源

建议在世界卡 data 下新增可选声明。它仅是**视图选择及资源入口**，不承载运行态状态：

~~~json
{
  "ui": {
    "default_view": "custom",
    "custom": {
      "entry": "ui/index.html",
      "api_version": "1"
    }
  }
}
~~~

- default_view 可为 builtin/chat、builtin/chat-state、custom；缺省使用 builtin/chat。custom 配置必须有打包入口、存在的本地资源与可解析的 API 版本。具体字段名以定稿 Schema 为准。
- 世界卡 assets / 资源包携带 ui/index.html、JS、CSS、图片与字体等静态资产。导入时做路径归一化、防目录穿越、类型/体积/数量校验；不凭远程 URL 自动拉取依赖或执行代码。
- 自定义视图随世界卡当前数据更新，**没有会话级 UI 快照**；更新后可能影响已有会话的显示，必须保留用户可切回内置聊天的恢复通道。
- 用户应能临时覆盖作者默认视图，避免坏页面锁死会话。首版可不持久化用户覆盖选择，不增加表。
- 无自定义页、资源丢失、不兼容 API 或加载异常时退回 builtin/chat，Session 和历史不受影响。

## 4. Session UI Bridge API v1

SDK 以宿主注入的受控通信桥为实现基础，面向自定义页暴露只读查询、事件订阅、用户动作三类能力。以下是**概念性 TypeScript 契约**，不等于直接开放后端领域 Service 或网络 URL。

~~~ts
type SessionViewAPI = {
  getSession(): Promise<SessionViewSnapshot>;
  getMessages(args?: { beforeRunCursor?: string; limit?: number }):
    Promise<{ runs: NarrativeRun[]; nextCursor?: string; hasMore: boolean; tipEntryId: string }>;
  getState(): Promise<{
    global: unknown; session: unknown; message: unknown;
    tipEntryId: string; revision: string;
  }>;
  getWorldlines(): Promise<WorldlineSummary>;
  subscribe(handler: (event: SessionUIEvent) => void): () => void;
  dispatch(command: SessionUICommand): Promise<{ accepted: boolean; operationId?: string }>;
};
~~~

**查询边界**

- getSession 返回当前会话必要的公开 ID、角色、世界卡展示信息、当前 tip、运行态，不包含 Provider Key、内部 Prompt 或原始 Pi 工具消息。
- getMessages 必须使用现有的 **当前 tip → parent_id 祖先链 → Run 分组 → NarrativeProjection**，分页单位是 Run，UI 不读取模型 Token 压缩后的历史；仅返回 user/assistant 的叙事与必要 Entry/Run 引用、时间。无意义的纯 ToolCall 不在普通 UI 显示。
- getState 返回 Global（世界卡共享）、Session（分支间共享）、Message（只沿当前分支父链）的**最新有效完整状态**，与模型的状态根加载筛选无关。当前 Schema 不兼容须以诊断呈现，不能默默生成默认值。**任何发给前端页面的状态都对玩家可检查，不具有保密性**；若未来需要「玩家不可见的 NPC 秘密状态」，须另行设计服务端状态投影/可见性协议，不可假装 iframe 能保密。
- getWorldlines 走既有摘要投影，不让自定义 UI 枚举所有原始数据库记录。资源访问另经宿主映射为只读资源 URL/受控资产接口。
- 只读不是「读取所有配置」。服务端需按 Session + 资源权限做白名单字段投影、数据大小限制；不返回 API Key、内部调试数据或 Prompt 脚本上下文。

**命令边界（v1 白名单）**

~~~ts
type SessionUICommand =
  | { type: "submitInput"; text: string; requestId: string }
  | { type: "stop"; requestId: string }
  | { type: "regenerateLastAssistant"; requestId: string }
  | { type: "continueLastAssistant"; requestId: string }
  | { type: "forkFromUserMessage"; userEntryId: string; newText: string; requestId: string }
  | { type: "switchWorldline"; leafEntryId: string; requestId: string };
~~~

- 所有命令都进入现有 SessionService / AgentRuntime，重新执行上下文、权限、分支位置、互斥运行、输入长度和状态兼容性校验；不能通过自定义 HTML 绕过业务规则。
- 自定义选项可映射为玩家提交文本，或仅做 UI 内部切换；UI v1 **没有**通用游戏动作执行器，也不开放 arbitrary tool call / setState / appendRawEntry / changePrompt。后续如果确需结构化选项，应作为明确的独立业务 Action 协议设计。
- dispatch 返回 accepted 仅代表**命令已受理**，不是运行成功；最后结果由事件通知。requestId 用于去重/回执关联；同会话同一时间只允许一个生成操作。
- 玩家在任何自定义页发出的真实提交都须符合产品的用户操作语义，不能在用户不知情时自动循环发起模型调用。对高影响/消耗 Token 的行为保留宿主侧控制与必要确认。

## 5. 实时事件、重连与状态一致性

Host 消费 AgentRuntime SSE，将必要信息转换为与 Pi 无关的 UI 事件再投递给视图。事件仅为画面更新的通知，**查询结果和已提交数据库数据才是权威快照**。

~~~ts
type SessionUIEvent =
  | { type: "run.started"; runId: string; operationId: string }
  | { type: "narrative.delta"; runId: string; entryId?: string; text: string }
  | { type: "entry.committed"; runId: string; entryId: string }
  | { type: "state.committed"; tipEntryId: string; revision: string }
  | { type: "session.tipChanged"; tipEntryId: string; reason: "append" | "switch" | "fork" }
  | { type: "run.ended"; runId: string; outcome: "success" | "failed" | "cancelled" };
~~~

- delta 是**暂态展示**，不可当作已提交 Entry 或已结算 State；完整 Entry 存储后以 entry.committed + 重新查询/同步进行对账。
- **state.committed 只在完整 Run 成功结算并完成跨 scope 事务提交后发送**。失败/停止时不广播候选工作状态；若此前已有持久化 Entry，依现有规则恢复其投影。
- 每次切换世界线，UI 清空旧分支分页游标、停止显示旧分支临时流，重新读取该 tip 的消息与 Message State。Global / Session 可由其他会话改变，订阅对应提交/失效通知后主动刷新完整状态。
- 每次重载或断线恢复先获取包含 tip/revision 的快照，再衔接增量事件；Host 须有单调序号或等价同步机制，避免「先查询再订阅」漏事件。断线/序号缺口/版本不一致时重新取快照，不假设 delta 一定完整且恰好一次。
- 单次模型输出可能跨多条 Assistant/ToolResult Entry 和同一个 Run；UI 流不能假定「一轮恰好一条 Assistant」。不要把模型的思维、ToolCall、ToolResult 或内联 StateUpdate 当成普通叙事 delta。**流式 narrative.delta 必须由增量叙事投影器产生**，对未闭合的控制标签和跨 chunk 边界做缓冲，不能直接将原始 Pi 文本 delta 透传、事后再靠最终投影删除。
- 事件类型及 payload 后续定稿；SDK 版本与具体 Pi 事件解耦。

## 6. 自定义 HTML 运行与安全

**自定义世界卡页面属于不可信代码**。不能把 HTML 注入 React DOM、应用主页面、同源动态 script，也不能只靠 Shadow DOM 或普通 DOM 清洗实现脚本隔离。

- 使用隔离的 iframe / 独立执行源，默认脚本仅可访问自身 DOM。最小必要 sandbox 权限；禁父页面 DOM、Cookie/LocalStorage 身份凭据、宿主 JS 全局、top navigation、弹窗、下载、剪贴板、任意网络和直连后端。
- 以严格 CSP、资源白名单、内容寻址或隔离的资产源交付已打包内容。注意：同源 iframe 同时开启 allow-scripts 与 allow-same-origin 可能失去隔离；真正实现方式要经浏览器与未来 WebView PoC 验证。
- 通过 postMessage / MessageChannel 实现带握手、绑定 iframe 实例和当前 session 的受限 RPC；验证消息来源（包括 source、适用时 origin）、协议版本、nonce/capability、类型/大小、每秒调用次数和超时；不可把传入消息当代码执行。
- 若 frame 采用 opaque origin，其 origin 可能为 null，不能把 null 当作可信来源。可采用 source + 随机握手令牌 + 专属 MessagePort，限制唯一 frame 生命周期；更严格方案是独立隔离 origin。消息端点不向其他 frame 扩散令牌。
- 所有命令在宿主/服务端二次校验；只向页面下发最小必要数据。禁止 UI 读取 Provider 密钥、底层文件、外部网络或直接操作数据库。若未来需外链、音频、摄像头、剪贴板，单独建立声明和用户授权机制。
- 包含自定义 JS 的世界卡在导入/首次启用时明确提示其运行风险；提供禁用和回退入口。无 JS 的静态展示不因此被拒绝。
- 浏览器不能仅凭 iframe 发出的 postMessage 证明它来自真实玩家点击。恶意作者页面可能在加载时自动 dispatch 并产生 Token 消耗；MVP 至少需要首次启用明确授权、会话级运行互斥/速率与消费上限、宿主可见的运行中/停止入口；需要强制每次人机确认时，应使用宿主控制，而不是相信作者 JS 自报 userGesture。

## 7. 内置模板与作者体验

- builtin/chat：叙事消息、输入框、历史加载、流式输出、最后回复重生/续写、世界线入口。
- builtin/chat-state：共用聊天能力，加可折叠状态栏；状态栏展示三作用域的当前值及可读的变更 reason。状态为可选，未定义状态时不强制显示空面板。
- custom：作者以一份前端资源包控制会话内容视图，可使用 HTML/CSS/JS 或自行打包任何前端框架；不要求学习 SR 内部 React 组件。
- 首版提供 SDK 类型、最小 HTML 示例、事件/命令示例、状态变化与世界线切换模拟器，以及「预览」/「返回默认聊天」入口。预览是隔离页面与模拟数据，不允许误向真实 Session 发送命令。
- 资源路径、主题、视口、安全区域、手机/桌面自适应作为 SDK/宿主环境能力暴露，不依赖隐式 DOM 操作。

## 8. MVP 与验收

**MVP**：内置 chat / chat-state；世界卡可选一个自定义 entry HTML；受限读接口（Session、当前分支 Run 叙事、三作用域 State、世界线）；Run 流式事件；submitInput/stop/重生/续写/分叉/切换；沙箱和回退能力。保持六业务表不变，不额外引入 runs 表、世界卡版本或会话快照。

**暂不做**：UI 任意 Prompt 插入/编辑、原始 Pi ToolCall 访问、UI 直接写 State、跨世界访问、作者自定义后端/网络插件、JS 调用本地文件系统、UI 多窗口、通用 RPG 规则引擎、远端在线 UI 依赖、作者接口对外授权市场。

验收至少覆盖：

1. 同一 Session 在三种视图切换，当前 tip、State 与 Raw Entry 不变；页面坏掉仍可恢复聊天。
2. 含多个 Assistant 与 ToolResult 的单 Run 正确呈现，按 Run 分页且跨分支不串读；实时 delta 与最终已提交叙事一致。
3. 切换世界线立即丢弃旧游标、旧临时流，Message State 从新父链恢复，Global/Session 仍按共享语义展示。
4. 停止/失败/状态校验不通过时，视图不能出现「已提交」的候选 State；正常成功仅一次权威 state.committed。
5. 恶意 HTML/JS 不能访问宿主 DOM、Cookie、Key、Raw Entries、任意网络或伪造状态写入；非法桥消息及高频命令被拒绝。
6. 世界卡 UI 资源不存在、API 版本不兼容、渲染异常时默认聊天可用；不影响已持久化内容。

## 9. 待最终确认的设计点

- 自定义视图是否需要支持 **多页面路由**（例如 RPG 战斗页、地图页），还是入口 HTML 负责页面内切换。建议 MVP 仅一个入口，内部自由路由。
- 世界卡能否声明多个 UI 皮肤并给玩家选择。建议 MVP 一份作者默认自定义视图 + 两份内置模板。
- UI 作者如何配置访问宿主设备/网络。建议 MVP 全部禁止，不预先承诺权限系统。
- 是否需要将「选项点击」升级为稳定的结构化玩家 Action 领域协议。建议先用明确的玩家文本输入完成 PoC；未来有实际 RPG 规则需求再设计。
