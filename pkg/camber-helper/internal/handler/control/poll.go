package control

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	pkgerrors "github.com/pkg/errors"
	"github.com/appleton/camber/pkg/camber-helper/methods"
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
		if command == "chat.output" {
			cursor = selected.Cursor
			if cursor == "" {
				cursor = s.log.TurnCursor(v.AgentServer, v.SessionID)
			}
		}
		if command == "chat.snapshot" {
			cursor = ""
		}
		page, err := s.log.PollBetween(v.AgentServer, v.SessionID, cursor, selected.EndCursor)
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
		out := map[string]any{"events": page.Events, "cursor": page.Cursor, "nextCursor": page.NextCursor, "turnActive": running, "resetRequired": page.ResetRequired, "hasMore": page.HasMore, "conversation": v, "turnId": v.TurnID, "status": status, "result": v.Result, "error": v.Error, "terminal": terminal && !page.HasMore, "waitExpired": a.WaitMs > 0 && time.Now().After(deadline) && !terminal, "pendingInteractions": pending}
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
			out["text"] = b.String()
			out["complete"] = !page.ResetRequired && !page.HasMore && terminal
			out["truncated"] = page.ResetRequired || page.HasMore
			out["scope"] = "latest_turn"
			if command == "chat.snapshot" {
				out["scope"] = "retained_session"
			}
		}
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
