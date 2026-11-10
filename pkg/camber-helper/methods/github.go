package methods

const githubMethodPrefix = "camber/github/"

const (
	// GitHubWorktreeStatusesMethod returns the pull-request status for a batch
	// of worktree paths. It is intended to drive the sidebar worktree icon
	// color and is cheap enough to poll.
	GitHubWorktreeStatusesMethod = githubMethodPrefix + "worktreeStatuses"
	// GitHubPRDetailMethod returns the full pull-request detail for a single
	// worktree path: reviews, individual checks, and comments. It backs the
	// GitHub panel.
	GitHubPRDetailMethod = githubMethodPrefix + "prDetail"
	// GitHubAuthStatusMethod reports how GitHub auth is resolved (gh CLI,
	// stored token, or unconfigured) for the settings UI.
	GitHubAuthStatusMethod = githubMethodPrefix + "authStatus"
	// GitHubSetTokenMethod stores (or clears, when token is empty) the
	// fallback GitHub token in the OS keyring.
	GitHubSetTokenMethod = githubMethodPrefix + "setToken"
	// GitHubPRURLMethod resolves the URL to open for a worktree: the existing
	// pull request, or the "create pull request" page for the current branch.
	GitHubPRURLMethod = githubMethodPrefix + "prUrl"
	// GitHubLinksMethod resolves the set of GitHub URLs for a worktree path
	// (repository, pull requests, issues, and the current/new PR).
	GitHubLinksMethod = githubMethodPrefix + "links"
	// GitHubFetchImageMethod fetches an auth-gated GitHub-hosted image (e.g. a
	// user-attachment in a private-repo PR body) and returns it as a data URI so
	// the webview, which has no GitHub session, can display it.
	GitHubFetchImageMethod = githubMethodPrefix + "fetchImage"
)

// GitHubChecks is the aggregated CI rollup for a pull request.
type GitHubChecks struct {
	// Status is the overall rollup: "none", "pending", "success", "failure".
	Status  string `json:"status"`
	Total   int    `json:"total"`
	Passed  int    `json:"passed"`
	Failed  int    `json:"failed"`
	Pending int    `json:"pending"`
}

// GitHubPRStatus is the compact pull-request status used for the worktree icon.
type GitHubPRStatus struct {
	// State is "none" (no PR), "draft", "open", "merged", or "closed".
	State   string `json:"state"`
	Number  int    `json:"number"`
	Title   string `json:"title"`
	URL     string `json:"url"`
	IsDraft bool   `json:"isDraft"`
	// ReviewDecision is "approved", "changes_requested", "review_required", or "".
	ReviewDecision string       `json:"reviewDecision"`
	Checks         GitHubChecks `json:"checks"`
	CommentCount   int          `json:"commentCount"`
	UpdatedAt      string       `json:"updatedAt"`
}

// GitHubWorktreeStatus pairs a worktree path with its resolved branch and PR
// status. State "none" means the worktree has no matching pull request (or the
// remote is not a supported GitHub host). Supported reports whether the path
// has a GitHub remote at all (independent of whether a PR exists). IsRepo
// reports whether the path is inside a git work tree at all — the UI uses it
// to gate git-only actions such as creating worktrees.
type GitHubWorktreeStatus struct {
	Path      string         `json:"path"`
	Branch    string         `json:"branch"`
	Supported bool           `json:"supported"`
	IsRepo    bool           `json:"isRepo"`
	Status    GitHubPRStatus `json:"status"`
}

type GitHubWorktreeStatusesParams struct {
	Paths []string `json:"paths"`
}

func (p GitHubWorktreeStatusesParams) MethodName() string { return GitHubWorktreeStatusesMethod }
func (p GitHubWorktreeStatusesParams) Description() string {
	return "Return GitHub pull-request status for a batch of worktree paths"
}

type GitHubWorktreeStatusesOutput struct {
	Statuses []GitHubWorktreeStatus `json:"statuses"`
	// Configured reports whether any GitHub auth is available at all. When
	// false the UI can prompt the user to connect instead of showing empty
	// status.
	Configured bool `json:"configured"`
}

// GitHubCheckRun is a single CI check or status context.
type GitHubCheckRun struct {
	Name string `json:"name"`
	// Status is the run state: "queued", "in_progress", "completed", "pending".
	Status string `json:"status"`
	// Conclusion is "success", "failure", "neutral", "cancelled", "skipped",
	// "timed_out", "action_required", or "" when still running.
	Conclusion string `json:"conclusion"`
	URL        string `json:"url"`
}

type GitHubComment struct {
	Author    string `json:"author"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt"`
}

