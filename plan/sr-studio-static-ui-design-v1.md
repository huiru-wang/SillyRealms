# SillyRealms Studio：独立静态 UI 工程与设计基调验证方案 v1

> 状态：**设计与实施方案，尚未执行工程改造**。
> 日期：2026-11-10。
> 目标：在 SR Monorepo 新建一个可长期演进的前端 App，以两张最新首页原型为视觉起点，先用真实、可交互的静态页面校准产品 UI / UX / Color Schema，再提炼可复用的设计系统，最终作为新 SR 前端的基础。
> 明确不做：本阶段不连接 Server、不调用真实 API、不改动 `apps/web` 的页面及业务逻辑、不改动 SDK/Agent/数据库、不提交或推送（执行时另按要求）。

## 0. 已确认事实、原则和设计输入

### 0.1 当前仓库现状（已查看）

- 仓库现址：`/Users/wanghuiru/Workspace/SillyRealms`，pnpm 10 Monorepo，主分支 `main`。
- 现有应用：`apps/web`（React 19.2、Vite 6、TypeScript、React Router 7、lucide-react）、`apps/server`（Hono）；`packages/` 下有 SDK、UI Compiler、Roleplay 等。
- `apps/web/src/design-system/` 已有旧版 `DESIGN.md`、tokens 和大量页面 CSS。**这些是现有工程事实，不是新设计的视觉基准**，新 App 不从旧 `style.css`、`studio.css` 或旧 tokens 引入样式。
- 根 `pnpm-workspace.yaml` 仅显式包含 `apps/web`、`apps/server`、`packages/*`，需要将新 App 加入工作区。
- 工作区目前存在独立的未跟踪文件（检查时包括 `plan/sr-product-roadmap-v1.md`、`public/UIDesign.excalidraw`），实施时必须保护，不重置、不覆盖、不顺手提交。
- `public/SillyRealms主页.png` 已存在，但**未认定为本轮两张新参考图之一**。

### 0.2 两张参考图的权威性

本轮聊天中用户提供的两张 **1536×864 左右的深色世界卡首页图**是新的设计输入：

- **展开版**：作为整体视觉基准：Logo + SillyRealms、深灰紫背景、克制的紫色选中态、无顶栏、左侧约 280–300px 信息侧栏、页面标题、分类栏、4 列 × 2 行世界卡、右上「导入」、侧栏底部设置与主题。
- **收起版**：作为侧栏折叠模式的交互与布局基准：约 64–72px 独立竖栏、图标导航、底部设置及主题入口、分类及世界卡区域重新分配空间。
- 两图有不一致处：品牌形式、中文字体风格、侧栏容器形式、背景亮度/环境光、分类选中样式和卡片间距。**不能机械拼接；需要在浏览器 Demo 中选定唯一规则**。
- 开工时须先将这两张原图以**未改动的参考资产**纳入 `docs/design/references/studio-home-expanded.png`、`studio-home-collapsed.png`（若当前运行环境无法访问聊天附件，必须先完成素材同步；不得用旧图冒充）。另建 `reference-decisions.md` 记录两图冲突的裁决。
- 8 张世界卡的**独立原始封面**应优先查找 SR 既有资料或让用户提供；没有独立封面时，用明确标注的临时素材进行布局开发，**不能用整张参考截图裁出的含文字/遮罩区域当成卡片原图**，也不能把 AI 生成的不一致封面当成精确还原。
- 原型是视觉方向而非可执行的精确规格；所有尺寸、色值、字体必须在真实浏览器截图和交互验证后锁定。

### 0.3 非目标和强制边界

