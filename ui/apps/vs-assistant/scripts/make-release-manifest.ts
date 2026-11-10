#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Stamp the release version into the VSIX source manifest and the webview
 * package.json in-place, ahead of the MSBuild packaging step.
 *
 * The tag-driven release flow is the source of truth for the version, so CI
 * injects it into an ephemeral working copy that is never committed. Nightly
 * builds are marked as Preview in the extension metadata; the version's
 * odd/even minor is an internal convention, the Preview flag is what the
 * Marketplace and the installer surface to users.
 */

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    channel: { type: "string" },
  },
});

if (!values.version) {
  throw new Error("--version <x.y.z> is required");
}
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(values.version)) {
  throw new Error("--version must be numeric major.minor.patch without prerelease metadata");
}
if (values.channel !== "stable" && values.channel !== "nightly") {
  throw new Error("--channel must be stable or nightly");
}
const preview = values.channel === "nightly";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifestPath = path.join(extensionRoot, "source.extension.vsixmanifest");
let manifest = fs.readFileSync(manifestPath, "utf8");

const identityVersion = /(<Identity\b[^>]*\bVersion=")[^"]*(")/u;
if (!identityVersion.test(manifest)) {
  throw new Error(`No Identity Version attribute in ${manifestPath}`);
}
manifest = manifest.replace(identityVersion, `$1${values.version}$2`);

const previewElement = /(<Preview>)[^<]*(<\/Preview>)/u;
if (!previewElement.test(manifest)) {
  throw new Error(`No Preview element in ${manifestPath}`);
}
manifest = manifest.replace(previewElement, `$1${preview}$2`);

fs.writeFileSync(manifestPath, manifest);

const packagePath = path.join(extensionRoot, "app", "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.version = values.version;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

// The VSIX packages ReleaseNotes.html, whose tracked content describes the
// last stable release. A nightly would otherwise ship those stale notes, so
// point its readers at the GitHub release instead. Stable releases keep the
// curated file.
if (preview) {
  const repository = pkg.repository?.url?.replace(/\.git$/u, "");
  if (!repository) {
    throw new Error(`No repository URL in ${packagePath}`);
  }
  const releaseUrl = `${repository}/releases/tag/vs-assistant/v${values.version}`;
  const notesPath = path.join(extensionRoot, "ReleaseNotes.html");
  fs.writeFileSync(
    notesPath,
    `<html>
<head>
\t<title>Camber Assistant for Visual Studio Release Notes</title>
</head>
<body>
\t<h3>Nightly build ${values.version}</h3>
\t<p>
\t\tThis is an automated nightly build. The list of changes is published on the
\t\t<a href="${releaseUrl}">GitHub release</a>.
\t</p>
</body>
</html>
`,
  );
}

console.log(
  `Stamped ${path.relative(process.cwd(), manifestPath)} and ${path.relative(
    process.cwd(),
    packagePath,
  )}: version=${values.version} preview=${preview}`,
);
