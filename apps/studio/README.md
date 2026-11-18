# SillyRealms Studio

SR 唯一第一方前端。世界卡、会话、预设、模型及默认配置接入真实 Server。作者舞台通过隔离 iframe 和统一 @sillyrealms/sdk 运行。

在仓库根目录：

```sh
pnpm install
pnpm dev:all
# Studio http://localhost:5174，Stage http://localhost:5175，API http://localhost:3000
```

生产运行：`pnpm build && pnpm start`，访问 http://localhost:3000。单独开发可用 `pnpm dev` 和 `pnpm dev:studio`。Studio 代理可通过 SR_STUDIO_SERVER_URL 配置。

检查：`pnpm --filter @sillyrealms/studio typecheck`、`pnpm build`、`pnpm test:browser`。UI 浏览器回归连接运行中的 Studio 和真实只读数据，需要已有世界卡、预设、模型及可运行的介绍组件；不创建业务数据、不调用模型。支持 `STUDIO_URL`、`CHROME_PATH`，截图路径由测试输出。组件、主题与验收规则见 [UI SPEC](../../docs/design/UI-SPEC.md)。

单文件旧 UI 需要显式离线转换；v4 的组件库和介绍/开局文本在备份后自动迁移到 v5。见 [组件契约](../../docs/design/world-components.md)。单文件迁移工具默认只检查。

平台视觉与作者组件的职责边界见 [设计规范](../../docs/design/README.md)。

会话 Stage 与详情的介绍、开局预览共用独立静态资源服务：生产默认端口 3001（`SILLYREALMS_STAGE_PORT`），开发默认 5175（`SR_STUDIO_STAGE_PORT`）。`pnpm dev:studio` 同时启动两套前端监听；`pnpm dev:all` 再启动 Server。局域网访问沿用浏览器当前 hostname，需开放主站和 Stage 两个端口。端口占用会使启动失败，不自动换端口。

HTTPS 反向代理部署可设置 `SILLYREALMS_STAGE_ORIGIN=https://stage.example.com` 和 `SILLYREALMS_HOST_ORIGIN=https://app.example.com`，分别代理到 Stage 和主站端口；保留响应安全头，Stage 必须与主站不同源且使用 HTTPS。Stage 无业务 API，不能将其所有请求代理到主站。

图片继续直接加载原始 URL；缓存遵循源站响应头。Stage 保留 `sandbox="allow-scripts allow-same-origin"` 及原有 CSP，页面重试保留平台草稿，不重复发送消息。

详情预览使用独立的 `world-component.html` 只读入口，主站不提供该入口。详情按世界及组件源码在内存中复用最近 4 张卡的编译结果，切换仍重建文档并停止旧媒体；刷新清空编译缓存。角色等静态文档不受此次优化影响。
