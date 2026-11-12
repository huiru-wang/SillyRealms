# Studio 世界卡列表与详情接入方案 v1

> 状态：2026-11-13 已按用户确认实现世界列表、详情及世界内会话的只读接入，并直接使用 SDK 文档渲染。Studio 进入逐步替换 Web 阶段；世界内会话暂不可点击，其他样板功能仍未接入。本文件保留实施前的分析与建议，若与本状态说明冲突，以本状态说明和代码为准。

## 1. 用户路径与范围

用户从世界卡列表读取自己的世界，按已有标签筛选、分页浏览，选择卡片进入详情；详情读取该世界的真实简介、角色、世界书、开局和状态定义。界面沿用 Studio 已确认的 AppShell、侧栏、世界详情 A/B 布局和移动端交互。读取中、无数据、错误、已删除及坏数据均提供明确反馈。

本阶段优先**只读接入世界列表、详情、标签及世界内会话列表**，不暗示会话创建、导入、删除、配置修改、Provider 或新版 `SR.WorldStory` 已接入。现有静态演示的按钮和字段在真实数据路径中不能伪装成已保存、已导入或真实运行；可明确禁用、标注待接入或暂时移出相应入口，具体文案在视觉设计确认时确定。

世界详情 UI 按已有用户要求继续设计：不在每个 tab 重复显示其标题；开局以左右切换方式浏览，保留可操作按钮及键盘、触屏方式；世界 `description`、角色 `description`、开局 `content` 和世界书正文可为 Markdown/HTML 混合内容。开局预览是静态文档，创建会话后的开局作为 AI 消息走正常消息展示规则。角色 `description` 面向用户；`prompt` 仅在模型上下文中按规则使用，不在页面上代替介绍展示。

## 2. 代码证据与接口现状

以下为当前代码行为，不是建议新增的实现。所有普通 JSON API 外层由 `responseEnvelope` 统一包装为 `{success,errorCode,errorMessage,data}`；成功时 `errorCode:null,errorMessage:""`。错误状态同时参考 HTTP 状态和 `errorCode`，`data` 可能为 null 或安全详情；下载原始源文件/导出成功时不采用该信封。网络中断、非 JSON、非法信封分别处理，不在日志中输出世界卡原文、prompt、密钥或完整 payload。

### 2.1 GET /api/v1/worlds

- 响应 `data` 为 `{items,hasMore,nextCursor}`；每项是 `{id,name,createdAt,updatedAt,tags,cover,defaultPresetId,defaultApiModelConfigId,sessionCount}`。`tags` 是 `{id,name}[]`；`cover` 和默认配置可能为 null；`sessionCount` 是服务端按世界统计的真实数量。
- `limit` 默认 20，整数范围 1–100；可使用多次 `tagId`、`match=all|any`（默认 all）和 `query`（世界名称的 SQLite `instr` 子串匹配）。列表按 `updated_at DESC,id DESC` 排序。
- `cursor` 绑定资源类型、查询文本、去重排序后的标签 ID 和 match 模式，不应解析或在筛选条件之间复用。筛选改变后清空旧项目与 cursor 并从第一页开始；错误页可重试，避免并发追加重复。
- 无效查询、标签或 cursor 由路由返回 422 的标准错误信封，按实际 `errorCode` 区分。不能把失败当作空列表，也不能回落到 fixtures。
- 列表没有 `genre`、世界完整 `summary/description` 或会话预览；现有 Studio 的固定类型/分类和卡片说明是演示数据，不应嫁接为真实数据。

证据：`apps/server/src/domain/tags.ts` 的 `targetRoutes`；`apps/server/test/catalog-flow.test.ts`。

### 2.2 GET /api/v1/tags?type=world

成功 `data` 为 `{items:[{id,type,name,sort_order,created_at,updated_at}]}`，服务端按 `sort_order,name,id` 排序。Studio 筛选应使用实际 tag ID 和 name；“全部”仅是客户端的无过滤状态，不是硬编码世界类型。当前页面单选筛选可以传一个 `tagId`，多选、搜索及标签排序是否展示由后续产品设计决定，不从 API 有能力推断 UI 已批准。

### 2.3 GET /api/v1/worlds/:id

