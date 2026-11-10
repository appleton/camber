#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "$script_dir/.." && pwd)"
host="${CAMBER_MLX_SIDECAR_HOST:-127.0.0.1}"
port="${CAMBER_MLX_SIDECAR_PORT:-48888}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
models_dir="${CAMBER_LOCAL_INFERENCE_MODELS_DIR:-${OSU_MODELS_DIR:-$config_home/camber/models}}"
default_model="${CAMBER_LOCAL_INFERENCE_MODEL:-poolside/Laguna-XS-2.1-NVFP4-mlx}"
api_key="${CAMBER_MLX_SIDECAR_API_KEY:-local-dev}"

# The helper gives a launched sidecar 45s to become ready; when the build
# lock is held by another worktree, give up inside that budget so this exits
# cleanly rather than being SIGKILLed mid-wait. (The helper reports a generic
# readiness failure either way — the lock message reaches its debug logs —
# but a clean exit leaves no orphaned processes behind.)
export CAMBER_MLX_SIDECAR_LOCK_TIMEOUT_SECONDS="${CAMBER_MLX_SIDECAR_LOCK_TIMEOUT_SECONDS:-30}"

# Run from a per-worktree copy of the products: launching straight out of the
# shared scratch would let a rebuild from another worktree overwrite the
# binary under a running sidecar. build.sh installs the copy while it still
# holds the build lock.
run_dir="$package_dir/.build/dev-run"
"$script_dir/build.sh" "$run_dir" >/dev/null

cd "$run_dir"
if [[ $# -gt 0 ]]; then
  exec "$run_dir/camber-mlx-sidecar" "$@"
fi

exec "$run_dir/camber-mlx-sidecar" \
  --host "$host" \
  --port "$port" \
  --models-dir "$models_dir" \
  --default-model "$default_model" \
  --api-key "$api_key" \
  "$@"
