# DSH 风格设计指导：静谧未来感

日期：2026-11-15。用途：视觉还原、设计学习、未来主题参考。

本指南将用户提供的 DeepSeek Harness 桌面端引导截图转换为可执行的视觉规格，并附官网公开样式中的设计尺度。`Quiet Futurism / 静谧未来感` 是本指南的归纳名，不是 DSH 官方名称。

这是设计参考文档，不代表 SillyRealms 已采用此主题，也不构成对现有页面、交互或作者组件主题的修改。

## 1. 证据、来源与还原边界

### 1.1 三类标记

| 标记 | 含义 | 使用方式 |
| --- | --- | --- |
| **O：官网实值** | 本次研究中读取到的官网 CSS 定义 | 可以准确复用该定义，但不推断它适用于桌面端 |
| **S：截图观察 / 采样** | 原图中可见的结构、坐标和渲染后颜色 | 用于视觉比对；不是源码、字体文件或材质实现的证明 |
| **R：还原规格 / 补全规则** | 为获得稳定、可实现的结果而明确给定的参数 | 本指南的执行标准；不声称是 DSH 内部实现 |

未单独标注的操作性规定均为 **R**。官网定义、截图采样和还原规格有差异时，各自保留，不混合成所谓“官方 token”。

### 1.2 来源索引

