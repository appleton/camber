package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/hashicorp/golang-lru/v2/expirable"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
	protocol "github.com/tliron/glsp/protocol_3_16"

	protocol3 "github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	cache2 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/pkg/cache"
	file2 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/pkg/file"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpnav"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpproxy"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/approvals"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/control"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/filesearch"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/localinference"
	acpsdk "github.com/coder/acp-go-sdk"

	githandler "github.com/appleton/camber/pkg/camber-helper/internal/handler/git"
	githubhandler "github.com/appleton/camber/pkg/camber-helper/internal/handler/github"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/mcpservers"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteterminal"
	secretshandler "github.com/appleton/camber/pkg/camber-helper/internal/handler/secrets"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/voiceinput"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	"github.com/appleton/camber/pkg/workspace/ignore"
)

// CamberHandler embeds the regular protocol.Handler but overrides the Handle method to allow us
// to pass our own custom messages
//
// N.B. please put new sets of handlers in their own packages, e.g. a new handler/$foo package (see git and acpnav for implementation).
// Via embedding you can avoid needing to write wrapper methods.
type CamberHandler struct {
	protocol.Handler

	// protects mutable fields below.
	mx sync.Mutex

	// in-flight requests, or pending requests, mapped by JSONRPC requestID (nothing to do with camber request IDs)
	requestCancelByID map[string]cancelState

	// handlers for JSONRPC extension methods, by method name
	extensionHandlers map[string]MethodHandler

	// methods that are safe to run concurrently
	concurrentMethods map[string]struct{}
	// methods that should not inherit the default request deadline
	noDeadlineMethods map[string]struct{}

	// huma - used for validation and doc generation only. Request handling goes via the LSP/JSONRPC server.
	huma                huma.API
	schemaMu            sync.Mutex
	schemaRegistrations []func(huma.API)
	cachedFS            overlayFs

	docLocks map[string]*sync.Mutex

	// set after init
	config           *Config
	workspaceFolders []protocol.WorkspaceFolder

	pprofStarted   sync.Once
	abortListeners map[string][]func()

	// A cache based on workspace directory paths to cache the checkers for paths
	// in the same directories. Entries expire after 15 mins to keep ingore config
	// up-to-date.
	ignoredCheckerCache *expirable.LRU[string, ignore.CheckIgnoredFunc]

	// fan-out of helper->client traffic to remote access clients
	remoteHub    *remoteaccess.Hub
	remoteAccess *remoteaccess.Server
	// sequenced live session events for stamping, fan-out, and cursor resume
	sessionLog *remoteaccess.SessionLog
	// helper-side PTYs for remote (mobile) clients
	remoteTerminals *remoteterminal.Manager

	// endpoints
	controlHandler             *control.Service
	acpProxyHandler            *acpproxy.Handler
	acpNavHandler              *acpnav.Server
	fileSearchHandler          *filesearch.Server
	localInferenceHandler      *localinference.Server
	voiceInputHandler          *voiceinput.Server
	secretsHandler             *secretshandler.Server
	githubHandler              *githubhandler.Server
	gitHandler                 *githandler.Server
	mcpServersHandler          *mcpservers.Server
	clientSupportsWatchedFiles bool

	receivedShutdown atomic.Bool
	// cleanupFns only for things that wouldn't be safely cleaned up
	// by normal process exit (os will already free memory, close open file
	// handles etc).
	cleanupFns []func() error
}

type MethodHandler func(ctx context.Context, lspReq *glsp.Context) (any, error)

type overlayFs interface {
	StatFile(ctx context.Context, uri protocol3.DocumentURI) (os.FileInfo, error)
	ReadFile(ctx context.Context, uri protocol3.DocumentURI) (file2.Handle, error)
	ApplyModifications(ctx context.Context, changes []file2.Modification) error
}

