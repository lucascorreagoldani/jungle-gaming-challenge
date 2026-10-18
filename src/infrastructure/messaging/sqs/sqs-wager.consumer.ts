import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../../domain/models/wager-transaction.entity";
import { MoneyProps } from "../../../domain/value-objects/money.vo";

export interface SqsWagerMessagePayload {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

export interface SqsConsumerConfig {
  queueUrl: string;
  dlqUrl?: string;
  waitTimeSeconds?: number;
  maxNumberOfMessages?: number;
  visibilityTimeout?: number;
  consumerName?: string;
}

export class SqsWagerConsumer {
  private isRunning = false;
  private activeProcessingCount = 0;
  private readonly queueUrl: string;
  private readonly dlqUrl?: string;
  private readonly waitTimeSeconds: number;
  private readonly maxNumberOfMessages: number;
  private readonly visibilityTimeout: number;
  private readonly consumerName: string;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    config?: SqsConsumerConfig,
  ) {
    this.queueUrl =
      config?.queueUrl ||
      process.env.SQS_QUEUE_URL ||
      "http://localhost:4566/000000000000/wager-transactions.fifo";
    this.dlqUrl = config?.dlqUrl || process.env.SQS_DLQ_URL;
    this.waitTimeSeconds = config?.waitTimeSeconds ?? 10;
    this.maxNumberOfMessages = config?.maxNumberOfMessages ?? 5;
    this.visibilityTimeout = config?.visibilityTimeout ?? 30;
    this.consumerName = config?.consumerName || "sqs-wager-consumer";
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.isRunning) {
      try {
        const response = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.maxNumberOfMessages,
            WaitTimeSeconds: this.waitTimeSeconds,
            VisibilityTimeout: this.visibilityTimeout,
            AttributeNames: ["All"],
          }),
        );

        const messages = response.Messages || [];
        if (messages.length > 0) {
          await Promise.all(messages.map((msg) => this.handleMessage(msg)));
        }
      } catch (err: any) {
        if (!this.isRunning) break;
        console.error(`[SQS_CONSUMER_POLL_ERROR] Error polling queue:`, err?.message || err);
        // Pequena pausa antes de tentar novo polling para evitar loop frenético em caso de indisponibilidade
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async stop(timeoutMs = 5000): Promise<void> {
    this.isRunning = false;
    const start = Date.now();

    while (this.activeProcessingCount > 0 && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async handleMessage(sqsMsg: any): Promise<void> {
    this.activeProcessingCount++;
    const receiptHandle = sqsMsg.ReceiptHandle;

    try {
      if (!sqsMsg.Body) {
        await this.ack(receiptHandle);
        return;
      }

      let parsed: SqsWagerMessagePayload;
      try {
        parsed = JSON.parse(sqsMsg.Body);
      } catch (parseErr) {
        console.error("[SQS_INVALID_JSON] Permanent JSON parsing error, moving to ACK/DLQ:", parseErr);
        // Mensagem malformada permanente -> Ack para não travar a fila FIFO
        await this.ack(receiptHandle);
        return;
      }

      const { data, messageId } = parsed;

      // Executa o use case reutilizado da API HTTP com Inbox persistente
      await this.processWagerUseCase.execute({
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        inboxMessageId: messageId,
        consumerName: this.consumerName,
        correlationId: messageId,
      });

      // ACK somente após o commit bem-sucedido (seja PROCESSED ou REJECTED por regra de negócio)
      await this.ack(receiptHandle);
    } catch (err: any) {
      console.error(
        `[SQS_PROCESSING_ERROR] Transient or unexpected failure on message '${sqsMsg.MessageId}':`,
        err?.message || err,
      );
      // Em caso de falha transitória, devolve a visibilidade para retry no SQS
      try {
        await this.sqsClient.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 2, // Retenta em 2 segundos
          }),
        );
      } catch {
        // Ignora erro ao mudar visibilidade caso a mensagem já tenha expirado
      }
    } finally {
      this.activeProcessingCount--;
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    try {
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err: any) {
      console.error(`[SQS_ACK_FAILED] Failed to delete message from queue:`, err?.message || err);
    }
  }
}
