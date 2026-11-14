# 故事舞台与新版 WorldStory：首期实施任务表

> 日期：2026-11-14。状态：T1–T5 实现完成，T6 本期必要工程验证与文档收尾完成；最终构建、开发/生产会话及世界/导航/预设回归通过。提交前白名单核对通过，提交推送待执行，用户视觉/真机及旧入口覆盖限制保持明确。
> 设计依据：[阅读界面设计](sr-story-stage-worldstory-design.md)。
> 工程依据：[可行性评估及实施方案](sr-story-stage-worldstory-implementation-v1.md)。
> 首期交付：官方 SDK 阅读界面 + Host 输入精简 + Studio 隔离预览。真实 Server 会话接入为后续独立阶段。

## 0. 评估阶段已完成的执行准备

- [x] 核对当前设计稿、Studio 规范、SDK/Host/编辑器源码与既有测试。
- [x] 确认 Studio 世界详情已只读接入真实 API，当前会话仍为本地 fixture。
- [x] 确认官方 WorldStory 的历史、流式、消息渲染与状态底座可以复用。
- [x] 确认 Web 实际快捷键与 Studio 一致：Enter 换行，Cmd/Ctrl+Enter 发送；类型块 Enter 跳出块。
- [x] 确认只移除输入快捷按钮，保留输入格式、历史、解析、序列化和消息渲染。
- [x] 通过 Studio typecheck、Web typecheck；四个 SDK/故事运行测试文件共 12 项通过。
- [x] 保留工作区并发更新的设计稿与原有 16 项 plan 删除。
- [x] 保存独立的工程方案、文件边界、分期与验收标准。

本节是产品改造前的评估基线，不作为新版界面完成证据。后续实施已获用户明确授权，代码和本轮验证状态如下；全程未调用真实 Provider。

## 1. 顺序与依赖

| 任务 | 内容 | 依赖 | 状态 |
| --- | --- | --- | --- |
| T1 | 官方组件语义与独立样式交付 | 准备完成 | 实现完成，最终构建通过 |
| T2 | 状态面板、容器响应式和阅读位置 | T1 | 实现及开发/生产会话回归完成 |
| T3 | Host 输入区精简并保留编辑器语义 | 准备完成；视觉对齐T1 | 实现及编辑器回归完成 |
| T4 | 真实 SDK 的最小隔离预览 | T1；整体验证需T2 | 实现及开发/生产会话回归完成 |
| T5 | Studio 平台衔接与两类预览样例 | T2、T3、T4 | 实现及开发/生产会话回归完成 |
| T6 | 交互/视觉/兼容验收与文档收尾 | T1–T5 | 本期必要验证与文档完成；提交推送待执行 |

实现清单的勾选表示代码或对应开发检查已完成，不等于全部退出条件通过。生产复验、已知失败及未测平台单独记录；未通过最终退出条件的任务仍为进行中。第 7 节及实施方案第 11 节保存实际证据。

## 2. T1：官方组件语义与样式交付

### 文件范围

- packages/sr-sdk/src/world-story.tsx
- packages/sr-sdk/src/world-story.css（新增）
- packages/sr-sdk/package.json
- apps/web/src/frame.tsx、frame.css
- 必要的现有 SDK 消费者测试

### 工作

- [x] 用同一阅读轴、来源文字“我 / 故事”、段落和留白替换官方消息气泡结构。
- [x] 保留 MessageContent、RunFeedback、showState、同Run合并、稳定消息ID和Portal。
- [x] 新建SDK局部CSS入口；根exports继续兼容，不增新作者消息/状态API。
- [x] 为官方组件提供亮暗默认语义变量，保留现有字号变量及通知。
- [x] 旧Web显式消费新样式，清理与官方消息/状态区域冲突的规则；不重做Web平台布局。
- [x] 查看真实官方组件的首轮渲染，确认文字尺度、长内容和来源层级，再进入后续微调。

### 退出条件

无气泡、无玩家正文底色或边框，正文可选择，长内容无整页横向溢出；共享组件能在现有Web frame中运行，原有消息能力没有被替换为静态HTML。根包导出与CSS子路径均能构建。

