// Copyright 2019 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Package ocagent adds the ability to export all telemetry to an ocagent.
// This keeps the compile time dependencies to zero and allows the agent to
// have the exporters needed for telemetry aggregation and viewing systems.
package ocagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/event"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/event/core"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/event/export"
	metric2 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/event/export/metric"
	wire2 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/event/export/ocagent/wire"
	keys2 "github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/event/keys"
	"github.com/appleton/camber/pkg/camber-helper/internal/gopls/gotoolsinternal/event/label"
)

type Config struct {
	Start   time.Time
	Host    string
	Process uint32
	Client  *http.Client
	Service string
	Address string
	Rate    time.Duration
}

var (
	connectMu sync.Mutex
	exporters = make(map[Config]*Exporter)
)

// Discover finds the local agent to export to, it will return nil if there
// is not one running.
// TODO: Actually implement a discovery protocol rather than a hard coded address
func Discover() *Config {
	return &Config{
		Address: "http://localhost:55678",
	}
}

type Exporter struct {
	mu      sync.Mutex
	config  Config
	spans   []*export.Span
	metrics []metric2.Data
}

// Connect creates a process specific exporter with the specified
// serviceName and the address of the ocagent to which it will upload
// its telemetry.
func Connect(config *Config) *Exporter {
	if config == nil || config.Address == "off" {
		return nil
	}
	resolved := *config
	if resolved.Host == "" {
		hostname, _ := os.Hostname()
		resolved.Host = hostname
	}
	if resolved.Process == 0 {
		resolved.Process = uint32(os.Getpid())
	}
	if resolved.Client == nil {
		resolved.Client = http.DefaultClient
	}
	if resolved.Service == "" {
		resolved.Service = filepath.Base(os.Args[0])
	}
	if resolved.Rate == 0 {
		resolved.Rate = 2 * time.Second
	}

	connectMu.Lock()
	defer connectMu.Unlock()
	if exporter, found := exporters[resolved]; found {
		return exporter
	}
	exporter := &Exporter{config: resolved}
	exporters[resolved] = exporter
	if exporter.config.Start.IsZero() {
		exporter.config.Start = time.Now()
	}
	go func() {
		for range time.Tick(exporter.config.Rate) {
			exporter.Flush()
		}
	}()
	return exporter
}

func (e *Exporter) ProcessEvent(ctx context.Context, ev core.Event, lm label.Map) context.Context {
	switch {
	case event.IsEnd(ev):
		e.mu.Lock()
		defer e.mu.Unlock()
		span := export.GetSpan(ctx)
		if span != nil {
			e.spans = append(e.spans, span)
		}
	case event.IsMetric(ev):
		e.mu.Lock()
		defer e.mu.Unlock()
		data := metric2.Entries.Get(lm).([]metric2.Data)
		e.metrics = append(e.metrics, data...)
	}
	return ctx
}

func (e *Exporter) Flush() {
	e.mu.Lock()
	defer e.mu.Unlock()
	spans := make([]*wire2.Span, len(e.spans))
	for i, s := range e.spans {
		spans[i] = convertSpan(s)
	}
	e.spans = nil
	metrics := make([]*wire2.Metric, len(e.metrics))
	for i, m := range e.metrics {
		metrics[i] = convertMetric(m, e.config.Start)
	}
	e.metrics = nil

	if len(spans) > 0 {
		e.send("/v1/trace", &wire2.ExportTraceServiceRequest{
			Node:  e.config.buildNode(),
			Spans: spans,
			//TODO: Resource?
		})
	}
	if len(metrics) > 0 {
		e.send("/v1/metrics", &wire2.ExportMetricsServiceRequest{
			Node:    e.config.buildNode(),
			Metrics: metrics,
			//TODO: Resource?
		})
	}
}

func (cfg *Config) buildNode() *wire2.Node {
	return &wire2.Node{
		Identifier: &wire2.ProcessIdentifier{
			HostName:       cfg.Host,
			Pid:            cfg.Process,
			StartTimestamp: convertTimestamp(cfg.Start),
		},
		LibraryInfo: &wire2.LibraryInfo{
			Language:           wire2.LanguageGo,
			ExporterVersion:    "0.0.1",
			CoreLibraryVersion: "x/tools",
		},
		ServiceInfo: &wire2.ServiceInfo{
			Name: cfg.Service,
		},
	}
}

