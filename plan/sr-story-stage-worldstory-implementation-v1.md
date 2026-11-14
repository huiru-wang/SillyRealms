# 故事舞台与新版 SR.WorldStory：可行性评估及实施方案 v1

> 更新日期：2026-11-14。评估基线：`8ffb2805a8e581cceaebe517954d3571cfe0ef46`；产品依据为同日工作区新版设计稿。
> 当前状态：T1–T5 实现完成，T6 的本期必要工程验证与文档收尾完成：最终 Studio/Web 构建、开发/生产会话及现行世界/导航/预设回归均通过。用户已明确授权完成后提交推送；预提交白名单核对通过，提交推送尚待执行，用户视觉认可及未测范围仍见第 11 节。
> 本文保留评估时的依据，并在第 11 节记录实际实施与验证状态，不覆盖 [阅读界面设计](sr-story-stage-worldstory-design.md)。逐项任务见 [实施任务表](sr-story-stage-worldstory-tasks.md)。

## 1. 评估结论与交付范围

方案可行。评估时 SDK 已具备历史分页、流式合并、状态读取、消息规则、组件插槽和阅读锚点，适合在这些能力上调整展示和补齐交互。评估识别的样式交付、Studio 隔离接入、响应式状态转换、异常矩阵与输入兼容范围已落实为本轮代码和回归场景；实际通过项与未完成项见第 11 节。

### 1.1 首期交付

**改造 SDK 中真实的官方 WorldStory，并在 Studio 的隔离预览中完成视觉和交互验收。**

1. 官方组件使用无气泡阅读布局，拥有可复用、独立加载的局部样式。
2. Studio 默认故事样板加载真实 SDK 组件；另有受控作者式组合样例验证同一公开契约。
3. 保留 Studio 平台外框、导航和弹窗，收敛 Host 输入区外观并移除“话语 / 叙事指令”快捷按钮；提供本地预览 transport 与 iframe 入口。
4. 补齐状态面板的容器响应式、焦点管理、布局变化锚点、Reduced Motion 和运行反馈。
5. 对现有 Host 编辑器做最小展示调整，保留文本处理、键盘、草稿、发送和停止；验证旧 Web 对共享 SDK/编辑器的兼容性，整体平台 UI 仍以 Studio 为设计对象。

首期的消息、发送、状态和用量均为可重复的本地预览数据。预览明确标识，不写入真实会话、不调用模型。验收标准是“真实 SDK 组件可复用、可读、可交互”，不能记为“Studio 已接入真实会话”。

### 1.2 后续真实业务接入

Studio 真实会话接入单独分期，依赖：真实会话列表/ID 导航、Host 运行生命周期、SSE、发送与停止、草稿、Usage、设置、恢复、世界详情的进入/创建入口。详见第 10 节。

首期不引入新的 Server/API/数据库协议、角色说话人协议、世界线、重生/续写、虚拟列表、可视化作者编辑器或独立 Design System 包。

## 2. 评估时基线与方案修正

以下描述评估开始时的代码，不代表实施后的当前状态；当前交付见第 11 节。

| 项目 | 评估时代码事实 | 本次处理 |
| --- | --- | --- |
| Studio 世界详情 | 已只读连接世界 API，使用 SDK WorldDocumentRenderer | 不再把“先接真实世界卡”作为本期前置条件 |
| Studio 会话 | Sessions.tsx 中两个硬编码样板；输入和新增消息仅本地内存 | 保留平台外框，以真实 SDK 替换舞台 |
| 官方组件 | SDK 导出 SR.WorldStory；样式实际位于旧 Web frame.css | 新增 SDK 样式入口并明确两个消费者的加载方式 |
| 消息数据 | ChatMessage 仅含 id、role、text | 来源只标“我 / 故事”，不从正文推测 NPC 身份 |
| 历史与流式 | 5 Run 分页、终态校准、UTF-16 offset、缺口修复已实现 | 保留 reducer、分页和稳定消息 ID |
| 状态面板 | showState 默认 true，按 iframe window 的 760/761px 判断；缩放不会同步修正打开状态 | 按组件实际宽度决定并排/覆盖，明确转换规则 |
| 阅读锚点 | 已处理首屏、prepend、字号及底部跟随 | 补齐上翻阅读时的布局/图片变化 |
| 手机导航 | 当前会话详情已隐藏底栏并有返回入口 | 沿用，无新增悬浮全局菜单或会话底部导航 |

事实依据见第 12 节。历史设计记录中的“Studio 完全静态、尚未接 SDK”已不足以描述现状；世界详情和会话应分别说明。

## 3. 产品职责与用户流程

### 3.1 三层职责

| 层级 | 拥有的内容 | 数据与交互边界 |
| --- | --- | --- |
| 平台会话页 | 返回/导航、标题、连接与任务状态、上下文入口、设置、草稿、输入、停止 | Host 管理，作者页面不能接管平台认证和受保护 API |
| 故事舞台 | 官方阅读界面或作者定义的完整内容区域 | 位于隔离 iframe，自定义布局由作者负责 |
| 官方 WorldStory | 故事列表、历史加载、最新内容入口、运行反馈、默认状态展示 | 使用现有 SRSessionAPI / SRStateAPI；作者可组合并设置 showState=false |

