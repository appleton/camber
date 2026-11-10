import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest, ManifestChunk } from "vite";
import * as vscode from "vscode";
import { getCamberConfigurationSection } from "../api/configuration";
import { getExtensionIdentity } from "../extensionIdentity";
import { getInitialAppStateAsJSON } from "../state";
import type { System } from "../system";

// A packaged extension's manifest is immutable for this activation. Do not
// cache mutable initial state or dev-server URLs across views.
const releaseManifests = new WeakMap<vscode.ExtensionContext, Promise<Manifest>>();
function getReleaseManifest(context: vscode.ExtensionContext): Promise<Manifest> {
  let pending = releaseManifests.get(context);
  if (!pending) {
    const manifestPath = join(context.extensionPath, "dist", ".vite", "manifest.json");
    pending = readFile(manifestPath, "utf-8").then((content) => JSON.parse(content) as Manifest);
    releaseManifests.set(context, pending);
    void pending.catch(() => {
      if (releaseManifests.get(context) === pending) releaseManifests.delete(context);
    });
  }
  return pending;
}

interface InitialState {
  key: string;
  value: any;
}

function getImportedChunks(manifest: Manifest, chunk: ManifestChunk) {
  const seen = new Set<string>();

  function importedChunks(chunk: ManifestChunk) {
    const chunks: ManifestChunk[] = [];
    for (const file of chunk.imports ?? []) {
      const importee = manifest[file];
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);

      chunks.push(...importedChunks(importee));
      chunks.push(importee);
    }

    return chunks;
  }

  return importedChunks(chunk);
}

/**
 * Generates the HTML source required to render a webview for the given mainFile. Any InitialState
 * values passed to the initialStates parameter will be rendered into the global scope under the
 * provided key.
 */
