import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { appState } from "../../hostAdapter";
import { initializeStatefulModule } from "../../hostRpc";
import Harness from "./ConfirmationDialog.test.svelte";

function setNativeConfirmDialogCapability(enabled: boolean): void {
  appState.update((state) => ({
    ...state,
    environment: {
      ...state.environment,
      capabilities: { ...state.environment.capabilities, nativeConfirmDialog: enabled },
    },
  }));
}

describe("ConfirmationDialog", () => {
  afterEach(() => {
    setNativeConfirmDialogCapability(false);
  });

  it("renders the message from a plain JSON-RPC error object", async () => {
    render(Harness, {
      props: {
        error: {
          code: -32602,
          message: "conversation is no longer bound to the handoff source session",
        },
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Hand Off" }));

    expect(
      await screen.findByText("conversation is no longer bound to the handoff source session"),
    ).toBeVisible();
    expect(screen.queryByText("[object Object]")).toBeNull();
  });

  it("renders the optional detail row", () => {
    render(Harness, {
      props: { error: new Error("unused"), detail: "~/models/foo" },
    });

    expect(screen.getByText("~/models/foo")).toBeVisible();
  });

  it("delegates to the host dialog when the nativeConfirmDialog capability is set", async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    initializeStatefulModule((method, args) => {
      calls.push({ method, args });
      return Promise.resolve(method === "showNativeConfirmDialog" ? true : undefined);
    });
    setNativeConfirmDialogCapability(true);

    render(Harness, {
      props: { error: { code: -32602, message: "handoff failed" } },
    });

    // No DOM modal renders; the confirmed action runs and its failure
    // surfaces through the native error dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(calls.map((call) => call.method)).toEqual([
        "showNativeConfirmDialog",
        "showNativeErrorDialog",
      ]);
    });
    expect(calls[0].args[0]).toEqual({
      title: "Hand off to Camber?",
      description: "A new Camber session will continue with context from this conversation.",
      confirmLabel: "Hand Off",
      destructive: false,
    });
    expect(calls[1].args[0]).toEqual({
      title: "Hand off to Camber?",
      message: "handoff failed",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("falls back to the DOM dialog when the native dialog fails", async () => {
    initializeStatefulModule(() => Promise.reject(new Error("dialog.ask not allowed")));
    setNativeConfirmDialogCapability(true);

    render(Harness, { props: { error: new Error("unused") } });

    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Hand Off" })).toBeVisible();
  });
});
