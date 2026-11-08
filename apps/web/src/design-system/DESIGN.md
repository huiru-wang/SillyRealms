# SillyRealms 设计系统 V2

## 设计定位

- **严谨但有温度、现代、适中留白**。工作台借鉴 Linear 的秩序、层级和克制，不模仿营销页面。
- **核心目标是立刻进入故事**。配置项默认继承；主操作「开始故事」「继续故事」高于管理配置。
- 设计仅约束 **平台 UI**（导航、世界库、预设、模型、会话 Host 和输入框）。世界卡作者 iframe 拥有自己的样式与 React 树，平台只传递 SDK / 必要主题信息。

## 技术基线

React 19 / Vite / CSS 自定义属性，保留原有 style.css，新增 tokens.css + studio.css。
本项目没有在平台页面使用 Tailwind 工具类编译；theme.css 仅提供可选 Tailwind v4 映射，不是平台样式入口。
Token 源文件为 design-tokens.json，按语义映射到 tokens.css。

## 设计约束

1. **层级**：一个页面有一个最主要操作，其他使用中性描边、文字按钮或菜单。
2. **文字**：正文使用 14–16px，字号从 12/14/16/18/20/24/30 选择。UI 用 400/500 与 650 两个主权重组。正文每行约 45–75 个字符。
3. **颜色**：三层正文文字 primary/secondary/muted，语义上的 success/warning/danger 均由完整文字和图标共同表达。全部真实前景/背景组合需达到 WCAG 4.5:1（大字 3:1）。
4. **间距**：4/8/12/16/24/32/48/64px；组内间距小于组间间距。
5. **圆角**：6/10/14/18px，输入 8–10px，卡片 10–14px，面板不夸张。
6. **阴影**：卡片通常只依赖表面和边框，只有悬浮、弹窗使用提升层级的阴影。深色主题使用表面明度表达深度。
7. **动效**：150–200ms，以状态反馈为主；支持 prefers-reduced-motion。
8. **响应式**：375/768/1280px 回归；手机上主操作始终可见，重要控件至少有足够触控空间。

## 产品约定

- 全局默认预设和模型在导入世界时复制到世界默认；创建会话时复制到会话。不存在动态回退。更换已有世界的默认值不改变已有会话。
- 编辑被多个会话引用的**共享预设内容**可能影响这些会话后续生成，不能与切换会话关联 ID 混为一谈。
- 世界详情在角色列表选择可扮演角色，在开局页切换开局并开始会话；默认预选第一位可扮演角色和第一个开局。运行配置页设置世界的新会话默认预设和模型。
- 运行时页面只保留平台状态、切换配置、设置和发送；创作者 UI 不由平台二次包装主题。
- 空状态不是一句「没有内容」，而是说明原因、下一步操作，隐藏无意义筛选器。
- 删除等破坏性操作不作为列表的主操作。
- 所有可编辑组件均需 loading/error/disabled/focus 状态。不要用 alert 作为新功能的标准错误展示方式。

## 新组件开发

从 app/ui.tsx 的数据读取、标题、搜索、加载、错误和空状态开始复用；平台页面使用语义 Token。缺失变量时先补充设计 Token，再开发组件。勿在组件中添加随意 hex/px；不要将平台 CSS 注入创作者 iframe。

## 验证

```bash
pnpm --filter @sillyrealms/web build
pnpm --filter @sillyrealms/server exec vitest run --maxWorkers=4
python3 /Users/wanghuiru/.codex/skills/refactoring-ui/scripts/check_contrast.py --matrix apps/web/src/design-system/design-tokens.json
```