- **只构建纯前端静态体验**：不使用任何后端地址、`/api` 代理、数据库、账号、凭据、SSE、Agent Runtime、真实会话发送或文件上传。
- 允许 React 本地状态和少量 localStorage（侧栏折叠/主题选择），但不制造伪后端，不引入 Mock Server/MSW，也不为尚未存在的业务 API 设计抽象层。
- 世界卡导入按钮在 Demo 中只展示界面和受控交互反馈，**不得假装成功导入**；模型配置界面不保存真正密钥。
- 新 App 只约束 **SR 平台 UI**，不约束世界卡作者的 iframe/自定义 React UI；未来集成必须继续遵守现有 Host/iframe 隔离。
- 初期只以**暗色**作为主设计方向；浅色可以作为后续平行实验，不能为了「支持所有主题」提前做庞大主题引擎。
- 用户当前需要的是**完整执行方案并写入 plan**，本文件的创建不代表批准立刻搭建或重构代码。

## 1. 核心决策：建立长期存在的 `apps/studio`

建议新应用名称：

- 路径：`apps/studio`
- npm 包名：`@sillyrealms/studio`
- 角色：**未来正式平台前端的候选工程，第一阶段以静态设计工作台运行**。不是一次性 HTML Demo。
- 旧前端 `apps/web` 继续独立存在并保持业务可用；设计验证完成前无替换、无旧页面迁移。
- Monorepo 只新增 workspace 入口、独立开发脚本；不对旧 `dev:web`、`build`、`typecheck` 做隐性切换。

### 1.1 技术选型（克制、适配现状）

- React 19.2 + TypeScript strict + Vite 6 + React Router 7 + lucide-react；版本与现有 Web 对齐、复用 pnpm 缓存。
- 样式采用 **CSS Custom Properties（语义 Token）+ CSS Modules（组件局部样式）+ 少量全局基础样式**。设计初期比引入复杂的 Tailwind/组件框架更便于逐像素观察与微调。
- 不引入重量级 UI 库（例如整套 Material/Ant）、CSS-in-JS 运行时、Storybook、独立 UI package、状态库、图表库、设计 Token 代码生成器。
- 使用静态、类型明确的 fixture 数据；页面通过纯本地 TS/JSON 导入。
- 开发脚本：`pnpm --filter @sillyrealms/studio dev`，独立端口（建议 5174）避免与 `apps/web` 5173 冲突；`build` = TypeScript 检查 + Vite build；可有单独 `typecheck`。
- 允许日后将 `fixtures` 换成服务端数据 adapter，但**在接口稳定前不做仓促的仓储/Service 抽象**。

## 2. 目录组织（建议逻辑结构，可按实际实现微调）

```text
apps/studio/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  public/
    covers/                     # 可用的独立示例封面素材
  src/
    main.tsx
    app/
      App.tsx
      routes.tsx
      AppShell.tsx               # 全局平台布局
    styles/
      reset.css
      tokens.css                 # 基础尺度、字重、圆角、动效
      themes.css                 # 语义颜色：dark 默认，后续 light
      globals.css
    components/
      ui/                        # 只放实际使用的基础组件
      shell/                     # Sidebar、NavItem、PageHeader
    features/
      worlds/
        WorldLibraryPage.tsx
        WorldCard.tsx
        WorldCategoryNav.tsx
      sessions/                  # 第二阶段静态验证页
      presets/                   # 第二阶段静态验证页
      models/                    # 未来按需补充
    fixtures/
      worlds.ts
      sessions.ts
      presets.ts
    playground/
      DesignPlaygroundPage.tsx   # 开发辅助：Token/组件/状态预览
      ColorLabPage.tsx           # 同一界面快速对比配色方案
    hooks/
      useTheme.ts
      useSidebar.ts
  tests/
    visual/                      # 浏览器固定视口截图/后期回归
docs/design/
  references/
    studio-home-expanded.png
    studio-home-collapsed.png
  reference-decisions.md
  studio-design-system-v0.md     # 验证后创建，非先验真理
```

设计规则暂先写进新 App 的 README/设计日志；等基准页面通过验收后再形成正式设计系统，不要一开始大量创建空文档/空组件。

## 3. 视觉基调：先规定方法，不提前锁死美学

### 3.1 已明确的原则

