package remoteaccess

import (
	"encoding/base64"
	"encoding/json"

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
}
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
			// A page always carries at least one event so an oversized event
			// cannot stall pagination.
			if len(out.Events) > 0 && size+len(encoded) > 256*1024 {
				out.HasMore = true
				break
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
