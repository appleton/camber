# Configure ACP agents

Camber Assistant uses `assistant.json` to configure custom
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) agents and
defaults for registry-managed agents.

Registry agents and Camber Local are installed and managed from **Settings >
ACP Agents**. Edit `assistant.json` when you need to run a custom executable,
such as a development build of an agent.

## Configuration file

Camber reads `assistant.json` from:

- **macOS/Linux**: `~/.config/camber/assistant.json`
- **Windows**: `%USERPROFILE%\.config\camber\assistant.json`

If `XDG_CONFIG_HOME` is set, Camber uses
`$XDG_CONFIG_HOME/camber/assistant.json` instead.

New configuration files include the published
[JSON Schema](../schemas/assistant/v1.json):

```json
{
  "$schema": "https://raw.githubusercontent.com/appleton/camber/main/schemas/assistant/v1.json",
  "agent_servers": {}
}
```

The `$schema` field gives compatible editors validation, field descriptions,
and completion. The schema validates documented fields but accepts unknown
fields for compatibility with future Camber versions and other ACP clients.
`assistant.json` is strict JSON and does not support comments.

## Add a custom agent

Add an entry to `agent_servers`. The entry's key is the name shown in Camber
Assistant.

```json
{
  "$schema": "https://raw.githubusercontent.com/appleton/camber/main/schemas/assistant/v1.json",
  "agent_servers": {
    "my-agent": {
      "type": "custom",
      "command": "my-agent",
      "args": ["acp"]
    }
  }
}
```

`command` may be an executable name found on `PATH` or an absolute path.
Camber starts it directly and passes every `args` item verbatim; it does not
interpret shell syntax. If the agent requires a shell command, invoke the shell
explicitly:

```json
{
  "$schema": "https://raw.githubusercontent.com/appleton/camber/main/schemas/assistant/v1.json",
  "agent_servers": {
    "agent-from-source": {
      "type": "custom",
      "command": "bash",
      "args": [
        "-lc",
        "cd /path/to/agent && exec ./run-agent acp"
      ]
    }
  }
}
```

### Run a development build of Poolside Agent

The registry-managed Poolside Agent remains available as `poolside`. Give a
development executable a different name so both versions are available:

```json
{
  "$schema": "https://raw.githubusercontent.com/appleton/camber/main/schemas/assistant/v1.json",
  "agent_servers": {
    "pool-main": {
      "type": "custom",
      "command": "/Users/me/.local/bin/pool",
      "args": ["acp"],
      "default_config_options": {
        "mode": "always-allow"
      }
    }
  },
  "default_agent_server": "pool-main"
}
```

## Configure a registry agent

Install and remove registry agents from **Settings > ACP Agents**. An
`assistant.json` registry entry stores only the agent type and optional default
configuration; Camber manages its command and distribution separately.

```json
{
  "$schema": "https://raw.githubusercontent.com/appleton/camber/main/schemas/assistant/v1.json",
  "agent_servers": {
    "claude-acp": {
      "type": "registry",
      "default_config_options": {
        "mode": "auto",
        "model": "claude-sonnet"
      }
    }
  }
}
```

Do not copy registry distribution fields such as `command` or `binary` into a
registry entry. Install the agent through the UI instead.

## Fields

| Field | Type | Behavior |
| --- | --- | --- |
| `agent_servers` | object | Maps display names to ACP agent configurations. |
| `default_agent_server` | string | Selects the agent for new conversations. Defaults to `poolside`. |
| `type` | `custom`, `registry`, or `local` | `custom` starts your command, `registry` uses a UI-managed registry installation, and `local` is reserved for Camber Local. A custom entry may omit `type`. |
| `command` | string | Executable name or path for a custom agent. Required for custom agents. |
| `args` | string array | Arguments passed verbatim to the custom agent. |
| `env` | string map | Variables added to the agent process environment. |
| `default_config_options` | string map | Agent-defined select option IDs and values used as defaults for new sessions. |

`default_config_options` is agent-specific. Camber applies a value only when
the agent advertises a matching select option and valid value. Use the option
IDs and values shown by that agent in the conversation controls.

The old agent name `default` is accepted as an alias for `poolside`, but new
configuration should use `poolside`.

## Environment variables and secrets

Values in `env` are stored as plain text in `assistant.json`. Do not store API
keys, tokens, or other secrets there. Prefer an agent's login flow, inherited
environment, or Camber's connector and secret-management UI.

## Apply changes

After editing `assistant.json` manually, restart Camber Assistant so the
agent picker and running subprocesses use the new configuration.

Changes made through Camber's settings controls stop the affected subprocess
automatically.

Malformed JSON does not prevent Camber Assistant from starting. Camber
continues with the last loaded agent configuration and shows an error above the
conversation composer. Fix the file, then select **Retry** in that banner.

## Troubleshooting

- Use a JSON-aware editor with the `$schema` field enabled for completion and
  validation of documented fields. Unknown fields are intentionally accepted.
- Fields used by other ACP clients are not necessarily supported. For example,
  Camber ignores Zed's `favorite_config_option_values`, but the schema accepts
  it for compatibility.
- Use separate names for registry and development builds, such as `poolside`
  and `pool-main`.
- If an executable is not found, use its absolute path.
