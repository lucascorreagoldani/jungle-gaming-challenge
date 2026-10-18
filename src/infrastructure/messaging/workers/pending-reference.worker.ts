import { ReprocessPendingReferencesUseCase } from "../../../application/use-cases/reprocess-pending-references.use-case";

export class PendingReferenceWorker {
  private isRunning = false;
  private timer?: Timer;

  constructor(
    private readonly reprocessUseCase: ReprocessPendingReferencesUseCase,
    private readonly intervalMs: number = 5000,
  ) { }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.reprocessUseCase.execute(25);
      } catch (err: any) {
        console.error("[PENDING_REFERENCE_WORKER_ERROR]", err?.message || err);
      } finally {
        if (this.isRunning) {
          this.timer = setTimeout(loop, this.intervalMs);
        }
      }
    };

    loop();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
