/**
 * Run from the repo root with the committed benchmarks present.
 * Temporarily switches only the two listed implementation files; do not edit
 * those files concurrently. Restores their original contents even on failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const paths = [
  "pkg/camber-helper/internal/handler/initialize.go",
  "pkg/camber-helper/internal/handler/acpnav/store.go",
];
const after = new Map(paths.map((path) => [path, readFileSync(path)]));
const before = new Map(
  paths.map((path) => [path, execFileSync("git", ["show", `90b316a69:${path}`])]),
);
const rows = [];
const output = process.argv[2] ?? "/tmp/camber-l5-matched.json";
try {
  for (let trial = 0; trial < 3; trial++) {
    for (const phase of trial % 2 ? ["after", "before"] : ["before", "after"]) {
      for (const [path, content] of phase === "before" ? before : after)
        writeFileSync(path, content);
      const log = execFileSync(
        "go",
        [
          "test",
          "./pkg/camber-helper/internal/handler",
          "./pkg/camber-helper/internal/handler/acpnav",
          "-run",
          "^$",
          "-bench",
          "Benchmark(InitializeReady|OpenUpgrade)",
          "-benchtime=20x",
          "-benchmem",
          "-count=1",
        ],
        {
          encoding: "utf8",
          timeout: 55_000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            CAMBER_REMOTE_ACCESS_STATE: "/tmp/camber-performance-test-remote.json",
          },
        },
      );
      writeFileSync(`${output}.${trial}.${phase}.log`, log);
      let name;
      for (const line of log.split("\n")) {
        if (line.startsWith("Benchmark")) name = line.split(/\s+/)[0];
        const match = line.match(/\b20\s+(\d+) ns\/op\s+(\d+) B\/op\s+(\d+) allocs\/op/);
        if (match)
          rows.push({
            phase,
            trial,
            name,
            nanosecondsPerIteration: +match[1],
            bytesPerIteration: +match[2],
            allocationsPerIteration: +match[3],
          });
      }
      writeFileSync(output, JSON.stringify(rows, null, 2) + "\n");
    }
  }
} finally {
  for (const [path, content] of after) writeFileSync(path, content);
}
