package remoteaccess

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"unicode/utf8"

	pkgerrors "github.com/pkg/errors"
)

type ControlEvent struct {
	Seq    int64  `json:"seq"`
	Method string `json:"method"`
	Params any    `json:"params"`
}
type ControlPoll struct {
	Events        []ControlEvent `json:"events"`
	Cursor        string         `json:"cursor"`
	NextCursor    string         `json:"nextCursor"`
	TurnActive    bool           `json:"turnActive"`
	ResetRequired bool           `json:"resetRequired"`
	HasMore       bool           `json:"hasMore"`
	// ReducedEvents counts events on this page that were size-reduced.
	ReducedEvents int `json:"reducedEvents"`
	// AgentTextReduced is true when an agent_message_chunk on this page was
	// reduced, so its text may have been cut.
	AgentTextReduced bool `json:"agentTextReduced"`
}

const (
	// controlEventCap bounds one event's encoding in a control page. With the
	// 256KB page budget, a page (plus the derived text field) stays well under
	// the 1 MiB control frame limit.
	controlEventCap = 192 * 1024
	controlPageCap  = 256 * 1024
	// Truncation limits used when reducing an oversized event.
	controlTextCap   = 64 * 1024
	controlStringCap = 2 * 1024
)

type controlCursor struct {
	Agent, Session, Epoch string
	Seq                   int64
}

// Poll reads the same stamped event stream used by every desktop surface.
// Cursors bind a position to one session and fail explicitly after eviction or
// helper restart; clients never silently miss text when a cursor expires.
func (l *SessionLog) Poll(agent, session, cursor string) (ControlPoll, error) {
	return l.PollBetween(agent, session, cursor, "")
}

// PollBetween bounds replay to an immutable completed turn when end is set.
func (l *SessionLog) PollBetween(agent, session, cursor, end string) (ControlPoll, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entryLocked(agent, session)
	out := ControlPoll{Events: []ControlEvent{}, TurnActive: entry.activeTurns > 0}
	after := int64(0)
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return out, pkgerrors.Wrap(err, "invalid cursor")
		}
		var c controlCursor
		if err = json.Unmarshal(raw, &c); err != nil {
			return out, pkgerrors.Wrap(err, "invalid cursor")
		}
		if c.Agent != agent || c.Session != session {
			return out, pkgerrors.Errorf("cursor belongs to a different conversation")
		}
		if c.Epoch != l.epoch || c.Seq > entry.seq {
			out.ResetRequired = true
		} else {
			after = c.Seq
		}
	}
	upper := entry.seq
	if end != "" {
		raw, err := base64.RawURLEncoding.DecodeString(end)
		if err != nil {
			return out, pkgerrors.Wrap(err, "invalid end cursor")
		}
		var c controlCursor
		if err = json.Unmarshal(raw, &c); err != nil {
			return out, pkgerrors.WithStack(err)
		}
		if c.Agent != agent || c.Session != session {
			return out, pkgerrors.Errorf("end cursor belongs to a different conversation")
		}
		if c.Epoch != l.epoch || c.Seq > entry.seq {
			out.ResetRequired = true
		} else {
			upper = c.Seq
		}
		out.TurnActive = false
		if after > upper {
			return out, pkgerrors.Errorf("cursor is beyond the selected turn")
		}
	}
	if len(entry.events) > 0 && entry.events[0].seq > after+1 {
		out.ResetRequired = true
	}
	last := after
	size := 0
	if !out.ResetRequired || cursor == "" {
		for _, event := range entry.events {
			if event.seq <= after || event.seq > upper {
				continue
			}
			item := ControlEvent{Seq: event.seq, Method: event.method, Params: event.params}
			encoded, err := json.Marshal(item)
			if err != nil {
				return out, pkgerrors.WithStack(err)
			}
			reduced := false
			if len(encoded) > controlEventCap {
				// Reduce a copy for the control view; the stored log keeps the
				// original for remote clients.
				item.Params = reduceControlParams(event.params, len(encoded))
				reduced = true
				if encoded, err = json.Marshal(item); err != nil {
					return out, pkgerrors.WithStack(err)
				}
			}
			// A page always carries at least one event so an oversized event
			// cannot stall pagination; reduction keeps it under controlEventCap.
			if len(out.Events) > 0 && size+len(encoded) > controlPageCap {
				out.HasMore = true
				break
			}
			if reduced {
				out.ReducedEvents++
				if isAgentMessageChunk(event.params) {
					out.AgentTextReduced = true
				}
			}
			size += len(encoded)
			out.Events = append(out.Events, item)
			last = event.seq
		}
	}
	if !out.HasMore {
		last = upper
	}
	raw, _ := json.Marshal(controlCursor{Agent: agent, Session: session, Epoch: l.epoch, Seq: last})
	out.Cursor = base64.RawURLEncoding.EncodeToString(raw)
	out.NextCursor = out.Cursor
	return out, nil
}

