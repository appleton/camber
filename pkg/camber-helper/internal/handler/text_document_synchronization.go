package handler

import (
	"context"
	"fmt"
	"sync"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/gopls/pkg/protocol"
	"github.com/appleton/camber/pkg/camber-helper/internal/events"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/diff"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/jsonrpc2"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/pkg/file"
)

func (h *CamberHandler) TextDocumentDidChange(ctx context.Context, params *protocol.DidChangeTextDocumentParams, lspCtx *glsp.Context) (any, error) {
	uri := params.TextDocument.URI
	unlock := h.lockDoc(string(uri))
	defer unlock()

	mappedChanges, err := mapChanges(params.ContentChanges)
	if err != nil {
		return nil, err
	}

	text, err := h.changedText(ctx, uri, mappedChanges)
	if err != nil {
		return nil, err
	}
	mod := file.Modification{
		URI:     uri,
		Action:  file.Change,
		Version: params.TextDocument.Version,
		Text:    text,
	}

	old, err := h.ReadFile(ctx, uri)
	if err != nil {
		return nil, err
	}

	h.OnTextDocumentDidChange(ctx, events.TextDocumentDidChange{
		NewContent: text,
		OldContent: old,
		URI:        uri,
	}, lspCtx.Call)

	err = h.cachedFS.ApplyModifications(ctx, []file.Modification{mod})
	if err != nil {
		return nil, err
	}

	return nil, nil
}

func (h *CamberHandler) TextDocumentDidOpen(ctx context.Context, params *protocol.DidOpenTextDocumentParams, c *glsp.Context) (any, error) {
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.DidOpen(params.TextDocument.URI)
	}

	return nil, h.cachedFS.ApplyModifications(c.Context, []file.Modification{{
		URI:        params.TextDocument.URI,
		Action:     file.Open,
		Version:    params.TextDocument.Version,
		Text:       []byte(params.TextDocument.Text),
		LanguageID: params.TextDocument.LanguageID,
	}})
}

func (h *CamberHandler) TextDocumentDidClose(ctx context.Context, params *protocol.DidCloseTextDocumentParams, c *glsp.Context) (any, error) {
	if h.fileSearchHandler != nil {
		h.fileSearchHandler.DidClose(params.TextDocument.URI)
	}

	// this removes the file from FSOverlay cache, and prompts it to check directly from disk if readFile is called.
	return nil, h.cachedFS.ApplyModifications(c.Context, []file.Modification{{
		URI:    params.TextDocument.URI,
		Action: file.Close,
	}})
}

func (h *CamberHandler) changedText(ctx context.Context, uri protocol.DocumentURI, changes []protocol.TextDocumentContentChangeEvent) ([]byte, error) {
	if len(changes) == 0 {
		return nil, fmt.Errorf("%w: no content changes provided", jsonrpc2.ErrInternal)
	}

	// Check if the client sent the full content of the file.
	// We accept a full content change even if the server expected incremental changes.
	if len(changes) == 1 && changes[0].Range == nil && changes[0].RangeLength == 0 {
		return []byte(changes[0].Text), nil
	}
	return h.applyIncrementalChanges(ctx, uri, changes)
}

func (h *CamberHandler) applyIncrementalChanges(ctx context.Context, uri protocol.DocumentURI, changes []protocol.TextDocumentContentChangeEvent) ([]byte, error) {
	fh, err := h.cachedFS.ReadFile(ctx, uri)
	if err != nil {
		return nil, err
	}
	content, err := fh.Content()
	if err != nil {
		return nil, fmt.Errorf("%w: file not found (%v)", jsonrpc2.ErrInternal, err)
	}
	for _, change := range changes {
		m := protocol.NewMapper(uri, content)
		start, end, err := m.RangeOffsets(*change.Range)
		if err != nil {
			return nil, fmt.Errorf("failed to get range offsets: %w: %w", err, jsonrpc2.ErrInternal)
		}
		edit := diff.Edit{
			Start: start,
			End:   end,
			New:   change.Text,
		}
		content, err = diff.ApplyBytes(content, []diff.Edit{edit})
		if err != nil {
			return nil, fmt.Errorf("failed to apply change: %w: %w", err, jsonrpc2.ErrInternal)
		}
	}
	return content, nil
}

func (h *CamberHandler) lockDoc(uri string) func() {
	h.mx.Lock()
	if _, ok := h.docLocks[uri]; !ok {
		h.docLocks[uri] = &sync.Mutex{}
	}
	mx := h.docLocks[uri]
	h.mx.Unlock()

	mx.Lock()

	return func() {
		h.mx.Lock()
		dmx, ok := h.docLocks[uri]
		h.mx.Unlock()
		if ok {
			dmx.Unlock()
		}
	}
}

func mapChanges(changes []protocol.TextDocumentContentChangeEvent) ([]protocol.TextDocumentContentChangeEvent, error) {
	var out []protocol.TextDocumentContentChangeEvent
	for _, change := range changes {
		// indicates a whole file change
		if change.Range == nil {
			out = append(out, protocol.TextDocumentContentChangeEvent{
				Text: change.Text,
			})
			continue
		}
		out = append(out, protocol.TextDocumentContentChangeEvent{
			Text: change.Text,
			Range: &protocol.Range{
				Start: protocol.Position{
					Line:      change.Range.Start.Line,
					Character: change.Range.Start.Character,
				},
				End: protocol.Position{
					Line:      change.Range.End.Line,
					Character: change.Range.End.Character,
				},
			},
		})
	}
	return out, nil
}
