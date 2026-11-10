package github

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseRemoteURL(t *testing.T) {
	cases := []struct {
		name      string
		remote    string
		wantHost  string
		wantOwner string
		wantRepo  string
		wantOK    bool
	}{
		{"https", "https://github.com/appleton/camber.git", "github.com", "appleton", "camber", true},
		{"https no suffix", "https://github.com/appleton/camber", "github.com", "appleton", "camber", true},
		{"scp", "git@github.com:appleton/camber.git", "github.com", "appleton", "camber", true},
		{"ssh", "ssh://git@github.com/appleton/camber.git", "github.com", "appleton", "camber", true},
		{"host case", "git@GitHub.com:appleton/camber.git", "github.com", "appleton", "camber", true},
		{"enterprise", "https://ghe.example.com/team/repo.git", "ghe.example.com", "team", "repo", true},
		{"empty", "", "", "", "", false},
		{"garbage", "not-a-url", "", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ref, ok := parseRemoteURL(tc.remote)
			assert.Equal(t, tc.wantOK, ok)
			if tc.wantOK {
				assert.Equal(t, tc.wantHost, ref.Host)
				assert.Equal(t, tc.wantOwner, ref.Owner)
				assert.Equal(t, tc.wantRepo, ref.Name)
			}
		})
	}
}

func TestIsSupportedHost(t *testing.T) {
	assert.True(t, isSupportedHost("github.com"))
	assert.True(t, isSupportedHost("github.internal.example.com"))
	assert.True(t, isSupportedHost("ghe.internal.example.com"))
	assert.False(t, isSupportedHost("gitlab.com"))
	assert.False(t, isSupportedHost("bitbucket.org"))
	assert.False(t, isSupportedHost("codeberg.org"))
	assert.False(t, isSupportedHost("dev.azure.com"))
	assert.False(t, isSupportedHost("git.internal.example.com"))
}

func TestGraphqlURL(t *testing.T) {
	assert.Equal(t, "https://api.github.com/graphql", repoRef{Host: "github.com"}.graphqlURL())
	assert.Equal(t, "https://ghe.example.com/api/graphql", repoRef{Host: "ghe.example.com"}.graphqlURL())
}

func TestRollupStatus(t *testing.T) {
	assert.Equal(t, "success", rollupStatus("SUCCESS"))
	assert.Equal(t, "failure", rollupStatus("FAILURE"))
	assert.Equal(t, "failure", rollupStatus("ERROR"))
	assert.Equal(t, "pending", rollupStatus("PENDING"))
	assert.Equal(t, "pending", rollupStatus("EXPECTED"))
	assert.Equal(t, "none", rollupStatus(""))
}

func TestPRState(t *testing.T) {
	assert.Equal(t, "merged", prState("MERGED", false))
	assert.Equal(t, "closed", prState("CLOSED", false))
	assert.Equal(t, "open", prState("OPEN", false))
	assert.Equal(t, "draft", prState("OPEN", true))
}

func TestNormalizeReviewDecision(t *testing.T) {
	assert.Equal(t, "approved", normalizeReviewDecision("APPROVED"))
	assert.Equal(t, "changes_requested", normalizeReviewDecision("CHANGES_REQUESTED"))
	assert.Equal(t, "review_required", normalizeReviewDecision("REVIEW_REQUIRED"))
	assert.Equal(t, "", normalizeReviewDecision(""))
}

func TestClassifyCheck(t *testing.T) {
	assert.Equal(t, "success", classifyCheck("COMPLETED", "SUCCESS", ""))
	assert.Equal(t, "failure", classifyCheck("COMPLETED", "FAILURE", ""))
	assert.Equal(t, "failure", classifyCheck("COMPLETED", "TIMED_OUT", ""))
	assert.Equal(t, "pending", classifyCheck("IN_PROGRESS", "", ""))
	assert.Equal(t, "pending", classifyCheck("QUEUED", "", ""))
	// StatusContext path (no status/conclusion, uses context state)
	assert.Equal(t, "success", classifyCheck("", "", "SUCCESS"))
	assert.Equal(t, "failure", classifyCheck("", "", "FAILURE"))
	assert.Equal(t, "pending", classifyCheck("", "", "PENDING"))
}

func TestConvertStatusAndDetail(t *testing.T) {
	pr := gqlPR{
		Number:         42,
		Title:          "Add feature",
		URL:            "https://github.com/o/r/pull/42",
		State:          "OPEN",
		IsDraft:        false,
		ReviewDecision: "CHANGES_REQUESTED",
		UpdatedAt:      "2026-06-29T00:00:00Z",
	}
	pr.Comments.TotalCount = 3
	pr.ReviewThreads.Nodes = append(pr.ReviewThreads.Nodes, struct {
		Comments struct {
			TotalCount int `json:"totalCount"`
		} `json:"comments"`
	}{})
	pr.ReviewThreads.Nodes[0].Comments.TotalCount = 2
	rollup := &gqlRollup{State: "FAILURE"}
	rollup.Contexts.Nodes = []gqlCheckContext{
		{Typename: "CheckRun", Name: "build", Status: "COMPLETED", Conclusion: "SUCCESS"},
		{Typename: "CheckRun", Name: "test", Status: "COMPLETED", Conclusion: "FAILURE"},
		{Typename: "StatusContext", Context: "ci/deploy", ContextState: "PENDING"},
	}
	commit := gqlCommitNode{}
	commit.Commit.StatusCheckRollup = rollup
	pr.Commits.Nodes = []gqlCommitNode{commit}

	status := convertStatus(pr)
	assert.Equal(t, "open", status.State)
	assert.Equal(t, 42, status.Number)
	assert.Equal(t, "failure", status.Checks.Status)
	assert.Equal(t, "changes_requested", status.ReviewDecision)
	assert.Equal(t, 3, status.CommentCount)

	detail := convertDetail(pr)
	assert.Equal(t, 5, detail.CommentCount)
	require.Len(t, detail.CheckRuns, 3)
	assert.Equal(t, 3, detail.Checks.Total)
	assert.Equal(t, 1, detail.Checks.Passed)
	assert.Equal(t, 1, detail.Checks.Failed)
	assert.Equal(t, 1, detail.Checks.Pending)
}

func TestEmptyStatus(t *testing.T) {
	s := emptyStatus()
	assert.Equal(t, "none", s.State)
	assert.Equal(t, "none", s.Checks.Status)
}
