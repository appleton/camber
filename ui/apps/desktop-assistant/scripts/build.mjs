import { execFileSync } from "node:child_process";

const pnpm = "pnpm";

if (process.env.SKIP_DESKTOP_TAURI_BUILD === "1") {
  // CI-only path (the UI Build gate sets this flag to skip the Rust/Tauri compile).
  // The `build` turbo task declares `dependsOn: ["build:web"]`, so turbo has already
  // run build:web (vite frontend + isolation) before this script. Re-running it here
  // just rebuilt the identical bundle a second time (~2 min of wasted CI work).
  console.log("Skipping desktop Tauri build; web assets already built by the build:web task.");
} else {
  runPnpm("download:binaries");
  runPnpm("tauri", "build");
}

function runPnpm(...args) {
  execFileSync(pnpm, args, { stdio: "inherit" });
}
