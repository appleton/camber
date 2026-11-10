// Package github exposes camber/github/* JSON-RPC methods that surface
// pull-request status for worktrees. All GitHub I/O lives here: the webview
// only ever receives normalized, already-derived data and never the token.
package github

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	commonsecrets "github.com/appleton/camber/pkg/common/secrets"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
)

// githubTokenSecretName is the keyring name for the fallback GitHub token.
const githubTokenSecretName = "github-token"

// listCacheTTL bounds how often we hit the GitHub API for a repo's PR list.
// The sidebar polls per worktree but many worktrees share a repo, so caching
// per repo keeps us well inside rate limits.
const listCacheTTL = 30 * time.Second

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type cachedList struct {
	byBranch map[string]gqlPR
	fetched  time.Time
}

// Server implements the camber/github/* handlers.
type Server struct {
	httpClient httpDoer
	store      commonsecrets.CamberSecretStore

	mu    sync.Mutex
	cache map[repoRef]cachedList
}

// NewServer constructs a Server with the default keyring-backed secret store.
func NewServer(httpClient httpDoer) *Server {
	return NewServerWithDeps(httpClient, commonsecrets.NewCamberSecretStore())
}

// NewServerWithDeps constructs a Server with injectable dependencies, for tests.
func NewServerWithDeps(httpClient httpDoer, store commonsecrets.CamberSecretStore) *Server {
	return &Server{
		httpClient: httpClient,
		store:      store,
		cache:      make(map[repoRef]cachedList),
	}
}

func (s *Server) storedToken(ctx context.Context) string {
	if s.store == nil {
		return ""
	}
	secret, err := s.store.Get(ctx, githubTokenSecretName)
	if err != nil || secret == nil {
		return ""
	}
	return secret.Value.Expose()
}

// WorktreeStatuses returns the PR status for a batch of worktree paths, grouping
// API calls by repository and caching each repo's PR list.
func (s *Server) WorktreeStatuses(ctx context.Context, params *methods.GitHubWorktreeStatusesParams, _ *glsp.Context) (*methods.GitHubWorktreeStatusesOutput, error) {
	out := &methods.GitHubWorktreeStatusesOutput{
		Statuses: make([]methods.GitHubWorktreeStatus, 0, len(params.Paths)),
	}

	// Resolve branch + repo per path first so we can batch by repo.
	type resolved struct {
		path   string
		branch string
		repo   repoRef
		ok     bool
		isRepo bool
	}
	resolvedPaths := make([]resolved, 0, len(params.Paths))
	repos := map[repoRef]struct{}{}
	for _, path := range params.Paths {
		r := resolved{path: path}
		branch, err := currentBranch(ctx, path)
		// A resolved branch (or a detached HEAD, which yields "" without an
		// error) proves the path is a repo; otherwise probe explicitly so
		// repos with an unborn HEAD still count.
		r.isRepo = err == nil || isWorkTree(ctx, path)
		if err == nil && branch != "" {
			r.branch = branch
			if repo, found := originRepo(ctx, path); found && isSupportedHost(repo.Host) {
				r.repo, r.ok = repo, true
				repos[repo] = struct{}{}
			}
		}
		resolvedPaths = append(resolvedPaths, r)
	}

	// Fetch (cache) each repo's PR list once.
	lists := map[repoRef]map[string]gqlPR{}
	for repo := range repos {
		list, ok := s.repoList(ctx, repo)
		if ok {
			out.Configured = true
			lists[repo] = list
		}
	}

	for _, r := range resolvedPaths {
		status := emptyStatus()
		branch := r.branch
		if r.ok {
			if pr, found := lists[r.repo][r.branch]; found {
				status = convertStatus(pr)
			}
		}
		out.Statuses = append(out.Statuses, methods.GitHubWorktreeStatus{
			Path:      r.path,
			Branch:    branch,
			Supported: r.ok,
			IsRepo:    r.isRepo,
			Status:    status,
		})
	}
	return out, nil
}

