import type { AttachedFile } from "@camber/rpc";

export interface DesktopFileViewerPanelProps {
  path: string;
  cwd?: string;
  line?: number;
  column?: number;
  openToken: number;
  focusToken: number;
  initialCodeFontFamily?: string;
  initialCodeFontSize?: number;
  onFileContextChange?: (file: AttachedFile) => void;
}
