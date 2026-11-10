package cache

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/samber/lo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	file2 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/pkg/file"
)

func TestUpdateOverlays(t *testing.T) {

	testCases := []struct {
		name             string
		changes          func(dir string) []file2.Modification
		osSetup          func(dir string)
		expected         int
		expectedOverlays func(dir string, prevOverlay map[protocol.DocumentURI]*overlay) map[protocol.DocumentURI]*overlay
	}{
		{
			name: "open file",
			changes: func(dir string) []file2.Modification {
				return []file2.Modification{
					{
						URI:        protocol.URIFromPath(filepath.Join(dir, "test_open.go")),
						Action:     file2.Open,
						LanguageID: "go",
						Text:       []byte("package main"),
					},
				}
			},
			osSetup: func(dir string) {
				requireWrite(t, dir, "test_open.go", "package main")
			},
			expected: 0,
			expectedOverlays: func(dir string, prevOverlay map[protocol.DocumentURI]*overlay) map[protocol.DocumentURI]*overlay {
				testOpenURI := protocol.URIFromPath(filepath.Join(dir, "test_open.go"))
				testOpenFileInfo, err := os.Stat(testOpenURI.Path())
				require.NoError(t, err)
				require.NotNil(t, testOpenFileInfo)

				testURI := protocol.URIFromPath(filepath.Join(dir, "test.go"))

				return map[protocol.DocumentURI]*overlay{
					testURI: prevOverlay[testURI],
					testOpenURI: {
						uri:      testOpenURI,
						content:  []byte("package main"),
						version:  0,
						kind:     file2.Go,
						hash:     file2.HashOf([]byte("package main")),
						saved:    false,
						fileInfo: testOpenFileInfo,
					},
				}
			},
		},
		{
			name: "modify existing overlay",
			changes: func(dir string) []file2.Modification {
				return []file2.Modification{
					{
						URI:    protocol.URIFromPath(filepath.Join(dir, "test.go")),
						Action: file2.Change,
						Text:   []byte("package main\n\nfunc main() {}"),
					},
				}
			},
			expected: 1,
			expectedOverlays: func(dir string, _ map[protocol.DocumentURI]*overlay) map[protocol.DocumentURI]*overlay {
				testURI := protocol.URIFromPath(filepath.Join(dir, "test.go"))
				testFileInfo, err := os.Stat(testURI.Path())
				require.NoError(t, err)
				require.NotNil(t, testFileInfo)

				return map[protocol.DocumentURI]*overlay{
					testURI: {
						uri:      testURI,
						content:  []byte("package main\n\nfunc main() {}"),
						version:  0,
						kind:     file2.Go,
						hash:     file2.HashOf([]byte("package main\n\nfunc main() {}")),
						saved:    false,
						fileInfo: testFileInfo,
					},
				}
			},
		},
		{
			name: "save file",
			changes: func(dir string) []file2.Modification {
				return []file2.Modification{
					{
						URI:    protocol.URIFromPath(filepath.Join(dir, "test.go")),
						Action: file2.Save,
					},
				}
			},
			expected: 1,
			expectedOverlays: func(dir string, _ map[protocol.DocumentURI]*overlay) map[protocol.DocumentURI]*overlay {
				testURI := protocol.URIFromPath(filepath.Join(dir, "test.go"))
				testFileInfo, err := os.Stat(testURI.Path())
				require.NoError(t, err)
				require.NotNil(t, testFileInfo)

				return map[protocol.DocumentURI]*overlay{
					testURI: {
						uri:      testURI,
						content:  []byte("package main"),
						version:  1,
						kind:     file2.Go,
						hash:     file2.HashOf([]byte("package main")),
						saved:    true,
						fileInfo: testFileInfo,
					},
				}
			},
		},
		{
			name: "delete file",
			changes: func(dir string) []file2.Modification {
				return []file2.Modification{
					{
						URI:    protocol.URIFromPath(filepath.Join(dir, "test.go")),
						Action: file2.Delete,
					},
				}
			},
			osSetup: func(dir string) {
				requireDelete(t, dir, "test.go")
			},
			expected: 1,
			expectedOverlays: func(dir string, prevOverlay map[protocol.DocumentURI]*overlay) map[protocol.DocumentURI]*overlay {
				testURI := protocol.URIFromPath(filepath.Join(dir, "test.go"))
				testFileInfo := prevOverlay[testURI].fileInfo

				return map[protocol.DocumentURI]*overlay{
					testURI: {
						uri:      testURI,
						content:  nil,
						version:  0,
						kind:     file2.Go,
						hash:     file2.HashOf(nil),
						saved:    false,
						fileInfo: testFileInfo,
					},
				}
			},
		},
		{
			name: "close file",
			changes: func(dir string) []file2.Modification {
				return []file2.Modification{
					{
						URI:    protocol.URIFromPath(filepath.Join(dir, "test.go")),
						Action: file2.Close,
					},
				}
			},
			expected: 1,
			expectedOverlays: func(dir string, _ map[protocol.DocumentURI]*overlay) map[protocol.DocumentURI]*overlay {
				return map[protocol.DocumentURI]*overlay{} // Overlay should not exist after close
			},
		},
		{
			name: "open unsaved file - file does not exist in disk yet",
			changes: func(dir string) []file2.Modification {
				return []file2.Modification{
					{
						URI:        protocol.URIFromPath(filepath.Join(dir, "test_open.go")),
						Action:     file2.Open,
						LanguageID: "go",
						Text:       []byte("package main"),
					},
				}
			},
			expected: 0,
			expectedOverlays: func(dir string, prevOverlay map[protocol.DocumentURI]*overlay) map[protocol.DocumentURI]*overlay {
				testOpenURI := protocol.URIFromPath(filepath.Join(dir, "test_open.go"))
				testURI := protocol.URIFromPath(filepath.Join(dir, "test.go"))

				return map[protocol.DocumentURI]*overlay{
					testURI: prevOverlay[testURI],
					testOpenURI: {
						uri:      testOpenURI,
						content:  []byte("package main"),
						version:  0,
						kind:     file2.Go,
						hash:     file2.HashOf([]byte("package main")),
						saved:    false,
						fileInfo: nil,
					},
				}
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {

			dir, err := os.MkdirTemp("", "fs-overlay-*")
			require.NoError(t, err)
			defer os.RemoveAll(dir)

			mockDelegate := &mockFileSource{}
			overlayFS := NewOverlayFS(mockDelegate)

			testFilePath := filepath.Join(dir, "test.go")
			testFileURI := protocol.URIFromPath(testFilePath)
			requireWrite(t, dir, "test.go", "package main")
			fileInfo, err := os.Stat(testFilePath)
			require.NoError(t, err)
			require.NotNil(t, fileInfo)
			overlayFS.overlays = map[protocol.DocumentURI]*overlay{
				testFileURI: {
					uri:      testFileURI,
					content:  []byte("package main"),
					version:  1,
					kind:     file2.Go,
					hash:     file2.HashOf([]byte("package main")),
					fileInfo: fileInfo,
				},
			}

			if tc.osSetup != nil {
				tc.osSetup(dir)
			}

			replaced, err := overlayFS.updateOverlays(context.Background(), tc.changes(dir))

			require.NoError(t, err)
			assert.Equal(t, tc.expected, len(replaced))
			assertOverlays(t, tc.expectedOverlays(dir, map[protocol.DocumentURI]*overlay{
				testFileURI: {
					uri:      testFileURI,
					content:  []byte("package main"),
					version:  1,
					kind:     file2.Go,
					hash:     file2.HashOf([]byte("package main")),
					fileInfo: fileInfo,
				},
			}), overlayFS.overlays)
		})
	}
}

func assertOverlays(t *testing.T, expectedOverlays map[protocol.DocumentURI]*overlay, actualOverlays map[protocol.DocumentURI]*overlay) {

	assert.Len(t, lo.Keys(actualOverlays), len(lo.Keys(expectedOverlays)))
	for uri, expected := range expectedOverlays {
		actual, ok := actualOverlays[uri]
		require.True(t, ok)
		assert.EqualValues(t, expected, actual)
	}
}

func TestStatFile(t *testing.T) {
	testCases := []struct {
		name          string
		setup         func(t *testing.T, fs *overlayFS, dir string) protocol.DocumentURI
		expectedError bool
	}{
		{
			name: "stat file with overlay",
			setup: func(t *testing.T, fs *overlayFS, dir string) protocol.DocumentURI {
				testFilePath := filepath.Join(dir, "test.go")
				requireWrite(t, dir, "test.go", "package main")
				testFileURI := protocol.URIFromPath(testFilePath)

				fileInfo, err := os.Stat(testFilePath)
				require.NoError(t, err)
				require.NotNil(t, fileInfo)

				overlay := &overlay{
					uri:      testFileURI,
					content:  []byte("package main"),
					version:  1,
					kind:     file2.Go,
					hash:     file2.HashOf([]byte("package main")),
					saved:    true,
					fileInfo: fileInfo,
				}

				fs.overlays[testFileURI] = overlay

				return testFileURI
			},
		},
		{
			name: "stat file with overlay but no fileInfo",
			setup: func(t *testing.T, fs *overlayFS, dir string) protocol.DocumentURI {
				testFilePath := filepath.Join(dir, "test.go")
				requireWrite(t, dir, "test.go", "package main")
				testFileURI := protocol.URIFromPath(testFilePath)

				overlay := &overlay{
					uri:      testFileURI,
					content:  []byte("package main"),
					version:  1,
					kind:     file2.Go,
					hash:     file2.HashOf([]byte("package main")),
					saved:    false,
					fileInfo: nil,
				}

				fs.overlays[testFileURI] = overlay

				return testFileURI
			},
		},
		{
			name: "stat file without overlay",
			setup: func(t *testing.T, fs *overlayFS, dir string) protocol.DocumentURI {
				testFilePath := filepath.Join(dir, "test.go")
				requireWrite(t, dir, "test.go", "package main")
				testFileURI := protocol.URIFromPath(testFilePath)

				return testFileURI
			},
		},
		{
			name: "stat non-existent file",
			setup: func(t *testing.T, fs *overlayFS, dir string) protocol.DocumentURI {
				testFilePath := filepath.Join(dir, "nonexistent.go")
				testFileURI := protocol.URIFromPath(testFilePath)

				return testFileURI
			},
			expectedError: true,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			dir, err := os.MkdirTemp("", "fs-overlay-stat-*")
			require.NoError(t, err)
			defer os.RemoveAll(dir)

			// Create overlayFS with mock delegate
			mockDelegate := &mockFileSource{}
			overlayFS := NewOverlayFS(mockDelegate)

			// Set up the test case
			testFileURI := tc.setup(t, overlayFS, dir)

			// Test StatFile
			info, err := overlayFS.StatFile(context.Background(), testFileURI)

			if tc.expectedError {
				assert.Error(t, err)
				assert.Nil(t, info)
			} else {
				require.NoError(t, err)
				assert.NotNil(t, info)
			}
		})
	}
}

