import type { ACPCompactionNotification } from "@camber/helperapi/schemas";

export class CamberSessionExtensions {
  compacting = $state(false);
  private activeCompactionId: string | null = null;

  reset(): void {
    this.compacting = false;
    this.activeCompactionId = null;
  }

  endTurn(): void {
    this.reset();
  }

  handleCompactionUpdate(params: ACPCompactionNotification): void {
    if (params.phase === "started") {
      this.activeCompactionId = params.id;
      this.compacting = true;
    } else if (params.phase === "completed") {
      if (this.activeCompactionId !== null && params.id !== this.activeCompactionId) return;
      this.activeCompactionId = null;
      this.compacting = false;
    }
  }
}
