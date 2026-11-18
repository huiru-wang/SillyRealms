# StudioV2

- 本项目仅对接 ServerV2：世界内容库、预设、模型配置、设置、基础会话。世界详情只允许名称、标签及默认配置管理；角色、开局、世界书、状态定义和组件只读。保留的运行时文件不挂载或主动请求接口。
- 复用本项目的 components/ui、styles/theme.ts 和 tokens.css，遵守 docs/design/UI-SPEC.md。业务对接不顺带重做视觉系统。
- API 使用 /api/v1、驼峰 CRUD 结构、data.item 单项和 items/hasMore/nextCursor 分页。预设文件协议仅用于导入导出，不渗透编辑器状态。
- 列表读取摘要；详情按需加载。分页错误可重试，切换查询时取消过期请求；不使用详情 N+1 或把第一页当完整选择目录。
- 预设草稿与已保存基线分离，导航保留草稿；保存提交 expectedRevision，冲突时保留草稿并明确提示，重新读取需确认丢弃修改。
- 模型密钥只在输入时提交，不读取、存入 localStorage 或模拟连通性；默认值通过 ManagementData 统一同步。设置允许 null，PATCH 只提交变化字段。
- 会话页面不挂载 SessionHost、不调用模型、不初始化开场，不加载 runtime、历史或事件流。世界和玩家身份创建后只读。
- 开发端口 5176，代理默认 127.0.0.1:3001，可配置 SR_STUDIO_V2_SERVER_URL。命令与边界见 ../../docs/runtime/studio-v2-management.md。
- 本轮只运行函数测试和类型检查，不启动服务，不增加浏览器/链路 mock 验证环境。

- 世界与会话共用 CreateSessionDialog；世界默认显式为空时不从应用设置补值，创建不传 openingId。ManagementData 同步目录、会话数量和本次文件清理重试入口。
- 世界管理表单分离基线与草稿，只提交变化字段及 expectedRevision，冲突保留修改。资源走 /api/v1/worlds/:id/resources/，不请求 runtime/web-config。
- 作者预览使用独立 origin（默认 5177）、独立构建 dist-preview 和只读 global bridge；管理页默认 5176。预览无 API 代理，不与管理页同源，不开放模型、消息、会话或写操作。部署约束见管理工作区文档。

- 管理列表沿用原 Studio 的布局，不添加常驻世界搜索表单或会话世界选择器；关联会话保留 worldId 导航上下文。弹窗恢复鼠标焦点时不显示键盘焦点环，键盘导航的焦点提示必须保留。

- 世界详情以原 Studio 的 WorldDetailPage.tsx / WorldDetailPage.module.css 为 UI 基线，完整保留折叠头部、角色条同步、六个图标 Tab、开局导航、弹窗和滚动交互；禁止用新面板布局替换。只适配 V2 顶层领域字段、分页、刷新和管理写入约束。
- 世界入口在头部选择角色，创建确认沿用该角色；开局名称可作为会话标题，但不提交 openingId 或初始化开局。名称标签在更多菜单弹窗编辑，默认项在运行配置 Tab 编辑。
