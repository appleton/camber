package acpproxy

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/bzip2"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/acpregistry"
)

func PrepareRegistryBinary(ctx context.Context, serverName string, binaries map[string]AgentServerBinaryDistribution) (string, []string, map[string]string, error) {
	target, err := acpregistry.BinaryTarget(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", nil, nil, err
	}
	binary, ok := binaries[target]
	if !ok {
		return "", nil, nil, fmt.Errorf("ACP agent server %q has no binary for %s", serverName, target)
	}
	if binary.Archive == "" || binary.Cmd == "" {
		return "", nil, nil, fmt.Errorf("ACP agent server %q binary for %s is incomplete", serverName, target)
	}

	root, err := acpregistry.BinaryInstallRoot(serverName, binary.Archive, binary.SHA256)
	if err != nil {
		return "", nil, nil, err
	}
	if _, err := os.Stat(root); err != nil {
		if !os.IsNotExist(err) {
			return "", nil, nil, err
		}
		if err := downloadAndExtractRegistryBinary(ctx, binary.Archive, binary.SHA256, root); err != nil {
			return "", nil, nil, &AgentInstallError{AgentServer: serverName, Err: err}
		}
	}

	command := filepath.Clean(filepath.Join(root, binary.Cmd))
	if !strings.HasPrefix(command, root+string(os.PathSeparator)) && command != root {
		return "", nil, nil, fmt.Errorf("ACP agent server %q binary command escapes install directory", serverName)
	}
	if _, err := os.Stat(command); err != nil {
		return "", nil, nil, fmt.Errorf("ACP agent server %q binary command unavailable: %w", serverName, err)
	}
	return command, append([]string{}, binary.Args...), binary.Env, nil
}

func downloadAndExtractRegistryBinary(ctx context.Context, archiveURL, expectedSHA256, root string) error {
	expectedChecksum, err := acpregistry.DecodeSHA256(expectedSHA256)
	if err != nil {
		return err
	}
	if err := checkRegistryURLString(archiveURL); err != nil {
		return err
	}
	if expectedChecksum == nil {
		// The registry is unsigned, so without a checksum nothing ties these
		// bytes to what the publisher intended. Roughly half the registry's
		// binary agents publish none, so this cannot be a hard failure without
		// breaking their installs.
		slog.Warn("acpproxy: ACP registry published no SHA-256 for binary; downloading unverified",
			"archive", archiveURL)
	}
	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		return err
	}
	archive, err := os.CreateTemp(filepath.Dir(root), ".download-*")
	if err != nil {
		return err
	}
	archivePath := archive.Name()
	defer func() {
		_ = archive.Close()
		_ = os.Remove(archivePath)
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, archiveURL, nil)
	if err != nil {
		return err
	}
	resp, err := registryHTTPClient(registryDownloadTimeout).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("downloading ACP binary failed: HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > registryArchiveMaxBytes {
		return fmt.Errorf("ACP binary archive too large: %d bytes exceeds limit of %d",
			resp.ContentLength, int64(registryArchiveMaxBytes))
	}

	hasher := sha256.New()
	// Cap the body independently of Content-Length, which a hostile server can
	// understate or omit.
	written, err := io.Copy(io.MultiWriter(archive, hasher), io.LimitReader(resp.Body, registryArchiveMaxBytes+1))
	if err != nil {
		return err
	}
	if written > registryArchiveMaxBytes {
		return fmt.Errorf("ACP binary archive exceeds limit of %d bytes", int64(registryArchiveMaxBytes))
	}
	actualChecksum := hasher.Sum(nil)
	if expectedChecksum != nil && !bytes.Equal(actualChecksum, expectedChecksum) {
		return fmt.Errorf(
			"ACP binary checksum mismatch: expected %s, got %s",
			hex.EncodeToString(expectedChecksum),
			hex.EncodeToString(actualChecksum),
		)
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return err
	}

	tmp := root + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(tmp)
		}
	}()

	switch {
	case strings.HasSuffix(archiveURL, ".zip"):
		if err := extractZip(archive, tmp); err != nil {
			return err
		}
	case strings.HasSuffix(archiveURL, ".tar.gz"), strings.HasSuffix(archiveURL, ".tgz"):
		if err := extractTarGz(archive, tmp); err != nil {
			return err
		}
	case strings.HasSuffix(archiveURL, ".tar.bz2"), strings.HasSuffix(archiveURL, ".tbz2"):
		if err := extractTarBz2(archive, tmp); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported ACP binary archive type: %s", archiveURL)
	}

	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, root); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func extractTarGz(reader io.Reader, dest string) error {
	gzipReader, err := gzip.NewReader(reader)
	if err != nil {
		return err
	}
	defer gzipReader.Close()

	return extractTar(gzipReader, dest)
}

