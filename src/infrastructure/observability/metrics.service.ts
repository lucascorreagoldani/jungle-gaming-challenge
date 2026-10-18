import { Injectable } from "@nestjs/common";

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface MetricsSnapshot {
  transactionsByStatus: Record<string, number>;
  duplicatesDetected: number;
  lockConflicts: number;
  retries: number;
  dlqMessages: number;
  outboxLag: number;
  latencyStats: LatencyStats;
}

@Injectable()
export class MetricsService {
  private transactionsByStatus: Record<string, number> = {
    PROCESSED: 0,
    REJECTED: 0,
    PENDING_REFERENCE: 0,
    FAILED: 0,
  };

  private duplicatesDetected = 0;
  private lockConflicts = 0;
  private retries = 0;
  private dlqMessages = 0;
  private outboxLag = 0;
  private latencies: number[] = [];

  public incrementTransaction(status: string): void {
    const key = status.toUpperCase();
    this.transactionsByStatus[key] = (this.transactionsByStatus[key] || 0) + 1;
  }

  public incrementDuplicate(): void {
    this.duplicatesDetected += 1;
  }

  public incrementLockConflict(): void {
    this.lockConflicts += 1;
  }

  public incrementRetry(): void {
    this.retries += 1;
  }

  public incrementDlq(): void {
    this.dlqMessages += 1;
  }

  public setOutboxLag(lag: number): void {
    this.outboxLag = lag;
  }

  public recordLatency(durationMs: number): void {
    this.latencies.push(durationMs);
    // Mantém um buffer circular de até 5000 amostras para cálculo estável de percentis
    if (this.latencies.length > 5000) {
      this.latencies.shift();
    }
  }

  public getLatencyStats(): LatencyStats {
    if (this.latencies.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0 };
    }

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const min = sorted[0]!;
    const max = sorted[count - 1]!;
    const avg = Number((sum / count).toFixed(2));

    const p50 = sorted[Math.floor(count * 0.5)]!;
    const p90 = sorted[Math.floor(count * 0.9)]!;
    const p99 = sorted[Math.floor(count * 0.99)]!;

    return { count, min, max, avg, p50, p90, p99 };
  }

  public getMetricsSnapshot(): MetricsSnapshot {
    return {
      transactionsByStatus: { ...this.transactionsByStatus },
      duplicatesDetected: this.duplicatesDetected,
      lockConflicts: this.lockConflicts,
      retries: this.retries,
      dlqMessages: this.dlqMessages,
      outboxLag: this.outboxLag,
      latencyStats: this.getLatencyStats(),
    };
  }

  public toPrometheusFormat(): string {
    const lines: string[] = [];

    // Transactions by status
    lines.push("# HELP wagering_transactions_total Total number of wagering transactions by status");
    lines.push("# TYPE wagering_transactions_total counter");
    for (const [status, count] of Object.entries(this.transactionsByStatus)) {
      lines.push(`wagering_transactions_total{status="${status.toLowerCase()}"} ${count}`);
    }

    // Duplicates
    lines.push("# HELP wagering_duplicates_detected_total Total idempotent replays / duplicates detected");
    lines.push("# TYPE wagering_duplicates_detected_total counter");
    lines.push(`wagering_duplicates_detected_total ${this.duplicatesDetected}`);

    // Lock conflicts
    lines.push("# HELP wagering_lock_conflicts_total Total concurrency lock conflicts encountered");
    lines.push("# TYPE wagering_lock_conflicts_total counter");
    lines.push(`wagering_lock_conflicts_total ${this.lockConflicts}`);

    // Retries
    lines.push("# HELP wagering_retries_total Total processing and outbox retries");
    lines.push("# TYPE wagering_retries_total counter");
    lines.push(`wagering_retries_total ${this.retries}`);

    // DLQ messages
    lines.push("# HELP wagering_dlq_messages_total Total messages routed to Dead Letter Queue");
    lines.push("# TYPE wagering_dlq_messages_total counter");
    lines.push(`wagering_dlq_messages_total ${this.dlqMessages}`);

    // Outbox Lag
    lines.push("# HELP wagering_outbox_lag Current number of pending unpublished outbox messages");
    lines.push("# TYPE wagering_outbox_lag gauge");
    lines.push(`wagering_outbox_lag ${this.outboxLag}`);

    // Latency
    const stats = this.getLatencyStats();
    lines.push("# HELP wagering_processing_latency_ms Latency of transaction processing");
    lines.push("# TYPE wagering_processing_latency_ms summary");
    lines.push(`wagering_processing_latency_ms{quantile="0.5"} ${stats.p50}`);
    lines.push(`wagering_processing_latency_ms{quantile="0.9"} ${stats.p90}`);
    lines.push(`wagering_processing_latency_ms{quantile="0.99"} ${stats.p99}`);
    lines.push(`wagering_processing_latency_ms_sum ${stats.avg * stats.count}`);
    lines.push(`wagering_processing_latency_ms_count ${stats.count}`);

    return lines.join("\n") + "\n";
  }
}
