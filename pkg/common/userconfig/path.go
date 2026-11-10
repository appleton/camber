package userconfig

import (
	"os"
	"path/filepath"

	"github.com/adrg/xdg"
)

// Directory returns the OS abs path for the directory containing user-specific config files.
// Uses XDG_CONFIG_HOME if set, otherwise defaults to $HOME/.config.
func Directory() string {
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		homeDir, err := os.UserHomeDir()
		if err == nil {
			configHome = filepath.Join(homeDir, ".config")
		}
	}
	return configHome
}

// CamberDirectory retains the original config directory so existing installs keep their settings.
func CamberDirectory() string {
	return filepath.Join(Directory(), "poolside")
}

// CamberConfigFile returns OS abs to a config file in camber config directory
func CamberConfigFile(name string) string {
	return filepath.Join(CamberDirectory(), name)
}

// StateDirectory returns the path to camber's XDG state directory for data that should
// persist between application restarts but is not important enough to store in $XDG_DATA_HOME
// (e.g. logs, history, recently used files).
//
// macOS: $HOME/Library/Application Support/poolside
//
// Linux: $HOME/.local/share/poolside
func StateDirectory() string {
	return filepath.Join(xdg.StateHome, "poolside")
}