// repoList returns the repo's pull requests (open, merged, and closed — see
// listPRsQuery) keyed by head branch, keeping the most recent PR per branch and
// using the cache when fresh. The bool is false when auth is unavailable or the
// fetch failed.
func (s *Server) repoList(ctx context.Context, repo repoRef) (map[string]gqlPR, bool) {
	s.mu.Lock()
	if cached, ok := s.cache[repo]; ok && time.Since(cached.fetched) < listCacheTTL {
		s.mu.Unlock()
		return cached.byBranch, true
	}
	s.mu.Unlock()

	a, ok := s.resolveAuth(ctx, repo.Host)
	if !ok {
		return nil, false
	}

	var resp gqlListResponse
	if err := s.graphql(ctx, repo, a.Token, listPRsQuery, map[string]any{
		"owner": repo.Owner,
		"name":  repo.Name,
	}, &resp); err != nil {
		return nil, false
	}

	byBranch := make(map[string]gqlPR, len(resp.Repository.PullRequests.Nodes))
	for _, pr := range resp.Repository.PullRequests.Nodes {
		// Nodes are ordered by UPDATED_AT desc; keep the most recent per branch.
		if _, exists := byBranch[pr.HeadRefName]; !exists {
			byBranch[pr.HeadRefName] = pr
		}
	}

	s.mu.Lock()
	s.cache[repo] = cachedList{byBranch: byBranch, fetched: time.Now()}
	s.mu.Unlock()
	return byBranch, true
}

// PRDetail returns the full PR detail for a worktree path.
func (s *Server) PRDetail(ctx context.Context, params *methods.GitHubPRDetailParams, _ *glsp.Context) (*methods.GitHubPRDetailOutput, error) {
	out := &methods.GitHubPRDetailOutput{}

	branch, err := currentBranch(ctx, params.Path)
	if err != nil || branch == "" {
		return out, nil
	}
	out.Branch = branch

	repo, found := originRepo(ctx, params.Path)
	if !found || !isSupportedHost(repo.Host) {
		return out, nil
	}
	out.RepoSupported = true

	a, ok := s.resolveAuth(ctx, repo.Host)
	if !ok {
		return out, nil
	}
	out.Configured = true

	var resp gqlListResponse
	if err := s.graphql(ctx, repo, a.Token, prDetailQuery, map[string]any{
		"owner":  repo.Owner,
		"name":   repo.Name,
		"branch": branch,
	}, &resp); err != nil {
		return nil, pkgerrors.Wrap(err, "fetch pr detail")
	}
	nodes := resp.Repository.PullRequests.Nodes
	if len(nodes) == 0 {
		return out, nil
	}
	pr := nodes[0]
	if err := s.fetchRemainingReviewThreads(ctx, repo, a.Token, branch, &pr); err != nil {
		return nil, pkgerrors.Wrap(err, "fetch pr review threads")
	}
	detail := convertDetail(pr)
	out.Detail = &detail
	return out, nil
}

func (s *Server) fetchRemainingReviewThreads(ctx context.Context, repo repoRef, token, branch string, pr *gqlPR) error {
	for pr.ReviewThreads.PageInfo.HasNextPage {
		var resp gqlListResponse
		if err := s.graphql(ctx, repo, token, prReviewThreadsQuery, map[string]any{
			"owner":  repo.Owner,
			"name":   repo.Name,
			"branch": branch,
			"after":  pr.ReviewThreads.PageInfo.EndCursor,
		}, &resp); err != nil {
			return err
		}
		nodes := resp.Repository.PullRequests.Nodes
		if len(nodes) == 0 {
			return nil
		}
		next := nodes[0].ReviewThreads
		pr.ReviewThreads.Nodes = append(pr.ReviewThreads.Nodes, next.Nodes...)
		pr.ReviewThreads.PageInfo = next.PageInfo
	}
	return nil
}

// PRUrl resolves the URL to open for a worktree: the existing pull request, or
// the create-PR page for the current branch. Returns an empty URL when the
// worktree has no supported GitHub remote.
func (s *Server) PRUrl(ctx context.Context, params *methods.GitHubPRURLParams, _ *glsp.Context) (*methods.GitHubPRURLOutput, error) {
	out := &methods.GitHubPRURLOutput{}

	branch, err := currentBranch(ctx, params.Path)
	if err != nil || branch == "" {
		return out, nil
	}
	repo, found := originRepo(ctx, params.Path)
	if !found || !isSupportedHost(repo.Host) {
		return out, nil
	}

	if list, ok := s.repoList(ctx, repo); ok {
		if pr, exists := list[branch]; exists && pr.URL != "" {
			out.URL = pr.URL
			out.Exists = true
			return out, nil
		}
	}
	// No PR (or auth unavailable): fall back to the create-PR page.
	out.URL = repo.createPRURL(branch)
	return out, nil
}

