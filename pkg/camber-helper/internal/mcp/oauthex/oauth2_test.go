// Copyright 2025 The Go MCP SDK Authors. All rights reserved.
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file.

package oauthex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetProtectedResourceMetadataFromID(t *testing.T) {
	handler := http.NewServeMux()
	server := httptest.NewTLSServer(handler)
	defer server.Close()

	handler.HandleFunc("GET /.well-known/oauth-protected-resource", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(&ProtectedResourceMetadata{Resource: server.URL}); err != nil {
			t.Error(err)
		}
	})

	metadata, err := GetProtectedResourceMetadataFromID(context.Background(), server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if metadata == nil || metadata.Resource != server.URL {
		t.Fatalf("metadata = %#v, want resource %q", metadata, server.URL)
	}
}
