package methods

// JSONRPCError accords to the JSON-RPC spec, but restricts code to known enum values.
// It implements the error interface so it can be returned directly from handlers.
type JSONRPCError struct {
	Code    CamberErrorCode   `json:"code" doc:"application error code"`
	Message string            `json:"message" doc:"human-readable error message"`
	Data    *JSONRPCErrorData `json:"data,omitempty" doc:"code-specific structured data"`
}

type JSONRPCErrorData struct {
	EntityNotFound *EntityNotFoundData `json:"entityNotFound,omitempty" doc:"details when an entity_not_found error was returned"`
	UserConfig     *UserConfigData     `json:"userConfig,omitempty" doc:"details when a user_config_invalid error was returned"`
	AgentInstall   *AgentInstallData   `json:"agentInstall,omitempty" doc:"details when an agent_install_failed error was returned"`
}

type EntityNotFoundData struct {
	EntityType ErrorEntityType `json:"entityType" doc:"type of entity that was not found"`
	EntityID   string          `json:"entityId" doc:"identifier of the entity that was not found" format:"uuid"`
}

type UserConfigData struct {
	FilePath string `json:"filePath,omitempty" doc:"path to the invalid user settings file, when available"`
}

type AgentInstallData struct {
	AgentServer string `json:"agentServer" doc:"name of the ACP agent server whose distribution could not be resolved or downloaded"`
}

func (e *JSONRPCError) Error() string {
	return e.Message
}

func (e *JSONRPCError) Is(other error) bool {
	o, ok := other.(*JSONRPCError)
	return ok && e.Code == o.Code
}
