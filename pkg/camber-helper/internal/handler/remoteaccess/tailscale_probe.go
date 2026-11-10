package remoteaccess

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// tailscaleBinary resolves the tailscale CLI. On macOS the GUI app ships the
// CLI inside the app bundle without putting it on PATH (regardless of the
// shellenv repair applied at startup), so fall back to the known bundle
// location.
func tailscaleBinary() (string, error) {
	if path, err := exec.LookPath("tailscale"); err == nil {
		return path, nil
	}
	if runtime.GOOS == "darwin" {
		const appCLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, err := exec.LookPath(appCLI); err == nil {
			return appCLI, nil
		}
	}
	return "", fmt.Errorf("tailscale CLI not found")
}

// tailscaleCommand builds an exec.Cmd for the tailscale CLI. The macOS GUI
// binary decides between acting as a CLI and launching the GUI by sniffing
// shell-indicator environment variables (TERM, SHLVL, PS1). The helper runs
// under launchd with none of them, so without TERM the binary prints "The
// Tailscale GUI failed to start" to stdout (exit 0) instead of CLI output.
func tailscaleCommand(ctx context.Context, bin string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), "TERM=dumb")
	return cmd
}

// clipOutput trims CLI output and caps it for inclusion in an error or
// warning shown in the settings UI, so a pathological multi-KB dump can't
// bloat the message. Returns "" when there is nothing to show.
func clipOutput(out []byte) string {
	s := strings.TrimSpace(string(out))
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

// probeTailscale inspects the local Tailscale installation so the settings UI
// can explain, before the user hits enable, whether the recommended
// trusted-certificate path will work — and if not, why.
func probeTailscale(certDir string) methods.RemoteAccessTailscaleInfo {
	info := methods.RemoteAccessTailscaleInfo{}
	_, ifErr := tailscaleIP()
	info.InterfaceUp = ifErr == nil

	bin, err := tailscaleBinary()
	if err != nil {
		info.Error = "Tailscale CLI not found"
		return info
	}
	info.CLIInstalled = true

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := tailscaleCommand(ctx, bin, "status", "--json").Output()
	if err != nil {
		info.Error = fmt.Sprintf("tailscale status failed: %v", err)
		return info
	}
	state, dnsName, httpsEnabled, err := parseTailscaleStatus(out)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	info.BackendState = state
	info.DNSName = dnsName
	info.HTTPSEnabled = httpsEnabled
	info.CertCached = cachedTailscaleCertValid(certDir)
	return info
}

// parseTailscaleStatus extracts what the probe needs from
// `tailscale status --json`: the backend state, this node's MagicDNS name,
// and whether the tailnet can issue HTTPS certificates (CertDomains).
func parseTailscaleStatus(out []byte) (backendState, dnsName string, httpsEnabled bool, err error) {
	var status struct {
		BackendState string   `json:"BackendState"`
		CertDomains  []string `json:"CertDomains"`
		Self         struct {
			DNSName string `json:"DNSName"`
		} `json:"Self"`
	}
	if err := json.Unmarshal(out, &status); err != nil {
		// Non-JSON output is usually the CLI explaining itself (e.g. "The
		// Tailscale GUI failed to start"); surface it over the parse error.
		if snippet := clipOutput(out); snippet != "" {
			return "", "", false, fmt.Errorf("unexpected tailscale status output: %q", snippet)
		}
		return "", "", false, fmt.Errorf("parsing tailscale status: %w", err)
	}
	return status.BackendState,
		strings.TrimSuffix(status.Self.DNSName, "."),
		len(status.CertDomains) > 0,
		nil
}

// cachedTailscaleCertValid reports whether a still-valid trusted Tailscale
// cert is already on disk — if so, enabling is instant; if not, the first
// enable blocks ~10-15s on Let's Encrypt issuance.
func cachedTailscaleCertValid(dir string) bool {
	c, err := tls.LoadX509KeyPair(
		filepath.Join(dir, "tailscale-cert.pem"),
		filepath.Join(dir, "tailscale-key.pem"),
	)
	if err != nil || len(c.Certificate) == 0 {
		return false
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	return err == nil && time.Now().Before(leaf.NotAfter.Add(-24*time.Hour))
}