func New() *CamberHandler {
	handler := newHandlerBaseState()

	// Note: potentially we could switch over to golsp's LSP handler, and drop glsp. glsp was
	// used before we vendored the golsp code
	handler.Handler = protocol.Handler{
		Initialize:    handler.initialize,
		Initialized:   handler.initialized,
		Shutdown:      handler.shutdown,
		Exit:          handler.exit,
		SetTrace:      setTrace,
		LogTrace:      logTrace,
		CancelRequest: handler.cancelRequest,

		WorkspaceDidChangeConfiguration: handler.WorkspaceDidChangeConfiguration,
		// n.b., generally we use registerLSPMethod
		// as generally it's better to use gopls's protocol types (they
		// handle VSCode's weird encoding. glsp's protocol package doesn't)
	}

	// these are standard methods, but the gopls types handle VSCode's unusual
	// escaping of DocumentURIs, so it makes sense to register them here.
	registerLSPMethod(handler, JSONRPCOperation{
		Method: "textDocument/didOpen",
	}, handler.TextDocumentDidOpen)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "textDocument/didChange",
	}, handler.TextDocumentDidChange)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "textDocument/didClose",
	}, handler.TextDocumentDidClose)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "workspace/didChangeWorkspaceFolders",
	}, handler.WorkspaceDidChangeWorkspaceFolders)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "workspace/didChangeWatchedFiles",
	}, handler.WorkspaceDidChangeWatchedFiles)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "workspace/willDeleteFiles",
	}, handler.WorkspaceWillDeleteFiles)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "workspace/didDeleteFiles",
	}, handler.WorkspaceDidDeleteFiles)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "workspace/didCreateFiles",
	}, handler.WorkspaceDidCreateFiles)

	registerLSPMethod(handler, JSONRPCOperation{
		Method: "workspace/didRenameFiles",
	}, handler.WorkspaceDidRenameFiles)

	// camber methods
	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.RuntimeFilesParams{}.MethodName(),
		Description: methods.RuntimeFilesParams{}.Description(),
	}, handler.runtimeFiles)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.SearchFilesParams{}.MethodName(),
		Description: methods.SearchFilesParams{}.Description(),
	}, handler.fileSearchHandler.Search)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      "camber/hello",
		Description: "simple ping/pong endpoint for verification",
	}, handler.helloHandler)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      "camber/listSkills",
		Description: "list all installed skills from workspace and user directories",
	}, handler.listSkillsHandler)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.InitiateMCPOAuthParams{}.MethodName(),
		Description: "Initiate OAuth flow for MCP server authentication",
	}, handler.InitiateMCPOAuth)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPOAuthCallbackParams{}.MethodName(),
		Description: "Complete a pending MCP OAuth flow with a deep-link redirect callback URL",
	}, handler.MCPOAuthCallback)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.DeleteMCPSecretsParams{}.MethodName(),
		Description: "Delete secrets for an MCP server",
	}, handler.DeleteMCPSecrets)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.AbortParams{}.MethodName(),
		Description: "aborts a long-running operation",
	}, handler.Abort)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GetUserConfigParams{}.MethodName(),
		Description: methods.GetUserConfigParams{}.Description(),
	}, handler.GetUserConfig)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.UpsertSecretParams{}.MethodName(),
		Description: methods.UpsertSecretParams{}.Description(),
	}, handler.secretsHandler.UpsertSecret)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.DeleteSecretParams{}.MethodName(),
		Description: methods.DeleteSecretParams{}.Description(),
	}, handler.secretsHandler.DeleteSecret)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ListSecretsParams{}.MethodName(),
		Description: methods.ListSecretsParams{}.Description(),
	}, handler.secretsHandler.ListSecrets)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GetSecretParams{}.MethodName(),
		Description: methods.GetSecretParams{}.Description(),
	}, handler.secretsHandler.GetSecret)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitHubWorktreeStatusesParams{}.MethodName(),
		Description: methods.GitHubWorktreeStatusesParams{}.Description(),
	}, handler.githubHandler.WorktreeStatuses)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitHubPRDetailParams{}.MethodName(),
		Description: methods.GitHubPRDetailParams{}.Description(),
	}, handler.githubHandler.PRDetail)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitHubAuthStatusParams{}.MethodName(),
		Description: methods.GitHubAuthStatusParams{}.Description(),
	}, handler.githubHandler.AuthStatus)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitHubSetTokenParams{}.MethodName(),
		Description: methods.GitHubSetTokenParams{}.Description(),
	}, handler.githubHandler.SetToken)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitHubPRURLParams{}.MethodName(),
		Description: methods.GitHubPRURLParams{}.Description(),
	}, handler.githubHandler.PRUrl)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitHubLinksParams{}.MethodName(),
		Description: methods.GitHubLinksParams{}.Description(),
	}, handler.githubHandler.Links)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitHubFetchImageParams{}.MethodName(),
		Description: methods.GitHubFetchImageParams{}.Description(),
	}, handler.githubHandler.FetchImage)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitStatusParams{}.MethodName(),
		Description: methods.GitStatusParams{}.Description(),
	}, handler.gitHandler.Status)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiffFileParams{}.MethodName(),
		Description: methods.GitDiffFileParams{}.Description(),
	}, handler.gitHandler.DiffFile)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiffOpenParams{}.MethodName(),
		Description: methods.GitDiffOpenParams{}.Description(),
	}, handler.gitHandler.DiffOpen)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiffListParams{}.MethodName(),
		Description: methods.GitDiffListParams{}.Description(),
	}, handler.gitHandler.DiffList)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiffReadParams{}.MethodName(),
		Description: methods.GitDiffReadParams{}.Description(),
	}, handler.gitHandler.DiffRead)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiffContentsParams{}.MethodName(),
		Description: methods.GitDiffContentsParams{}.Description(),
	}, handler.gitHandler.DiffContents)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiffStatsParams{}.MethodName(),
		Description: methods.GitDiffStatsParams{}.Description(),
	}, handler.gitHandler.DiffStats)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiffCloseParams{}.MethodName(),
		Description: methods.GitDiffCloseParams{}.Description(),
	}, handler.gitHandler.DiffClose)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitStageParams{}.MethodName(),
		Description: methods.GitStageParams{}.Description(),
	}, handler.gitHandler.Stage)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitUnstageParams{}.MethodName(),
		Description: methods.GitUnstageParams{}.Description(),
	}, handler.gitHandler.Unstage)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitDiscardParams{}.MethodName(),
		Description: methods.GitDiscardParams{}.Description(),
	}, handler.gitHandler.Discard)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.GitCommitParams{}.MethodName(),
		Description: methods.GitCommitParams{}.Description(),
	}, handler.gitHandler.Commit)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersListParams{}.MethodName(),
		Description: "list user MCP servers",
	}, handler.mcpServersHandler.List)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersUpsertParams{}.MethodName(),
		Description: "add or replace a user MCP server",
	}, handler.mcpServersHandler.Upsert)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersDeleteParams{}.MethodName(),
		Description: "delete a user MCP server",
	}, handler.mcpServersHandler.Delete)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersSetEnabledParams{}.MethodName(),
		Description: "enable or disable a user MCP server",
	}, handler.mcpServersHandler.SetEnabled)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersAuthenticateParams{}.MethodName(),
		Description: "initiate OAuth flow for a user MCP server",
	}, handler.mcpServersHandler.Authenticate)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersSignOutParams{}.MethodName(),
		Description: "sign out (clear OAuth tokens) for a user MCP server",
	}, handler.mcpServersHandler.SignOut)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersTestConnectionParams{}.MethodName(),
		Description: "run a transient probe against a user MCP server",
	}, handler.mcpServersHandler.TestConnection)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersTestConfigParams{}.MethodName(),
		Description: "run a transient probe against an inline (unsaved) MCP server config",
	}, handler.mcpServersHandler.TestConfig)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.MCPServersSetPoolServerDisabledParams{}.MethodName(),
		Description: "enable/disable a pool MCP server globally via user settings",
	}, handler.mcpServersHandler.SetPoolServerDisabled)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.LocalInferenceGetStateMethod,
		Description: "returns local on-device inference state and catalog",
	}, handler.localInferenceHandler.GetState)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.LocalInferenceSetDefaultModelMethod,
		Description: "updates the default local on-device model",
	}, handler.localInferenceHandler.SetDefaultModel)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.LocalInferenceSearchModelsMethod,
		Description: "searches Hugging Face for installable local on-device models",
	}, handler.localInferenceHandler.SearchModels)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.LocalInferenceDownloadModelMethod,
		Description: "starts downloading a local on-device model",
	}, handler.localInferenceHandler.DownloadModel)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.LocalInferenceCancelDownloadMethod,
		Description: "cancels the download of a local on-device model",
	}, handler.localInferenceHandler.CancelDownload)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.LocalInferenceDeleteModelMethod,
		Description: "deletes a local on-device model from disk",
	}, handler.localInferenceHandler.DeleteModel)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.LocalInferenceUnloadModelMethod,
		Description: "releases the model resident in the local sidecar's memory",
	}, handler.localInferenceHandler.UnloadModel)

	registerExtensionMethodNoDeadline(handler, JSONRPCOperation{Method: methods.ControlDispatchMethod, Description: "dispatches discoverable local desktop orchestration actions"}, handler.controlHandler.Dispatch)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavListMethod,
		Description: "lists locally pinned ACP projects, worktrees, and active conversations",
	}, handler.ACPNavList)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavCreateChatMethod,
		Description: "creates the XDG state working directory for a chat session",
	}, handler.acpNavHandler.CreateChat)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavUpsertProjectMethod,
		Description: "adds or updates a locally known ACP project or worktree",
	}, handler.ACPNavUpsertProject)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavRenameProjectMethod,
		Description: "renames a locally known ACP project or worktree",
	}, handler.acpNavHandler.RenameProject)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavSetProjectCollapsedMethod,
		Description: "updates the locally persisted collapsed state for an ACP project",
	}, handler.acpNavHandler.SetProjectCollapsed)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavReorderProjectsMethod,
		Description: "updates the locally persisted order for root ACP projects",
	}, handler.acpNavHandler.ReorderProjects)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavReorderWorktreesMethod,
		Description: "updates the locally persisted order for a project's worktrees",
	}, handler.acpNavHandler.ReorderWorktrees)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavGetProjectSettingsMethod,
		Description: "gets setup and teardown scripts for an ACP project",
	}, handler.acpNavHandler.GetProjectSettings)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavSetProjectSettingsMethod,
		Description: "updates setup and teardown scripts for an ACP project",
	}, handler.acpNavHandler.SetProjectSettings)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavPrepareWorktreeMethod,
		Description: "reserves a name for the next ACP worktree without touching the filesystem or database",
	}, handler.ACPNavPrepareWorktree)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavReleasePreparedWorktreeMethod,
		Description: "releases a name previously reserved by prepareWorktree",
	}, handler.ACPNavReleasePreparedWorktree)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavCreateWorktreeMethod,
		Description: "creates a git worktree for an ACP project and stores it locally",
	}, handler.ACPNavCreateWorktree)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavRemoveProjectMethod,
		Description: "removes an ACP project and its worktrees/conversations from local navigation state",
	}, handler.ACPNavRemoveProject)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavRemoveWorktreeMethod,
		Description: "removes a git worktree from disk and from local ACP navigation state",
	}, handler.ACPNavRemoveWorktree)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavUpsertConversationMethod,
		Description: "adds or restores a conversation in the locally active ACP navigation list",
	}, handler.acpNavHandler.UpsertConversation)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavPrepareConversationHandoffMethod,
		Description: "durably freezes the current ACP session leg before handing a conversation to another agent",
	}, handler.acpNavHandler.PrepareConversationHandoff)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavAbortConversationHandoffMethod,
		Description: "discards an uncommitted ACP conversation handoff",
	}, handler.acpNavHandler.AbortConversationHandoff)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavGetConversationHistoryMethod,
		Description: "loads completed ACP agent legs for a conversation",
	}, handler.acpNavHandler.GetConversationHistory)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavRestoreConversationMethod,
		Description: "restores an archived ACP conversation and recreates its project entry",
	}, handler.acpNavHandler.RestoreConversation)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavArchiveConversationMethod,
		Description: "archives a conversation from the locally active ACP navigation list",
	}, handler.acpNavHandler.ArchiveConversation)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavRenameConversationMethod,
		Description: "renames a conversation in local ACP navigation state",
	}, handler.acpNavHandler.RenameConversation)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavDeleteConversationMethod,
		Description: "deletes conversations with a matching ACP session from local navigation state",
	}, handler.acpNavHandler.DeleteConversation)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavListAgentServersMethod,
		Description: "lists locally enabled ACP agent servers",
	}, handler.ACPNavListAgentServers)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavCheckAgentRuntimesMethod,
		Description: "reports whether the runtimes registry ACP agent distributions launch through are available",
	}, handler.CheckACPNavAgentRuntimes)

	registerExtensionMethodNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPNavInstallAgentServerMethod,
		Description: "downloads and unpacks registry ACP agent server assets before enabling the server",
	}, handler.InstallACPNavAgentServer)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavSetAgentServersMethod,
		Description: "replaces the locally enabled ACP agent servers",
	}, handler.SetACPNavAgentServers)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavGetConfigCacheMethod,
		Description: "gets cached ACP session configuration options for an agent server",
	}, handler.acpNavHandler.GetConfigCache)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavUpsertConfigCacheMethod,
		Description: "updates cached ACP session configuration options for an agent server",
	}, handler.acpNavHandler.UpsertConfigCache)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavSetConversationViewStateMethod,
		Description: "updates transient editor view state for an ACP conversation",
	}, handler.acpNavHandler.SetConversationViewState)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavGetFileOpenerMethod,
		Description: "gets the user's preferred desktop file opener",
	}, handler.acpNavHandler.GetFileOpener)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavSetFileOpenerMethod,
		Description: "updates the user's preferred desktop file opener",
	}, handler.acpNavHandler.SetFileOpener)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavGetKeybindingsMethod,
		Description: "gets the user's desktop keyboard-shortcut overrides",
	}, handler.acpNavHandler.GetKeybindings)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavSetKeybindingsMethod,
		Description: "updates the user's desktop keyboard-shortcut overrides",
	}, handler.acpNavHandler.SetKeybindings)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavGetGithubColorModeMethod,
		Description: "gets the user's worktree status color mode",
	}, handler.acpNavHandler.GetGithubColorMode)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPNavSetGithubColorModeMethod,
		Description: "updates the user's worktree status color mode",
	}, handler.acpNavHandler.SetGithubColorMode)

	publishClientSideTypes(handler, methods.ACPNavDidChangeMethod, methods.ACPNavDidChangeParams{},
		"notifies the client when ACP navigation state changes")

	publishClientSideTypes(handler, methods.LocalInferenceDidChangeMethod, methods.LocalInferenceDidChangeParams{},
		"notifies the client when local on-device inference state changes")

	publishClientSideTypes(handler, methods.SearchSymbolDefinitionsParams{}.MethodName(), methods.SearchSymbolDefinitionsParams{},
		"allows the helper to lookup project symbols using the editor")

	publishClientSideTypes(handler, methods.SearchSymbolDefinitionsParams{}.MethodName()+"resp", methods.SearchSymbolDefinitionsOutput{},
		"allows the helper to lookup project symbols using the editor")

	publishClientSideTypes(handler, methods.GetDiagnosticsParams{}.MethodName(), methods.GetDiagnosticsParams{},
		"allows the helper to retrieve diagnostic information for a given file path")
	publishClientSideTypes(handler, methods.GetDiagnosticsParams{}.MethodName()+"resp", methods.GetDiagnosticsOutput{},
		"allows the helper to retrieve diagnostic information for a given file path")

	publishClientSideTypes(handler, methods.MCPOAuthURLParams{}.MethodName(), methods.MCPOAuthURLParams{},
		"notifies the client to open an OAuth URL in the browser for MCP server authentication")

	// ACP proxy methods
	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPInitializeMethod,
		Description: "initializes the ACP agent subprocess",
	}, handler.acpProxyHandler.Initialize)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPRestartServerMethod,
		Description: "restarts the ACP agent subprocess",
	}, handler.acpProxyHandler.RestartServer)

	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPAuthenticateMethod,
		Description: "authenticates with the ACP agent using a previously advertised auth method",
	}, handler.acpProxyHandler.Authenticate)

	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPLogoutMethod,
		Description: "logs out of the ACP agent's current authenticated state",
	}, handler.acpProxyHandler.Logout)

	// NewSession, LoadSession, and ResumeSession can take well over the default 5s serialized
	// timeout: ACP subprocess spin-up, agent-side auth checks, and the
	// session-creation work in the agent itself all stack up. They sit in the
	// same no-deadline bucket as Initialize, Authenticate, and Prompt; the
	// helper still cancels them when the client drops the request.
	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPNewSessionMethod,
		Description: "creates a new ACP session",
	}, handler.acpProxyHandler.NewSession)

	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPLoadSessionMethod,
		Description: "loads an existing ACP session",
	}, handler.acpProxyHandler.LoadSession)

	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPResumeSessionMethod,
		Description: "resumes an existing ACP session without replaying its transcript",
	}, handler.acpProxyHandler.ResumeSession)

	registerExtensionMethodUntyped(handler, JSONRPCOperation{
		Method:      methods.ACPListSessionsMethod,
		Description: "lists ACP sessions",
	}, handler.acpProxyHandler.ListSessions)

	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPPromptMethod,
		Description: "sends a prompt to the ACP agent subprocess",
	}, handler.acpProxyHandler.Prompt)

	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPSteerMethod,
		Description: "steers an ongoing ACP agent turn through its native extension",
	}, handler.acpProxyHandler.Steer)

	registerUnserializedExtensionMethodUntyped(handler, JSONRPCOperation{
		Method:      methods.ACPCodexGoalControlMethod,
		Description: "pauses or clears a Codex goal through its native extension",
	}, handler.acpProxyHandler.CodexGoalControl)

	registerUnserializedExtensionMethodUntyped(handler, JSONRPCOperation{
		Method:      methods.ACPCancelMethod,
		Description: "cancels an ongoing ACP operation",
	}, handler.acpProxyHandler.Cancel)

	registerUnserializedExtensionMethodUntyped(handler, JSONRPCOperation{
		Method:      methods.ACPSetModeMethod,
		Description: "changes the ACP session mode",
	}, handler.acpProxyHandler.SetMode)

	registerUnserializedExtensionMethodUntyped(handler, JSONRPCOperation{
		Method:      methods.ACPSetConfigOptionMethod,
		Description: "sets a session config option",
	}, handler.acpProxyHandler.SetConfigOption)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPDeleteSessionMethod,
		Description: "deletes an ACP session",
	}, handler.acpProxyHandler.DeleteSession)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPCloseSessionMethod,
		Description: "closes an ACP session's agent-side resources, keeping it reopenable",
	}, handler.acpProxyHandler.CloseSession)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPRenameSessionMethod,
		Description: "renames an ACP session when the agent supports the extension",
	}, handler.acpProxyHandler.RenameSession)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPMCPSettingsMethod,
		Description: "returns MCP settings for an ACP session",
	}, handler.acpProxyHandler.MCPSettings)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPMCPSetServerDisabledMethod,
		Description: "enables or disables an MCP server for an ACP session",
	}, handler.acpProxyHandler.MCPSetServerDisabled)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPMCPDeleteSecretsMethod,
		Description: "deletes stored MCP secrets for an ACP session",
	}, handler.acpProxyHandler.MCPDeleteSecrets)

	registerUnserializedExtensionMethodUntypedNoDeadline(handler, JSONRPCOperation{
		Method:      methods.ACPMCPAuthenticateMethod,
		Description: "authenticates an MCP server for an ACP session",
	}, handler.acpProxyHandler.MCPAuthenticate)

	registerExtensionMethod(handler, JSONRPCOperation{
		Method:      methods.ACPMCPSetInputVariableMethod,
		Description: "sets an MCP input variable for an ACP session",
	}, handler.acpProxyHandler.MCPSetInputVariable)

	publishClientSideTypes(handler, methods.ACPElicitationCreateMethod, methods.ACPElicitationParams{},
		"requests structured user input via ACP elicitation protocol")
	publishClientSideTypes(handler, methods.ACPElicitationResponseMethod, methods.ACPElicitationOutput{},
		"publishes the response schema for ACP elicitation requests")

	// Approvals: helper-owned pending permission prompts / elicitations.
	// respond must be concurrent — it is answered while the agent's prompt
	// (and the approval-holding request) is still in flight.
	registerUnserializedExtensionMethodUntyped(handler, JSONRPCOperation{
		Method:      methods.ACPApprovalsRespondMethod,
		Description: "answers one pending approval; first valid answer wins",
	}, handler.acpProxyHandler.RespondApproval)
	registerUnserializedExtensionMethodUntyped(handler, JSONRPCOperation{
		Method:      methods.ACPApprovalsListMethod,
		Description: "returns the current pending approval set",
	}, handler.acpProxyHandler.ListApprovals)
	publishClientSideTypes(handler, methods.ACPApprovalsDidChangeMethod, methods.ACPApprovalsDidChangeParams{},
		"pushes the full pending approval set to every surface on change")
	publishClientSideTypes(handler, methods.ACPCompactionUpdateMethod, methods.ACPCompactionNotification{},
		"notifies the client of a compaction update")
	publishClientSideTypes(handler, methods.ACPTurnEndedMethod, methods.ACPTurnEndedNotification{},
		"notifies every surface that an ACP turn has ended")
	publishClientSideTypes(handler, methods.MCPServersDidChangeParams{}.MethodName(), methods.MCPServersDidChangeParams{},
		"notifies every surface that the user's MCP connector set changed")

	setupRemoteAccess(handler)
	setupRemoteTerminal(handler)
	setupVoiceInput(handler)

	return handler
}

