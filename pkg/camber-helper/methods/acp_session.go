package methods

import (
	"encoding/json"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/appleton/camber/pkg/acp"
)

const acpMethodPrefix = "camber/acp/"

const ACPSessionSteeringExtensionMethod = "_session/steering"

// ACPUserMessageSteerMetaKey marks a relayed user_message_chunk as steering
// the active turn rather than starting a new prompt.
const ACPUserMessageSteerMetaKey = "camber/steer"

// ACPSteerFallbackMetaKey marks a session/prompt that re-delivers a steer
// message the agent declined to inject (outcome promptRequired). Steer already
// mirrored that user message to the other surfaces, so the prompt path must
// not mirror this copy again.
const ACPSteerFallbackMetaKey = "camber/steer_fallback"

// ACP method names for client → agent requests.
const (
	ACPInitializeMethod           = acpMethodPrefix + acpsdk.AgentMethodInitialize
	ACPAuthenticateMethod         = acpMethodPrefix + acpsdk.AgentMethodAuthenticate
	ACPLogoutMethod               = acpMethodPrefix + acpsdk.AgentMethodLogout
	ACPNewSessionMethod           = acpMethodPrefix + acpsdk.AgentMethodSessionNew
	ACPLoadSessionMethod          = acpMethodPrefix + acpsdk.AgentMethodSessionLoad
	ACPResumeSessionMethod        = acpMethodPrefix + acpsdk.AgentMethodSessionResume
	ACPListSessionsMethod         = acpMethodPrefix + acpsdk.AgentMethodSessionList
	ACPPromptMethod               = acpMethodPrefix + acpsdk.AgentMethodSessionPrompt
	ACPSteerMethod                = acpMethodPrefix + ACPSessionSteeringExtensionMethod
	ACPCancelMethod               = acpMethodPrefix + acpsdk.AgentMethodSessionCancel
	ACPSetModeMethod              = acpMethodPrefix + acpsdk.AgentMethodSessionSetMode
	ACPSetConfigOptionMethod      = acpMethodPrefix + acpsdk.AgentMethodSessionSetConfigOption
	ACPDeleteSessionMethod        = acpMethodPrefix + acpsdk.AgentMethodSessionDelete
	ACPCloseSessionMethod         = acpMethodPrefix + acpsdk.AgentMethodSessionClose
	ACPRenameSessionMethod        = acpMethodPrefix + acp.ExtensionMethodSessionRename
	ACPRestartServerMethod        = acpMethodPrefix + "server/restart"
	ACPMCPSettingsMethod          = acpMethodPrefix + acp.ExtensionMethodMCPSettings
	ACPMCPSetServerDisabledMethod = acpMethodPrefix + acp.ExtensionMethodMCPSetServerDisabled
	ACPMCPDeleteSecretsMethod     = acpMethodPrefix + acp.ExtensionMethodMCPDeleteSecrets
	ACPMCPAuthenticateMethod      = acpMethodPrefix + acp.ExtensionMethodMCPAuthenticate
	ACPMCPSetInputVariableMethod  = acpMethodPrefix + acp.ExtensionMethodMCPSetInputVariable
	ACPElicitationCreateMethod    = acpMethodPrefix + "elicitation/create"
	ACPElicitationResponseMethod  = ACPElicitationCreateMethod + "resp"
	ACPCompactionUpdateMethod     = acpMethodPrefix + "compaction_update"
	ACPTurnEndedMethod            = acpMethodPrefix + "turn_ended"
)

// Generic JSON-RPC bridge method names for agent → client messages.
const (
	JSONRPCNotifyMethod  = "camber/jsonrpc/notify"
	JSONRPCRequestMethod = "camber/jsonrpc/request"
)

const ACPAgentServerDidExitMethod = "camber/acp/serverDidExit"

type ACPAgentServerDidExitParams struct {
	AgentServer string `json:"agentServer"`
	Error       string `json:"error,omitempty"`
}

type ACPAgentServerParams struct {
	AgentServer string `json:"agentServer,omitempty"`
}

// Client → Agent: ACP SDK request types plus helper routing metadata.
type ACPInitializeParams struct {
	ACPAgentServerParams
	acpsdk.InitializeRequest
}

type ACPAuthenticateParams struct {
	ACPAgentServerParams
	acpsdk.AuthenticateRequest
}

type ACPLogoutParams struct {
	ACPAgentServerParams
	acpsdk.LogoutRequest
}

type ACPNewSessionParams struct {
	ACPAgentServerParams
	acpsdk.NewSessionRequest
}

type ACPLoadSessionParams struct {
	ACPAgentServerParams
	acpsdk.LoadSessionRequest
}

type ACPResumeSessionParams struct {
	ACPAgentServerParams
	acpsdk.ResumeSessionRequest
}

type ACPListSessionsParams struct {
	ACPAgentServerParams
	acpsdk.ListSessionsRequest
}

type ACPDeleteSessionParams struct {
	ACPAgentServerParams
	acpsdk.DeleteSessionRequest
}

type ACPCloseSessionParams struct {
	ACPAgentServerParams
	acpsdk.CloseSessionRequest
}

type ACPRenameSessionParams struct {
	ACPAgentServerParams
	acp.SessionRenameRequest
}

type ACPPromptParams struct {
	ACPAgentServerParams
	acpsdk.PromptRequest
}

type ACPSteerRequest struct {
	SessionID acpsdk.SessionId      `json:"sessionId"`
	Prompt    []acpsdk.ContentBlock `json:"prompt"`
	Meta      map[string]any        `json:"_meta,omitempty"`
}

type ACPSteerParams struct {
	ACPAgentServerParams
	ACPSteerRequest
}

type ACPSteerOutcome string

