# Web UI SPEC

## 范围与实现入口

本规范适用于平台管理界面、会话宿主和官方 WorldStory。作者组件可以保留自己的美术风格、字体和布局，不能影响平台外壳。

Web 使用 React、CSS Modules 和 CSS 自定义属性。共享组件负责视觉状态和尺寸，页面负责排列、内容和业务行为。Web 不以作者 iframe 中的 Tailwind 运行时作为组件样式基础。

| 契约 | 入口 |
|---|---|
| 颜色、内置主题、主题校验、外观快照 | [theme.ts](../../apps/web/src/styles/theme.ts) |
| 尺度、响应式尺寸、材质阴影、层级 | [tokens.css](../../apps/web/src/styles/tokens.css) |
| 公共控件样式 | [components.css](../../apps/web/src/styles/components.css) |
| Button / IconButton / UploadButton / ActionLink | [Button.tsx](../../apps/web/src/components/ui/Button.tsx) |
| 页面标题栏 | [PageHeader.tsx](../../apps/web/src/components/ui/PageHeader.tsx) |
| Field / Input / Textarea / Panel / Badge | [Field.tsx](../../apps/web/src/components/ui/Field.tsx) |
| Select / Switch / Modal | [ui 目录](../../apps/web/src/components/ui) |
| 会话条目 | [SessionRow.tsx](../../apps/web/src/features/sessions/SessionRow.tsx) |

## Token 使用规则

颜色的 CSS 名称为 `--canvas`、`--text` 等；主题 JSON 使用不带 `--` 的同名键。颜色只在 `theme.ts` 中定义。页面不得定义自己的浅色／深色色板。CSS mask 的黑白遮罩不属于界面配色。

| 用途 | Token |
|---|---|
| 页面、分组、浮层、悬停、按下 | `canvas`、`surface`、`surface-raised`、`surface-hover`、`surface-active` |
| 主文字、次文字、辅助文字、禁用文字 | `text`、`text-secondary`、`text-muted`、`text-disabled` |
| 分隔线、较强分隔线、控件边界、焦点 | `stroke`、`stroke-strong`、`control-border`、`focus` |
| 主操作 | `action-primary-bg/fg/hover/pressed` |
| 次操作 | `action-secondary-bg/fg/hover/pressed` |
| 选中项 | `selection-bg/fg/border` |
| 错误与危险动作 | `danger`、`danger-bg`、`danger-action-bg/fg` |
| 成功、警告、信息 | `success`、`warning`、`info` 及各自 `-bg` |
| 连接指示灯 | `connection-online`（绿）、`connection-offline`（红），与 canvas 对比度至少 3:1 |
| 玻璃面板、无模糊回退、阴影、模态遮罩 | `glass-bg/border/fallback`、`shadow-color`、`shade` |
| 阅读区域 | `reading-bg/surface/text/muted/border/speech` |
| 用量图表 | `usage-system/summary/history/input/cache-read/cache-write/output/ink` |
| 封面上的文字、渐变与底色 | `media-text/muted/bg/scrim-soft/scrim-mid/scrim-strong` |

封面文字始终配合遮罩；不能直接把普通浅色主题文字用于照片。普通选中态不随 hover 再次加深。错误、选中和成功状态必须同时提供文字、图标或 ARIA 语义。

新增语义 token 必须进入主题类型与解析器。不得在组件内重复颜色常量或创建仅服务某一个页面的主题。

## 尺度与排版

间距尺度：4、8、12、16、20、24、32、40、48、64px，分别使用对应 `--space-*`。1px 边框、图片比例、滚动测量和连续折叠的计算值属于几何约束。

| 项目 | 桌面 | 移动端（≤760px） |
|---|---|---|
| 主页面左右 inset | 24px | 12px |
| 标题栏顶部 | 20px | 8px + safe-area top |
| 标题栏最小高度 | 40px | 40px |
| 主标题字号／行高 | 24／32px | 24／32px |
| 标题栏与内容间隔 | 16px | 12px |
| 标准控件最小高度 | 36px | 36px |
| compact 操作最小高度 | 32px | 32px |
| prominent 操作最小高度 | 44px | 44px |
| 图标按钮触控区 | 32px | 32px |
| 标准按钮内边距 | 上下 4px、左右 12px | 上下 4px、左右 12px |
| 输入内容字号 | 14px | 16px |
| Panel／弹层内容内边距 | 16px | 12px |
| 共享操作组／按钮图文间距 | 8px | 4px |
| 分组间距 | 16px | 12px |
| 标准条目内边距 token | 12px | 8px |

