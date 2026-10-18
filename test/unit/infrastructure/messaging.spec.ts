import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TransactionalOutboxPublisher } from "../../../src/infrastructure/messaging/outbox/outbox.publisher";
import { SqsWagerConsumer } from "../../../src/infrastructure/messaging/sqs/sqs-wager.consumer";
import { OutboxMessage } from "../../../src/domain/models/outbox-message.entity";
import { WalletBalanceChanged } from "../../../src/domain/events/integration-events";
import { LedgerDirection } from "../../../src/domain/models/wallet-ledger-entry.entity";
import { SQSClient } from "@aws-sdk/client-sqs";

describe("Messaging Infrastructure Unit Tests", () => {
  describe("TransactionalOutboxPublisher", () => {
    let mockEm: any;
    let mockSqsClient: any;
    let pendingMessages: OutboxMessage[];

    beforeEach(() => {
      const event = new WalletBalanceChanged({
        eventId: "evt-pub-1",
        aggregateId: "w-10",
        correlationId: "corr-10",
        data: {
          walletId: "w-10",
          transactionId: "tx-10",
          direction: LedgerDirection.Credit,
          money: { amount: "50.00", currency: "BRL" },
          balanceBefore: { amount: "0.00", currency: "BRL" },
          balanceAfter: { amount: "50.00", currency: "BRL" },
          walletVersion: 1,
        },
      });

      pendingMessages = [OutboxMessage.enqueue(event)];

      mockSqsClient = {
        send: mock(async () => ({ MessageId: "sqs-msg-1" })),
      };

      mockEm = {
        transactional: async (cb: any) => {
          return await cb({
            persist: (entity: any) => { },
            find: async () => pendingMessages.map((m) => ({
              id: m.id,
              aggregateId: m.aggregateId,
              eventType: m.eventType,
              payload: m.payload,
              occurredAt: m.occurredAt,
              attempts: m.attempts,
              nextAttemptAt: m.nextAttemptAt,
              publishedAt: m.publishedAt,
              toDomain: () => m,
            })),
            findOne: async (_: any, where: any) => {
              const msg = pendingMessages.find((m) => m.id === where.id);
              return msg ? {
                id: msg.id,
                attempts: msg.attempts,
                nextAttemptAt: msg.nextAttemptAt,
                publishedAt: msg.publishedAt,
              } : null;
            },
          });
        },
      };
    });

    it("should publish pending outbox messages and mark them published", async () => {
      const publisher = new TransactionalOutboxPublisher(
        mockEm as any,
        mockSqsClient as unknown as SQSClient,
        { queueUrl: "http://localhost:4566/wager-transactions.fifo" },
      );

      const count = await publisher.publishPending();
      expect(count).toBe(1);
      expect(mockSqsClient.send).toHaveBeenCalledTimes(1);

      const publishedMsg = pendingMessages[0]!;
      expect(publishedMsg.isPending()).toBe(false);
      expect(publishedMsg.publishedAt).toBeDefined();
    });

    it("should schedule retry with backoff when SQS send fails", async () => {
      mockSqsClient.send = mock(async () => {
        throw new Error("SQS Network Timeout");
      });

      const publisher = new TransactionalOutboxPublisher(
        mockEm as any,
        mockSqsClient as unknown as SQSClient,
        { queueUrl: "http://localhost:4566/wager-transactions.fifo" },
      );

      const count = await publisher.publishPending();
      expect(count).toBe(0);

      const failedMsg = pendingMessages[0]!;
      expect(failedMsg.isPending()).toBe(true);
      expect(failedMsg.attempts).toBe(1);
      expect(failedMsg.nextAttemptAt).toBeDefined();
    });
  });

  describe("SqsWagerConsumer", () => {
    let mockSqsClient: any;
    let mockProcessWagerUseCase: any;

    beforeEach(() => {
      mockSqsClient = {
        send: mock(async () => ({})),
      };
      mockProcessWagerUseCase = {
        execute: mock(async () => ({
          transactionId: "tx-sqs-1",
          status: "PROCESSED",
          balance: { amount: "100.00", currency: "BRL" },
          idempotentReplay: false,
        })),
      };
    });

    it("should handle message, execute use case and ACK after commit", async () => {
      const consumer = new SqsWagerConsumer(
        mockSqsClient as unknown as SQSClient,
        mockProcessWagerUseCase as any,
        { queueUrl: "http://localhost:4566/wager-transactions.fifo" },
      );

      const fakeSqsMessage = {
        MessageId: "sqs-1",
        ReceiptHandle: "receipt-1",
        Body: JSON.stringify({
          messageId: "msg-999",
          type: "WagerTransactionRequested",
          occurredAt: "2026-10-18T12:00:00.000Z",
          data: {
            providerId: "prov-sqs",
            externalTransactionId: "ext-sqs-1",
            idempotencyKey: "prov-sqs:ext-sqs-1",
            playerId: "p-sqs",
            walletId: "w-sqs",
            roundId: "r-sqs",
            gameId: "g-sqs",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          },
        }),
      };

      // Call internal handler
      await (consumer as any).handleMessage(fakeSqsMessage);

      // Verify use case called with inboxMessageId
      expect(mockProcessWagerUseCase.execute).toHaveBeenCalledTimes(1);
      const callArg = mockProcessWagerUseCase.execute.mock.calls[0]![0];
      expect(callArg.inboxMessageId).toBe("msg-999");
      expect(callArg.providerId).toBe("prov-sqs");

      // Verify DeleteMessageCommand was sent (ACK)
      expect(mockSqsClient.send).toHaveBeenCalledTimes(1);
    });

    it("should return message visibility for retry when use case throws transient error", async () => {
      mockProcessWagerUseCase.execute = mock(async () => {
        throw new Error("PostgreSQL Connection Terminated");
      });

      const consumer = new SqsWagerConsumer(
        mockSqsClient as unknown as SQSClient,
        mockProcessWagerUseCase as any,
        { queueUrl: "http://localhost:4566/wager-transactions.fifo" },
      );

      const fakeSqsMessage = {
        MessageId: "sqs-fail",
        ReceiptHandle: "receipt-fail",
        Body: JSON.stringify({
          messageId: "msg-fail",
          data: {
            providerId: "prov-fail",
            externalTransactionId: "ext-fail",
            idempotencyKey: "prov-fail:ext-fail",
            playerId: "p-fail",
            walletId: "w-fail",
            roundId: "r-fail",
            gameId: "g-fail",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          },
        }),
      };

      await (consumer as any).handleMessage(fakeSqsMessage);

      // Verify ChangeMessageVisibilityCommand was called instead of DeleteMessageCommand
      expect(mockSqsClient.send).toHaveBeenCalledTimes(1);
      const command = mockSqsClient.send.mock.calls[0]![0];
      expect(command.constructor.name).toBe("ChangeMessageVisibilityCommand");
    });
  });
});
