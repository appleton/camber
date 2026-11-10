package lsptypes

import (
	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
)

// FileURI is a newtype that works the same as protocol.DocumentURI but
// can only be file. The generated gopls types have string, using our DocumentURI
// type ensures the URIs are parsed
// TODO ideally this type should validate this
type FileURI = protocol.DocumentURI

type FileDelete struct {
	// A file:// URI for the location of the file/folder being deleted.
	URI FileURI `json:"uri"`
}

type DeleteFilesParams struct {
	// An array of all files/folders deleted in this operation.
	Files []FileDelete `json:"files"`
}

// Represents information on a file/folder rename.
//
// @since 3.16.0
//
// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification#fileRename
type FileRename struct {
	// A file:// URI for the original location of the file/folder being renamed.
	OldURI FileURI `json:"oldUri"`
	// A file:// URI for the new location of the file/folder being renamed.
	NewURI FileURI `json:"newUri"`
}

// The parameters sent in notifications/requests for user-initiated creation of
// files.
//
// @since 3.16.0
//
// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification#createFilesParams
type CreateFilesParams struct {
	// An array of all files/folders created in this operation.
	Files []FileCreate `json:"files"`
}

// Represents information on a file/folder create.
//
// @since 3.16.0
//
// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification#fileCreate
type FileCreate struct {
	// A file:// URI for the location of the file/folder being created.
	URI FileURI `json:"uri"`
}

// The parameters sent in notifications/requests for user-initiated renames of
// files.
//
// @since 3.16.0
//
// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification#renameFilesParams
type RenameFilesParams struct {
	// An array of all files/folders renamed in this operation. When a folder is renamed, only
	// the folder will be included, and not its children.
	Files []FileRename `json:"files"`
}
