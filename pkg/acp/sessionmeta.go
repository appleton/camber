package acp

// MetaKeySessionConversationID is set on a session/new request's _meta to
// carry the client's conversation id for the session being created. The
// helper uses it to bind the nav conversation row to the new session id
// synchronously, before the response returns — so conversation live status
// (keyed by session id) is attachable from the first moment a turn can start,
// instead of racing a client-side echo upsert over a possibly-flaky socket.
// Agents ignore unknown _meta keys per the ACP spec.
const (
	MetaKeySessionConversationID = "camber/conversation_id"
	MetaKeySessionHandoffID      = "camber/handoff_id"
)

// DecodeSessionConversationID extracts the conversation id from a session/new
// request's _meta. Returns "" when the key is missing or malformed.
func DecodeSessionConversationID(meta any) string {
	m, ok := meta.(map[string]any)
	if !ok {
		return ""
	}
	v, _ := m[MetaKeySessionConversationID].(string)
	return v
}

// DecodeSessionHandoffID extracts the prepared Camber handoff id from a
// session/new request. The helper uses it to commit the frozen source leg in
// the same transaction that rebinds the conversation to the target session.
func DecodeSessionHandoffID(meta any) string {
	m, ok := meta.(map[string]any)
	if !ok {
		return ""
	}
	v, _ := m[MetaKeySessionHandoffID].(string)
	return v
}
