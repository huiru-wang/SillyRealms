# SR Linux 服务器部署

使用 **Nginx + 单个 systemd 后端服务**。源码与数据保留在 `/root/<项目目录>`，主站和舞台的静态文件发布到 `/var/www/sillyrealms`，Nginx 配置安装到 `/etc/nginx/conf.d/sillyrealms.conf`。

## 前置条件

服务器使用 Linux 与 systemd，以 root 执行。先安装：

- Node.js **22.19.0 或更高版本**。
- 仓库声明的 pnpm **10.12.1**。
- Nginx，且系统中已有 `nginx.service`。
- `curl`、`flock`（通常由 util-linux 提供）。

脚本会安装项目依赖和构建产物；操作系统软件、DNS、证书与网络入口由服务器环境提供。由于后端通过 tsx 运行 TypeScript，安装会保留开发依赖。

Nginx 主配置的 `http {}` 中需要包含以下内容，常规系统安装通常已经具备：

```nginx
include /etc/nginx/mime.types;
include /etc/nginx/conf.d/*.conf;
```

脚本检查实际 `nginx.service` 的配置路径，并验证站点文件确实被 include。不会覆盖其他站点或替换整份 `nginx.conf`。

## 首次一键启动

例如项目已经放在 `/root/SillyRealms`。将下面示例地址 `203.0.113.10` **替换为客户端实际访问的服务器 IP**：

```bash
cd /root/SillyRealms
WEB_ORIGIN=http://203.0.113.10 STAGE_ORIGIN=http://203.0.113.10:8081 bash deploy/start.sh
```

主站使用 80 端口，舞台使用 8081，后端仅监听 `127.0.0.1:3001`。服务器的防火墙与安全组需要允许实际选用的两个 Nginx 端口。

项目路径自动取脚本所在仓库，不要求目录名一定叫 SillyRealms。首次必须提供两个来源；来源不能带路径、结尾斜杠、查询参数或用户名密码。两个来源必须不同；不同端口或不同域名均可。HTTPS 主站必须使用 HTTPS 舞台。

只检查配置、Node、pnpm 和 Nginx，不写文件、不构建、不启停服务：

```bash
WEB_ORIGIN=http://203.0.113.10 STAGE_ORIGIN=http://203.0.113.10:8081 bash deploy/start.sh --check
```

首次成功后，配置保存到 `/etc/sillyrealms/deploy.json`。后续直接执行：

```bash
cd /root/SillyRealms
bash deploy/start.sh
```

更新代码后也执行同一个命令。代码更新由你自行完成；脚本不会拉取、清理或重置 Git 工作区。

## 一次执行做什么

1. 获取全局部署锁，检查版本、来源、路径、端口及 Nginx 系统服务。
2. 执行 `pnpm install --frozen-lockfile --prod=false` 与 `pnpm build`，构建时注入正确的主站和舞台来源。
3. 将 `apps/web/dist` 与 `apps/web/dist-preview` 复制到按内容哈希命名的静态发布目录。相同产物重复执行会复用同一个目录。
4. 首次生成独立主密钥，生成后端环境文件、systemd unit 和 Nginx 站点配置。
5. 通过 `nginx -t`，确认站点被主配置实际包含，然后启动或重启同一个 `sillyrealms.service`。
6. 等待后端健康检查成功，原子切换静态 `current` 指向，启动或平滑重载 Nginx。
7. 检查主站页面、runtime config、两个舞台页面，以及舞台不能访问 API、主站不能执行舞台文档的隔离规则。
8. 设置后端与 Nginx 开机自启，保存本次公开部署配置。

**幂等范围：** 不产生重复后端进程、不重复追加 Nginx 配置、不重建数据库、不覆盖已有主密钥；相同前端产物不重复创建发布目录。每次仍会校验依赖、构建并重启同一个后端服务，运行中的叙事会按已有关闭流程结算。

失败时恢复本次改动的服务配置与静态入口，并尝试恢复服务原运行状态；保留原错误和恢复失败信息。**这不是整套应用版本回滚**：源码和 `node_modules` 为原地更新，数据库与密钥不会回滚或清空。不同内容的旧静态发布目录会保留，重复的相同内容不会增加目录。

## 路径与进程

| 项目 | 默认位置 |
| --- | --- |
| 源码 | 脚本所在的仓库，例如 `/root/SillyRealms` |
| SQLite、导入世界等数据 | `<仓库>/data` |
| Linux 模型密钥密文 | `<数据目录>/credentials` |
| 部署配置 | `/etc/sillyrealms/deploy.json` |
| 后端环境 | `/etc/sillyrealms/server.env` |
| 主密钥 | `/etc/sillyrealms/credential.key`，32 字节、0600 |
| Nginx 站点 | `/etc/nginx/conf.d/sillyrealms.conf` |
| systemd unit | `/etc/systemd/system/sillyrealms.service` |
| 主站静态入口 | `/var/www/sillyrealms/current/web` |
| 舞台静态入口 | `/var/www/sillyrealms/current/stage` |
| 日志 | systemd journal |

只有一个后端进程，与项目的 SQLite、内存锁和 SSE EventHub 语义一致。Nginx 直接读取发布后的静态文件，因此不需要放开 `/root` 的访问权限，也不运行两个 Vite preview 进程。

