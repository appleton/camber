<script lang="ts">
  import qrcode from "qrcode-generator";

  import { Button } from "@camber/components/button";
  import { Switch } from "@camber/components/switch";
  import {
    camberRemoteAccessConfirmPairing,
    camberRemoteAccessCreatePairingCode,
    camberRemoteAccessDisable,
    camberRemoteAccessEnable,
    camberRemoteAccessRevokeDevice,
    camberRemoteAccessSetAutoStart,
    camberRemoteAccessStatus,
    type RemoteAccessPairingCode,
    type RemoteAccessStatus,
  } from "@camber/helperapi";

  type BindMode = "loopback" | "tailscale" | "all";

  let status = $state<RemoteAccessStatus | null>(null);
  let bind = $state<BindMode>("tailscale");
  let pairing = $state<RemoteAccessPairingCode | null>(null);
  let error = $state("");
  // Errors from user actions (enable, confirm, revoke…) are sticky: the
  // background status poll must not wipe them before they can be read. Poll
  // errors are transient and clear on the next successful poll.
  let stickyError = false;
  let busy = $state(false);
  // enabling distinguishes the (potentially slow, ~10-15s on first Tailscale
  // certificate issuance) turn-on call from other busy actions, so the panel
  // can show what it is waiting on.
  let enabling = $state(false);
  let desiredAutoStart = $state<boolean | null>(null);
  let autoStartSaveToken = 0;
  let autoStartSaveQueue: Promise<void> = Promise.resolve();
  let autoStartChecked = $derived(desiredAutoStart ?? status?.autoStart ?? false);
  let confirmationCode = $state("");
  let showPairUrl = $state(false);
  // The bind radio starts on the persisted auto-start bind (if any) the first
  // time status loads, so the selection mirrors what a relaunch would do.
  let bindInitialized = false;

  function clearError() {
    error = "";
    stickyError = false;
  }

  function setActionError(e: unknown) {
    error = errorMessage(e);
    stickyError = true;
  }

  // The desktop host RPC flattens helper errors into a plain object
  // ({ message, code, data }), so `instanceof Error` is false and String(e)
  // would render "[object Object]". Pull the message out of whatever we get.
  function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === "object" && e !== null) {
      const msg = (e as { message?: unknown }).message;
      if (typeof msg === "string" && msg) return msg;
      try {
        return JSON.stringify(e);
      } catch {
        return String(e);
      }
    }
    return String(e);
  }

  function isBindMode(value: string | undefined): value is BindMode {
    return value === "loopback" || value === "tailscale" || value === "all";
  }

  function applyStatus(next: RemoteAccessStatus) {
    status = next;
    if (!bindInitialized) {
      bindInitialized = true;
      if (!next.enabled && isBindMode(next.autoStartBind)) {
        bind = next.autoStartBind;
      }
    }
  }

  async function refresh() {
    try {
      applyStatus(await camberRemoteAccessStatus());
      if (!stickyError) error = "";
    } catch (e) {
      if (!stickyError) error = errorMessage(e);
    }
  }

  async function enable() {
    busy = true;
    enabling = true;
    clearError();
    try {
      applyStatus(await camberRemoteAccessEnable({ bind }));
    } catch (e) {
      setActionError(e);
    } finally {
      busy = false;
      enabling = false;
    }
  }

  async function disable() {
    busy = true;
    clearError();
    pairing = null;
    try {
      applyStatus(await camberRemoteAccessDisable());
    } catch (e) {
      setActionError(e);
    } finally {
      busy = false;
    }
  }

  async function setAutoStart(autoStart: boolean) {
    const token = ++autoStartSaveToken;
    desiredAutoStart = autoStart;
    clearError();
    // Auto-start reuses the running bind when the server is on, otherwise the
    // mode currently selected in the radio group. Capture it with this click
    // so queued toggles preserve user order without locking the switch.
    const autoStartBind = status?.enabled && isBindMode(status.bind) ? status.bind : bind;
    const operation = autoStartSaveQueue.then(async () => {
      const next = await camberRemoteAccessSetAutoStart(
        autoStart ? { autoStart: true, bind: autoStartBind } : { autoStart: false },
      );
      applyStatus(next);
    });
    autoStartSaveQueue = operation.catch(() => undefined);
    try {
      await operation;
      if (token === autoStartSaveToken) desiredAutoStart = null;
    } catch (e) {
      if (token === autoStartSaveToken) {
        desiredAutoStart = null;
        setActionError(e);
      }
    }
  }

  async function createPairingCode() {
    busy = true;
    clearError();
    confirmationCode = "";
    showPairUrl = false;
    try {
      pairing = await camberRemoteAccessCreatePairingCode();
    } catch (e) {
      setActionError(e);
    } finally {
      busy = false;
    }
  }

  async function confirmPairing(pairingId: string) {
    busy = true;
    clearError();
    try {
      applyStatus(
        await camberRemoteAccessConfirmPairing({
          pairingId,
          code: confirmationCode.trim(),
        }),
      );
      pairing = null;
      confirmationCode = "";
      showPairUrl = false;
    } catch (e) {
      setActionError(e);
    } finally {
      busy = false;
    }
  }

  async function revoke(deviceId: string) {
    busy = true;
    clearError();
    try {
      applyStatus(await camberRemoteAccessRevokeDevice({ deviceId }));
    } catch (e) {
      setActionError(e);
    } finally {
      busy = false;
    }
  }

  // Poll status while the section is mounted so connected-device state stays live.
  $effect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pairing ? 1500 : 4000);
    return () => clearInterval(timer);
  });

  const pairUrl = $derived.by(() => {
    if (!pairing?.urls?.length) return null;
    return `${pairing.urls[0]}/#pair=${pairing.code}`;
  });

  // Render the pairing URL as a QR the phone camera can scan — generated
  // locally so the URL never leaves this machine.
  const qrSvg = $derived.by(() => {
    if (!pairUrl) return "";
    try {
      const qr = qrcode(0, "M");
      qr.addData(pairUrl);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      return "";
    }
  });

  const pendingPairing = $derived(status?.pendingPairings?.[0] ?? null);

  const ts = $derived(status?.tailscale ?? null);
  const tlsInfo = $derived(status?.tls ?? null);

  // The recommended path is fully ready: CLI reachable, backend connected,
  // and the tailnet can issue trusted certificates.
  const tailscaleReady = $derived(
    ts !== null && ts.cliInstalled && ts.backendState === "Running" && ts.httpsEnabled,
  );

  // Without a Tailscale interface the tailscale bind cannot listen at all;
  // don't offer a button that can only fail.
  const enableBlocked = $derived(bind === "tailscale" && ts !== null && !ts.interfaceUp);

  const enablingMessage = $derived.by(() => {
    if (!enabling) return "";
    if (bind === "tailscale" && tailscaleReady && !ts?.certCached) {
      return "Issuing a trusted HTTPS certificate via Let's Encrypt — the first time takes 10–15 seconds…";
    }
    return "Turning on…";
  });

  const bindLabels: Record<string, string> = {
    tailscale: "Tailscale",
    all: "Local network",
    loopback: "This computer only",
  };

  const securitySummary = $derived.by(() => {
    if (!tlsInfo) return "";
    switch (tlsInfo.mode) {
      case "trusted":
        return "trusted HTTPS (Tailscale certificate)";
      case "localCA":
        return "HTTPS with this desktop's own certificate";
      case "plainHttp":
        return status?.bind === "loopback" ? "plain HTTP (local connections only)" : "plain HTTP";
      default:
        return "";
    }
  });

  const cardClass = "border-psx-border rounded-[10px] border p-3";
  const titleClass = "text-psx-foreground-primary text-sm font-medium";
  const subClass = "text-psx-foreground-secondary text-[13px]/[18px]";
  const warningClass =
    "border-psx-border text-psx-warning-foreground rounded-[10px] border p-3 text-[13px]/[18px]";
  const linkClass = "text-psx-link underline decoration-transparent hover:decoration-current";
  const codeClass = "bg-psx-menu-hover-background rounded px-1 py-0.5";