常规控件在移动断点和粗指针设备上保持相同尺寸，不使用 `pointer:coarse` 将整组控件放大。图标按钮统一使用 `--touch-target`（32px）；标准按钮/输入框/选择器使用 `--control-height`（36px），紧凑工具栏使用 `--control-compact-height`（32px）。紧凑按钮保持左右 8px 内边距，图标按钮不叠加文字按钮内边距。操作组间距复用 `--control-gap`；不通过重叠的透明区域扩大命中范围。显式 prominent 操作仍为 44px，底部主导航、会话输入条和安全区按各自布局契约保留。

世界分类在移动端使用 compact 高度；世界详情横向 Tab 使用 compact 高度、纵向 Tab 使用 standard 高度。更多、概览折叠、会话设置/返回/用量等工具栏操作复用共享尺寸 token，页面不得另设移动端 44px 覆盖。面板和弹层内边距复用各自 token，手机上分组间距仍大于组内操作间距。

字段标签与控件间距为 4px，表单字段间距为 12px，普通分组间距为 16px；均消费共享 token。表单网格按内容从顶部排列，不拉伸标签与说明之间的空隙。说明文字不得再与表单 gap 叠加额外段落外边距。带分隔线的分组可在线两侧各保留 12px。设置行在手机上保留标签与控件同排，长选择值省略，展开后显示完整选项。

界面使用系统无衬线字体栈。主标题字重 600，普通文字 400；分组标题使用 16px，主要控件文字 14px，辅助说明 12px。compact 用于紧凑工具栏，文字 12px，触控区不随字号缩小。故事正文服从独立阅读字号，不套用管理界面字号。

圆角按职责复用：control 9px、item 12px、panel 15px、overlay 16px。浮动底部导航采用 20px。阴影使用 `shadow-control`、`shadow-popover`、`shadow-dialog`、`glass-shadow`；遮罩色不作为阴影色。

## 操作层级

每个当前操作上下文只突出一个主要动作。按钮的视觉等级、危险语义、尺寸相互独立。

| 属性 | 用途 |
|---|---|
| `variant="primary"` | 保存、确认、开始；使用实色背景和配对前景色 |
| `variant="secondary"`（默认） | 导入、编辑、取消等常规操作；带边界 |
| `variant="ghost"` | 工具栏、更多、轻量操作；透明背景 |
| `variant="text"` | 低优先级文字操作 |
| `intent="danger"` | 删除等危险语义；确认删除使用 primary + danger |
| `size="compact"` | 开局等紧凑工具栏 |
| `size="standard"`（默认） | 常规表单和页面操作 |
| `size="prominent"` | 需要更大操作区的独立入口 |
| `loading` | 显示忙碌指示，设置 `aria-busy` 并禁止重复触发 |

使用 `IconButton` 时必须提供 `aria-label`。上传使用 `UploadButton`，不要用带不同尺寸的文件 label 模拟按钮。路由链接保持链接语义；需要操作外观时使用同一 `sr-button` recipe。禁止通过 `.page button` 或页面内的 `button` 后代选择器重定义共享按钮尺寸、颜色和状态。

开局翻页使用 `IconButton inset`：32px 点击区及焦点环保持不变，背景每边内收 4px，形成 24px 视觉色块；hover、active 和 disabled 背景保持同一范围，避免紧贴页码。该表现由共享按钮 recipe 实现。

```tsx
<PageHeader title="模型" actions={
  <Button variant="primary" icon={<Plus size={16}/>} onClick={openCreate}>添加模型</Button>
}/>
<Button variant="primary" intent="danger" loading={deleting} onClick={remove}>确认删除</Button>
```

## 表单、选择与状态

