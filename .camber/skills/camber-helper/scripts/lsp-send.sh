#!/usr/bin/env bash
# Thin relay: reads JSON lines from stdin, wraps each in LSP base-protocol
# framing, sends over a persistent TCP connection via nc, and prints responses.
#
# Usage:
#     bash lsp-send.sh <host> <port>
#
# Each line of stdin is treated as a complete JSON-RPC body.
# The script adds the Content-Length header automatically.
# Responses are printed to stdout as plain JSON (one per line).

set -euo pipefail

host=${1:?usage: lsp-send.sh <host> <port>}
port=${2:?usage: lsp-send.sh <host> <port>}

# Temp FIFO so we can write to nc's stdin on demand while its stdout
# flows to the response parser running in the background.
fifo=$(mktemp -u /tmp/lsp-send-XXXXXX)
mkfifo "$fifo"
trap 'rm -f "$fifo"' EXIT

# Response parser: reads raw LSP-framed bytes from nc's stdout,
# extracts JSON bodies and prints them one per line.
parse_responses() {
    while IFS= read -r header_line; do
        # Strip trailing \r from the Content-Length header
        header_line=${header_line%$'\r'}
        if [[ $header_line == Content-Length:* ]]; then
            length=${header_line#Content-Length: }
            # Read the blank line separating header from body
            IFS= read -r _blank
            # Read exactly $length bytes of body
            body=""
            while (( ${#body} < length )); do
                remaining=$(( length - ${#body} ))
                IFS= read -r -N "$remaining" chunk
                body+=$chunk
            done
            printf '%s\n' "$body"
        fi
    done
}

# Start nc first (opens the FIFO read end), then open the write fd.
# Reversing this order deadlocks on macOS because opening a FIFO for
# writing blocks until a reader exists.
nc "$host" "$port" < "$fifo" | parse_responses &
nc_pid=$!

# Hold the FIFO open for writing so nc doesn't see EOF after the first message.
exec 3>"$fifo"

echo "connected to ${host}:${port}"

# Read JSON lines from stdin and send them LSP-framed to nc via the FIFO.
while IFS= read -r line; do
    line=${line%$'\r'}
    [[ -z $line ]] && continue
    printf "Content-Length: %d\r\n\r\n%s" "${#line}" "$line" >&3
done

# Clean up
exec 3>&-
wait "$nc_pid" 2>/dev/null || true
