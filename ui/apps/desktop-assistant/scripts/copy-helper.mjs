import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCLI } from "./build-cli.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(scriptDir, "..");
const repoRoot = join(appDir, "..", "..", "..");
const binaryDir = join(appDir, "src-tauri", "binaries");
const helperRepository = process.env.CAMBER_HELPER_REPOSITORY || "appleton/camber";

const runtimeArtifactDir = process.env.CAMBER_RUNTIME_ARTIFACT_DIR;
if (runtimeArtifactDir && !existsSync(runtimeArtifactDir)) {
  throw new Error(`Release runtime artifact directory does not exist: ${runtimeArtifactDir}`);
}

const { refresh, targetInput } = parseArguments(process.argv.slice(2));
const targetTriple = targetTripleFromInput(targetInput);
const target = helperTarget(targetTriple);
const needsPublishedRuntime =
  process.env.CAMBER_DESKTOP_LOCAL_HELPER !== "1" ||
  supportsMLXSidecar(targetTriple) ||
  supportsWhisperServer(targetTriple);
const explicitHelperVersion = process.env.CAMBER_HELPER_VERSION;
const cachedHelperVersion =
  runtimeArtifactDir || explicitHelperVersion || refresh || !needsPublishedRuntime
    ? undefined
    : findCachedHelperVersion();
const helperVersion = runtimeArtifactDir
  ? undefined
  : (cachedHelperVersion ?? (needsPublishedRuntime ? resolveHelperVersion() : undefined));
const runtimeVersion = process.env.CAMBER_RUNTIME_VERSION ?? helperVersion ?? "source/unknown";
const downloadRuntimeAsset = runtimeArtifactDir
  ? copyReleaseRuntimeArtifact
  : downloadGitHubReleaseAsset;

mkdirSync(binaryDir, { recursive: true });
buildCLI(targetTriple);

if (cachedHelperVersion) {
  console.log(
    `Using cached release runtime ${cachedHelperVersion}; pass --refresh to check GitHub`,
  );
}

if (process.env.CAMBER_DESKTOP_LOCAL_HELPER === "1") {
  installLocalBazelBinary({
    binary: "camber-helper",
    label: "//cmd/camber-helper:camber-helper",
    installedName: `camber-helper-${targetTriple}${target.extension}`,
  });
} else {
  await installBinary({
    binary: "camber-helper",
    version: runtimeVersion,
    download: downloadRuntimeAsset,
    archiveName: `camber-helper-${target.platform}-${target.arch}.tar.gz`,
    extractedName: `camber-helper-${target.platform}-${target.arch}${target.extension}`,
    installedName: `camber-helper-${targetTriple}${target.extension}`,
  });
}
// Keep the Swift/MLX build explicit: normal desktop dev and camberqa launches
// should consume the prebuilt release sidecar.
if (process.env.CAMBER_DESKTOP_LOCAL_MLX_SIDECAR === "1") {
  installLocalMLXSidecar({ target, targetTriple });
} else {
  await installReleaseMLXSidecar({ target, targetTriple });
}
// whisper.cpp is not built from this repo. Local development takes it from the
// cached or highest permanent helper release; product releases use the
// canonical assets published for the current release SHA.
await installReleaseWhisperServer({ target, targetTriple });

