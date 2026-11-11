package control

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/appleton/camber/pkg/camber-helper/methods"
	pkgerrors "github.com/pkg/errors"
	"github.com/tliron/glsp"
)

func (s *Service) poll(ctx context.Context, a Args, command string, g *glsp.Context) (any, error) {
	deadline := time.Now().Add(time.Duration(a.WaitMs) * time.Millisecond)
	for {
		v, err := s.view(ctx, a.ConversationID, g)
		if err != nil {
			return nil, err
		}
		actualID, actualStatus, actualFound := "", "", false
		if source, ok := s.agent.(interface {
			CurrentTurn(string, string) (string, string, bool)
		}); ok {
			actualID, actualStatus, actualFound = source.CurrentTurn(v.AgentServer, v.SessionID)
		}
		selected := v.Record
		if a.TurnID != "" {
			var saved Record
			if err = s.nav.ReadControlState(ctx, "turn/"+a.TurnID, &saved); err != nil {
				return nil, err
			}
			if saved.TurnID != "" && strings.HasPrefix(saved.TurnID, v.ID+"/") {
				selected = saved
			} else if observed, found, observeErr := s.observedTurn(ctx, v, a.TurnID); observeErr != nil {
				return nil, observeErr
			} else if found {
				selected = observed
			} else if actualFound && actualID == a.TurnID {
				selected.TurnID = actualID
				selected.Status = actualStatus
				selected.Cursor = s.log.TurnCursor(v.AgentServer, v.SessionID)
				selected.EndCursor = ""
				selected.Result = nil
				selected.Error = ""
			} else {
				return nil, pkgerrors.Errorf("turnId does not belong to this conversation or is no longer retained")
			}
		}
		if a.TurnID == "" && actualFound && actualID != v.TurnID {
			selected.TurnID = actualID
			selected.Status = actualStatus
			selected.Cursor = s.log.TurnCursor(v.AgentServer, v.SessionID)
			selected.EndCursor = ""
			selected.Result = nil
			selected.Error = ""
			if observed, found, observeErr := s.observedTurn(ctx, v, actualID); observeErr != nil {
				return nil, observeErr
			} else if found {
				selected = observed
			}
		}
		if selected.EndCursor == "" && selected.Status != "running" && selected.TurnID != "" {
			if boundaries, ok := s.agent.(interface {
				TurnEndCursor(context.Context, string, string, string) (string, int64, bool, error)
			}); ok {
				epoch, seq, found, e := boundaries.TurnEndCursor(ctx, v.AgentServer, v.SessionID, selected.TurnID)
				if e != nil {
					return nil, e
				}
				if found {
					selected.EndCursor = s.log.CursorAt(v.AgentServer, v.SessionID, epoch, seq)
				}
			}
		}
		v.Record = selected
		cursor := a.Cursor
		if cursor == "" {
			cursor = selected.Cursor
		}
		// An explicit cursor (a previous page's nextCursor) always wins;
		// otherwise output starts at the turn and snapshot at the oldest
		// retained event.
		if command == "chat.output" && a.Cursor == "" {
			cursor = selected.Cursor
			if cursor == "" {
				cursor = s.log.TurnCursor(v.AgentServer, v.SessionID)
			}
		}
		if command == "chat.snapshot" && a.Cursor == "" {
			cursor = ""
		}
		page, err := s.log.PollBetweenRedacted(v.AgentServer, v.SessionID, cursor, selected.EndCursor, s.redactor())
		if err != nil {
			return nil, err
		}
		running := page.TurnActive || v.Status == "running"
		if selected.EndCursor != "" {
			running = false
		}
		if v.Status == "running" && v.Cursor != "" {
			boundary, e := s.log.Poll(v.AgentServer, v.SessionID, v.Cursor)
			if e == nil && boundary.ResetRequired && !s.log.CursorEpochCurrent(v.Cursor) && !page.TurnActive {
				v.Status = "interrupted"
				v.Error = "helper restarted or output history expired; inspect before resuming"
				running = false
				page.ResetRequired = true
			}
		}
		if selected.EndCursor == "" && v.LiveStatus != nil && v.LiveStatus.Working {
			running = true
		}
		pending := []methods.ACPApproval{}
		if selected.EndCursor == "" {
			if source, ok := s.agent.(interface {
				ListApprovals(context.Context, *struct{}, *glsp.Context) (methods.ACPApprovalsDidChangeParams, error)
			}); ok {
				if approvals, e := source.ListApprovals(ctx, &struct{}{}, g); e == nil {
					for _, p := range approvals.Pending {
						if p.AgentServer == v.AgentServer && p.SessionID == v.SessionID {
							pending = append(pending, p)
						}
					}
				}
			}
		}
		waiting := selected.EndCursor == "" && (len(pending) > 0 || (v.LiveStatus != nil && v.LiveStatus.WaitingForUser))
		if len(page.Events) == 0 && !page.ResetRequired && running && !waiting && time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(100 * time.Millisecond):
				continue
			}
		}
		status := v.Status
		if waiting {
			status = "waiting_for_input"
		} else if running {
			status = "running"
		} else if status == "" {
			status = "idle"
		}
		terminal := !running && !waiting
		out := map[string]any{"events": page.Events, "cursor": page.Cursor, "nextCursor": page.NextCursor, "turnActive": running, "resetRequired": page.ResetRequired, "hasMore": page.HasMore, "conversation": v, "turnId": v.TurnID, "status": status, "result": v.Result, "error": v.Error, "terminal": terminal && !page.HasMore, "waitExpired": a.WaitMs > 0 && time.Now().After(deadline) && !terminal}
		bounded, pendingTruncated := boundPendingInteractions(pending, s.redactor())
		out["pendingInteractions"] = bounded
		if page.ReducedEvents > 0 {
			out["truncated"] = true
			out["reducedEvents"] = page.ReducedEvents
		}
		if command == "chat.output" || command == "chat.snapshot" {
			var b strings.Builder
			for _, event := range page.Events {
				raw, _ := json.Marshal(event.Params)
				var p struct {
					Message struct {
						Params struct {
							Update struct {
								SessionUpdate string `json:"sessionUpdate"`
								Content       struct {
									Type string `json:"type"`
									Text string `json:"text"`
								} `json:"content"`
							} `json:"update"`
						} `json:"params"`
					} `json:"message"`
				}
				if json.Unmarshal(raw, &p) == nil && p.Message.Params.Update.SessionUpdate == "agent_message_chunk" && p.Message.Params.Update.Content.Type == "text" {
					b.WriteString(p.Message.Params.Update.Content.Text)
				}
			}
			// text covers only this page's agent message chunks; concatenating
			// it across pages (following nextCursor) yields the full message.
			out["text"] = b.String()
			// A reduced agent message chunk means text was cut: never claim a
			// complete answer, and flag the page truncated.
			out["complete"] = !page.ResetRequired && !page.HasMore && terminal && !page.AgentTextReduced
			out["truncated"] = page.ResetRequired || page.HasMore || page.ReducedEvents > 0
			out["reducedEvents"] = page.ReducedEvents
			out["agentTextTruncated"] = page.AgentTextReduced
			out["scope"] = "latest_turn"
			if command == "chat.snapshot" {
				out["scope"] = "retained_session"
			}
		}
		if pendingTruncated {
			out["truncated"] = true
			out["pendingInteractionsTruncated"] = true
		}
		fitPollResponse(out, pending, s.redactor())
		return out, nil
	}
}

