package methods

const gitMethodPrefix = "camber/git/"

const (
	// GitStatusMethod returns the working-tree status (branch, staged,
	// unstaged, and untracked changes) for a worktree path. It backs the
	// desktop Changes panel.
	GitStatusMethod = gitMethodPrefix + "status"
	// GitDiffFileMethod returns the unified diff for a single file, either
	// staged or unstaged.
	GitDiffFileMethod = gitMethodPrefix + "diffFile"
	// GitDiffOpenMethod opens a bounded, incrementally-readable diff snapshot.
	GitDiffOpenMethod = gitMethodPrefix + "diffOpen"
	// GitDiffListMethod reads the next page of file summaries from a snapshot.
	GitDiffListMethod = gitMethodPrefix + "diffList"
	// GitDiffReadMethod reads one bounded patch chunk for a file in a snapshot.
	GitDiffReadMethod = gitMethodPrefix + "diffRead"
	// GitDiffContentsMethod reads the full before/after contents for one file
	// in a snapshot's scope, so the viewer can expand collapsed context.
	GitDiffContentsMethod = gitMethodPrefix + "diffContents"
	// GitDiffStatsMethod polls asynchronously-computed snapshot totals.
	GitDiffStatsMethod = gitMethodPrefix + "diffStats"
	// GitDiffCloseMethod releases a diff snapshot and its running git commands.
	GitDiffCloseMethod = gitMethodPrefix + "diffClose"
	// GitStageMethod stages one or more paths (git add).
	GitStageMethod = gitMethodPrefix + "stage"
	// GitUnstageMethod unstages one or more paths (git restore --staged).
	GitUnstageMethod = gitMethodPrefix + "unstage"
	// GitDiscardMethod discards working-tree changes for one or more paths
	// (git restore, or deletion for untracked files).
	GitDiscardMethod = gitMethodPrefix + "discard"
	// GitCommitMethod commits the staged changes with a message.
	GitCommitMethod = gitMethodPrefix + "commit"
)

// GitFileChange describes a single changed file in the working tree or index.
type GitFileChange struct {
	// Path is repo-relative, using forward slashes.
	Path string `json:"path"`
	// OrigPath is set for renames/copies: the previous repo-relative path.
	OrigPath string `json:"origPath,omitempty"`
	// Status is "modified", "added", "deleted", "renamed", "copied",
	// "typechange", "untracked", "unmerged", or "unknown".
	Status string `json:"status"`
}

// GitStatusOutput is the working-tree summary backing the Changes panel. All
// mutating git methods return the refreshed status so the UI needs a single
// round trip per action.
type GitStatusOutput struct {
	// IsRepo is false when the path is not inside a git work tree; all other
	// fields are zero values in that case.
	IsRepo bool `json:"isRepo"`
	// GitMissing is true when IsRepo is false because the git binary is not
	// installed, so the UI can say so instead of "not a repository".
	GitMissing bool `json:"gitMissing,omitempty"`
	// Branch is the checked-out branch, or empty when detached.
	Branch   string `json:"branch"`
	Detached bool   `json:"detached"`
	// Upstream is the remote tracking branch (e.g. "origin/main"), or empty
	// when none is configured.
	Upstream string `json:"upstream,omitempty"`
	// Ahead/Behind are relative to the upstream, when one is configured.
	Ahead      int             `json:"ahead"`
	Behind     int             `json:"behind"`
	Staged     []GitFileChange `json:"staged"`
	Unstaged   []GitFileChange `json:"unstaged"`
	Untracked  []GitFileChange `json:"untracked"`
	StashCount int             `json:"stashCount"`
	// Additions/Deletions are total changed lines versus HEAD (staged +
	// unstaged + untracked, binary files excluded) for +n/−n summaries.
	Additions int `json:"additions"`
	Deletions int `json:"deletions"`
}

type GitStatusParams struct {
	Path string `json:"path"`
}

func (p GitStatusParams) MethodName() string { return GitStatusMethod }
func (p GitStatusParams) Description() string {
	return "Return the git working-tree status for a worktree path"
}

