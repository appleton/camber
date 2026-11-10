import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { desktopUpdate } from "../desktopUpdate";
import { initializeStatefulModule } from "../hostRpc";
import DesktopPreferencesSection from "./DesktopPreferencesSection.svelte";

type UpdateChannel = "stable" | "nightly";

interface StableSwitchResult {
  status: "alreadyStable" | "noUpdate" | "cancelled" | "staged";
  currentVersion: string;
  version?: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function desktopSettings(updateChannel: UpdateChannel) {
  return {
    themePreference: "system",
    chatFontSize: 15,
    codeFontFamily: "Menlo",
    codeFontFamilies: ["Menlo"],
    codeFontSize: 13,
    terminalFontFamily: "Menlo",
    terminalFontFamilies: ["Menlo"],
    terminalFontSize: 12,
    terminalCursorStyle: "block",
    toolActivity: "grouped",
    steerWithEnter: false,
    windowVibrancy: true,
    updateChannel,
    fileOpenerId: "default",
    fileOpeners: [],
  };
}

afterEach(() => {
  cleanup();
  desktopUpdate.set({ available: false, busy: false, downloading: false });
});

describe("DesktopPreferencesSection", () => {
  it("persists the Steer with Enter preference", async () => {
    let settings = desktopSettings("stable");
    const writes: boolean[] = [];

    initializeStatefulModule(async (method, args) => {
      if (method === "getDesktopSettings") return settings;
      if (method === "setDesktopSteerWithEnter") {
        const steerWithEnter = args[0] as boolean;
        writes.push(steerWithEnter);
        settings = { ...settings, steerWithEnter };
        return settings;
      }
      throw new Error(`Unexpected desktop RPC: ${method}`);
    });

    render(DesktopPreferencesSection);
    const preference = await screen.findByRole("switch", { name: "Steer with Enter" });
    expect(preference).not.toBeChecked();

    await fireEvent.click(preference);

    await waitFor(() => expect(writes).toEqual([true]));
    expect(preference).toBeChecked();
  });

  it("keeps preference toggles interactive while changes are being saved", async () => {
    const settings = desktopSettings("stable");
    const firstSteerSave = deferred<ReturnType<typeof desktopSettings>>();
    const secondSteerSave = deferred<ReturnType<typeof desktopSettings>>();
    const steerWrites: boolean[] = [];

    initializeStatefulModule(async (method, args) => {
      if (method === "getDesktopSettings") return settings;
      if (method === "setDesktopSteerWithEnter") {
        steerWrites.push(args[0] as boolean);
        return await (steerWrites.length === 1 ? firstSteerSave.promise : secondSteerSave.promise);
      }
      throw new Error(`Unexpected desktop RPC: ${method}`);
    });

    render(DesktopPreferencesSection);
    const steer = await screen.findByRole("switch", { name: "Steer with Enter" });

    await fireEvent.click(steer);
    expect(steer).toBeEnabled();
    expect(steer).toBeChecked();

    await fireEvent.click(steer);
    expect(steer).toBeEnabled();
    expect(steer).not.toBeChecked();
    expect(steerWrites).toEqual([true]);

    firstSteerSave.resolve({ ...settings, steerWithEnter: true });
    await waitFor(() => expect(steerWrites).toEqual([true, false]));
    secondSteerSave.resolve({ ...settings, steerWithEnter: false });
  });

  it("does not show a saving state for the preferred editor dropdown", async () => {
    const saveFileOpener = deferred<unknown>();
    const settings = {
      ...desktopSettings("stable"),
      fileOpeners: [
        { id: "default", label: "Default", kind: "default" as const },
        { id: "app:code", label: "Visual Studio Code", kind: "application" as const },
      ],
    };
    let writeCalls = 0;

    initializeStatefulModule(async (method) => {
      if (method === "getDesktopSettings") return settings;
      if (method === "setDesktopFileOpener") {
        writeCalls += 1;
        return await saveFileOpener.promise;
      }
      throw new Error(`Unexpected desktop RPC: ${method}`);
    });

    render(DesktopPreferencesSection);
    await fireEvent.click(await screen.findByRole("button", { name: "Open files in" }));
    await fireEvent.click(await screen.findByText("Visual Studio Code"));
    await waitFor(() => expect(writeCalls).toBe(1));

    expect(screen.queryByText("Saving")).not.toBeInTheDocument();

    saveFileOpener.resolve({ ...settings, fileOpenerId: "app:code" });
  });

  it("renders a compact Updates channel control after Default Layout", async () => {
    initializeStatefulModule(async (method) => {
      if (method === "getDesktopSettings") return desktopSettings("stable");
      throw new Error(`Unexpected desktop RPC: ${method}`);
    });

    render(DesktopPreferencesSection);

    const channelSelect = await screen.findByRole("combobox", { name: "Updates channel" });
    const defaultLayoutHeading = screen.getByRole("heading", { name: "Default Layout" });
    const updatesHeading = screen.getByRole("heading", { name: "Updates channel" });

    expect(channelSelect.parentElement).toHaveClass("max-w-[360px]");
    expect(
      screen.queryByText("Which release channel this app updates from"),
    ).not.toBeInTheDocument();
    expect(
      defaultLayoutHeading.compareDocumentPosition(updatesHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  const scenarios: Array<{
    name: string;
    settle: (operation: ReturnType<typeof deferred<StableSwitchResult>>) => void;
    expectedMessage: string;
  }> = [
    {
      name: "cancelled switch",
      settle: ({ resolve }) =>
        resolve({
          status: "cancelled",
          currentVersion: "1.3.0",
          version: "1.2.0",
        }),
      expectedMessage: "The Stable switch was cancelled, so Preview remains selected.",
    },
    {
      name: "missing Stable build",
      settle: ({ resolve }) =>
        resolve({
          status: "noUpdate",
          currentVersion: "1.3.0",
        }),
      expectedMessage: "No Stable build is currently available, so Preview remains selected.",
    },
    {
      name: "updater error",
      settle: ({ reject }) => reject(new Error("feed unavailable")),
      expectedMessage: "Couldn't switch to Stable: feed unavailable. Preview remains selected",
    },
  ];

  it.each(scenarios)(
    "keeps the selector locked and restores Preview after a $name",
    async ({ settle, expectedMessage }) => {
      const stableSwitch = deferred<StableSwitchResult>();
      const channelWrites: UpdateChannel[] = [];
      const messages: string[] = [];
      let switchCalls = 0;
      let settings = desktopSettings("nightly");

      initializeStatefulModule(async (method, args) => {
        switch (method) {
          case "getDesktopSettings":
            return settings;
          case "setDesktopUpdateChannel": {
            const updateChannel = args[0] as UpdateChannel;
            channelWrites.push(updateChannel);
            settings = desktopSettings(updateChannel);
            // The native command emits this event before its promise resolves.
            window.dispatchEvent(
              new CustomEvent("camber:desktop-settings-changed", { detail: settings }),
            );
            return settings;
          }
          case "switchDesktopToStable":
            switchCalls += 1;
            return await stableSwitch.promise;
          case "showInfoMessage":
            messages.push(args[0] as string);
            return;
          default:
            throw new Error(`Unexpected desktop RPC: ${method}`);
        }
      });

      render(DesktopPreferencesSection);
      const stableOption = await screen.findByRole("option", { name: "Stable (recommended)" });
      const channelSelect = stableOption.parentElement as HTMLSelectElement;
      await waitFor(() => expect(channelSelect).toHaveValue("nightly"));

      await fireEvent.change(channelSelect, { target: { value: "stable" } });
      await waitFor(() => expect(switchCalls).toBe(1));

      // The settings event above marks updateChannelStatus as saved. The
      // independent transition flag must keep the selector locked regardless.
      expect(channelSelect).toBeDisabled();
      expect(screen.getByText("Switching")).toBeInTheDocument();

      settle(stableSwitch);

      await waitFor(() => {
        expect(channelWrites).toEqual(["stable", "nightly"]);
        expect(channelSelect).toHaveValue("nightly");
        expect(channelSelect).toBeEnabled();
      });
      expect(messages.some((message) => message.includes(expectedMessage))).toBe(true);
    },
  );
});
