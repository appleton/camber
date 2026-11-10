import { createHash } from "crypto";
import { parseHTML } from "linkedom";
import * as vscode from "vscode";
import type { System } from "../system";

export type AcpTabIconStatus = "default" | "working" | "unread" | "waiting";
export type AcpTabIconTheme = "dark" | "light";

const DEFAULT_AGENT_SERVER = "poolside";
const ALL_STATUSES: AcpTabIconStatus[] = ["default", "working", "unread", "waiting"];
const MAX_ICON_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

const AGENT_ICON_COLORS: Record<AcpTabIconTheme, string> = {
  dark: "#E2E2E2",
  light: "#757779",
};

const STATUS_COLORS: Record<AcpTabIconStatus, Record<AcpTabIconTheme, string>> = {
  default: {
    dark: AGENT_ICON_COLORS.dark,
    light: AGENT_ICON_COLORS.light,
  },
  working: {
    dark: "#3794FF",
    light: "#3794FF",
  },
  unread: {
    dark: "#3794FF",
    light: "#3794FF",
  },
  waiting: {
    dark: "#CCA700",
    light: "#CCA700",
  },
};

const BADGE_COLORS: Record<AcpTabIconTheme, { background: string; foreground: string }> = {
  dark: {
    background: "#1E1E1E",
    foreground: "#E2E2E2",
  },
  light: {
    background: "#FFFFFF",
    foreground: "#424242",
  },
};

const SAFE_SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "symbol",
  "use",
  "defs",
  "title",
  "desc",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
]);

const CAMBER_ROUNDEL_PATH =
  "M2.79989 4.28935C3.08545 4.30563 3.38729 4.35252 3.6872 4.43901C4.26898 4.60679 4.86742 4.93164 5.32869 5.49021C6.07132 4.41058 7.38408 2.897 9.5541 1.80342C7.02181 1.16559 4.32457 2.14725 2.79989 4.28935ZM10.6818 2.50457C8.52349 3.42283 7.19739 4.81149 6.42473 5.86549C6.55114 5.88522 6.68012 5.91639 6.81029 5.96135C7.38777 6.16083 7.91236 6.60506 8.31385 7.36098C9.16663 7.21815 9.84147 7.38666 10.3486 7.74954C10.4376 7.81323 10.5194 7.88143 10.5944 7.95279C10.9265 6.58122 11.1892 4.56348 10.6818 2.50457ZM11.5594 8.65807C12.2935 8.66124 12.9303 8.91364 13.4333 9.25555C13.6924 9.43169 13.9215 9.63517 14.1154 9.84671C14.8845 7.31115 13.9928 4.5559 11.9094 2.94735C12.3037 5.20925 11.9262 7.32808 11.5594 8.65807ZM13.6202 11.035C13.4779 10.7842 13.2033 10.4427 12.8086 10.1744C12.3186 9.84131 11.6815 9.64563 10.9203 9.8578C10.7777 9.89757 10.6251 9.87873 10.4964 9.80547C10.3676 9.73222 10.2735 9.61061 10.2349 9.46764C10.1606 9.19306 9.99509 8.86284 9.70202 8.65314C9.45995 8.47992 9.05988 8.33789 8.38478 8.47773L5.70379 13.9607C8.68375 15.1126 12.0897 13.874 13.6202 11.035ZM4.70562 13.4727C2.74197 12.2937 1.61273 10.1871 1.6111 7.99965C1.61087 7.69283 1.36196 7.44428 1.05514 7.44451C0.748316 7.44474 0.499772 7.69365 0.5 8.00048C0.502058 10.7713 2.04697 13.436 4.70617 14.7363C8.42648 16.5554 12.9171 15.0141 14.7362 11.2938C16.5553 7.57352 15.014 3.08294 11.2937 1.26384C7.57339 -0.555254 3.08281 0.985986 1.26372 4.7063C1.16501 4.90816 1.19763 5.1496 1.34635 5.31804C1.49507 5.48647 1.73062 5.54874 1.94315 5.47579C2.1911 5.39069 2.77593 5.3326 3.37932 5.50661C3.95837 5.67359 4.50814 6.0387 4.80352 6.75858C4.85974 6.89559 4.96833 7.00448 5.10519 7.06107C5.24204 7.11766 5.39583 7.11727 5.53239 7.05999C5.78122 6.95561 6.11963 6.8983 6.44751 7.01156C6.72576 7.10768 7.07959 7.35536 7.38696 7.98895L4.70562 13.4727Z";