- 单行与多行输入使用 `Input`、`Textarea`。多行输入尊重 `rows` 与内容用途，共享最小高度为 64px；长提示词编辑器保留自己的编辑高度，不把短标签输入框撑成大文本区。`Field` 关联可见 label、说明和错误；错误文本通过 `aria-describedby` 与控件关联，控件设置 `aria-invalid`。
- Web 弹窗关闭后恢复触发控件焦点：鼠标/触摸关闭不留下键盘焦点环，键盘关闭保留可见提示；后续键盘交互清除指针恢复标记。不用全局取消 outline 或 blur 焦点替代。
- 控件边框使用 `control-border`；只有 focus-visible 显示 2px 焦点环，offset 3px。会话编辑器使用整个输入条的焦点反馈，不给内部编辑区域重复加边框。
- 单选下拉使用共享 `Select`。箭头固定在控件内部；弹出列表使用主题颜色与 Popover 顶层，按可用空间向上或向下打开。长选项可换行，触发器超长单值可省略。
- 预设的连续数值使用共享原生 Range 和精确数字输入。滑轨标出上下限，包含负值的对称范围标出零点，方向键步长 0.01，Home/End 到达端点；手输保留合法精度。默认态显示「模型默认」与「自定义」，自定义态提供「恢复默认」。未完成或越界的输入逐项提示；窄屏将说明和控件上下排列。
- Select 支持方向键、Home/End、Enter/Space、文字检索和 Escape；禁用选项不可选，收起后焦点保留在触发器。
- Web 的应用默认和世界默认配置允许选择“未设置”，并保存 null；会话创建仍必须明确选择有效预设和模型。
- 布尔设置使用 `Switch`，提供可读名称和 `aria-checked`。互斥策略保留原生 radio 语义；选中态同时显示选择标记，不能只改变底色。
- Badge 是信息标签，不承担选择或点击行为。成功、警告、危险标签消费各自语义颜色。
- 请求错误使用 `ErrorNotice`，可重试时提供明确重试操作；加载使用 `role="status"`，错误使用 `role="alert"`。加载、空结果、失败不能使用相同文案。

## 页面与列表

Web 的五个管理入口使用 `PageHeader`。主标题位于固定标题锚点，操作在同一行右侧；辅助描述在下一行。页面不单独修改标题字号和顶部位置。手机上避免为了两个按钮挤压主标题；优先缩短操作文案或使用有名称的图标按钮。

预设与模型使用同一工作区布局：左列表 240px、列间隔 16px；可用容器宽度 ≤744px 时切换为列表／详情单栏。断点针对可用工作区，不能只根据整个浏览器宽度判断。

模型详情操作依次为测试连接、默认、编辑、删除，四项在移动端保持同一行；标题空间不足时可以移到操作行上方。测试结果在按钮内显示，当前默认项显示“当前默认”，编辑和删除可使用带名称的图标按钮。

列表项的 hover、选中和 focus-within 覆盖完整条目。主点击区域与右侧独立操作分开，不嵌套 button/link。会话名占剩余空间，更新时间与更多操作靠右；长名称可省略并保留完整名称提示。导航摘要仅显示前两个会话、预设和模型。

移动主导航顺序：世界卡、预设、会话、模型、设置。桌面顺序保持世界卡、会话、预设、模型，设置在底部。主题在设置内配置。

世界、预设、模型详情在手机上保留底部导航且不重复提供左上返回按钮。详情容器保持完整视口高度，内容可以透过底栏显示；滚动区添加 `--mobile-nav-space` 尾部空间，保证最后一个操作能滑到底栏上方。不得将整个详情容器直接向上缩短来避让底栏。

世界详情的折叠头部属于连续布局，不套用列表标题栏。展开时封面、标题与右侧操作顶部对齐；收起时角色条给右侧操作保留独立空间。开局页的翻页、页码、查看初始状态、开始会话保持同排；角色选择属于头部角色列表。

会话顶栏桌面和移动端统一为 48px，文字只占一行：显示会话名称（缺省时使用世界名称），超长省略，完整名称与所属世界通过 title 提示保留，不额外显示第二行世界名。顶栏高度与 `--session-toolbar-height` 使用同一值。

会话连接指示灯只由 `stage.connected` 决定：已连接为绿色，未连接（包括连接中）为红色；生成或整理上下文时不改成强调色。状态文字保留，指示灯本身不重复朗读。

会话输入框展开时，可在其上方显示最多五个舞台快捷按钮。按钮区与输入框同宽，按声明顺序自然换行，每行独立居中。复用次级 compact 按钮和主题交互态，高度固定为 32px，宽度随单行标签，过长时省略并保留完整名称。空列表或输入框收起时整组不占空间。

会话工具栏在所有宽度下只显示“用量”下拉入口，累计用量与上下文仅在面板内展示。用量面板锚定触发按钮并限制在可视窗口内，内容超高时内部滚动。展开后点击面板外部（包括故事 iframe 区域）收起，该次点击只关闭面板，不透传给底层操作；面板内部点击和滚动保持展开。Escape 收起并恢复触发按钮的键盘焦点；指针关闭恢复焦点时不显示键盘焦点环。WorldStory 的底部阅读留白固定为 128px，不随输入框开关变化。