1. **内容为主角，界面是背景**：高饱和来自 8 张世界卡封面，而非底色、按钮、导航同时发光。
2. **低对比背景层次**：炭黑/深灰紫的微小明度差，克制的背景环境光；不使用满屏霓虹、大面积彩虹渐变。
3. **紧凑但呼吸感足**：比先前生成原型更小的正文、导航和按钮；通过信息权重、留白、对齐建立节奏。
4. **统一字体**：平台中文、英文字体组合统一；原型中疑似图片生成导致的宋体/衬线混用，不予照搬；先以系统无衬线栈作基准，必要时评估合法可用的 Web 字体。
5. **减法设计**：避免容器套容器、所有元素都有描边、过量阴影/圆角/高亮。
6. **行为统一**：hover、pressed、selected、focus-visible、disabled、tooltip、popover、modal、keyboard 均通过同一套规则呈现。

### 3.2 配色实验策略

- 第一轮只做 **A：中性石墨黑 + 极低饱和紫** 的参考图近似实现。
- A 完成后在 `/lab/colors` 中，用**完全相同的布局、内容和组件**比较至多 2–3 套低饱和 dark palette（例如偏中性灰、偏暖灰紫、偏冷灰蓝紫）。
- 每套颜色必须通过语义变量表达：`canvas`、`sidebar`、`surface`、`surface-hover`、`border-subtle`、`text-primary/secondary/muted`、`accent`、`selected-bg`、`focus-ring`、`overlay`。不要在业务组件中堆十几种独立 Hex。
- 选择色彩不只看大图：同时对比卡片背景、侧栏文字、禁用/焦点、弹窗、较长文本和复杂编辑区；WCAG 正文建议至少 4.5:1，必要时为封面叠加渐变遮罩。
- 色值通过实际取样 + 视觉校准得出，不把聊天里曾经给出的参考 Hex 当成已批准 Token。

### 3.3 首轮尺寸**仅作起点**，以截图校准为准

| 元素 | 初始建议 | 调优目标 |
| --- | --- | --- |
| 桌面视觉验收视口 | 1536×864（与参考图对齐） | 保证同条件比对 |
| 侧栏展开宽度 | 280–300px | 品牌、导航、会话、预设、底部操作无挤压 |
| 侧栏收起宽度 | 64–72px | 仅图标，不留空白标签占位 |
| 页面标题 | 26–30px / 600 | 不形成巨大视觉噪音 |
| 主导航/正文 | 13–14px | 信息密度紧凑且可读 |
| 卡片标题 | 15–16px / 500–600 | 标题强于标签，弱于页面标题 |
| 卡片封面 | 宽度约 230–250px，接近纵向方卡 | 不因收起侧栏而无节制放大 |
| 页面侧内边距 | 32–48px | 跟随屏幕宽度调整 |
| 列表/卡片间距 | 常用 12/16/20/24px | 同组紧凑、跨组清晰 |
| 交互时长 | 140–200ms | 支持 reduced motion |

## 4. 首页 Demo：结构与内容精确复刻

### 4.1 统一 AppShell

**去掉顶部全局栏**，全局 Logo、入口、用户操作都归侧栏；页面内容顶部仍保留当前页标题和「导入」按钮（这不是全局顶栏）。

展开侧栏固定区域：
- Logo + SillyRealms、可访问的「折叠」控制。
- 主导航：世界卡 / 会话 / 预设 / 模型配置。
- 会话列表（长安风云：初入长安；霓虹之城：雨夜重逢）。
- 预设列表（通用叙事：默认；角色扮演）。
- 固定底部：设置、主题切换。
- 会话和预设列表的视觉/密度以展开参考为准，不额外加入新分区或虚构功能。

收起侧栏：
- 宽 64–72px，仅显示图标、激活态、底部设置和主题；提供可靠展开入口（按钮和 tooltip，不把 hover 作为唯一操作）。
- Logo 可以缩写为 SR，但字体、空间和颜色规则一致。
- 所有隐藏的标签仍须有 `aria-label` 或 tooltip；展开/收起过程中避免导航跳动、闪烁、误点。
- 主区域重排，**维持卡片视觉尺寸范围**，通过列间空间消化增量宽度；不把 4 张卡自动拉成超宽图片。