export interface SanitizedSvgMask {
  viewBox: string;
  innerHTML: string;
}

export class AcpTabIconProvider {
  private readonly inFlight = new Map<string, Promise<vscode.Uri>>();
  private readonly iconPathByAgentStatus = new Map<string, vscode.WebviewPanel["iconPath"]>();
  private readonly rawSvgByUrl = new Map<string, Promise<string>>();

  constructor(private readonly system: System) {}

  async iconPathForAgent(
    agentServer: string | undefined,
    agentIconUrl: string | undefined,
    status: AcpTabIconStatus,
  ): Promise<vscode.WebviewPanel["iconPath"] | undefined> {
    if (!canUseAgentIcon(agentServer, agentIconUrl)) return undefined;

    const cached = this.cachedIconPathForAgent(agentServer, agentIconUrl, status);
    if (cached) return cached;

    await this.prepareAgentIcon(agentIconUrl);
    return this.cachedIconPathForAgent(agentServer, agentIconUrl, status);
  }

  cachedIconPathForAgent(
    agentServer: string | undefined,
    agentIconUrl: string | undefined,
    status: AcpTabIconStatus,
  ): vscode.WebviewPanel["iconPath"] | undefined {
    if (!canUseAgentIcon(agentServer, agentIconUrl)) return undefined;
    return this.iconPathByAgentStatus.get(agentStatusKey(agentIconUrl, status));
  }

  private async prepareAgentIcon(agentIconUrl: string): Promise<void> {
    await Promise.all(
      ALL_STATUSES.map((status) => this.prepareAgentStatusIcon(agentIconUrl, status)),
    );
  }

  private async prepareAgentStatusIcon(
    agentIconUrl: string,
    status: AcpTabIconStatus,
  ): Promise<void> {
    const key = agentStatusKey(agentIconUrl, status);
    if (this.iconPathByAgentStatus.has(key)) return;

    const [dark, light] = await Promise.all([
      this.iconUri(agentIconUrl, status, "dark"),
      this.iconUri(agentIconUrl, status, "light"),
    ]);
    this.iconPathByAgentStatus.set(key, { dark, light });
  }

  private iconUri(
    agentIconUrl: string,
    status: AcpTabIconStatus,
    theme: AcpTabIconTheme,
  ): Promise<vscode.Uri> {
    const key = cacheKey(agentIconUrl, status, theme);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.writeIcon(agentIconUrl, status, theme, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async writeIcon(
    agentIconUrl: string,
    status: AcpTabIconStatus,
    theme: AcpTabIconTheme,
    key: string,
  ): Promise<vscode.Uri> {
    const rawSvg = await this.fetchIcon(agentIconUrl);
    const sanitized = sanitizeSvgForMask(rawSvg);
    const svg = composeAcpTabIconSvg(sanitized, {
      mainColor: AGENT_ICON_COLORS[theme],
      badge: {
        ...BADGE_COLORS[theme],
        foreground: STATUS_COLORS[status][theme],
      },
    });

    // WebviewPanel icons reject vscode-userdata: image URIs under CSP, so write
    // and return a file: URI for generated tab icons.
    const storageDirectory = vscode.Uri.joinPath(
      this.system.context.globalStorageUri,
      "acp-tab-icons",
    );
    const directory = vscode.Uri.file(storageDirectory.fsPath);
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, `${key}.svg`);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(svg));
    return uri;
  }

  private fetchIcon(agentIconUrl: string): Promise<string> {
    const existing = this.rawSvgByUrl.get(agentIconUrl);
    if (existing) return existing;

    const promise = fetchSvg(agentIconUrl).catch((error) => {
      this.rawSvgByUrl.delete(agentIconUrl);
      throw error;
    });
    this.rawSvgByUrl.set(agentIconUrl, promise);
    return promise;
  }
}

