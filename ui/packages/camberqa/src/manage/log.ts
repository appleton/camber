import * as fs from "node:fs";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const TRUNCATE_TO = 2.5 * 1024 * 1024; // keep last 2.5MB
const CAP_CHECK_INTERVAL = 500; // check every N writes

export class LogWriter {
  private fd: number;
  private writeCount = 0;

  constructor(private logFile: string) {
    this.fd = fs.openSync(logFile, "a", 0o600);
  }

  write(chunk: Buffer): void {
    fs.writeSync(this.fd, chunk);
    this.writeCount++;
    if (this.writeCount % CAP_CHECK_INTERVAL === 0) {
      this.checkCap();
    }
  }

  private checkCap(): void {
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size <= MAX_LOG_SIZE) return;

      // Read the tail portion
      const readStart = stat.size - TRUNCATE_TO;
      const buf = Buffer.alloc(stat.size - readStart);
      fs.readSync(this.fd, buf, 0, buf.length, readStart);

      // Find the first newline to avoid partial lines
      const nlIdx = buf.indexOf(0x0a);
      const clean = nlIdx >= 0 ? buf.subarray(nlIdx + 1) : buf;

      fs.closeSync(this.fd);
      fs.writeFileSync(this.logFile, clean, { mode: 0o600 });
      this.fd = fs.openSync(this.logFile, "a", 0o600);
    } catch {
      // non-fatal
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {}
  }
}

export function readLastLines(logFile: string, n: number): string {
  let content: string;
  try {
    content = fs.readFileSync(logFile, "utf-8");
  } catch {
    return "";
  }

  const lines = content.split("\n");
  // Remove trailing empty line from final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-n).join("\n");
}
