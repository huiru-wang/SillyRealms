# Studio UI SPEC

## 范围与实现入口

本规范适用于平台管理界面、会话宿主和官方 WorldStory。作者组件可以保留自己的美术风格、字体和布局，不能影响平台外壳。

Studio 使用 React、CSS Modules 和 CSS 自定义属性。共享组件负责视觉状态和尺寸，页面负责排列、内容和业务行为。Studio 不以作者 iframe 中的 Tailwind 运行时作为组件样式基础。

| 契约 | 入口 |
|---|---|
| 颜色、内置主题、主题校验、外观快照 | [theme.ts](../../apps/studio/src/styles/theme.ts) |
| 尺度、响应式尺寸、材质阴影、层级 | [tokens.css](../../apps/studio/src/styles/tokens.css) |
| 公共控件样式 | [components.css](../../apps/studio/src/styles/components.css) |
| Button / IconButton / UploadButton / ActionLink | [Button.tsx](../../apps/studio/src/components/ui/Button.tsx) |
| 页面标题栏 | [PageHeader.tsx](../../apps/studio/src/components/ui/PageHeader.tsx) |
| Field / Input / Textarea / Panel / Badge | [Field.tsx](../../apps/studio/src/components/ui/Field.tsx) |
| Select / Switch / Modal | [ui 目录](../../apps/studio/src/components/ui) |
| 会话条目 | [SessionRow.tsx](../../apps/studio/src/features/sessions/SessionRow.tsx) |

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
| 主页面左右 inset | 32px | 16px |
| 标题栏顶部 | 32px | 20px + safe-area top |
| 标题栏最小高度 | 48px | 44px |
| 主标题字号／行高 | 28／36px | 24／32px |
| 标题栏与内容间隔 | 24px | 24px |
| 标准控件最小高度 | 40px | 44px |
| compact 操作最小高度 | 32px | 44px |
| prominent 操作最小高度 | 48px | 48px |
| 输入内容字号 | 14px | 16px |
| Panel／弹层内容内边距 | 24px | 16px |

粗指针设备的共享操作触控高度至少 44px。图标按钮使用 `--touch-target`，图标本身不需要放大到触控区大小。

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

```tsx
<PageHeader title="模型" actions={
  <Button variant="primary" icon={<Plus size={16}/>} onClick={openCreate}>添加模型</Button>
}/>
<Button variant="primary" intent="danger" loading={deleting} onClick={remove}>确认删除</Button>
```

## 表单、选择与状态

- 单行与多行输入使用 `Input`、`Textarea`。`Field` 关联可见 label、说明和错误；错误文本通过 `aria-describedby` 与控件关联，控件设置 `aria-invalid`。
- 控件边框使用 `control-border`；只有 focus-visible 显示 2px 焦点环，offset 3px。会话编辑器使用整个输入条的焦点反馈，不给内部编辑区域重复加边框。
- 单选下拉使用共享 `Select`。箭头固定在控件内部；弹出列表使用主题颜色与 Popover 顶层，按可用空间向上或向下打开。长选项可换行，触发器超长单值可省略。
- Select 支持方向键、Home/End、Enter/Space、文字检索和 Escape；禁用选项不可选，收起后焦点保留在触发器。
- 设置的默认预设／默认模型和世界运行配置必须选有效项。空值只能作为禁用占位项，不能作为“未配置”选项保存。
- 布尔设置使用 `Switch`，提供可读名称和 `aria-checked`。互斥策略保留原生 radio 语义；选中态同时显示选择标记，不能只改变底色。
- Badge 是信息标签，不承担选择或点击行为。成功、警告、危险标签消费各自语义颜色。
- 请求错误使用 `ErrorNotice`，可重试时提供明确重试操作；加载使用 `role="status"`，错误使用 `role="alert"`。加载、空结果、失败不能使用相同文案。

## 页面与列表

五个主入口均使用 `PageHeader`。主标题位于固定标题锚点，操作在同一行右侧；辅助描述在下一行。页面不单独修改标题字号和顶部位置。手机上避免为了两个按钮挤压主标题；优先缩短操作文案或使用有名称的图标按钮。

预设与模型使用同一工作区布局：左列表 240px、列间隔 24px；可用容器宽度 ≤744px 时切换为列表／详情单栏。断点针对可用工作区，不能只根据整个浏览器宽度判断。

列表项的 hover、选中和 focus-within 覆盖完整条目。主点击区域与右侧独立操作分开，不嵌套 button/link。会话名占剩余空间，更新时间与更多操作靠右；长名称可省略并保留完整名称提示。导航摘要仅显示前两个会话、预设和模型。

移动主导航顺序：世界卡、预设、会话、模型、设置。桌面顺序保持世界卡、会话、预设、模型，设置在底部。主题在设置内配置。

世界、预设、模型详情在手机上保留底部导航且不重复提供左上返回按钮。详情容器保持完整视口高度，内容可以透过底栏显示；滚动区添加 `--mobile-nav-space` 尾部空间，保证最后一个操作能滑到底栏上方。不得将整个详情容器直接向上缩短来避让底栏。

世界详情的折叠头部属于连续布局，不套用列表标题栏。展开时封面、标题与右侧操作顶部对齐；收起时角色条给右侧操作保留独立空间。开局页的翻页、页码、查看初始状态、开始会话保持同排；角色选择属于头部角色列表。

会话工具栏的完整用量文字空间不足时整体切换为“用量”，不显示截断的上下文。WorldStory 的底部阅读留白固定为 128px，不随输入框开关变化。

## 弹层、材质与动效

`Modal` 负责标题、关闭按钮、正文滚动与操作区。普通宽度上限 440px，编辑型上限 760px；移动编辑弹层使用可用视口高度。长内容在正文区域滚动，操作区允许换行。

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
pnpm --filter @sillyrealms/studio test:theme
pnpm --filter @sillyrealms/studio typecheck
pnpm --filter @sillyrealms/studio build
pnpm --filter @sillyrealms/studio test:visual
```

浏览器回归连接运行中的 Studio，默认 `http://localhost:5174`；可设置 `STUDIO_URL` 和 `CHROME_PATH`。需要至少一个现有世界、预设、模型，以及可运行的介绍组件。测试只读取业务数据，不导入、不保存、不开始会话、不调用模型服务商。截图写入临时目录，结果输出具体路径。

基础验收包含五主页面双主题的 320／375／820／1280px 标题锚点、操作尺寸、横向溢出，Select／Modal 键盘行为，三类详情滚动尾部、开局工具栏及同模式主题的 iframe 同步。新组件须检查默认、hover、focus-visible、active、disabled、loading、错误和长文案状态。Chrome 移动尺寸仿真不等同于 iOS Safari 真机验收。