func (e *Exporter) send(endpoint string, message interface{}) {
	blob, err := json.Marshal(message)
	if err != nil {
		errorInExport("ocagent failed to marshal message for %v: %v", endpoint, err)
		return
	}
	uri := e.config.Address + endpoint
	req, err := http.NewRequest("POST", uri, bytes.NewReader(blob))
	if err != nil {
		errorInExport("ocagent failed to build request for %v: %v", uri, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := e.config.Client.Do(req)
	if err != nil {
		errorInExport("ocagent failed to send message: %v \n", err)
		return
	}
	if res.Body != nil {
		res.Body.Close()
	}
}

func errorInExport(message string, args ...interface{}) {
	// This function is useful when debugging the exporter, but in general we
	// want to just drop any export
}

func convertTimestamp(t time.Time) wire2.Timestamp {
	return t.Format(time.RFC3339Nano)
}

func toTruncatableString(s string) *wire2.TruncatableString {
	if s == "" {
		return nil
	}
	return &wire2.TruncatableString{Value: s}
}

func convertSpan(span *export.Span) *wire2.Span {
	result := &wire2.Span{
		TraceID:                 span.ID.TraceID[:],
		SpanID:                  span.ID.SpanID[:],
		TraceState:              nil, //TODO?
		ParentSpanID:            span.ParentID[:],
		Name:                    toTruncatableString(span.Name),
		Kind:                    wire2.UnspecifiedSpanKind,
		StartTime:               convertTimestamp(span.Start().At()),
		EndTime:                 convertTimestamp(span.Finish().At()),
		Attributes:              convertAttributes(span.Start(), 1),
		TimeEvents:              convertEvents(span.Events()),
		SameProcessAsParentSpan: true,
		//TODO: StackTrace?
		//TODO: Links?
		//TODO: Status?
		//TODO: Resource?
	}
	return result
}

func convertMetric(data metric2.Data, start time.Time) *wire2.Metric {
	descriptor := dataToMetricDescriptor(data)
	timeseries := dataToTimeseries(data, start)

	if descriptor == nil && timeseries == nil {
		return nil
	}

	// TODO: handle Histogram metrics
	return &wire2.Metric{
		MetricDescriptor: descriptor,
		Timeseries:       timeseries,
		// TODO: attach Resource?
	}
}

func skipToValidLabel(list label.List, index int) (int, label.Label) {
	// skip to the first valid label
	for ; list.Valid(index); index++ {
		l := list.Label(index)
		if !l.Valid() || l.Key() == keys2.Label {
			continue
		}
		return index, l
	}
	return -1, label.Label{}
}

func convertAttributes(list label.List, index int) *wire2.Attributes {
	index, l := skipToValidLabel(list, index)
	if !l.Valid() {
		return nil
	}
	attributes := make(map[string]wire2.Attribute)
	for {
		if l.Valid() {
			attributes[l.Key().Name()] = convertAttribute(l)
		}
		index++
		if !list.Valid(index) {
			return &wire2.Attributes{AttributeMap: attributes}
		}
		l = list.Label(index)
	}
}

func convertAttribute(l label.Label) wire2.Attribute {
	switch key := l.Key().(type) {
	case *keys2.Int:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.Int8:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.Int16:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.Int32:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.Int64:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.UInt:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.UInt8:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.UInt16:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.UInt32:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.UInt64:
		return wire2.IntAttribute{IntValue: int64(key.From(l))}
	case *keys2.Float32:
		return wire2.DoubleAttribute{DoubleValue: float64(key.From(l))}
	case *keys2.Float64:
		return wire2.DoubleAttribute{DoubleValue: key.From(l)}
	case *keys2.Boolean:
		return wire2.BoolAttribute{BoolValue: key.From(l)}
	case *keys2.String:
		return wire2.StringAttribute{StringValue: toTruncatableString(key.From(l))}
	case *keys2.Error:
		return wire2.StringAttribute{StringValue: toTruncatableString(key.From(l).Error())}
	case *keys2.Value:
		return wire2.StringAttribute{StringValue: toTruncatableString(fmt.Sprint(key.From(l)))}
	default:
		return wire2.StringAttribute{StringValue: toTruncatableString(fmt.Sprintf("%T", key))}
	}
}

func convertEvents(events []core.Event) *wire2.TimeEvents {
	//TODO: MessageEvents?
	result := make([]wire2.TimeEvent, len(events))
	for i, event := range events {
		result[i] = convertEvent(event)
	}
	return &wire2.TimeEvents{TimeEvent: result}
}

func convertEvent(ev core.Event) wire2.TimeEvent {
	return wire2.TimeEvent{
		Time:       convertTimestamp(ev.At()),
		Annotation: convertAnnotation(ev),
	}
}

func getAnnotationDescription(ev core.Event) (string, int) {
	l := ev.Label(0)
	if l.Key() != keys2.Msg {
		return "", 0
	}
	if msg := keys2.Msg.From(l); msg != "" {
		return msg, 1
	}
	l = ev.Label(1)
	if l.Key() != keys2.Err {
		return "", 1
	}
	if err := keys2.Err.From(l); err != nil {
		return err.Error(), 2
	}
	return "", 2
}

func convertAnnotation(ev core.Event) *wire2.Annotation {
	description, index := getAnnotationDescription(ev)
	if _, l := skipToValidLabel(ev, index); !l.Valid() && description == "" {
		return nil
	}
	return &wire2.Annotation{
		Description: toTruncatableString(description),
		Attributes:  convertAttributes(ev, index),
	}
}
