# Studio 设计系统实施任务

状态：已完成本轮实施和 Chrome 回归。现行标准：[UI SPEC](../docs/design/UI-SPEC.md)。方案：[studio-design-system.md](./studio-design-system.md)。

| ID | 实施结果 |
|---|---|
| DS-01 | 完成五主入口、详情、会话宿主与共享控件审查；保留既有业务及 Server V2 修改 |
| DS-02 | 基础尺度、语义颜色、组件尺寸、材质、状态、阅读与媒体 token 集中定义 |
| DS-03 | 内置主题、受限颜色覆盖、派生值、对比度校验、原子应用和本地回退已实现 |
| DS-04 | Button、IconButton、ActionLink、UploadButton 支持独立等级／意图／尺寸；共享忙碌、禁用、焦点样式 |
| DS-05 | Field、Input、Textarea、Select、Switch 已接入；策略选择保留原生 radio 语义，未另建没有调用点的 Checkbox/Radio 抽象 |
| DS-06 | 复用 SessionRow、Panel，列表选中与整行反馈使用语义颜色；保留各列表必要的业务信息结构 |
| DS-07 | Modal、Select 弹层、菜单材质和反馈语义已统一；会话删除确认改用共享 Modal |
| DS-08 | 五主入口及更多页接入 PageHeader；标题位置和页面 inset 统一 |
| DS-09 | 预设／模型工作区断点统一；详情导航、滚动尾部和紧凑开局栏回归通过 |
| DS-10 | Host 与隔离渲染器共用完整外观快照；WorldStory line 映射修复，同 mode 主题热切换有效 |
| DS-11 | 清理被替代的样式和历史设计参考；docs/design 改为现行 SPEC，AGENTS.md 引用规范 |
| DS-12 | 恢复有效的 test:browser / test:visual 入口，新增主题单元测试；以真实页面只读回归代替新增展示路由 |

## 验证结果

- `pnpm --filter @sillyrealms/studio build`：通过，包含 TypeScript 检查；Vite 仍提示现有主 bundle 超过 500 kB。
- `pnpm test:browser`：通过。4 个主题测试及真实页面浏览器回归。
- 五主入口在浅色／深色、320／375／820／1280px 下标题锚点、操作高度与横向边界一致。
- Select 的 Escape 与焦点、模型弹窗的焦点归还、会话删除取消流程通过。
- 世界／预设／模型详情保留底栏背后的内容及滚动尾部，开局工具栏完整显示。
- 同为 dark 的两套自定义强调色可热更新已有介绍 iframe；会话 Stage 的 light/dark 外观和 `--sr-story-line` 映射通过。
- 使用独立 Chrome 临时 profile；没有业务数据写入、导入、生成或服务商测试调用。
- 移动尺寸为 Chrome 仿真，未进行 iOS Safari 真机验收。

## 范围边界

自定义主题编辑器、主题市场、服务端主题同步、任意 CSS 注入不在本轮实现内。作者卡片的美术和明确指定的样式保持独立。共享 recipe 和语义 token 已建立，后续新增控件遵守 SPEC，不要求不同职责的控件具有相同外观。