Nginx 保留 `/api/v1/...` 请求路径与 Host，关闭 API 响应缓冲和压缩以支持 SSE，设置 300 MiB 请求上限以容纳当前 256 MiB 世界包及 multipart 开销。主站支持 SPA 路由；舞台仅提供独立静态产物，并设置限制宿主来源的 CSP。HTML 不长期缓存，带哈希的静态资源长期缓存。

## 配置覆盖与 HTTPS

配置读取顺序为：默认值 → 已保存的 `deploy.json` → 本次显式环境变量。也可参考 `deploy/deploy.example.json` 创建 JSON 配置。

| 环境变量 | JSON 字段 | 默认/说明 |
| --- | --- | --- |
| `WEB_ORIGIN` | `webOrigin` | 首次必填 |
| `STAGE_ORIGIN` | `stageOrigin` | 首次必填 |
| `SERVER_PORT` | `serverPort` | 3001 |
| `SERVER_DATA_ROOT` | `dataRoot` | `<仓库>/data` |
| `STATIC_ROOT` | `staticRoot` | `/var/www/sillyrealms`，需为独立静态目录 |
| `NGINX_DIR` | `nginxDir` | `/etc/nginx`，必须与 nginx.service 实际配置一致 |
| `WEB_TLS_CERT` / `WEB_TLS_KEY` | `webTlsCert` / `webTlsKey` | 主站 HTTPS 证书与私钥绝对路径 |
| `STAGE_TLS_CERT` / `STAGE_TLS_KEY` | `stageTlsCert` / `stageTlsKey` | 舞台 HTTPS 证书与私钥绝对路径 |
| `TLS_CA_FILE` | `tlsCaFile` | 可选 CA 证书文件绝对路径，用于本机 HTTPS 部署检查 |
| `SR_CONFIG_DIR` | 不保存在 JSON 中 | `/etc/sillyrealms`；改变后每次需显式指定 |

所有目录和证书路径使用无空格的规范绝对路径。HTTPS 示例（替换域名和证书路径）：

```bash
WEB_ORIGIN=https://sr.example.com STAGE_ORIGIN=https://stage.example.com WEB_TLS_CERT=/etc/letsencrypt/live/sr.example.com/fullchain.pem WEB_TLS_KEY=/etc/letsencrypt/live/sr.example.com/privkey.pem STAGE_TLS_CERT=/etc/letsencrypt/live/stage.example.com/fullchain.pem STAGE_TLS_KEY=/etc/letsencrypt/live/stage.example.com/privkey.pem bash deploy/start.sh
```

证书需要预先准备；脚本不申请证书。两个域名可以同用 443 端口，同一证书覆盖两个域名时也可以提供相同路径。部署完成检查通过本机回环地址连接 Nginx，并保留域名/SNI 与证书校验；不代表外部 DNS、防火墙或安全组已经配置完成。

如果源站使用 Cloudflare Origin CA 等非系统公共信任链签发的证书，提供 `TLS_CA_FILE=/etc/nginx/ssl/origin-ca.pem`（对应签发 CA 的证书文件）。脚本先检查文件可读，再为本机 HTTPS 检查传入 `curl --cacert`；域名、证书链与有效期校验保持启用。该设置仅用于部署检查，不改变 Nginx 服务端证书或应用的模型请求；成功后保存在部署 JSON 中，后续执行自动复用。

## 模型密钥与备份

当前本地启动使用 macOS Keychain。服务器入口 `deploy/server.mjs` 利用已有 `startServer({credentialStore})` 注入 Linux 部署适配，不改变本地开发入口或业务模块。

密钥使用 AES-256-GCM 加密、随机 nonce 与凭据引用绑定；密文目录 0700，文件 0600。重复部署不会轮换主密钥。检测到已有密文但主密钥缺失时会停止并要求恢复，避免生成一把无法解密旧数据的新密钥。

备份时同时保存 **整个数据目录、部署配置与 credential.key**。macOS Keychain 中的已有 API Key 不会自动迁移，迁移到 Linux 后在模型配置中重新保存。数据目录变化也会改变现有凭据引用命名空间，不要在更新部署时随意更换。

当前 SR 没有内置用户登录鉴权，Origin 检查只约束浏览器来源。示例用于可信网络；通过公网访问时，应在现有 VPN、访问网关等入口落实访问控制。

## 运维命令

```bash
systemctl status sillyrealms nginx
journalctl -u sillyrealms -f
systemctl restart sillyrealms
systemctl stop sillyrealms
nginx -t -c /etc/nginx/nginx.conf
```

只停后端可执行 `systemctl stop sillyrealms`。不要直接执行 `node deploy/server.mjs`，systemd 已提供 tsx loader 与所需环境变量。

## 本地验证

```bash
bash -n deploy/start.sh
node --test deploy/*.test.mjs
pnpm build
pnpm --filter @sillyrealms/server typecheck
pnpm --filter @sillyrealms/server lint
```

函数测试只使用临时目录，验证配置、发布幂等、入口切换与凭据保护，不启动服务或访问现有数据库、Keychain。实际部署流程需在目标 Linux 服务器运行。
