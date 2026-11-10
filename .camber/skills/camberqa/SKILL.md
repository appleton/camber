---
name: camberqa
version: 0.2.0
description: |
  🧵 Interact with Camber desktop app webviews via Playwright.
  Snapshot the accessibility tree, click elements, fill inputs, send chat
  messages, and take screenshots. Use for QA testing Camber app surfaces.
  Also manages long-running services (storybook, etc.) — list, restart, and inspect logs.
allowed-tools:
  - Bash
  - Read

---

# 🧵 CamberQA: App QA + Process Manager

Interacts with Camber desktop app webviews via Playwright. The user starts
a target with `camberqa desktop up`; commands then execute in ~100ms.

Also includes a **process manager** for long-running services. Any command wrapped with
`camberqa manage run` can be listed, restarted, and have its logs inspected — enabling
autonomous agents to recover crashed services without user intervention.

## When To Use CamberQA

- Use camberqa by default for **all product feature and bug work** to validate behavior in the real extension UI.
- For bug fixes, treat screenshots as mandatory evidence:
  1. Reproduce in camberqa and take a **before** screenshot.
  2. Apply the fix.
  3. Reproduce again and take an **after** screenshot.
- Prefer `camberqa component @ref` over source grep when tracing UI ownership. It shows the Svelte component chain and file paths for an element selected from `snapshot`.

## Commonly Managed Services

| ID | Command | Description |
|----|---------|-------------|
| `desktop-s<slot>` | `camberqa desktop up` (auto-managed) | The camberqa desktop app target. Restartable via `camberqa manage restart desktop-s<slot>`. |
| _(varies)_ | `camberqa manage run pnpm storybook` | Storybook dev server, or any other long-running dev service. |

## Setup

The `camberqa` CLI must be on PATH. **If `command -v camberqa` fails**, run the installer first:

```bash
"$(git rev-parse --show-toplevel)/ui/packages/camberqa/install.sh"
```

The server must be running. **When any command fails:**

1. Run `camberqa status`. Its output tells you exactly what's wrong and what to do.
2. **Relay the output verbatim to the user.** The error messages already contain the correct commands to run. Do NOT paraphrase, summarize, or invent your own setup instructions — they will be wrong. Copy-paste the error output as-is.

**You cannot start the server yourself.** These are long-running processes that the user manages.

## Worktree Context

- In worktree flows, agents usually already have a running camberqa target with worktree-scoped ports and service IDs.
- Check your current slot/ports with:
  - `camberqa worktree status`
  - `camberqa worktree env`
  set to `acp`; `--lsp` sets it to `classic`. Omitting both preserves the copied
- `camberqa desktop up --color "#1f6feb" --worktree-name agent-name` starts a
  Tauri desktop app instance with a distinct title, bundle identifier, dev port,
  camberqa port, and visible color marker.
- Generic commands such as `snapshot`, `screenshot`, `click`, `fill`, `text`, and
  `js` auto-select the only running target. Use `--desktop` to select it explicitly.
- If camberqa renders garbled log output instead of the extension UI, restart the managed camberqa process:
  1. `camberqa manage list`

## Quick Start

Commands auto-recover the webview if it's closed — no need to check `status` first.
Chain multiple commands with `--`:

```bash
camberqa sendMessage "Hello world" -- waitForMessageCount 1 30000 -- getLastResponse
camberqa snapshot                    # accessibility tree with @refs
camberqa --desktop snapshot          # choose target when multiple are running
camberqa click @e3                   # click element
camberqa screenshot -o /tmp/camberqa.png
```

## Command Reference

### Meta
| Command | Description |
|---------|-------------|
| `desktop up [--id <id>] [--fast] [--api-url URL] [--color HEX] [--worktree-name NAME]` | Start the desktop target for this worktree |
| `desktop down [--all]` | Stop that target's services for this worktree (`--all` stops both); the slot is released once nothing is left running |
| `status` | Is the selected target running? Webview ready? |
| `focusCamber` | Open the Camber sidebar |
| `quit` | Shut down server |

### Snapshot
| Command | Description |
|---------|-------------|
| `snapshot [-i] [-c] [-d N] [-D] [--desktop]` | Accessibility tree of webview with @refs |
| `screenshot [-o PATH]` | Screenshot of desktop window |
| `screenshot --webview [-o PATH]` | Screenshot of webview only |
| `screenshotElement @ref [-p N] [-o PATH]` | Screenshot of single element with optional padding |

### Interact
| Command | Description |
|---------|-------------|
| `click @ref` | Click element |
| `hover @ref` | Hover over element |
| `fill @ref "text"` | Fill input |
| `type "text"` | Type via keyboard |
| `press "Key"` | Press key (Enter, Escape, etc.) |
| `scroll [up\|down] [amount]` | Scroll webview |
| `wait "selector" [timeout]` | Wait for element |

### Read
| Command | Description |
|---------|-------------|
| `text [@ref or selector]` | Get text content (accepts @ref or CSS selector) |
| `html [@ref or selector]` | Get HTML (accepts @ref or CSS selector) |
| `component @ref` | Get Svelte component metadata for element |
| `js "expression"` | Evaluate JS in webview frame |

### Debug / Profile
| Command | Description |
|---------|-------------|
| `debug go [--port PORT]` | Restart the desktop `camber-helper` under headless Delve and print `dlv connect` attach guidance. |
| `profile go <cpu\|heap\|goroutine\|trace> [--seconds N] [-o PATH]` | Capture helper pprof output. Defaults to `/tmp/camberqa-profiles`. |
| `debug rust` | Print the desktop Tauri shell PID, executable path, and LLDB attach commands. Requires a desktop target. |
| `profile rust cpu [--seconds N] [-o PATH] [--format pprof\|svg]` | Report Rust profiling availability. The pprof bridge currently fails fast as unavailable while it is being stabilized. Requires a desktop target. |

