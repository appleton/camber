# Getting started with Camber Assistant

Camber Assistant is a client for coding agents that speak the
[Agent Client Protocol](https://agentclientprotocol.com/). After
[installing Camber Assistant](../INSTALL.md), open it and start a
conversation from your project.

## Step 1: Open Camber Assistant

Launch **Camber**, then open a project.

## Step 2: Connect an agent

Install an ACP-compatible agent or configure a custom agent, then select it
when starting a conversation.

### Use any ACP-compatible agent

Camber Assistant includes quick install options for tested third-party
agents, such as Claude, Codex, and Cursor, and agents from the public ACP
registry. Third-party agents run local code from their publisher. Install only
agents you trust, and review the command or binary before installing.

1. With Camber Assistant open, go to **Settings > ACP Agents**:
   - **Desktop app**: Click **Settings** in the sidebar, then click
     **ACP Agents**.
2. Click **Install** next to the agent you want to use.
3. Start a new conversation:
   - **Desktop app**: Click **New conversation**.
4. In the prompt controls, select the agent you installed.

### Use a local model on your device

Camber Local runs models on your own machine with the
[MLX framework](https://mlx-framework.org). Use it when you want the model runtime to stay on your device.

Camber Local requires the desktop app on a Mac with Apple silicon. The
**On-Device Models** settings run on the Mac hosting the desktop app.

1. In the desktop app, click **Settings** in the sidebar, then click
   **On-Device Models**.
2. Choose a model under **Recommended models**, or search Hugging Face for an
   MLX model, then download it.
   Gated and private Hugging Face models need the **Hugging Face** connector.
   If the model you chose needs it, Camber Assistant sends you to
   **Connectors** to add the connector and sign in to Hugging Face.
   Recommended models and ungated Hugging Face models download without a
   connector.
3. Start a new conversation.
4. In the prompt controls, select **Camber Local** as the agent, then select
   the model you downloaded.

### Use a custom agent

To use a custom agent that is not listed under **ACP Agents**, add it to
`assistant.json` in your Camber config directory. See
[Configure ACP agents](./acp-agent-configuration.md) for file locations, every
supported field, and examples for registry and development agents.

Use `agent_servers` to define the agent command:

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

## Step 3: Start your first task

In the conversation tab, confirm the agent, mode, thought level, and model, or
use the defaults. Then describe the task you want the agent to work on.

The agent may ask for approval before it reads files, runs commands, or edits
code.

## Step 4: Work with your agent

- Type `/` in the prompt to open commands and session controls. The available
  commands depend on the selected agent.
- Type `$` in the prompt to open skills, if the selected agent or workspace
  provides any.
- Add project context by mentioning files, folders, or other relevant details in
  the prompt.
- Use the prompt controls to adjust the mode, change the model, or use voice
  input before you send a prompt.
- Use the prompt controls or the `/agent` menu to change agents. Switching
  agents starts a new session and does not carry over the current conversation.
- Review changes before you keep them. The agent may edit files, but you remain
  responsible for accepting, changing, or reverting the result.
- Approve commands or tool use only when you understand what the agent is about
  to do.

## Step 5: Add connectors (optional)

Connectors are MCP servers that let agents use external tools and context, such
as GitHub, Linear, Jira, Notion, Sentry, Hugging Face, or PostgreSQL. Add a
listed connector or configure a custom MCP server if you want agents to access
those systems.

1. Open **Connectors**:
   - **Desktop app**: Click **Connectors** in the sidebar.
2. Add one of the listed connectors, or add a custom connector.

## Related resources

- [Install Camber Assistant](../INSTALL.md)
- [Contributing](../CONTRIBUTING.md)
- [Working on Camber Assistant with coding agents](./coding-with-agents.md)
