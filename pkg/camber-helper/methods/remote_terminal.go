package methods

const remoteTerminalMethodPrefix = "camber/remoteTerminal/"

// Remote worktree terminals: PTYs the helper spawns on behalf of a remote
// (mobile) client. They are independent of the desktop app's own integrated
// terminals — the desktop process never sees them. Output streams to the
// subscribed client as RemoteTerminalDidWrite notifications; a reconnecting
// client re-subscribes (and backfills missed output) with
// RemoteTerminalAttach.
const (
	RemoteTerminalCreateMethod       = remoteTerminalMethodPrefix + "create"
	RemoteTerminalWriteMethod        = remoteTerminalMethodPrefix + "write"
	RemoteTerminalResizeMethod       = remoteTerminalMethodPrefix + "resize"
	RemoteTerminalClearMethod        = remoteTerminalMethodPrefix + "clear"
	RemoteTerminalDeleteMethod       = remoteTerminalMethodPrefix + "delete"
	RemoteTerminalListMethod         = remoteTerminalMethodPrefix + "list"
	RemoteTerminalCloseForPathMethod = remoteTerminalMethodPrefix + "closeForPath"
	RemoteTerminalAttachMethod       = remoteTerminalMethodPrefix + "attach"
	RemoteTerminalDidWriteMethod     = remoteTerminalMethodPrefix + "didWrite"
	RemoteTerminalDidExitMethod      = remoteTerminalMethodPrefix + "didExit"
)

// RemoteTerminalTab mirrors the client-side AssistantTerminalTab shape so the
// mobile host can hand results straight to the shared terminal repository.
type RemoteTerminalTab struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Cwd          string `json:"cwd"`
	WorktreePath string `json:"worktreePath"`
	CreatedAt    string `json:"createdAt"`
	ExitCode     *int   `json:"exitCode,omitempty"`
}

type RemoteTerminalCreateParams struct {
	// Cwd is the directory the shell starts in; it is also recorded as the
	// tab's worktree path.
	Cwd string `json:"cwd"`
	// Command, when non-empty, runs via the user's shell (`shell -lc command`)
	// instead of starting an interactive shell. Used for worktree
	// setup/teardown scripts.
	Command string            `json:"command,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Cols    int               `json:"cols,omitempty"`
	Rows    int               `json:"rows,omitempty"`
}

func (p RemoteTerminalCreateParams) MethodName() string { return RemoteTerminalCreateMethod }
func (p RemoteTerminalCreateParams) Description() string {
	return "Spawn a helper-side PTY for a remote client in the given worktree"
}

type RemoteTerminalCreateOutput struct {
	Tab RemoteTerminalTab `json:"tab"`
}

type RemoteTerminalWriteParams struct {
	TerminalID string `json:"terminalId"`
	Data       string `json:"data"`
}

func (p RemoteTerminalWriteParams) MethodName() string { return RemoteTerminalWriteMethod }
func (p RemoteTerminalWriteParams) Description() string {
	return "Write input to a remote terminal's PTY"
}

type RemoteTerminalWriteOutput struct{}

type RemoteTerminalResizeParams struct {
	TerminalID string `json:"terminalId"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
}

func (p RemoteTerminalResizeParams) MethodName() string { return RemoteTerminalResizeMethod }
func (p RemoteTerminalResizeParams) Description() string {
	return "Resize a remote terminal's PTY"
}

type RemoteTerminalResizeOutput struct{}

type RemoteTerminalClearParams struct {
	TerminalID string `json:"terminalId"`
}

func (p RemoteTerminalClearParams) MethodName() string { return RemoteTerminalClearMethod }
func (p RemoteTerminalClearParams) Description() string {
	return "Clear a remote terminal's replay buffer and redraw the prompt"
}

type RemoteTerminalClearOutput struct{}

type RemoteTerminalDeleteParams struct {
	TerminalID string `json:"terminalId"`
}

func (p RemoteTerminalDeleteParams) MethodName() string { return RemoteTerminalDeleteMethod }
func (p RemoteTerminalDeleteParams) Description() string {
	return "Kill a remote terminal's PTY and forget it"
}

type RemoteTerminalDeleteOutput struct{}

type RemoteTerminalListParams struct{}

func (p RemoteTerminalListParams) MethodName() string { return RemoteTerminalListMethod }
func (p RemoteTerminalListParams) Description() string {
	return "List the live remote terminals"
}

type RemoteTerminalListOutput struct {
	Tabs []RemoteTerminalTab `json:"tabs"`
}

type RemoteTerminalCloseForPathParams struct {
	// Path closes every terminal whose worktree path is the path itself or a
	// directory beneath it (project close covers its worktrees).
	Path string `json:"path"`
}

func (p RemoteTerminalCloseForPathParams) MethodName() string {
	return RemoteTerminalCloseForPathMethod
}
func (p RemoteTerminalCloseForPathParams) Description() string {
	return "Kill every remote terminal under a project or worktree path"
}

type RemoteTerminalCloseForPathOutput struct{}

type RemoteTerminalAttachSession struct {
	TerminalID string `json:"terminalId"`
	// SinceSeq is the absolute output byte offset the client has already
	// applied; the response backfills anything after it.
	SinceSeq int64 `json:"sinceSeq"`
}

type RemoteTerminalAttachParams struct {
	Sessions []RemoteTerminalAttachSession `json:"sessions"`
}

func (p RemoteTerminalAttachParams) MethodName() string { return RemoteTerminalAttachMethod }
func (p RemoteTerminalAttachParams) Description() string {
	return "Re-subscribe a reconnected remote client to its terminals and backfill missed output"
}

type RemoteTerminalAttachResult struct {
	TerminalID string `json:"terminalId"`
	// Alive is false when the terminal no longer exists (helper restart or
	// killed); the client should drop its tab.
	Alive bool `json:"alive"`
	// Data is the output after SinceSeq (or the whole retained buffer when the
	// requested offset was already trimmed), ending at Seq.
	Data string `json:"data,omitempty"`
	Seq  int64  `json:"seq,omitempty"`
	// Truncated reports that retention trimming ate part of the requested
	// range, so Data restarts mid-stream.
	Truncated bool `json:"truncated,omitempty"`
	ExitCode  *int `json:"exitCode,omitempty"`
}

type RemoteTerminalAttachOutput struct {
	Sessions []RemoteTerminalAttachResult `json:"sessions"`
}

// RemoteTerminalDidWriteParams streams PTY output to the subscribed client.
// Seq is the absolute byte offset after this chunk, so clients can dedupe
// across an attach backfill.
type RemoteTerminalDidWriteParams struct {
	TerminalID string `json:"terminalId"`
	Data       string `json:"data"`
	Seq        int64  `json:"seq"`
}

func (p RemoteTerminalDidWriteParams) MethodName() string { return RemoteTerminalDidWriteMethod }

type RemoteTerminalDidExitParams struct {
	TerminalID string `json:"terminalId"`
	ExitCode   *int   `json:"exitCode,omitempty"`
}

func (p RemoteTerminalDidExitParams) MethodName() string { return RemoteTerminalDidExitMethod }