// returns a handler with only base state safely initialized, ready for
// method initialization, e.g. sub-handlers and all maps.
func newHandlerBaseState() *CamberHandler {
	cachedFS := cache2.NewOverlayFS(cache2.New(nil))

	h := &CamberHandler{
		requestCancelByID: make(map[string]cancelState),
		extensionHandlers: make(map[string]MethodHandler),
		concurrentMethods: make(map[string]struct{}),
		noDeadlineMethods: make(map[string]struct{}),
		config:            &Config{},

		cachedFS: cachedFS,

		docLocks: map[string]*sync.Mutex{},

		abortListeners: map[string][]func(){},

		ignoredCheckerCache: expirable.NewLRU[string, ignore.CheckIgnoredFunc](64, nil, time.Minute*15),
		cleanupFns:          []func() error{},

		remoteHub: remoteaccess.NewHub(),

		/*         Sub-handlers           */
		// for allocate handlers to allow for registration, and we'll
		// assign sub-handler values into these addresses on initialize
		acpNavHandler:         acpnav.NewServer(),
		localInferenceHandler: localinference.NewServer(),
		voiceInputHandler:     voiceinput.NewServer(),
		secretsHandler:        secretshandler.NewServer(),
		githubHandler:         githubhandler.NewServer(http.DefaultClient),
		gitHandler:            githandler.NewServer(),
		mcpServersHandler:     mcpservers.NewServer(),
	}
	h.fileSearchHandler = filesearch.NewServer(h.searchFileWorkspaceFolders)
	h.acpNavHandler.SetStateFilter(h.acpNavStateForHost)
	h.mcpServersHandler.SetDeepLinkOAuthCapable(func() bool {
		h.mx.Lock()
		defer h.mx.Unlock()
		return h.config != nil && h.config.ClientCapabilities.MCPOAuthDeepLink
	})

	// Reuse the Hugging Face MCP connector's OAuth token for Hugging Face API
	// requests (e.g. downloading gated models that require TOS acceptance).
	h.localInferenceHandler.SetHuggingFaceTokenSource(h.mcpServersHandler.HuggingFaceTokenSource())
	h.localInferenceHandler.SetHuggingFaceTokenInvalidator(h.mcpServersHandler.InvalidateHuggingFaceToken)

	h.acpProxyHandler = acpproxy.NewHandler(
		func() acpproxy.HandlerConfig {
			cfg := acpproxy.HandlerConfig{
				AgentServers: h.activeACPAgentServers(context.Background()),
			}
			if folders := h.GetWorkspaceFolders(); len(folders) > 0 {
				cfg.WorkingDir = uriToPath(string(folders[0].URI))
			}

			cfg.MCPServerInjector = func(ctx context.Context, agentServer string, caps acpsdk.McpCapabilities) ([]acpsdk.McpServer, []methods.MCPServerStatus) {
				isPool := acpproxy.NormalizeAgentServerName(agentServer) == acpproxy.DefaultAgentServerName
				result := h.mcpServersHandler.Resolve(ctx, mcpservers.ResolveParams{
					MCPCapabilities: caps,
					IsPoolAgent:     isPool,
				})
				return result.Servers, result.Unavailable
			}

			cfg.AgentServerEnvProvider = h.localInferenceHandler.AgentServerEnv
			cfg.AgentServerReady = h.localInferenceHandler.AgentServerReady

			return cfg
		},
		h.ReadFile,
		h.acpNavHandler,
	)

	h.sessionLog = remoteaccess.NewSessionLog(h.remoteHub)
	h.controlHandler = control.New(h.acpNavHandler, h.acpProxyHandler, h.sessionLog, h.acpProxyHandler)
	h.acpNavHandler.SetArchivedSessionCloser(func(ctx context.Context, agentServer, sessionID string) {
		_, err := h.acpProxyHandler.CloseSession(ctx, &methods.ACPCloseSessionParams{
			ACPAgentServerParams: methods.ACPAgentServerParams{AgentServer: agentServer},
			CloseSessionRequest:  acpsdk.CloseSessionRequest{SessionId: acpsdk.SessionId(sessionID)},
			CancelInFlight:       true,
		}, nil)
		if err != nil {
			slog.WarnContext(ctx, "closing archived sub-agent session failed", "agentServer", agentServer, "sessionId", sessionID, "error", err)
		}
	})
	h.acpProxyHandler.SetSessionEvents(&sessionEventSink{log: h.sessionLog, hub: h.remoteHub})

	// Pending approvals are helper-owned state: every change pushes the full
	// set to all surfaces (primary + remotes), which reconcile by key — so
	// reconnects and late joins are idempotent instead of re-raced.
	approvalStore := approvals.NewStore()
	approvalStore.SetNotifier(func(pending []methods.ACPApproval) {
		if pending == nil {
			pending = []methods.ACPApproval{}
		}
		h.remoteHub.NotifyAll(methods.ACPApprovalsDidChangeMethod, methods.ACPApprovalsDidChangeParams{Pending: pending})
	})
	h.acpProxyHandler.SetApprovals(approvalStore)

	// The connector store is shared on disk across helper instances, but change
	// listeners are in-memory per client — broadcast every mutation, and watch
	// the store for other instances' writes, so every surface re-injects its
	// live agent sessions with the current connector set.
	h.mcpServersHandler.SetChangeNotifier(func() {
		h.remoteHub.NotifyAll(methods.MCPServersDidChangeParams{}.MethodName(), methods.MCPServersDidChangeParams{})
	})
	h.cleanupFns = append(h.cleanupFns, h.mcpServersHandler.WatchStoreForExternalChanges())

	// Models placed in the local models directory outside the app download
	// flow are only discovered by a state read; watch the directory so they
	// reach every client without waiting for one (PE-2474).
	h.cleanupFns = append(h.cleanupFns, h.localInferenceHandler.WatchModelsDirectory())

	h.remoteTerminals = remoteterminal.NewManager(h.remoteHub.NotifyClient)
	h.cleanupFns = append(h.cleanupFns, h.remoteTerminals.Close)

	h.cleanupFns = append(h.cleanupFns, h.acpProxyHandler.Close)
	h.cleanupFns = append(h.cleanupFns, h.acpNavHandler.Close)
	h.cleanupFns = append(h.cleanupFns, h.localInferenceHandler.Close)
	h.cleanupFns = append(h.cleanupFns, h.voiceInputHandler.Close)

	return h
}

