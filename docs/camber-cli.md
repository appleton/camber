# Camber CLI

The `poolside` command controls a running Camber desktop. It does not start an
agent or helper itself. Start the desktop app first; requests use the desktop's
existing helper and its registered agents, projects, worktrees, and conversations.
The CLI currently supports macOS and other Unix desktop builds.

## Install

Packaged desktop builds include a `poolside` executable beside the app
executable. On macOS, it is at
`Camber.app/Contents/MacOS/camber`. You can link it into a directory already
on `PATH`:

```sh
"/Applications/Camber.app/Contents/MacOS/camber" cli install --directory "$HOME/.local/bin"
```

Add that directory to `PATH` if needed, then check the connection:

```sh
camber status --json
camber instances list --json
```

For a source build, from the repository root run:

```sh
go build -o "$PWD/camber" ./cmd/camber
./camber status --json
```

The desktop development build also compiles a host CLI when it downloads its
bundled binaries. You can build just that executable with
`pnpm -F @camber/desktop-assistant build:cli`; it appears under
`ui/apps/desktop-assistant/src-tauri/binaries/camber` on the host platform.

## Agent skill

Install the small Camber skill so an agent can discover the live guide and
commands. For example, for Codex at user scope:

```sh
camber skill setup --agent codex --scope user
camber skill status --agent codex --scope user
camber skill show
```

Use `--agent shared` for `.agents/skills`, `--agent claude` for
`.claude/skills`, or `--scope project` to install under the current project.
`camber skill setup --directory PATH` selects an exact skill directory. Setup
will not replace an existing user-owned skill file.

## Sandboxed agents

The CLI needs permission to connect to the desktop's local Unix socket.
The agent's shell sandbox can deny this even when the CLI is on `PATH` and the
desktop is running. Currently a blocked handshake can appear as “instance
unavailable” or an empty instance list. Use the agent runtime's normal approval
flow when access is blocked.

Automatic socket grants are not currently implemented. Testing Codex 0.160.1
with codex-acp 2.2.2 did not establish a working configuration-only grant that
preserves disabled network access; see the
[sandbox investigation in the plan](camber-cli-plan.md).

## Find agents and configuration options

Ask the running desktop for its live agent list and an agent's configuration
schema. Option discovery may depend on the workspace:

```sh
camber agents list --json
camber agents inspect AGENT --workspace /absolute/project --json
camber agents config options AGENT --workspace /absolute/project --json
```

The returned option IDs and allowed values are authoritative for that agent and
workspace. This CLI exposes live discovery through the desktop; it does not ship
a separate complete catalog of every agent's options.

## Spawn and configure a conversation

Spawn accepts a batch configuration, plus shortcuts for model, reasoning effort,
and mode. The desktop validates and applies configuration before submitting the
initial prompt:

```sh
camber chat spawn PARENT \
  --project /absolute/project \
  --new-worktree api-task \
  --agent AGENT \
  --model MODEL \
  --effort EFFORT \
  --input '{"OPTION_ID":"VALUE"}' \
  --text @task.txt \
  --request-id api-task-001 \
  --caller-token CALLER_TOKEN \
  --timeout 10m \
  --json
```

