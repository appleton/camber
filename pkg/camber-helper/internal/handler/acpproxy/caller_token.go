package acpproxy

import (
	"bytes"
	"crypto/rand"
	"sync"
)

// callerTokens maps per-conversation caller tokens to conversation ids. A
// token proves which conversation issued a control request: it is delivered
// only inside that conversation's per-prompt host context, never through the
// shared agent process environment, nav state, or logs. Tokens live in memory
// for the helper process lifetime, so a restart invalidates them.
type callerTokens struct {
	mu             sync.Mutex
	byConversation map[string]string
	byToken        map[string]string
}

// CallerToken returns the conversation's caller token, minting it on first use.
func (h *Handler) CallerToken(conversationID string) string {
	if conversationID == "" {
		return ""
	}
	t := &h.callers
	t.mu.Lock()
	defer t.mu.Unlock()
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

// ResolveCallerToken maps a caller token back to the conversation it was
// minted for. Unknown or empty tokens prove nothing.
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

// RedactCallerTokens replaces every minted token in data. An agent can echo
// its prompt (for example when replaying a loaded session), and control
// output must not let one conversation read another's token.
func (h *Handler) RedactCallerTokens(data []byte) []byte {
	t := &h.callers
	t.mu.Lock()
	defer t.mu.Unlock()
	for token := range t.byToken {
		if bytes.Contains(data, []byte(token)) {
			data = bytes.ReplaceAll(data, []byte(token), []byte("[redacted]"))
		}
	}
	return data
}
