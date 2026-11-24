# 本地运行与开发

[项目首页](../../README.md) · [快速体验](../getting-started.md) · [文档首页](../README.md)

本页记录开发启动、部署入口、调试和数据管理。第一次游玩可先阅读快速体验。

## Linux 服务器部署

首次配置主站与舞台地址后，在仓库根目录运行 `./deploy.sh` 即可拉取最新代码、构建并启动服务。首次命令、数据与主密钥路径见 [单机部署](../../deploy/README.md)。

## 本地启动

使用 Node.js 22.19 或更高版本和 pnpm 10.12.1。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

本机打开 [Web 主站](http://127.0.0.1:5176)。同一局域网内的手机或电脑打开终端里标为「Web 主站」的局域网 IPv4 地址（5176）。Web 和舞台分别监听 TCP 5176、5177，主机防火墙需要允许这两个端口。API 和 Node 调试器仅监听本机。主站可直接管理本机数据，请在可信网络中使用。按 Ctrl+C 一起停止三个进程。

| 进程 | 默认端口 | 职责 |
| --- | --- | --- |
| Web 主站 | 5176 | 管理页面和会话宿主，将 `/api` 转发到 Server |
| Server API | 3001 | 处理业务请求、SSE 和持久化 |
| 隔离舞台 | 5177 | 提供会话的 `frame.html` 和世界详情的 `world-component.html`。作者组件在单独的浏览器来源运行 |

## 运行与调试

| 根目录命令 | 用途 |
| --- | --- |
| `pnpm dev` | 日常开发，前端热更新，后端监听源码改动 |
| `pnpm debug` | 启动同一套开发环境，开启舞台诊断和 Node 调试器 |
| `pnpm build` | 构建 Web 主站到 `apps/web/dist`，构建隔离舞台到 `apps/web/dist-preview` |
| `pnpm start` | 本地运行已构建的两个前端产物和 TypeScript 后端。首次使用或更新前端后先执行 `pnpm build` |
| `pnpm dev:server`、`pnpm dev:web`、`pnpm dev:stage` | 分别启动一个开发进程，便于单独排查 |

**后端断点。** 运行 `pnpm debug` 后，用编辑器的 Node Attach 连接 `127.0.0.1:9229`，在 `apps/server/src` 中设置断点。服务直接开始监听。编辑源码触发重启时，支持自动重连的调试器可继续使用。

**前端与舞台。** 在浏览器开发者工具中选择 5176 的主文档调试平台 UI，选择 5177 的 iframe 调试舞台或作者组件。调试模式下，`GET /api/v1/runtime/config` 返回 `debug: true`，官方舞台会展示消息携带的数据处理结果。若只需在本地构建产物中查看该面板，可执行 `SERVER_DEBUG=true pnpm start`。叙事执行日志在普通和调试模式下都输出到服务端终端。

## 内置预设与世界卡

Server 在监听前读取仓库的 [初始化资源清单](../../initial-data/manifest.json)。首次启动会安装「标准叙事」和「小饭馆」。每次启动按 ID 补齐缺项，已安装世界的进度、会话、文件与用户编辑过的预设继续保留。删除清单内的世界后，下次启动会从原包新建该世界，已删除的进度和会话无法借此恢复。手动导入的同名世界拥有独立 ID。

增加资源时，把导出的预设 JSON 放入 `initial-data/presets/`，或把世界卡 ZIP 放入 `initial-data/worlds/`，在清单对应数组中填写固定的 `id` 和文件名 `file`，并将两者一同提交。ID 使用小写字母、数字、下划线或连字符，以小写字母或数字开头。顶层 `defaultPresetId` 指定新建应用设置的默认预设。更换同一 ID 的资源文件只影响后续新装或补建的副本。

启动错误会标出失败条目。修复文件后重启即可继续。如果数据库缺少世界记录，但数据根目录已存在同 ID 的世界目录，先备份数据库和目录，核对后移开残留目录再重启。

## 配置与检查

- 默认数据根目录是仓库的 `data/`。SQLite 位于 `data/database.sqlite`，导入的世界卡原件与解包资源位于 `data/worlds/<worldId>/`。备份时应一并保存数据库和世界卡目录。
- 可通过 `SERVER_DATA_ROOT` 指定自定义绝对路径。已有部署若继续使用原目录，可将此变量指向该目录。迁移到新目录前先停止后端并整体移动数据；模型密钥按目录关联到 macOS Keychain，已有模型配置需在新目录下重新保存密钥。
- `SERVER_PORT` 设置 API 监听端口，Web 的默认代理随之调整。显式设置 `SR_WEB_SERVER_URL` 可覆盖代理目标。
- 外部部署时主站和舞台各用一个来源。前端来源变量在构建时生效，服务端在启动时读取配置。来源配对与 CSP 配置见 [Web 部署说明](web-management.md#作者内容预览与部署)。
- `pnpm test` 执行前后端测试，`pnpm test:web` 单独执行前端函数测试，`pnpm typecheck` 检查两端类型，`pnpm lint` 检查后端规则。
