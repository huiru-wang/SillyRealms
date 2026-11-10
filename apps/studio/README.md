# SillyRealms Studio

新一代 SR 平台 UI 设计验证工程。只包含静态 React 页面、本地 fixture 和视图状态，**不连接 SR Server**，不修改现有 apps/web。

## 运行

- `pnpm install`（仓库根目录）
- `pnpm --filter @sillyrealms/studio dev`
- 打开 http://localhost:5174/worlds
- `pnpm --filter @sillyrealms/studio typecheck`
- `pnpm --filter @sillyrealms/studio build`

## 原则

- 两张最新聊天原型：展开版为视觉基准；收起版为交互结构参考。
- 先还原真实 UI 再形成规范；现有 Web 的旧 CSS / tokens 不导入 Studio。
- 全部页面共用 AppShell，统一使用语义色彩 Token；组件内部只管局部样式。
- 首页封面来自仓库已有首页截图的临时提取图，正式还原应替换成 8 张独立封面原图。
- /lab/colors 是可切换色调的设计实验区；明色为辅助试验，当前主基准是暗色。
- 设计 Demo 不提供业务保存、真实导入、账号或模型连接。
