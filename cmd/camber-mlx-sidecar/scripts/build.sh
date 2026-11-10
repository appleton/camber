#!/usr/bin/env bash
# Builds camber-mlx-sidecar and prepares its Metal libraries.
#
# Usage: build.sh [install-dir]
#
# With an install-dir, the binary and metallibs are copied there (while the
# build lock is still held, so a build in another checkout cannot mutate them
# mid-copy) and the install dir is printed on stdout. Without one, the SwiftPM
# bin path inside the shared scratch is printed instead — callers reading
# products straight out of it must tolerate concurrent rebuilds. All build
# output goes to stderr.
#
# The build uses a SwiftPM scratch path shared across checkouts (e.g. git
# worktrees), so heavy dependencies such as swift-syntax compile once per
# machine instead of once per worktree. A lock serializes concurrent
# invocations so parallel worktree builds don't oversubscribe every core.
# Override the location with CAMBER_MLX_SIDECAR_SCRATCH_PATH.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "$script_dir/.." && pwd)"
install_dir="${1:-}"
configuration="${CAMBER_MLX_SIDECAR_BUILD_CONFIGURATION:-release}"
cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
scratch_dir="${CAMBER_MLX_SIDECAR_SCRATCH_PATH:-$cache_home/camber/mlx-sidecar/scratch}"
export CAMBER_MLX_SIDECAR_SCRATCH_PATH="$scratch_dir"

# mkdir is atomic, so it doubles as a portable lock; a pid file lets waiters
# reclaim locks left behind by killed builds. Best-effort: two waiters
# reclaiming the same stale lock can in theory race each other past it, and a
# recycled pid can delay reclaim. SwiftPM's own scratch lock still serializes
# the compile in that case, but the patch and metallib steps would race
# unprotected — the window (moments after a build died) is accepted for what
# is a dev/CI convenience wrapper.
#
# CAMBER_MLX_SIDECAR_LOCK_TIMEOUT_SECONDS bounds how long to wait for the
# lock (empty = wait forever). dev-run.sh sets it so a sidecar launch blocked
# behind another worktree's build exits cleanly instead of being killed by
# the helper's readiness timeout mid-wait and leaving orphaned processes.
lock_timeout="${CAMBER_MLX_SIDECAR_LOCK_TIMEOUT_SECONDS:-}"
if [[ -n "$lock_timeout" && ! "$lock_timeout" =~ ^[0-9]+$ ]]; then
  echo "Ignoring non-integer CAMBER_MLX_SIDECAR_LOCK_TIMEOUT_SECONDS: $lock_timeout" >&2
  lock_timeout=""
fi
lock_waited=0
lock_dir="$scratch_dir.lock"
mkdir -p "$(dirname "$lock_dir")"
missing_pid_checks=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  lock_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  if [[ -n "$lock_pid" ]]; then
    missing_pid_checks=0
    if ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
  else
    # The owner writes its pid right after taking the lock; a lock that stays
    # pid-less was orphaned between mkdir and the write.
    missing_pid_checks=$((missing_pid_checks + 1))
    if [[ $missing_pid_checks -ge 3 ]]; then
      rm -rf "$lock_dir"
      continue
    fi
  fi
  if [[ -n "$lock_timeout" && "$lock_waited" -ge "$lock_timeout" ]]; then
    echo "camber-mlx-sidecar build lock at $lock_dir is held by pid ${lock_pid:-unknown}; gave up after ${lock_waited}s (retry once the other build finishes)" >&2
    exit 1
  fi
  echo "Waiting for camber-mlx-sidecar build in another checkout (pid ${lock_pid:-unknown})..." >&2
  sleep 5
  lock_waited=$((lock_waited + 5))
done
echo "$$" >"$lock_dir/pid"

cleanup() {
  rm -rf "$lock_dir"
  if [[ -n "$install_dir" ]]; then
    rm -f "$install_dir"/*.tmp.$$
  fi
}
trap cleanup EXIT
# Turn catchable signals into an exit so the EXIT trap releases the lock
# immediately; SIGKILL still leaves it to the pid-based reclaim above.
trap 'exit 130' INT
trap 'exit 143' TERM

"$script_dir/apply-vmlx-patches.sh" 1>&2

swift build -c "$configuration" --package-path "$package_dir" --scratch-path "$scratch_dir" 1>&2
bin_path="$(
  swift build -c "$configuration" --package-path "$package_dir" --scratch-path "$scratch_dir" --show-bin-path |
    awk 'NF { last = $0 } END { print last }'
)"

if [[ -z "$bin_path" ]]; then
  echo "Could not resolve SwiftPM binary output path for camber-mlx-sidecar" >&2
  exit 1
fi

# Debug symbols and local symbols are ~44% of the release binary (68MB ->
# 38MB). -S drops debug info, -x drops locals; global symbols stay, so
# sample/atos/crash reports still name Swift frames. Debug builds keep their
# DWARF (that configuration exists to attach lldb). Stripping invalidates
# the ad-hoc signature swift build applies on arm64, so re-sign; release
# pipelines re-sign properly afterwards anyway.
if [[ "$configuration" == "release" ]]; then
  chmod u+w "$bin_path/camber-mlx-sidecar"
  strip -Sx "$bin_path/camber-mlx-sidecar" 1>&2
  codesign -f -s - "$bin_path/camber-mlx-sidecar" 1>&2
fi

vmlx_checkout="$scratch_dir/checkouts/vmlx-swift"
metal_script="$vmlx_checkout/scripts/prepare-mlx-metal.sh"
if [[ ! -x "$metal_script" ]]; then
  echo "Expected executable MLX Metal preparation script at $metal_script" >&2
  exit 1
fi

# prepare-mlx-metal.sh skips work when its outputs already exist, which would
# keep stale metallibs across a vmlx-swift revision bump; stamp the outputs
# with the checkout revision and clear them when it changes.
vmlx_rev="$(git -C "$vmlx_checkout" rev-parse HEAD)"
metal_stamp="$bin_path/mlx.metallib.vmlx-revision"
if [[ "$(cat "$metal_stamp" 2>/dev/null || true)" != "$vmlx_rev" ]]; then
  rm -f "$bin_path/default.metallib" "$bin_path/mlx.metallib" "$metal_stamp"
fi

MLXPRESS_BUILD_CONFIGURATION="$configuration" \
  MLXPRESS_BUILD_TRIPLE="arm64-apple-macosx" \
  "$metal_script" "$bin_path/mlx.metallib" 1>&2

for name in default.metallib mlx.metallib; do
  if [[ ! -s "$bin_path/$name" ]]; then
    echo "Expected $bin_path/$name after MLX Metal preparation" >&2
    exit 1
  fi
done
echo "$vmlx_rev" >"$metal_stamp"

if [[ -z "$install_dir" ]]; then
  echo "$bin_path"
  exit 0
fi

# Rename into place so a concurrent reader never sees a partially written
# file, and so replacing a running binary keeps its old inode alive.
mkdir -p "$install_dir"
for name in camber-mlx-sidecar default.metallib mlx.metallib; do
  cp -f "$bin_path/$name" "$install_dir/$name.tmp.$$"
  mv -f "$install_dir/$name.tmp.$$" "$install_dir/$name"
done
echo "$install_dir"