type GitDiffFileParams struct {
	Path string `json:"path"`
	// File is the repo-relative path of the file to diff.
	File string `json:"file"`
	// Staged selects the index-vs-HEAD diff instead of worktree-vs-index.
	Staged bool `json:"staged,omitempty"`
	// Untracked renders the whole file as an addition (for files git does not
	// track yet). Ignored when Staged is true.
	Untracked bool `json:"untracked,omitempty"`
	// Head selects the HEAD-vs-worktree diff (staged + unstaged combined),
	// e.g. for editor gutter decorations. Takes precedence over Staged.
	Head bool `json:"head,omitempty"`
}

func (p GitDiffFileParams) MethodName() string { return GitDiffFileMethod }
func (p GitDiffFileParams) Description() string {
	return "Return the unified diff for a single file in a worktree"
}

type GitDiffFileOutput struct {
	// Patch is the raw unified diff text; empty when the file has no changes.
	Patch string `json:"patch"`
	// Binary is true when git reports the file as binary (no textual patch).
	Binary bool `json:"binary"`
	// HasContents is true when OldContent/NewContent carry the full before and
	// after file contents. The diff viewer uses them to expand collapsed
	// unmodified lines. Omitted for binary or oversized files.
	HasContents bool `json:"hasContents,omitempty"`
	// OldContent is the full base-side file content (HEAD for staged diffs,
	// the index for worktree diffs, empty for untracked files).
	OldContent string `json:"oldContent,omitempty"`
	// NewContent is the full result-side file content (the index for staged
	// diffs, the worktree file otherwise).
	NewContent string `json:"newContent,omitempty"`
}

// GitDiffScope selects which worktree changes a diff snapshot contains.
type GitDiffScope string

const (
	GitDiffScopeUncommitted GitDiffScope = "uncommitted"
	GitDiffScopeStaged      GitDiffScope = "staged"
	GitDiffScopeUnstaged    GitDiffScope = "unstaged"
)

// GitDiffFileSummary is the lightweight file chrome shown before patch data is
// requested. StatsReady indicates whether additions and deletions are final.
type GitDiffFileSummary struct {
	Path       string `json:"path"`
	OrigPath   string `json:"origPath,omitempty"`
	Status     string `json:"status"`
	StatsReady bool   `json:"statsReady,omitempty"`
	Additions  int    `json:"additions,omitempty"`
	Deletions  int    `json:"deletions,omitempty"`
	Binary     bool   `json:"binary,omitempty"`
}

type GitDiffFileStats struct {
	Path      string `json:"path"`
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
}

type GitDiffStats struct {
	Files     int                `json:"files"`
	Additions int                `json:"additions"`
	Deletions int                `json:"deletions"`
	FileStats []GitDiffFileStats `json:"fileStats,omitempty"`
}

// GitDiffOpenParams starts a snapshot. TargetPath lets a file-opening gesture
// render that file without waiting for its position in the manifest stream.
type GitDiffOpenParams struct {
	Path       string       `json:"path"`
	Scope      GitDiffScope `json:"scope,omitempty"`
	TargetPath string       `json:"targetPath,omitempty"`
}

func (p GitDiffOpenParams) MethodName() string { return GitDiffOpenMethod }
func (p GitDiffOpenParams) Description() string {
	return "Open an incrementally-readable git diff snapshot"
}

type GitDiffOpenOutput struct {
	// Unavailable is true when Path is not a worktree or git cannot be run.
	// No session is created in that case.
	Unavailable bool                 `json:"unavailable,omitempty"`
	GitMissing  bool                 `json:"gitMissing,omitempty"`
	SessionID   string               `json:"sessionId"`
	Files       []GitDiffFileSummary `json:"files"`
	NextCursor  string               `json:"nextCursor,omitempty"`
	Complete    bool                 `json:"complete"`
	Target      *GitDiffFileSummary  `json:"target,omitempty"`
	Stats       *GitDiffStats        `json:"stats,omitempty"`
}

type GitDiffListParams struct {
	SessionID string `json:"sessionId"`
	Cursor    string `json:"cursor,omitempty"`
}

func (p GitDiffListParams) MethodName() string { return GitDiffListMethod }
func (p GitDiffListParams) Description() string {
	return "Read the next file-summary page from a git diff snapshot"
}

type GitDiffListOutput struct {
	Files      []GitDiffFileSummary `json:"files"`
	NextCursor string               `json:"nextCursor,omitempty"`
	Complete   bool                 `json:"complete"`
	Stats      *GitDiffStats        `json:"stats,omitempty"`
}