## 3. T2：响应式状态面板与阅读锚点

### 文件范围

world-story.tsx、world-story.css、story-scroll.ts（只在确有需要时调整）；对应scroll和浏览器用例。

### 工作

- [x] 以组件实际宽度判断并排/覆盖；首轮采用960px门槛，并在真实布局中检查阅读宽度。
- [x] 保持showState默认true；false时无入口/面板/遮罩/占位。
- [x] 实现并排开合偏好、转窄自动关闭覆盖层、回宽恢复并排偏好的规则。
- [x] 覆盖层采用iframe内原生dialog，处理背景不可交互、Tab、Escape、遮罩、关闭焦点和卸载清理。
- [x] 复用已有锚点工具，覆盖状态面板、容器/侧栏宽度、输入高度和异步图片变化；保留初次底部、5 Run手动分页、上翻不追随。
- [x] 将“回到最新”绑定阅读区域，Reduced Motion下不使用JS smooth。
- [x] 保持所有Portal和历史组件身份，验证不会出现ResizeObserver/scroll反馈循环。

### 退出条件

通过实施方案A3–A7、A9。尤其验证“窗口很宽但作者把组件放在窄列”“侧栏动画”“图片在当前阅读位置上方加载”这三类普通视口测试容易漏掉的场景。

## 4. T3：Host输入区精简

### 文件范围

- apps/web/src/features/sessions/composer/RoleplayComposer.tsx
- apps/web/src/features/sessions/composer/roleplay-composer.css
- Host中必要的输入局部样式
- apps/web/test/composer/test.tsx、block-composer.test.ts
- 必要的host-roleplay/runtime-v2浏览器fixture

### 工作

- [x] 移除“话语 / 叙事指令”快捷栏及仅供这两个按钮的UI事件代码。
- [x] 保留现有Lexical、节点、HistoryPlugin、输入法、粘贴、KEY_ENTER/BACKSPACE、序列化、100000字符限制和尾部空行清理。
- [x] 不改sr_instruction语法、手工输入权限、历史内容或服务端Prompt；不额外规范化/删改用户文本。
- [x] 以低对比表面、清楚聚焦边界、多行限高和内部滚动完成输入外观；保留发送/停止、展开/收起和已有草稿撤销。
- [x] 将依赖点击旧按钮的测试调整为“入口已不存在”验收；其余类型块、外部格式草稿、输入和序列化测试用既有合法草稿建立场景，不删除行为覆盖。
- [x] 验证Enter换行、Cmd/Ctrl+Enter发送、类型块Enter退出和组合输入不误发送。
- [x] 分别验证普通段落手工输入的转义路径与外部格式草稿解析路径；不为取消按钮改变两者语义。
- [x] 保持生成中可编辑下一份草稿、发送接受后的revision保护和失败保留草稿。
- [x] 同步host-roleplay用例的typeBlock按钮依赖、composer/run.mjs的toolbar存在断言和完成用例数；不让runner提前结束或无限等待。

### 退出条件

A16通过；取消按钮后输入行为与既有实现一致。不能通过换成普通textarea、移除格式支持、保留不可见快捷按钮或删掉失败测试完成任务。

## 5. T4：真实SDK的最小隔离预览

### 文件范围

- apps/studio/src/features/sessions/preview/（新增）
- apps/studio/preview-frame.html（新增）
- apps/studio/vite.config.ts
- apps/studio/src/features/sessions/preview/fixtures.ts；原列表 fixtures/sessions.ts 保留
- apps/studio/package.json、pnpm-lock.yaml 中的 roleplay 工作区依赖

### 工作

