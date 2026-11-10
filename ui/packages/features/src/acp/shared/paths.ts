import { normalize, relative } from "@camber/lib/path";
import type { WorkspaceFolder } from "@camber/rpc";

const NO_CONTEXT_PREFIX = "/path/to/";

export function getFilenameFromPath(path: string): string {
  return toPosixPath(path).split("/").pop() || "";
}

export function getBasename(path: string): string {
  return getFilenameFromPath(path);
}

export function getDirname(path: string): string {
  return toPosixPath(path).split("/").slice(0, -1).join("/");
}

export function removeRootPathFromFilename(
  filename: string,
  workspaces: WorkspaceFolder[],
): string {
  filename = normalize(filename);
  const workspace = workspaces.find((candidate) => filename.startsWith(normalize(candidate.path)));

  return workspace ? relative(normalize(workspace.path), filename) : filename;
}

export function getReadableFileInfo(
  givenPath: string,
  workspaces: WorkspaceFolder[],
  homeDirectory?: string,
): { filePath: string; fileName: string; absolutePath: string } {
  if (!givenPath) return { filePath: "", fileName: "", absolutePath: "" };

  const path = fileUriToPath(givenPath) ?? givenPath;
  const { relativePath, absolutePath } = expandRelativePath(path, workspaces);
  const filePath = relativePath ?? shortenHomePath(absolutePath, homeDirectory);
  const fileName = relativePath ? getFilenameFromPath(relativePath) : filePath;

  if (!relativePath && path.startsWith("/workspace/")) {
    const fileName = path.split("/").at(-1) || path;
    return { filePath: path, fileName, absolutePath };
  }

  return { filePath, fileName, absolutePath };
}

/**
 * Shorten home-directory paths embedded in UI-owned labels such as a tool
 * title or shell-command header. Opaque tool input/output stays verbatim.
 * The host supplies the exact home directory; this does not infer a username
 * from a platform-specific path pattern.
 */
export function shortenHomeDirectoryInText(value: string, homeDirectory?: string): string {
  const normalizedHome = homeDirectory ? toPosixPath(homeDirectory).replace(/\/+$/, "") : "";
  if (!normalizedHome) return value;

  let shortened = replacePathPrefix(value, `file://${normalizedHome}`, "~");
  shortened = replacePathPrefix(shortened, normalizedHome, "~");

  const originalHome = homeDirectory?.replace(/[\\/]+$/, "") ?? "";
  if (originalHome && originalHome !== normalizedHome) {
    shortened = replacePathPrefix(shortened, originalHome, "~");
  }

  return shortened;
}

/** Apply the same workspace-first precedence as {@link getReadableFileInfo} to paths in labels. */
export function shortenDirectoryPathsInText(
  value: string,
  workspaces: WorkspaceFolder[],
  homeDirectory?: string,
): string {
  let shortened = value;
  const workspacePaths = workspaces
    .map((workspace) => workspace.path.replace(/[\\/]+$/, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const workspacePath of workspacePaths) {
    const normalizedWorkspace = toPosixPath(workspacePath);
    shortened = replacePathPrefix(shortened, `file://${normalizedWorkspace}`, ".");
    shortened = replacePathPrefix(shortened, normalizedWorkspace, ".");
    if (workspacePath !== normalizedWorkspace) {
      shortened = replacePathPrefix(shortened, workspacePath, ".");
    }
  }

  return shortenHomeDirectoryInText(shortened, homeDirectory);
}

function replacePathPrefix(value: string, pathPrefix: string, replacement: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const index = value.indexOf(pathPrefix, cursor);
    if (index < 0) return result + value.slice(cursor);

    const previous = value[index - 1];
    const next = value[index + pathPrefix.length];
    const startsAtPathBoundary = previous === undefined || !/[A-Za-z0-9._~\\/-]/.test(previous);
    const endsAtPathBoundary = next === undefined || next === "/" || next === "\\";

    if (startsAtPathBoundary && endsAtPathBoundary) {
      result += value.slice(cursor, index) + replacement;
      cursor = index + pathPrefix.length;
    } else {
      result += value.slice(cursor, index + pathPrefix.length);
      cursor = index + pathPrefix.length;
    }
  }

  return result;
}

function fileUriToPath(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return;

    const path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1);
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
    return path;
  } catch {
    return;
  }
}

function shortenHomePath(path: string, homeDirectory: string | undefined): string {
  const normalizedHome = homeDirectory ? toPosixPath(homeDirectory).replace(/\/+$/, "") : "";
  if (!normalizedHome || (path !== normalizedHome && !path.startsWith(`${normalizedHome}/`))) {
    return path;
  }
  return path === normalizedHome ? "~" : `~${path.slice(normalizedHome.length)}`;
}

export function expandRelativePath(
  givenPath: string,
  workspaces: WorkspaceFolder[],
): { absolutePath: string; relativePath?: string } {
  const absolutePath = toAbsolutePosixPath(givenPath, workspaces);

  if (!isPathAbsolute(absolutePath)) {
    return {
      relativePath: givenPath,
      absolutePath,
    };
  }

  for (const workspace of workspaces) {
    const workspacePath = toPosixPath(workspace.path).replace(/\/+$/, "");
    if (absolutePath === workspacePath || absolutePath.startsWith(`${workspacePath}/`)) {
      const relPath = absolutePath.substring(workspacePath.length);
      return {
        relativePath: `.${relPath}`,
        absolutePath,
      };
    }
  }

  return { absolutePath };
}

export function toAbsolutePosixPath(osPath: string, workspaces: WorkspaceFolder[]): string {
  return toAbsolutePath(toPosixPath(osPath), workspaces);
}

function toAbsolutePath(givenPath: string, workspaces: WorkspaceFolder[]): string {
  if (isPathAbsolute(givenPath) || workspaces.length === 0) {
    return givenPath;
  }

  const workspacePath = toPosixPath(workspaces[0].path);

  if (givenPath.startsWith(NO_CONTEXT_PREFIX)) {
    givenPath = givenPath.replace(/^\/path\/to/, workspacePath);
  }

  if (givenPath.startsWith("/") || givenPath.substring(1, 3) === ":/") {
    return givenPath;
  }

  if (givenPath.startsWith("./")) {
    givenPath = givenPath.substring(2);
  } else if (givenPath === ".") {
    givenPath = "";
  }

  return workspacePath + "/" + givenPath;
}

function toPosixPath(osPath: string): string {
  return osPath.replaceAll("\\", "/");
}

function isPathAbsolute(givenPath: string): boolean {
  return (
    (givenPath.startsWith("/") && !givenPath.startsWith(NO_CONTEXT_PREFIX)) ||
    givenPath.substring(1, 3) === ":/" ||
    givenPath.substring(1, 3) === ":\\"
  );
}
