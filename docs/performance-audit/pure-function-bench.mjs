// Synthetic CPU scaling probe; these are Node/V8 timings, not UI frame timings.
// Build @camber/components first, then run with node from any directory.
import {
  chunkSettledMarkdown,
  segmentStreamingMarkdown,
} from "../../ui/packages/components/dist/components/markdown/streamingMarkdown.js";
import { computeVirtualWindow } from "../../ui/packages/components/dist/components/virtual-list/virtualWindow.js";

const results = [];
let consumed = 0;
function bench(name, fn, metadata) {
  for (let i = 0; i < 10; i++) consumed += fn();
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    consumed += fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results.push({ name, ...metadata, p50ms: samples[25], p95ms: samples[47], maxMs: samples[49] });
}
for (const chars of [32768, 262144, 1048576]) {
  for (const kind of ["paragraphs", "openFence"]) {
    const line =
      kind === "paragraphs"
        ? "Some text with **formatting**, [links](https://example.com), and several ordinary words.\n\n"
        : "const answer = calculate(value, options); // an ordinary line of source code\n";
    const body = line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
    const source = (kind === "openFence" ? "```typescript\n" : "") + body;
    bench("segmentStreamingMarkdown", () => segmentStreamingMarkdown(source).length, {
      kind,
      chars: source.length,
      settledChunks: chunkSettledMarkdown(source).length,
    });
  }
}
for (const count of [1000, 10000, 100000]) {
  bench(
    "computeVirtualWindow",
    () =>
      computeVirtualWindow({
        count,
        heightFor: (i) => 80 + (i % 10),
        scrollTop: count * 40,
        viewportHeight: 900,
        overscanPx: 2400,
        pinEnd: false,
      }).start,
    { count },
  );
}
console.log(
  JSON.stringify({ runtime: process.version, warmup: 10, samples: 50, results, consumed }, null, 2),
);
