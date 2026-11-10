import { escape } from "html-escaper";
import visualizationStyles from "./visualization.css?inline";

const CDNS = [
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://fonts.bunny.net",
].join(" ");

export const VISUALIZATION_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS}`,
  `img-src data: blob: ${CDNS}`,
  `font-src data: ${CDNS}`,
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function buildVisualizationDocument(
  fragment: string,
  foreground: string,
  background: string,
): string {
  // Each frame has an opaque origin. The trusted wrapper's frame-src policy
  // blocks navigation of the untrusted frame, including navigation that would
  // discard its own meta CSP. Never place agent markup directly in the wrapper.
  // The returned wrapper also requires sandbox="allow-scripts" (no same-origin).
  const innerDocument = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escape(VISUALIZATION_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${visualizationStyles}</style></head>
<body style="${escape(`--foreground:${foreground};--background:${background}`)}">
<script>
(() => {
  let previousHeight = 0;
  const reportSize = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== previousHeight) {
      previousHeight = height;
      parent.postMessage({type: 'camber:visualization-size', height}, '*');
    }
  };
  new ResizeObserver(reportSize).observe(document.body);
  window.addEventListener('load', reportSize);
})();
</script>
${fragment}
</body></html>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escape(VISUALIZATION_CSP)}">
<style>html,body{margin:0}iframe{display:block;width:100%;height:240px;border:0}</style>
</head><body>
<iframe title="Visualization content" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(innerDocument)}"></iframe>
<script>
(() => {
  const frame = document.querySelector('iframe');
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data?.type !== 'camber:visualization-size' ||
        typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
    const height = Math.min(1600, Math.max(80, data.height));
    frame.style.height = height + 'px';
    parent.postMessage({type: 'camber:visualization-size', height}, '*');
  });
})();
</script></body></html>`;
}