func (h *CamberHandler) OpenAPI() huma.API {
	h.schemaMu.Lock()
	defer h.schemaMu.Unlock()
	if h.huma == nil {
		h.huma = humachi.New(chi.NewMux(), huma.DefaultConfig("camber helper", "0.1.0"))
		for _, register := range h.schemaRegistrations {
			register(h.huma)
		}
		h.schemaRegistrations = nil
	}
	return h.huma
}

// Runtime dispatch needs only typed handlers. Build documentation schemas on
// first OpenAPI access (including development validation), not every launch.
func (h *CamberHandler) registerSchema(register func(huma.API)) {
	h.schemaMu.Lock()
	defer h.schemaMu.Unlock()
	if h.huma == nil {
		h.schemaRegistrations = append(h.schemaRegistrations, register)
	} else {
		register(h.huma)
	}
}

// all method calls go via Handle (primary stdio/TCP client) or HandleRemote
// (authenticated remote access clients).
func (h *CamberHandler) Handle(req *glsp.Context) (r any, validMethod bool, validParams bool, err error) {
	if h.remoteHub != nil {
		// Record the primary connection's raw notify, then wrap the request's
		// Notify so helper->client notifications (including closures captured
		// by acpproxy/acpnav) fan out to remote clients too. Calls stay on the
		// originating connection: the former broadcast-call race for approvals
		// is replaced by the helper-owned approval store.
		h.remoteHub.SetPrimary(req.Notify)
		req.Notify = h.remoteHub.WrapNotify(remoteaccess.PrimaryOrigin, req.Notify)
	}
	return h.handleCore(req, remoteaccess.PrimaryOrigin)
}

