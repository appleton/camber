package remoteaccess

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/methods"
)

func parseCertPEM(t *testing.T, certPEM []byte) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(certPEM)
	require.NotNil(t, block)
	cert, err := x509.ParseCertificate(block.Bytes)
	require.NoError(t, err)
	return cert
}

func TestLoadOrCreateCertCoversHostsAndPersists(t *testing.T) {
	dir := t.TempDir()
	hosts := []string{"localhost", "127.0.0.1", "100.101.102.103"}

	certPEM, keyPEM, caPEM, err := loadOrCreateCert(dir, hosts)
	require.NoError(t, err)

	// Usable as a TLS keypair.
	_, err = tls.X509KeyPair(certPEM, keyPEM)
	require.NoError(t, err)

	cert := parseCertPEM(t, certPEM)
	assert.Contains(t, cert.DNSNames, "localhost")
	assert.True(t, certCoversHost(cert, "127.0.0.1"))
	assert.True(t, certCoversHost(cert, "100.101.102.103"))

	// The leaf chains to the returned CA (the phone trusts the CA once and
	// every future leaf validates).
	ca := parseCertPEM(t, caPEM)
	assert.True(t, ca.IsCA)
	require.NoError(t, cert.CheckSignatureFrom(ca))

	// Second call reuses the persisted cert (stable so phones don't re-trust).
	certPEM2, _, caPEM2, err := loadOrCreateCert(dir, hosts)
	require.NoError(t, err)
	assert.Equal(t, certPEM, certPEM2)
	assert.Equal(t, caPEM, caPEM2)

	// Files landed next to the state dir.
	assert.FileExists(t, filepath.Join(dir, "remote-access-cert.pem"))
	assert.FileExists(t, filepath.Join(dir, "remote-access-key.pem"))
	assert.FileExists(t, filepath.Join(dir, "remote-access-ca.pem"))
	assert.FileExists(t, filepath.Join(dir, "remote-access-ca-key.pem"))
}

func TestLoadOrCreateCertRegeneratesForNewHostKeepingCA(t *testing.T) {
	dir := t.TempDir()
	certPEM, _, caPEM, err := loadOrCreateCert(dir, []string{"127.0.0.1"})
	require.NoError(t, err)

	// A newly-required host (e.g. the LAN IP changed) forces leaf
	// regeneration, but the CA stays stable so the phone's installed trust
	// keeps working.
	certPEM2, _, caPEM2, err := loadOrCreateCert(dir, []string{"127.0.0.1", "100.64.0.5"})
	require.NoError(t, err)
	assert.NotEqual(t, certPEM, certPEM2)
	assert.Equal(t, caPEM, caPEM2)

	cert := parseCertPEM(t, certPEM2)
	assert.True(t, certCoversHost(cert, "100.64.0.5"))
	require.NoError(t, cert.CheckSignatureFrom(parseCertPEM(t, caPEM2)))
}

func TestLoadOrCreateCertReplacesForeignLeaf(t *testing.T) {
	dir := t.TempDir()
	hosts := []string{"127.0.0.1"}

	// Simulate a leaf from another scheme (e.g. the previous self-signed
	// one): signed by a CA this state dir does not hold.
	caPEM, caKeyPEM, err := generateCA()
	require.NoError(t, err)
	otherCA, otherKey, err := parseCA(caPEM, caKeyPEM)
	require.NoError(t, err)
	oldCert, oldKey, err := issueLeaf(otherCA, otherKey, hosts)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "remote-access-cert.pem"), oldCert, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "remote-access-key.pem"), oldKey, 0o600))

	certPEM, _, newCAPEM, err := loadOrCreateCert(dir, hosts)
	require.NoError(t, err)
	assert.NotEqual(t, oldCert, certPEM)
	require.NoError(t, parseCertPEM(t, certPEM).CheckSignatureFrom(parseCertPEM(t, newCAPEM)))
}

func TestEnableTLSServesHTTPSAndReportsHTTPSURLs(t *testing.T) {
	srv, err := NewServer(Options{
		StatePath: filepath.Join(t.TempDir(), "state.json"),
		Hub:       NewHub(),
		Dispatch: func(string, *glsp.Context) (any, bool, bool, error) {
			return nil, true, true, nil
		},
	})
	require.NoError(t, err)

	port := freePort(t)
	// "all" bind triggers TLS; loopback IP is in the cert SANs so we can dial it.
	status, err := srv.Enable(methods.RemoteAccessEnableParams{Bind: BindAll, Port: port})
	require.NoError(t, err)
	defer srv.Disable()

	require.NotEmpty(t, status.URLs)
	for _, u := range status.URLs {
		assert.Contains(t, u, "https://")
	}

	// Status reports the local-CA TLS mode with a CA download URL.
	require.NotNil(t, status.TLS)
	assert.Equal(t, methods.RemoteAccessTLSModeLocalCA, status.TLS.Mode)
	assert.Equal(t, status.URLs[0]+"/ca.crt", status.TLS.CAURL)
	assert.Empty(t, status.TLS.Warning)

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	resp, err := client.Get(fmt.Sprintf("https://127.0.0.1:%d/api/me", port))
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	// The CA cert is downloadable pre-auth so the phone can trust it before
	// pairing.
	caResp, err := client.Get(fmt.Sprintf("https://127.0.0.1:%d/ca.crt", port))
	require.NoError(t, err)
	defer caResp.Body.Close()
	require.Equal(t, http.StatusOK, caResp.StatusCode)
	assert.Equal(t, "application/x-x509-ca-cert", caResp.Header.Get("Content-Type"))
	caBody, err := io.ReadAll(caResp.Body)
	require.NoError(t, err)
	ca := parseCertPEM(t, caBody)
	assert.True(t, ca.IsCA)

	// The served TLS leaf verifies against the downloaded CA — the exact
	// check the phone performs after installing it.
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	verifyingClient := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool},
	}}
	verResp, err := verifyingClient.Get(fmt.Sprintf("https://127.0.0.1:%d/api/me", port))
	require.NoError(t, err)
	verResp.Body.Close()

	// Plain HTTP to a TLS listener is rejected: Go's TLS server replies 400
	// "Client sent an HTTP request to an HTTPS server".
	plainResp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/me", port))
	require.NoError(t, err)
	defer plainResp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, plainResp.StatusCode)
}

