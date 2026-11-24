import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));

export function buildCLI(targetTriple) {
  const target =
    targetTriple ??
    execFileSync("rustc", ["--print", "host-tuple"], {
      encoding: "utf8",
    }).trim();
  const goos = target.includes("apple-darwin")
    ? "darwin"
    : target.includes("windows")
      ? "windows"
      : target.includes("linux")
        ? "linux"
        : undefined;
  const goarch = target.startsWith("aarch64-")
    ? "arm64"
    : target.startsWith("x86_64-")
      ? "amd64"
      : undefined;
  if (!goos || !goarch) throw new Error(`Unsupported CLI target: ${target}`);

  const binaryDir = join(appDir, "src-tauri", "binaries");
  const extension = goos === "windows" ? ".exe" : "";
  const installedPath = join(binaryDir, `camber-${target}${extension}`);
  const temporaryPath = `${installedPath}.${process.pid}.tmp`;
  mkdirSync(binaryDir, { recursive: true });
  try {
    execFileSync(
      process.env.CAMBER_GO_BINARY || "go",
      ["build", "-trimpath", "-ldflags=-s -w", "-o", temporaryPath, "./cmd/camber"],
      {
        cwd: join(appDir, "..", "..", ".."),
        env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
        stdio: "inherit",
      },
    );
    renameSync(temporaryPath, installedPath);
    // The unsuffixed name lets agents launched by a development desktop find
    // the same CLI on PATH. Cross-built binaries must not replace the host CLI.
    const hostOS = process.platform === "win32" ? "windows" : process.platform;
    const hostArch = process.arch === "x64" ? "amd64" : process.arch;
    if (goos === hostOS && goarch === hostArch) {
      const devPath = join(binaryDir, `camber${extension}`);
      rmSync(devPath, { force: true });
      copyFileSync(installedPath, devPath);
      if (process.platform !== "win32") chmodSync(devPath, 0o755);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  console.log(`Built Camber CLI: ${installedPath}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildCLI(process.argv[2]);
}
