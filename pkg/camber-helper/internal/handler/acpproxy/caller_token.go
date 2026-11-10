package acpproxy

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"log/slog"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"
)

// callerTokens maps per-conversation caller tokens to conversation ids. A
// token proves which conversation issued a control request: it is delivered
// only inside that conversation's per-prompt host context, never through the
// shared agent process environment, nav state, or logs. Tokens live in memory
// for the helper process lifetime, so a restart invalidates them.
//
// A token that shows up in agent output is revoked (see
// observeCallerTokenLeak): exact redaction of control output cannot catch a
// token the agent streamed across several chunks, and any reader of the
// session's events could rejoin the fragments.
type callerTokens struct {
	mu             sync.Mutex
	byConversation map[string]string
	byToken        map[string]string
	// ownerSession maps a conversation to the agent session whose prompts
	// carry its token, so the agent's own CLI invocations are not leaks.
	ownerSession map[string]promptSessionKey
	// windows holds the trailing streamed text per session and chunk kind,
	// bounded to leakWindowBytes, so a token split across chunks is seen.
	windows map[leakWindowKey][]byte
	// revoked keeps recently revoked tokens so control output still redacts
	// them; bounded to maxRevokedCallerTokens.
	revoked []string
}

const (
	// leakWindowBytes keeps at least twice the token length (rand.Text is
	// 26 base32 characters) of trailing streamed text per session.
	leakWindowBytes = 64
	// maxLeakWindows bounds the per-session window map; exceeding it drops
	// every window, which at worst misses one split across that reset.
	maxLeakWindows         = 4096
	maxRevokedCallerTokens = 64
)

type leakWindowKey struct {
	session promptSessionKey
	kind    string
}

// CallerToken returns the conversation's caller token, minting it on first use.
func (h *Handler) CallerToken(conversationID string) string {
	return h.callerTokenForSession(conversationID, promptSessionKey{})
}

// ResolveCallerToken maps a caller token back to the conversation it was
// minted for. Unknown, revoked, or empty tokens prove nothing.
func (h *Handler) ResolveCallerToken(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	t := &h.callers
	t.mu.Lock()
	defer t.mu.Unlock()
	id, ok := t.byToken[token]
	return id, ok
}

// RedactCallerTokens replaces every minted (or recently revoked) token in
// data. An agent can echo its prompt (for example when replaying a loaded
// session), and control output must not let one conversation read another's
// token.
func (h *Handler) RedactCallerTokens(data []byte) []byte {
	t := &h.callers
	t.mu.Lock()
	defer t.mu.Unlock()
	redact := func(token string) {
		if bytes.Contains(data, []byte(token)) {
			data = bytes.ReplaceAll(data, []byte(token), []byte("[redacted]"))
		}
	}
	for token := range t.byToken {
		redact(token)
	}
	for _, token := range t.revoked {
		redact(token)
	}
	return data
}

// observeCallerTokenLeak revokes any caller token that appears in an agent
// session/update, before the update is routed to surfaces or the event log.
// Streamed agent message and thought text is matched through a rolling
// per-session window, so a token split across chunks is caught; every other
// string in the notification is scanned whole. The session's own token in a
// tool call is not a leak: the agent passes it to `poolside` on the command
// line, and exact redaction covers that whole token in control output.
// User message chunks are skipped: they echo the prompt (including the host
// context) during session/load replay, where the token is whole and redacted.
func (h *Handler) observeCallerTokenLeak(serverName, sessionID string, update acpsdk.SessionUpdate) {
	if update.UserMessageChunk != nil {
		return
	}
	t := &h.callers
	t.mu.Lock()
	empty := len(t.byToken) == 0
	t.mu.Unlock()
	if empty {
		return
	}
	session := promptSessionKey{agentServer: normalizeServerName(serverName), sessionID: sessionID}
	var streamKind, streamText string
	switch {
	case update.AgentMessageChunk != nil && update.AgentMessageChunk.Content.Text != nil:
		streamKind, streamText = "message", update.AgentMessageChunk.Content.Text.Text
	case update.AgentThoughtChunk != nil && update.AgentThoughtChunk.Content.Text != nil:
		streamKind, streamText = "thought", update.AgentThoughtChunk.Content.Text.Text
	}
	toolCall := update.ToolCall != nil || update.ToolCallUpdate != nil
	raw, err := json.Marshal(update)
	if err != nil {
		raw = nil
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	var leaked []string
	if streamKind != "" {
		key := leakWindowKey{session: session, kind: streamKind}
		joined := append(append([]byte(nil), t.windows[key]...), streamText...)
		for token := range t.byToken {
			if bytes.Contains(joined, []byte(token)) {
				leaked = append(leaked, token)
			}
		}
		if len(joined) > leakWindowBytes {
			joined = joined[len(joined)-leakWindowBytes:]
		}
		if t.windows == nil || len(t.windows) >= maxLeakWindows {
			t.windows = map[leakWindowKey][]byte{}
		}
		t.windows[key] = joined
	}
	for token, conversationID := range t.byToken {
		if !bytes.Contains(raw, []byte(token)) {
			continue
		}
		if toolCall && t.ownerSession[conversationID] == session {
			continue
		}
		leaked = append(leaked, token)
	}
	for _, token := range leaked {
		conversationID, ok := t.byToken[token]
		if !ok {
			continue
		}
		t.revokeLocked(token, conversationID)
		// Never log the token itself.
		slog.Warn("acpproxy: caller token appeared in agent output; revoked it",
			"conversation", conversationID, "server", session.agentServer, "session_id", sessionID)
	}
}

// callerTokenForSession returns the conversation's caller token, minting it
// on first use, and records the agent session whose prompts carry it.
func (h *Handler) callerTokenForSession(conversationID string, session promptSessionKey) string {
	if conversationID == "" {
		return ""
	}
	t := &h.callers
	t.mu.Lock()
	defer t.mu.Unlock()
	if session.sessionID != "" {
		if t.ownerSession == nil {
			t.ownerSession = map[string]promptSessionKey{}
		}
		t.ownerSession[conversationID] = session
	}
	if token, ok := t.byConversation[conversationID]; ok {
		return token
	}
	if t.byConversation == nil {
		t.byConversation = map[string]string{}
		t.byToken = map[string]string{}
	}
	// rand.Text carries at least 128 bits of randomness.
	token := rand.Text()
	t.byConversation[conversationID] = token
	t.byToken[token] = conversationID
	return token
}

// revokeLocked forgets a token so ResolveCallerToken rejects it; the
// conversation's next prompt mints a fresh one.
func (t *callerTokens) revokeLocked(token, conversationID string) {
	delete(t.byToken, token)
	if t.byConversation[conversationID] == token {
		delete(t.byConversation, conversationID)
	}
	t.revoked = append(t.revoked, token)
	if len(t.revoked) > maxRevokedCallerTokens {
		t.revoked = t.revoked[len(t.revoked)-maxRevokedCallerTokens:]
	}
}
