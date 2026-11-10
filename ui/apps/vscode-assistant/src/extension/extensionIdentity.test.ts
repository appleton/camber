import { createVSCodeMock } from "jest-mock-vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMBER,
  CAMBER_EXTENSION_ID,
  camberConfigurationKey,
  configureExtensionIdentity,
  getExtensionIdentity,
} from "./extensionIdentity";

vi.mock("vscode", () => createVSCodeMock(vi));

describe("extensionIdentity", () => {
  afterEach(() => {
    configureExtensionIdentity(CAMBER_EXTENSION_ID);
  });

  it("keeps normal Camber IDs unchanged", () => {
    configureExtensionIdentity(CAMBER_EXTENSION_ID);

    expect(getExtensionIdentity().camberName).toBe("camber");
    expect(getExtensionIdentity().isDev).toBe(false);
    expect(`${CAMBER}.open`).toBe("camber.open");
    expect(`${CAMBER}.webviewFocus`).toBe("camber.webviewFocus");
    expect(camberConfigurationKey("camber.uri")).toBe("camber.uri");
    expect(`${CAMBER}-roundel`).toBe("camber-roundel");
    expect(`${CAMBER}-webview.focus`).toBe("camber-webview.focus");
    expect(getExtensionIdentity().helperOutputChannelName).toBe("camber Helper");
    expect(getExtensionIdentity().telemetryOutputChannelName).toBe("camber");
  });

  it("passes a renamed production id through unchanged and keeps the camber namespace", () => {
    // Publishing under a new marketplace name must not break `@ext:` / marketplace
    // deep-links, and the static `contributes` namespace stays `camber.*`.
    configureExtensionIdentity("appleton.camber");

    expect(getExtensionIdentity().extensionId).toBe("appleton.camber");
    expect(getExtensionIdentity().isDev).toBe(false);
    expect(getExtensionIdentity().camberName).toBe("camber");
    expect(`${CAMBER}.open`).toBe("camber.open");
  });

  it("treats any -dev suffixed id as the dev variant", () => {
    configureExtensionIdentity("appleton.camber-dev");

    expect(getExtensionIdentity().extensionId).toBe("appleton.camber-dev");
    expect(getExtensionIdentity().isDev).toBe(true);
    expect(getExtensionIdentity().camberName).toBe("camber-dev");
  });

  it("maps dev Camber IDs to the dev namespace", () => {
    configureExtensionIdentity("appleton.camber-assistant-dev");

    expect(getExtensionIdentity().camberName).toBe("camber-dev");
    expect(getExtensionIdentity().isDev).toBe(true);
    expect(`${CAMBER}.open`).toBe("camber-dev.open");
    expect(`${CAMBER}.webviewFocus`).toBe("camber-dev.webviewFocus");
    expect(camberConfigurationKey("camber.uri")).toBe("camber-dev.uri");
    expect(`${CAMBER}-roundel`).toBe("camber-dev-roundel");
    expect(`${CAMBER}-webview.focus`).toBe("camber-dev-webview.focus");
    expect(getExtensionIdentity().helperOutputChannelName).toBe("camber Helper-dev");
    expect(getExtensionIdentity().telemetryOutputChannelName).toBe("camber-dev");
  });
});