// ControlCursor captures a boundary before a newly launched turn emits output.
func (l *SessionLog) ControlCursor(agent, session string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entryLocked(agent, session)
	raw, _ := json.Marshal(controlCursor{Agent: agent, Session: session, Epoch: l.epoch, Seq: entry.seq})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// TurnCursor captures the boundary before the latest UI- or CLI-started turn.
func (l *SessionLog) TurnCursor(agent, session string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entryLocked(agent, session)
	seq := entry.turnStartSeq - 1
	if seq < 0 {
		seq = 0
	}
	raw, _ := json.Marshal(controlCursor{Agent: agent, Session: session, Epoch: l.epoch, Seq: seq})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// CursorEpochCurrent distinguishes process restarts from ordinary bounded
// event eviction without treating a long completed turn as interrupted.
func (l *SessionLog) CursorEpochCurrent(cursor string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return false
	}
	var c controlCursor
	if json.Unmarshal(raw, &c) != nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return c.Epoch == l.epoch
}

// CursorAt encodes a boundary captured by the ACP proxy's serialized event queue.
func (l *SessionLog) CursorAt(agent, session, epoch string, seq int64) string {
	raw, _ := json.Marshal(controlCursor{Agent: agent, Session: session, Epoch: epoch, Seq: seq})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// ProcessEpoch identifies the helper lifetime that owns preparation work.
func (l *SessionLog) ProcessEpoch() string { return l.epoch }

// isAgentMessageChunk reports whether params carry an agent_message_chunk
// session update, wherever the stamped envelope nests it.
func isAgentMessageChunk(params any) bool {
	raw, err := json.Marshal(params)
	if err != nil {
		return false
	}
	var p struct {
		Message struct {
			Params struct {
				Update struct {
					SessionUpdate string `json:"sessionUpdate"`
				} `json:"update"`
			} `json:"params"`
		} `json:"message"`
	}
	return json.Unmarshal(raw, &p) == nil && p.Message.Params.Update.SessionUpdate == "agent_message_chunk"
}

// reduceControlParams returns a reduced copy of params for control output,
// keeping identifying fields and agent message text while truncating bulky
// payloads. The result is marked with _poolside.truncated.
func reduceControlParams(params any, originalBytes int) any {
	return ReduceControlValue(params, originalBytes, controlEventCap/2)
}

// ReduceControlValue returns a reduced copy of v whose encoding fits in
// target bytes where possible: bulky strings are truncated with a marker,
// media, _meta, rawInput, rawOutput and toolResponse payloads are omitted, and
// long arrays are cut. Short identifying fields survive. Object results carry
// _poolside.truncated; control output uses this for oversized events and
// pending interactions alike.
func ReduceControlValue(params any, originalBytes, target int) any {
	raw, err := json.Marshal(params)
	var tree any
	if err == nil {
		err = json.Unmarshal(raw, &tree)
	}
	marker := map[string]any{"truncated": true, "originalBytes": originalBytes}
	if err != nil {
		return map[string]any{"_poolside": marker}
	}
	for _, level := range []struct{ text, str int }{{controlTextCap, controlStringCap}, {controlTextCap / 4, 256}, {1024, 64}} {
		reduced := reduceNode(tree, level.text, level.str, "")
		if m, ok := reduced.(map[string]any); ok {
			m["_poolside"] = marker
			if enc, e := json.Marshal(m); e == nil && len(enc) <= target {
				return m
			}
		}
	}
	return map[string]any{"_poolside": marker, "note": "event too large for control output"}
}

func reduceNode(n any, textCap, strCap int, key string) any {
	switch v := n.(type) {
	case string:
		limit := strCap
		if key == "text" {
			limit = textCap
		}
		return truncateMarked(v, limit)
	case []any:
		const maxItems = 16
		out := make([]any, 0, min(len(v), maxItems)+1)
		for i, item := range v {
			if i == maxItems {
				out = append(out, fmt.Sprintf("[%d more items omitted]", len(v)-maxItems))
				break
			}
			out = append(out, reduceNode(item, textCap, strCap, key))
		}
		return out
	case map[string]any:
		if t, _ := v["type"].(string); t == "image" || t == "audio" {
			data, _ := v["data"].(string)
			mime, _ := v["mimeType"].(string)
			return map[string]any{"type": t, "mimeType": mime, "omitted": true, "bytes": len(data)}
		}
		out := make(map[string]any, len(v))
		for k, item := range v {
			switch k {
			case "_meta", "rawInput", "rawOutput", "toolResponse":
				raw, _ := json.Marshal(item)
				out[k] = fmt.Sprintf("[omitted %d bytes]", len(raw))
			case "data", "blob":
				if s, ok := item.(string); ok && len(s) > strCap {
					out[k] = fmt.Sprintf("[omitted %d bytes]", len(s))
					continue
				}
				out[k] = reduceNode(item, textCap, strCap, k)
			default:
				out[k] = reduceNode(item, textCap, strCap, k)
			}
		}
		return out
	}
	return n
}

func truncateMarked(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return fmt.Sprintf("%s\n[truncated %d of %d bytes]", s[:cut], len(s)-cut, len(s))
}
