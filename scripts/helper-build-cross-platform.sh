#!/usr/bin/env bash

set -euo pipefail

# IMPORTANT: This script is NOT designed to use in production.
# It is intended for local development and testing purposes only.

# Other platforms can be added here as needed.
ALL_PLATFORMS=(
    "windows/amd64"
    "windows/arm64"
    "linux/amd64"
    "linux/arm64"
    "darwin/amd64"
    "darwin/arm64"
)

get_cross_compile_settings() {
    local platform="$1"
    local goos="${platform%/*}"
    local goarch="${platform#*/}"

    case "$platform" in
        windows/amd64)
            echo "CC=/llvm-mingw/bin/x86_64-w64-mingw32-gcc CXX=/llvm-mingw/bin/x86_64-w64-mingw32-g++ CGO_ENABLED=1"
            ;;
        windows/arm64)
            echo "CC=/llvm-mingw/bin/aarch64-w64-mingw32-gcc CXX=/llvm-mingw/bin/aarch64-w64-mingw32-g++ CGO_ENABLED=1"
            ;;
        darwin/amd64)
            echo "CC=o64-clang CXX=o64-clang++ CGO_ENABLED=1"
            ;;
        darwin/arm64)
            echo "CC=oa64-clang CXX=oa64-clang++ CGO_ENABLED=1"
            ;;
        linux/amd64)
            echo "CC=x86_64-linux-gnu-gcc CXX=x86_64-linux-gnu-g++ CGO_ENABLED=1"
            ;;
        linux/arm64)
            echo "CC=aarch64-linux-gnu-gcc CXX=aarch64-linux-gnu-g++ CGO_ENABLED=1"
            ;;
        *)
            echo "Error: Unsupported platform '$platform'" >&2
            exit 1
            ;;
    esac
}

get_ldflags() {
    local platform="$1"
    local goos="${platform%/*}"
    local tag="$2"
    local commit="$3"
    local date="$4"

    local base_ldflags="-s -w -X github.com/appleton/camber/pkg/common/version.Tag=${tag} -X github.com/appleton/camber/pkg/common/version.Commit=${commit} -X github.com/appleton/camber/pkg/common/version.BuildTime=${date}"

    if [[ "$goos" == "windows" ]]; then
        echo "$base_ldflags -linkmode external -extldflags \"-static\""
    else
        echo "$base_ldflags"
    fi
}

get_output_filename() {
    local tool="$1"
    local platform="$2"
    local goos="${platform%/*}"
    local goarch="${platform#*/}"

    local filename="${tool}-${goos}-${goarch}"
    if [[ "$goos" == "windows" ]]; then
        filename="${filename}.exe"
    fi
    echo "$filename"
}

get_container_image() {
    echo "ghcr.io/goreleaser/goreleaser-cross:v1.25.0"
}

get_current_platform() {
    local os
    local arch

    # Determine OS
    case "$(uname -s)" in
        Darwin)
            os="darwin"
            ;;
        Linux)
            os="linux"
            ;;
        CYGWIN*|MINGW*|MSYS*)
            os="windows"
            ;;
        *)
            echo "Unsupported OS: $(uname -s)" >&2
            return 1
            ;;
    esac

    # Determine architecture
    case "$(uname -m)" in
        x86_64|amd64)
            arch="amd64"
            ;;
        arm64|aarch64)
            arch="arm64"
            ;;
        *)
            echo "Unsupported architecture: $(uname -m)" >&2
            return 1
            ;;
    esac

    echo "${os}/${arch}"
}

clean_cache_for_platform() {
    local platform="$1"

    echo "🧹 Cleaning cache for $platform..."
    docker volume rm go-mod-cache >/dev/null 2>&1 || true
    docker volume rm go-build-cache >/dev/null 2>&1 || true
    docker volume rm go-sdk-cache >/dev/null 2>&1 || true
}