### 4.2 主区域

- 页面标题「世界卡」；右侧「导入」为中性小按钮。
- 左侧分类：多角色、古风、现代、赛博朋克、纯文字（选中态细致且稳定）。
- 右侧 **4×2** 世界卡网格（在目标桌面视口）；卡片统一圆角、纵横比、图片遮罩与底部文字位置。
- 内容固定为：
  1. 长安风云｜古风·权谋｜2 个会话
  2. 星海市｜现代·都市｜2 个会话
  3. 霓虹之城｜赛博朋克·科幻｜2 个会话
  4. 青禾小镇｜田园·治愈｜2 个会话
  5. 云上之城｜奇幻·冒险｜2 个会话
  6. 北境边城｜古风·战争｜2 个会话
  7. 新伊甸｜科幻·探索｜2 个会话
  8. 遗忘之森｜奇幻·神秘｜2 个会话
- 分类筛选先只改变本地 fixture 列表，用户可恢复「多角色」；为空时展示合理的空态。
- 世界卡点击展示只读详情/静态样例，不跳到现有 `apps/web`，不伪造真实会话。
- 标题、分类、标签、会话数溢出要有策略（例如单行省略 + tooltip），而不是自然撑大卡片。

### 4.3 静态交互范围

必须真实可用：侧栏展开/收起、路由切换或静态占位页、分类切换、hover/selected/focus、主题切换、设置 Dialog 示例、导入操作的演示反馈、卡片详情预览、Esc 关闭弹层。

演示交互不可谎称业务完成：导入/设置仅为视觉与流程模拟，所有内容本地生成、不访问真实服务。选择是否持久化视觉偏好（最多 localStorage）并提供重置功能。

## 5. 组件与复用架构：演进式，不预造完整 Design System

组件分三层：
1. **基础 primitives**：Button、IconButton、Tooltip、Dialog、Text、Badge、Separator。仅在首页真实使用时抽取。
2. **平台 shell**：AppShell、Sidebar、SidebarItem、SidebarSection、PageHeader。跨页面复用全局布局和行为。
3. **业务 patterns**：WorldCard、GalleryGrid、CategoryNav、SimpleListItem，后续由第二类页面验证其泛化价值。

约束：
- 组件使用语义 Token，业务页面不写大量 magic numbers、不同字体堆叠或自制颜色。
- **避免过度抽象**：不要为了一个按钮制作多级 Variant 配置，不要把世界卡 Grid 误抽象成万能表单组件。
- 复杂设计决策保留「设计日志」：问题、截图、候选方案、选择依据、改动前后效果、决策状态。
- 可将未来需要的 Token 导出为 CSS 变量，但不急于与旧 `apps/web` 共享单一 CSS 包；正式迁移时再决定是否升格为 `packages/sr-design`。
- 平台样式作用域只在 `apps/studio`，未来创作者 iframe 不应默认继承平台 CSS。

## 6. 跨设备与可访问性要求

- 固定截图视口：1536×864 展开、1536×864 收起；增加 1280×800 桌面、768×1024 平板、390×844 手机。
- 桌面宽屏以 4 列为基准；随空间不足依次减少列数，分类可变横向 Tab/折叠控件，不能让卡片小到不可读。
- 手机采用适当的 Drawer/窄导航模式，而不是强行保留桌面 64px 竖栏；导入操作仍然可达，卡片保证可触摸与可阅读。
- 保持语义 HTML、键盘可达、明显 `focus-visible`、图标按钮可访问名称；避开无必要的大段入场动画，遵守 `prefers-reduced-motion`。
- 滚动责任清晰：Sidebar 列表过长可在自己的内容区滚动，底部设置/主题始终可见；主区域独立滚动；展开折叠不重置主区滚动。

## 7. 设计实验与验收机制