async function installBinary({
  binary,
  version,
  download,
  archiveName,
  extractedName,
  installedName,
  requiredSiblings = [],
}) {
  const installedPath = join(binaryDir, installedName);
  const versionPath = `${installedPath}.version`;

  if (
    existsSync(installedPath) &&
    existsSync(versionPath) &&
    helperVersionsMatch(readFileSync(versionPath, "utf8").trim(), version) &&
    requiredSiblings.every((name) => fileExistsAndIsNonEmpty(join(binaryDir, name)))
  ) {
    console.log(`${installedName} is already present for ${version}`);
    return;
  }

  const archivePath = join(binaryDir, archiveName);
  const extractedPath = join(binaryDir, extractedName);

  await download({ version, archiveName, archivePath });
  execFileSync("tar", ["-xzf", archivePath, "-C", binaryDir], { stdio: "inherit" });

  if (!existsSync(extractedPath)) {
    throw new Error(`Expected ${extractedPath} after extracting ${archiveName}`);
  }
  for (const name of requiredSiblings) {
    if (!fileExistsAndIsNonEmpty(join(binaryDir, name))) {
      throw new Error(`Expected ${name} after extracting ${archiveName}`);
    }
  }

  if (extractedPath !== installedPath) {
    rmSync(installedPath, { force: true });
    renameSync(extractedPath, installedPath);
  }
  rmSync(archivePath, { force: true });

  execFileSync("chmod", ["+x", installedPath], { stdio: "inherit" });

  writeFileSync(versionPath, `${version}\n`);
  console.log(`Installed ${binary} as ${installedName} from ${version}`);
}