// Links resolves the set of GitHub destinations for a worktree path: the
// repository, its pull-request and issue lists, and the current/new PR.
func (s *Server) Links(ctx context.Context, params *methods.GitHubLinksParams, _ *glsp.Context) (*methods.GitHubLinksOutput, error) {
	out := &methods.GitHubLinksOutput{}

	branch, err := currentBranch(ctx, params.Path)
	if err != nil || branch == "" {
		return out, nil
	}
	repo, found := originRepo(ctx, params.Path)
	if !found || !isSupportedHost(repo.Host) {
		return out, nil
	}

	out.Supported = true
	out.Branch = branch
	base := repo.webURL() + "/" + repo.Owner + "/" + repo.Name
	out.RepoURL = base
	out.PullsURL = base + "/pulls"
	out.IssuesURL = base + "/issues"

	if list, ok := s.repoList(ctx, repo); ok {
		if pr, exists := list[branch]; exists && pr.URL != "" {
			out.PRURL = pr.URL
			out.PRExists = true
			return out, nil
		}
	}
	out.PRURL = repo.createPRURL(branch)
	return out, nil
}

// maxImageBytes caps proxied image size to avoid unbounded data URIs.
const maxImageBytes = 16 << 20 // 16 MiB

// allowedGithubImageURL reports whether url is a GitHub-hosted image we are
// willing to fetch with the user's token. Restricting to GitHub image hosts
// prevents the token from being sent to (or content fetched from) arbitrary
// URLs embedded in a PR body.
func allowedGithubImageURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "github.com" && strings.HasPrefix(u.Path, "/user-attachments/") {
		return true
	}
	return strings.HasSuffix(host, ".githubusercontent.com")
}

// FetchImage fetches an auth-gated GitHub image and returns it as a data URI.
// The webview has no GitHub session, so private-repo attachment images would
// otherwise fail to load. Only GitHub image hosts are fetched, and the auth
// header is sent by the http client only for same-host requests (Go strips it
// on cross-host redirects to the signed CDN URL, which needs no auth anyway).
func (s *Server) FetchImage(ctx context.Context, params *methods.GitHubFetchImageParams, _ *glsp.Context) (*methods.GitHubFetchImageOutput, error) {
	out := &methods.GitHubFetchImageOutput{}
	if !allowedGithubImageURL(params.URL) {
		return out, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, params.URL, nil)
	if err != nil {
		return out, nil
	}
	if a, ok := s.resolveAuth(ctx, "github.com"); ok {
		req.Header.Set("Authorization", "bearer "+a.Token)
	}
	req.Header.Set("User-Agent", "camber-assistant")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return out, nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return out, nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes))
	if err != nil {
		return out, nil
	}
	mime := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(mime, "image/") {
		mime = http.DetectContentType(body)
	}
	if !strings.HasPrefix(mime, "image/") {
		return out, nil
	}
	out.DataURI = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(body)
	out.OK = true
	return out, nil
}

// AuthStatus reports how GitHub auth resolves for the settings UI.
func (s *Server) AuthStatus(ctx context.Context, _ *methods.GitHubAuthStatusParams, _ *glsp.Context) (*methods.GitHubAuthStatusOutput, error) {
	out := &methods.GitHubAuthStatusOutput{
		Source:         "none",
		Host:           "github.com",
		GHInstalled:    ghInstalled(),
		HasStoredToken: s.storedToken(ctx) != "",
	}
	if a, ok := s.resolveAuth(ctx, "github.com"); ok {
		login := s.viewerLogin(ctx, a)
		if login == "" {
			return out, nil
		}
		out.Source = a.Source
		out.Login = login
	}
	return out, nil
}

