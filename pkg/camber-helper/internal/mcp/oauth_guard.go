package mcp

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// oauthMaxRedirects caps the redirect chain on OAuth discovery, registration
// and token requests.
const oauthMaxRedirects = 5

// These relax the transport guard so tests can point discovery at httptest
// servers, which listen on loopback and often speak plain HTTP. They are kept
// separate so a test can exercise one half of the guard while the other stays
// out of the way. Neither is ever set outside tests.
var (
	// allowCleartextOAuthEndpoints drops the https requirement.
	allowCleartextOAuthEndpoints atomic.Bool
	// allowNonPublicOAuthAddresses drops the resolved-address check.
	allowNonPublicOAuthAddresses atomic.Bool
)

// nonPublicPrefixes covers ranges that netip's own predicates miss but which
// still address infrastructure rather than the public internet.
var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),  // CGNAT, also used by tailnets
	netip.MustParsePrefix("192.0.0.0/24"),   // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"),  // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),    // reserved
	netip.MustParsePrefix("::ffff:0:0/96"),  // IPv4-mapped, handled after Unmap
	netip.MustParsePrefix("64:ff9b:1::/48"), // IPv4/IPv6 translation
}

// checkOAuthEndpointURL requires HTTPS for any URL the helper fetches during an
// OAuth flow.
//
// Discovery starts from a URL the user typed, but everything after that --
// authorization, token and registration endpoints -- comes out of a metadata
// document the MCP server controls. The loopback redirect URI is exempt by
// construction: it is handed to the browser, never fetched here.
func checkOAuthEndpointURL(u *url.URL) error {
	if allowCleartextOAuthEndpoints.Load() {
		return nil
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return fmt.Errorf("OAuth endpoint %s must use https", u.Redacted())
	}
	return nil
}

func checkOAuthEndpointURLString(rawURL, role string) error {
	if rawURL == "" {
		return nil
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid %s URL: %w", role, err)
	}
	if err := checkOAuthEndpointURL(u); err != nil {
		return fmt.Errorf("%s: %w", role, err)
	}
	return nil
}

// checkResolvedAddress rejects a connection to an address that is not on the
// public internet. It runs as the dialer's Control hook, which fires after DNS
// resolution with the address actually being dialled, so a hostname that
// resolves to a private address -- or re-resolves to one on a later lookup --
// is refused as well.
func checkResolvedAddress(address string) error {
	if allowNonPublicOAuthAddresses.Load() {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("OAuth endpoint address %q is malformed: %w", address, err)
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("OAuth endpoint address %q is not an IP", host)
	}
	if !isPublicAddr(ip) {
		return fmt.Errorf("OAuth endpoint resolves to non-public address %s", ip)
	}
	return nil
}

func isPublicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() ||
		ip.IsUnspecified() ||
		ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || // includes 169.254.169.254, the cloud metadata service
		ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() {
		return false
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

// newOAuthHTTPClient returns the client used for every OAuth request driven by
// server-supplied URLs: metadata discovery, dynamic client registration, and
// the token exchange and refresh.
func newOAuthHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			return checkResolvedAddress(address)
		},
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dialer.DialContext

	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= oauthMaxRedirects {
				return fmt.Errorf("too many redirects (%d) during OAuth flow", len(via))
			}
			return checkOAuthEndpointURL(req.URL)
		},
	}
}
