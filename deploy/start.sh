#!/usr/bin/env bash

# Parse the whole entrypoint before Git may replace this file during an update.
main() {
  set -euo pipefail
  local deploy_dir project_dir revision
  deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  project_dir="$(cd -- "$deploy_dir/.." && pwd -P)"
  if [[ "$#" -gt 1 ]] || [[ "$#" -eq 1 && "$1" != --help && "$1" != --check ]]; then
    echo "用法：bash deploy/start.sh [--check|--help]" >&2
    exit 1
  fi
  command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js >= 22.19.0。" >&2; exit 1; }
  case "${1:-}" in
    --help|--check) exec node "$deploy_dir/start.mjs" "$@" ;;
  esac

  [[ "$(uname -s)" == Linux ]] || { echo "实际部署需要使用 systemd 的 Linux 服务器；可先运行 --check。" >&2; exit 1; }
  [[ "$EUID" -eq 0 ]] || { echo "请以 root 身份运行（项目位于 /root）。" >&2; exit 1; }
  command -v flock >/dev/null 2>&1 || { echo "缺少 flock，请先安装 util-linux。" >&2; exit 1; }
  command -v git >/dev/null 2>&1 || { echo "缺少 git，请先安装并配置 origin 访问权限。" >&2; exit 1; }
  mkdir -p /run/lock
  exec 9>/run/lock/sillyrealms-deploy.lock
  flock -n 9 || { echo "已有 SR 部署正在运行，请待其完成后重试。" >&2; exit 1; }
  export SR_DEPLOY_LOCK_HELD=1
  echo "[SR deploy] 拉取并快进到 origin/main"
  revision="$(node "$deploy_dir/update.mjs" "$project_dir")"
  export SR_DEPLOY_REVISION="$revision"
  # Load the newly fetched deployment code only after a successful update.
  exec node "$deploy_dir/start.mjs"
}

main "$@"
