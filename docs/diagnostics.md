# Diagnostics

Camber Assistant does not send usage metrics or error reports to a reporting
service. Errors and diagnostic events stay on the machine, in a place the user
can inspect when troubleshooting:

- **Helper** (`camber-helper`): structured `slog` records on stderr, which
  each host captures into its own log below.
- **Desktop app**: the helper session log under the app's log directory
  (`camber-helper-<timestamp>.log`, opened by the "Show logs" action).
  Errors reported by the assistant webview and startup diagnostics are appended
  to the same file as `webview-diag:` lines, so webview and helper activity
  interleave chronologically.
- **Mobile remote**: the browser console only.
