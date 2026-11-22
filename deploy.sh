#!/usr/bin/env bash
set -euo pipefail

die() { echo "[SR deploy] $*" >&2; exit 1; }

provision_key() (
  local key=$1 credentials=$2 temporary
  if [[ -e $key || -L $key ]]; then
    [[ -f $key && ! -L $key && -O $key && -n $(find "$key" -perm 0600 -size 32c -print) ]] ||
      die "已有 credential.key 必须是当前用户拥有、0600 权限的 32 字节普通文件"
    return
  fi
  if [[ -e $credentials || -L $credentials ]]; then
    [[ -d $credentials && ! -L $credentials ]] || die "凭据目录无效：$credentials"
    local existing
    existing=$(find "$credentials" -mindepth 1 -print -quit)
    [[ -z $existing ]] || die "已有加密凭据但主密钥缺失，请恢复 credential.key"
  fi
  temporary=$(mktemp "$(dirname "$key")/.credential.key.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  head -c 32 /dev/urandom > "$temporary"
  ln -- "$temporary" "$key"
)

check_tools() {
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' ||
    die "需要 Node.js 22.19 或以上版本"
  [[ pnpm@$(pnpm --version) == "$(node -p 'require("./package.json").packageManager')" ]] ||
    die "请使用 package.json 声明的 pnpm 版本"
  nginx -v
}

install_managed() {
  local source=$1 destination=$2 mode=$3
  if [[ -e $destination || -L $destination ]]; then
    [[ -f $destination && ! -L $destination ]] || die "不能覆盖：$destination"
    case "$(head -n 1 "$destination")" in
      '# Managed by SillyRealms.'|'# Managed by SillyRealms deploy/start.sh.') ;;
      *) die "同名文件不属于本部署：$destination" ;;
    esac
    if cmp -s "$source" "$destination"; then return; fi
  fi
  install -m "$mode" "$source" "$destination"
}

probe() {
  local origin=$1 path=$2 loopback=127.0.0.1
  shift 2
  local -a args=(--noproxy '*' -sS --max-time 5)
  [[ $origin != *'://['* ]] || loopback='[::1]'
  if [[ $origin == https:* && -n $TLS_CA_FILE ]]; then args+=(--cacert "$TLS_CA_FILE"); fi
  curl "${args[@]}" --connect-to "::$loopback:" "$@" "$origin$path"
}

deploy() (
  check_tools
  umask 077
  local work site path attempt
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  node deploy/config.mjs "$work" > "$work/settings"
  source "$work/settings"

  [[ ! -L $CONFIG_DIR ]] || die "配置目录不能是符号链接：$CONFIG_DIR"
  mkdir -p -- "$CONFIG_DIR" "$SERVER_DATA_ROOT"
  chmod 0700 "$CONFIG_DIR"
  provision_key "$CONFIG_DIR/credential.key" "$SERVER_DATA_ROOT/credentials"

  echo '[SR deploy] 安装依赖并构建主站和舞台'
  CI=true pnpm install --frozen-lockfile --prod=false
  VITE_WEB_ORIGIN="$WEB_ORIGIN" VITE_WORLD_PREVIEW_ORIGIN="$STAGE_ORIGIN" NODE_ENV=production pnpm build
  [[ -f apps/server/node_modules/tsx/dist/loader.mjs ]] || die '后端 tsx loader 缺失'

  site="$NGINX_DIR/conf.d/sillyrealms.conf"
  mkdir -p -- "$NGINX_DIR/conf.d"
  if [[ -f $site ]]; then cp -p "$site" "$work/previous.conf"; fi
  install_managed "$work/sillyrealms.conf" "$site" 0644
  if ! nginx -T -c "$NGINX_DIR/nginx.conf" > "$work/nginx-active" ||
     ! grep -Fxq "# configuration file $site:" "$work/nginx-active"; then
    if [[ -f $work/previous.conf ]]; then cp -p "$work/previous.conf" "$site"; else rm -f "$site"; fi
    die "请检查 Nginx 配置及 $site 的 include 路径"
  fi
  install_managed "$work/server.env" "$CONFIG_DIR/server.env" 0600
  install_managed "$work/sillyrealms.service" /etc/systemd/system/sillyrealms.service 0644
  systemctl daemon-reload
  systemctl restart sillyrealms.service
  curl --noproxy '*' -fsS --retry 30 --retry-connrefused --retry-delay 1 --max-time 3 \
    "http://127.0.0.1:$SERVER_PORT/health" | node -e '
      const health = JSON.parse(require("fs").readFileSync(0));
      if (health.success !== true || health.data?.ok !== true) process.exit(1);'

  node deploy/static.mjs "$STATIC_ROOT" "$SERVER_DATA_ROOT" "$CONFIG_DIR" "$NGINX_DIR"
  systemctl reload-or-restart nginx.service
  for attempt in {1..10}; do
    if probe "$WEB_ORIGIN" /api/v1/runtime/config --fail | node -e '
      const config = JSON.parse(require("fs").readFileSync(0));
      if (config.data?.stage?.origin !== process.argv[1]) process.exit(1);' "$STAGE_ORIGIN" &&
      probe "$WEB_ORIGIN" / --fail > /dev/null && probe "$STAGE_ORIGIN" /frame.html --fail > /dev/null &&
      probe "$STAGE_ORIGIN" /world-component.html --fail > /dev/null; then break; fi
    [[ $attempt != 10 ]] || die '主站或舞台检查失败，请检查 Nginx 配置及服务日志'
    sleep 1
  done
  for path in /frame.html /world-component.html; do
    [[ $(probe "$WEB_ORIGIN" "$path" -o /dev/null -w '%{http_code}') == 404 ]] || die "主站暴露了舞台页面 $path"
  done
  for path in /api /api/v1/runtime/config; do
    [[ $(probe "$STAGE_ORIGIN" "$path" -o /dev/null -w '%{http_code}') == 404 ]] || die "舞台暴露了 API $path"
  done
  systemctl enable sillyrealms.service nginx.service
  install -m 0600 "$work/deploy.json" "$CONFIG_DIR/.deploy.json.new"
  mv -fT "$CONFIG_DIR/.deploy.json.new" "$CONFIG_DIR/deploy.json"
  echo "[SR deploy] 已部署 $(git rev-parse --short HEAD)  主站 $WEB_ORIGIN  舞台 $STAGE_ORIGIN"
)

update_and_deploy() {
  echo '[SR deploy] 更新到 origin/main'
  node deploy/update.mjs "$PWD"
  # Git may have replaced this script. Run the fetched version under the same lock.
  exec bash -c 'source ./deploy.sh; deploy'
}

main() {
  cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")"
  local usage='用法：./deploy.sh [--check|--help]；首次设置 WEB_ORIGIN 和 STAGE_ORIGIN'
  [[ $# -le 1 ]] || die "$usage"
  case "${1:-}" in
    --help) echo "$usage"; return ;;
    --check) check_tools; node deploy/config.mjs; return ;;
    '') ;;
    *) die "$usage" ;;
  esac
  [[ $(uname -s) == Linux && $EUID == 0 ]] || die '请在使用 systemd 的 Linux 服务器以 root 执行'
  mkdir -p /run/lock
  exec 9>/run/lock/sillyrealms-deploy.lock
  flock -n 9 || die '已有部署在运行'
  update_and_deploy
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
