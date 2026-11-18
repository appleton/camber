package methods

// ACPNavAgentServersDidChangeMethod is broadcast to every surface (primary +
// remotes) after camber/acpNav/setAgentServers changes the agent server
// store, whoever made the change (a settings panel, a default pin, or a
// control action). The payload is empty: receivers re-list the store, which
// keeps coalesced or reordered notifications idempotent.
const ACPNavAgentServersDidChangeMethod = acpNavMethodPrefix + "agentServersDidChange"

type ACPNavAgentServersDidChangeParams struct{}

func (p ACPNavAgentServersDidChangeParams) MethodName() string {
	return ACPNavAgentServersDidChangeMethod
}
