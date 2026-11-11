package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	cambercli "github.com/appleton/camber/pkg/camber-cli"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	command := cambercli.NewCommand()
	if err := command.ExecuteContext(ctx); err != nil {
		asJSON, _ := command.PersistentFlags().GetBool("json")
		if asJSON {
			var rpcError *cambercli.RPCError
			if errors.As(err, &rpcError) {
				_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"error": rpcError})
			} else {
				_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"error": map[string]any{"code": "CLI_ERROR", "message": err.Error()}})
			}
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