正式会话开局仍是一条 AI 消息，经过正常消息展示规则。世界详情的开局预览继续使用静态文档表面，二者不互相替代。

### 3.2 默认预览流程

1. 从既有 Studio 会话列表或侧栏进入样例详情。
2. 平台框架保持稳定，舞台 iframe 初始化真实 SDK Runtime 与内部 Provider。
3. 首次历史请求前订阅事件；读取最近 5 个 Run，完成首屏后定位底部。
4. 玩家可以阅读、手动加载更早消息、打开状态、调整字号、输入本地消息。
5. 本地发送通过同一预览 Host 入口返回模拟接受结果，再按约定推送阶段/增量/终态；固定脚本响应使用稳定 ID。
6. 选择行动建议只填入平台草稿；已有草稿可撤销一次，后续手动编辑使撤销失效。预览发送不会调用 Provider。
7. 切换样例清理旧订阅、计时器、通道和过期历史请求；原有按样例保留的草稿继续生效。刷新恢复 fixture。

### 3.3 作者式组合预览

保留默认阅读与不同世界风格两类入口。组合样例运行在同一 iframe 边界，通过 SDK Hook 读取状态，并组合 `<SR.WorldStory showState={false} />`，由样例自己的状态区域展示数据。

样例为仓库内受控 React 组件，不加载任意导入世界卡的 ui.source。它用于验证组合性、样式隔离和公开契约；真实世界卡编译、求值和 Host 生命周期仍由后续真实接入承担，旧 Web 现有测试继续覆盖其当前能力。

原 CustomStory 只能作为视觉参考，不能通过重命名宣称已接入作者运行时。

### 3.4 输入、草稿与阅读偏好

- 源码已确认：Web RoleplayComposer 与 Studio 样板都采用 Enter 换行、Cmd/Ctrl+Enter 发送；Web 中类型块内 Enter 跳出块。设计稿引用的 Web 文档“Enter 发送”是旧描述，不构成另一个需要实现的快捷键方案。
- 输入区属于 Host，固定在可见工作区底部，采用低对比表面和明确聚焦边界；展开、收起和多行增长改变舞台槽位高度，舞台负责恢复阅读位置。
- 移除“话语 / 叙事指令”快捷栏和只服务于按钮的 UI 代码。保留 Lexical 编辑器、节点类型、粘贴、序列化、撤销、类型块退出、尾部空行清理、长度限制和输入法 composing 防护。移除按钮不等于删除语法或禁止用户手工输入。
- 不把现有编辑器替换成普通 textarea；历史/外部草稿中的话语与 sr_instruction 继续按既有行为处理。原来的解析和规范化仍有效，不承诺字节级原样发送，也不新增静默转换。
- 两条输入路径分别验收：普通旁白段落手打/粘贴引号或整行 sr_instruction 标签继续按 escapeText 转义为普通内容；初值、外部 value 与 session.setDraft 中的既有协议文本继续解析为类型块。移除按钮不自动开启手写标签协议，也不新增禁输规则。
- 运行中仍允许编辑下一份草稿，按当前 Host 的 fatal 状态控制编辑器禁用。发送响应只清空未被后续编辑改变的那一版草稿；拒绝/失败保留草稿，维持当前 revision 保护。
- Studio 隔离预览复用现有 Host 编辑器模块，输入留在 Host 文档；使用 Studio 局部样式，不导入旧 Web 页面布局。保持单一 React/ReactDOM runtime，不复制解析器或新建独立编辑器框架。
- 默认字号16px、范围13–21px、即时预览及取消恢复沿用当前 Host 契约。正式阅读偏好的存储策略保持现状；预览适配仅使用临时内存，不建立新持久化命名空间。消息和模拟状态不做持久化。
- 平台只有一个 draft source of truth，SDK setDraft 和平台输入都写入它。已有草稿的填入/撤销与发送后清理按现有 Host 行为验收。
- 预览用量继续标明“示意”，不可把字节比例或固定数字显示成真实计费 Token。

## 4. 官方阅读界面设计

### 4.1 消息与信息层级

- 玩家和叙事共享稳定阅读轴，均采用正文排版，不使用聊天气泡或左右分列。
- 消息顶部以小型文字标签标识“我 / 故事”；玩家正文可用字重和间距辅助区分，含义不只依赖颜色。
- 不增加虚构的人物头像、角色名称或说话者归属。正文中的角色台词按正文正常展示。
- 保留现有同一 Run 内相邻 assistant 的展示合并语义，不扩大到跨 Run 合并。
- 数据、原始消息和模型上下文不因视觉合并改变；data-message-id、稳定 React key 和 Portal 身份继续保留。
- 运行反馈与行动建议靠近其所属 Run。失败和停止后保留权威终态确认的正文；已展示但未获终态确认的暂态文本按现有规则移除，不承诺全部可见内容必然持久化。只给可用的最新建议保留操作。

### 4.2 首轮实施参数