WorldStory 的 AI 消息直接展示正文，不加外层气泡、底色、边框或阴影；用户消息右对齐，使用主题强调色的淡色圆角气泡，实际 Markdown 内容的首尾块不额外增加上下外边距。公开思考内容默认收起，接收时标题显示「思考中」，结束后显示「思考完成」。标题右侧箭头在收起时朝右、展开时朝下。展开后保持固定高度并支持内部滚动，流式更新保留用户选择的折叠状态。消息之间以留白区分，不重复显示“我／故事”标签，保留可访问名称。行动建议紧跟对应 AI 正文，使用轻边框、淡阴影的圆角按钮；悬停仅轻微变色，不位移，长文案自然换行，移动端纵向排列。

## 弹层、材质与动效

`Modal` 负责标题、关闭按钮、正文滚动与操作区。普通宽度上限 440px，编辑型上限 760px；弹窗按内容决定高度，并受可用视口最大高度限制，手机上的短内容也不强制撑满屏幕。标题使用 18px，标题区与操作区上下内边距为 8px，正文为 16px。长内容在正文区域滚动，操作区允许换行。

弹窗只管理直属说明段落的间距，不覆盖 Field、自定义表单或内容组件内部的段落样式；正文末项不额外保留底部外边距。创建会话的只读摘要使用标签与内容并排的两列，角色头像 32px、行间距 12px，长名称自然换行。

弹窗打开后限制背景交互，Tab 保持在弹窗内；Escape 关闭，关闭后归还触发器焦点。业务保存中可通过 `onBeforeClose` 阻止关闭，不能重新挂载弹窗来更新表单。

层级使用 token：sticky 10、navigation 20、popover 40、modal 50、notice 60。原生 Popover 顶层不依赖 z-index。浮层使用阴影而非大面积发光；底部导航和输入条共用玻璃材质，关闭透明效果时使用 `glass-fallback`。

动作反馈使用 `motion-fast` 130ms，布局过渡 270ms，弹层 200ms。共享按钮不通过缩放／位移改变布局。`prefers-reduced-motion` 下取消布局动画与平滑滚动。

## 主题契约与隔离渲染

`ThemeDefinition` 格式：

```ts
{ version: 1, id: string, name: string, baseMode: 'light' | 'dark', colors?: Partial<Record<ColorToken, string>> }
```

- `resolveTheme` 以内置主题为基础，先应用基础色覆盖，再派生操作、选择与阅读颜色；显式语义覆盖最后生效。
- 只接受白名单颜色键及十六进制、数值 RGB/RGBA。拒绝未知字段、非法值、CSS 代码和不符合规定配对对比度的主题。
- 普通文字配对至少 4.5:1，焦点和关键边界配对至少 3:1。校验针对代码中声明的配对，不能替代含图片／透明叠层的实际视觉检查。
- `applyTheme` 完成校验后一次性应用；失败不部分改写 DOM。`setTheme` 同步本地存储；无效存储值回退内置主题。
- 颜色覆盖不允许改变业务数据、布局结构、执行权限或注入 CSS。当前设置页提供内置浅色／深色选择；没有主题导入 UI、编辑器或服务端主题同步。
- Host 发送 `{version:1,mode,colors}` 完整白名单快照；接收端拒绝不完整或非法颜色。相同 mode 的不同颜色主题也必须同步，不以 mode 是否变化作为更新条件。
- 舞台把阅读 token 映射为公开的 `--sr-story-*`，其中 `reading-border` 对应 `--sr-story-line`。SDK 独立使用时保留自身 fallback。
- 世界介绍／开局组件收到相同外观变量。主题热切换更新样式，不重建组件；作者明确指定的颜色不强制覆盖。静态文档 iframe 保持安全的独立文档渲染。
- 外观消息不携带原始卡片、状态、API 凭据或请求能力；现有 origin、nonce、MessagePort 与 CSP 权限边界保持有效。

## 验收命令与检查范围

```sh
pnpm --filter @sillyrealms/web test:theme
pnpm --filter @sillyrealms/web typecheck
pnpm --filter @sillyrealms/web build
pnpm --filter @sillyrealms/web test:visual
```

浏览器回归连接运行中的 Web，默认 `http://127.0.0.1:5176`；可设置 `WEB_URL` 和 `CHROME_PATH`。需要至少一个现有世界、预设、模型，以及可运行的介绍组件。测试只读取业务数据，不导入、不保存、不开始会话、不调用模型服务商。截图写入临时目录，结果输出具体路径。

基础验收包含五主页面双主题的 320／375／820／1280px 标题锚点、操作尺寸、横向溢出，Select／Modal 键盘行为，三类详情滚动尾部、开局工具栏及同模式主题的 iframe 同步。新组件须检查默认、hover、focus-visible、active、disabled、loading、错误和长文案状态。Chrome 移动尺寸仿真不等同于 iOS Safari 真机验收。