Go diagnostics target `camber-helper`; Rust diagnostics target the desktop Tauri
shell.

### Panels
The Camber sidebar is the default panel. The "Review Changes" diff view (opened
via the **Review** button on the sandbox-changes banner when the agent edits
files in the disk-access-limited sandbox) is a separate webview panel. Generic
commands (snapshot, screenshot, click, fill, hover, scroll, screenshotElement,
text, html, js, component) operate on the **currently selected panel**;
Camber-specific commands always target the sidebar.

| Command | Description |
|---------|-------------|
| `listPanels` | List all live webview panels (* = current) |
| `selectPanel "name"` | Switch the current panel for generic commands. Fuzzy match supported (e.g. `selectPanel review` matches "Review Changes"). |
| `getCurrentPanel` | Print the current panel name |

```bash
# Capture the diff view that opens when the agent edits a file
camberqa listPanels
camberqa selectPanel "Review Changes" -- snapshot -- screenshot --webview -o /tmp/diff.png
camberqa selectPanel "Camber" -- sendMessage "next prompt"
```

### Camber
| Command | Description |
|---------|-------------|
| `sendMessage "text"` | Type and send a chat message |
| `waitForMessageCount <N> [timeout]` | Wait for N message pairs (user+response) |
| `getLastResponse` | Get text of last assistant message |
| `getMessageCount` | Get current message pair count |
| `newConversation [--project NAME \| --worktree NAME]` | Click "New conversation". On desktop: clicks the project- or worktree-scoped sidebar button (`aria-label="New conversation in {name}"`). With no args on desktop, defaults to the first project in the sidebar. |
| `archiveConversation "title-substring"` | Archive a sidebar conversation by case-insensitive title match. Errors if zero or >1 matches. |
| `openHistory` / `closeHistory` | Open or close the archived-conversations overlay |
| `deleteConversation "title-substring"` | Delete a conversation via the history overlay. Auto-opens history. Errors clearly if the agent does not support deletion. |
| `restoreConversation "title-substring"` | Restore an archived conversation via the history overlay. Auto-opens history. |
| `openCommandMenu` | Open the command menu |
| `assertMessage "text"` | Assert a message is visible |
| `isStreaming` | Check if response is being generated |
| `stopGeneration` | Stop current response generation |
| `approveAction [once\|always\|deny]` | Handle tool approval dialog |
| `waitForApproval [timeout]` | Wait for approval dialog (default 30s) |
| `getApprovalInfo` | Get pending approval details |
| `selectConversation "title"` or `selectConversation --index N` | Switch conversation by case-insensitive title substring or by global index from `listConversations`. Errors on zero or ambiguous matches. |
| `getCurrentConversation` | Title (and agent name) of the currently selected sidebar row, or "(no conversation is currently selected)". |
| `restartACPServer "agent-server"` | Restart one ACP agent subprocess by configured server name, e.g. `codex-acp` or `poolside`. |
| `restartHelper` | Restart camber-helper |
| `helperLogs [lines]` | Get last N lines of helper logs (default 500) |
| `selectCommand "name"` | Execute a slash command from menu |
| `getConfigs` | List each session config option (Mode, Model, etc.) with its current value |
| `setConfig <name> <value>` | Open the dropdown for `<name>` (case-insensitive substring) and click `<value>`. Errors clearly on zero or ambiguous matches. |

### Projects & worktrees (desktop only)

These commands target the desktop sidebar tree (Project › Worktree › Conversation). Add-project is intentionally not exposed — it triggers a native OS folder picker that Playwright can't drive.

| Command | Description |
|---------|-------------|
| `listProjects` | Project tree summary (expanded/collapsed + worktree count) |
| `listWorktrees [--project NAME]` | Worktrees per project; filter by name substring |
| `openProject "name"` | Expand a collapsed project section |
| `closeProject "name"` | Collapse a project (errors if the UI doesn't support collapse-by-header) |
| `removeProject "name"` | Open the project kebab and click "Remove project". No confirmation. |
| `createWorktree [--project NAME]` | Click "Add worktree for X". Name is server-assigned; the command returns the new worktree's name once it appears (15s timeout). Defaults to the only project if just one is present. |
| `removeWorktree "name"` | Hover the worktree row and click "Archive worktree X". No confirmation. |
| `openWorktree "name"` | Click the worktree row main button (switches workspace). |


### Manage (Process Manager)
| Command | Description |
|---------|-------------|
| `manage list` | List all managed processes (ID, command, PIDs, status, uptime, restarts) |
| `manage run [--name <id>] <command...>` | Wrap a command — transparent stdout/stderr, but trackable and restartable |
| `manage restart <id>` | Restart a managed process (kills child, respawns same command) |
| `manage stop <id>` | Stop a managed process and its wrapper |
| `manage logs <id> [--tail N]` | Show last N lines of captured output (default 100) |

### Refs
After `snapshot`, use `@e1`, `@e2`... as selectors:
```bash
camberqa snapshot       # shows @e1 [button] "Send", @e2 [textbox] "Message"...
camberqa click @e1         # click the Send button
camberqa fill @e2 "hello"  # fill the Message textbox
```

## Flags
| Flag | Applies to | Description |
|------|-----------|-------------|
| `-c` / `--compact` | snapshot | Remove empty structural elements |
| `-d N` / `--depth N` | snapshot | Limit tree depth |
| `-s SEL` / `--selector SEL` | snapshot | Snapshot subtree under CSS selector |
| `-D` / `--diff` | snapshot | Diff against previous snapshot |
| `--webview` | screenshot | Screenshot only the webview |
| `-o PATH` | screenshot | Output path for screenshot |