- [x] 建立独立frame入口、构建入口和最小根样式，显式导入官方WorldStory CSS。
- [x] 使用真实SessionRuntime、StateRuntime与内部Provider，通过现有仓库私有源码路径导入，不复制Runtime或扩大公开SDK导出。
- [x] 用结构化fixture提供history/state.read/send与预定义message.match结果；状态和Run事件遵守现有契约。
- [x] 模拟发送/停止仅运行确定性脚本；明确不支持的preview state.write，不伪造Server状态校验。
- [x] 加入受控作者式组合样例，使用SDK Hook和showState=false；不执行导入世界卡的任意ui.source。
- [x] 实现source+nonce握手、MessageChannel方法allowlist、体积限制和端口/计时器清理。
- [x] 开发环境校验opaque-origin sandbox、CSP、资源路径/CORS和模块加载；不开放同源权限或frame直连Server。
- [x] 最终构建产物的完整会话复验：测试改为真实 Home 键并等待顶部与两帧后，SDK helper、全部响应式与短视口完整通过；未因此修改 SDK 产品代码。
- [x] 用预定义匹配验证真实渲染/Portal，将正则Worker执行能力交给现有测试，不另写一套正则引擎。

### 退出条件

官方与作者式组合都通过真实SDK运行；message/state/Portal有可重复样本。开发和构建入口可加载，预览与真实数据完全分离，旧样例的异步消息不会进入新样例。

## 6. T5：Studio平台衔接

### 文件范围

- apps/studio/src/features/sessions/Sessions.tsx、Sessions.module.css
- 预览Host及fixture
- 必要的Studio局部语义变量
- apps/studio/tests/visual/sessions.mjs

### 工作

- [x] 平台提供高度明确的舞台槽位，去掉原样板外层正文滚动与硬编码消息数组。
- [x] 默认与不同风格样例保持既有路由/快捷入口，通过隔离frame渲染。
- [x] 复用当前Host编辑器模块，用Studio局部样式适配；不复制文本处理或导入旧Web整套样式。明确构建依赖与每个文档/JS realm内React/ReactDOM去重；Host和隔离iframe各自保有runtime。
- [x] 接通单一平台草稿、预览发送/停止、建议填入/撤销，保留按样例切换的草稿。
- [x] 通过白名单同步主题和字号；既有正式字号存储保持不变，preview不新增持久化策略。
- [x] 上下文、运行状态和发送结果保留“演示/示意”标识。
- [x] 保持手机详情无底栏和现有返回入口；验证输入多行、收起、可用视口和安全区域。
- [x] 在SDK中保留反馈，不让Studio叠加第二套状态面板或渲染器。

### 退出条件

A1、A2、A10–A13、A15通过，平台和iframe职责清晰。用户能在Studio中操作真实官方组件，但任何文案、测试或交付说明都不把它记为真实会话业务接入。

## 7. T6：验收与收尾

### 最小验证集

- [x] 最终 Studio/Web `build` 均退出 0，包含各自 `tsc --noEmit`；Web 有 >500KB chunk 的非阻断提醒，Studio 无此提醒。
- [x] 实施后的 story-history、story-scroll、sdk-session-runtime、sdk-state-runtime：4 文件 12 测试；block-composer：8 测试通过。
- [x] `node apps/web/test/world-document/run.mjs`：实施后全部通过，保留消息净化、规则和 Portal。
- [x] `pnpm test:browser` 在最后阅读意图修复前通过；修复后 `SR_BROWSER_ONLY=worldstory-font node apps/web/test/composer/run.mjs` 红→绿，8 测试通过；不宣称最终代码全套重跑。
- [x] 最新开发 sessions-only 完整通过 SDK helper、最终 Tab/Shift+Tab、平台交互和响应式，无 stderr；执行记录见下表。
- [x] 现行 world-api（5 视口）与 mobile-nav 生产预览回归通过；它们使用受控 HTTP fixture，不能称为真实 Server 会话集成通过。
- [x] presets-only 最终生产回归退出 0、stderr 空：保留原焦点断言，等待 trigger 的 aria-expanded=false 与 rAF 恢复，最多 2000ms；菜单焦点、草稿/保存/撤销、Prompt 焦点锁、键盘/指针拖拽、创建/删除、五视口及 Reduced Motion 均通过。
- [x] 构建产物上的 sessions-only 完整退出 0：SDK helper 的锚点容差收紧为 2px，全部响应式和 390×280 短视口通过。
- [x] 开发回归包含 1536/1280/768/390/375/320px、两类样例、主题和宽屏窄列；390×280 短视口通过。人工已检查官方 1536/390、组合浅色 1536、宽屏窄列 dialog 及短视口截图，未见遮挡/溢出，不等于用户视觉批准。
- [x] 开发 helper 覆盖失败、停止、部分状态、建议失败/失效、历史失败、根错误、重复/重叠增量及 snapshot/gap 恢复。
- [x] 明确真 Safari/Firefox、真实软键盘和真实 Server 会话未测；不把桌面模拟或本地事件当作真实证据。
- [x] 全范围 `git diff --check` 与 story-preview/presets 的 `node --check` 退出 0；依赖、公开契约与用户现有变更已复查。36 个本次现存变更文件与预提交白名单完全一致，无额外文件或预先暂存项；16 项既有 plan 删除保持未暂存。