# Function to build a specific tool for a specific platform
build_tool_for_platform() {
    local tool="$1"
    local platform="$2"
    local goos="${platform%/*}"
    local goarch="${platform#*/}"

    # Set up environment variables
    export GOOS="$goos"
    export GOARCH="$goarch"
    export TAG=${TAG:-"dev-$(date +%Y%m%d%H%M%S)"}
    export COMMIT=${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")}
    export DATE=${DATE:-$(date -u +%Y-%m-%dT%H:%M:%S)}

    local output_file
    local cross_compile_settings
    local ldflags
    local container_image
    output_file=$(get_output_filename "$tool" "$platform")
    cross_compile_settings=$(get_cross_compile_settings "$platform")
    ldflags=$(get_ldflags "$platform" "$TAG" "$COMMIT" "$DATE")
    container_image=$(get_container_image "$platform")

    echo ""
    echo "🚀 Building $tool for $platform..."
    echo "   Output: $output_file"

    # Create a temporary build script
    BUILD_SCRIPT=$(mktemp)
    cat > "$BUILD_SCRIPT" << EOF
#!/bin/bash
set -euo pipefail

echo "Building $tool for $platform..."
echo "Environment:"
echo "  GOOS=\$GOOS"
echo "  GOARCH=\$GOARCH"
echo "  CGO_ENABLED=\$CGO_ENABLED"
if [[ -n "\${CC:-}" ]]; then
    echo "  CC=\$CC"
fi
if [[ -n "\${CXX:-}" ]]; then
    echo "  CXX=\$CXX"
fi
echo ""

echo "📦 Downloading Go modules (this will be cached for future builds)..."
go mod download

echo "🔨 Building binary..."
if go build \\
    -ldflags "$ldflags" \\
    -buildvcs=false \\
    -mod=readonly \\
    -o "$output_file" \\
    ./cmd/$tool 2>&1; then

    if [[ -f "$output_file" ]]; then
        echo "✅ Build completed successfully!"
        ls -la "$output_file"
        file "$output_file" 2>/dev/null || echo "File type: Binary executable"
    else
        echo "❌ Build succeeded but output file not found"
        exit 1
    fi
else
    build_exit_code=\$?
    echo "❌ Build command failed with exit code \$build_exit_code"
    if [[ -f "$output_file" ]]; then
        echo "⚠️  Output file exists despite build failure - removing it"
        rm "$output_file"
    fi
    exit \$build_exit_code
fi
EOF

    chmod +x "$BUILD_SCRIPT"

    docker volume create go-mod-cache >/dev/null 2>&1 || true
    docker volume create go-build-cache >/dev/null 2>&1 || true
    docker volume create go-sdk-cache >/dev/null 2>&1 || true

    # Prepare docker run command with cross-compilation settings
    local docker_env_args=()
    for setting in $cross_compile_settings; do
        local key="${setting%=*}"
        local value="${setting#*=}"
        docker_env_args+=("-e" "$key=$value")
    done

    # Run the build inside the container
    if docker run \
        --rm \
        --entrypoint="" \
        -v "${PWD}":/go/src/app \
        -v "$BUILD_SCRIPT":/build.sh \
        -v go-mod-cache:/go/pkg/mod \
        -v go-build-cache:/root/.cache/go-build \
        -v go-sdk-cache:/root/sdk \
        -w /go/src/app \
        -e GOOS="$GOOS" \
        -e GOARCH="$GOARCH" \
        -e GOAMD64="v1" \
        "${docker_env_args[@]}" \
        -e GOPROXY="https://proxy.golang.org,direct" \
        -e GOSUMDB="sum.golang.org" \
        "$container_image" \
        bash /build.sh; then

        # Clean up
        rm -f "$BUILD_SCRIPT"

        echo "✅ $tool for $platform built successfully!"
        echo "📁 Output: $output_file"
        if [[ -f "$output_file" ]]; then
            echo "📏 Size: $(du -h "$output_file" | awk '{print $1}')"
        fi
        return 0
    else
        docker_exit_code=$?
        # Clean up
        rm -f "$BUILD_SCRIPT"

        echo "❌ Build failed for $tool on $platform! (Docker exit code: $docker_exit_code)"
        return 1
    fi
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTIONS] <tool> <platform|all>"
    echo ""
    echo "Build camber-helper for different platforms"
    echo ""
    echo "Tools:"
    echo "  camber-helper"
    echo ""
    echo "Platforms:"
    for platform in "${ALL_PLATFORMS[@]}"; do
        echo "  $platform"
    done
    echo "  all          - Build for all platforms"
    echo ""
    echo "Options:"
    echo "  --clean      - Clean Docker cache before building"
    echo "  --help       - Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 camber-helper windows/amd64"
    echo "  $0 camber-helper all"
    echo "  $0 --clean camber-helper windows/amd64"
    echo ""
    echo "Environment variables:"
    echo "  TAG          - Version tag (default: dev-TIMESTAMP)"
    echo "  COMMIT       - Git commit hash (default: auto-detected)"
    echo "  DATE         - Build date (default: current UTC time)"
}

# Parse arguments
CLEAN_CACHE=false
TOOL=""
PLATFORMS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --clean)
            CLEAN_CACHE=true
            shift
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        camber-helper)
            if [[ -n "$TOOL" ]]; then
                echo "Error: Tool already specified as '$TOOL'" >&2
                echo "Cannot specify multiple tools in one invocation" >&2
                exit 1
            fi
            TOOL="$1"
            shift
            ;;
        all)
            PLATFORMS=("${ALL_PLATFORMS[@]}")
            shift
            ;;
        */*)
            PLATFORMS+=("$1")
            shift
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "" >&2
            show_usage >&2
            exit 1
            ;;
    esac
done

# Validate tool was specified
if [[ -z "$TOOL" ]]; then
    echo "Error: No tool specified" >&2
    echo "" >&2
    show_usage >&2
    exit 1
fi

# If no platforms specified, use current platform
if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
    current_platform=$(get_current_platform)
    PLATFORMS=("$current_platform")
fi

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker is not running. Please start Docker Desktop."
    exit 1
fi

# Clean cache if requested
if [[ "$CLEAN_CACHE" == "true" ]]; then
    for platform in "${PLATFORMS[@]}"; do
        clean_cache_for_platform "$platform"
    done
    echo "Cache cleaned!"
fi

echo "Building $TOOL for platforms: ${PLATFORMS[*]}"

# Build for each platform
failed_builds=()
successful_builds=()

for platform in "${PLATFORMS[@]}"; do
    if build_tool_for_platform "$TOOL" "$platform"; then
        successful_builds+=("$platform")
    else
        failed_builds+=("$platform")
    fi
done

# Summary
echo ""
echo "🎯 Build Summary for $TOOL:"
if [[ ${#successful_builds[@]} -gt 0 ]]; then
    echo "✅ Successful builds (${#successful_builds[@]}):"
    for platform in "${successful_builds[@]}"; do
        output_file=$(get_output_filename "$TOOL" "$platform")
        file_size=$(du -h "$output_file" 2>/dev/null | awk '{print $1}' || echo "N/A")
        echo "   $platform -> $output_file ($file_size)"
    done
fi

if [[ ${#failed_builds[@]} -gt 0 ]]; then
    echo "❌ Failed builds (${#failed_builds[@]}):"
    for platform in "${failed_builds[@]}"; do
        echo "   $platform"
    done
    exit 1
fi

echo ""
echo "🎉 All builds completed successfully!"
