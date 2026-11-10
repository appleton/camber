package acp

const (
	// MetaKeyPermissionOverrideRules is set on a RequestPermissionOutcomeSelected's
	// _meta to override the suggested rules with user-edited ones. When absent,
	// the agent persists the original suggested rules.
	MetaKeyPermissionOverrideRules = "camber/permission_override_rules"
)

// EncodeOverrideRules returns the _meta payload that user-edited rules ride
// on inside a permission response's Outcome.Selected. Returns nil for empty
// input so the Meta field stays absent on the wire.
func EncodeOverrideRules(rules []string) map[string]any {
	if len(rules) == 0 {
		return nil
	}
	return map[string]any{MetaKeyPermissionOverrideRules: rules}
}
