import { EntityManager } from "@mikro-orm/postgresql";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { MikroOutboxRepository } from "../../database/repositories/mikro-outbox.repository";
import { MetricsService } from "../../observability/metrics.service";
import { StructuredLoggerService } from "../../observability/structured-logger.service";

export interface OutboxPublisherConfig {
  pollIntervalMs?: number;
  batchSize?: number;
  queueUrl?: string;
}

export class TransactionalOutboxPublisher {
  private isRunning = false;
  private pollTimeout?: Timer;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly queueUrl: string;

  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient?: SQSClient,
    config?: OutboxPublisherConfig,
    private readonly metricsService?: MetricsService,
    private readonly logger?: StructuredLoggerService,
  ) {
    this.pollIntervalMs = config?.pollIntervalMs ?? 1000;
    this.batchSize = config?.batchSize ?? 20;
    this.queueUrl =
      config?.queueUrl ||
      process.env.SQS_QUEUE_URL ||
      "http://localhost:4566/000000000000/wager-transactions.fifo";
  }

  /**
   * Executa uma iteração de busca e publicação de mensagens pendentes na outbox.
   * Utiliza SELECT ... FOR UPDATE SKIP LOCKED no repositório para permitir
   * que múltiplas instâncias publiquem concorrentemente sem contenção.
   */
  async publishPending(): Promise<number> {
    return await this.em.transactional(async (txEm) => {
      const outboxRepo = new MikroOutboxRepository(txEm);
      const pendingMessages = await outboxRepo.findPendingToPublish(
        this.batchSize,
        new Date(),
      );

      if (pendingMessages.length === 0) {
        this.metricsService?.setOutboxLag(0);
        return 0;
      }

      this.metricsService?.setOutboxLag(pendingMessages.length);
      let publishedCount = 0;
      const now = new Date();

      for (const message of pendingMessages) {
        try {
          if (this.sqsClient && this.queueUrl) {
            // Publica no SQS com MessageGroupId e MessageDeduplicationId para filas FIFO
            await this.sqsClient.send(
              new SendMessageCommand({
                QueueUrl: this.queueUrl,
                MessageBody: JSON.stringify(message.payload),
                MessageGroupId: message.aggregateId || "default-group",
                MessageDeduplicationId: message.id,
              }),
            );
          }

          message.markPublished(now);
          publishedCount++;
          this.logger?.log("Outbox message published to SQS FIFO", {
            messageId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
          });
        } catch (err: any) {
          this.logger?.error(
            `Failed to publish outbox message '${message.id}' (type: ${message.eventType})`,
            err?.stack,
            { messageId: message.id, eventType: message.eventType },
          );
          // Incrementa attempts e agenda próximo retry com backoff exponencial
          message.scheduleRetry(now);
          this.metricsService?.incrementRetry();
        }

        await outboxRepo.update(message);
      }

      return publishedCount;
    });
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.publishPending();
      } catch (err: any) {
        console.error("[OUTBOX_PUBLISHER_LOOP_ERROR]", err?.message || err);
      } finally {
        if (this.isRunning) {
          this.pollTimeout = setTimeout(loop, this.pollIntervalMs);
        }
      }
    };

    loop();
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }
  }
}