export async function getWebviewHtml(
  system: System,
  webview: vscode.Webview,
  entry: "assistant" | "acp-chat" | "tasks",
  initialStates: InitialState[] = [],
) {
  let baseUri: vscode.Uri;
  let head = "";
  let src: string;
  let riveUri: string;
  let riveThinUri: string;
  let logoUri: string;
  let logoFaceUri: string;
  const identity = getExtensionIdentity();
  const production = system.context.extensionMode === vscode.ExtensionMode.Production;
  const devPort = process.env[identity.devPortEnvName] || "5173";
  const [initialAppState, manifest, devBaseUri] = await Promise.all([
    getInitialAppStateAsJSON(system),
    production ? getReleaseManifest(system.context) : undefined,
    production
      ? undefined
      : vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${devPort}/`)),
  ]);
  const editorConfig = vscode.workspace.getConfiguration("editor");
  const camberConfig = getCamberConfigurationSection();
  const customCodeFontSize = camberConfig.get<number>("codeFontSize") ?? 0;
  const editorFontSize =
    customCodeFontSize > 0 ? customCodeFontSize : (editorConfig.get<number>("fontSize") ?? 14);

  let lineHeight = editorConfig.get<number>("lineHeight") ?? 0;

  if (lineHeight === 0) {
    // Default to 1.5x font size
    lineHeight = Math.round(editorFontSize * 1.5);
  } else if (lineHeight > 0 && lineHeight < 8) {
    // Use as multiplier if less than 8
    lineHeight = Math.round(editorFontSize * lineHeight);
  }
  const editorLineHeight = lineHeight;

  if (manifest) {
    const entryChunk = manifest[`src/webview/${entry}.main.ts`];
    const importedChunks = getImportedChunks(manifest, entryChunk);
    const importedCssFiles = new Set(importedChunks.flatMap((chunk) => chunk.css || []));

    function createLinkTag<R extends string>(rel: R, href: string) {
      return `<link rel="${rel}" href="${href}" />` as const;
    }

    const entryStylesheets = (entryChunk.css ?? []).map((css) => createLinkTag("stylesheet", css));
    const importedStylesheets = Array.from(importedCssFiles).map((css) =>
      createLinkTag("stylesheet", css),
    );
    const preloads = importedChunks.map((chunk) => createLinkTag("modulepreload", chunk.file));

    baseUri = webview.asWebviewUri(vscode.Uri.joinPath(system.context.extensionUri, "dist", "/"));
    head = [...entryStylesheets, ...importedStylesheets, ...preloads].join("\n");
    src = entryChunk.file;
    riveUri = "resources/roundel-spinner.riv";
    riveThinUri = "resources/roundel-spinner-thin.riv";
    logoUri = "resources/camber-logo.glb";
    logoFaceUri = "resources/camber-logo-face.glb";
  } else {
    // Convert local Vite server URL to externally accessible URL for compatibility with remote port
    // forwarding used for remote tunnel access
    if (!devBaseUri) throw new Error("Missing webview asset base URI");
    baseUri = devBaseUri;
    src = `/src/webview/${entry}.main.ts`;
    riveUri = "/roundel-spinner.riv";
    riveThinUri = "/roundel-spinner-thin.riv";
    logoUri = "/camber-logo.glb";
    logoFaceUri = "/camber-logo-face.glb";
  }

  const notificationIconUri = webview
    .asWebviewUri(vscode.Uri.joinPath(system.context.extensionUri, "dist", "resources", "icon.png"))
    .toString();

  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="${baseUri.toString()}">
    ${head}
    <style type="text/css" class="editor-config">
      body {
        --editor-font-size: ${editorFontSize}px;
        --editor-line-height: ${editorLineHeight}px;
        min-height: 100vh;
      }
      .camber-dev-badge {
        position: fixed;
        top: 8px;
        right: 10px;
        z-index: 2147483647;
        padding: 3px 7px;
        border-radius: 4px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        font: 600 10px/1.2 var(--vscode-font-family);
        letter-spacing: 0;
        pointer-events: none;
      }
    </style>
  </head>
  <body>
    ${identity.isDev ? '<div class="camber-dev-badge">DEV</div>' : ""}
    <div id="app"></div>
    <script>
      (function() {
        function decode(base64) {
          const binary = atob(base64);
          const bytes = Uint8Array.from(binary, (m) => m.codePointAt(0));
          const json = new TextDecoder("utf-8").decode(bytes);
          return JSON.parse(json);
        }

        this.CAMBER_INITIAL_STATE = decode("${encode(initialAppState)}");
        ${initialStates.map((s) => `this.${s.key} = decode("${encode(JSON.stringify(s.value))}");`).join("\n")};
      }).call(this);

      // Add message handler for updateEditorConfig command
      window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'updateEditorConfig') {
          document.body.style.setProperty('--editor-font-size', message.fontSize + 'px');
          document.body.style.setProperty('--editor-line-height', message.lineHeight + 'px');
        }
      });

        window.riveUri = "${riveUri}";
        window.riveThinUri = "${riveThinUri}";
        window.notificationIconUri = "${notificationIconUri}";
        window.logoUri = "${logoUri}";
        window.logoFaceUri = "${logoFaceUri}";
    </script>
    <script type="module" src="${src}"></script>
  </body>
</html>`;
}

function encode(data: string) {
  return Buffer.from(data, "utf8").toString("base64");
}

export async function updateEditorConfig(system: System, webview: vscode.Webview) {
  const editorConfig = vscode.workspace.getConfiguration("editor");
  const camberConfig = getCamberConfigurationSection();
  const customCodeFontSize = camberConfig.get<number>("codeFontSize") ?? 0;
  const editorFontSize =
    customCodeFontSize > 0 ? customCodeFontSize : (editorConfig.get<number>("fontSize") ?? 14);

  let lineHeight = editorConfig.get<number>("lineHeight") ?? 0;

  if (lineHeight === 0) {
    // Default to 1.5x font size
    lineHeight = Math.round(editorFontSize * 1.5);
  } else if (lineHeight > 0 && lineHeight < 8) {
    // Use as multiplier if less than 8
    lineHeight = Math.round(editorFontSize * lineHeight);
  }
  const editorLineHeight = lineHeight;

  webview.postMessage({
    command: "updateEditorConfig",
    fontSize: editorFontSize,
    lineHeight: editorLineHeight,
  });
}
