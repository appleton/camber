package methods

import (
	"context"
	"strings"
)

// PrimaryClientOrigin identifies the primary (stdio/TCP) client connection.
// Remote WebSocket connections carry "remote:<deviceID>/<connUUID>" origins.
// Mirrors remoteaccess.PrimaryOrigin; defined here so packages that must not
// import remoteaccess (acpproxy) can reason about request origins.
const PrimaryClientOrigin = "primary"

type clientOriginKey struct{}

// WithClientOrigin records which client connection a request arrived on.
func WithClientOrigin(ctx context.Context, originID string) context.Context {
	return context.WithValue(ctx, clientOriginKey{}, originID)
}

// ClientOriginFromContext returns the request's originating client connection
// ID, defaulting to the primary connection for contexts without one.
func ClientOriginFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(clientOriginKey{}).(string); ok && v != "" {
		return v
	}
	return PrimaryClientOrigin
}

// ClientOriginDevice extracts the paired device ID from a remote origin ID
// ("remote:<deviceID>/<connUUID>"). It returns "" for the primary connection,
// so device-scoped bookkeeping (e.g. skipping a device's own relayed user
// messages during resume) never matches the desktop.
func ClientOriginDevice(originID string) string {
	rest, ok := strings.CutPrefix(originID, "remote:")
	if !ok {
		return ""
	}
	device, _, _ := strings.Cut(rest, "/")
	return device
}
