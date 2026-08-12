#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
project_root="${script_dir:h}"
worker_env="$script_dir/worker.env.local"

if [[ ! -f "$worker_env" ]]; then
  print -u2 "缺少 n8n/worker.env.local。请从 worker.env.example 创建本机凭据文件。"
  exit 1
fi

export LOOP_PROJECT_ROOT="$project_root"
set -a
source "$worker_env"
set +a

cd "$project_root"
exec npm run orchestrator:run -- "$@"