// SetToken stores or clears the fallback GitHub token and invalidates the cache.
func (s *Server) SetToken(ctx context.Context, params *methods.GitHubSetTokenParams, _ *glsp.Context) (*methods.GitHubSetTokenOutput, error) {
	if s.store == nil {
		return nil, pkgerrors.New("secret store unavailable")
	}
	token := params.Token
	if token == "" {
		if err := s.store.Delete(ctx, githubTokenSecretName); err != nil {
			return nil, pkgerrors.Wrap(err, "clear github token")
		}
	} else {
		if err := s.store.Upsert(ctx, commonsecrets.UpsertSecretParams{
			Name:        githubTokenSecretName,
			Value:       token,
			Description: "GitHub token for Camber",
		}); err != nil {
			return nil, pkgerrors.Wrap(err, "store github token")
		}
	}
	s.mu.Lock()
	s.cache = make(map[repoRef]cachedList)
	s.mu.Unlock()
	return &methods.GitHubSetTokenOutput{}, nil
}

// --- conversions ---

func rollupState(pr gqlPR) *gqlRollup {
	if len(pr.Commits.Nodes) == 0 {
		return nil
	}
	return pr.Commits.Nodes[0].Commit.StatusCheckRollup
}

func convertStatus(pr gqlPR) methods.GitHubPRStatus {
	checks := methods.GitHubChecks{Status: "none"}
	if rollup := rollupState(pr); rollup != nil {
		checks.Status = rollupStatus(rollup.State)
	}
	return methods.GitHubPRStatus{
		State:          prState(pr.State, pr.IsDraft),
		Number:         pr.Number,
		Title:          pr.Title,
		URL:            pr.URL,
		IsDraft:        pr.IsDraft,
		ReviewDecision: normalizeReviewDecision(pr.ReviewDecision),
		Checks:         checks,
		CommentCount:   pr.Comments.TotalCount,
		UpdatedAt:      pr.UpdatedAt,
	}
}

func convertDetail(pr gqlPR) methods.GitHubPRDetail {
	status := convertStatus(pr)
	for _, thread := range pr.ReviewThreads.Nodes {
		status.CommentCount += thread.Comments.TotalCount
	}

	// Initialized (not nil) so it marshals to [] rather than null — the webview
	// dereferences .length on this array.
	checkRuns := make([]methods.GitHubCheckRun, 0)
	if rollup := rollupState(pr); rollup != nil {
		for _, c := range rollup.Contexts.Nodes {
			bucket := classifyCheck(c.Status, c.Conclusion, c.ContextState)
			switch bucket {
			case "success":
				status.Checks.Passed++
			case "failure":
				status.Checks.Failed++
			default:
				status.Checks.Pending++
			}
			status.Checks.Total++

			name := c.Name
			url := c.DetailsURL
			runStatus := c.Status
			conclusion := c.Conclusion
			if c.Typename == "StatusContext" {
				name = c.Context
				url = c.TargetURL
				runStatus = "completed"
				conclusion = c.ContextState
			}
			checkRuns = append(checkRuns, methods.GitHubCheckRun{
				Name:       name,
				Status:     runStatus,
				Conclusion: conclusion,
				URL:        url,
			})
		}
	}

	comments := make([]methods.GitHubComment, 0, len(pr.Comments.Nodes))
	for _, c := range pr.Comments.Nodes {
		comments = append(comments, methods.GitHubComment{
			Author:    c.Author.Login,
			Body:      c.Body,
			URL:       c.URL,
			CreatedAt: c.CreatedAt,
		})
	}

	reviews := make([]methods.GitHubReview, 0, len(pr.Reviews.Nodes))
	for _, r := range pr.Reviews.Nodes {
		reviews = append(reviews, methods.GitHubReview{
			Author:    r.Author.Login,
			State:     normalizeReviewState(r.State),
			Body:      r.Body,
			URL:       r.URL,
			CreatedAt: r.SubmittedAt,
		})
	}

	return methods.GitHubPRDetail{
		GitHubPRStatus: status,
		Body:           pr.Body,
		Author:         pr.Author.Login,
		BaseRefName:    pr.BaseRefName,
		HeadRefName:    pr.HeadRefName,
		Additions:      pr.Additions,
		Deletions:      pr.Deletions,
		ChangedFiles:   pr.ChangedFiles,
		CheckRuns:      checkRuns,
		Reviews:        reviews,
		Comments:       comments,
	}
}