| 项目 | 初始参数与规则 |
| --- | --- |
| 正文宽度 | 最大 740px；空间不足时自适应缩小，避免正文撑出舞台 |
| 字号 / 行高 | 16px / 1.85；字号遵循平台偏好 |
| 正文边距 | 桌面至少 24px，窄屏至少 16px，320px 极窄屏可降至 12px |
| 消息节奏 | 同类段落使用正文间距，不给每条消息叠加卡片；消息间初始间隔 24–32px |
| 状态侧栏 | 初始宽度 288px，允许在 280–320px 内按真实截图微调 |
| 并排门槛 | 以 WorldStory 根容器实际宽度 960px 为首轮门槛，验证正文至少约 560px 可读宽度 |
| 触控入口 | 手机主要按钮的可点击区域至少 44px |
| 动效 | 使用 Studio 已有运动节奏，无装饰弹跳；Reduced Motion 下取消平滑滚动及非必要过渡 |

这些是落地起点，不是已验收视觉基准。若截图证明某参数妨碍阅读，在同一设计目标内调整并记录理由，不另改产品结构。

### 4.3 富文本与状态内容

- 标题、列表、链接、代码、引用、图片和表格保持清晰层级。
- 长单词、长路径和 JSON 可换行；代码与表格只在自身内部横向滚动，不带动整个舞台。
- 图片保持比例并限制最大宽度；不通过新增正文 iframe 处理长内容。
- 保留 Markdown/HTML 净化、规则匹配、组件插槽和局部失败回退原文。
- 默认状态面板只读，按 global/session/message 分组，沿用现有值和权限投影；展示加载、失败重试、无状态和长 JSON。首期不增加状态编辑器。

## 5. 滚动、响应式与无障碍

### 5.1 单一阅读滚动职责

Studio 提供高度稳定的舞台槽位及 iframe，槽位使用 min-height:0 并不承担正文纵向滚动。官方 WorldStory 内部只有一个主要故事阅读滚动容器，状态面板独立滚动。

删除当前静态 .reading 外层的正文滚动职责。自定义舞台可以自行管理局部滚动，但平台不能再替它追加一层阅读滚动。

“回到最新”定位在故事阅读区域内，不以固定 bottom:184px / 166px 猜测输入区高度；输入折叠和手机键盘变化后仍可达。

### 5.2 阅读位置规则

1. 首屏读取最近 5 Run 后直接定位最新内容，不播放从顶部到底部的滚动动画。
2. 仍使用现有距底部小于 64px 的跟随判定；用户上翻后停止自动追随。
3. 手动点击“加载更早消息”，每次 5 Run；禁止自动无限加载。加载完成保持同一可见消息及其相对偏移。
4. 字号、状态侧栏、平台侧栏、容器尺寸、输入区高度和异步图片变化均遵循：在底部则保持底部；在上方阅读则保持消息锚点。
5. 复用 story-scroll 的 capture/restore。对已知布局变更先采集锚点；对图片等异步变高，使用前一稳定布局缓存的锚点，不能在变高后才把新位置当作原位置。
6. ResizeObserver 和恢复动作合并到帧内，防止测量/滚动反馈循环；用户继续滚动时更新阅读意图，不与用户输入争抢。
7. 点击“回到最新”或手动滚回距底部小于64px时恢复跟随；Reduced Motion时程序化滚动即时完成。
8. 窗口隐藏/恢复、最新页修复、旧请求迟到与切换会话继续遵守当前 history epoch 和终态合并规则。

### 5.3 状态面板规则

- `showState` 省略或 true：提供状态入口；false：不显示入口、面板、遮罩和无意义占位。
- 首次进入：实际容器宽度 >=960px 时并排展开；不足时覆盖模式默认关闭。组件在宽 iframe 的窄列中仍按自身宽度判定。
- 并排模式记住本次挂载期间用户的开合选择。转入覆盖模式时关闭面板，避免缩放自动弹出模态层；回到并排模式恢复并排偏好。
- 覆盖面板使用 iframe 内的原生 dialog 模态机制，避免新增通用焦点框架。
- 模态范围是该 iframe：其背景内容不可交互，Tab/Shift+Tab 限定在面板，Escape/遮罩可关闭，关闭回到触发按钮。平台输入区不被误标为同文档背景。
- 断点切换、showState 改为 false、组件卸载时正确释放模态/滚动锁。触发按钮已不存在时将焦点放到仍存在的故事容器。
- 面板开合不重建故事树，不重置 Portal 内部状态或触发历史重载。

### 5.4 手机与平台弹层

- 会话详情沿用当前无底栏布局和返回会话列表入口；一级页面导航按现有规则运行。
- 平台会话设置、上下文弹窗继续使用 Studio Modal；SDK 内面板不能导入 Studio Modal 或访问父文档 DOM。
- 验证 100dvh / 可用视口、底部安全区域、多行输入与键盘后的可达性。真机软键盘验收单独记录，不能用桌面模拟宣称通过。
- 状态和操作不能只靠颜色；图标入口有可访问名称，Focus Visible 独立于 Hover/Selected。

