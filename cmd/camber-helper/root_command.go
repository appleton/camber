package main

import (
	"fmt"
	"log/slog"
	"runtime"
	"runtime/debug"

	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"

	"github.com/appleton/camber/pkg/camber-helper/server"
)

func rootCommand() *cobra.Command {
	var rootCmd = &cobra.Command{
		Use:   "camber-helper",
		Short: "Runs camber Helper",
	}

	useStdin := rootCmd.Flags().Bool("stdin", true, "run lsp server against stdin (default)")
	listenPort := rootCmd.Flags().Int("port", 0, "listen on port")

	// left in for backwards compatibility with anything passing this flag
	_ = rootCmd.Flags().Bool("pprof", false, "(obsolete - now always started) start pprof server")

	rootCmd.RunE = func(cmd *cobra.Command, args []string) error {
		targetMax := 4
		// set GOMAXPROCS to smallest of targetMax and 50% of available CPUs
		cpuMax := min(max(runtime.NumCPU()/2, 1), targetMax)
		runtime.GOMAXPROCS(cpuMax)

		slog.Info("creating server")
		s, _ := server.NewDefault()

		// set memory soft limit for go heap.
		// N.B. this is for the Go heap. CGO allocated memory (treesitter) is not visible to
		// the Go GC.
		debug.SetMemoryLimit(512 * humanize.MiByte)

		if *useStdin {
			return s.RunStdio()
		}

		slog.Info("starting tcp listener", "port", *listenPort)
		return s.RunTCP(fmt.Sprintf("0.0.0.0:%d", *listenPort))
	}

	return rootCmd
}