// mockFileSource implements file.Source for testing
type mockFileSource struct{}

func (m *mockFileSource) ReadFile(ctx context.Context, uri protocol.DocumentURI) (file2.Handle, error) {
	return &mockFileHandle{uri: uri}, nil
}

func (m *mockFileSource) StatFile(ctx context.Context, uri protocol.DocumentURI) (os.FileInfo, error) {
	return nil, nil
}

// mockFileHandle implements file.Handle for testing
type mockFileHandle struct {
	uri protocol.DocumentURI
}

func (m *mockFileHandle) URI() protocol.DocumentURI {
	return m.uri
}

func (m *mockFileHandle) Identity() file2.Identity {
	return file2.Identity{URI: m.uri}
}

func (m *mockFileHandle) SameContentsOnDisk() bool {
	return false
}

func (m *mockFileHandle) Version() int32 {
	return 0
}

func (m *mockFileHandle) Content() ([]byte, error) {
	return []byte("package main"), nil
}

func (m *mockFileHandle) Kind() file2.Kind {
	return file2.Go
}

func requireWrite(t *testing.T, dir string, fn string, content string) {
	t.Helper()
	err := os.WriteFile(filepath.Join(dir, fn), []byte(content), 0644)
	require.NoError(t, err)
}

func requireDelete(t *testing.T, dir string, fn string) {
	t.Helper()
	err := os.Remove(filepath.Join(dir, fn))
	require.NoError(t, err)
}