const (
	ACPSteerOutcomeInjected ACPSteerOutcome = "injected"
	ACPSteerOutcomeFailed   ACPSteerOutcome = "failed"
	// The agent had no running turn and left the message undelivered for the
	// client to re-send as an ordinary prompt (idleBehavior "promptRequired").
	ACPSteerOutcomePromptRequired ACPSteerOutcome = "promptRequired"
	// The agent had no running turn and started a detached turn itself — the
	// legacy default of agents predating the promptRequired opt-in.
	ACPSteerOutcomeStartedNewTurn ACPSteerOutcome = "startedNewTurn"
)

type ACPSteerOutput struct {
	Outcome ACPSteerOutcome `json:"outcome"`
}

type ACPCancelParams struct {
	ACPAgentServerParams
	acpsdk.CancelNotification
}

type ACPSetModeParams struct {
	ACPAgentServerParams
	acpsdk.SetSessionModeRequest
}

type ACPSetConfigOptionParams struct {
	ACPAgentServerParams
	acpsdk.SetSessionConfigOptionRequest
}

type ACPMCPSettingsParams struct {
	ACPAgentServerParams
	acp.MCPSettingsRequest
}

type ACPMCPSetServerDisabledParams struct {
	ACPAgentServerParams
	acp.MCPSetServerDisabledRequest
}

type ACPMCPDeleteSecretsParams struct {
	ACPAgentServerParams
	acp.MCPDeleteSecretsRequest
}

type ACPMCPAuthenticateParams struct {
	ACPAgentServerParams
	acp.MCPAuthenticateRequest
}

type ACPMCPSetInputVariableParams struct {
	ACPAgentServerParams
	acp.MCPSetInputVariableRequest
}

func (p *ACPInitializeParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.InitializeRequest)
}

func (p *ACPAuthenticateParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.AuthenticateRequest)
}

func (p *ACPLogoutParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.LogoutRequest)
}

func (p *ACPNewSessionParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.NewSessionRequest)
}

func (p *ACPLoadSessionParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.LoadSessionRequest)
}

func (p *ACPResumeSessionParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.ResumeSessionRequest)
}

func (p *ACPListSessionsParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.ListSessionsRequest)
}

func (p *ACPDeleteSessionParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.DeleteSessionRequest)
}

func (p *ACPCloseSessionParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.CloseSessionRequest)
}

func (p *ACPRenameSessionParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.SessionRenameRequest)
}

func (p *ACPPromptParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.PromptRequest)
}

func (p *ACPSteerParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.ACPSteerRequest)
}

func (p *ACPCancelParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.CancelNotification)
}

func (p *ACPSetModeParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.SetSessionModeRequest)
}

func (p *ACPSetConfigOptionParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.SetSessionConfigOptionRequest)
}

func (p *ACPMCPSettingsParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.MCPSettingsRequest)
}

func (p *ACPMCPSetServerDisabledParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.MCPSetServerDisabledRequest)
}

func (p *ACPMCPDeleteSecretsParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.MCPDeleteSecretsRequest)
}

func (p *ACPMCPAuthenticateParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.MCPAuthenticateRequest)
}

func (p *ACPMCPSetInputVariableParams) UnmarshalJSON(b []byte) error {
	return decodeACPParams(b, &p.AgentServer, &p.MCPSetInputVariableRequest)
}

func decodeACPParams(b []byte, agentServer *string, request any) error {
	var routing ACPAgentServerParams
	if err := json.Unmarshal(b, &routing); err != nil {
		return err
	}
	if err := json.Unmarshal(b, request); err != nil {
		return err
	}
	*agentServer = routing.AgentServer
	return nil
}

type (
	ACPInitializeOutput           = acpsdk.InitializeResponse
	ACPAuthenticateOutput         = acpsdk.AuthenticateResponse
	ACPLogoutOutput               = acpsdk.LogoutResponse
	ACPNewSessionOutput           = acpsdk.NewSessionResponse
	ACPLoadSessionOutput          = acpsdk.LoadSessionResponse
	ACPResumeSessionOutput        = acpsdk.ResumeSessionResponse
	ACPListSessionsOutput         = acpsdk.ListSessionsResponse
	ACPPromptOutput               = acpsdk.PromptResponse
	ACPCancelOutput               = struct{}
	ACPSetModeOutput              = acpsdk.SetSessionModeResponse
	ACPSetConfigOptionOutput      = acpsdk.SetSessionConfigOptionResponse
	ACPDeleteSessionOutput        = acpsdk.DeleteSessionResponse
	ACPCloseSessionOutput         = acpsdk.CloseSessionResponse
	ACPRenameSessionOutput        = acp.SessionRenameResponse
	ACPMCPSettingsOutput          = acp.MCPSettingsResponse
	ACPMCPSetServerDisabledOutput = acp.MCPSetServerDisabledResponse
	ACPMCPDeleteSecretsOutput     = acp.MCPDeleteSecretsResponse
	ACPMCPAuthenticateOutput      = acp.MCPAuthenticateResponse
	ACPMCPSetInputVariableOutput  = acp.MCPSetInputVariableResponse
)

type ACPRestartServerOutput struct{}

// elicitation types are not yet in sdk
type ACPElicitationParams struct {
	ACPAgentServerParams
	ElicitationRequest
}

type ACPElicitationOutput ElicitationResponse

type ACPCompactionNotification acp.CompactionNotification

// ACPTurnEndedNotification is emitted by the helper after every prompt
// settles. Unlike agent-owned compaction phases, this terminal boundary is
// guaranteed even when the agent's summarizer fails or the turn is cancelled.
type ACPTurnEndedNotification struct {
	SessionID acpsdk.SessionId `json:"sessionId"`
}