// HandleRemote dispatches a request from an authenticated remote client. The
// remoteaccess server enforces its method allowlist before calling this;
// originID keeps fan-out from echoing traffic back to the originator.
func (h *CamberHandler) HandleRemote(originID string, req *glsp.Context) (any, bool, bool, error) {
	if h.remoteHub != nil {
		req.Notify = h.remoteHub.WrapNotify(originID, req.Notify)
	}
	return h.handleCore(req, originID)
}

func (h *CamberHandler) handleCore(req *glsp.Context, originID string) (r any, validMethod bool, validParams bool, err error) {
	if h.receivedShutdown.Load() && req.Method != "exit" {
		return r, true, true,
			jsonrpc2.NewError(-32602, "shutdown has been received, no message but exit should be sent")
	}

	ctx, cancel := h.newRequestContext(req.Method)
	defer cancel()
	// Handlers that scope traffic per client connection (acpproxy load
	// replay, remote resume) read the origin from the request context.
	ctx = methods.WithClientOrigin(ctx, originID)

	// starts off nil
	req.Context = ctx
	start := time.Now()

	wasCancelled := false

	defer func() {
		duration := time.Since(start)
		if rv := recover(); rv != nil {
			err = errFromPanicValue(rv)
		}

		errString := "<nil>"
		level := slog.LevelInfo
		if err != nil {
			errString = fmt.Sprintf("%+v", err)
			level = slog.LevelError
		}

		attrs := []any{
			slog.String("method", req.Method), slog.String("error", errString),
			slog.Bool("method_valid", validMethod), slog.Bool("params_valid", validParams),
			slog.Int64("duration_ms", duration.Milliseconds()),
			slog.String("jsonrpc_request_id", req.RequestID.String()),
		}
		if data, ok := jsonrpcErrorData(err); ok {
			attrs = append(attrs, slog.String("error_data", data))
		}
		if wasCancelled {
			attrs = append(attrs, slog.Bool("canceled_by_client", true))
		}
		if err != nil || req.Method != methods.ACPNavListMethod {
			slog.Log(req.Context, level, "jsonrpc handled", attrs...)
		}
	}()

	if req.Method != protocol.MethodCancelRequest {
		done, wc := h.addInFlightRequest(req.RequestID, cancel)
		defer done()

		wasCancelled = wc
		if wasCancelled {
			// TODO return jsonrpc cancellation error
			return nil, true, true, nil
		}
	}

	if handler, ok := h.extensionHandlers[req.Method]; ok {
		validMethod = true
		res, err := handler(ctx, req)
		return res, validMethod, !isInvalidParams(err), err
	}

	// fall back to LSP spec method handlers
	return h.Handler.Handle(req)
}