## 6. SDK 样式与隔离预览实现

### 6.1 样式归属

新增 `packages/sr-sdk/src/world-story.css`，通过 `@sillyrealms/sdk/world-story.css` 显式导入。

package.json 将现有字符串 exports 改为同时保留根入口与 CSS 子路径的导出表。根导出继续指向 src/index.tsx，不新增 mock/runs 等作者公开 props。

- 新样式限定于 .sr-story 及其内部组件，提供 --sr-story-* 语义变量和亮暗默认值。
- 保留 --sr-story-font-size 与现有字号变更事件；不为视觉调整改变 SRSessionAPI / SRStateAPI。
- Studio iframe 显式加载官方样式；iframe 根高度、文本缩放策略和最小 reset 属于 frame 基础样式。
- 旧 Web frame 也加载官方样式，只移除或调整与官方组件冲突的旧气泡/状态样式；保留其 Host 行为、作者根布局和必要兼容规则。
- Studio 不导入旧 Web 全量 CSS，SDK 不导入 Studio 全局样式。作者自定义区域只有显式使用官方组件时才获得官方局部样式。

### 6.2 主题桥接

Host 和 iframe 不共享 CSS 继承。预览通道传递当前 light/dark、合法字号和少量官方展示变量：

- Studio 从现有语义变量提取背景、正文、次级文字、边框、强调色及必要表面色；使用固定字段白名单。
- frame 校验允许的颜色/数值，只设置 WorldStory 所在容器的 --sr-story-* 变量，不接受 CSS 源码、选择器或任意属性。
- 官方 CSS 有完整默认值，使只传 light/dark 与字号的既有 Web Host 仍可工作。
- 主题/字号切换更新样式而不重建 Runtime、iframe 或作者组件。作者样例外层风格自行决定是否采用这些变量。
- 新增消息仅限平台内部展示协议，不变成作者可调用的宿主控制 API。

### 6.3 预览最小架构

预览实现位于 `apps/studio/src/features/sessions/preview/`，当前共 7 个文件：

| 文件职责 | 内容 |
| --- | --- |
| StoryPreviewHost.tsx | iframe 生命周期、nonce/source 校验、MessageChannel、平台草稿衔接、预览阶段/停止、清理 |
| preview-transport.ts | 结构化 fixture 的 history/state.read、模拟 send、预定义展示匹配结果；稳定游标/ID与可控失败 |
| preview-frame.tsx | 实例化 SDK SessionRuntime/StateRuntime，提供 AtomicContext/StoryContext，加载官方或受控组合组件 |
| ComposedStoryPreview.tsx | 作者式组合样例，用 SDK Hook 和 showState=false 展示不同布局 |
| preview-frame.css | iframe 根布局与最小 reset；不包含另一套 WorldStory 视觉实现 |
| protocol.ts | 内部消息、外观字段与体积校验，不扩展作者公开 API |
| fixtures.ts | 结构化历史、状态、组件及确定性异常场景 |

模拟逻辑保留在 Studio 预览目录，不进入 SDK 的作者公开入口。

已增加独立 HTML 入口和 Vite 多入口构建。开发环境的 iframe 模块、opaque-origin 和 CSP 已通过会话回归，最终 Studio/Web 构建通过；构建产物上的完整会话回归也已通过，包含 SDK helper、全部响应式与短视口。静态资源 CORS 只针对受限路径的 GET/HEAD，不开放 API；未增加 allow-same-origin 或 frame 直连 Server。

### 6.4 transport 与安全边界

- 使用真实 SessionRuntime、StateRuntime 和 StoryContext；复用 SDK 历史/事件 reducer、渲染器和净化器。内部Runtime/Context沿用现有Web frame的仓库私有源码导入，不扩大作者公开exports，也不复制实现。
- 预览 adapter 只提供测试数据与事件，不复制完整 Server、上下文算法、历史合并器或持久化层。
- history 使用 HistoryRunsResult，发送使用现有返回结构，事件使用 SessionRunEvent；状态快照符合现有公开投影。
- message.match 可返回预定义 fixture 匹配结果以验证真实渲染和 Portal。它不宣称验证正则 Worker 执行；真实规则执行继续由已有 Worker 测试覆盖。
- 首期受控组合样例仅需要状态读取、setDraft、send；state.write 返回明确的预览不支持错误，不模拟状态业务校验。状态变化由测试脚本发布权威形状的事件。
- 不接受任意 ui.source、HTML 脚本或外部模块作为预览输入。iframe 保持 opaque-origin sandbox、受限 CSP 和固定消息 allowlist。
- 父页校验 event.source 和 nonce 后建立通道，切换样例关闭旧端口；未知方法、过大请求、失效 frame 消息均拒绝。
- 本地模拟的停止必须取消待发送脚本事件，终态后不再推进运行。reset/reload 清理所有计时器，避免跨样例串消息。

## 7. 状态、失败与降级矩阵