### 实际证据与覆盖限制

| 验证 | 结果 |
| --- | --- |
| 最新开发 `STUDIO_SESSIONS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual` | `session-64dfb0d6637435c847559d75` 退出 0，无 stderr，含最终 Tab/Shift+Tab 与 390×280 |
| `pnpm --filter @sillyrealms/studio build`、`pnpm --filter @sillyrealms/web build` | 最终代码均退出 0，包含类型检查 |
| `pnpm --filter @sillyrealms/studio test:visual:world-api`、`test:visual:mobile-nav` | 4174 独立生产预览通过；运行普通模式，不使用 `VITE_STUDIO_MOCK_DATA=1` |
| `STUDIO_PRESETS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual` | `session-4f02b02358d37d76ed9158f4` 最终生产回归退出 0、stderr 空；完整预设交互、1536/1280/768/390/375 及 Reduced Motion 通过 |
| 4174 构建产物 sessions-only | 首轮测试滚动方式已修正，SDK 产品代码未因此改变；`session-8473f3ebee0caf26c40b8891` 完整退出 0，含 SDK helper 的 2px 锚点与全部响应式/短视口 |

旧完整 `test:visual` 在 `capture.mjs:437` 的固定 8 卡断言失败；当前 mock 有 20 张，普通模式卡数由 API 决定。旧段还依赖已废弃的世界会话跳转和手机抽屉，不能仅修改数量或改产品迎合旧测试。现行 world-api/mobile-nav 加 presets-only 是必要回归，不等价替代旧段的动画中间帧、A/B 滚动边界、20 角色锚点及完整几何/reduced-motion 覆盖；旧完整套件未通过。

会话锚点回归容差已从 3px 收紧到实施矩阵 A3 的 2px，生产 SDK helper 的全部锚点场景通过；结论限于实际用例范围。完整阶段命令、此前通过记录和未测边界见[实施方案第 11 节](sr-story-stage-worldstory-implementation-v1.md)。

### 文档与交付

- [x] 已同步 Studio README/AGENTS 与技术/设计文档，修正旧快捷键说法和静态样板边界，披露旧完整测试入口限制。
- [x] 已在设计记录补充实际实现与截图范围，保留用户原设计实质；未把截图升级为用户认可基准。
- [x] 区分“SDK+Host 展示与本地预览的本期必要工程验证完成”和“真实 Studio 会话链路尚未接入”；用户视觉、真机与旧完整入口覆盖限制未被测试通过取消。
- [x] 任务表按实际阶段记录证据；存在失败时继续定位、修复和定向复验，不预报成功。
- [ ] 用户后续已明确授权“执行方案，完成后提交推送代码”；预提交白名单已核对，下一步按授权提交并推送本次功能及三份 WorldStory plan。实际推送后以第二个纯文档提交补充真实 commit/hash 与闭环记录，不提前标记成功。既有 16 项 plan 删除不纳入提交；不调用真实或付费 Provider。

## 8. 后续阶段入口

真实Studio会话接入须建立独立任务，涵盖真实列表/ID导航、可复用Host、SSE与恢复、send/stop、Usage和设置、世界详情创建/进入入口及完整链路验收。首期不提前修改世界详情只读测试，不承诺预设/模型样板已支持真实保存。
