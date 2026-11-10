package github

import (
	"context"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"testing"

	"github.com/appleton/camber/pkg/camber-helper/methods"
	commonsecrets "github.com/appleton/camber/pkg/common/secrets"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeDoer is an httpDoer returning a canned body and counting calls.
type fakeDoer struct {
	body  string
	calls int
}

func (f *fakeDoer) Do(*http.Request) (*http.Response, error) {
	f.calls++
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Header:     make(http.Header),
	}, nil
}

// fakeStore is an in-memory CamberSecretStore holding a single token.
type fakeStore struct{ token string }

func (f *fakeStore) Upsert(_ context.Context, p commonsecrets.UpsertSecretParams) error {
	f.token = p.Value
	return nil
}
func (f *fakeStore) Delete(context.Context, string) error { f.token = ""; return nil }
func (f *fakeStore) Get(_ context.Context, name string) (*commonsecrets.Secret, error) {
	if f.token == "" {
		return nil, nil
	}
	return &commonsecrets.Secret{Name: name, Value: commonsecrets.NewSecretValue(f.token)}, nil
}
func (f *fakeStore) List(context.Context) ([]commonsecrets.Secret, error) { return nil, nil }

const listResponse = `{"data":{"repository":{"pullRequests":{"nodes":[
  {"number":1,"title":"Feature A","url":"https://github.com/o/r/pull/1","state":"OPEN","isDraft":false,"headRefName":"feature-a","reviewDecision":"APPROVED","updatedAt":"2026-06-29T00:00:00Z","comments":{"totalCount":2},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}},
  {"number":2,"title":"Feature B","url":"https://github.com/o/r/pull/2","state":"OPEN","isDraft":true,"headRefName":"feature-b","reviewDecision":"","updatedAt":"2026-06-28T00:00:00Z","comments":{"totalCount":0},"commits":{"nodes":[]}}
]}}}}`

func TestRepoListMapsBranchesAndCaches(t *testing.T) {
	ctx := context.Background()
	doer := &fakeDoer{body: listResponse}
	s := NewServerWithDeps(doer, &fakeStore{token: "ghp_test"})
	repo := repoRef{Host: "github.com", Owner: "o", Name: "r"}

	list, ok := s.repoList(ctx, repo)
	require.True(t, ok)
	require.Contains(t, list, "feature-a")
	require.Contains(t, list, "feature-b")
	assert.Equal(t, 1, list["feature-a"].Number)
	assert.Equal(t, "APPROVED", list["feature-a"].ReviewDecision)
	assert.True(t, list["feature-b"].IsDraft)
	assert.Equal(t, 1, doer.calls)

	// A second lookup within the TTL is served from cache (no extra HTTP call).
	_, ok = s.repoList(ctx, repo)
	require.True(t, ok)
	assert.Equal(t, 1, doer.calls)

	// The converted status reflects the rollup + review decision.
	status := convertStatus(list["feature-a"])
	assert.Equal(t, "open", status.State)
	assert.Equal(t, "success", status.Checks.Status)
	assert.Equal(t, "approved", status.ReviewDecision)
	assert.Equal(t, 2, status.CommentCount)
}

func TestRepoListReturnsFalseWithoutAuth(t *testing.T) {
	ctx := context.Background()
	doer := &fakeDoer{body: listResponse}
	// Empty store + (assuming) no gh auth for this host → no token.
	s := NewServerWithDeps(doer, &fakeStore{})
	_, ok := s.repoList(ctx, repoRef{Host: "github.com", Owner: "o", Name: "r"})
	if ok {
		// Environments with a gh login will still resolve a token; only assert
		// the no-call invariant when auth was genuinely unavailable.
		t.Skip("gh CLI auth is available in this environment")
	}
	assert.Equal(t, 0, doer.calls)
}

func TestWorktreeStatusesIncludesBranchWithoutGitHubRemote(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	command := exec.CommandContext(ctx, "git", "init", "-b", "feature/local-only", dir)
	require.NoError(t, command.Run())
	command = exec.CommandContext(
		ctx,
		"git",
		"-C",
		dir,
		"-c",
		"user.name=Camber Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"--allow-empty",
		"-m",
		"initial",
	)
	require.NoError(t, command.Run())

	s := NewServerWithDeps(&fakeDoer{}, &fakeStore{})
	result, err := s.WorktreeStatuses(ctx, &methods.GitHubWorktreeStatusesParams{
		Paths: []string{dir},
	}, nil)
	require.NoError(t, err)
	require.Len(t, result.Statuses, 1)
	assert.Equal(t, "feature/local-only", result.Statuses[0].Branch)
	assert.False(t, result.Statuses[0].Supported)
	assert.True(t, result.Statuses[0].IsRepo)
}

func TestWorktreeStatusesReportsIsRepo(t *testing.T) {
	ctx := context.Background()
	plainDir := t.TempDir()
	emptyRepoDir := t.TempDir()
	command := exec.CommandContext(ctx, "git", "init", emptyRepoDir)
	require.NoError(t, command.Run())

	s := NewServerWithDeps(&fakeDoer{}, &fakeStore{})
	result, err := s.WorktreeStatuses(ctx, &methods.GitHubWorktreeStatusesParams{
		Paths: []string{plainDir, emptyRepoDir},
	}, nil)
	require.NoError(t, err)
	require.Len(t, result.Statuses, 2)
	assert.False(t, result.Statuses[0].IsRepo)
	// A freshly-initialized repo has an unborn HEAD but is still a repo.
	assert.True(t, result.Statuses[1].IsRepo)
}

func TestAllowedGithubImageURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		// Allowed: GitHub attachment + githubusercontent hosts over https.
		{"https://github.com/user-attachments/assets/0c9e14d4", true},
		{"https://objects.githubusercontent.com/foo/bar", true},
		{"https://private-user-images.githubusercontent.com/x.png", true},
		// Rejected: wrong scheme, wrong github.com path, lookalike hosts.
		{"http://github.com/user-attachments/assets/x", false},
		{"https://github.com/owner/repo/blob/main/x.png", false},
		{"https://githubusercontent.com.attacker.com/x", false},
		{"https://github.com.attacker.com/user-attachments/assets/x", false},
		{"https://evil.com/x.png", false},
		{"", false},
		{"not-a-url", false},
	}
	for _, tc := range cases {
		assert.Equalf(t, tc.want, allowedGithubImageURL(tc.url), "url=%q", tc.url)
	}
}

func TestResolveAuthStoredTokenIsGithubComOnly(t *testing.T) {
	ctx := context.Background()
	s := NewServerWithDeps(&fakeDoer{}, &fakeStore{token: "ghp_test"})

	// github.com can use the stored token.
	_, ok := s.resolveAuth(ctx, "github.com")
	assert.True(t, ok)

	// A lookalike host must NOT receive the stored token. (gh is not
	// authenticated for it either, so no auth resolves.)
	_, okEvil := s.resolveAuth(ctx, "github.evil.example.com")
	assert.False(t, okEvil, "stored token must not leak to non-github.com hosts")
}
