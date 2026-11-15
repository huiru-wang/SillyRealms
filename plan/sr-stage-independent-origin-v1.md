# SR Stage 浏览器图片缓存优化 v1

日期：2026-11-15。状态：已按用户确认的最小方案实施，自动化验证通过。

## 用户目标与已确认边界

再次进入会话或普通刷新时，符合缓存条件的图片可以复用浏览器缓存，减少重复下载。会话界面和世界卡图片 URL 保持不变。

用户已明确修正原方案：目标不是让世界卡拥有普通网页的全部能力。本文替代此前“取消 sandbox / 删除 CSP”的实施内容；采用 **独立来源 + sandbox="allow-scripts allow-same-origin" + 保留原有 CSP**。

只优化会话 Stage 和其中的消息组件。介绍、开局预览和静态文档维持原隔离方式。SDK、世界卡 Schema、数据库和图片加载地址不变；不增加图片代理、自建缓存、Service Worker 或资源下载服务。

## 已验证原因

Chrome 157.0.8103.52 的隔离实验及真实 SR 临时会话均已复现：当前 `allow-scripts` 的 opaque origin 在 iframe 重建后不能复用测试图片缓存；只删除 CSP 或只改变端口均无效。独立来源配合 `allow-same-origin` 后，保留原 CSP，重建与普通刷新均命中缓存。图片成功解码，并同时以图片服务器请求计数、传输正文大小和 Resource Timing 验证。

测试使用 262,263 字节的可控 HTTPS 图片，`Cache-Control: public, max-age=3600`。这不承诺第三方源站的 no-store 图片、过期资源或被浏览器淘汰的缓存仍能命中，也不承诺离线缓存。

## 运行方式与所有权

- 生产主站默认 3000，Stage 静态监听默认 3001；复用同一 Node 进程和 Studio 构建产物，仅有一套数据库和 Runtime。
- 开发主站默认 5174，Stage 默认 5175；`pnpm dev:studio` 同时管理两套前端，`pnpm dev:all` 再管理 Server。
- 配置：生产 `SILLYREALMS_STAGE_PORT`、开发 `SR_STUDIO_STAGE_PORT`；可选公开来源 `SILLYREALMS_STAGE_ORIGIN`。反向代理的可信主站来源为 `SILLYREALMS_HOST_ORIGIN`。
- 主站公开只读 `/api/v1/runtime/web-config`，沿用 HTTP envelope，返回 `stage: {origin,port,entryPath}`。开发由 Vite 提供对应开发配置。
- 无显式 Stage origin 时沿用浏览器 hostname/protocol 并替换端口，支持局域网地址；HTTPS 主站拒绝 HTTP Stage。同源、非法配置直接报错，不降级到同源 iframe。
- Stage 仅提供 `/frame.html` 和构建资产，不提供业务 API 或 SPA fallback；主站不提供会话 `frame.html`。原预览入口增加响应头强制 sandbox 和可信祖先约束，避免脱离正常 Host 嵌入时成为主站代码执行入口。
- 保留 Stage 原有 CSP，包括 connect-src none、资源来源和表单限制。服务端拒绝已配置的 Stage 来源直接访问业务接口。没有新增账户或身份系统。
- Host 继续持有 HTTP/SSE、当前 session、草稿、输入与设置。SDK 契约与权威状态归属不变。共享 Stage origin 的浏览器存储不构成世界之间的隔离。

## 通信、失败与退出

Host 从 iframe load 发出明确来源的 probe，再完成 ready/connect/ack 握手；两端校验 origin/source/nonce。Stage URL 中的 hostOrigin 与挂载 nonce 仅用于握手，不是 API 凭据。

Stage 导航和重试关闭旧通道，忽略过期响应；未派发的异步发送在通道失效后不再提交。已被 Server 接受的操作不能靠关闭 MessagePort 撤销，不重发。字号、主题和底部布局变化只同步消息，不改变 Stage 地址。

加载或握手超时显示舞台重试入口。重试只重建 Stage，保留 Host 草稿、设置和会话生命周期。独立打开 Stage 显示未连接提示。

双监听都启动成功才打印可用日志；失败关闭已启动监听，关闭 SQLite 并释放锁。退出继续遵守既有 Run 收尾和 3.5 秒期限，统一关闭两套监听。开发子进程失败或退出统一回收其余进程。

## 执行任务与验收

1. 服务与配置：独立静态监听、来源和端口验证、入口分离、统一启动退出；覆盖非法配置、路径绕过、Stage 无 API、主站无 renderer、写请求拒绝和重启。
2. Host/Stage 接入：独立地址、sandbox、明确来源握手、旧通道失效、超时重试；验证主界面无法直接访问、SDK 保持正常。
3. 开发与部署：双 Vite、独立缓存目录、主站 proxy、开发配置和双服务管理；原 CSP 不为 HMR 或演示整体放开。
4. 浏览器验收：真实 SR 临时会话和可控 HTTPS 图片，验证首次下载、离开再进入、普通刷新、舞台重试及草稿保留；回归官方/自定义舞台、消息组件、状态、发送/停止、历史、字号与主题，375/1280 视口。
5. 文档与复核：同步相关 AGENTS、SDK 展示契约及运行说明；执行 typecheck/lint/test/build/browser，单独复核边界和失败路径，记录结果。

## 回退

原子恢复旧的同源 Stage 地址和 `sandbox="allow-scripts"`，保留原 CSP，并恢复对应握手与服务路由；不得把新 sandbox 配置用于同源页面。关闭新增监听。不清理数据库、世界卡或用户浏览器存储。

