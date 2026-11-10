package handler

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/tliron/glsp"

	"github.com/appleton/camber/pkg/camber-helper/internal/filesystem"
	"github.com/appleton/camber/pkg/camber-helper/internal/handler/remoteaccess"
	"github.com/appleton/camber/pkg/camber-helper/methods"
)

// setupRemoteAccess constructs the remote access server and registers its
// control methods. These methods are callable only by the primary client
// (desktop settings UI); the remote deny list blocks them for paired devices.
func setupRemoteAccess(h *CamberHandler) {
	statePath := os.Getenv("CAMBER_REMOTE_ACCESS_STATE")
	if statePath == "" {
		cacheDir, err := filesystem.CamberCacheDir()
		if err != nil {
			slog.Error("remoteaccess: no cache dir, remote access unavailable", "error", err)
		} else {
			statePath = filepath.Join(cacheDir, "remote-access.json")
		}
	}
	if statePath != "" {
		srv, err := remoteaccess.NewServer(remoteaccess.Options{
			StatePath:          statePath,
			Dispatch:           h.HandleRemote,
			IsConcurrentMethod: h.IsConcurrentMethod,
			Hub:                h.remoteHub,
			OnDisconnect:       h.acpNavHandler.ClearClientViewState,
		})
		if err != nil {
			slog.Error("remoteaccess: initialization failed, remote access unavailable", "error", err)
		} else {
			h.remoteAccess = srv
			h.cleanupFns = append(h.cleanupFns, srv.Close)
			autoStartRemoteAccess(srv)
		}
	}

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteResumeParams{}.MethodName(),
		Description: methods.RemoteResumeParams{}.Description(),
	}, h.remoteResume)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteAccessStatusParams{}.MethodName(),
		Description: methods.RemoteAccessStatusParams{}.Description(),
	}, h.remoteAccessStatus)

	// Enabling can block on first-time Let's Encrypt cert provisioning
	// (`tailscale cert`), which may exceed the default request deadline.
	registerExtensionMethodNoDeadline(h, JSONRPCOperation{
		Method:      methods.RemoteAccessEnableParams{}.MethodName(),
		Description: methods.RemoteAccessEnableParams{}.Description(),
	}, h.remoteAccessEnable)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteAccessDisableParams{}.MethodName(),
		Description: methods.RemoteAccessDisableParams{}.Description(),
	}, h.remoteAccessDisable)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteAccessSetAutoStartParams{}.MethodName(),
		Description: methods.RemoteAccessSetAutoStartParams{}.Description(),
	}, h.remoteAccessSetAutoStart)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteAccessCreatePairingCodeParams{}.MethodName(),
		Description: methods.RemoteAccessCreatePairingCodeParams{}.Description(),
	}, h.remoteAccessCreatePairingCode)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteAccessConfirmPairingParams{}.MethodName(),
		Description: methods.RemoteAccessConfirmPairingParams{}.Description(),
	}, h.remoteAccessConfirmPairing)

	registerExtensionMethod(h, JSONRPCOperation{
		Method:      methods.RemoteAccessRevokeDeviceParams{}.MethodName(),
		Description: methods.RemoteAccessRevokeDeviceParams{}.Description(),
	}, h.remoteAccessRevokeDevice)
}

// autoStartRemoteAccess enables the server on helper launch when the user
// opted in from the desktop settings. It runs in the background: the first
// Tailscale certificate issuance can block for 10-15 seconds and must not
// delay helper startup. A failed auto-start (e.g. another helper instance
// already holds the port, or Tailscale is down) only logs; the settings UI
// still shows the server as off.
func autoStartRemoteAccess(srv *remoteaccess.Server) {
	autoStart, bind := srv.AutoStartConfig()
	if !autoStart {
		return
	}
	go func() {
		if _, err := srv.Enable(methods.RemoteAccessEnableParams{Bind: bind}); err != nil {
			slog.Error("remoteaccess: auto-start failed", "bind", bind, "error", err)
		}
	}()
}

func (h *CamberHandler) remoteAccessServer() (*remoteaccess.Server, error) {
	if h.remoteAccess == nil {
		return nil, errRemoteAccessUnavailable
	}
	return h.remoteAccess, nil
}

var errRemoteAccessUnavailable = &methods.JSONRPCError{
	Code:    -32011,
	Message: "remote access is unavailable (state directory could not be initialized)",
}

func (h *CamberHandler) remoteAccessStatus(ctx context.Context, params *methods.RemoteAccessStatusParams, gCtx *glsp.Context) (methods.RemoteAccessStatus, error) {
	srv, err := h.remoteAccessServer()
	if err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	return srv.Status(), nil
}

func (h *CamberHandler) remoteAccessEnable(ctx context.Context, params *methods.RemoteAccessEnableParams, gCtx *glsp.Context) (methods.RemoteAccessStatus, error) {
	srv, err := h.remoteAccessServer()
	if err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	return srv.Enable(*params)
}

func (h *CamberHandler) remoteAccessDisable(ctx context.Context, params *methods.RemoteAccessDisableParams, gCtx *glsp.Context) (methods.RemoteAccessStatus, error) {
	srv, err := h.remoteAccessServer()
	if err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	if err := srv.Disable(); err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	// The auto-start toggle is only shown while the server runs, so an
	// explicit turn-off must clear it — otherwise a hidden preference would
	// resurrect the server on the next launch. Server.Disable itself must not
	// do this: it also runs on enable-restarts and helper shutdown.
	if err := srv.SetAutoStart(false, ""); err != nil {
		slog.Warn("remoteaccess: could not clear auto-start on disable", "error", err)
	}
	return srv.Status(), nil
}

func (h *CamberHandler) remoteAccessSetAutoStart(ctx context.Context, params *methods.RemoteAccessSetAutoStartParams, gCtx *glsp.Context) (methods.RemoteAccessStatus, error) {
	srv, err := h.remoteAccessServer()
	if err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	if err := srv.SetAutoStart(params.AutoStart, params.Bind); err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	return srv.Status(), nil
}

func (h *CamberHandler) remoteAccessCreatePairingCode(ctx context.Context, params *methods.RemoteAccessCreatePairingCodeParams, gCtx *glsp.Context) (methods.RemoteAccessPairingCode, error) {
	srv, err := h.remoteAccessServer()
	if err != nil {
		return methods.RemoteAccessPairingCode{}, err
	}
	return srv.CreatePairingCode()
}

func (h *CamberHandler) remoteAccessConfirmPairing(ctx context.Context, params *methods.RemoteAccessConfirmPairingParams, gCtx *glsp.Context) (methods.RemoteAccessStatus, error) {
	srv, err := h.remoteAccessServer()
	if err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	if err := srv.ConfirmPairing(params.PairingID, params.Code); err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	return srv.Status(), nil
}

func (h *CamberHandler) remoteAccessRevokeDevice(ctx context.Context, params *methods.RemoteAccessRevokeDeviceParams, gCtx *glsp.Context) (methods.RemoteAccessStatus, error) {
	srv, err := h.remoteAccessServer()
	if err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	if err := srv.RevokeDevice(params.DeviceID); err != nil {
		return methods.RemoteAccessStatus{}, err
	}
	return srv.Status(), nil
}