Use `--workspace PATH` (or `--worktree PATH`) to share an existing workspace
instead of creating one. Pass the parent ID and caller token from your
per-prompt Camber host context (see [Caller identity](#caller-identity)). The desktop supplies the instance environment, but does not export a
conversation ID from its shared agent process. An external wrapper may set
`CAMBER_CONVERSATION_ID`, `CAMBER_PROJECT_PATH`, and
`CAMBER_WORKSPACE_PATH` as optional defaults; `camber context` reports
those explicit values and never guesses from UI focus. Save the returned
conversation ID, turn ID, and cursor. A request ID makes retrying an identical
spawn safe; do not reuse it for a different task. If no model or effort is
specified, the desktop applies its compatible inherited settings and agent
defaults.

Preparation and configuration operations serialize per conversation, so a slow
setup does not block controls for other conversations. Setup and teardown
scripts have a five-minute deadline; helper control requests have a nine-minute
deadline. Once a prompt starts, generation continues independently of the
request or CLI reader.
CLI setup uses the helper's terminal runner; its output is not yet mirrored into
the desktop setup-output panel. A failure is returned by the CLI and recorded
on a spawned conversation for inspection.

Inspect current values and update them before a later prompt:

```sh
camber chat config list CHILD --json
camber chat config set CHILD reasoning_effort --value-json '"high"' --json
camber chat config set CHILD --input '{"model":"MODEL","mode":"MODE"}' --json
```

Config values are strings or booleans. `--input` accepts JSON, `@FILE`, or
`@-` for stdin. `--value-json` parses one JSON string or boolean.
Escape a literal leading `@` in prompt text as `@@`, for example
`--text '@@team please review'`.
Some options depend on the selected model. A batch applies the model first and
then validates dependent choices; if a later choice fails, inspect
`chat config list` for the effective settings. The task is never submitted with
an unapplied requested configuration.

Permission and workspace guardrails apply to every control call:

- A permission-bypass mode is one whose value or display name matches
  `bypassPermissions`, `agent-full-access`, `full-access`, `always-allow`,
  `allow-all`, `yolo` or `bypass*` (ignoring case and punctuation, so an opaque
  value labelled "Full access" counts). Requested values are resolved against
  the session's option schema; a mode value the schema does not offer is
  rejected.
- `chat spawn` gives a child a bypass mode, whether requested with `--mode` or
  `--input` or inherited from a same-agent parent, only when the request's
  `--caller-token` proves it comes from that parent and the parent's session is
  loaded and running in a bypass mode right now. A parent that only has a saved
  bypass selection (an idle conversation) does not qualify.
- `chat config set` selects a bypass value only when `--caller-token` proves the
  request comes from the target or its parent, and that conversation is loaded
  and running in a bypass mode right now.
- Otherwise the call fails with `PERMISSION_ESCALATION` before any change: pass
  the caller token from your host context, or choose a non-bypass mode. A bypass
  mode the agent applies by default (for example from the agent's configured
  default options, or a different child agent) is not a caller choice and is
  allowed.
- An explicit `--workspace`/`--project`, and the `--workspace` used by
  `agents inspect` and `agents config options`, must be a registered project or
  worktree (symlinks resolved) or a subdirectory of one.
- `worktrees create` and `chat spawn --new-worktree` require the project path
  to be a registered root project itself: not a subdirectory and not a
  worktree.

### Caller identity

Each prompt's Camber host context carries a `callerToken` beside the
`instanceId` and `conversationId`. It is a random per-conversation secret that
lives in the desktop helper's memory until the helper restarts. The desktop
puts it only in that conversation's host context. It is not exported through
the agent process environment, which several conversations share, and it is not
shown in conversation lists or other CLI output (control responses replace
known tokens with `[redacted]`). Pass it with `--caller-token TOKEN`, or set
`CAMBER_CALLER_TOKEN` in your own command's environment. Do not write it to
files, task text, or other conversations.

The token is checked only where it unlocks extra permission: bypass modes on
`chat spawn` and `chat config set`. A missing or unknown token makes those
requests unproven; it does not otherwise fail them. No other action is scoped
to the caller. Any local process that can reach the desktop's control socket
(the same OS user) can still list, inspect, read, send to, steer or stop any
conversation, and spawn non-bypass children under any parent. The token stops
one conversation borrowing another's bypass mode through the CLI; it is not a
sandbox against a process that can read your files.

After a session closes or the helper restarts, configuration discovery,
updates, and continuations restore saved selections before proceeding.
Same-agent children also inherit saved parent selections when the parent is
not currently loaded.

## Read and follow output

Send to an existing conversation and follow the response:

```sh
camber chat send CHILD --text @follow-up.txt --follow --json
```

Or resume from a saved cursor:

```sh
camber chat poll CHILD --turn TURN --cursor CURSOR --wait-ms 30000 --json
camber chat watch CHILD --turn TURN --cursor CURSOR --json
camber chat output CHILD --turn TURN --json
camber chat snapshot CHILD --json
```

Follow/watch output is newline-delimited JSON. Save `nextCursor` after
processing each poll page. Disconnecting a reader does not stop generation;
`camber chat stop CHILD --turn TURN` is explicit cancellation. Transport
failure does not mean a task failed, and should not cause an automatic resubmit.
Inspect the conversation result and status to confirm completion.
Watch retries an unexpectedly closed connection up to three times from the
last emitted cursor. It does not resend the prompt. Persistent connection
failure exits with an error so a caller can inspect and resume explicitly.
Watch exits unsuccessfully for failed, cancelled, or interrupted turns.
Pending approvals remain in the desktop workflow. Steering requires support
from the selected agent; inspect the returned outcome before assuming it was
accepted.
Steering has no idempotency key: inspect uncertain delivery before retrying.
While waiting for approval, watch polls every five seconds and suppresses
identical waiting pages.

Output replay is bounded. A response with `resetRequired: true` or
`truncated: true` does not contain a complete replay. `chat snapshot` returns
the session output that is still retained and a cursor for continuing from
there; it cannot restore evicted output. Check the desktop transcript for
earlier or missing content, and do not treat partial text as a completed
answer. `--wait-ms` accepts values from 0 through 30000.

Each page stays small enough for the CLI transport. An event larger than
192 KiB is reduced in poll, watch, output and snapshot responses: bulky tool
output, raw input/output, `_meta` and images become size placeholders, long
text is truncated with a marker, and the event carries
`_poolside: {"truncated": true, "originalBytes": N}`. The stored history and
remote clients keep the full event.
When any event on a page was reduced, that page returns `truncated: true` and
`reducedEvents: N`. In `output` and `snapshot` responses,
`agentTextTruncated: true` means agent message text on that page was cut, and
`complete` is then `false` even though the turn finished. A reduced event can
sit on an earlier page of a multi-page read, so treat the answer as complete
only if no page you read had `truncated: true`; read the full text in the
desktop transcript instead.
UI-started turns can also be read by their original turn ID after a later turn
starts, while their turn records and output remain retained in the helper.

Opening a running child in the desktop attaches to the helper's retained
conversation stream without reloading the agent session. Running tools and
the agent's current configuration are preserved. If a complete transcript is
unavailable (for example, its beginning was evicted or the session was restored
from disk), opening it returns `SESSION_ACTIVE`; the agent continues working.
Wait for completion and reopen it to load its persisted history. Older clients
without live-attachment support also receive this error instead of interrupting
the agent. Closing or resuming an active session is rejected as busy.

## Choose a desktop instance

The CLI uses the inherited `CAMBER_INSTANCE_ID` when available. Otherwise it
connects when exactly one live desktop instance is discoverable, and reports an
error if there are none or several. List live instances with:

```sh
camber instances list --json
```

Select one explicitly with `--instance ID`, or set `CAMBER_INSTANCE_ID`.
`CAMBER_CONTROL_DIR` can override the platform's discovery directory. The CLI
checks the selected instance's live identity before sending each command and
pins that identity for a streaming invocation.

## Command groups

The current CLI command surface is:

- `instances list`, `status`, `context`
- `actions list`, `actions describe`, `do`
- `agents list`, `agents inspect`, `agents config options`
- `projects list`
- `worktrees list`, `inspect`, `create`, `remove`
- `chat list`, `inspect`, `children`, `snapshot`, `spawn`, `config list`,
  `config set`, `send`, `steer`, `stop`, `poll`, `output`, `watch`
- `skill show`, `skill setup`, `skill status`, `skill remove`
- `cli install`

Use `camber --help` and `camber COMMAND --help` for syntax and flags. Add
`--json` for structured results and machine-readable errors.