### 7.1 先定义比较条件

- 固定相同的浏览器视口、DPR、主题、字体加载状态、设备缩放和 fixture 顺序。
- 以本轮**用户提供的两张图**为「概念参考」，以第一轮真实浏览器截图为「迭代基线」，以最终人工认可截图为「回归金标准」。
- 每轮只聚焦一个类型的问题：结构比例 → 文字与节奏 → 色彩 → 边框/遮罩/微细节 → 动效/状态。避免所有因素一起随机变化。

### 7.2 视觉审查清单

1. 侧栏、内容、分类与卡片的基线对齐；标题/按钮是否在同一视觉秩序。
2. 展开/收起均无比例失调、文字抖动、奇怪留白；卡片不随可用宽度任意伸长。
3. 页面焦点始终在封面内容，而不是彩色背景、亮按钮或过强的侧栏。
4. 中文字体、字重、行高、截断、图标粗细和按钮高度统一。
5. 色彩有明确语义，hover/selected/focus/disabled 与正常态区别合理，文本对比度达标。
6. 长文本、空列表、窄屏、弹窗、滚动、缩放和系统字体回退没有破版。
7. 不因追求与 AI 原型逐像素相似而接受明显的真实产品交互缺陷。

### 7.3 校验工具与质量门

- 每阶段跑 `pnpm --filter @sillyrealms/studio typecheck` 与 `build`。
- 使用 Playwright（或 SR 现有可复用的浏览器截图工具）保存固定视口截图；第一轮可人工截图，不以引入复杂视觉测试设施为前置条件。
- 检查开发控制台没有 React、路由、样式和资源错误；关键静态交互可手动回归。
- 最终视觉通过确认后再引入锁定基准的截图回归；**禁止为了通过测试直接覆盖未经认可的基准**。
- 设计评价必须由真实渲染截图和交互结果支持，不能仅由 Agent 声称「已对齐」。

## 8. 分阶段实施清单及退出条件

### Phase 0：准备设计证据（阻断条件）

- [ ] 复制两张原型参考图进入仓库，并验证尺寸与可读取性。
- [ ] 盘点/准备 8 张独立世界卡封面，缺失时明确标注占位，决定如何补齐。
- [ ] 建立双图冲突决策记录（Logo、字体、分类选中态、侧栏造型、容器明度等）。
- [ ] 确认现有应用和工作区状态，保护用户未提交文件。
- **Exit**：参考素材和相互冲突的处理方法清晰，不再依赖 Agent 对聊天历史的模糊回忆。

### Phase 1：新 App 脚手架与视觉基础

- [ ] 新增 `apps/studio`、包脚本、workspace entry、TS/Vite/React Router 入口。
- [ ] 建立 reset、基础尺度 Token、深色语义颜色、全局字体和基本布局。
- [ ] 建立静态 fixture；实现 AppShell 与最小路线 `/worlds`、开发辅助 `/lab`。
- [ ] 现有 `apps/web` 无源码/样式改动，旧前端仍可独立启动。
- **Exit**：新 App 单独开发、构建与加载成功；不依赖 Server 启动。

### Phase 2：高还原首页（最重要）

- [ ] 完成展开 Sidebar、主页面标题/导入、分类栏、4×2 卡片。
- [ ] 完成收起 Sidebar、导航/底部按钮，以及展开收起对内容宽度的协调。
- [ ] 封面、遮罩、字号、图标、间距、圆角等以 1536×864 双状态截图逐轮比对微调。
- **Exit**：展开和收起两种效果获得人工视觉认可，真实界面质量不低于概念图的主要设计意图。

### Phase 3：交互/响应式补全

- [ ] 静态路由、筛选、卡片预览、导入/设置示意弹窗、主题切换。
- [ ] 键盘、焦点、悬停、禁用、空态、长文案、缩放和滚动检查。
- [ ] 1280 / 768 / 390 典型视口适配。
- **Exit**：首页不是截图皮肤，而是正常可交互、可测试的 UI；无明显破版。