func extractTarBz2(reader io.Reader, dest string) error {
	return extractTar(bzip2.NewReader(reader), dest)
}

func extractTar(reader io.Reader, dest string) error {
	budget := newExtractBudget()
	tarReader := tar.NewReader(reader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		path, err := safeExtractPath(dest, header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, os.FileMode(header.Mode)); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := budget.addFile(); err != nil {
				return err
			}
			if err := budget.declare(header.Size); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode))
			if err != nil {
				return err
			}
			if err := budget.copy(out, tarReader); err != nil {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		}
	}
}

// extractBudget bounds how much an archive may expand to. A gzip or bzip2
// stream that is small on the wire can unpack to an unbounded amount of data,
// so the archive size limit alone does not bound disk use.
type extractBudget struct {
	remainingBytes int64
	remainingFiles int
}

func newExtractBudget() *extractBudget {
	return &extractBudget{
		remainingBytes: registryExtractedMaxBytes,
		remainingFiles: registryExtractedMaxFiles,
	}
}

func (b *extractBudget) addFile() error {
	if b.remainingFiles <= 0 {
		return fmt.Errorf("ACP binary archive contains more than %d files", registryExtractedMaxFiles)
	}
	b.remainingFiles--
	return nil
}

// declare rejects an entry whose header claims it expands past the budget,
// before any of it is written.
func (b *extractBudget) declare(size int64) error {
	if size > b.remainingBytes {
		return errExtractTooLarge
	}
	return nil
}

func (b *extractBudget) copy(dst io.Writer, src io.Reader) error {
	// Wrap the destination rather than limiting the source: a limited reader
	// would happily write the whole budget to disk before the overrun showed
	// up, so an oversized entry would still cost the full limit in writes.
	counter := &budgetWriter{dst: dst, remaining: b.remainingBytes}
	written, err := io.Copy(counter, src)
	b.remainingBytes -= written
	if err != nil {
		return err
	}
	return nil
}

var errExtractTooLarge = fmt.Errorf(
	"ACP binary archive expands beyond limit of %d bytes", int64(registryExtractedMaxBytes))

// budgetWriter fails the write as soon as the budget is exceeded, so io.Copy
// stops on the first oversized chunk instead of filling the disk first.
type budgetWriter struct {
	dst       io.Writer
	remaining int64
}

func (w *budgetWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errExtractTooLarge
	}
	n, err := w.dst.Write(p)
	w.remaining -= int64(n)
	return n, err
}

func extractZip(reader io.Reader, dest string) error {
	tmp, err := os.CreateTemp("", "camber-acp-binary-*.zip")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := io.Copy(tmp, reader); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	zipReader, err := zip.OpenReader(tmpPath)
	if err != nil {
		return err
	}
	defer zipReader.Close()

	budget := newExtractBudget()
	for _, file := range zipReader.File {
		path, err := safeExtractPath(dest, file.Name)
		if err != nil {
			return err
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(path, file.Mode()); err != nil {
				return err
			}
			continue
		}
		if err := budget.addFile(); err != nil {
			return err
		}
		if file.UncompressedSize64 > uint64(budget.remainingBytes) {
			return errExtractTooLarge
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		in, err := file.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, file.Mode())
		if err != nil {
			_ = in.Close()
			return err
		}
		if err := budget.copy(out, in); err != nil {
			_ = in.Close()
			_ = out.Close()
			return err
		}
		if err := in.Close(); err != nil {
			_ = out.Close()
			return err
		}
		if err := out.Close(); err != nil {
			return err
		}
	}
	return nil
}

func safeExtractPath(dest, name string) (string, error) {
	path := filepath.Clean(filepath.Join(dest, name))
	if path != dest && !strings.HasPrefix(path, dest+string(os.PathSeparator)) {
		return "", fmt.Errorf("archive entry escapes install directory: %s", name)
	}
	return path, nil
}

func mergeStringMaps(left, right map[string]string) map[string]string {
	if len(left) == 0 {
		return right
	}
	if len(right) == 0 {
		return left
	}
	merged := make(map[string]string, len(left)+len(right))
	for key, value := range left {
		merged[key] = value
	}
	for key, value := range right {
		merged[key] = value
	}
	return merged
}