## 实施验收记录（2026-11-15）

- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。构建仍有大 chunk 提示，本次没有增加依赖或进行打包重构。
- `pnpm test`：58 个测试文件、302 项通过；最终来源配置与双监听修改另以 `pnpm --filter @sillyrealms/server exec vitest run test/stage-origin.test.ts test/server-restart.test.ts` 复验，5 项通过。
- `node apps/studio/tests/visual/production.mjs`：真实 API/SSE、官方/自定义 Stage、状态与消息组件、发送/停止、预览只读边界、375/1280 布局，以及新增缓存/断连重试检查通过。
- `node apps/studio/test/composer/run.mjs`：开发双来源下输入、SDK、恢复和切换会话通过；`SR_BROWSER_ONLY=worldstory-font node apps/studio/test/composer/run.mjs` 的长历史字号与滚动回归通过。
- `node apps/studio/test/world-document/run.mjs`：正文清洗、文档 iframe、消息 Portal、主题和对白回归通过。
- 缓存证据：测试 HTTPS 图片正文 262,263 字节，首次传输 262,563 字节（含计量开销）；离开再进入和普通刷新均为 0，舞台重试后图片服务器仍只收到一次请求。图片成功解码，父 DOM 访问被拒绝，Stage 直接业务写请求返回 403。
- 已检查 375/1280 的断连界面截图，草稿保留、无横向溢出。浏览器套件的 Enter 字符与点击焦点模拟已修正，未改动角色业务行为。
- 测试使用 Chrome 157、本机隔离数据库、临时 HTTPS 图片服务和离线 Provider；未使用用户数据库或付费模型。手机局域网实机、其他浏览器及真实 HTTPS 反向代理未实测；地址解析和 HTTPS 配置拒绝由单元测试覆盖。

## 后续已授权范围：详情介绍与开局缓存（2026-11-15）

本节扩展前文仅会话 Stage 的初始范围。用户要求只优化世界卡详情的介绍、开局；角色/世界书/无组件开局的静态文档与会话编译行为保持不变。

- 复用现有独立资源服务承载 `/world-component.html`，不增加端口或配置。主站拒绝该入口（含编码/规范化路径），独立服务仍无业务 API。保持预览原 CSP，响应头和 iframe 均采用 `sandbox="allow-scripts allow-same-origin"`。
- 预览通过现有 web-config 构造独立 URL，Host 与 iframe 双向校验 origin/source/nonce，通过专用 MessageChannel 维持只读全局状态权限。页面导航使旧通道失效，错误允许显式重试。
- Host 中仅详情预览按世界 ID 和完整源码快照复用进行中/完成的编译，最多保留 4 张最近使用世界卡；源码变化失效，失败及带编译错误的结果不保留。编译结果不在 Host 执行，不持久化到浏览器存储。组件实例、世界状态和媒体播放不缓存。
- 该资源 origin 与现有 Stage 共用，不构成世界间或作者组件之间的独立安全域；它们与可信 Host 保持跨来源隔离，平台权限仍由各自 Host 桥校验。
- 验收：介绍→开局一→开局二→切回→离开重进→普通刷新→失败重试，同一可缓存图片只下载一次；编译复用/源码失效/失败重试/容量限制测试；只读权限、主界面隔离与旧媒体文档卸载回归；开发及生产资源入口一致。

### 详情扩展验证记录

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过；`pnpm test` 59 个文件、306 项通过。编译缓存测试覆盖并发复用、重新获取同一世界、源码/ID/集合变更、失败重试、旧失败不删除新结果及 4 项容量限制。
- Chrome 详情缓存回归：介绍、开局一、开局二、切回开局一、切回介绍、离开重进、普通刷新、导航失败后重试共 8 次展示，受控图片只下载一次（262,263 字节正文），后 7 次 Resource Timing transferSize 为 0；结果见 `apps/studio/tests/visual/output/preview-cache.json`。
- 保留只读全局查询、禁止 session/message 查询和写入、禁止业务 HTTP、跨来源主界面隔离，以及切换时重置组件局部状态并卸载旧媒体文档。375/1280 开局截图检查未发现新增布局问题。
- `node apps/studio/test/composer/run.mjs`、`SR_BROWSER_ONLY=worldstory-font node apps/studio/test/composer/run.mjs`、`node apps/studio/test/world-document/run.mjs` 通过。测试开发模式下预览入口由独立服务提供、Host 拒绝原入口。
- 浏览器测试只信任临时图片证书的 SPKI，不修改系统证书。此前全局忽略证书错误会让 Chrome 丢弃 HTTP 缓存条目，导致只能偶尔命中内存缓存；已修正测试环境。依据：[Chromium 缓存写入逻辑](https://chromium.googlesource.com/chromium/src/+/e1a1e32cffe70c41199d38b333283031a64e6772/net/http/http_cache_transaction.cc)、[测试证书指纹验证逻辑](https://chromium.googlesource.com/chromium/src/+/HEAD/services/network/ignore_errors_cert_verifier.cc)。
- 最终完整 `node apps/studio/tests/visual/production.mjs` 通过，包含详情缓存全部 8 个步骤、原有 Stage 回归、详情/会话流程及当前模型页测试；刷新验收等待新 iframe nonce，避免误读刷新前的文档。复查已确认 Host 不执行作者源码、两端握手精确校验且只读权限不变。