成功 `data` 为 `{item,warnings}`，其中 `item` 为 `{id,spec,spec_version,data,defaultPresetId,defaultApiModelConfigId,createdAt,updatedAt}`；`item.data` 是规范化世界卡，含 `name`、可选 `summary/description/cover`、`characters`、`openings`、可选 `lorebook/state/message_render/ui/extensions` 及名称字符串数组 `tags`。列表的 `tags:{id,name}[]` 与详情 `data.tags:string[]` 必须分别建模，不假定同形；详情不直接提供 `sessionCount`。

卡片导入校验要求至少一个可扮演角色和一个开局，但客户端仍要对空值/字段缺失和非法响应有安全降级，不把 UI 防护当作服务端校验。世界不存在返回 404 `WORLD_NOT_FOUND`；读取/校验异常返回 422（例如 `WORLD_CORRUPT`），不能自行修复或回退样板数据。

`state` 为声明结构，不等同于正在运行会话的权威状态值。`message_render`/`ui` 是世界卡数据；世界详情的静态文档不能执行作者代码、消息组件或运行消息规则。

证据：`apps/server/src/routes/worlds.ts`、`apps/server/src/repositories/world-repository.ts`、`apps/server/src/domain/world-card.ts`、`docs/technical/worldstory-runtime-v1.md`。

### 2.4 GET /api/v1/sessions

接口返回按 `updated_at DESC,id DESC` 排序的 `{items,hasMore,nextCursor}`，每项含 `id,worldId,presetId,apiModelConfigId,title,updatedAt,worldName,cover`。可选 `worldId` 在服务端分页前过滤，未知世界 ID 返回空列表，空白 ID 返回 400 `INVALID_REQUEST`。游标绑定筛选条件，跨世界或与无筛选查询混用返回 400 `INVALID_CURSOR`；无筛选旧游标保持兼容。当前没有消息摘要或预览字段，不能将样板文本当作真实消息。

进入世界详情后按当前世界 ID 请求此接口并分页；加载、空列表、错误及重试分别处理。世界详情接口不内嵌会话，列表和详情按各自请求状态独立呈现。当前分页仍先读取该筛选范围的全部会话再在内存中分页，大量会话场景可后续单独优化，不改变现有游标契约。

### 2.5 邻接而非本阶段实现的接口

`POST /api/v1/worlds/import` 接受 `FormData.file`，10 MiB 上限；`PATCH /worlds/:id` 更新默认预设/模型；`DELETE /worlds/:id` 会删除该世界及关联会话和 entries；`GET /worlds/:id/source` 返回原始导入文件、`/export` 返回重建卡片；`POST /sessions` 创建会话并要求 `worldId,openingId,userCharacterId` 和可用配置。它们影响文件、数据和使用者流程，需各自设计、测试和明确范围，不因列表读取而自动启用。

## 3. Studio 前端结构建议

沿用 React、Vite、TypeScript、CSS Modules 和现有语义 tokens；不引入新的跨平台包、全局状态库或网络依赖。建议按真实需求渐进增加，文件名可随实现微调：

```text
apps/studio/src/
  app/                       # 路由、AppShell；不写业务请求细节
  lib/http/                  # 统一 fetch、信封校验、ApiError、取消和安全 URL
  features/worlds/
    api/                     # 列表、详情、标签请求及 wire 类型
    model/                   # DTO -> 展示模型、筛选与角色/开局选择
    hooks/                   # 列表分页、详情读取和请求状态
    components/              # 世界卡、角色、开局等世界域组件
    WorldLibraryPage.tsx
    WorldDetailPage.tsx
  components/ui/             # 通用按钮、弹窗、加载/错误等基础组件
  fixtures/                  # 测试及显式静态设计入口；不混入真实数据路径
```

当前将最小传输、信封与世界域 API 放在 `features/worlds/api/`，不提前建立跨域抽象；世界域 API 不依赖 React。页面负责组合及交互，复用现有组件/token。是否提取跨应用共享契约推迟到两个真实消费者和兼容规则清晰时评估。