export function sanitizeSvgForMask(svg: string): SanitizedSvgMask {
  const document = parseHTML(svg).document;
  const root = document.querySelector("svg");
  if (!root) {
    throw new Error("agent icon is not an SVG");
  }

  const viewBox =
    root.getAttribute("viewBox") ??
    root.getAttribute("viewbox") ??
    viewBoxFromDimensions(root.getAttribute("width"), root.getAttribute("height"));
  if (!viewBox) {
    throw new Error("agent icon SVG is missing a viewBox");
  }

  for (const element of Array.from(root.querySelectorAll("*"))) {
    sanitizeElement(element);
  }
  sanitizeElement(root);

  return {
    viewBox,
    innerHTML: root.innerHTML,
  };
}

export function composeAcpTabIconSvg(
  agent: SanitizedSvgMask,
  options: { mainColor: string; badge: { background: string; foreground: string } },
): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <mask id="agent-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
      <rect width="16" height="16" fill="black"/>
      <svg x="1" y="1" width="12.75" height="12.75" viewBox="${escapeAttribute(agent.viewBox)}" preserveAspectRatio="xMidYMid meet" fill="white" stroke="white" color="white">
        ${agent.innerHTML}
      </svg>
    </mask>
  </defs>
  <rect width="16" height="16" fill="${options.mainColor}" mask="url(#agent-mask)"/>
  <circle cx="12.5" cy="12.5" r="3.5" fill="${options.badge.background}"/>
  <g transform="translate(9.4 9.4) scale(0.39)">
    <path fill-rule="evenodd" clip-rule="evenodd" d="${CAMBER_ROUNDEL_PATH}" fill="${options.badge.foreground}"/>
  </g>
</svg>
`;
}

async function fetchSvg(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: "image/svg+xml,text/xml,application/xml,text/plain;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`agent icon request failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/\b(svg|xml|text\/plain)\b/i.test(contentType)) {
      throw new Error(`agent icon response is not SVG: ${contentType}`);
    }

    const text = await readResponseWithLimit(response, MAX_ICON_BYTES);
    if (!/^\s*(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
      throw new Error("agent icon response body is not SVG");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("agent icon response is too large");
    }
    return text;
  }

  let received = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      throw new Error("agent icon response is too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function sanitizeElement(element: Element): void {
  const tagName = element.tagName.toLowerCase();
  if (!SAFE_SVG_ELEMENTS.has(tagName)) {
    throw new Error(`agent icon SVG contains unsupported element: ${tagName}`);
  }

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;

    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (name === "src" || name === "href" || name === "xlink:href") {
      if (name !== "src" && value.trim().startsWith("#")) {
        continue;
      }
      throw new Error("agent icon SVG contains external references");
    }

    if (name === "style") {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (/javascript:/i.test(value) || (/\burl\(/i.test(value) && !isLocalSvgReference(value))) {
      throw new Error("agent icon SVG contains unsafe references");
    }

    if ((name === "fill" || name === "stroke") && value.toLowerCase() !== "none") {
      element.setAttribute(attribute.name, "white");
    }
  }
}

function isSupportedIconUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function canUseAgentIcon(
  agentServer: string | undefined,
  agentIconUrl: string | undefined,
): agentIconUrl is string {
  return Boolean(
    agentIconUrl && agentServer !== DEFAULT_AGENT_SERVER && isSupportedIconUrl(agentIconUrl),
  );
}

function agentStatusKey(agentIconUrl: string, status: AcpTabIconStatus): string {
  return `${agentIconUrl}\0${status}`;
}

function isLocalSvgReference(value: string): boolean {
  return /^url\(\s*["']?#[^)]+["']?\s*\)$/i.test(value);
}

function viewBoxFromDimensions(width: string | null, height: string | null): string | undefined {
  const parsedWidth = parseSvgLength(width);
  const parsedHeight = parseSvgLength(height);
  if (!parsedWidth || !parsedHeight) return undefined;
  return `0 0 ${parsedWidth} ${parsedHeight}`;
}

function parseSvgLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function cacheKey(agentIconUrl: string, status: AcpTabIconStatus, theme: AcpTabIconTheme): string {
  return createHash("sha256")
    .update(`${agentIconUrl}\0${status}\0${theme}`)
    .digest("hex")
    .slice(0, 32);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
