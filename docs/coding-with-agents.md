# Working on Camber Assistant with coding agents

Camber Assistant is largely built _with_ coding agents such as Claude, Codex,
and pool. This guide walks through the tooling we rely on so your agents can
use the same workflow.

The headline tool is **camberqa**: a Playwright-driven CLI that lets an
agent drive a real Camber webview, click buttons, fill inputs, send
chat messages, snapshot the accessibility tree, take screenshots, and
verify behavior end-to-end. Combined with git worktrees, it lets you run
**multiple agents in parallel** against multiple instances of the
assistant on the same machine.

## Why camberqa

Coding agents have limited visibility into UI work unless they can run the app
and inspect the result. CamberQA gives agents that feedback loop:

- A snapshot of the accessibility tree, with stable `@e1`, `@e2`
  identifiers an agent can click on.
- A real screenshot in `/tmp/foo.png` an agent can inspect.
- One-shot Camber-specific commands like `sendMessage`,
  `waitForMessageCount`, `getLastResponse`, `approveAction`, so an
  agent can drive a full conversation.
- A process manager that lets the agent restart a crashed dev server
  without bothering you.

If your agent is working on a UI bug, **make screenshots mandatory evidence**:
a "before" screenshot before the fix and an "after" screenshot after the fix.
This catches plausible-looking fixes that code review alone can miss.

## Install camberqa

From your local clone:

```sh
ui/packages/camberqa/install.sh
```

That script:

- Symlinks the `camberqa` CLI into `~/.local/bin/`.
- Installs the camberqa skill into `~/.claude/skills/camberqa` (if
  you use Claude Code) and `~/.codex/skills/camberqa` (if you use
  Codex).

Make sure `~/.local/bin` is on your `PATH`; the installer reminds you if it is
not:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Verify it worked:

```sh
camberqa --help
```

## Start a target

CamberQA drives either a **VS Code** window or the **desktop app**.
Pick one, or both. See [parallel worktrees](#parallel-worktrees-and-the-desktop-app)
below.

```sh
# VS Code with the extension loaded
camberqa vscode up

# Desktop app
camberqa desktop up
```

Each `up` starts a long-running process. Generic camberqa commands
auto-select whichever target is running; pass `--vscode` or `--desktop`
if both are up.

Check what's alive:

```sh
camberqa status
camberqa manage list
```

When you're done, stop each target you started:

```sh
# VS Code
camberqa vscode down

# Desktop app
camberqa desktop down
```

## Snapshots and screenshots

When a target is running:

```sh
# Accessibility tree of the webview, with @e1, @e2, ... refs
camberqa snapshot

# Visible UI subtree of the chat shell
camberqa snapshot --compact --depth 4

# Screenshot
camberqa screenshot -o /tmp/before.png

# Webview region
camberqa screenshot --webview -o /tmp/webview.png

# Screenshot a single element
camberqa screenshotElement @e3 -p 8 -o /tmp/button.png

# Diff a new snapshot against the previous one
camberqa snapshot --diff
```

The pattern an agent should follow when fixing a UI bug:

```sh
# 1. Reproduce.
camberqa sendMessage "trigger the bug" -- waitForMessageCount 1 30000
camberqa screenshot --webview -o /tmp/before.png

# 2. Fix it in the code, hot-reload picks it up.

# 3. Verify.
camberqa newConversation
camberqa sendMessage "trigger the bug" -- waitForMessageCount 1 30000
camberqa screenshot --webview -o /tmp/after.png
```

Both PNGs become evidence in the PR description.

## Driving the chat

Most things you can do in the UI by hand have a camberqa command:

```sh
camberqa sendMessage "Hello world" -- waitForMessageCount 1 30000 -- getLastResponse
camberqa listConversations
camberqa selectConversation --index 2
camberqa newConversation
camberqa stopGeneration
camberqa approveAction once          # respond to a tool-approval dialog
camberqa waitForApproval 30          # wait for one to appear
camberqa restartHelper               # reload VS Code window
camberqa helperLogs 500              # last 500 lines of helper logs
```

Generic webview commands work on any visible panel:

```sh
camberqa click @e3
camberqa fill @e2 "type something"
camberqa hover @e4
camberqa type "raw keyboard input"
camberqa press "Enter"
camberqa text @e7                    # extract text content
camberqa js "document.title"         # evaluate JS in the webview
camberqa component @e3               # find the Svelte component owning an element
```

Use `--` to chain commands so an agent can execute a small script in one shot:

```sh
camberqa sendMessage "/help" -- waitForMessageCount 1 30000 -- getLastResponse
```

## Parallel worktrees and the desktop app

Create worktrees from inside the desktop app, and Camber Assistant spawns a
dedicated instance of itself for each one. Each instance claims a slot, gets a
distinct title-bar color, and gets its own dev port and camberqa port. You do
not pick colors by hand, manage slots, or keep a terminal open for each
worktree.

That means you can run **N coding agents on N branches in N worktrees
against N desktop apps**. They all run on one machine, can all be driven from
one camberqa CLI, and remain visually distinguishable on your screen.

To make this work end-to-end, configure the worktree setup and teardown
scripts in the app to:

```sh
# Setup: runs when a worktree is created
pnpm install && camberqa desktop up
```

```sh
# Teardown: runs when a worktree is removed
camberqa desktop down
```

That's it. The app handles the rest: each new worktree comes up with its
own colored Camber Assistant window, ready for an agent to drive with
commands such as `camberqa snapshot` and `camberqa sendMessage`. When the
worktree is torn down, its desktop instance and camberqa server are cleaned up.

Use the same target namespace to show the current slot/ports:

```sh
camberqa desktop status
camberqa desktop env
```

If you run the VS Code target instead, use `camberqa vscode status` and
`camberqa vscode env`.

## Managing background services

Long-running development services, such as Storybook, can run under camberqa's
process manager so an agent can restart them when they crash:

```sh
camberqa manage run pnpm storybook
camberqa manage list
camberqa manage logs storybook --tail 200
camberqa manage restart storybook
camberqa manage stop storybook
```

## When something goes wrong

If a camberqa command fails, the **first** thing to do is run:

```sh
camberqa status
```

Its output is precise about what's wrong and how to fix it. If the
extension UI is rendering garbled log output instead of chat, restart the
managed process:

```sh
camberqa manage list
camberqa manage restart camberqa-s<slot>
```

## Pointers

- CamberQA skill spec: [`.camber/skills/camberqa/SKILL.md`](../.camber/skills/camberqa/SKILL.md)
- CamberQA package: [`ui/packages/camberqa/`](../ui/packages/camberqa/)
- The bigger picture for coding agents: [`AGENTS.md`](../AGENTS.md)
