import { rpc, type RPCClient } from "../../hostRpc";

export interface DesktopQuotaPopoverContent {
  buckets: {
    label: string;
    usedPercent: number;
    valueLabel: string;
    resetLabel?: string;
  }[];
  message?: string;
  usageLinkLabel?: string;
}

export interface DesktopQuotaPopoverRequest {
  id: string;
  anchor: { x: number; y: number; width: number; height: number };
  content: DesktopQuotaPopoverContent;
}

type DesktopQuotaPopoverRPC = RPCClient & {
  showDesktopQuotaPopover(request: DesktopQuotaPopoverRequest): Promise<boolean>;
  updateDesktopQuotaPopover(id: string, content: DesktopQuotaPopoverContent): Promise<void>;
  closeDesktopQuotaPopover(id: string): Promise<void>;
};

export function showDesktopQuotaPopover(request: DesktopQuotaPopoverRequest): Promise<boolean> {
  return (rpc as DesktopQuotaPopoverRPC).showDesktopQuotaPopover(request);
}

export function updateDesktopQuotaPopover(
  id: string,
  content: DesktopQuotaPopoverContent,
): Promise<void> {
  return (rpc as DesktopQuotaPopoverRPC).updateDesktopQuotaPopover(id, content);
}

export function closeDesktopQuotaPopover(id: string): Promise<void> {
  return (rpc as DesktopQuotaPopoverRPC).closeDesktopQuotaPopover(id);
}
