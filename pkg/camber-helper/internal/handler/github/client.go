package github

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"

	pkgerrors "github.com/pkg/errors"
)

// auth holds a resolved GitHub token and where it came from.
type auth struct {
	Token  string
	Source string // "cli" | "token"
	Host   string
}

// ghInstalled reports whether the gh CLI binary is on PATH.
func ghInstalled() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

// ghToken borrows the token gh has stored for a host. Returns "" when gh is not
// installed or not authenticated for that host.
func ghToken(ctx context.Context, host string) string {
	if !ghInstalled() {
		return ""
	}
	if host == "" {
		host = "github.com"
	}
	cmd := exec.CommandContext(ctx, "gh", "auth", "token", "--hostname", host)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// resolveAuth resolves a token for a host, preferring the gh CLI (which scopes
// tokens per host, so it safely honors the user's gh login and enterprise
// hosts) and falling back to the stored token. Returns ok=false when no auth is
// available.
//
// Security: the gh CLI token is host-scoped, but the stored fallback token has
// no host association — and `host` is derived from a worktree's origin remote,
// which only passes the loose isSupportedHost check. To avoid leaking the
// stored GitHub PAT to an attacker-controlled host whose name merely contains
// "github" (e.g. github.attacker.com), the stored token is only ever sent to
// github.com (which is also the only host the settings UI stores a token for).
func (s *Server) resolveAuth(ctx context.Context, host string) (auth, bool) {
	if host == "" {
		host = "github.com"
	}
	if token := ghToken(ctx, host); token != "" {
		return auth{Token: token, Source: "cli", Host: host}, true
	}
	if host == "github.com" {
		if token := s.storedToken(ctx); token != "" {
			return auth{Token: token, Source: "token", Host: host}, true
		}
	}
	return auth{}, false
}

// graphql posts a GraphQL query and unmarshals data into out.
func (s *Server) graphql(ctx context.Context, repo repoRef, token, query string, vars map[string]any, out any) error {
	payload, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, repo.graphqlURL(), bytes.NewReader(payload))
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	req.Header.Set("Authorization", "bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "camber-assistant")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return pkgerrors.Wrap(err, "github graphql request")
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return pkgerrors.WithStack(err)
	}
	if resp.StatusCode != http.StatusOK {
		return pkgerrors.Errorf("github graphql status %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return pkgerrors.Wrap(err, "decode graphql response")
	}
	if len(envelope.Errors) > 0 {
		return pkgerrors.Errorf("github graphql error: %s", envelope.Errors[0].Message)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(envelope.Data, out); err != nil {
		return pkgerrors.Wrap(err, "decode graphql data")
	}
	return nil
}

// viewerLogin returns the authenticated user's login for an auth.
func (s *Server) viewerLogin(ctx context.Context, a auth) string {
	var out struct {
		Viewer struct {
			Login string `json:"login"`
		} `json:"viewer"`
	}
	repo := repoRef{Host: a.Host}
	if err := s.graphql(ctx, repo, a.Token, `query{viewer{login}}`, nil, &out); err != nil {
		return ""
	}
	return out.Viewer.Login
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// --- GraphQL queries ---

// We fetch OPEN, MERGED, and CLOSED so a worktree whose PR was merged/closed
// still shows an indicator (the local branch usually outlives the remote one).
// Ordered by UPDATED_AT desc; repoList keeps the most recent PR per branch.
const listPRsQuery = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:100, states:[OPEN,MERGED,CLOSED], orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number title url state isDraft headRefName reviewDecision updatedAt
        comments{ totalCount }
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      }
    }
  }
}`

const prDetailQuery = `query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:1, headRefName:$branch, states:[OPEN,MERGED,CLOSED], orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number title url state isDraft body headRefName baseRefName updatedAt
        additions deletions changedFiles reviewDecision
        author{ login }
        comments(first:50){ totalCount nodes{ author{ login } body url createdAt } }
        reviews(first:50){ nodes{ author{ login } state body url submittedAt } }
        reviewThreads(first:100){ pageInfo{ hasNextPage endCursor } nodes{ comments{ totalCount } } }
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state contexts(first:100){ nodes{
          __typename
          ... on CheckRun{ name status conclusion detailsUrl }
          ... on StatusContext{ context state targetUrl }
        } } } } } }
      }
    }
  }
}`

const prReviewThreadsQuery = `query($owner:String!,$name:String!,$branch:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(first:1, headRefName:$branch, states:[OPEN,MERGED,CLOSED], orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        reviewThreads(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ comments{ totalCount } } }
      }
    }
  }
}`

// --- GraphQL response shapes ---

type gqlCheckContext struct {
	Typename     string `json:"__typename"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	Conclusion   string `json:"conclusion"`
	DetailsURL   string `json:"detailsUrl"`
	Context      string `json:"context"`
	ContextState string `json:"state"`
	TargetURL    string `json:"targetUrl"`
}

type gqlRollup struct {
	State    string `json:"state"`
	Contexts struct {
		Nodes []gqlCheckContext `json:"nodes"`
	} `json:"contexts"`
}

type gqlCommitNode struct {
	Commit struct {
		StatusCheckRollup *gqlRollup `json:"statusCheckRollup"`
	} `json:"commit"`
}

type gqlPageInfo struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

type gqlReviewThreads struct {
	PageInfo gqlPageInfo `json:"pageInfo"`
	Nodes    []struct {
		Comments struct {
			TotalCount int `json:"totalCount"`
		} `json:"comments"`
	} `json:"nodes"`
}

type gqlPR struct {
	Number         int    `json:"number"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	State          string `json:"state"`
	IsDraft        bool   `json:"isDraft"`
	Body           string `json:"body"`
	HeadRefName    string `json:"headRefName"`
	BaseRefName    string `json:"baseRefName"`
	UpdatedAt      string `json:"updatedAt"`
	Additions      int    `json:"additions"`
	Deletions      int    `json:"deletions"`
	ChangedFiles   int    `json:"changedFiles"`
	ReviewDecision string `json:"reviewDecision"`
	Author         struct {
		Login string `json:"login"`
	} `json:"author"`
	Comments struct {
		TotalCount int `json:"totalCount"`
		Nodes      []struct {
			Author struct {
				Login string `json:"login"`
			} `json:"author"`
			Body      string `json:"body"`
			URL       string `json:"url"`
			CreatedAt string `json:"createdAt"`
		} `json:"nodes"`
	} `json:"comments"`
	Reviews struct {
		Nodes []struct {
			Author struct {
				Login string `json:"login"`
			} `json:"author"`
			State       string `json:"state"`
			Body        string `json:"body"`
			URL         string `json:"url"`
			SubmittedAt string `json:"submittedAt"`
		} `json:"nodes"`
	} `json:"reviews"`
	ReviewThreads gqlReviewThreads `json:"reviewThreads"`
	Commits       struct {
		Nodes []gqlCommitNode `json:"nodes"`
	} `json:"commits"`
}

type gqlListResponse struct {
	Repository struct {
		PullRequests struct {
			Nodes []gqlPR `json:"nodes"`
		} `json:"pullRequests"`
	} `json:"repository"`
}