// GitDiffChunk is capped by both line count and encoded patch bytes. Patch is
// a self-contained single-file unified patch that can be parsed independently;
// it packs as many whole hunks as fit under the caps.
type GitDiffChunk struct {
	Patch     string `json:"patch"`
	Rows      int    `json:"rows"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	// Hunks is the number of @@ sections in Patch, for row-height estimates.
	Hunks          int  `json:"hunks,omitempty"`
	Binary         bool `json:"binary,omitempty"`
	TruncatedLines int  `json:"truncatedLines,omitempty"`
}

type GitDiffReadParams struct {
	SessionID string `json:"sessionId"`
	File      string `json:"file"`
	Cursor    string `json:"cursor,omitempty"`
}

func (p GitDiffReadParams) MethodName() string { return GitDiffReadMethod }
func (p GitDiffReadParams) Description() string {
	return "Read one bounded file patch chunk from a git diff snapshot"
}

type GitDiffReadOutput struct {
	Chunk      *GitDiffChunk `json:"chunk,omitempty"`
	NextCursor string        `json:"nextCursor,omitempty"`
	Complete   bool          `json:"complete"`
}

type GitDiffContentsParams struct {
	SessionID string `json:"sessionId"`
	// File is the repo-relative path of the file to load.
	File string `json:"file"`
}

func (p GitDiffContentsParams) MethodName() string { return GitDiffContentsMethod }
func (p GitDiffContentsParams) Description() string {
	return "Read the full before/after file contents for a git diff snapshot"
}

type GitDiffContentsOutput struct {
	// HasContents is true when OldContent/NewContent carry the full before and
	// after contents for the snapshot's scope. False when either side is
	// unavailable or oversized; the diff still renders collapsed-only.
	HasContents bool `json:"hasContents,omitempty"`
	// OldContent is the full base-side content (HEAD for uncommitted and
	// staged scopes, the index for unstaged; empty for untracked files).
	OldContent string `json:"oldContent,omitempty"`
	// NewContent is the full result-side content (the index for the staged
	// scope, the worktree file otherwise).
	NewContent string `json:"newContent,omitempty"`
}

type GitDiffStatsParams struct {
	SessionID string `json:"sessionId"`
}

func (p GitDiffStatsParams) MethodName() string { return GitDiffStatsMethod }
func (p GitDiffStatsParams) Description() string {
	return "Poll totals for a git diff snapshot"
}

type GitDiffStatsOutput struct {
	Ready bool          `json:"ready"`
	Stats *GitDiffStats `json:"stats,omitempty"`
}

type GitDiffCloseParams struct {
	SessionID string `json:"sessionId"`
}

func (p GitDiffCloseParams) MethodName() string { return GitDiffCloseMethod }
func (p GitDiffCloseParams) Description() string {
	return "Close a git diff snapshot"
}

type GitDiffCloseOutput struct{}

type GitStageParams struct {
	Path string `json:"path"`
	// Files are repo-relative paths to stage.
	Files []string `json:"files"`
}

func (p GitStageParams) MethodName() string { return GitStageMethod }
func (p GitStageParams) Description() string {
	return "Stage files in a worktree (git add)"
}

type GitUnstageParams struct {
	Path  string   `json:"path"`
	Files []string `json:"files"`
}

func (p GitUnstageParams) MethodName() string { return GitUnstageMethod }
func (p GitUnstageParams) Description() string {
	return "Unstage files in a worktree (git restore --staged)"
}

type GitDiscardParams struct {
	Path string `json:"path"`
	// Files are repo-relative tracked paths to restore from the index.
	Files []string `json:"files,omitempty"`
	// UntrackedFiles are repo-relative untracked paths to delete.
	UntrackedFiles []string `json:"untrackedFiles,omitempty"`
}

func (p GitDiscardParams) MethodName() string { return GitDiscardMethod }
func (p GitDiscardParams) Description() string {
	return "Discard working-tree changes for files in a worktree"
}

type GitCommitParams struct {
	Path    string `json:"path"`
	Message string `json:"message,omitempty"`
}

func (p GitCommitParams) MethodName() string { return GitCommitMethod }
func (p GitCommitParams) Description() string {
	return "Commit the staged changes in a worktree"
}
