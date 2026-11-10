package handler

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof"
	"time"

	"github.com/pkg/errors"

	"github.com/appleton/camber/pkg/common/goroutine"
)

func (h *CamberHandler) startPprofNonBlocking() {
	h.pprofStarted.Do(func() {
		goroutine.WithRecover(func() {
			listener, err := findPort()
			if err != nil {
				slog.Error("failed to start pprof", "err", err)
			} else {
				slog.Info("pprof listening on", "addr", listener.Addr())
				// the pprof import has registered itself with http.DefaultServeMux
				http.Serve(listener, http.DefaultServeMux)
			}
		})
	})
}

func findPort() (net.Listener, error) {
	// pick ephemeral port range, rather than registered port range
	// which user may wish to use (e.g. for pprof'ing their own programs)
	start := 49600
	count := 1000
	maxWait := time.After(time.Second * 2)
	var i int

search:
	for i = range count {
		select {
		case <-maxWait:
			break search
		default:
			addr := fmt.Sprintf("127.0.0.1:%d", start+i)
			listener, err := net.Listen("tcp", addr)
			if err == nil {
				return listener, nil
			}
		}
	}
	return nil, errors.Errorf("could not listen on any port between %d-%d", start, start+i)
}
