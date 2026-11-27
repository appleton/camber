package acpproxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	acpsdk "github.com/coder/acp-go-sdk"
)

// The pinned SDK predates standard compaction. Adapt those frames at the SDK
// boundary so they still pass through its ordered notification queue and load
// barrier. The helper forwards the original ACP method and payload to clients.
const compactionTransportMethod = "_camber/standard_compaction"

type standardCompactionNotification struct {
	SessionID string `json:"sessionId"`
	Update    struct {
		Kind    string                `json:"sessionUpdate"`
		ID      string                `json:"compactionId"`
		Status  string                `json:"status"`
		Content *acpsdk.ContentBlock  `json:"content"`
		Summary []acpsdk.ContentBlock `json:"summary"`
		Error   *string               `json:"error"`
	} `json:"update"`
}

type compactionInitializeWriter struct{ io.Writer }

func (w compactionInitializeWriter) Write(frame []byte) (int, error) {
	if !bytes.Contains(frame, []byte(`"initialize"`)) {
		return w.Writer.Write(frame)
	}
	// The SDK writes a complete, compact JSON-RPC frame in one Write. Decode
	// only initialize requests and retain all existing capability fields.
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(frame, &envelope); err != nil || string(envelope["method"]) != `"initialize"` {
		return w.Writer.Write(frame)
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(envelope["params"], &params); err != nil {
		return 0, err
	}
	var capabilities map[string]json.RawMessage
	if err := json.Unmarshal(params["clientCapabilities"], &capabilities); err != nil {
		return 0, err
	}
	capabilities["session"] = json.RawMessage(`{"compaction":{}}`)
	params["clientCapabilities"], _ = json.Marshal(capabilities)
	envelope["params"], _ = json.Marshal(params)
	updated, err := json.Marshal(envelope)
	if err != nil {
		return 0, err
	}
	if _, err := w.Writer.Write(append(updated, '\n')); err != nil {
		return 0, err
	}
	return len(frame), nil
}

type compactionNotificationReader struct {
	input   *bufio.Reader
	pending bytes.Reader
	err     error
}

func (r *compactionNotificationReader) Read(buf []byte) (int, error) {
	if r.pending.Len() == 0 {
		if r.err != nil {
			return 0, r.err
		}
		frame, err := r.input.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			prefix := bytes.Clone(frame)
			frame, err = r.input.ReadBytes('\n')
			frame = append(prefix, frame...)
		}
		r.err = err
		if len(frame) == 0 {
			return 0, err
		}
		r.pending.Reset(rewriteCompactionNotification(frame))
	}
	return r.pending.Read(buf)
}

func rewriteCompactionNotification(frame []byte) []byte {
	if !bytes.Contains(frame, []byte(`"compaction_update"`)) &&
		!bytes.Contains(frame, []byte(`"compaction_summary_chunk"`)) {
		return frame
	}
	var message struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
		Params struct {
			Update struct {
				Kind string `json:"sessionUpdate"`
			} `json:"update"`
		} `json:"params"`
	}
	if err := json.Unmarshal(frame, &message); err != nil ||
		message.Method != acpsdk.ClientMethodSessionUpdate || len(message.ID) != 0 {
		return frame
	}
	switch message.Params.Update.Kind {
	case "compaction_update", "compaction_summary_chunk":
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(frame, &envelope); err != nil {
			return frame
		}
		envelope["method"] = json.RawMessage(`"` + compactionTransportMethod + `"`)
		updated, err := json.Marshal(envelope)
		if err == nil {
			return append(updated, '\n')
		}
	}
	return frame
}

func (c *acpClient) enqueueStandardCompaction(params json.RawMessage) error {
	var notification standardCompactionNotification
	if err := json.Unmarshal(params, &notification); err != nil {
		return fmt.Errorf("acpproxy: decode compaction notification: %w", err)
	}
	if notification.SessionID == "" || notification.Update.ID == "" {
		return fmt.Errorf("acpproxy: compaction notification requires sessionId and compactionId")
	}
	update := notification.Update
	var streamText string
	switch update.Kind {
	case "compaction_update":
		switch update.Status {
		case "in_progress", "completed", "failed", "cancelled":
		default:
			return fmt.Errorf("acpproxy: invalid compaction status")
		}
	case "compaction_summary_chunk":
		if update.Content == nil {
			return fmt.Errorf("acpproxy: compaction summary chunk requires content")
		}
		if update.Content.Text != nil {
			streamText = update.Content.Text.Text
		}
	default:
		return fmt.Errorf("acpproxy: invalid compaction notification kind")
	}
	if c.handler != nil {
		streamKind := ""
		if streamText != "" {
			streamKind = "compaction:" + update.ID
		}
		c.handler.observeOutputForCallerTokens(c.agentServer, notification.SessionID, streamKind, streamText, params, false)
	}
	c.asyncNotifications.enqueue(func(ctx context.Context, method string, payload any) {
		c.routeSessionEvent(ctx, method, notification.SessionID, payload)
	}, acpsdk.ClientMethodSessionUpdate, params)
	return nil
}
