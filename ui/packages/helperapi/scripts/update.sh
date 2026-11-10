#!/usr/bin/env bash

set -euo pipefail

# starts up the openapi server from helper, regenerates types
main() {
  local addr="${HELPER_OPENAPI_ADDR:-127.0.0.1:18080}"
  local schema_url="http://${addr}/openapi.yaml"

  # go runs the server as a subprocess of itself, so kill the server via lsof
  HELPER_OPENAPI_ADDR="${addr}" go run -tags=fts5 ../../../cmd/camber-helper openapi &
  trap "cleanup" EXIT SIGINT SIGTERM

  while ! curl --fail --silent --output /dev/null "${schema_url}"; do
    echo waiting for server to start
    sleep 2
  done

  # Intentionally not using turbo because it doesn't know about changes in the source go files
  LOCAL_SCHEMA="${schema_url}" pnpm -F @camber/helperapi codegen
  cleanup
}

cleanup() {
  local addr="${HELPER_OPENAPI_ADDR:-127.0.0.1:18080}"
  local port="${addr##*:}"
  local pid
  pid=$(lsof -i :"${port}" -t || true)

  if [[ -n "$pid" ]]; then
    kill "$pid"
  fi
}

main "$@"