| ID | 来源 | 覆盖内容 |
| --- | --- | --- |
| S1 | [工作用途选择原图](./references/dsh-onboarding-purpose.png) | 双选项、图标组、勾选、紫蓝描边、较亮灰背景 |
| S2 | [过程展示选择原图](./references/dsh-onboarding-process.png) | 三选项、炭灰背景、线性图标、青色选中轮廓 |
| O1 | [官网](https://deepseek.com/harness/) | 页面来源与产品展示内容 |
| O2 | [官网基础样式](https://deepseek.com/_next/static/css/12ac947760ee9d08.css) | `.harness-site`、暗色 token、字体、间距、圆角、局部玻璃材质 |
| O3 | [官网组件样式](https://deepseek.com/_next/static/css/c10abea4914501ec.css) | 下载菜单动画、产品演示时间线、减少动态效果回退 |

O2/O3 为本次读取的带构建哈希的地址，后续官网部署可能使其失效。文档保留本次核实的关键数值，不将它们描述为永久不变的官方标准。

浏览器预览连接超时，未完成官网动态效果的实看验证。动效事实仅限读取到的 CSS；截图不能证明入场、悬停、步骤切换的真实动画。

### 1.3 两种视觉配置分别保留

- **应用引导配置**：以 S2 为主。炭灰画布、略亮表面、较大卡片、柔白文字、蓝紫青状态色。
- **官网展示配置**：依据 O2。近黑画布、透明白表面、展示字体、局部玻璃导航和更大的章节间距。
- S1 的灰背景明显更亮，原因未确认。不能据此断言使用了毛玻璃、系统 vibrancy 或某种遮罩。
- 本指南默认还原应用引导配置；官网配置只在明确标注的章节使用。
- macOS 红黄绿窗口按钮、系统窗口轮廓属于宿主外壳。网页或现有桌面壳中不重复绘制。

## 2. 风格的构成与优先级

### 2.1 可复用关键词

| 关键词 | 具体设计动作 | 不宜扩展成 |
| --- | --- | --- |
| 静谧未来感 / Quiet Futurism | 中性暗底、少量冷色、精确轮廓 | 满屏霓虹、粒子、扫描线 |
| 克制用色 / Chromatic Restraint | 彩色分配给图标、选中、焦点 | 每张卡铺一整块高饱和渐变 |
| 同色阶分层 / Tonal Layering | 通过小幅明度差区分背景和表面 | 每层都加入不同色相 |
| 微光边缘 / Luminous Edges | 细渐变轮廓加低透明度外晕 | 粗发光边框、持续跑马灯 |
| 空间从容 / Spatial Calm | 一屏一问，组间留白大于组内 | 所有业务页机械照搬巨大空白 |
| 柔和几何 / Soft Geometry | 大容器大圆角，小控件小圆角 | 所有元素统一胶囊形 |
| 克制排版 / Typographic Restraint | 中等字号差、正常字重、明确灰度层级 | 标题全部加粗或全部使用极细字体 |
| 连续反馈 / Continuous Feedback | 小位移、减速、清晰的状态过渡 | 每次悬停都弹跳或重新入场 |

### 2.2 必须成立的视觉关系

1. 页面标题是阅读入口；卡片标题是决策入口；主按钮是行动入口。
2. 卡片保持中性表面，选中通过轮廓与标识表达；主按钮使用柔白实心。
3. 描述文字比标题弱，但必须可读。不能通过降低整个卡片透明度实现层级。
4. 每个卡片的图标、标题、描述共用左对齐轴；页面标题与主按钮共用中轴。
5. 先校准布局和排版，再校准颜色，最后调整光晕。不能用加强特效补偿错误的比例。
6. 高饱和色的面积保持很小；至少九成视觉面积由背景、表面和中性文字构成。这是借鉴约束，不是原图面积统计。

## 3. 基准画布与坐标

### 3.1 尺度约定

S1、S2 原图均为 **2560 × 1640 像素**。本指南将其按 2:1 归一为 **1280 × 820 设计画布**，用于给出可实现的 CSS 尺寸。

这个比例是还原约定，不代表已经确认截图设备 DPR。所有下文尺寸除注明外均为归一后的 CSS px。字体可换算为 `rem`，以根字号 16px 为基准。

复核时可以：以 1280 × 820、DPR 2 导出图片与原图比对；或把原图等比缩小到 1280 × 820，再与 DPR 1 截图比对。禁止横纵独立缩放。

### 3.2 S2：三选项页面的几何锚点

以下坐标为人工观察后归一并取整的 **R**，允许 2px 的初次还原误差。文字坐标是排版框，不是字形的实际着墨边界。

| 元素 | X | Y | 宽 | 高 | 对齐要求 |
| --- | ---: | ---: | ---: | ---: | --- |
| 画布 | 0 | 0 | 1280 | 820 | 内容包含在视口内 |
| 标题排版框 | 107 | 224 | 1066 | 40 | 居中 |
| 副标题排版框 | 107 | 276 | 1066 | 24 | 居中 |
| 选项区 | 107 | 348 | 1066 | 222 | 三列等宽 |
| 卡片一 | 107 | 348 | 约 345 | 222 | 内部左对齐 |
| 卡片二 | 约 468 | 348 | 约 345 | 222 | 同一水平基线 |
| 卡片三 | 约 829 | 348 | 约 344 | 222 | 选中轮廓不改变外框 |
| 主按钮 | 520 | 672 | 240 | 44 | 页面中轴 |
| 返回 / 跳过行 | 107 | 728 | 1066 | 32 | 左右两端 |

推荐布局计算：

- 内容最大宽度：`1066px`。
- 三列间距：`16px`；列宽用 `(容器宽度 - 32px) / 3` 计算，不分别写死。
- 标题行高 40px → 间隔 12px → 副标题行高 24px → 间隔 48px → 卡片。
- 卡片高度 222px → 间隔 102px → 主按钮。
- 按钮高度 44px → 间隔 12px → 底部导航行。
- 页面顶部留白 224px、底部约 60px；这是引导页的特定构图，不是通用业务页 padding。

### 3.3 S1：双选项页面

保持标题、副标题和整体垂直节奏；只收窄卡片组。

| 项目 | 还原值 R |
| --- | --- |
| 卡片组 | 宽 842px，水平居中，X 约 219px |
| 双列 | `repeat(2, minmax(0, 1fr))` |
| 列间距 | 18px |
| 单卡宽 | 412px |
| 卡片高 | 222px |
| 图标组 | 5 个，单个约 25 × 28px，间距 10px；统一置于 32px 高图标行 |
| 选择标识 | 24 × 24px，位于图标行右侧 |
| 主按钮 | 仍为 240 × 44px；S1 实际位置比 S2 稍高，统一还原可采用 Y=672px |

S1 两张卡同时勾选，S2 只有一张高亮。视觉还原分别按多选与单选处理；截图不能证明原产品全部选择与保存规则。

## 4. 色彩系统

### 4.1 应用引导配置

表中 token 名为本指南命名，不是 DSH 原始变量名。

| Token | 值 | 证据 | 用途 |
| --- | --- | --- | --- |
| `color.canvas` | `#26272D` | S2 主导采样 | 页面背景 |
| `color.surface` | `#2A2B2E` | S2 卡片主导采样 | 默认及选中卡片 |
| `color.surface.hover` | `#303136` | R | 未选中悬停 |
| `color.surface.raised` | `#353638` | R；参考 O2 中性阶 | 菜单、弹层扩展 |
| `color.text.primary` | `#F9FAFB` | S2 | 标题、卡片标题 |
| `color.text.secondary` | `#ADB2B9` | S2 | 副标题、描述、返回、跳过 |
| `color.text.decorative` | `#81858C` | R；参考官网中性阶 | 非必要装饰文字，不用于普通正文 |
| `color.text.inverse` | `#0F1115` | R | 柔白按钮上的文字 |
| `color.border.default` | `rgba(255,255,255,0.12)` | R | 卡片弱边界 |
| `color.border.hover` | `rgba(255,255,255,0.20)` | R | 未选中悬停边界 |
| `color.accent.violet` | `#8370F1` | S2 | 结果类图标 |
| `color.accent.blue` | `#3A87FF` | S2 | 细节类图标 |
| `color.accent.cyan` | `#01A4C9` | S2 | 过程类图标 |
| `color.focus` | `#6799FE` | R；取 O2 品牌色 | 键盘焦点轮廓 |
| `color.action.primary` | `#F9FAFB` | S2 | 主按钮背景 |
| `color.action.primary.hover` | `#E8EBF0` | R | 主按钮悬停 |
| `color.action.primary.pressed` | `#DDE2E8` | R | 主按钮按压 |

S2 各区域存在轻微像素差异，例如卡片还会出现 `#2B2B2F`。默认还原使用统一 surface；不把每种渲染差异都转成独立 token。

### 4.2 S1 的亮灰变体

需要单独还原 S1 时，使用以下覆盖；其他文字、尺寸和结构保持不变。

| Token | R 选定值 | S1 采样依据 |
| --- | --- | --- |
| `color.canvas` | `#4F5150` | 大面积为 `#4F5150`、`#515251` |
| `color.surface` | `#323335` | 卡片大面积为 `#323335`、`#333335` |

此变体的卡片比画布深，与 S2 的卡片稍亮关系不同。把它作为独立标本保留，不推导成全局暗色分层规则。默认不添加 backdrop-filter；静态图不足以证明原背景处理。

### 4.3 官网展示配置 O2

| 原变量 | 暗色实值 |
| --- | --- |
| `--ds-color-bg-page` | `#0A0A0A` |
| `--ds-color-bg-surface-1` | `rgba(255,255,255,0.06)` |
| `--ds-color-bg-surface-2` | `rgba(255,255,255,0.04)` |
| `--ds-color-bg-surface-3` | `rgba(255,255,255,0.02)` |
| `--ds-color-bg-surface-4` | `rgba(255,255,255,0.015)` |
| `--ds-color-bg-surface-5` | `rgba(255,255,255,0.12)` |
| `--ds-color-bg-overlay` | `#262626` |
| `--ds-color-text-primary` | `#FFFFFF` |
| `--ds-color-text-secondary` | `rgba(255,255,255,0.80)` |
| `--ds-color-text-description` | `rgba(255,255,255,0.50)` |
| `--ds-color-border-default` | `rgba(255,255,255,0.06)` |
| `--ds-color-brand` | `#6799FE` |
| `--ds-btn-primary-bg` / `text` | `#FFFFFF` / `#0A0A0A` |

表面编号不是由暗到亮的排序。透明度色的最终结果依赖下层颜色；不要把 `surface-1` 到 `surface-5` 当成五级固定亮度台阶。

### 4.4 渐变描边

**S**：S1 紫色边缘由左侧深紫走向右侧浅紫，蓝色边缘由左蓝走向右侧浅蓝；S2 青色上边右侧更亮、下边更深。

**R**：使用下面的稳定参数进行近似还原。端点参考采样，但角度、停靠位置和混合方式是重建选择。

| Token | 定义 |
| --- | --- |
| `gradient.selection.violet` | `linear-gradient(90deg, #3F38D1 0%, #8370F1 52%, #B4A5FF 100%)` |
| `gradient.selection.blue` | `linear-gradient(90deg, #3A70FF 0%, #398FFE 55%, #60BFFF 100%)` |
| `gradient.selection.cyan` | 上层 `linear-gradient(0deg, #0493B5 0%, transparent 75%)`，下层 `linear-gradient(90deg, #21C4E6 0%, #A2ECFD 100%)` |

青色采样依据：上左段约 `#34CAEC`，上右段约 `#A2ECFD`，下边大量像素为 `#0493B5`。多层渐变是让“上右亮、下边深”同时成立的还原手段。

- 选中轮廓宽 2px，默认边界宽 1px。
- 选中描边单独覆盖在边缘，切换前后卡片盒模型、文字位置完全不变。
- 渐变仅用于边缘；卡片正文表面保持纯色。
- 禁止持续旋转渐变、扫光或让选中卡片自动呼吸。

### 4.5 颜色角色与对比度

本次按 sRGB 相对亮度计算，四舍五入至两位小数：

| 前景 / 背景 | 对比度 | 使用结论 |
| --- | ---: | --- |
| `#F9FAFB` / `#26272D` | 14.25:1 | 主要文字 |
| `#ADB2B9` / `#2A2B2E` | 6.64:1 | 卡片描述 |
| `#ADB2B9` / `#26272D` | 6.98:1 | 页面副标题与次要操作 |
| `#0F1115` / `#F9FAFB` | 18.08:1 | 主按钮文字 |
| `#6799FE` / `#26272D` | 5.36:1 | 焦点色参考 |
| `#81858C` / `#2A2B2E` | 3.82:1 | 不满足普通小字 4.5:1 要求 |
| `#8370F1` / `#2A2B2E` | 3.74:1 | 可用于图形，不直接用作小号正文 |
| `#3A87FF` / `#2A2B2E` | 4.10:1 | 可用于图形，不直接用作小号正文 |
| `#01A4C9` / `#2A2B2E` | 4.82:1 | 当前配对可读；仍保留文字角色分工 |

这些数值只证明对应不透明纯色配对，不证明完整组件可访问性。焦点环、渐变边缘、叠层表面还需在最终组合中检查。错误、成功、警告使用产品既有语义色，不把类别紫蓝青重新解释成状态成功与失败。

## 5. 字体、字重与文案排版

### 5.1 字体选择

**应用还原 R**：优先系统无衬线字体。中文在 macOS 上优先 PingFang SC，其他平台允许回退。截图不能确定准确字体文件或字重。

```css
/* 应用引导参考栈 */
font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
  "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
```

**官网 O2**：正文栈主字体 `DM Sans`，展示字体变量为 `Host Grotesk`，等宽字体为 `Fragment Mono`。部分 hero / heading 类实际覆盖为 `Montserrat`。不能把所有官网标题都描述成 Host Grotesk；这些西文字体也不证明中文采用同一字库。

### 5.2 引导页排版规格 R

| 角色 | 字号 | 行高 | 字重 | 字距 | 颜色 |
| --- | ---: | ---: | ---: | --- | --- |
| 页面问题 | 28px / 1.75rem | 40px | 400 | 0 | primary |
| 页面解释 | 16px / 1rem | 24px | 400 | 0 | secondary |
| 卡片标题 | 20px / 1.25rem | 28px | 400 | 0 | primary |
| 卡片描述 | 16px / 1rem | 24px | 400 | 0 | secondary |
| 主按钮 | 14px / .875rem | 20px | 600 | 0 | inverse |
| 返回 / 跳过 | 16px / 1rem | 24px | 400 | 0 | secondary |
| 窄屏问题 | 24px / 1.5rem | 34px | 400 | 0 | primary |
| 窄屏卡片描述 | 14px / .875rem | 22px | 400 | 0 | secondary |

- 避免给中文问题添加大字距。原图的舒展主要来自字号、留白和字重。
- 标题最多两行；描述允许自然换行。不能为了维持卡片高度裁掉关键选择依据。
- 目标画布内，原有卡片标题和描述各一行。内容改变后按真实文本增加卡片高度。
- 禁止 `transform: scaleX()` 修正字形宽度；先校对字体回退，再调整容器。
- 不使用全局透明度、文字阴影或发光文字。
- 不因截图显得纤细而将普通 UI 文本默认设为 300。若精确匹配需要特殊字重，必须在目标字体加载后单独验证。

### 5.3 文案结构

- 页面标题：直接提出一个问题。
- 副标题：解释选择会影响什么，必要时说明不受影响的能力。
- 选项标题：2–6 个汉字为宜；描述以一句话交代结果与用途。
- 主按钮：明确下一步；最后一步改成进入应用等完成动作。
- 次要操作：保留返回和跳过的低强调，不与主按钮使用同等底色。

## 6. 间距、圆角、材质与深度

### 6.1 官网尺度 O2

| 原 token | 值 |
| --- | --- |
| `--ds-space-1` 至 `--ds-space-7` | `4 / 8 / 12 / 16 / 24 / 32 / 40px` |
| `--ds-space-8` 至 `--ds-space-13` | `56 / 80 / 120 / 160 / 200 / 240px` |
| `--ds-radius-sm` | `8px` |
| `--ds-radius-media` / `input` | `10px` |
| `--ds-radius-panel` | `16px` |
| `--ds-radius-card` | `24px` |
| `--ds-radius-pill` | `100px` |
| `--ds-blur-glass` | `12px` |
| 暗色 `--ds-shadow-card` | `inset 0 1px 0 rgba(255,255,255,.12)` |

### 6.2 应用引导规格 R

| Token | 值 | 规则 |
| --- | --- | --- |
| `radius.option` | 28px | 接近截图的大卡片轮廓 |
| `radius.button` | 10px | 主按钮保留短圆角矩形形态 |
| `radius.check` | 6px | 24px 方形勾选控件 |
| `space.option.inline` | 32px | 卡片左右内边距 |
| `space.option.top` | 52px | 顶部至图标行 |
| `space.option.bottom` | 60px | 基准单行内容下的底部留白 |
| `space.icon-to-title` | 16px | 32px 图标行结束至标题 |
| `space.title-to-description` | 8px | 同一内容组保持紧凑 |
| `shadow.option.ambient` | `0 10px 24px rgba(38,54,128,.10)` | 默认卡片下方轻微冷色晕影 |
| `shadow.option.selected` | `0 12px 28px rgba(38,75,160,.16)` | 选中阴影，仍然克制 |
| `shadow.overlay` | `0 16px 48px rgba(0,0,0,.28)` | 扩展弹层使用；截图未展示 |

阴影与发光参数是近似重建，不能从截图精确反推出。默认不叠加全屏彩色 radial-gradient，不添加噪点纹理。验收时先关闭阴影检查结构，再打开阴影。

### 6.3 材质使用位置

- 引导卡片：默认不透明，弱边界，细微外晕。
- 选中卡片：保留相同 surface，只增加边缘光；避免整卡变蓝。
- 浮动导航 / 工具条扩展：允许使用 12px blur 与较实的暗底，但必须有真实可透出的下层内容。
- 模糊降级：背景改为不透明 `surface.raised`，保留边界，确保文字清晰。
- 大面积表面不同时使用透明、噪点、内高光、双层投影、渐变五种效果。

## 7. 核心组件规格

### 7.1 单选卡 / 多选卡

| 属性 | 基准 R |
| --- | --- |
| 盒模型 | `border-box`，最小高度 222px，1px 默认边界 |
| 卡片内部 | 上 52px、右 32px、下 60px、左 32px |
| 顶行 | 32px 高，图标左对齐；多选时勾选标识靠右 |
| 图标至标题 | 16px |
| 标题 / 描述 | 28px / 24px 行高，中间 8px |
| 可点击区 | 整个卡片；不要再把图标和文字拆成独立操作 |
| 选中轮廓 | 2px 独立覆盖层，圆角与外框一致 |
| 多行 | min-height 保底，内容需要时自然增高，同一行卡片等高 |

基准高度可验算：`2px 边界 + 52 + 32 + 16 + 28 + 8 + 24 + 60 = 222px`。

### 7.2 状态矩阵

| 状态 | 表面 | 边缘 / 阴影 | 内容与反馈 |
| --- | --- | --- | --- |
| Default | surface | 1px default + ambient | 标题 primary、描述 secondary |
| Hover，未选中 | surface.hover | 1px hover | 不位移；图标不旋转 |
| Selected | surface | 2px 对应渐变 + selected shadow | 多选显示实心勾；单选见下面说明 |
| Selected + Hover | 与 Selected 相同 | 与 Selected 相同 | 不叠加第二种底色或更大光晕 |
| Pressed，可交互 | 保留当前状态 | 不新增阴影层 | 整卡 `scale(.995)`，释放恢复 |
| Focus-visible | 保留当前状态 | 外加 2px focus，offset 4px | 焦点与选中独立叠加 |
| Disabled | surface | default，无彩光 | 无 hover/pressed；使用不可用语义与必要说明 |
| Error，扩展状态 | 保留 surface | 产品错误色边界 | 错误文字加图形标识，不只变红 |

**单选标识**：S2 可见状态主要依赖彩色边框，未看到独立勾选。用于静态还原时保持这一点；用于真实产品时增加可见单选点或“已选择”标识，配合选中语义。这是可访问性补全，不标注为原图特征。

单选组具备明确组名，支持方向键切换；多选项支持 Space 切换。优先采用原生 radio / checkbox 与整卡 label，避免卡内嵌套按钮。焦点环不能被父级 `overflow:hidden` 裁切。

### 7.3 多选勾选控件

- 外框 24 × 24px，圆角 6px。
- 已选：背景 `#F9FAFB`，勾线 `#0F1115`，勾图形约 14px，线宽约 1.5px。
- 未选 R：透明底、1px 强边界、无勾。
- 勾选显现用 120ms opacity；不飞入、不弹跳。
- 真实点击区域仍是整张卡，右上勾只反映同一个值。

### 7.4 主按钮

- 桌面 240 × 44px，圆角 10px，水平内边距 24px；文字 14/20、600。
- 背景柔白，文字近黑；不加品牌蓝填充或大投影。
- Hover 变为 `primary.hover`，Pressed 变为 `primary.pressed` 并 `scale(.98)`。
- Focus-visible 使用 2px focus、offset 4px。
- Loading 保留宽高和可读标签，增加小型进度标识，防止按钮内容跳动和重复提交。
- Disabled R：底 `#353638`，字 `#ADB2B9`，无按压或悬停；需要解释原因时在附近给出文字。
- 主操作只保留一个；其标签反映当前步骤是否完成。

### 7.5 返回与跳过

- 文字为 secondary；hover 提升为 primary，不出现新的实心卡片。
- 返回箭头约 20px，和文字间距 12px。
- 参考图行高 32px；实际交互命中区至少 44px，可通过透明 padding 扩大。
- 右侧跳过不依赖绝对定位压在内容上；文字增长或窄屏时进入正常流。
- 切换步骤后保留已经选择的值。是否允许跳过及默认值由具体产品决定，本指南不补造 DSH 业务规则。

### 7.6 图标语言

- S2：单色线性图形，约 28–32px 的容纳框，圆端点，线宽 R=1.75px；图标根据实际轮廓光学校准，不能只依靠 SVG 外框对齐。
- S1：文件 / 语言品牌图标为彩色识别资产，同组视觉高度一致；不把所有原有品牌色强制改成单色。
- 通用功能图标、类别图标和文件品牌图标分工明确。不要把同一功能一会儿画成 3D、一会儿画成线稿。
- 本规范不创建或重新分发品牌图标包。下次实现使用已授权资产或项目已有图标体系。

## 8. 关键视觉配方

以下 CSS 仅是设计文档中的还原示例，不是本项目新增的生产样式。所有变量采用独立 `--dsh-ref-*` 前缀，避免与 Studio 现有命名发生混淆。

完整画布需先清除宿主默认 body margin，加载第 5 节字体栈；所有交互控件继承字体、使用 `border-box`。若嵌入现有产品，只对参考组件根节点及其子元素做局部归一，不覆盖宿主全局样式。以下片段按第 8.1 → 8.2 → 10 节顺序组合。

### 8.1 卡片与无布局跳动的选中轮廓

```css
.dsh-ref {
  --dsh-ref-canvas: #26272d;
  --dsh-ref-surface: #2a2b2e;
  --dsh-ref-hover: #303136;
  --dsh-ref-text: #f9fafb;
  --dsh-ref-secondary: #adb2b9;
  --dsh-ref-border: rgb(255 255 255 / .12);
  --dsh-ref-focus: #6799fe;
  --dsh-ref-ease-state: cubic-bezier(.2, 0, 0, 1);
  --dsh-ref-selection: linear-gradient(90deg, #3a70ff, #60bfff);
  color: var(--dsh-ref-text);
  background: var(--dsh-ref-canvas);
}

.dsh-ref-option {
  position: relative;
  box-sizing: border-box;
  min-width: 0;
  min-height: 222px;
  padding: 52px 32px 60px;
  border: 1px solid var(--dsh-ref-border);
  border-radius: 28px;
  background: var(--dsh-ref-surface);
  color: var(--dsh-ref-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 10px 24px rgb(38 54 128 / .10);
  transition: background-color 200ms var(--dsh-ref-ease-state),
    border-color 200ms var(--dsh-ref-ease-state),
    box-shadow 200ms var(--dsh-ref-ease-state),
    transform 120ms var(--dsh-ref-ease-state);
}

.dsh-ref-option::before {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 2px;
  background: var(--dsh-ref-selection);
  -webkit-mask: linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask: linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  opacity: 0;
  transition: opacity 180ms var(--dsh-ref-ease-state);
}

.dsh-ref-option[data-selected="true"] {
  border-color: transparent;
  box-shadow: 0 12px 28px rgb(38 75 160 / .16);
}
.dsh-ref-option[data-selected="true"]::before { opacity: 1; }

@media (hover: hover) and (pointer: fine) {
  .dsh-ref-option:not([data-selected="true"]):not([data-disabled="true"]):hover {
    background: var(--dsh-ref-hover);
    border-color: rgb(255 255 255 / .20);
  }
}

.dsh-ref-option:not([data-disabled="true"]):active {
  transform: scale(.995);
}
.dsh-ref-option:focus-visible,
.dsh-ref-option:has(input:focus-visible) {
  outline: 2px solid var(--dsh-ref-focus);
  outline-offset: 4px;
}
.dsh-ref-option[data-disabled="true"] {
  cursor: not-allowed;
  border-color: var(--dsh-ref-border);
  box-shadow: none;
}
.dsh-ref-option[data-disabled="true"]::before { opacity: 0; }

.dsh-ref-icon-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
}
.dsh-ref-option-title {
  margin: 16px 0 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 400;
}
.dsh-ref-option-description {
  margin: 8px 0 0;
  font-size: 16px;
  line-height: 24px;
  color: var(--dsh-ref-secondary);
}

.dsh-ref-primary {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 240px;
  min-height: 44px;
  padding: 12px 24px;
  border: 0;
  border-radius: 10px;
  background: #f9fafb;
  color: #0f1115;
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 200ms var(--dsh-ref-ease-state),
    transform 120ms var(--dsh-ref-ease-state);
}
@media (hover: hover) and (pointer: fine) {
  .dsh-ref-primary:enabled:hover { background: #e8ebf0; }
}
.dsh-ref-primary:enabled:active {
  background: #dde2e8;
  transform: scale(.98);
}
.dsh-ref-primary:focus-visible {
  outline: 2px solid var(--dsh-ref-focus);
  outline-offset: 4px;
}
.dsh-ref-primary:disabled {
  background: #353638;
  color: #adb2b9;
  cursor: not-allowed;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-ref-option, .dsh-ref-option::before,
  .dsh-ref-primary { transition: none; }
  .dsh-ref-option:not([data-disabled="true"]):active,
  .dsh-ref-primary:enabled:active { transform: none; }
}
```

示例中 `data-selected` / `data-disabled` 只用于样式；真实选择、禁用与可访问语义必须由原生控件或完整组件提供。属性不能代替实际禁用逻辑。对于不支持 mask 的目标环境，回退为 2px 单色选中轮廓并保持布局不变。

### 8.2 精确画布与自适应布局分工

1280 × 820 的还原画布使用第 3 节几何锚点。业务页面使用正常文档流，不将所有内容固定在绝对坐标。

```css
.dsh-ref-onboarding {
  box-sizing: border-box;
  min-height: 100svh;
  padding: clamp(96px, calc(50svh - 186px), 224px) 32px 60px;
}
.dsh-ref-content { max-width: 1066px; margin-inline: auto; }
.dsh-ref-question {
  margin: 0;
  font-size: 28px;
  line-height: 40px;
  font-weight: 400;
  text-align: center;
}
.dsh-ref-explanation {
  margin: 12px 0 0;
  font-size: 16px;
  line-height: 24px;
  color: var(--dsh-ref-secondary);
  text-align: center;
}
.dsh-ref-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 48px;
}
.dsh-ref-options[data-count="2"] {
  max-width: 842px;
  margin-inline: auto;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.dsh-ref-actions {
  display: flex;
  justify-content: center;
  margin-top: 102px;
}
.dsh-ref-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
  min-height: 32px;
}
```

该布局在 820px 高视口给出 224px 顶部间距。字体放大、标题换行时，后续内容自然下移并允许页面滚动。实际 44px 导航命中区可以比参考排版框高，不能为了像素对齐牺牲命中区。

## 9. 动效系统

### 9.1 官网代码能确认的内容 O3

| 证据 | 可确认内容 | 不能据此推断 |
| --- | --- | --- |
| 下载菜单 | `.35s cubic-bezier(.19,1,.22,1)` 入场动画 | 所有菜单或桌面端都用同一参数 |
| 插件演示 | 22s 循环时间线；含 5–8px 位移、淡入淡出、状态更替 | 真实操作必须等待 22s |
| 运行轨迹演示 | 15s 循环；行记录出现、列表移动、详情面板展开 | 生产界面默认自动滚动相同行为 |
| 交付物演示 | 17.5s 循环、`cubic-bezier(.37,0,.63,1)` | 日常按钮适合此长时长 |
| 运行控制 | 根据 `data-running` 切换 animation-play-state | 所有动画触发条件、可见性策略 |
| Reduced motion | 多个演示隐藏动画画布、展示静态 fallback | 所有应用页面均已完整无障碍适配 |

### 9.2 可执行的动效 token R

| Token | 值 | 用途 |
| --- | --- | --- |
| `motion.duration.press` | 120ms | 按压与释放 |
| `motion.duration.selection` | 180ms | 勾选、选中轮廓 |
| `motion.duration.hover` | 200ms | 底色与边界变化 |
| `motion.duration.enter` | 320ms | 卡片组入场 |
| `motion.duration.exit` | 160ms | 离场 |
| `motion.duration.scene` | 440ms | 一次引导步骤切换的内容转场 |
| `motion.delay.stagger` | 50ms | 同组卡片错峰 |
| `motion.distance.enter` | 8px | 下方轻微淡入 |
| `motion.distance.exit` | -4px | 向上轻微淡出 |
| `motion.scale.button` | .98 | 按钮按压 |
| `motion.scale.option` | .995 | 大卡片按压，幅度更小 |
| `motion.ease.enter` | `cubic-bezier(.19,1,.22,1)` | 快启动、长减速 |
| `motion.ease.state` | `cubic-bezier(.2,0,0,1)` | 状态颜色与轮廓 |
| `motion.ease.exit` | `cubic-bezier(.4,0,1,1)` | 短促离场 |

这些是从风格出发制定的还原动作，不是截图已证实的动画。

### 9.3 具体时序

**首次进入 R**：

1. 标题与解释作为一个组，从 opacity 0、Y=8px 到 opacity 1、Y=0，持续 320ms。
2. 卡片组从 t=60ms 开始，同样持续 320ms，各卡延迟 50ms，三张最后一张在 t=480ms 完成。
3. 主按钮从 t=160ms 开始 200ms 淡入；底部导航一起淡入，不再多加一套位移。
4. 动画只在首次进入或步骤实际切换时播放，不在选中、重新渲染、窗口缩放时重播。

**选择 R**：

- 输入响应立即更新，轮廓 opacity 与勾选用 180ms 完成视觉过渡。
- 卡片尺寸、排列和文案位置保持不变。
- 不等待动画结束才允许继续，不因快速点击堆积动画队列。

**步骤切换 R**：

- t=0–160ms：旧内容淡出并上移 4px。
- t=120–440ms：新内容从下方 8px 淡入，两个内容层可短暂叠放在同一区域。
- 外部标题 / 卡片 / 按钮的区域锚点保持稳定；不同内容高度用容器预留或正常流处理，不裁掉文本。
- 离场内容立即退出焦点顺序，新内容准备好后将焦点移到新问题标题或适当的首个控件。
- 需要等待数据时，加载反馈立即可见，不能把网络延迟伪装成设计动画。

**减少动态效果 R**：取消位移、缩放、错峰和循环，直接呈现最终状态；最多保留短于 100ms 的淡变。内容与操作仍完整可用。

### 9.4 性能与触摸边界

- 常规交互优先动画 opacity / transform；不动画大面积 blur、filter 或阴影半径。
- 渐变边缘通过覆盖层 opacity 过渡，避免持续重绘渐变角度。
- 不给所有卡片常驻 `will-change`。
- Hover 仅用于精细指针设备；触摸设备依靠按压和选中反馈，不保留粘滞悬停。
- 页面后台或演示不再可见时可暂停装饰性循环；实际状态信息仍持续更新。

## 10. 响应式与内容压力

截图只覆盖桌面。以下断点与变化都是 **R**，用于将风格扩展到可用界面。

| 条件 | 布局与尺寸 |
| --- | --- |
| 宽 ≥1200px、高 ≥780px | 使用基准三列；主体 max-width 1066px；保留大段留白 |
| 宽 768–1199px | 三选项改为一列；双选项可保留两列；卡片 padding 32px 24px；卡片 min-height 180px，按内容增高 |
| 宽 <768px | 所有选项一列；页面左右 20px；顶部 64px；标题 24/34；卡片 padding 24px，radius 20px，min-height 160px |
| 高 <780px 且宽 ≥768px | 顶部间距 64px；问题至卡片 32px；卡片至按钮 48px；允许页面滚动 |
| 移动端主操作 | 卡片至按钮 32px；按钮宽 100%、最大 360px、高 48px；底部导航 margin-top 16px |
| 375px 宽基准 | 可用宽 335px；内层卡片文字宽约 285px；描述允许 2–3 行 |
| 内容放大到 200% | 不固定卡片 height；标题、描述自然换行；按钮和底部操作不覆盖文字 |

断点优先级：先按宽度选布局，再在桌面 / 平板条件下应用短高度规则；移动端始终保留 64px 顶部间距。页面底部至少 24px 加安全区余量。

不要给桌面三张卡简单施加全局缩放来适配手机。手机上保留颜色、轮廓、层级与动效语法，允许构图变为可滚动纵向选择。

对应 CSS 补充：

```css
@media (min-width: 768px) and (max-width: 1199px) {
  .dsh-ref-options { grid-template-columns: 1fr; }
  .dsh-ref-option { padding: 32px 24px; min-height: 180px; }
}
@media (min-width: 768px) and (max-height: 779px) {
  .dsh-ref-onboarding { padding-top: 64px; }
  .dsh-ref-options { margin-top: 32px; }
  .dsh-ref-actions { margin-top: 48px; }
}
@media (max-width: 767px) {
  .dsh-ref-onboarding {
    padding: 64px 20px calc(24px + env(safe-area-inset-bottom, 0px));
  }
  .dsh-ref-question { font-size: 24px; line-height: 34px; }
  .dsh-ref-options, .dsh-ref-options[data-count="2"] {
    grid-template-columns: 1fr;
    gap: 16px;
    margin-top: 32px;
  }
  .dsh-ref-option { padding: 24px; min-height: 160px; border-radius: 20px; }
  .dsh-ref-option-description { font-size: 14px; line-height: 22px; }
  .dsh-ref-actions { margin-top: 32px; }
  .dsh-ref-primary { width: 100%; max-width: 360px; min-height: 48px; }
  .dsh-ref-footer { margin-top: 16px; }
}
```

## 11. 将风格迁移到其他界面

本节是借鉴原则，不是 SillyRealms 的已批准改版方案。

| 场景 | 保留 | 调整 |
| --- | --- | --- |
| 引导 / 模式选择 | 大留白、选择卡、单主操作 | 使用本指南基准比例 |
| 设置页 | 中性表面、文字层级、明确焦点 | 页面 padding 24–32px，组距 24–32px；不使用 224px 顶留白 |
| 工具面板 / 菜单 | 同色阶分层、细边、柔和入场 | 圆角 12–16px，内边距 12–16px；避免巨大卡片 |
| 内容库 | 克制彩色与边界 | 图片成为视觉重点时降低描边光晕，不能每张卡都常亮 |
| 长文 / 对话 | 柔白正文、稳定灰底 | 正文 16px 起、行高约 1.7；减少持续装饰和大面积动效 |
| 营销官网 | 官网展示配置、展示字体与章节节奏 | 可用产品演示；演示时间线与真实交互时长分开 |

与 Studio 对接前，沿用现有语义 token 职责。本次检查到 Studio 为 React + Vite + CSS Modules，已有 dark / light 主题、系统字体与 `--canvas`、`--surface`、`--text`、`--accent`、`--focus` 等变量。不要仅因参考文档存在而导入新的全局样式体系。

尤其注意：官网 `--ds-space-5=24px`，当前 Studio `--space-5=20px`；相同编号不是相同值。映射必须按语义与尺寸进行，不能去掉前缀后覆盖。蓝紫青类别色也不能直接全部映射到单一 `--accent`。

## 12. 还原与验收清单

### 12.1 按顺序校准

1. **轮廓**：关闭光晕，核对画布、标题、卡片、按钮的坐标与宽高。
2. **排版**：确认实际字体回退，核对字号、行高、换行与左对齐轴。
3. **色阶**：先画布与表面，再文字；不要先调蓝紫青。
4. **边缘**：默认 1px、选中 2px，边缘弧度和盒模型稳定。
5. **微光**：最后添加阴影；看起来像独立霓虹灯时降低透明度。
6. **状态**：单选、多选、hover、pressed、focus、disabled 各自检查。
7. **动效**：检查开始、中间、结束帧以及快速反复操作。
8. **窄屏和内容**：375px、短视口、长描述、200% 放大与 reduced motion。

### 12.2 可检查的通过标准

| 维度 | 标准 |
| --- | --- |
| 桌面几何 | 1280 × 820 下主要外框与第 3 节相差不超过 2px；光晕不计入盒尺寸 |
| 对齐 | 同排卡片图标、标题、描述基线一致；主按钮与页面标题共轴 |
| 排版 | 原始短文案不意外换行；字体差异不能靠水平拉伸解决 |
| 颜色 | 大面积不透明内部采样与指定 token 一致；不在抗锯齿边缘取样判断 |
| 选中 | 点击不引起卡片位移、尺寸改变或邻卡跳动 |
| 层级 | 主按钮的明亮实体与选项的彩色轮廓各自清晰 |
| 焦点 | 键盘可完成选择、继续、返回；焦点不被裁切且不与选中混淆 |
| 手机 | 375px 宽无横向滚动；所有内容和操作可到达；触控命中区至少 44px |
| 动效 | 无重播、排队、闪烁；减少动态效果时所有最终状态可用 |
| 内容压力 | 描述增加到三行、标题两行时不遮挡按钮或裁切信息 |

颜色采样应避开字形边缘、阴影和渐变；跨平台字体抗锯齿差异不宜用整图逐像素相等判定。渐变与阴影属于 R 近似还原，以整体方向、边缘厚度和亮度关系验收。

### 12.3 本次文档的验证记录

- 已确认两张原图尺寸为 2560 × 1640，并提取主要背景、表面、文字、图标与部分描边颜色。
- 已读取官网基础与组件 CSS，记录其中确定的 token 和动画定义。
- 已计算第 4.5 节所列不透明配色的对比度。
- 已检查 Studio 现有语义 token，文档未将参考值描述成已实施主题。
- 本次只新增参考文档和原图，不实施 UI；CSS 配方未作为实际页面渲染，不能据此宣称完成像素还原、浏览器兼容或无障碍验收。
- 官网实时动画与原应用的 hover / focus / reduced-motion 行为仍未实看验证。

## 13. 可直接使用的设计简报

> 设计目标为静谧未来感的暗色应用引导。使用 #26272D 画布、#2A2B2E 卡片、#F9FAFB 主文字和 #ADB2B9 说明文字。1280 × 820 基准下，内容最大宽度 1066px，标题 28/40、描述 16/24，选项卡最小高度 222px、圆角 28px、左右内边距 32px。卡片保持中性实底；蓝、紫、青用于图标和选中渐变轮廓，选中描边 2px，低透明度外晕，无持续旋转或呼吸。主按钮为 240 × 44px 柔白实心短圆角矩形。按本指南的颜色角色、状态矩阵与响应式规则实现；移动端改为纵向选择。入场采用 8px 小位移、320ms 柔和减速；状态反馈 120–200ms，减少动态效果时取消位移。先还原几何与排版，再添加颜色和微光。截图推算值和补全规则均按 R 处理，不宣称为官方源码参数。