### Phase 4：Color Lab 与样式收敛

- [ ] 固定组件与布局，仅迭代配色/光照层次；对比至多 3 套 dark palette。
- [ ] 逐轮记录取舍、最终 token、截图和颜色对比度；选择唯一默认方案。
- [ ] 补齐组件交互态及开发预览页，形成 Design System **v0.1**。
- **Exit**：在不改布局结构的情况下能稳定切换 palette；默认方案获得认可，不再随意更改。

### Phase 5：第二类复杂静态页面验证

- [ ] 选一个与图库差异大的页面，**优先预设编辑/世界状态**，使用同一 AppShell 和基础组件进行纯静态原型开发。
- [ ] 验证信息密度、表单、长文本、Tab、弹窗、较复杂的层级是否仍优雅。
- [ ] 修正 Token/组件不足；记录适合复用的 Page Patterns。
- **Exit**：至少「图库」和「编辑/复杂数据」两种页面使用同一套视觉规则，均达到人工验收。

### Phase 6：固化规范，规划正式迁移（当前方案的边界）

- [ ] 形成 `docs/design/studio-design-system-v1.md`（Typography、Color、Spacing、Radius、Elevation、Grid、Components、Interaction、Responsive、Accessibility）。
- [ ] 建立 `apps/studio/README.md` 开发指引与简短 Agent 规则，明确参考优先级、Token 使用和截图审核。
- [ ] 锁定已确认的桌面/移动端截图基准。
- [ ] 另写迁移评估：`apps/studio` 如何逐页接入现有 API/SDK/Host，哪些组件可复用，哪些需保留安全隔离。
- **Exit**：Design System v1.0 有两个经真实浏览器验证的页面作为证据；允许随后提出正式前端替换方案，但**不在本计划中接入业务**。

## 9. 防止失败与反模式

| 风险 | 对策 |
| --- | --- |
| 只把原型图做成静态背景 | 必须是真实 DOM/CSS/React，交互可操作 |
| 两张图片风格存在矛盾 | 展开版定视觉，收起版定折叠结构，记录裁决 |
| 首页做完就锁定全站规范 | 先 v0.1，再用不同类型页面验证后锁 v1.0 |
| 旧设计系统污染新工程 | 不导入旧 CSS/tokens，功能代码暂不迁移 |
| 新 App 变成一次性 Demo | 使用可长期维护的 `apps/studio` 结构、真实路由和组件化实现 |
| 过度工程化 | 不引入 Storybook、庞大 UI 框架、Mock Server、共享包与复杂状态层 |
| 配色反复随机试验 | 同一布局/数据做 Color Lab 对照、决策留痕 |
| 截图依赖 AI 猜测 | 实际浏览器固定尺寸截图，用户确认后锁定 |
| 仅桌面展示效果好 | 平板/手机、长文字、无障碍、侧栏滚动必须验证 |
| 未确认素材导致低还原 | 先明确原封面资源，临时图必须清晰标注 |

## 10. 交付物及执行顺序

**第一批（只做这一批，先锁定首页）**：
1. 原型截图/独立封面资源入库与参考冲突记录；
2. `apps/studio` 独立工程；
3. 真实 DOM/CSS 的世界卡首页，展开 + 收起两态；
4. 基础 Token、Shell 和最少必要 UI 组件；
5. 固定视口双状态截图与可运行 Demo。

**第二批（视觉确认之后）**：交互/移动端完善、Color Lab、设计日志与 v0.1 Token。

**第三批（基调初步稳定后）**：一个复杂静态页面验证、正式 v1.0 规范、视觉回归基准、未来迁移评估。

### 第一批明确不做

不对接 Server、没有真实导入/会话/Provider、不动原 `apps/web`、不完整实现其他导航页面、不做全站统一设计系统、不提前抽出共享 `packages/sr-design`、不做 Android/桌面客户端。

## 11. 最终评价标准

此计划成功的标准不是「完成了一套静态首页」，而是：