func (s *Service) observedTurn(ctx context.Context, v View, id string) (Record, bool, error) {
	source, ok := s.agent.(interface {
		ObserveTurn(context.Context, string, string, string) (methods.ControlObservedTurn, bool, error)
	})
	if !ok {
		return Record{}, false, nil
	}
	observed, found, err := source.ObserveTurn(ctx, v.AgentServer, v.SessionID, id)
	if err != nil || !found {
		return Record{}, false, err
	}
	record := v.Record
	record.TurnID, record.Status, record.Result, record.Error = observed.TurnID, observed.Status, observed.Result, observed.Error
	record.Cursor = s.log.CursorAt(v.AgentServer, v.SessionID, observed.Epoch, observed.StartSeq)
	record.EndCursor = ""
	if observed.Finished {
		record.EndCursor = s.log.CursorAt(v.AgentServer, v.SessionID, observed.Epoch, observed.EndSeq)
	}
	return record, true, nil
}

const (
	// pendingInteractionCap bounds one pending interaction's encoding; a
	// permission request carries the agent's raw tool call, which can hold a
	// whole proposed file write.
	pendingInteractionCap = 32 * 1024
	// pendingInteractionsCap bounds all pending interactions on one page;
	// interactions past it are reduced to identifying stubs.
	pendingInteractionsCap = 96 * 1024
	// pollResponseCap keeps a whole poll response well under the 1 MiB
	// control frame limit.
	pollResponseCap = 768 * 1024
)

