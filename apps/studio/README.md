# SillyRealms Studio

新一代 SR 平台 UI 工程。世界卡列表与详情默认只读连接 SR Server；预设仍使用本地 fixture 与视图状态。会话详情已使用真实 SDK 的隔离本地预览，历史、事件和状态来自内存 fixture，尚未接入真实 Server 会话或 Provider。

## 运行

- `pnpm install`（仓库根目录）
- `pnpm --filter @sillyrealms/studio dev`
- `pnpm dev:studio:mock`：使用 20 张模拟世界卡、20 个会话和 10 个预设；模拟世界不会写入 Server。需先停止占用 5174 端口的 Studio 开发服务。
- 打开 http://localhost:5174/worlds
- `pnpm --filter @sillyrealms/studio typecheck`
- `pnpm --filter @sillyrealms/studio build`

## 原则

- 两张最新聊天原型：展开版为视觉基准；收起版为交互结构参考。
- 先还原真实 UI 再形成规范；现有 Web 的旧 CSS / tokens 不导入 Studio。
- 平台页面共用 AppShell，统一使用语义色彩 Token；隔离故事舞台由 SDK 或作者样例负责自身布局。
- 首页封面来自仓库已有首页截图的临时提取图，正式还原应替换成 8 张独立封面原图。
- /lab/colors 是可切换色调的设计实验区；明色为辅助试验，当前主基准是暗色。
- 设计 Demo 不提供业务保存、真实导入、账号或模型连接。


## 会话与故事舞台预览

- 路由：`/sessions`、`/sessions/:sessionId`；`changan` 使用官方 `SR.WorldStory`，`neon` 在作者组合样例中使用 `SR.WorldStory showState={false}` 和公开状态 Hook。两者都运行在独立 `preview-frame.html`，不是平台页面中仿制的消息列表。
- Host 拥有标题、上下文比例示意、设置、输入和草稿；SDK 拥有故事阅读、历史分页、流式正文、状态面板、建议及消息组件 Portal。上下文条标明“示意”，不表示真实计费 Token。
- 本地 `PreviewTransport` 提供确定性历史、Run 事件、状态快照和消息匹配，不调用会话 API、数据库或模型。草稿、消息、模拟状态及阅读字号仅保留在当前浏览器文档内，刷新恢复样例；后续真实 Server 接入需单独完成鉴权、正式会话生命周期和权威持久化。
- 预览 iframe 保留 `sandbox="allow-scripts"` 的 opaque origin，通过来源、nonce 和 MessageChannel 建立连接；只加载仓库内受信样例，不编译或运行任意世界卡源码。样例切换/卸载关闭通道、取消定时事件；不加入 `allow-same-origin` 或暴露 Provider 凭据。

### 样式与阅读布局

iframe 入口显式导入 `@sillyrealms/sdk/world-story.css`。该公开 CSS 子路径提供限定在 `.sr-story` 内的官方阅读表面；Web iframe 与 Studio 预览共用它，Studio 不复制 SDK 样式，也不导入旧 Web 页面 CSS/tokens。Host 可传递经过限制的 `--sr-story-*` 色彩与字号变量；作者外围页面继续由作者自己控制。

官方状态栏以 **WorldStory 实际容器宽度** 为依据：`.sr-story.clientWidth >= 960` 时采用内嵌侧栏，小于 960px 时采用默认关闭的弹层；不能按整个浏览器宽度判断。即使宽屏作者页面将故事放进窄列，也应使用窄布局。`showState={false}` 同时移除官方状态入口、面板和弹层。

Host 只提供有界舞台槽位，正文由 SDK 内部阅读区滚动；输入区展开/收起、多行增长、字号调整或侧栏变化均需保留阅读锚点与底部跟随。手机使用可见视口高度，并保留键盘弹出后可操作的输入 footer。

### 输入与草稿

直接复用 `apps/web/src/features/sessions/composer/RoleplayComposer.tsx` 的 `value`、`disabled`、`onChange`、`onSubmit` 四 props 接口，使用 Studio 局部样式并保持每个文档内单一 React/ReactDOM runtime。话语/叙事指令快捷按钮已移除；Lexical、语义节点、序列化、粘贴、撤销、IME 防护和 100000 字符限制仍保留。

普通段落中手打或粘贴引号、整行 `sr_instruction` 标签仍按既有规则转义为普通内容；初值、外部 `value` 和 SDK `session.setDraft` 中的既有格式文本仍解析为语义块。保留既有解析和规范化，不承诺字节级原样发送。Enter/Shift+Enter 在普通段落中换行，语义块中 Enter 退出到旁白，Cmd/Ctrl+Enter 发送。

草稿由 Host 统一管理；SDK 填入不自动发送，已有草稿可撤销，后续编辑使该撤销失效。生成期间仍可编辑下一份草稿；发送响应仅清空未被后续修改的 revision，拒绝发送保留当前草稿。字号默认 16px、范围 13–21px，即时预览、取消恢复；本地预览不新建持久化字号键。

### 开发验收

当前回归入口如下；均支持 `STUDIO_URL` 指向独立开发或生产预览服务：

```sh
STUDIO_SESSIONS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual
STUDIO_PRESETS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual
pnpm --filter @sillyrealms/studio test:visual:world-api
pnpm --filter @sillyrealms/studio test:visual:mobile-nav
```

世界 API 与移动导航脚本通过浏览器拦截提供确定性 API fixture，必须使用非 `VITE_STUDIO_MOCK_DATA=1` 的构建；它们不证明真实 Server 会话集成。未设筛选的旧 `test:visual` 仍保留固定 8 卡、旧会话链接及移动抽屉假设，当前不能作为通过门槛；旧动画及多角色锚点覆盖尚待迁移，不能称上述入口已等价替代全部旧覆盖。

输出目录为 `apps/studio/tests/visual/output/`，截图属于开发验收证据；通过自动化不代表用户已批准视觉，也不代表 Safari/Firefox 或移动真机验证。实际执行结果见 `plan/sr-story-stage-worldstory-tasks.md`。

## 预设工作区

- 路由：`/presets`、`/presets/:presetId`。全局侧栏快捷项与工作区共享预设名称及默认项。
- 无标签；列表只有标题、单行省略描述，可新建、复制、删除、设为默认。
- 编辑名称、描述、上下文策略、输出预算、压缩提示词与温度；叙事风格和自定义节点在宽弹窗内编辑。
- 自定义节点可增删、切换消息角色、启停，并通过手柄拖动、方向键或上移/下移菜单排序。固定消息骨架按已批准的状态尾块目标展示来源说明。
- 弹窗“应用”写入当前预设草稿，页面“保存预设”更新内存快照；切换预设或 Studio 路由保留各自草稿，“放弃更改”恢复当前预设快照。
- **保存仅用于静态交互验证，不写入 SR Server 或持久存储。刷新后恢复 10 个 fixture。** 存在未保存页面草稿或未应用弹窗内容时，关闭/刷新提供浏览器提示。
- 主工作区宽度不足 780px 时切换为列表/编辑两级视图，左右滚动独立。群像长篇提供 16 个自定义节点用于长编排检查。
- `STUDIO_PRESETS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual` 包含预设操作、真实指针排序、草稿与弹窗及 5 个视口。世界页与移动导航使用上文的现行独立回归入口。

本轮新增的无标签、叙事风格/自定义节点启停仅为 Studio 产品交互；现行服务端仍是旧节点契约。正式接入时需同步领域校验、编排与接口，本工程不执行数据迁移。
