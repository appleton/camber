package acpproxy

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Everything the ACP registry describes ends up executed on the machine: npx
// and uvx package names, and archive URLs whose contents are unpacked and run.
// The registry is unsigned and mutable, so these limits are what stands between
// a registry or CDN compromise and an unbounded download, a redirect onto a
// cleartext or internal host, or a decompression bomb filling the disk.
const (
	// registryFetchTimeout bounds a registry metadata fetch. Metadata is small;
	// a slow response here delays agent startup.
	registryFetchTimeout = 30 * time.Second
	// registryDownloadTimeout bounds a whole binary download. Agent archives
	// reach a few hundred MB, so this is generous rather than tight.
	registryDownloadTimeout = 15 * time.Minute
	// registryMetadataMaxBytes caps the registry JSON document.
	registryMetadataMaxBytes = 8 << 20 // 8 MiB
	// registryArchiveMaxBytes caps a downloaded archive before extraction.
	registryArchiveMaxBytes = 512 << 20 // 512 MiB
	// registryExtractedMaxBytes caps the total unpacked size, bounding
	// decompression bombs that are small on the wire.
	registryExtractedMaxBytes = 2 << 30 // 2 GiB
	// registryExtractedMaxFiles caps the number of unpacked entries.
	registryExtractedMaxFiles = 50_000
	// registryMaxRedirects caps the redirect chain. Each hop is re-checked
	// against checkRegistryURL, so a 302 cannot downgrade to cleartext or
	// point at a private address.
	registryMaxRedirects = 5
)

// checkRegistryURL rejects registry and archive URLs that are not HTTPS.
// Loopback is exempt: the helper's own tests and local registry mirrors serve
// plain HTTP there, and loopback is not exposed to network attackers.
func checkRegistryURL(u *url.URL) error {
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("ACP registry URL must use https: %s", u.Redacted())
	default:
		return fmt.Errorf("unsupported ACP registry URL scheme %q", u.Scheme)
	}
}

func checkRegistryURLString(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid ACP registry URL: %w", err)
	}
	return checkRegistryURL(u)
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// registryHTTPClient returns a client that re-validates every redirect hop and
// gives up after registryMaxRedirects. http.DefaultClient follows redirects
// anywhere, including from an https registry onto cleartext or a private host.
func registryHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= registryMaxRedirects {
				return fmt.Errorf("too many redirects (%d) fetching ACP registry resource", len(via))
			}
			return checkRegistryURL(req.URL)
		},
	}
}