func TestPlainHTTPReportsModeAndHidesCACert(t *testing.T) {
	srv, err := NewServer(Options{
		StatePath: filepath.Join(t.TempDir(), "state.json"),
		Hub:       NewHub(),
		Dispatch: func(string, *glsp.Context) (any, bool, bool, error) {
			return nil, true, true, nil
		},
	})
	require.NoError(t, err)

	port := freePort(t)
	status, err := srv.Enable(methods.RemoteAccessEnableParams{Bind: BindLoopback, Port: port})
	require.NoError(t, err)
	defer srv.Disable()

	require.NotNil(t, status.TLS)
	assert.Equal(t, methods.RemoteAccessTLSModePlain, status.TLS.Mode)
	assert.Empty(t, status.TLS.CAURL)

	// No CA in play: /ca.crt has nothing to serve.
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/ca.crt", port))
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestParseTailscaleStatus(t *testing.T) {
	out := []byte(`{
		"BackendState": "Running",
		"CertDomains": ["mac.tailnet.ts.net"],
		"Self": {"DNSName": "mac.tailnet.ts.net."}
	}`)
	state, dnsName, httpsEnabled, err := parseTailscaleStatus(out)
	require.NoError(t, err)
	assert.Equal(t, "Running", state)
	assert.Equal(t, "mac.tailnet.ts.net", dnsName)
	assert.True(t, httpsEnabled)

	// HTTPS not enabled for the tailnet: CertDomains is empty/absent.
	state, dnsName, httpsEnabled, err = parseTailscaleStatus([]byte(`{
		"BackendState": "NeedsLogin",
		"Self": {"DNSName": ""}
	}`))
	require.NoError(t, err)
	assert.Equal(t, "NeedsLogin", state)
	assert.Empty(t, dnsName)
	assert.False(t, httpsEnabled)

	// Non-JSON output (the macOS GUI binary prints "The Tailscale GUI failed
	// to start" when it doesn't detect a shell) is quoted in the error so the
	// settings UI shows what the CLI actually said, not a JSON parse error.
	_, _, _, err = parseTailscaleStatus([]byte("The Tailscale GUI failed to start\n"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), `"The Tailscale GUI failed to start"`)

	_, _, _, err = parseTailscaleStatus(nil)
	assert.Error(t, err)
}

func TestTailscaleCommandForcesCLIMode(t *testing.T) {
	cmd := tailscaleCommand(context.Background(), "/usr/bin/true", "status")
	assert.Contains(t, cmd.Env, "TERM=dumb")
}

func TestSplitCertPEM(t *testing.T) {
	chain := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte("leaf")})
	chain = append(chain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte("intermediate")})...)

	// The key block type varies by key algorithm; all must be recognized.
	for _, keyType := range []string{"PRIVATE KEY", "EC PRIVATE KEY", "RSA PRIVATE KEY"} {
		key := pem.EncodeToMemory(&pem.Block{Type: keyType, Bytes: []byte("key")})
		certPEM, keyPEM, err := splitCertPEM(append(append([]byte{}, chain...), key...))
		require.NoError(t, err, keyType)
		assert.Equal(t, chain, certPEM, keyType)
		assert.Equal(t, key, keyPEM, keyType)
	}

	// An unexpected block is ignored rather than absorbed as key material, so
	// a chain plus only a stray block is treated as "no key".
	stray := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: []byte("csr")})
	_, _, err := splitCertPEM(append(append([]byte{}, chain...), stray...))
	assert.Error(t, err, "stray block must not count as a key")

	_, _, err = splitCertPEM(chain)
	assert.Error(t, err, "missing key")
	_, _, err = splitCertPEM(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: []byte("key")}))
	assert.Error(t, err, "missing certificate")
	_, _, err = splitCertPEM([]byte("The Tailscale GUI failed to start\n"))
	assert.Error(t, err)
}

func TestWriteCertCacheRemovesBothOnKeyFailure(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "tailscale-cert.pem")
	// Make the key path un-writable by creating a directory in its place.
	keyPath := filepath.Join(dir, "tailscale-key.pem")
	require.NoError(t, os.Mkdir(keyPath, 0o700))

	err := writeCertCache(certPath, keyPath, []byte("cert"), []byte("key"))
	require.Error(t, err)
	// The cert must not survive without its key, or a later reuse would load a
	// mismatched pair.
	assert.NoFileExists(t, certPath)
}

func TestStatusIncludesTailscaleProbe(t *testing.T) {
	srv, err := NewServer(Options{
		StatePath: filepath.Join(t.TempDir(), "state.json"),
		Hub:       NewHub(),
	})
	require.NoError(t, err)

	// Probe content is machine-dependent (CI has no tailscale, dev machines
	// might); the contract is that it is always present so the UI can explain
	// the environment before enabling.
	status := srv.Status()
	require.NotNil(t, status.Tailscale)
}
