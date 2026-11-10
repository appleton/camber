// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package jsonrpc2

import (
	"encoding/json"
	"fmt"

	srcjsonrpc2 "github.com/sourcegraph/jsonrpc2"
)

// this file contains the go forms of the wire specification
// see http://www.jsonrpc.org/specification for details

var (
	CodeParseError     int64 = srcjsonrpc2.CodeParseError
	CodeInvalidRequest int64 = srcjsonrpc2.CodeInvalidRequest
	CodeMethodNotFound int64 = srcjsonrpc2.CodeMethodNotFound
	CodeInvalidParams  int64 = srcjsonrpc2.CodeInvalidParams
	CodeInternalError  int64 = srcjsonrpc2.CodeInternalError

	CodeServerOverloaded int64 = -32000
	CodeUnknown          int64 = -32001
	CodeServerClosing    int64 = -32002
	CodeClientClosing    int64 = -32003
)

var (
	// ErrParse is used when invalid JSON was received by the server.
	ErrParse = NewError(CodeParseError, "JSON RPC parse error")
	// ErrInvalidRequest is used when the JSON sent is not a valid Request object.
	ErrInvalidRequest = NewError(CodeInvalidRequest, "JSON RPC invalid request")
	// ErrMethodNotFound should be returned by the handler when the method does
	// not exist / is not available.
	ErrMethodNotFound = NewError(CodeMethodNotFound, "JSON RPC method not found")
	// ErrInvalidParams should be returned by the handler when method
	// parameter(s) were invalid.
	ErrInvalidParams = NewError(CodeInvalidParams, "JSON RPC invalid params")
	// ErrInternal indicates a failure to process a call correctly
	ErrInternal = NewError(CodeInternalError, "JSON RPC internal error")

	// The following errors are not part of the json specification, but
	// compliant extensions specific to this implementation.

	// ErrServerOverloaded is returned when a message was refused due to a
	// server being temporarily unable to accept any new messages.
	ErrServerOverloaded = NewError(CodeServerOverloaded, "JSON RPC overloaded")
	// ErrUnknown should be used for all non coded errors.
	ErrUnknown = NewError(CodeUnknown, "JSON RPC unknown error")
	// ErrServerClosing is returned for calls that arrive while the server is closing.
	ErrServerClosing = NewError(CodeServerClosing, "JSON RPC server is closing")
	// ErrClientClosing is a dummy error returned for calls initiated while the client is closing.
	ErrClientClosing = NewError(CodeClientClosing, "JSON RPC client is closing")
)

// wireRequest is sent to a server to represent a Call or Notify operation.
type wireRequest struct {
	// VersionTag is always encoded as the string "2.0"
	VersionTag wireVersionTag `json:"jsonrpc"`
	// Method is a string containing the method name to invoke.
	Method string `json:"method"`
	// Params is either a struct or an array with the parameters of the method.
	Params *json.RawMessage `json:"params,omitempty"`
	// The id of this request, used to tie the Response back to the request.
	// Will be either a string or a number. If not set, the Request is a notify,
	// and no response is possible.
	ID *ID `json:"id,omitempty"`
}

// WireResponse is a reply to a Request.
// It will always have the ID field set to tie it back to a request, and will
// have either the Result or Error fields set depending on whether it is a
// success or failure response.
type wireResponse struct {
	// VersionTag is always encoded as the string "2.0"
	VersionTag wireVersionTag `json:"jsonrpc"`
	// Result is the response value, and is required on success.
	Result *json.RawMessage `json:"result,omitempty"`
	// Error is a structured error response if the call fails.
	Error *WireError `json:"error,omitempty"`
	// ID must be set and is the identifier of the Request this is a response to.
	ID *ID `json:"id,omitempty"`
}

// wireCombined has all the fields of both Request and Response.
// We can decode this and then work out which it is.
type wireCombined struct {
	VersionTag wireVersionTag   `json:"jsonrpc"`
	ID         *ID              `json:"id,omitempty"`
	Method     string           `json:"method"`
	Params     *json.RawMessage `json:"params,omitempty"`
	Result     *json.RawMessage `json:"result,omitempty"`
	Error      *WireError       `json:"error,omitempty"`
}

// WireError is an alias for the sourcegraph jsonrpc2.Error type.
type WireError = srcjsonrpc2.Error

// wireVersionTag is a special 0 sized struct that encodes as the jsonrpc version
// tag.
// It will fail during decode if it is not the correct version tag in the
// stream.
type wireVersionTag struct{}

// ID is a Request identifier.
type ID struct {
	name   string
	number int64
}

func NewError(code int64, message string) error {
	return &WireError{
		Code:    code,
		Message: message,
	}
}

func (wireVersionTag) MarshalJSON() ([]byte, error) {
	return json.Marshal("2.0")
}

func (wireVersionTag) UnmarshalJSON(data []byte) error {
	version := ""
	if err := json.Unmarshal(data, &version); err != nil {
		return err
	}
	if version != "2.0" {
		return fmt.Errorf("invalid RPC version %v", version)
	}
	return nil
}

// NewIntID returns a new numerical request ID.
func NewIntID(v int64) ID { return ID{number: v} }

// NewStringID returns a new string request ID.
func NewStringID(v string) ID { return ID{name: v} }

// Format writes the ID to the formatter.
// If the rune is q the representation is non ambiguous,
// string forms are quoted, number forms are preceded by a #
func (id ID) Format(f fmt.State, r rune) {
	numF, strF := `%d`, `%s`
	if r == 'q' {
		numF, strF = `#%d`, `%q`
	}
	switch {
	case id.name != "":
		fmt.Fprintf(f, strF, id.name)
	default:
		fmt.Fprintf(f, numF, id.number)
	}
}

func (id *ID) MarshalJSON() ([]byte, error) {
	if id.name != "" {
		return json.Marshal(id.name)
	}
	return json.Marshal(id.number)
}

func (id *ID) UnmarshalJSON(data []byte) error {
	*id = ID{}
	if err := json.Unmarshal(data, &id.number); err == nil {
		return nil
	}
	return json.Unmarshal(data, &id.name)
}