function fileExistsAndIsNonEmpty(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function installLocalBazelBinary({ binary, label, installedName }) {
  const hostTriple = targetTripleFromInput();
  if (hostTriple !== targetTriple) {
    throw new Error(
      `CAMBER_DESKTOP_LOCAL_HELPER=1 only supports host builds; host is ${hostTriple}, target is ${targetTriple}`,
    );
  }

  warnIfMobileWebUIMissing();
  console.log(`Building local ${binary} from ${label}`);
  execFileSync("bazelisk", ["build", label], { cwd: repoRoot, stdio: "inherit" });

  const builtPath = execFileSync("bazelisk", ["cquery", "--output=files", label], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!builtPath) {
    throw new Error(`Could not resolve built output for ${label}`);
  }

  const installedPath = join(binaryDir, installedName);
  // Bazel outputs are read-only and copyFileSync preserves that mode, so a
  // second install would fail with EACCES without removing the old copy.
  rmSync(installedPath, { force: true });
  copyFileSync(join(repoRoot, builtPath), installedPath);
  execFileSync("chmod", ["+x", installedPath], { stdio: "inherit" });
  writeFileSync(`${installedPath}.version`, "local\n");
  console.log(`Installed ${binary} as ${installedName} from local Bazel build`);
}

// A locally built helper embeds whatever is in the webui embed dir at build
// time, and a plain checkout has only the committed placeholders — so the
// helper silently serves the "no mobile UI bundle" page instead of the real
// remote UI. Released helpers never hit this (helper-build.yml runs the embed
// step), which makes it easy to mistake a local build's placeholder page for a
// regression. Warn rather than fail: most desktop work does not need the
// mobile UI, and building it is a ~6k-module Vite build.
function warnIfMobileWebUIMissing() {
  const embedDir = join(repoRoot, "pkg/camber-helper/internal/handler/remoteaccess/webui/dist");
  let entries = [];
  try {
    entries = readdirSync(embedDir).filter(
      (entry) => entry !== ".gitkeep" && entry !== ".gitignore",
    );
  } catch {
    return;
  }
  if (entries.length > 0) return;
  console.warn(
    "\nwarning: no mobile-remote UI bundle is embedded; this helper will serve\n" +
      "         a placeholder page for remote access. Build one first with:\n" +
      "           pnpm -F @camber/mobile-remote embed\n",
  );
}

async function installReleaseMLXSidecar({ target, targetTriple }) {
  const installedName = `camber-mlx-sidecar-${targetTriple}${target.extension}`;
  if (!supportsMLXSidecar(targetTriple)) {
    installPlaceholderBinary({
      installedName,
      version: "unsupported",
      reason: `MLX sidecar is not supported on ${targetTriple}`,
    });
    return;
  }

  try {
    await installBinary({
      binary: "camber-mlx-sidecar",
      version: runtimeVersion,
      download: downloadRuntimeAsset,
      archiveName: `camber-mlx-sidecar-${target.platform}-${target.arch}.tar.gz`,
      extractedName: `camber-mlx-sidecar-${target.platform}-${target.arch}${target.extension}`,
      installedName,
      requiredSiblings: ["default.metallib", "mlx.metallib"],
    });
  } catch (error) {
    if (runtimeArtifactDir) throw error;
    console.warn(`Unable to install camber-mlx-sidecar from ${runtimeVersion}: ${error.message}`);
    installPlaceholderBinary({
      installedName,
      version: `missing:${runtimeVersion}`,
      reason: `camber-mlx-sidecar is not present in ${runtimeVersion}`,
    });
  }
}

function installLocalMLXSidecar({ targetTriple }) {
  const target = helperTarget(targetTriple);
  const installedName = `camber-mlx-sidecar-${targetTriple}${target.extension}`;
  if (!supportsMLXSidecar(targetTriple)) {
    installPlaceholderBinary({
      installedName,
      version: "unsupported",
      reason: `MLX sidecar is not supported on ${targetTriple}`,
    });
    return;
  }

  const packagePath = join(repoRoot, "cmd", "camber-mlx-sidecar");
  console.log("Building local camber-mlx-sidecar from cmd/camber-mlx-sidecar");
  // build.sh shares a SwiftPM scratch path across worktrees, serializes
  // concurrent builds, and installs the binary and metallibs into binaryDir
  // while it still holds the build lock (so a rebuild from another worktree
  // cannot mutate them mid-copy).
  execFileSync(join(packagePath, "scripts", "build.sh"), [binaryDir], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const builtPath = join(binaryDir, "camber-mlx-sidecar");
  if (!existsSync(builtPath)) {
    throw new Error(`Expected ${builtPath} after Swift build`);
  }

  const installedPath = join(binaryDir, installedName);
  rmSync(installedPath, { force: true });
  renameSync(builtPath, installedPath);
  execFileSync("chmod", ["+x", installedPath], { stdio: "inherit" });
  writeFileSync(`${installedPath}.version`, "local\n");
  console.log(`Installed camber-mlx-sidecar as ${installedName} from local Swift build`);
}

async function installReleaseWhisperServer({ target, targetTriple }) {
  const installedName = `camber-whisper-server-${targetTriple}${target.extension}`;
  if (!supportsWhisperServer(targetTriple)) {
    installPlaceholderBinary({
      installedName,
      version: "unsupported",
      reason: `whisper-server is not supported on ${targetTriple}`,
    });
    return;
  }

  try {
    await installBinary({
      binary: "camber-whisper-server",
      version: runtimeVersion,
      download: downloadRuntimeAsset,
      archiveName: `camber-whisper-server-${target.platform}-${target.arch}.tar.gz`,
      extractedName: `camber-whisper-server-${target.platform}-${target.arch}${target.extension}`,
      installedName,
    });
  } catch (error) {
    if (runtimeArtifactDir) throw error;
    console.warn(
      `Unable to install camber-whisper-server from ${runtimeVersion}: ${error.message}`,
    );
    installPlaceholderBinary({
      installedName,
      version: `missing:${runtimeVersion}`,
      reason: `camber-whisper-server is not present in ${runtimeVersion}`,
    });
  }
}

function installPlaceholderBinary({ installedName, version, reason }) {
  const installedPath = join(binaryDir, installedName);
  writeFileSync(installedPath, "");
  execFileSync("chmod", ["+x", installedPath], { stdio: "inherit" });
  writeFileSync(`${installedPath}.version`, `${version}\n`);
  console.log(`Installed placeholder ${installedName}: ${reason}`);
}

function supportsMLXSidecar(triple) {
  return triple === "aarch64-apple-darwin";
}

// Whisper-server release assets are only built for Apple Silicon today; other
// targets get a placeholder and fall back to PATH/env resolution at runtime.
function supportsWhisperServer(triple) {
  return triple === "aarch64-apple-darwin";
}

function downloadGitHubReleaseAsset({ version, archiveName }) {
  execFileSync(
    "gh",
    [
      "release",
      "download",
      version,
      "--repo",
      helperRepository,
      "--pattern",
      archiveName,
      "--clobber",
      "--dir",
      binaryDir,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
}

function resolveHelperVersion() {
  return execFileSync("bash", [join(repoRoot, "scripts", "resolve-helper-release.sh")], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function findCachedHelperVersion() {
  const installedNames = [
    `camber-helper-${targetTriple}${target.extension}`,
    ...(supportsMLXSidecar(targetTriple)
      ? [`camber-mlx-sidecar-${targetTriple}${target.extension}`]
      : []),
    ...(supportsWhisperServer(targetTriple)
      ? [`camber-whisper-server-${targetTriple}${target.extension}`]
      : []),
  ];
  if (process.env.CAMBER_DESKTOP_LOCAL_HELPER === "1") {
    installedNames.shift();
  }

  const versions = installedNames.flatMap((installedName) => {
    const installedPath = join(binaryDir, installedName);
    const versionPath = `${installedPath}.version`;
    if (!fileExistsAndIsNonEmpty(installedPath) || !existsSync(versionPath)) return [];
    const version = normalizeHelperVersion(readFileSync(versionPath, "utf8").trim());
    return version ? [version] : [];
  });

  if (versions.length !== installedNames.length || new Set(versions).size !== 1) {
    return undefined;
  }
  if (
    supportsMLXSidecar(targetTriple) &&
    (!fileExistsAndIsNonEmpty(join(binaryDir, "default.metallib")) ||
      !fileExistsAndIsNonEmpty(join(binaryDir, "mlx.metallib")))
  ) {
    return undefined;
  }
  return versions[0];
}

function helperVersionsMatch(left, right) {
  if (left === right) return true;
  const normalizedLeft = normalizeHelperVersion(left);
  return normalizedLeft !== undefined && normalizedLeft === normalizeHelperVersion(right);
}

function normalizeHelperVersion(version) {
  if (/^helper\/v\d+\.\d+\.\d+$/u.test(version)) return version;
  if (/^\d+\.\d+\.\d+$/u.test(version)) return `helper/v${version}`;
  return undefined;
}

function copyReleaseRuntimeArtifact({ archiveName, archivePath }) {
  const sourcePath = join(runtimeArtifactDir, archiveName);
  if (!fileExistsAndIsNonEmpty(sourcePath)) {
    throw new Error(`Required release runtime artifact not found: ${sourcePath}`);
  }
  copyFileSync(sourcePath, archivePath);
}

function parseArguments(args) {
  const refresh = args.includes("--refresh") || process.env.CAMBER_HELPER_REFRESH === "1";
  const positional = args.filter((arg) => arg !== "--refresh");
  if (positional.length > 1) {
    throw new Error(`Unexpected arguments: ${positional.slice(1).join(" ")}`);
  }
  return { refresh, targetInput: positional[0] };
}

function targetTripleFromInput(input) {
  if (input) return normalizeTargetTriple(input);
  if (process.env.TARGET_TRIPLE) return normalizeTargetTriple(process.env.TARGET_TRIPLE);
  if (process.env.CARGO_BUILD_TARGET) return normalizeTargetTriple(process.env.CARGO_BUILD_TARGET);

  try {
    return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  } catch {
    const verbose = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
    const hostLine = verbose
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("host:"));
    if (!hostLine) {
      throw new Error("Could not determine Rust target triple");
    }
    return hostLine.slice("host:".length).trim();
  }
}

function normalizeTargetTriple(value) {
  switch (value) {
    case "darwin-x64":
      return "x86_64-apple-darwin";
    case "darwin-arm64":
      return "aarch64-apple-darwin";
    default:
      return value;
  }
}

function helperTarget(triple) {
  if (triple === "aarch64-apple-darwin") {
    return { platform: "darwin", arch: "arm64", extension: "" };
  }
  if (triple === "x86_64-apple-darwin") {
    return { platform: "darwin", arch: "amd64", extension: "" };
  }

  throw new Error(`Unsupported target triple: ${triple}`);
}