| 场景 | 应有表现 |
| --- | --- |
| 首次加载 | 舞台内加载提示，平台外框不闪动；完成后一次定位底部 |
| 空历史 | 正常空状态，可使用平台输入；不伪造 AI 消息 |
| 历史首次失败 | 舞台显示重试；重试读取，不创建新 Run |
| 加载更早失败 | 当前正文和锚点保留，在原入口重试 |
| 准备 / 正文 / 扩展 | 显示对应阶段；扩展处理时保留正文与此前权威状态 |
| completed | 以完整净正文校准；显示允许的最新行动建议 |
| failed / stopped | 按既有终态保留正文；显示原因或停止状态，不把未提交候选写进状态面板 |
| 状态部分成功/失败 | 保留已认可的状态结果与警示；遵守现有建议 blocked 规则 |
| 建议失败 | 仅建议区域退化，正文和合法状态仍可展示 |
| 连接中断 / snapshot 恢复 | 预览模拟断线与恢复数据形状；真实重连职责仍在 Host，不能宣称 SSE 可重放 |
| 状态读取失败 | 面板内错误和重试，故事继续可读 |
| 消息组件缺失/失败 | 局部回退原文，其他消息继续显示 |
| 作者式页面根错误 | 平台显示舞台不可用并停用预览发送；不静默换成官方舞台 |
| 过期请求 / 迟到事件 | 清理与现有终态权威规则阻止污染新样例或复活已结束 Run |

预览应覆盖实际 SDK 消费的 snapshot/delta/终态场景，但不把私有假数据适配当成真实网络恢复验收。Server 进程退出后的未完成正文丢失语义不在本期改变。

## 8. 兼容性与实际文件边界

| 位置 | 本轮处理 |
| --- | --- |
| packages/sr-sdk/src/world-story.tsx | 无气泡语义结构、局部交互、面板模式和反馈呈现 |
| packages/sr-sdk/src/world-story.css（新增） | 官方组件完整局部样式、默认主题、响应式和 Reduced Motion |
| packages/sr-sdk/src/story-scroll.ts | 复用原有锚点工具，未改此文件；布局恢复在 WorldStory 中补齐，不重写 history reducer |
| packages/sr-sdk/package.json | 保留根导出，新增 CSS 子路径 |
| apps/studio/src/features/sessions/Sessions.tsx / Sessions.module.css | 平台与舞台分离，去除样板的正文滚动和硬编码新增消息 |
| apps/studio/src/features/sessions/preview/（新增） | 隔离预览 Host、adapter、frame、作者式样例 |
| apps/studio/src/fixtures/sessions.ts | 保留原列表数据；结构化预览场景另放 preview/fixtures.ts，不改本文件 |
| apps/studio/preview-frame.html（新增）、vite.config.ts | 独立入口、构建与 iframe 资源加载 |
| apps/web/src/frame.tsx / frame.css | 官方 CSS 消费与冲突规则调整；不迁移旧平台 UI |
| apps/web/src/features/sessions/composer/RoleplayComposer.tsx / roleplay-composer.css | 取消快捷栏，调整 Host 输入局部外观；保留编辑器及序列化语义 |
| apps/web/test/composer/test.tsx / block-composer.test.ts、host-roleplay fixture | 删除按钮相关断言改为入口不存在断言；用已有格式草稿驱动仍需保留的类型块和序列化测试 |
| apps/studio/tests/visual/sessions.mjs、story-preview.mjs（新增） | 扩展到 iframe、SDK 运行状态、阅读锚点、焦点和异常交互验收 |
| SDK/Server 现有相关测试、Web 浏览器 fixture | 保留合并/净化/Portal/字号基线，补真实缺口的测试 |
| Studio README、AGENTS、技术/设计文档 | 实施后按真实交付更新范围、接口和证据 |

公开契约保留 SR.WorldStory、showState、SRSessionAPI、SRStateAPI、消息渲染格式、状态作用域和现有事件。CSS 子路径属于可选新增入口。内部 Context/预览桥接不升级为新的创作者 API。

用户既有的 16 个 plan 删除保持原状，不恢复、不纳入本次提交。原设计稿的设计实质保留，仅校正阶段状态和已核实事实并补充实施记录；本文、任务表与该设计稿属于本次交付范围。

## 9. 验收与执行顺序

