package github

import (
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// repoRef identifies a GitHub repository resolved from a git remote.
type repoRef struct {
	Host  string // e.g. "github.com" or an enterprise host
	Owner string
	Name  string
}

// graphqlURL returns the GraphQL endpoint for the repo's host. github.com uses
// api.github.com; GitHub Enterprise Server uses https://<host>/api/graphql.
func (r repoRef) graphqlURL() string {
	if r.Host == "github.com" || r.Host == "" {
		return "https://api.github.com/graphql"
	}
	return "https://" + r.Host + "/api/graphql"
}

// webURL is the browser base for the repo's host (github.com or a GHE host).
func (r repoRef) webURL() string {
	host := r.Host
	if host == "" {
		host = "github.com"
	}
	return "https://" + host
}

// createPRURL is the page to open a new pull request from branch.
func (r repoRef) createPRURL(branch string) string {
	return r.webURL() + "/" + r.Owner + "/" + r.Name + "/pull/new/" + branch
}

// parseRemoteURL extracts host/owner/name from the common git remote URL forms:
//
//	https://github.com/owner/repo(.git)
//	git@github.com:owner/repo(.git)
//	ssh://git@github.com/owner/repo(.git)
//
// ok is false when the URL cannot be parsed into owner/name.
func parseRemoteURL(remote string) (repoRef, bool) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return repoRef{}, false
	}

	var host, path string
	switch {
	case strings.HasPrefix(remote, "git@"):
		// scp-like syntax: git@host:owner/repo
		rest := strings.TrimPrefix(remote, "git@")
		host, path, _ = strings.Cut(rest, ":")
	case strings.Contains(remote, "://"):
		_, rest, _ := strings.Cut(remote, "://")
		// strip optional userinfo (git@)
		if at := strings.IndexByte(rest, '@'); at != -1 {
			rest = rest[at+1:]
		}
		host, path, _ = strings.Cut(rest, "/")
	default:
		return repoRef{}, false
	}

	host = strings.ToLower(strings.TrimSpace(host))
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	owner, name, found := strings.Cut(path, "/")
	if !found || host == "" || owner == "" || name == "" {
		return repoRef{}, false
	}
	// name may still contain trailing path segments for nested forms; keep the
	// first segment after owner only.
	if extra := strings.IndexByte(name, '/'); extra != -1 {
		name = name[:extra]
	}
	return repoRef{Host: host, Owner: owner, Name: name}, true
}

// isSupportedHost reports whether we should attempt GitHub API calls for a host.
// github.com is always supported. For enterprise hosts, stay conservative: only
// opt into hosts whose names clearly identify them as GitHub Enterprise. This
// avoids surfacing GitHub controls for arbitrary Git remotes such as Azure
// DevOps or internal non-GitHub forges.
func isSupportedHost(host string) bool {
	host = strings.ToLower(host)
	if host == "github.com" {
		return true
	}
	return strings.Contains(host, "github") || strings.HasPrefix(host, "ghe.")
}

// rollupStatus maps a GraphQL statusCheckRollup state to our compact checks
// status. The rollup state is one of EXPECTED, ERROR, FAILURE, PENDING, SUCCESS.
func rollupStatus(state string) string {
	switch strings.ToUpper(state) {
	case "SUCCESS":
		return "success"
	case "FAILURE", "ERROR":
		return "failure"
	case "PENDING", "EXPECTED":
		return "pending"
	default:
		return "none"
	}
}

// prState derives our state field from the GraphQL PR state + isDraft.
func prState(state string, isDraft bool) string {
	switch strings.ToUpper(state) {
	case "MERGED":
		return "merged"
	case "CLOSED":
		return "closed"
	case "OPEN":
		if isDraft {
			return "draft"
		}
		return "open"
	default:
		return "open"
	}
}

// normalizeReviewDecision lowercases the GraphQL reviewDecision enum
// (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED) into our snake_case form.
func normalizeReviewDecision(decision string) string {
	switch strings.ToUpper(decision) {
	case "APPROVED":
		return "approved"
	case "CHANGES_REQUESTED":
		return "changes_requested"
	case "REVIEW_REQUIRED":
		return "review_required"
	default:
		return ""
	}
}

// normalizeReviewState lowercases the GraphQL PullRequestReviewState enum
// (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING) into snake_case.
func normalizeReviewState(state string) string {
	switch strings.ToUpper(state) {
	case "APPROVED":
		return "approved"
	case "CHANGES_REQUESTED":
		return "changes_requested"
	case "COMMENTED":
		return "commented"
	case "DISMISSED":
		return "dismissed"
	case "PENDING":
		return "pending"
	default:
		return strings.ToLower(state)
	}
}

// classifyCheck classifies a single CheckRun/StatusContext into a bucket:
// "success", "failure", or "pending". Used to tally detail counts.
func classifyCheck(status, conclusion, contextState string) string {
	// CheckRun: status QUEUED/IN_PROGRESS/COMPLETED, conclusion set when COMPLETED.
	if conclusion != "" {
		switch strings.ToUpper(conclusion) {
		case "SUCCESS", "NEUTRAL", "SKIPPED":
			return "success"
		case "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE":
			return "failure"
		default:
			return "pending"
		}
	}
	if status != "" {
		switch strings.ToUpper(status) {
		case "COMPLETED":
			return "success"
		default:
			return "pending"
		}
	}
	// StatusContext: state SUCCESS/PENDING/FAILURE/ERROR/EXPECTED.
	switch strings.ToUpper(contextState) {
	case "SUCCESS":
		return "success"
	case "FAILURE", "ERROR":
		return "failure"
	default:
		return "pending"
	}
}

// emptyStatus is the canonical "no pull request" status.
func emptyStatus() methods.GitHubPRStatus {
	return methods.GitHubPRStatus{State: "none", Checks: methods.GitHubChecks{Status: "none"}}
}
