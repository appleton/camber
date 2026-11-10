// Copyright 2025 The Go MCP SDK Authors. All rights reserved.
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file.

// This file implements Protected Resource Metadata.
// See https://www.rfc-editor.org/rfc/rfc9728.html.

package oauthex

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
)

const defaultProtectedResourceMetadataURI = "/.well-known/oauth-protected-resource"

// GetProtectedResourceMetadataFromID issues a GET request to retrieve protected resource
// metadata from a resource server by its ID.
// The resource ID is an HTTPS URL, typically with a host:port and possibly a path.
// For example:
//
//	https://example.com/server
//
// This function, following the spec (§3), inserts the default well-known path into the
// URL. In our example, the result would be
//
//	https://example.com/.well-known/oauth-protected-resource/server
//
// It then retrieves the metadata at that location using the given client (or the
// default client if nil) and validates its resource field against resourceID.
func GetProtectedResourceMetadataFromID(ctx context.Context, resourceID string, c *http.Client) (_ *ProtectedResourceMetadata, err error) {
	defer Wrapf(&err, "GetProtectedResourceMetadataFromID(%q)", resourceID)

	u, err := url.Parse(resourceID)
	if err != nil {
		return nil, err
	}
	// Insert well-known URI into URL.
	u.Path = path.Join(defaultProtectedResourceMetadataURI, u.Path)
	return getPRM(ctx, u.String(), c, resourceID)
}

// getPRM makes a GET request to the given URL, and validates the response.
// As part of the validation, it compares the returned resource field to wantResource.
func getPRM(ctx context.Context, purl string, c *http.Client, wantResource string) (*ProtectedResourceMetadata, error) {
	if !strings.HasPrefix(strings.ToUpper(purl), "HTTPS://") {
		return nil, fmt.Errorf("resource URL %q does not use HTTPS", purl)
	}
	prm, err := getJSON[ProtectedResourceMetadata](ctx, c, purl, 1<<20)
	if err != nil {
		return nil, err
	}
	// Validate the Resource field (see RFC 9728, section 3.3).
	if prm.Resource != wantResource {
		return nil, fmt.Errorf("got metadata resource %q, want %q", prm.Resource, wantResource)
	}
	// Validate the authorization server URLs to prevent XSS attacks (see #526).
	for _, u := range prm.AuthorizationServers {
		if err := checkURLScheme(u); err != nil {
			return nil, err
		}
	}
	return prm, nil
}

// Wrapf wraps *errp with the given formatted message if *errp is not nil.
func Wrapf(errp *error, format string, args ...any) {
	if *errp != nil {
		*errp = fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), *errp)
	}
}
