#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "$script_dir/.." && pwd)"
scratch_dir="${CAMBER_MLX_SIDECAR_SCRATCH_PATH:-$package_dir/.build}"
checkout_dir="$scratch_dir/checkouts/vmlx-swift"

# Resolve on every run: with a scratch path shared across worktrees the
# checkout may sit at a different pinned revision, and patching that would be
# silently undone when the build re-resolves. Resolving first force-checks-out
# this package's pin; when everything is current it is a fast no-op that
# leaves an already-patched checkout alone.
swift package --package-path "$package_dir" --scratch-path "$scratch_dir" resolve

if [[ ! -d "$checkout_dir/.git" ]]; then
  echo "vmlx-swift checkout is missing at $checkout_dir" >&2
  exit 1
fi

patch_files=("$package_dir"/patches/*.patch)

all_applied=true
for patch_file in "${patch_files[@]}"; do
  if ! git -C "$checkout_dir" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    all_applied=false
    break
  fi
done
if [[ "$all_applied" == true ]]; then
  echo "vmlx patches already applied: ${#patch_files[@]}"
  exit 0
fi

# A scratch path shared across worktrees may carry a different patch set;
# restore the pristine checkout and apply the full set in order. Capture the
# local modifications first so a hard failure can still show what conflicted.
restored_diff="$(git -C "$checkout_dir" diff 2>/dev/null || true)"
git -C "$checkout_dir" diff --name-only -z 2>/dev/null \
  | xargs -0 -I{} chmod u+w "$checkout_dir/{}" 2>/dev/null || true
git -C "$checkout_dir" checkout -- .
for patch_file in "${patch_files[@]}"; do
  git -C "$checkout_dir" apply --check "$patch_file" || {
    echo "Unable to apply vmlx patch: $(basename "$patch_file")" >&2
    if [[ -n "$restored_diff" ]]; then
      echo "Local modifications discarded before the retry:" >&2
      printf '%s\n' "$restored_diff" >&2
    fi
    exit 1
  }
  # SwiftPM checkouts are read-only; make each patched file writable first.
  while IFS= read -r target_path; do
    chmod u+w "$checkout_dir/$target_path" 2>/dev/null || true
  done < <(git -C "$checkout_dir" apply --numstat "$patch_file" | awk '{print $3}')
  git -C "$checkout_dir" apply "$patch_file"
  echo "Applied vmlx patch: $(basename "$patch_file")"
done