type GitHubReview struct {
	Author string `json:"author"`
	// State is "approved", "changes_requested", "commented", "dismissed", "pending".
	State     string `json:"state"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt"`
}

// GitHubPRDetail is the full pull-request view backing the GitHub panel.
type GitHubPRDetail struct {
	GitHubPRStatus
	Body         string           `json:"body"`
	Author       string           `json:"author"`
	BaseRefName  string           `json:"baseRefName"`
	HeadRefName  string           `json:"headRefName"`
	Additions    int              `json:"additions"`
	Deletions    int              `json:"deletions"`
	ChangedFiles int              `json:"changedFiles"`
	CheckRuns    []GitHubCheckRun `json:"checkRuns"`
	Reviews      []GitHubReview   `json:"reviews"`
	Comments     []GitHubComment  `json:"comments"`
}

type GitHubPRDetailParams struct {
	Path string `json:"path"`
}

func (p GitHubPRDetailParams) MethodName() string { return GitHubPRDetailMethod }
func (p GitHubPRDetailParams) Description() string {
	return "Return full GitHub pull-request detail for a worktree path"
}

type GitHubPRDetailOutput struct {
	// Detail is nil when the worktree has no matching pull request.
	Detail *GitHubPRDetail `json:"detail,omitempty"`
	// Configured is false when no GitHub auth is available.
	Configured bool `json:"configured"`
	// RepoSupported is false when the remote is not a GitHub host.
	RepoSupported bool   `json:"repoSupported"`
	Branch        string `json:"branch"`
}

type GitHubAuthStatusParams struct{}

func (p GitHubAuthStatusParams) MethodName() string { return GitHubAuthStatusMethod }
func (p GitHubAuthStatusParams) Description() string {
	return "Report how GitHub authentication is resolved"
}

type GitHubAuthStatusOutput struct {
	// Source is "cli" (token borrowed from gh), "token" (stored token), or "none".
	Source string `json:"source"`
	// Login is the authenticated GitHub username, when known.
	Login string `json:"login"`
	// Host is the GitHub host the auth applies to (e.g. "github.com").
	Host string `json:"host"`
	// GHInstalled reports whether the gh CLI binary is on PATH.
	GHInstalled bool `json:"ghInstalled"`
	// HasStoredToken reports whether a fallback token is saved in the keyring.
	HasStoredToken bool `json:"hasStoredToken"`
}

type GitHubSetTokenParams struct {
	// Token is the GitHub personal access token. An empty token clears the
	// stored value.
	Token string `json:"token"`
}

func (p GitHubSetTokenParams) MethodName() string { return GitHubSetTokenMethod }
func (p GitHubSetTokenParams) Description() string {
	return "Store or clear the fallback GitHub token"
}

type GitHubSetTokenOutput struct{}

type GitHubPRURLParams struct {
	Path string `json:"path"`
}

func (p GitHubPRURLParams) MethodName() string { return GitHubPRURLMethod }
func (p GitHubPRURLParams) Description() string {
	return "Resolve the pull-request URL (or create-PR page) for a worktree"
}

type GitHubPRURLOutput struct {
	// URL is the pull-request page when Exists is true, otherwise the
	// "create pull request" page for the current branch. Empty when the
	// worktree has no supported GitHub remote.
	URL    string `json:"url"`
	Exists bool   `json:"exists"`
}

type GitHubLinksParams struct {
	Path string `json:"path"`
}

func (p GitHubLinksParams) MethodName() string { return GitHubLinksMethod }
func (p GitHubLinksParams) Description() string {
	return "Resolve GitHub URLs (repo, pull requests, issues, current/new PR) for a worktree"
}

// GitHubLinksOutput is the set of GitHub destinations for a worktree path. When
// Supported is false the path has no GitHub remote and the URLs are empty.
type GitHubLinksOutput struct {
	Supported bool   `json:"supported"`
	Branch    string `json:"branch"`
	RepoURL   string `json:"repoUrl"`
	PullsURL  string `json:"pullsUrl"`
	IssuesURL string `json:"issuesUrl"`
	// PRURL is the current pull request when PRExists is true, otherwise the
	// create-PR page for the current branch.
	PRURL    string `json:"prUrl"`
	PRExists bool   `json:"prExists"`
}

type GitHubFetchImageParams struct {
	URL string `json:"url"`
}

func (p GitHubFetchImageParams) MethodName() string { return GitHubFetchImageMethod }
func (p GitHubFetchImageParams) Description() string {
	return "Fetch an auth-gated GitHub-hosted image and return it as a data URI"
}

type GitHubFetchImageOutput struct {
	// DataURI is "data:<mime>;base64,<...>" when OK is true, otherwise empty.
	DataURI string `json:"dataUri"`
	OK      bool   `json:"ok"`
}