状态归属：URL 路由携带真实 world ID；筛选、分页、读取状态由世界域持有；选中章节、展开/收敛、角色/开局索引是页面状态；真实世界和会话由 Server 权威管理。请求使用 AbortController 与请求序号，避免切换世界、筛选、卸载或重复请求后旧响应覆盖新页面；失败重试保留有效上下文。分页请求每个查询只有一个进行中的“加载更多”，cursor 不混用。

### 安全渲染与现有边界

世界、角色、开局、世界书内容来自不可信世界卡。用户已批准 Studio 直接引入 SDK 的 `WorldDocumentRenderer`，沿用净化和无脚本隔离，不执行世界卡自定义 UI 或消息组件；Studio 的语义文字颜色映射至文档渲染器。此接入不代表故事舞台或 `SR.WorldStory` 已更新。

## 4. 本地开发与网络

Studio Vite 使用 5174，将 `/api`、`/health` 代理到本机 3000；开发环境可用 `SR_STUDIO_SERVER_URL` 指定其他 Server 地址。Server 启动时将检测到的 LAN IPv4 对应 Server 端口、5173 和 5174 加入允许 Origin，环回地址有单独规则。Studio 使用同源相对路径 `/api/v1/...`，不在前端环境变量中放置密钥。

回环和局域网代理的允许来源、以及其他来源的拒绝行为需要分别验证；不能通配来源或绕过 Origin 检查。网络地址变化后需重启 Server 以重新检测地址。

Server 目前默认只托管 `apps/web/dist`；Studio 生产构建如何托管、路径及同源路由属于后续明确设计，不因本地代理而宣称生产可用。保持原有 LAN 文档与安全约束，实际实施若改变网络行为应同步更新相关文档。

## 5. 页面行为与故障边界

- 世界列表：首屏加载、无世界、筛选无结果、追加加载、标签读取失败、分页失败和重试分别表达；保留已加载数据时明确错误，避免展示成空结果。
- 世界详情：路由切换时先隔离旧世界数据；请求加载、404、422 坏数据、Server 离线及安全渲染失败要有明确反馈和返回/重试。详情页不得把固定示例角色或剧情展示为实际数据。
- 展示字段：卡片名称、封面、标签、会话数用列表实际值；摘要只在详情返回时使用，缺少封面/简介有稳定空态；角色、开局按真实 ID/数据，保留当前章节与角色选择语义；当数据刷新删除所选 ID 时选择有效项或给出空态。
- 点击角色显示 `description` 的呈现、可扮演角色选择、开局左右切换与移动端滑动规则需要按用户要求先设计并验收；不能只把预览字符串或 `prompt` 当介绍。保留当前顶部展开/收敛、滚动和角色锚点等已确认交互。
- 真实数据不可用时不静默回退示例；不得在用户真实数据库上执行导入、删除、迁移或真实 Provider 调用作为验证。

## 6. 实施顺序与测试

任务拆解见 [任务清单](sr-studio-world-api-integration-v1-tasks.md)。先完成字段与交互确认、只读连接和错误边界，再实现列表与详情；富文本依赖仍需独立确定，不夹带高风险的 Session/SDK 改造。

使用 Server 的临时隔离数据库、临时数据目录和固定测试世界卡；验证列表空、过滤分页、详情结构、404/422、错误信封、离线、请求竞态、换路由取消、空字段与资源异常。浏览器验证 1536/1280/768/390/375px，检查侧栏、A/B 收敛、角色切换、开局选择、长文和富文本净化/隔离、深浅主题、键盘和 reduced motion。针对世界会话的查询、创建和多分页场景需在对应后续范围验证。

执行时分别检查 Studio 的 `typecheck`、`build`、`test:visual`，按需运行 Server 有关测试；根目录 `pnpm typecheck/build/test` 当前脚本并不覆盖 Studio 的全部检查，不能以其代替。测试不得读取真实用户内容、覆盖既有用户文件或发起付费模型调用。

## 7. 待确认决策

1. 已确定世界列表、详情及其中会话列表只读接入；会话不可点击进入，导入和会话创建不在本阶段。
2. 已批准 Studio 直接使用 SDK 静态文档组件，`SR.WorldStory` 后续优化。
3. 已确定需要 LAN 开发访问；Server 仅增加本机检测到的 IPv4 对应 Studio 5174 来源。
4. Studio 开始逐步替换 Web，其他原型页面不能视为已接入真实数据。
