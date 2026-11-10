package remoteaccess

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"time"
)

const (
	// caValidity is the lifetime of the local CA. Long-lived on purpose: a
	// phone installs and trusts it exactly once.
	caValidity = 10 * 365 * 24 * time.Hour
	// leafValidity stays under Apple's 825-day limit for TLS server
	// certificates, which iOS enforces even for chains anchored at a
	// user-installed root. The leaf rotates transparently; the CA does not.
	leafValidity = 730 * 24 * time.Hour
)

// loadOrCreateCert returns a TLS server certificate whose SANs cover every
// host in `hosts` (IPs and DNS names), signed by this desktop's persistent
// local CA (mkcert-style), plus the CA certificate PEM a phone can install
// and trust. Everything persists next to the state file: the CA is stable so
// a phone only has to trust it once; the leaf regenerates when it is missing,
// expiring, not signed by the current CA, or does not cover a required host
// (e.g. the LAN IP changed).
func loadOrCreateCert(dir string, hosts []string) (certPEM, keyPEM, caPEM []byte, err error) {
	caPEM, caKeyPEM, err := loadOrCreateCA(dir)
	if err != nil {
		return nil, nil, nil, err
	}
	caCert, caKey, err := parseCA(caPEM, caKeyPEM)
	if err != nil {
		return nil, nil, nil, err
	}

	certPath := filepath.Join(dir, "remote-access-cert.pem")
	keyPath := filepath.Join(dir, "remote-access-key.pem")

	if c, k, ok := loadUsableCert(certPath, keyPath, hosts, caCert); ok {
		return c, k, caPEM, nil
	}

	certPEM, keyPEM, err = issueLeaf(caCert, caKey, hosts)
	if err != nil {
		return nil, nil, nil, err
	}
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		return nil, nil, nil, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, nil, nil, err
	}
	return certPEM, keyPEM, caPEM, nil
}

// loadOrCreateCA loads the persisted local CA, generating it on first use.
func loadOrCreateCA(dir string) (caPEM, caKeyPEM []byte, err error) {
	caPath := filepath.Join(dir, "remote-access-ca.pem")
	caKeyPath := filepath.Join(dir, "remote-access-ca-key.pem")

	caPEM, errCert := os.ReadFile(caPath)
	caKeyPEM, errKey := os.ReadFile(caKeyPath)
	if errCert == nil && errKey == nil {
		if cert, _, err := parseCAOnly(caPEM); err == nil &&
			time.Now().Before(cert.NotAfter.Add(-30*24*time.Hour)) {
			return caPEM, caKeyPEM, nil
		}
	}

	caPEM, caKeyPEM, err = generateCA()
	if err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(caPath, caPEM, 0o600); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(caKeyPath, caKeyPEM, 0o600); err != nil {
		return nil, nil, err
	}
	return caPEM, caKeyPEM, nil
}

func generateCA() (caPEM, caKeyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	// The hostname in the CN identifies the CA in the phone's certificate
	// trust settings ("which of these did I install?").
	cn := "Camber Remote CA"
	if name, err := os.Hostname(); err == nil && name != "" {
		cn = fmt.Sprintf("Camber Remote CA (%s)", name)
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: cn, Organization: []string{"Camber Remote"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(caValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	return encodePEM(der, key)
}

func issueLeaf(caCert *x509.Certificate, caKey *ecdsa.PrivateKey, hosts []string) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Camber Remote", Organization: []string{"Camber Remote"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(leafValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, host := range hosts {
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, host)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, caCert, &key.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	return encodePEM(der, key)
}

func encodePEM(certDER []byte, key *ecdsa.PrivateKey) (certPEM, keyPEM []byte, err error) {
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if certPEM == nil || keyPEM == nil {
		return nil, nil, fmt.Errorf("remoteaccess: failed to PEM-encode certificate")
	}
	return certPEM, keyPEM, nil
}

func parseCAOnly(caPEM []byte) (*x509.Certificate, []byte, error) {
	block, _ := pem.Decode(caPEM)
	if block == nil {
		return nil, nil, fmt.Errorf("remoteaccess: invalid CA PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, err
	}
	return cert, block.Bytes, nil
}

func parseCA(caPEM, caKeyPEM []byte) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	cert, _, err := parseCAOnly(caPEM)
	if err != nil {
		return nil, nil, err
	}
	block, _ := pem.Decode(caKeyPEM)
	if block == nil {
		return nil, nil, fmt.Errorf("remoteaccess: invalid CA key PEM")
	}
	keyAny, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, nil, err
	}
	key, ok := keyAny.(*ecdsa.PrivateKey)
	if !ok {
		return nil, nil, fmt.Errorf("remoteaccess: unexpected CA key type %T", keyAny)
	}
	return cert, key, nil
}

// loadUsableCert accepts a persisted leaf only if it is valid for another day,
// covers every required host, and is signed by the current CA (a leaf from an
// older scheme, e.g. the previous self-signed one, is regenerated).
func loadUsableCert(certPath, keyPath string, hosts []string, caCert *x509.Certificate) (certPEM, keyPEM []byte, ok bool) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, false
	}
	keyPEM, err = os.ReadFile(keyPath)
	if err != nil {
		return nil, nil, false
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return nil, nil, false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, false
	}
	if time.Now().After(cert.NotAfter.Add(-24 * time.Hour)) {
		return nil, nil, false
	}
	if err := cert.CheckSignatureFrom(caCert); err != nil {
		return nil, nil, false
	}
	for _, host := range hosts {
		if !certCoversHost(cert, host) {
			return nil, nil, false
		}
	}
	return certPEM, keyPEM, true
}

func certCoversHost(cert *x509.Certificate, host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		for _, certIP := range cert.IPAddresses {
			if certIP.Equal(ip) {
				return true
			}
		}
		return false
	}
	for _, name := range cert.DNSNames {
		if name == host {
			return true
		}
	}
	return false
}

// tlsHosts collects the SANs the certificate should cover for a given bind.
func tlsHosts(bind string) []string {
	hosts := []string{"localhost", "127.0.0.1", "::1"}
	if name, err := os.Hostname(); err == nil && name != "" {
		hosts = append(hosts, name)
	}
	addrs, _ := net.InterfaceAddrs()
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok || ipNet.IP.IsLoopback() {
			continue
		}
		if bind == BindTailscale {
			v4, ok := netip.AddrFromSlice(ipNet.IP.To4())
			if !ok || !tailscaleCGNAT.Contains(v4) {
				continue
			}
		}
		hosts = append(hosts, ipNet.IP.String())
	}
	return hosts
}