### 9.1 验收矩阵

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| A1 | 官方与作者组合 | 两者均使用真实 SDK；showState=false 无重复状态区；共享状态投影正确 |
| A2 | 基本视觉 | 1536×864、1280×800、768×1024、390×844、375×812；覆盖深浅主题和展开/收起侧栏；无气泡、阅读轴稳定、无整页横向溢出 |
| A3 | 首屏与分页 | 最近 5 Run；直接在底部；手动前翻无重复消息；同一消息锚点稳定后误差目标 <=2px |
| A4 | 流式阅读 | 底部跟随；上翻不抢滚动；终态校准不重复正文；snapshot/重叠/缺口/迟到终态语义保留 |
| A5 | 布局与高度变化 | 字号、状态面板、侧栏、输入折叠、多行、图片加载后保持底部或原消息锚点；无 observer 循环 |
| A6 | 状态面板 | 宽 window 的窄组件、跨960px、空/长值/错误重试；用户开合偏好及断点规则生效 |
| A7 | 可访问性 | 覆盖层背景不可交互，焦点循环/返回/Escape；触控44px；Reduced Motion 不触发 JS smooth |
| A8 | 内容 | Markdown/HTML、表格、代码、图片、输入类型标记和规则；净化不削弱、局部错误回退 |
| A9 | Portal 稳定性 | 同一组件按钮状态在多次流式更新、主题/面板/字号变化后保留；历史不因 token 逐个重建 |
| A10 | 行动建议 | 只填草稿、已有草稿一次撤销、新输入撤销失效、新 Run 禁用旧建议；部分状态结果阻止建议 |
| A11 | 失败与停止 | 第7节各状态可复现；已提交正文不丢失，未提交暂态内容按权威终态校准；不应用未提交候选、不假报真实恢复 |
| A12 | 平台与移动 | 会话无底栏，返回/草稿保留/固定输入可用；最新入口不被输入遮挡；真机软键盘另行记录 |
| A13 | 隔离 | 作者布局不被平台 CSS 覆盖；无 parent DOM/Server 直连；每个文档/JS realm内组件、SDK与Hook共用同一React/ReactDOM，Host与隔离iframe各自的runtime符合正常隔离 |
| A14 | 既有消费者 | Web 类型/构建、Portal、字号、原运行时浏览器用例继续通过 |
| A15 | 构建与生命周期 | 独立 frame 在开发和构建中可加载；切换/卸载清理监听、计时器、端口和历史请求 |
| A16 | 输入功能保留 | 无话语/叙事指令按钮；Enter、Cmd/Ctrl+Enter、IME、粘贴、外部格式草稿、类型块退出、撤销、序列化和尾部空行清理仍通过 |

视觉截图使用真实 SDK DOM，不能把静态样板截图作为新版组件完成证据。截图与实测状态明确区分“已生成/已检查/用户已认可”；未认可的截图不覆盖正式视觉基准。

### 9.2 工程顺序

1. T1：整理语义结构与 SDK 官方样式入口，保留运行底座，校验旧 Web 消费。
2. T2：补齐容器响应式、状态面板、滚动与 Reduced Motion。
3. T3：简化 Host 输入外观与快捷栏，验证粘贴、序列化、类型块、草稿和发送行为保留。
4. T4：建立最小隔离预览入口和 transport，运行官方与作者式组合样例。
5. T5：接入 Studio 既有平台外框、复用输入组件、草稿/字号/主题，替换硬编码舞台。
6. T6：场景与跨端视觉验收、兼容回归、缺陷修复，实施完成后更新实际交付文档。

详细依赖、文件边界与逐项退出标准见任务表。首期没有阻止启动的技术前置依赖；视觉参数是否符合预期必须由真实浏览器结果决定。

### 9.3 验证入口与运行条件

~~~sh
pnpm --filter @sillyrealms/studio typecheck
pnpm --filter @sillyrealms/studio build
pnpm --filter @sillyrealms/web typecheck
pnpm --filter @sillyrealms/web build
pnpm --filter @sillyrealms/server exec vitest run test/story-history.test.ts test/story-scroll.test.ts test/sdk-session-runtime.test.ts test/sdk-state-runtime.test.ts
node apps/web/test/world-document/run.mjs
pnpm test:browser
STUDIO_SESSIONS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual
STUDIO_PRESETS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual
pnpm --filter @sillyrealms/studio test:visual:world-api
pnpm --filter @sillyrealms/studio test:visual:mobile-nav
git diff --check
~~~

Studio visual 测试依赖运行中的 Studio 服务。执行前检查占用端口与各浏览器 runner 的启动方式，复用已有服务或使用隔离端口；不得结束用户已有进程。新增预览的构建加载也要检查，开发服务器通过不足以替代构建验证。

按实际改动选取针对性测试，不为纯样式重跑所有无关 Server 测试；出现跨契约改动时扩大检查范围并记录理由。真实 Provider 调用、真实会话写入和数据迁移不属于首期验证。

### 9.4 旧完整视觉入口的限制

本轮运行完整 `test:visual`，在 `capture.mjs:437` 的固定 8 张世界卡断言失败。原始 `worlds` 为 8 张，当前 mock 为 8+12=20 张；普通模式通过 `/api/v1/worlds?limit=24` 读取数据，不保证固定数量。旧段还要求世界会话跳转 `/sessions/changan` 与手机导航抽屉，已不符合现行世界会话只读及手机底栏契约；仅改卡数不能修复入口。

本期必要回归改用现有 `world-api`、`mobile-nav` 和 presets-only，并独立执行 sessions-only。前两者通过 CDP 拦截 API 响应，验证当前 API 适配路径，必须指向非 mock 服务；它们不证明 live Server 集成。`test:visual:mock-data` 另要求以 `VITE_STUDIO_MOCK_DATA=1` 启动服务，只检查 20 世界/20 会话/10 预设模拟数据。

