---
name: camber
description: Use the camber CLI to delegate work to Camber conversations, configure agents, manage worktrees, and read agent output.
---

Run `camber skill show` and follow the guide it prints.
Use `camber <command> --help` for task-specific details.
Pass the `callerToken` from your Camber host context with `--caller-token` on `chat spawn`, `chat config set`, `chat send` and `chat steer`; permission-bypass modes, and prompting a conversation in one, require it. Keep it private.
If the guide cannot load, run `camber status --json` and `camber --help`.
