import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesktopRemoteAccessSection from "./DesktopRemoteAccessSection.svelte";

const jsonrpcCall = vi.hoisted(() => vi.fn());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

// The component uses the hand-written helperapi bindings; funnel them all
// through one method-keyed mock so scenarios keep dispatching on the method.
vi.mock("@camber/helperapi", () => ({
  camberRemoteAccessStatus: () => jsonrpcCall("camber/remoteAccess/status", {}),
  camberRemoteAccessEnable: (params: object) => jsonrpcCall("camber/remoteAccess/enable", params),
  camberRemoteAccessDisable: () => jsonrpcCall("camber/remoteAccess/disable", {}),
  camberRemoteAccessSetAutoStart: (params: object) =>
    jsonrpcCall("camber/remoteAccess/setAutoStart", params),
  camberRemoteAccessCreatePairingCode: () =>
    jsonrpcCall("camber/remoteAccess/createPairingCode", {}),
  camberRemoteAccessConfirmPairing: (params: object) =>
    jsonrpcCall("camber/remoteAccess/confirmPairing", params),
  camberRemoteAccessRevokeDevice: (params: object) =>
    jsonrpcCall("camber/remoteAccess/revokeDevice", params),
}));

interface StatusOverrides {
  enabled?: boolean;
  bind?: string;
  port?: number;
  urls?: string[];
  autoStart?: boolean;
  autoStartBind?: string;
  tls?: { mode: string; warning?: string; caUrl?: string };
  tailscale?: {
    cliInstalled: boolean;
    interfaceUp: boolean;
    backendState?: string;
    dnsName?: string;
    httpsEnabled: boolean;
    certCached: boolean;
    error?: string;
  };
}

function mockStatus(overrides: StatusOverrides = {}) {
  jsonrpcCall.mockImplementation(async (method: string) => {
    if (method === "camber/remoteAccess/status") {
      return {
        enabled: false,
        devices: [],
        connectedClients: 0,
        ...overrides,
      };
    }
    throw new Error(`unexpected call: ${method}`);
  });
}

