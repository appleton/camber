package main

import (
	"context"
	"io"
	"os"
	"time"

	"github.com/spf13/cobra"
)

func tailCommand() *cobra.Command {
	var follow bool

	cmd := &cobra.Command{
		Use:   "tail [-f] FILE",
		Short: "reads a shell output file and writes it out to stdout",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := args[0]
			if follow {
				return tailFollow(path)
			}
			return tailOnce(path)
		},
	}

	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "Follow file changes (like tail -f)")

	return cmd
}

func tailOnce(path string) error {
	fd, err := os.Open(path)
	if err != nil {
		return err
	}
	defer fd.Close()
	_, err = io.Copy(os.Stdout, fd)
	return err
}

func tailFollow(path string) error {
	fd, err := os.Open(path)
	if err != nil {
		return err
	}

	_, err = io.Copy(os.Stdout, fd)
	if err != nil {
		fd.Close()
		return err
	}

	ctx := context.Background()
	return followFile(ctx, fd, path)
}

func followFile(ctx context.Context, fd *os.File, path string) error {
	defer fd.Close()

	buf := make([]byte, 4096)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			n, err := fd.Read(buf)
			if err != nil {
				if err == io.EOF {
					time.Sleep(100 * time.Millisecond)

					stat1, err1 := fd.Stat()
					stat2, err2 := os.Stat(path)
					if err1 == nil && err2 == nil {
						if !os.SameFile(stat1, stat2) {
							fd.Close()
							newFd, err := os.Open(path)
							if err != nil {
								return err
							}
							fd = newFd
						}
					}
					continue
				}
				return err
			}

			if n > 0 {
				os.Stdout.Write(buf[:n])
			}
		}
	}
}
