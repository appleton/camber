import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICON_NAME = "icon";
const ICON_COMPOSER_2_FEATURES = new Set(["refractivity", "specular-location"]);

if (process.platform !== "darwin") {
  throw new Error("The macOS app icon can only be compiled on macOS with Xcode installed.");
}

const appDir = fileURLToPath(new URL("..", import.meta.url));
const sourceIconPath = path.join(appDir, "src-tauri", "icons", `${ICON_NAME}.icon`);
const destinationDir = path.join(appDir, "src-tauri", "icons", "icon-composer");
const actool = execFileSync("xcrun", ["--find", "actool"], { encoding: "utf8" }).trim();
const actoolVersion = readActoolVersion(actool);
const temporaryDir = mkdtempSync(path.join(tmpdir(), "camber-macos-icon-"));

try {
  const inputIconPath = compatibleIconPath(sourceIconPath, temporaryDir, actoolVersion);
  const outputDir = path.join(temporaryDir, "output");
  const partialInfoPlist = path.join(outputDir, "assetcatalog_generated_info.plist");
  mkdirSync(outputDir, { recursive: true });

  execFileSync(
    actool,
    [
      inputIconPath,
      "--compile",
      outputDir,
      "--output-format",
      "human-readable-text",
      "--notices",
      "--warnings",
      "--errors",
      "--output-partial-info-plist",
      partialInfoPlist,
      "--app-icon",
      ICON_NAME,
      "--include-all-app-icons",
      "--enable-on-demand-resources",
      "NO",
      "--target-device",
      "mac",
      "--minimum-deployment-target",
      "10.13",
      "--platform",
      "macosx",
    ],
    { stdio: "inherit" },
  );

  const assetsCar = path.join(outputDir, "Assets.car");
  if (!existsSync(assetsCar)) {
    throw new Error(`actool did not produce ${assetsCar}`);
  }

  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(assetsCar, path.join(destinationDir, "Assets.car"));
  console.log(`Compiled ${sourceIconPath} with actool ${actoolVersion}.`);
} finally {
  rmSync(temporaryDir, { force: true, recursive: true });
}

function readActoolVersion(actoolPath) {
  const output = execFileSync(actoolPath, ["--version"], { encoding: "utf8" });
  const version = output.match(/<key>short-bundle-version<\/key>\s*<string>([^<]+)<\/string>/)?.[1];

  if (!version) {
    throw new Error("Could not determine the installed actool version.");
  }

  return version;
}

function compatibleIconPath(iconPath, temporaryDir, actoolVersion) {
  const actoolMajorVersion = Number.parseInt(actoolVersion, 10);
  if (actoolMajorVersion >= 27) return iconPath;
  if (actoolMajorVersion < 26) {
    throw new Error(
      `Icon Composer assets require Xcode 26 or newer; found actool ${actoolVersion}.`,
    );
  }

  const compatibleIcon = path.join(temporaryDir, `${ICON_NAME}.icon`);
  cpSync(iconPath, compatibleIcon, { recursive: true });

  const iconJsonPath = path.join(compatibleIcon, "icon.json");
  const icon = JSON.parse(readFileSync(iconJsonPath, "utf8"));
  icon.features = icon.features?.filter((feature) => !ICON_COMPOSER_2_FEATURES.has(feature));
  if (icon.features?.length === 0) delete icon.features;
  removeIconComposer2Annotations(icon);
  writeFileSync(iconJsonPath, `${JSON.stringify(icon, null, 2)}\n`);

  console.log(
    `actool ${actoolVersion} does not support Icon Composer 2 refraction annotations; compiling a compatible temporary copy.`,
  );
  return compatibleIcon;
}

function removeIconComposer2Annotations(value) {
  if (Array.isArray(value)) {
    for (const item of value) removeIconComposer2Annotations(item);
    return;
  }
  if (!value || typeof value !== "object") return;

  delete value.refractivity;
  delete value["refractivity-specializations"];

  if (Array.isArray(value["specular-specializations"])) {
    for (const specialization of value["specular-specializations"]) {
      if (typeof specialization.value === "string") specialization.value = true;
    }
  }

  for (const child of Object.values(value)) removeIconComposer2Annotations(child);
}