这些入口不是旧完整套件的等价迁移：旧段的侧栏动画中间帧、世界详情 A/B 滚动边界、20 角色锚点和完整几何/reduced-motion 路径本轮未恢复。保留原覆盖，不以删除断言、改产品或把旧入口记为通过处理失败。

## 10. 后续真实会话接入的明确依赖

后续阶段另列实施范围，不能隐藏在本期“换成 SDK 组件”的任务中：

1. 会话列表、侧栏快捷项与详情改用真实 ID；定义加载、空列表、失效 ID、跨路由草稿和当前会话状态。
2. 将现有 Web Host 中的认证/HTTP/SSE、iframe 握手、命令 allowlist、编译/Worker、生命周期和错误处理复用或提取为无旧 UI 样式依赖的实现；避免长期维护两套不同的运行规则。
3. 接入 send/stop、requestId/expectedTipEntryId、准备/正文/扩展、终态及 snapshot 恢复。SDK 仍只通过 Host 访问服务。
4. 上下文用量、字号、预设/模型/运行模式与能力设置接真实数据；预设和模型仍为样板的部分需要明确可用入口。
5. 世界详情增加进入已有会话、选择开局/角色并创建会话的完整链路；创建前检查实际预设和模型配置，失败留在原页面并保留选择。
6. 更新世界详情 API 测试中的“不得出现会话链接”断言；不能保留只读阶段的断言同时宣称新链路已经可用。
7. 验证正在运行时切换页面、断线、停止、根组件错误、恢复、消息/状态权限及完整真实链路；数据与付费调用按该阶段明确授权执行。

世界详情的只读真实接入已存在，原文“先完成世界详情再准备真实世界卡”不再作为当前未完成前置任务。

## 11. 评估基线、实施结果与剩余验证

### 11.1 评估阶段基线

2026-11-14 在产品改造前完成以下源码核对与基线验证：

- Studio 与旧 Web 类型检查均通过。
- story-history、story-scroll、sdk-session-runtime、sdk-state-runtime 四个测试文件，12 项测试全部通过。
- 该评估阶段仅形成方案和任务表，未修改产品代码、未运行新版视觉验收、未执行真实 Provider 调用；不代表后续实施仍未开始。
- 新版设计稿需要的样式归属、输入快捷栏精简边界、真实快捷键依据、隔离接入、来源标签、容器响应式、完整锚点、运行反馈、组合性、后续真实接入和验证命令已补齐。
- 上述结果仅为评估时基线，不作为本轮新界面完成证据。

### 11.2 已落地的实现

- SDK 官方阅读表面改为“我 / 故事”的单列无气泡排版，显式 CSS 子路径由 Web 和 Studio iframe 共用；保留消息渲染、Run 合并和 Portal 身份。
- 状态布局按组件 960px 宽度切换；原生 dialog 补齐 Tab/Shift+Tab 边界、Escape 和焦点恢复。阅读锚点覆盖输入、字号、面板、容器与异步图片变化，保留用户上翻后的阅读意图。
- Host 移除话语/叙事指令快捷按钮，继续复用 Lexical 与既有输入/草稿语义；Studio 只增加 `@sillyrealms/roleplay` 工作区依赖，没有复制解析器或导入旧 Web 平台 CSS。
- Studio 官方与作者组合样例运行真实 SDK，通过本地 transport 提供历史、状态和确定性事件。source+nonce、MessageChannel、方法/体积限制、终态和卸载清理均保留；frame nonce、key 与 src 同步更新，避免 StrictMode 握手生命周期错位。
- 正式 README/AGENTS、运行时、阅读设置与设计记录已同步本地预览边界；全部消息和模拟状态仍在内存中，不接真实 Server 会话、不调用 Provider。

### 11.3 实际验证记录

以下“此前通过”均指实施后的记录，与 11.1 的评估基线分开；末轮修复后只按实际复验范围记结论。

