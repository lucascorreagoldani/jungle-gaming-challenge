import { describe, it, expect } from "bun:test";
import { MetricsService } from "../../../src/infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../../src/infrastructure/observability/structured-logger.service";

describe("Observability & Metrics Unit Tests", () => {
  describe("MetricsService", () => {
    it("should increment counters and calculate percentiles accurately", () => {
      const metrics = new MetricsService();

      metrics.incrementTransaction("PROCESSED");
      metrics.incrementTransaction("PROCESSED");
      metrics.incrementTransaction("REJECTED");
      metrics.incrementDuplicate();
      metrics.incrementLockConflict();
      metrics.incrementRetry();
      metrics.incrementDlq();
      metrics.setOutboxLag(5);

      // Record sample latencies in ms: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
      for (let i = 1; i <= 10; i++) {
        metrics.recordLatency(i * 10);
      }

      const snapshot = metrics.getMetricsSnapshot();
      expect(snapshot.transactionsByStatus.PROCESSED).toBe(2);
      expect(snapshot.transactionsByStatus.REJECTED).toBe(1);
      expect(snapshot.duplicatesDetected).toBe(1);
      expect(snapshot.lockConflicts).toBe(1);
      expect(snapshot.retries).toBe(1);
      expect(snapshot.dlqMessages).toBe(1);
      expect(snapshot.outboxLag).toBe(5);

      expect(snapshot.latencyStats.count).toBe(10);
      expect(snapshot.latencyStats.min).toBe(10);
      expect(snapshot.latencyStats.max).toBe(100);
      expect(snapshot.latencyStats.avg).toBe(55);
      expect(snapshot.latencyStats.p50).toBe(60);
    });

    it("should export metrics in valid Prometheus format", () => {
      const metrics = new MetricsService();
      metrics.incrementTransaction("PROCESSED");
      metrics.incrementDuplicate();
      metrics.setOutboxLag(3);
      metrics.recordLatency(25);

      const prometheusOutput = metrics.toPrometheusFormat();
      expect(prometheusOutput).toContain('wagering_transactions_total{status="processed"} 1');
      expect(prometheusOutput).toContain("wagering_duplicates_detected_total 1");
      expect(prometheusOutput).toContain("wagering_outbox_lag 3");
      expect(prometheusOutput).toContain("wagering_processing_latency_ms");
    });
  });

  describe("StructuredLoggerService", () => {
    it("should sanitize sensitive keys from log metadata", () => {
      const sanitizeMethod = (StructuredLoggerService as any).sanitize;

      const metadata = {
        correlationId: "corr-123",
        transactionId: "tx-456",
        password: "super_secret_password",
        secretToken: "bearer_xyz",
        cardPayload: "1234-5678-9012-3456",
        rawPayload: { amount: "100.00" },
      };

      const sanitized = sanitizeMethod(metadata);
      expect(sanitized.correlationId).toBe("corr-123");
      expect(sanitized.transactionId).toBe("tx-456");
      expect(sanitized.password).toBe("[REDACTED]");
      expect(sanitized.secretToken).toBe("[REDACTED]");
      expect(sanitized.cardPayload).toBe("[REDACTED]");
      expect(sanitized.rawPayload).toBe("[REDACTED]");
    });
  });
});
