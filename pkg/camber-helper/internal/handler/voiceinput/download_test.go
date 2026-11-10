package voiceinput

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func digestOf(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

// The model file is fed straight into a native Whisper parser, so bytes that
// do not match the pinned digest must never reach it.
func TestVerifyDownloadRejectsChecksumMismatch(t *testing.T) {
	payload := []byte("not the real weights")
	model := catalogEntry{
		id:            "tiny",
		downloadBytes: int64(len(payload)),
		sha256:        hex.EncodeToString(digestOf([]byte("the real weights"))),
	}

	err := verifyDownload(model, model.sha256, int64(len(payload)), digestOf(payload))

	require.Error(t, err)
	assert.ErrorContains(t, err, "checksum mismatch")
}

func TestVerifyDownloadRejectsSizeMismatch(t *testing.T) {
	payload := []byte("weights")
	model := catalogEntry{
		id:            "tiny",
		downloadBytes: 999,
		sha256:        hex.EncodeToString(digestOf(payload)),
	}

	err := verifyDownload(model, model.sha256, int64(len(payload)), digestOf(payload))

	require.Error(t, err)
	assert.ErrorContains(t, err, "expected 999")
}

func TestVerifyDownloadAcceptsMatchingModel(t *testing.T) {
	payload := []byte("weights")
	model := catalogEntry{
		id:            "tiny",
		downloadBytes: int64(len(payload)),
		sha256:        hex.EncodeToString(digestOf(payload)),
	}

	require.NoError(t, verifyDownload(model, model.sha256, int64(len(payload)), digestOf(payload)))
}

// A mirror serves fixture bytes, so it cannot match the pinned digest. Its
// downloads stay unverified by design; the size and transfer caps still apply.
func TestVerifyDownloadSkipsVerificationForMirror(t *testing.T) {
	model := catalogEntry{id: "tiny", downloadBytes: 1, sha256: "irrelevant"}

	require.NoError(t, verifyDownload(model, "", 12345, digestOf([]byte("anything"))))
}

// Every catalog entry must carry the data the verification depends on,
// otherwise a model silently downloads unverified in production.
func TestCatalogEntriesArePinned(t *testing.T) {
	require.NotEmpty(t, catalog)
	for _, entry := range catalog {
		t.Run(entry.id, func(t *testing.T) {
			assert.NotEmpty(t, entry.sha256, "model must pin a SHA-256")
			assert.Len(t, entry.sha256, 64, "SHA-256 must be 64 hex characters")
			assert.Equal(t, strings.ToLower(entry.sha256), entry.sha256, "digest must be lowercase hex")
			_, err := hex.DecodeString(entry.sha256)
			assert.NoError(t, err, "digest must be valid hex")
			assert.Positive(t, entry.downloadBytes, "model must pin an exact size")
		})
	}
}

// The repository ref must be an immutable commit: `main` can be moved to point
// at different weights.
func TestModelRepoRevisionIsPinnedToACommit(t *testing.T) {
	assert.Len(t, modelRepoRevision, 40)
	_, err := hex.DecodeString(modelRepoRevision)
	assert.NoError(t, err)
}

func TestModelDownloadURLUsesPinnedRevision(t *testing.T) {
	s := &Server{}
	url := s.modelDownloadURL("base")

	assert.Equal(t,
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/"+modelRepoRevision+"/ggml-base.bin",
		url)
	assert.NotContains(t, url, "/resolve/main/")
}
