# Web

- 本项目仅对接 Server：世界内容库、预设、模型配置、设置、会话运行。世界详情只允许名称、标签及默认配置管理；角色、开局、世界书、状态定义和组件只读。会话路由挂载 SessionPage，只调用 Server 已实现的接口。
- 复用本项目的 components/ui、styles/theme.ts 和 tokens.css，遵守 docs/design/UI-SPEC.md。业务对接不顺带重做视觉系统。
- API 使用 /api/v1、驼峰 CRUD 结构、data.item 单项和 items/hasMore/nextCursor 分页。预设文件协议仅用于导入导出，不渗透编辑器状态。
- 列表读取摘要；详情按需加载。分页错误可重试，切换查询时取消过期请求；不使用详情 N+1 或把第一页当完整选择目录。
- 预设草稿与已保存基线分离，导航保留草稿；保存提交 expectedRevision，冲突时保留草稿并明确提示，重新读取需确认丢弃修改。
- 模型密钥只在输入时提交，不读取、存入 localStorage 或模拟连通性；默认值通过 ManagementData 统一同步。设置允许 null，PATCH 只提交变化字段。
- 模型目录读取 Server 的 provider 分组，先选 provider 再选 SDK 模型，切 provider 清空模型；不手填目录标识或自行推断 SDK 能力。选中模型以紧凑参数区展示上下文/输出/推理/有效思考档位/协议/输入/缓存，缺失数据明确未提供。保留旧配置目录缺项时的既有值，禁止加载或重试覆盖编辑草稿。
- 不保留初始化向导、setup 入口或依赖默认模型/凭据的准入判断。应用可直接进入管理页；默认数据只由 Server 启动时幂等补齐。
- 会话页由 workspace 组合 features/narrative、history、state、worlds、suggestions；通过服务端提交/停止模型运行，加载已保存历史与会话事件。世界和玩家身份创建后只读。
- 开发端口 5176，代理默认 127.0.0.1:3001，可配置 SR_WEB_SERVER_URL。启动和断点调试见[根目录 README](../../README.md)，部署边界见[管理工作区](../../docs/runtime/web-management.md)。
- 本轮只运行函数测试和类型检查，不启动服务，不增加浏览器/链路 mock 验证环境。

- 世界与会话共用 CreateSessionDialog；世界默认显式为空时不从应用设置补值，创建必须提交 openingId，由服务端原子初始化状态并保存首条消息。ManagementData 同步目录、会话数量和本次文件清理重试入口。
- 世界管理表单分离基线与草稿，只提交变化字段及 expectedRevision，冲突保留修改。资源走 /api/v1/worlds/:id/resources/，不请求 runtime/web-config。
- 作者预览使用独立 origin（默认 5177）、独立构建 dist-preview 和只读 global bridge；管理页默认 5176。预览无 API 代理，不与管理页同源，不开放模型、消息、会话或写操作。部署约束见管理工作区文档。

- 管理列表沿用现有布局，不添加常驻世界搜索表单或会话世界选择器；关联会话保留 worldId 导航上下文。弹窗恢复鼠标焦点时不显示键盘焦点环，键盘导航的焦点提示必须保留。

- 世界详情以本模块的 WorldDetailPage.tsx / WorldDetailPage.module.css 为 UI 基线，完整保留折叠头部、角色条同步、六个图标 Tab、开局导航、弹窗和滚动交互；禁止用新面板布局替换。只适配 V2 顶层领域字段、分页、刷新和管理写入约束。
- 世界入口在头部选择角色，创建确认沿用该角色；提交当前 openingId 和角色，开局名称可作为会话标题；全局会话入口增加开局选择，单个默认选中、多个要求选择。创建后进入会话舞台，消息与正则组件替换统一在独立来源 frame 渲染，不增加开场标记或专用分支。名称标签在更多菜单弹窗编辑，默认项在运行配置 Tab 编辑。

- 隔离 world-preview 服务/构建同时提供 frame.html 与 world-component.html，管理来源拒绝这两个入口。runtime/config 使用明确的 stage.origin/entryPath/debug，不接受 port 推导。SessionPage 挂载 stage-host/StageHost；后者只管理 iframe、受限 bridge 和外观，不保存业务状态，不因 frame 重载停止生成。

## 会话运行与 Stage SDK

- Server 是唯一业务契约：提交 input.text + expectedTipEntryId，返回 runId/userEntryId/assistantEntryId；叙事路径 /sessions/:id/narrative，状态路径 /state/global|session|message。不恢复旧路径或伪造请求去重、能力开关和旧运行状态。用量面板复用 V1 UI 和粒度，只读取 Server 已记录用量及 latestContext；系统/摘要/历史组成按实际编译字节和约定消息开销计算，不冒充逐类计费 Token。模型配置变化后刷新 usage，未知数据保留未知。
- history 只维护已保存 entries 与分页；narrative 只维护活跃运行和临时输出；workspace 组合展示投影。run.delta.snapshot 整体替换临时消息，只有查询确认的 entries 才接管为保存消息。compaction 不渲染为气泡，但其 seq 与真实 tip 必须保留。
- session-events 保持一条会话 SSE，显式注册当前事件并按订阅分发；一个监听者失败不影响其他消费者。断线只标记不连续，不重发生成。先建立连接再分页补查历史，覆盖原活跃轮次的末条 seq；读取代次防止迟到响应覆盖新事件。
- state feature 负责三作用域读写与消息数组归一化。path:"" 替换整个 scope，null 保留普通值；PATCH success 可能是忽略，写后通过补读/真实事件同步，禁止按提交值乐观造状态。真实 tip 变化后再确认 message 状态。
- suggestions 独立消费 action_suggestions.created，run.created 清空；恢复只取最新 run 的有效完成结果，无建议不回找更早轮次。读取 actionSuggestions 的整体 status/items，不依赖逐项 results；history 向 Stage 透传 output，状态诊断使用每项带 status 的 stateUpdate.updates。旧格式由服务端读取投影归一化，前端不另做兼容。
- stage-host 校验 origin/source/nonce、消息大小与命令白名单；session/world/tip 绑定由可信页面提供。frame 无直接业务 HTTP 权限。作者预览保持只读 global；会话 stage 通过受限命令提供 send/stop/history/state 写入。
- V2 frame 与作者类型共用 SDK 根入口。getRuns 使用 narrative/runs 的原生分页契约。StageRuntime 只接收不可变投影、转发命令和原生事件；官方 WorldStory 保留展示/滚动，不能再独立拉取和归并运行。messageRender 匹配在 frame 的有界 Worker 中执行。
- 不提供重新生成、失败重试、历史回退和生成中编辑。设置生成中禁用业务配置修改，字号等阅读外观可独立调整。移动会话页隐藏主导航底栏，保留返回会话列表入口。
- 验证使用函数级注入端口、typecheck 和两个静态构建，不启动真实服务/浏览器/模型或读取 Keychain。集成说明见 ../../docs/runtime/web-runtime.md。
