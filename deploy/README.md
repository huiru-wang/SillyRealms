# Linux 单机部署

在使用 systemd 的 Linux 服务器安装 Node.js 22.19+、pnpm 10.12.1、Nginx、Git、curl 和 flock。以 root 进入仓库的 main 分支，首次传入客户端实际访问的两个地址。以下 IP 为示例。

```bash
WEB_ORIGIN=http://203.0.113.10 STAGE_ORIGIN=http://203.0.113.10:8081 ./deploy.sh
```

旧服务器首次切换时，先在干净的 main 分支执行 `git pull --ff-only origin main` 获取新入口。以后在仓库根目录执行：

```bash
./deploy.sh
```

脚本从 origin 快进到最新 main，准备数据目录和主密钥，安装锁定依赖，构建主站与舞台。systemd 托管单个后端，Nginx 提供两个独立来源并在主站代理 API。脚本验证后端、主站和舞台后报告成功。后端重启会中断正在执行的请求。

## 配置与数据

- 默认数据目录为仓库的 `data/`，包含 SQLite、导入的世界和模型密文。主密钥位于 `/etc/sillyrealms/credential.key`，仅在首次部署生成。已有密文而主密钥缺失时，先恢复原密钥。
- 成功后保存 `/etc/sillyrealms/deploy.json`。已有部署配置、主密钥和 systemd 服务可复用；数据目录仅在数据库符合当前结构时可继续使用。备份时同时保存整个数据目录和 `/etc/sillyrealms/`。如果之前自定义过 `SR_CONFIG_DIR`，每次执行都要指定原目录。
- 自定义路径和端口可设置 `SERVER_DATA_ROOT`、`STATIC_ROOT`、`NGINX_DIR`、`SERVER_PORT`。环境变量优先于已保存的值。Nginx 服务须使用该目录下的 nginx.conf，并在 http 块包含 conf.d/*.conf 和 mime.types。
- 主站与舞台使用不同的端口或域名。HTTPS 首次部署还需设置 `WEB_TLS_CERT`、`WEB_TLS_KEY`、`STAGE_TLS_CERT`、`STAGE_TLS_KEY`；使用私有 CA 时用 `TLS_CA_FILE` 指定部署检查所需的 CA 文件。公网访问需通过已有的访问控制入口。
- 当前版本使用数据库 v14。旧 v1–v13 数据库会在启动时明确拒绝，不执行迁移或自动删除。按当前格式重新开始时，先备份原数据，再通过 `SERVER_DATA_ROOT` 指定一个新的空目录；保留原目录及主密钥。部署失败后根据报错修正配置，再执行同一命令；若配置或服务已切换，需要手动恢复或重新部署。

## 检查与日志

```bash
./deploy.sh --check
systemctl status sillyrealms nginx
journalctl -u sillyrealms -n 80
```

首次运行 `--check` 也需传入两个来源。该选项读取本机部署配置并检查工具，无需更新仓库或启停服务。