// redactor returns the caller-token redaction applied before any truncation
// (see PollBetweenRedacted), or nil without a caller resolver.
func (s *Service) redactor() func([]byte) []byte {
	if s.callers == nil {
		return nil
	}
	return s.callers.RedactCallerTokens
}

// boundPendingInteractions reduces oversized pending interactions (marked
// _camber.truncated) and stubs those past the total budget, reporting
// whether anything was cut. redact, when set, runs before reduction so a
// truncation cannot leave part of a token behind.
func boundPendingInteractions(pending []methods.ACPApproval, redact func([]byte) []byte) ([]any, bool) {
	out := make([]any, 0, len(pending))
	total, truncated := 0, false
	for _, p := range pending {
		var item any = p
		enc, err := json.Marshal(p)
		switch {
		case err != nil:
			item, truncated = pendingStub(p, 0), true
		case len(enc) > pendingInteractionCap:
			var value any = p
			if redact != nil {
				value = json.RawMessage(redact(enc))
			}
			item, truncated = withApprovalIdentity(remoteaccess.ReduceControlValue(value, len(enc), pendingInteractionCap), p), true
		}
		size := encodedLen(item)
		if total+size > pendingInteractionsCap {
			item, truncated = pendingStub(p, len(enc)), true
			size = encodedLen(item)
		}
		total += size
		out = append(out, item)
	}
	return out, truncated
}

// fitPollResponse shrinks out until its encoding fits pollResponseCap:
// first pending interactions become stubs, then the conversation drops its
// bulky metadata, then the derived text (still present in events) goes.
// Event pages are already bounded by the session log. redact, when set, runs
// on the task before it is cut.
func fitPollResponse(out map[string]any, pending []methods.ACPApproval, redact func([]byte) []byte) {
	if encodedLen(out) <= pollResponseCap {
		return
	}
	if len(pending) > 0 {
		stubs := make([]any, 0, len(pending))
		for _, p := range pending {
			stubs = append(stubs, pendingStub(p, 0))
		}
		out["pendingInteractions"] = stubs
		out["pendingInteractionsTruncated"] = true
		out["truncated"] = true
		if encodedLen(out) <= pollResponseCap {
			return
		}
	}
	if v, ok := out["conversation"].(View); ok {
		v.Metadata, v.ConfigOptions, v.Modes = nil, nil, nil
		if redact != nil {
			v.Task = string(redact([]byte(v.Task)))
		}
		if len(v.Task) > 1024 {
			v.Task = strings.ToValidUTF8(v.Task[:1024], "")
		}
		out["conversation"] = v
		out["conversationReduced"] = true
		out["truncated"] = true
		if encodedLen(out) <= pollResponseCap {
			return
		}
	}
	if text, ok := out["text"].(string); ok && text != "" {
		out["text"] = ""
		out["textOmitted"] = true
		out["complete"] = false
		out["truncated"] = true
	}
}

// pendingStub keeps only what identifies a pending interaction.
func pendingStub(p methods.ACPApproval, originalBytes int) map[string]any {
	marker := map[string]any{"truncated": true, "omitted": true}
	if originalBytes > 0 {
		marker["originalBytes"] = originalBytes
	}
	return withApprovalIdentity(map[string]any{"_camber": marker}, p).(map[string]any)
}

// withApprovalIdentity restores identifying fields a reduction may have cut.
func withApprovalIdentity(reduced any, p methods.ACPApproval) any {
	m, ok := reduced.(map[string]any)
	if !ok {
		m = map[string]any{"_camber": map[string]any{"truncated": true}}
	}
	m["agentServer"], m["sessionId"], m["kind"], m["id"] = p.AgentServer, p.SessionID, p.Kind, p.ID
	if p.CreatedAt != "" {
		m["createdAt"] = p.CreatedAt
	}
	return m
}

func encodedLen(v any) int {
	raw, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(raw)
}
