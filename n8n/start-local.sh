#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
project_root="${script_dir:h}"
brew_prefix="$(brew --prefix)"
node_binary="$brew_prefix/opt/node@22/bin/node"
n8n_entrypoint="$brew_prefix/lib/node_modules/n8n/bin/n8n"
simdjson_dylib="$(otool -L "$node_binary" | awk '/libsimdjson\./ { print $1; exit }')"

if [[ ! -x "$node_binary" || ! -f "$n8n_entrypoint" ]]; then
  print -u2 "缺少 Node 22。请先执行 brew install node@22。"
  exit 1
fi

if [[ -n "$simdjson_dylib" && ! -f "$simdjson_dylib" ]]; then
  simdjson_dylib="$(find -L "$brew_prefix/Cellar/simdjson" -type f -name "${simdjson_dylib:t}" -print | sort | tail -n 1)"
fi

export PATH="$brew_prefix/opt/node@22/bin:$brew_prefix/bin:/usr/bin:/bin"
if [[ -n "$simdjson_dylib" ]]; then
  export DYLD_LIBRARY_PATH="${simdjson_dylib:h}${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi
export LOOP_PROJECT_ROOT="$project_root"
export N8N_USER_FOLDER="$project_root/n8n/runtime"
export N8N_HOST="127.0.0.1"
export N8N_LISTEN_ADDRESS="127.0.0.1"
export N8N_PORT="${N8N_PORT:-5678}"
export N8N_PROTOCOL="http"
export N8N_SECURE_COOKIE="false"
export N8N_DIAGNOSTICS_ENABLED="false"
export N8N_PERSONALIZATION_ENABLED="false"
export N8N_TEMPLATES_ENABLED="false"
export N8N_PUBLIC_API_DISABLED="true"
export N8N_UNVERIFIED_PACKAGES_ENABLED="false"
# 仅信任本机 Owner：其可编辑工作流并因此可配置命令节点；n8n 仍只监听 127.0.0.1。
# 本项目的四条工作流只调用 n8n/run-orchestrator.sh，切勿把此实例暴露给不受信任的用户或网络。
export NODES_EXCLUDE=""
export N8N_BLOCK_ENV_ACCESS_IN_NODE="true"
export N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS="true"
export N8N_DEFAULT_BINARY_DATA_MODE="filesystem"
export EXECUTIONS_DATA_PRUNE="true"
export EXECUTIONS_DATA_MAX_AGE="168"

mkdir -p "$N8N_USER_FOLDER"
exec "$node_binary" "$n8n_entrypoint" start