| 命令/场景 | 实际结果与阶段 |
| --- | --- |
| `pnpm --filter @sillyrealms/server exec vitest run test/story-history.test.ts test/story-scroll.test.ts test/sdk-session-runtime.test.ts test/sdk-state-runtime.test.ts` | 实施后通过，4 文件、12 测试 |
| `pnpm --filter @sillyrealms/server exec tsx --test ../web/test/composer/block-composer.test.ts` | 实施后通过，8 测试 |
| `node apps/web/test/world-document/run.mjs` | 实施后全部通过；消息净化、规则和 Portal |
| `pnpm test:browser` | 实施后通过；发生在最后阅读意图修复之前，不表述为最终代码全套重跑 |
| `SR_BROWSER_ONLY=worldstory-font node apps/web/test/composer/run.mjs` | 阅读意图修复后红→绿定向回归，8 测试通过 |
| `pnpm --filter @sillyrealms/studio build`、`pnpm --filter @sillyrealms/web build` | 最终 frameNonce/key 和 Tab 修复后均退出 0，含各自 `tsc --noEmit`；Web 提示 >500KB chunk，非阻断，Studio 无此提醒 |
| `STUDIO_SESSIONS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual` | 最新开发回归退出 0、无 stderr；执行记录 `session-64dfb0d6637435c847559d75`。SDK helper（含最终 Tab/Shift+Tab）、官方/组合样例、响应式与 390×280 短视口全部通过 |
| `test:visual:world-api`、`test:visual:mobile-nav` | 4174 独立生产预览通过；world-api 含 5 视口，范围差异见 9.4 |
| presets-only | 最终生产回归 `session-4f02b02358d37d76ed9158f4` 退出 0、stderr 空。原焦点断言保留，等待 trigger 的 aria-expanded=false 与 closeMenu 的 rAF 恢复（最多 2000ms）；菜单焦点、草稿/保存/撤销、Prompt 焦点锁、键盘/指针拖拽、创建/删除、1536/1280/768/390/375 与 Reduced Motion 均通过 |
| 最终构建产物上的 sessions-only | 4174 首轮分页锚点失败；测试改用真实 Home 键并等待 scrollTop<1 与两帧，替代 programmatic scrollTop=0+固定延时，SDK 产品代码未因此修改。复跑 `session-8473f3ebee0caf26c40b8891` 完整退出 0，SDK helper（含 2px 锚点）、全部响应式和短视口通过 |
| 完整 `test:visual` | 失败于旧固定 8 卡断言；不得记为通过 |
| 全范围 `git diff --check`、story-preview/presets 的 `node --check` | 均退出 0；36 个本次现存变更文件与预提交白名单完全一致，无额外文件或预先暂存项 |

会话回归覆盖 1536px 开发场景、1280/768/390/375/320px 两类样例以及 390×280 短视口。截图保存在被 Git 忽略的 `apps/studio/tests/visual/output/`。人工已检查官方 1536/390、组合浅色 1536、宽屏窄列 dialog 和 390×280 截图，未见可见遮挡或溢出；这些仍是开发证据，不等于用户视觉认可。原 3px 锚点容差已收紧至 A3 的 2px，生产 SDK helper 的全部锚点场景通过；这是现有用例范围内的证明，不扩展为未测浏览器或任意作者布局的保证。

### 11.4 验收限制与待执行交付

- 生产会话与预设完整复验、最终构建、全范围 diff 和测试语法检查已通过；本期必要工程验证完成。预提交白名单核对通过：36 个本次现存变更文件一致，无额外文件或预先暂存项，16 项既有 plan 删除仍未暂存；真实提交推送结果待补。
- 真 Safari、Firefox 和真实软键盘未测；Chromium 视口/UA 模拟不替代真浏览器或真机。390×280 只证明短可用视口的输入可达性。
- 用户视觉验收未完成；旧完整视觉入口的独有覆盖未恢复，详见 9.4。
- 真实 Server 会话、SSE 网络恢复、Provider、持久化和真实用量未接入或验证，仍是第 10 节后续阶段。
- 用户已明确要求完成后提交推送，当前尚未执行。三份 WorldStory plan 随本次功能提交；实际推送后再以独立纯文档提交补充真实 commit/hash 与闭环记录。16 项既有 plan 删除不纳入本次提交。

## 12. 源码与契约依据

以下路径均相对仓库根目录，行号以本次评估基线为准：

- [SDK 官方组件](../packages/sr-sdk/src/world-story.tsx)：第57–80行的消息结构、showState与断点；第82–216行的字号、订阅、分页和滚动；末尾状态入口与最新按钮。
- [公开运行契约](../packages/sr-sdk/src/run-contract.ts)：ChatMessage字段、阶段、扩展与SRSessionAPI。
- [故事历史合并](../packages/sr-sdk/src/story-history.ts)、[滚动锚点](../packages/sr-sdk/src/story-scroll.ts)、[消息渲染](../packages/sr-sdk/src/message-content.tsx)：本期复用底座。
- [旧 Web Host](../apps/web/src/host.tsx)、[frame入口](../apps/web/src/frame.tsx)、[旧frame样式](../apps/web/src/frame.css)：正式运行和样式现状。
- [Host输入组件](../apps/web/src/features/sessions/composer/RoleplayComposer.tsx)、[输入浏览器用例](../apps/web/test/composer/test.tsx)：实际快捷键、输入节点、粘贴、序列化与按钮边界。
- [Studio会话样板](../apps/studio/src/features/sessions/Sessions.tsx)、[会话样式](../apps/studio/src/features/sessions/Sessions.module.css)、[AppShell](../apps/studio/src/app/AppShell.tsx)：平台与样板边界。
- [Studio世界API](../apps/studio/src/features/worlds/api/worlds.ts)、[世界详情](../apps/studio/src/features/worlds/WorldDetailPage.tsx)：只读真实接入及缺失的会话入口。
- [WorldStory运行时](../docs/technical/worldstory-runtime-v1.md)、[消息展示格式](../docs/data-formats/worldstory-message-render-v1.md)、[字号与用量](../docs/technical/session-usage-and-reading-settings.md)：现行行为和权限依据。评估时发现的旧发送键说明已按实际 Host 行为更新。
- [Studio设计记录](../docs/design/studio-reference-decisions.md)、[Studio约束](../apps/studio/AGENTS.md)：最新导航、交互和已有样板范围。
