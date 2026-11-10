package main

import (
	"github.com/spf13/cobra"

	"github.com/appleton/camber/pkg/camber-helper/helpercli"
)

func apiDocsCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "openapi",
		Short: "Runs OpenAPI server for the JSON-RPC extensions",
		RunE: func(cmd *cobra.Command, args []string) error {
			return helpercli.RunOpenAPIServer()
		},
	}
	return cmd
}