const (
	serializedRequestTimeout = 5 * time.Second
	concurrentRequestTimeout = 30 * time.Second
)

func (h *CamberHandler) newRequestContext(method string) (context.Context, context.CancelFunc) {
	if _, ok := h.noDeadlineMethods[method]; ok {
		return context.WithCancel(context.Background())
	}
	if _, ok := h.concurrentMethods[method]; ok {
		return context.WithTimeout(context.Background(), concurrentRequestTimeout)
	}
	return context.WithTimeout(context.Background(), serializedRequestTimeout)
}

func errFromPanicValue(rv any) error {
	err, ok := rv.(error)
	if !ok {
		return pkgerrors.Errorf("panic with value: %v", rv)
	}
	return ensureStacktrace(err)
}

func ensureStacktrace(err error) error {
	// don't generate a new stack if we have one
	if _, ok := err.(interface {
		StackTrace() pkgerrors.StackTrace
	}); ok {
		return err
	}
	return pkgerrors.WithStack(err)
}

func jsonrpcErrorData(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var wireErr *jsonrpc2.WireError
	if !errors.As(err, &wireErr) || wireErr.Data == nil {
		return "", false
	}
	return string(*wireErr.Data), true
}

func isInvalidParams(err error) bool {
	return errors.Is(err, ErrInvalidParams)
}

