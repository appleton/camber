#!/usr/bin/env bash
# Build the complete development helper runtime from a clean source commit.
# Developer ID signing/notarization is performed separately for public distribution.
set -euo pipefail
version="${1:?usage: build-macos-helper-runtime.sh <M.m.p> <output-directory>}"
output="${2:?usage: build-macos-helper-runtime.sh <M.m.p> <output-directory>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid version" >&2; exit 1; }
[[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]] || { echo "Build on Apple Silicon macOS" >&2; exit 1; }
root="$(git rev-parse --show-toplevel)"
cd "$root"
git diff --quiet HEAD || { echo "Commit source changes before building a release" >&2; exit 1; }
source_sha="$(git rev-parse HEAD)"
build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
[[ -z "$(ls -A "$output")" ]] || { echo "Use an empty output directory" >&2; exit 1; }
build_dir="${CAMBER_RUNTIME_BUILD_DIR:-$(mktemp -d)}"
mkdir -p "$build_dir"
pnpm -F @camber/mobile-remote embed
for arch in arm64 amd64; do
  name="camber-helper-darwin-$arch"
  CGO_ENABLED=1 GOOS=darwin GOARCH="$arch" go build -tags=fts5 -trimpath \
    -ldflags "-s -w -X github.com/appleton/camber/pkg/common/version.Tag=$version -X github.com/appleton/camber/pkg/common/version.Commit=$source_sha -X github.com/appleton/camber/pkg/common/version.BuildTime=$build_time" \
    -o "$build_dir/$name" ./cmd/camber-helper
  codesign --force --sign - "$build_dir/$name"
  tar -C "$build_dir" -czf "$output/$name.tar.gz" "$name"
done
cmd/camber-mlx-sidecar/scripts/build.sh "$build_dir/mlx"
cp "$build_dir/mlx/camber-mlx-sidecar" "$build_dir/mlx/camber-mlx-sidecar-darwin-arm64"
tar -C "$build_dir/mlx" -czf "$output/camber-mlx-sidecar-darwin-arm64.tar.gz" \
  camber-mlx-sidecar-darwin-arm64 default.metallib mlx.metallib
whisper_revision=f049fff95a089aa9969deb009cdd4892b3e74916
if [[ ! -d "$build_dir/whisper.cpp/.git" ]]; then
  git clone https://github.com/ggml-org/whisper.cpp.git "$build_dir/whisper.cpp"
fi
git -C "$build_dir/whisper.cpp" checkout --detach "$whisper_revision"
git -C "$build_dir/whisper.cpp" diff --quiet HEAD
cmake -S "$build_dir/whisper.cpp" -B "$build_dir/whisper.cpp/build" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
  -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$build_dir/whisper.cpp/build" --config Release -j 4 --target whisper-server
cp "$build_dir/whisper.cpp/build/bin/whisper-server" "$build_dir/camber-whisper-server-darwin-arm64"
codesign --force --sign - "$build_dir/camber-whisper-server-darwin-arm64"
tar -C "$build_dir" -czf "$output/camber-whisper-server-darwin-arm64.tar.gz" camber-whisper-server-darwin-arm64
for archive in "$output"/*.tar.gz; do
  (cd "$output" && shasum -a 256 "$(basename "$archive")") > "${archive%.tar.gz}.checksum"
done
bash scripts/verify-helper-runtime.sh "$output"
echo "Built helper/v$version from $source_sha (ad-hoc signed; not notarized)"