- 两张原型所表达的**整体比例、密度、氛围、交互**在真实浏览器中可复现，且缺陷能被明确识别和迭代；
- 统一 Shell、Token 和组件让展开/收起、桌面/移动、图库/复杂页面具有真实一致性；
- 配色和细节不再靠 Agent 每次临时发挥，而是由经过验收的规则驱动；
- 后续能够**直接在新 App 上接入真实业务**，不用推倒重来，也不影响现有 SR 的稳定功能。

> 建议开工顺序：**Phase 0 → Phase 1 → Phase 2 → 用户视觉验收 → Phase 3/4 → Phase 5 → Phase 6**。先做到首页足够好，再抽象、验证、推广。


---

## 12. 实施记录：第一轮静态 App（2026-11-10）

> 此部分是实施后的实况，**不覆盖上文尚未完成的整体计划**。

### 已完成

- [x] 创建 `apps/studio`，加入 pnpm workspace，保持旧 `apps/web` 与 Server 源码不变。
- [x] 实现 React + Vite + TypeScript 工程，独立 5174 开发端口、独立构建。
- [x] 建立深色主题 Token、AppShell、展开/收起 Sidebar、会话及预设静态列表、底部设置/主题按钮。
- [x] 世界卡首页：分类、8 张封面、标题、会话数、导入示意弹窗与静态详情；4 列桌面布局及移动端布局。
- [x] 辅助页面路由、Color Lab（3 套 dark 色调候选）、模拟设置弹窗。
- [x] 通过 TypeScript、Vite build、Headless Chrome 浏览器的展开/收起截图和基础交互检查；390px 实拍可查看。
- [x] 增加 Studio 独立 Agent 规则与参考裁决记录（`docs/design/studio-reference-decisions.md`）。

### 未完成及待确认

- [ ] **Phase 0 未完全结束**：用户聊天中的两张原型原图未拷贝到 Mac 仓库。目前仅能依据聊天可视内容开发，无法准确原图像素比对。
- [ ] 8 张世界卡独立原图尚缺，当前提取并加工的封面为临时素材。
- [ ] 当前截图只是第一轮草案，尚待用户精修与最终视觉确认。
- [ ] 复杂页验证、正式 Design System v1.0 未锁定；业务对接仍排除。

### 验证指令

```bash
pnpm --filter @sillyrealms/studio dev
pnpm --filter @sillyrealms/studio typecheck
pnpm --filter @sillyrealms/studio build
pnpm --filter @sillyrealms/studio test:visual
```

截图输出：`apps/studio/tests/visual/output/`（Git 忽略；需已运行开发服务器）。

## 13. 交互一致性迭代（2026-11-10）

> 对 Studio 初步测试发现的三个问题完成本轮改造；整体视觉仍待用户主观验收。

- [x] Sidebar 展开/收起改用同一浮动圆角容器，统一材质、边框、图标位置及底部纵向操作。
- [x] 添加 Motion Tokens；侧栏轨道、页面 padding 和分类间距同步连续过渡，文字与列表通过透明度显隐。
- [x] 导航与分类 Selected + Hover 不再重复变色；非选中项仍保留适度 Hover 和焦点状态。
- [x] Dialog 使用统一淡入/淡出、微位移动效；遵守 reduced-motion。
- [x] 修复移动端 Drawer 在桌面偏好为 collapsed 时隐藏导航文字和会话列表的情况。
- [x] Chrome CDP 测试增加 CSS grid 中间帧单调变化、侧栏材质一致性、Selected Hover、移动端偏好及 reduced-motion 检查。
- [x] Studio TypeScript、Vite Build、Chrome UI smoke 与旧 apps/web TypeScript 已通过。
- [ ] 用户在真实浏览器中确认最终动效感受、间距和配色，独立封面仍是临时版本。

详细规则见 `docs/design/studio-reference-decisions.md` 与 `apps/studio/AGENTS.md`。未对 Server、SDK 和旧 Web 业务实施修改。
