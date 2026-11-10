import type {
  LocalInferenceDownloadState,
  LocalInferenceModel,
  LocalInferenceState,
} from "@camber/helperapi/schemas";

export function localInferenceDownloads(
  state: LocalInferenceState | null | undefined,
): LocalInferenceDownloadState[] {
  return state?.downloads ?? [];
}

export function localInferenceDownloadForModel(
  downloads: readonly LocalInferenceDownloadState[],
  model: LocalInferenceModel,
): LocalInferenceDownloadState | undefined {
  return downloads.find(
    (download) =>
      download.modelId === model.id ||
      download.modelId === model.repoId ||
      download.modelId === model.download?.modelId,
  );
}

export function isActiveLocalInferenceDownload(
  download: LocalInferenceDownloadState | null | undefined,
): download is LocalInferenceDownloadState {
  return download?.status === "resolving" || download?.status === "downloading";
}

export function localInferenceDownloadProgressWidth(download: LocalInferenceDownloadState): string {
  if (download.bytesTotal && download.bytesDownloaded != null) {
    return `${Math.max(2, Math.min(100, Math.round((download.bytesDownloaded / download.bytesTotal) * 100)))}%`;
  }
  if (download.filesTotal && download.filesCompleted != null) {
    return `${Math.max(8, Math.min(95, Math.round((download.filesCompleted / download.filesTotal) * 100)))}%`;
  }
  return download.status === "resolving" ? "8%" : "18%";
}

export function localInferenceDownloadPercent(
  download: LocalInferenceDownloadState,
): string | undefined {
  if (!download.bytesTotal || download.bytesDownloaded == null) return undefined;
  return `${Math.max(0, Math.min(100, Math.round((download.bytesDownloaded / download.bytesTotal) * 100)))}%`;
}

export function formatLocalInferenceDownloadStats(download: LocalInferenceDownloadState): string {
  const eta = formatLocalInferenceDownloadEta(download);
  return [
    formatLocalInferenceDownloadCounts(download),
    formatLocalInferenceDownloadSpeed(download),
    eta ? `ETA ${eta}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

export function formatLocalInferenceDownloadCounts(
  download: LocalInferenceDownloadState,
): string | undefined {
  const files =
    download.filesTotal && download.filesCompleted != null
      ? `${download.filesCompleted} of ${download.filesTotal} files`
      : undefined;
  const bytes =
    download.bytesTotal && download.bytesDownloaded != null
      ? `${formatLocalInferenceBytes(download.bytesDownloaded)} / ${formatLocalInferenceBytes(download.bytesTotal)}`
      : undefined;
  return [files, bytes].filter(Boolean).join(", ") || undefined;
}

export function formatLocalInferenceDownloadSpeed(
  download: LocalInferenceDownloadState,
): string | undefined {
  if (!isActiveLocalInferenceDownload(download) || !download.bytesPerSecond) return undefined;
  return `${formatLocalInferenceBytes(download.bytesPerSecond)}/s`;
}

export function formatLocalInferenceDownloadEta(
  download: LocalInferenceDownloadState,
): string | undefined {
  if (!isActiveLocalInferenceDownload(download) || download.etaSeconds == null) return undefined;
  if (!download.bytesPerSecond) return undefined;
  return formatLocalInferenceDuration(download.etaSeconds);
}

export function formatLocalInferenceBytes(value: number | undefined): string {
  if (!value || value < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next >= 10 || unit === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[unit]}`;
}

export function formatOptionalLocalInferenceBytes(value: number | undefined): string | undefined {
  if (!value || value < 0) return undefined;
  return formatLocalInferenceBytes(value);
}

export function formatLocalInferenceDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const rounded = Math.max(1, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}
