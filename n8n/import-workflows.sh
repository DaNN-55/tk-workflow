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
export N8N_USER_FOLDER="$project_root/n8n/runtime"

"$node_binary" "$n8n_entrypoint" import:workflow --separate --input="$script_dir/workflows"