var ErrInvalidParams = errors.New("invalid request params")

func setTrace(context *glsp.Context, params *protocol.SetTraceParams) error {
	protocol.SetTraceValue(params.Value)
	return nil
}

func logTrace(ctx *glsp.Context, params *protocol.LogTraceParams) error {
	slog.Debug(ctx.Method, slog.Any("params", params))
	return nil
}

func (h *CamberHandler) GetWorkspaceFolders() []protocol.WorkspaceFolder {
	h.mx.Lock()
	defer h.mx.Unlock()
	return h.workspaceFolders
}

// Checks if the method should be run concurrently
func (h *CamberHandler) IsConcurrentMethod(method string) bool {
	h.mx.Lock()
	defer h.mx.Unlock()
	_, ok := h.concurrentMethods[method]
	return ok
}

func (h *CamberHandler) shouldValidate() bool {
	if h.config == nil {
		return false
	}
	// We only want to validate during testing and development. Production
	// deployments of assistants cannot be guaranteed to be backwards/forwards compatible with
	// deployed backend API versions, and many backend types are included in request/response types within our methods package (e.g. AgentConfig)
	// If we controlled all the types deeply referred to in methods/ it could be safe, but this would involve a lot of duplication.
	switch methods.AssistantEnvironment(h.config.AssistantEnvironment) {
	case methods.DevelopmentEnv, methods.TestingEnv:
		return true
	default:
		return false
	}
}

/**
 * N.B. please do not put new application handlers here. If they're
 * new sub-systems, create a new handler/$foo package (like tasks or agent).
 * Otherwise put them in a specific file named for their method.
 * Agents should read the AGENTS.md file in this directory.
 */
