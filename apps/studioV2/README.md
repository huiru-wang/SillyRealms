# SillyRealms StudioV2

独立对接 ServerV2 的管理前端：世界内容库、预设、模型配置、设置、基础会话。世界作者内容只读，不挂载 runtime。

在仓库根目录分别运行：

```sh
pnpm dev:server-v2
pnpm dev:studio-v2
pnpm dev:world-preview-v2
```

StudioV2 默认 http://127.0.0.1:5176，API 默认 http://127.0.0.1:3001。代理地址可通过 SR_STUDIO_V2_SERVER_URL 配置；服务端数据目录由 SERVER_V2_DATA_ROOT 配置。不会复用旧 Server 的数据库。模型凭据默认使用 macOS Keychain。

函数测试：`pnpm test:studio-v2`。类型检查：`pnpm --filter @sillyrealms/studio-v2 typecheck`。本轮不启动服务或执行浏览器/链路验证。

范围和数据行为见 [管理工作区](../../docs/runtime/studio-v2-management.md)，接口见 [ServerV2 HTTP](../../docs/runtime/server-v2-http.md)，视觉规范见 [UI SPEC](../../docs/design/UI-SPEC.md)。

作者组件预览默认使用独立来源 http://127.0.0.1:5177，管理和静态内容不依赖它。生产构建分别输出 dist 与 dist-preview，必须分开来源部署；来源配置和 CSP 约束见管理工作区文档。
