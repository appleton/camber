import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAHOE_SDK_VERSION = "26.0";
const APP_BINARY_NAME = "desktop-assistant";

if (process.platform !== "darwin") {
  process.exit(0);
}

const appDir = fileURLToPath(new URL("..", import.meta.url));
const tauriDir = path.join(appDir, "src-tauri");
const tauriConfig = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
const appBinaryNames = [...new Set([tauriConfig.mainBinaryName, APP_BINARY_NAME].filter(Boolean))];
const targetDir = process.env.CAMBER_DESKTOP_TAURI_TARGET_DIR ?? path.join(tauriDir, "target");
const vtool = execFileSync("xcrun", ["-f", "vtool"], { encoding: "utf8" }).trim();
const binaryPath = findNewestReleaseBinary(targetDir, appBinaryNames);
const build = readBuildVersion(binaryPath);

if (Number.parseInt(build.sdk, 10) >= Number.parseInt(TAHOE_SDK_VERSION, 10)) {
  console.log(`macOS build SDK is already ${build.sdk}; leaving ${binaryPath} unchanged.`);
  process.exit(0);
}

// AppKit's Tahoe chrome metrics are gated by the linked SDK version. Patch only
// that metadata before Tauri bundles and signs the app; keep the original minos.
execFileSync(
  vtool,
  [
    "-set-build-version",
    "macos",
    build.minos,
    TAHOE_SDK_VERSION,
    "-replace",
    "-output",
    binaryPath,
    binaryPath,
  ],
  { stdio: "inherit" },
);

const patched = readBuildVersion(binaryPath);
console.log(
  `Updated macOS build SDK metadata for ${binaryPath}: minos ${patched.minos}, sdk ${build.sdk} -> ${patched.sdk}`,
);

function findNewestReleaseBinary(targetDir, binaryNames) {
  const candidates = releaseDirs(targetDir)
    .flatMap((releaseDir) => binaryNames.map((binaryName) => path.join(releaseDir, binaryName)))
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ path: candidate, mtime: statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) {
    throw new Error(
      `Could not find ${binaryNames.join(" or ")} in ${targetDir}/release or ${targetDir}/*/release`,
    );
  }

  return candidates[0].path;
}

function releaseDirs(targetDir) {
  if (!existsSync(targetDir)) return [];

  const dirs = [];
  const hostReleaseDir = path.join(targetDir, "release");
  if (existsSync(hostReleaseDir)) dirs.push(hostReleaseDir);

  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const releaseDir = path.join(targetDir, entry.name, "release");
    if (existsSync(releaseDir)) dirs.push(releaseDir);
  }

  return dirs;
}

function readBuildVersion(binaryPath) {
  const output = execFileSync(vtool, ["-show-build", binaryPath], { encoding: "utf8" });
  const minos = output.match(/^\s*minos\s+(\S+)/m)?.[1];
  const sdk = output.match(/^\s*sdk\s+(\S+)/m)?.[1];

  if (!minos || !sdk) {
    throw new Error(`Could not read macOS build version metadata from ${binaryPath}`);
  }

  return { minos, sdk };
}
