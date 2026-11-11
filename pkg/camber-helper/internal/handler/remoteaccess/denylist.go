package remoteaccess

import "strings"

// Remote clients may invoke every JSON-RPC method EXCEPT the deny list below.
//
// This is deliberately not a security boundary: a paired device already runs
// agents and a worktree terminal on this machine, so method-level blocking
// cannot contain a hostile device. A default-open list keeps a new desktop
// method from silently breaking the mobile UI because nobody remembered to
// allowlist it. The deny list only protects the transport itself: the
// primary connection's protocol lifecycle, the remote-access server a
// client is connected through, and entry points that assume a local caller.
var deniedMethods = map[string]struct{}{
	// LSP lifecycle belongs to the primary (stdio) client. A remote
	// initialize would re-run global handler setup mid-session, and
	// shutdown/exit terminate the helper underneath the desktop app.
	"initialize":  {},
	"initialized": {},
	"shutdown":    {},
	"exit":        {},
}

var deniedPrefixes = []string{
	// The CLI dispatcher assigns local control origin and is reachable only
	// through the desktop's authenticated user-local socket.
	"camber/control/",
	// Remote-access administration: a paired device must not mint pairing
	// codes (persistence that survives its own revocation), revoke other
	// devices, or reconfigure/disable the server it is connected through.
	"camber/remoteAccess/",
}

// MethodAllowed reports whether remote clients may call the given method.
func MethodAllowed(method string) bool {
	if _, denied := deniedMethods[method]; denied {
		return false
	}
	for _, prefix := range deniedPrefixes {
		if strings.HasPrefix(method, prefix) {
			return false
		}
	}
	return true
}