describe("DesktopRemoteAccessSection", () => {
  beforeEach(() => {
    jsonrpcCall.mockReset();
  });

  it("explains and blocks turn-on when Tailscale is absent entirely", async () => {
    mockStatus({
      tailscale: {
        cliInstalled: false,
        interfaceUp: false,
        httpsEnabled: false,
        certCached: false,
        error: "Tailscale CLI not found",
      },
    });
    render(DesktopRemoteAccessSection);

    await waitFor(() => {
      expect(screen.getByText(/Tailscale isn't set up on this computer/)).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /Get Tailscale/ })).toHaveAttribute(
      "href",
      "https://tailscale.com/download",
    );
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();
  });

  it("guides enabling tailnet HTTPS certificates but keeps turn-on available", async () => {
    mockStatus({
      tailscale: {
        cliInstalled: true,
        interfaceUp: true,
        backendState: "Running",
        dnsName: "mac.tailnet.ts.net",
        httpsEnabled: false,
        certCached: false,
      },
    });
    render(DesktopRemoteAccessSection);

    await waitFor(() => {
      expect(screen.getByText(/can't issue HTTPS certificates yet/)).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /Step-by-step guide/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeEnabled();
  });

  it("announces readiness and first-enable latency when no cert is cached", async () => {
    mockStatus({
      tailscale: {
        cliInstalled: true,
        interfaceUp: true,
        backendState: "Running",
        dnsName: "mac.tailnet.ts.net",
        httpsEnabled: true,
        certCached: false,
      },
    });
    render(DesktopRemoteAccessSection);

    await waitFor(() => {
      expect(
        screen.getByText(/Tailscale is ready — this desktop is mac.tailnet.ts.net/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/10–15 seconds/)).toBeInTheDocument();
  });

  it("shows certificate install steps for the local-CA mode", async () => {
    mockStatus({
      enabled: true,
      bind: "all",
      port: 8737,
      urls: ["https://192.168.1.20:8737"],
      tls: { mode: "localCA", caUrl: "https://192.168.1.20:8737/ca.crt" },
    });
    render(DesktopRemoteAccessSection);

    await waitFor(() => {
      expect(screen.getByText(/Remote access is on/)).toBeInTheDocument();
    });
    expect(screen.getByText(/One-time phone setup/)).toBeInTheDocument();
    expect(screen.getByText("https://192.168.1.20:8737/ca.crt")).toBeInTheDocument();
    expect(screen.getByText(/Certificate Trust Settings/)).toBeInTheDocument();
  });

  it("surfaces a degraded-TLS warning from the helper", async () => {
    mockStatus({
      enabled: true,
      bind: "tailscale",
      port: 8737,
      urls: ["https://100.64.0.5:8737"],
      tls: {
        mode: "localCA",
        caUrl: "https://100.64.0.5:8737/ca.crt",
        warning: "Couldn't get a trusted Tailscale certificate (boom).",
      },
      tailscale: {
        cliInstalled: true,
        interfaceUp: true,
        backendState: "Running",
        httpsEnabled: false,
        certCached: false,
      },
    });
    render(DesktopRemoteAccessSection);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't get a trusted Tailscale certificate/)).toBeInTheDocument();
    });
    // The warning includes the remediation for the root cause.
    expect(screen.getByText(/enable HTTPS certificates for your tailnet/)).toBeInTheDocument();
  });

  it("hides the keep-open toggle while the server is off", async () => {
    mockStatus({});
    render(DesktopRemoteAccessSection);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("switch", { name: "Keep remote access open on startup" }),
    ).not.toBeInTheDocument();
  });

  it("persists keep-open-on-startup with the running bind when toggled on", async () => {
    const base = {
      enabled: true,
      bind: "all",
      port: 8737,
      urls: ["https://192.168.1.20:8737"],
      devices: [],
      connectedClients: 0,
    };
    const save = deferred<typeof base & { autoStart: boolean; autoStartBind?: string }>();
    jsonrpcCall.mockImplementation(async (method: string, _params?: object) => {
      if (method === "camber/remoteAccess/status") return { ...base };
      if (method === "camber/remoteAccess/setAutoStart") {
        return await save.promise;
      }
      throw new Error(`unexpected call: ${method}`);
    });
    render(DesktopRemoteAccessSection);

    const toggle = await screen.findByRole("switch", {
      name: "Keep remote access open on startup",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await fireEvent.click(toggle);

    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await waitFor(() => {
      expect(jsonrpcCall).toHaveBeenCalledWith("camber/remoteAccess/setAutoStart", {
        autoStart: true,
        // The bind the server is currently running on becomes the auto-start bind.
        bind: "all",
      });
    });
    save.resolve({ ...base, autoStart: true, autoStartBind: "all" });
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Keep remote access open on startup" }),
      ).toHaveAttribute("aria-checked", "true");
    });
  });

  it("reflects a persisted keep-open preference", async () => {
    mockStatus({
      enabled: true,
      bind: "tailscale",
      port: 8737,
      urls: ["https://mac.tailnet.ts.net:8737"],
      autoStart: true,
      autoStartBind: "tailscale",
    });
    render(DesktopRemoteAccessSection);

    const toggle = await screen.findByRole("switch", {
      name: "Keep remote access open on startup",
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("documents the reverse-proxy escape hatch for loopback", async () => {
    mockStatus({
      enabled: true,
      bind: "loopback",
      port: 8737,
      urls: ["http://127.0.0.1:8737"],
      tls: { mode: "plainHttp" },
    });
    render(DesktopRemoteAccessSection);

    await waitFor(() => {
      expect(screen.getByText(/bring your own tunnel/)).toBeInTheDocument();
    });
    expect(screen.getByText("tailscale serve")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:8737")).toBeInTheDocument();
  });
});