</script>

<div class="flex max-w-[620px] flex-col gap-3 px-3 py-2">
  <p class={subClass}>
    Control this desktop's conversations from your phone. Paired phones can chat and answer
    permission prompts, but cannot read secrets or change settings. Every phone must be paired by
    scanning a QR code here and confirmed on this desktop.
  </p>

  {#if error}
    <p class="text-psx-error-foreground text-[13px]/[18px]">{error}</p>
  {/if}

  {#if status?.enabled}
    <div class={cardClass}>
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span
              class="bg-psx-diff-insert-foreground size-2 shrink-0 rounded-full"
              aria-hidden="true"
            ></span>
            <span class={titleClass}>Remote access is on</span>
          </div>
          <div class={subClass}>
            {bindLabels[status.bind ?? ""] ?? status.bind}
            {#if securitySummary}
              · {securitySummary}{/if}
            · {status.connectedClients} connected
          </div>
        </div>
        <Button
          type="button"
          appearance="outline"
          size="sm"
          class="ui-standard:text-psx-error-foreground ui-standard:hover:text-psx-error-foreground shrink-0"
          onclick={disable}
          disabled={busy}
        >
          Turn off
        </Button>
      </div>

      <div class="border-psx-border mt-3 flex items-center justify-between gap-3 border-t pt-3">
        <div class="min-w-0">
          <div class={titleClass}>Keep open on startup</div>
          <p class={subClass}>Turn remote access back on when Camber Assistant starts.</p>
        </div>
        <Switch
          checked={autoStartChecked}
          disabled={busy}
          onCheckedChange={(value) => void setAutoStart(value)}
          aria-label="Keep remote access open on startup"
        />
      </div>
    </div>

    {#if tlsInfo?.warning}
      <div class={warningClass}>
        {tlsInfo.warning}
        {#if !ts?.httpsEnabled && status.bind === "tailscale"}
          To fix this, enable HTTPS certificates for your tailnet (Tailscale admin console → DNS →
          HTTPS Certificates), then turn remote access off and on again.
          <a
            class={linkClass}
            href="https://tailscale.com/kb/1153/enabling-https"
            target="_blank"
            rel="noreferrer"
          >
            Tailscale HTTPS guide
          </a>
        {/if}
      </div>
    {/if}

    {#if tlsInfo?.mode === "localCA" && tlsInfo.caUrl}
      <div class={cardClass}>
        <div class={titleClass}>One-time phone setup: trust this desktop's certificate</div>
        <p class="{subClass} mt-1">
          Without a service like Tailscale there is no public authority that can vouch for this
          desktop, so it signs its own HTTPS certificate. Your phone needs to trust it once —
          otherwise the page may load after a warning, but the live connection is silently refused.
        </p>
        <ol class="{subClass} mt-2 flex list-decimal flex-col gap-1.5 pl-4">
          <li>
            On the phone, open <span class="text-psx-link select-all break-all"
              >{tlsInfo.caUrl}</span
            >
            and download the certificate. The browser will warn that the connection isn't private — that's
            expected on first contact; continue anyway.
          </li>
          <li>
            iPhone: install it under Settings → General → VPN &amp; Device Management, then enable
            full trust under Settings → General → About → Certificate Trust Settings.
          </li>
          <li>
            Android: install it via Settings → Security → Encryption &amp; credentials → Install a
            certificate → CA certificate.
          </li>
          <li>Come back here and pair the phone below — the warnings are gone for good.</li>
        </ol>
      </div>
    {/if}

    {#if status.bind === "loopback"}
      <div class={cardClass}>
        <div class={titleClass}>Local only — bring your own tunnel</div>
        <p class="{subClass} mt-1">
          The server listens on 127.0.0.1:{status.port} and phones cannot reach it directly. To expose
          it, run your own reverse proxy or tunnel that terminates TLS with a certificate the phone trusts
          (for example <code class={codeClass}>tailscale serve</code>, Caddy, or nginx). Point it at
          <code class={codeClass}>http://127.0.0.1:{status.port}</code>; it must forward WebSocket
          upgrades and pass the <code class={codeClass}>Host</code> header through unchanged, or connections
          will be rejected as cross-origin.
        </p>
      </div>
    {/if}

    <div class="flex flex-col gap-3">
      <div>
        <Button type="button" size="sm" onclick={createPairingCode} disabled={busy}>
          Pair a new phone
        </Button>
      </div>
      {#if pendingPairing}
        <div class="{cardClass} text-center">
          <div class={titleClass}>{pendingPairing.deviceName} is requesting access</div>
          <div class={subClass}>Type the code shown on the phone to finish pairing.</div>
          <form
            class="mb-2 mt-3 flex gap-2"
            onsubmit={(event) => {
              event.preventDefault();
              void confirmPairing(pendingPairing.id);
            }}
          >
            <input
              bind:value={confirmationCode}
              placeholder="Code from phone"
              inputmode="numeric"
              autocomplete="one-time-code"
              spellcheck="false"
              autocorrect="off"
              autocapitalize="off"
              class="border-psx-input-border bg-psx-input-background text-psx-input-foreground placeholder:text-psx-input-placeholder-foreground focus-visible:outline-psx-focus min-w-0 flex-1 rounded-[6px] border px-2 py-1.5 text-center text-[13px]/[18px] focus-visible:outline-2"
            />
            <Button
              type="submit"
              prominence="increased"
              size="sm"
              disabled={busy || confirmationCode.trim().length === 0}
            >
              Confirm
            </Button>
          </form>
          <div class={subClass}>
            Expires {new Date(pendingPairing.expiresAt).toLocaleTimeString()}.
          </div>
        </div>
      {:else if pairing}
        <div class="{cardClass} text-center">
          {#if qrSvg}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- locally generated QR SVG, no user HTML -->
            <div class="remote-qr mx-auto mb-2.5 size-[180px] rounded-[8px] bg-white p-2.5">
              {@html qrSvg}
            </div>
            <div class={subClass}>Scan with your phone camera.</div>
          {/if}
          {#if pairUrl && showPairUrl}
            <div class="text-psx-link my-1.5 select-all break-all text-[13px]/[18px]">
              {pairUrl}
            </div>
          {/if}
          {#if pairUrl}
            <button
              type="button"
              class="{linkClass} mt-2 cursor-pointer text-[13px]/[18px]"
              onclick={() => (showPairUrl = !showPairUrl)}
            >
              {showPairUrl ? "Hide link" : "Show link"}
            </button>
          {/if}
          <div class={subClass}>The QR disappears after the phone scans it.</div>
        </div>
      {/if}
    </div>

    <div class={cardClass}>
      <h3 class={titleClass}>Paired devices</h3>
      {#if status.devices.length === 0}
        <div class="{subClass} mt-1">No devices paired yet.</div>
      {/if}
      {#each status.devices as device (device.id)}
        <div class="border-psx-border mt-2 flex items-center justify-between gap-3 border-t pt-2">
          <div class="min-w-0">
            <div class="text-psx-foreground-primary text-[13px]/[18px] font-medium">
              {device.name}
              {#if device.connected}
                <span class="text-psx-diff-insert-foreground ml-1.5 text-[11px]">connected</span>
              {/if}
            </div>
            <div class={subClass}>paired {new Date(device.createdAt).toLocaleString()}</div>
          </div>
          <Button
            type="button"
            appearance="outline"
            size="sm"
            class="ui-standard:text-psx-error-foreground ui-standard:hover:text-psx-error-foreground shrink-0"
            onclick={() => revoke(device.id)}
            disabled={busy}
          >
            Revoke
          </Button>
        </div>
      {/each}
    </div>
  {:else}
    <fieldset class="m-0 flex flex-col gap-2 border-none p-0" disabled={busy}>
      <legend class="{titleClass} pb-1.5">How should your phone reach this desktop?</legend>

      <label
        class={[
          "flex cursor-pointer items-start gap-2.5 rounded-[10px] border p-3",
          bind === "tailscale"
            ? "border-psx-focus bg-psx-menu-hover-background"
            : "border-psx-border",
        ]}
      >
        <input
          type="radio"
          name="remote-bind"
          value="tailscale"
          bind:group={bind}
          class="accent-psx-focus mt-0.5"
        />
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class={titleClass}>
            Tailscale
            <span
              class="bg-psx-menu-hover-background text-psx-foreground-secondary ml-1 rounded-full px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide"
            >
              recommended
            </span>
          </span>
          <span class={subClass}>
            Reachable only inside your private Tailscale network, with a trusted HTTPS certificate
            issued automatically. No router changes, works from anywhere your tailnet does.
          </span>
        </span>
      </label>

      <label
        class={[
          "flex cursor-pointer items-start gap-2.5 rounded-[10px] border p-3",
          bind === "all" ? "border-psx-focus bg-psx-menu-hover-background" : "border-psx-border",
        ]}
      >
        <input
          type="radio"
          name="remote-bind"
          value="all"
          bind:group={bind}
          class="accent-psx-focus mt-0.5"
        />
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class={titleClass}>Local network</span>
          <span class={subClass}>
            Reachable by devices on the same Wi-Fi. No extra software, but the phone must trust this
            desktop's certificate once (~2 minutes), and anyone on the network can see the pairing
            page.
          </span>
        </span>
      </label>

      <label
        class={[
          "flex cursor-pointer items-start gap-2.5 rounded-[10px] border p-3",
          bind === "loopback"
            ? "border-psx-focus bg-psx-menu-hover-background"
            : "border-psx-border",
        ]}
      >
        <input
          type="radio"
          name="remote-bind"
          value="loopback"
          bind:group={bind}
          class="accent-psx-focus mt-0.5"
        />
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class={titleClass}>This computer only</span>
          <span class={subClass}>
            Listens on 127.0.0.1. For testing in a browser on this machine, or for advanced setups
            with your own reverse proxy or tunnel in front.
          </span>
        </span>
      </label>
    </fieldset>

    {#if bind === "tailscale" && ts}
      {#if !ts.cliInstalled && !ts.interfaceUp}
        <div class={warningClass}>
          Tailscale isn't set up on this computer. It's a free private network between your own
          devices and the easiest secure path: install it on this computer and your phone, sign both
          into the same account, and come back here.
          <a
            class={linkClass}
            href="https://tailscale.com/download"
            target="_blank"
            rel="noreferrer"
          >
            Get Tailscale
          </a>
          — or pick another option above.
        </div>
      {:else if !ts.cliInstalled && ts.interfaceUp}
        <div class={warningClass}>
          A Tailscale network is up, but the <code class={codeClass}>tailscale</code> command wasn't
          found, so a trusted certificate can't be issued. You can still turn on — the phone will need
          to trust this desktop's own certificate (instructions will appear here).
        </div>
      {:else if ts.backendState !== "Running"}
        <div class={warningClass}>
          Tailscale is installed but not connected{ts.backendState ? ` (${ts.backendState})` : ""}.
          Open the Tailscale app and sign in, then come back here.
        </div>
      {:else if !ts.httpsEnabled}
        <div class={warningClass}>
          Your tailnet can't issue HTTPS certificates yet, and without one the phone's live
          connection is silently refused. Enable HTTPS certificates in the Tailscale admin console
          (DNS → HTTPS Certificates → Enable), wait a minute, then turn on here.
          <a
            class={linkClass}
            href="https://tailscale.com/kb/1153/enabling-https"
            target="_blank"
            rel="noreferrer"
          >
            Step-by-step guide
          </a>
        </div>
      {:else}
        <div class="text-psx-diff-insert-foreground text-[13px]/[18px]">
          Tailscale is ready{ts.dnsName ? ` — this desktop is ${ts.dnsName}` : ""}.
          {#if !ts.certCached}
            The first turn-on issues a certificate and can take 10–15 seconds.
          {/if}
        </div>
      {/if}
    {/if}

    <div class="flex items-center justify-between gap-3">
      <div class={subClass}>
        {#if enablingMessage}
          <span class="text-psx-foreground-primary">{enablingMessage}</span>
        {/if}
      </div>
      <Button
        type="button"
        prominence="increased"
        size="sm"
        class="shrink-0"
        onclick={enable}
        disabled={busy || enableBlocked}
        title={enableBlocked ? "Tailscale is not connected on this computer" : undefined}
      >
        {enabling ? "Turning on…" : "Turn on"}
      </Button>
    </div>
  {/if}
</div>

<style>
  /* qrcode-generator emits a scalable SVG; fill the white plate so it scans. */
  .remote-qr :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
    shape-rendering: crispedges;
  }
</style>
