package remoteaccess

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// tailscaleCert obtains a genuinely-trusted TLS certificate for this node's
// MagicDNS name via the `tailscale` CLI. Unlike a self-signed cert, browsers
// trust it, so WebSocket (wss) handshakes succeed without a manual exception —
// which they cannot get, since WS has no "proceed anyway" interstitial.
//
// Returns the cert and the MagicDNS name the caller should advertise (the URL
// must use that name for the cert to validate). Requires HTTPS certificates to
// be enabled for the tailnet; otherwise it returns an error and the caller
// falls back to a self-signed certificate.
func tailscaleCert(dir string) (cert tls.Certificate, dnsName string, err error) {
	dnsName, err = tailscaleDNSName()
	if err != nil {
		return tls.Certificate{}, "", err
	}

	certPath := filepath.Join(dir, "tailscale-cert.pem")
	keyPath := filepath.Join(dir, "tailscale-key.pem")

	// Reuse a cached, still-valid cert to avoid hitting Let's Encrypt rate
	// limits on every enable. It must still cover the current MagicDNS name:
	// after a tailnet rename or re-login the cached cert can be unexpired yet
	// issued for a different name, and serving it would break the phone's TLS
	// with no fallback.
	if c, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil && len(c.Certificate) > 0 {
		if leaf, perr := x509.ParseCertificate(c.Certificate[0]); perr == nil &&
			time.Now().Before(leaf.NotAfter.Add(-24*time.Hour)) &&
			leaf.VerifyHostname(dnsName) == nil {
			return c, dnsName, nil
		}
	}

	bin, err := tailscaleBinary()
	if err != nil {
		return tls.Certificate{}, "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// `tailscale cert` provisions/renews the cert. The macOS GUI variant is
	// sandboxed and cannot write files outside its own container, so have it
	// print the PEM data to stdout ("-") and write the files ourselves.
	out, err := tailscaleCommand(ctx, bin, "cert",
		"--cert-file", "-", "--key-file", "-", dnsName).Output()
	if err != nil {
		if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
			return tls.Certificate{}, "", fmt.Errorf("tailscale cert: %w: %s", err, clipOutput(exitErr.Stderr))
		}
		return tls.Certificate{}, "", fmt.Errorf("tailscale cert: %w", err)
	}
	certPEM, keyPEM, err := splitCertPEM(out)
	if err != nil {
		return tls.Certificate{}, "", err
	}

	cert, err = tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, "", fmt.Errorf("loading tailscale cert: %w", err)
	}

	// Cache to disk so future enables skip issuance; serving works either way.
	if werr := writeCertCache(certPath, keyPath, certPEM, keyPEM); werr != nil {
		slog.Warn("remoteaccess: could not cache tailscale cert", "error", werr)
	}
	return cert, dnsName, nil
}

// writeCertCache persists the cert/key pair, removing both files if either
// write fails so a later reuse can't load a fresh cert paired with a stale
// key (which would only be caught at handshake time).
func writeCertCache(certPath, keyPath string, certPEM, keyPEM []byte) error {
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		os.Remove(certPath)
		os.Remove(keyPath)
		return err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		os.Remove(certPath)
		os.Remove(keyPath)
		return err
	}
	return nil
}

// splitCertPEM separates `tailscale cert` stdout — the certificate chain
// followed by the private key — into certificate and key PEM bytes. Blocks are
// matched by type (any "* PRIVATE KEY" is a key) rather than treating every
// non-certificate block as key material, so an unexpected block can't silently
// corrupt the key.
func splitCertPEM(out []byte) (certPEM, keyPEM []byte, err error) {
	rest := out
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		switch {
		case block.Type == "CERTIFICATE":
			certPEM = append(certPEM, pem.EncodeToMemory(block)...)
		case strings.HasSuffix(block.Type, "PRIVATE KEY"):
			keyPEM = append(keyPEM, pem.EncodeToMemory(block)...)
		}
	}
	if len(certPEM) == 0 || len(keyPEM) == 0 {
		return nil, nil, fmt.Errorf("tailscale cert output missing certificate or key")
	}
	return certPEM, keyPEM, nil
}

// tailscaleDNSName returns this node's MagicDNS name (without the trailing dot).
func tailscaleDNSName() (string, error) {
	bin, err := tailscaleBinary()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := tailscaleCommand(ctx, bin, "status", "--json").Output()
	if err != nil {
		return "", fmt.Errorf("tailscale status: %w", err)
	}
	_, name, _, err := parseTailscaleStatus(out)
	if err != nil {
		return "", err
	}
	if name == "" {
		return "", fmt.Errorf("no MagicDNS name (is MagicDNS enabled?)")
	}
	return name, nil
}
