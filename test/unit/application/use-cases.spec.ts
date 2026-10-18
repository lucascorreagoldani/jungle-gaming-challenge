import { describe, it, expect, beforeEach } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { CreateWalletUseCase, DuplicateWalletError } from "../../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../../src/application/use-cases/reconcile-wallet.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/models/wager-transaction.entity";
import { LedgerDirection } from "../../../src/domain/models/wallet-ledger-entry.entity";
import { FailureCode, IdempotencyConflictError } from "../../../src/domain/errors/domain.error";
import { WalletOrmEntity } from "../../../src/infrastructure/database/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../../src/infrastructure/database/entities/wager-transaction.orm-entity";
import { WalletLedgerEntryOrmEntity } from "../../../src/infrastructure/database/entities/wallet-ledger-entry.orm-entity";
import { OutboxMessageOrmEntity } from "../../../src/infrastructure/database/entities/outbox-message.orm-entity";
import { InboxMessageOrmEntity } from "../../../src/infrastructure/database/entities/inbox-message.orm-entity";

// In-Memory Test Driver Mocking MikroORM EntityManager
class InMemoryEntityManager {
  public wallets = new Map<string, WalletOrmEntity>();
  public transactions = new Map<string, WagerTransactionOrmEntity>();
  public ledger = new Map<string, WalletLedgerEntryOrmEntity>();
  public outbox = new Map<string, OutboxMessageOrmEntity>();
  public inbox = new Map<string, InboxMessageOrmEntity>();

  async transactional<T>(cb: (em: any) => Promise<T>): Promise<T> {
    return await cb(this);
  }

  persist(entity: any): this {
    if (entity instanceof WalletOrmEntity) {
      this.wallets.set(entity.id, entity);
    } else if (entity instanceof WagerTransactionOrmEntity) {
      this.transactions.set(entity.id, entity);
    } else if (entity instanceof WalletLedgerEntryOrmEntity) {
      this.ledger.set(entity.id, entity);
    } else if (entity instanceof OutboxMessageOrmEntity) {
      this.outbox.set(entity.id, entity);
    } else if (entity instanceof InboxMessageOrmEntity) {
      this.inbox.set(`${entity.consumerName}:${entity.messageId}`, entity);
    }
    return this;
  }

  async findOne(entityClass: any, where: any): Promise<any> {
    if (entityClass === WalletOrmEntity) {
      if (where.id) return this.wallets.get(where.id) || null;
      if (where.playerId && where.currency) {
        for (const w of this.wallets.values()) {
          if (w.playerId === where.playerId && w.currency === where.currency) return w;
        }
      }
      return null;
    }

    if (entityClass === WagerTransactionOrmEntity) {
      if (where.id) return this.transactions.get(where.id) || null;
      if (where.idempotencyKey) {
        for (const tx of this.transactions.values()) {
          if (tx.idempotencyKey === where.idempotencyKey) return tx;
        }
      }
      if (where.providerId && where.externalTransactionId) {
        for (const tx of this.transactions.values()) {
          if (
            tx.providerId === where.providerId &&
            tx.externalTransactionId === where.externalTransactionId
          ) {
            return tx;
          }
        }
      }
      if (where.referenceTransactionId && where.kind) {
        for (const tx of this.transactions.values()) {
          if (
            tx.referenceTransactionId === where.referenceTransactionId &&
            tx.kind === where.kind &&
            tx.status === where.status
          ) {
            return tx;
          }
        }
      }
      return null;
    }

    if (entityClass === WalletLedgerEntryOrmEntity) {
      if (where.transactionId) {
        for (const l of this.ledger.values()) {
          if (l.transactionId === where.transactionId) return l;
        }
      }
      return null;
    }

    if (entityClass === InboxMessageOrmEntity) {
      return this.inbox.get(`${where.consumerName}:${where.messageId}`) || null;
    }

    if (entityClass === OutboxMessageOrmEntity) {
      return this.outbox.get(where.id) || null;
    }

    return null;
  }

  getConnection() {
    return {
      execute: async () => {
        let totalCredits = 0;
        let totalDebits = 0;
        let count = 0;
        for (const l of this.ledger.values()) {
          count++;
          if (l.direction === "CREDIT") totalCredits += parseFloat(l.amount);
          if (l.direction === "DEBIT") totalDebits += parseFloat(l.amount);
        }
        return [
          {
            total_credits: totalCredits.toFixed(2),
            total_debits: totalDebits.toFixed(2),
            total_count: count.toString(),
          },
        ];
      },
    };
  }
}

describe("Application Use Cases", () => {
  let mockEm: InMemoryEntityManager;
  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeEach(() => {
    mockEm = new InMemoryEntityManager();
    createWalletUseCase = new CreateWalletUseCase(mockEm as unknown as EntityManager);
    processWagerUseCase = new ProcessWagerTransactionUseCase(mockEm as unknown as EntityManager);
    reconcileWalletUseCase = new ReconcileWalletUseCase(mockEm as unknown as EntityManager);
  });

  describe("CreateWalletUseCase", () => {
    it("should create wallet with initial balance > 0 and record OPENING transaction & ledger", async () => {
      const output = await createWalletUseCase.execute({
        playerId: "player-1",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      expect(output.id).toBeDefined();
      expect(output.playerId).toBe("player-1");
      expect(output.balance.amount).toBe("100.00");
      expect(output.version).toBe(1);

      // Verify wallet persisted
      const walletOrm = mockEm.wallets.get(output.id);
      expect(walletOrm).toBeDefined();
      expect(walletOrm!.balance).toBe("100.00");

      // Verify OPENING transaction persisted
      expect(mockEm.transactions.size).toBe(1);
      const openingTx = Array.from(mockEm.transactions.values())[0]!;
      expect(openingTx.kind).toBe(WagerTransactionKind.Opening);
      expect(openingTx.status).toBe(WagerTransactionStatus.Processed);

      // Verify ledger credit
      expect(mockEm.ledger.size).toBe(1);
      const ledgerEntry = Array.from(mockEm.ledger.values())[0]!;
      expect(ledgerEntry.direction).toBe(LedgerDirection.Credit);
      expect(ledgerEntry.amount).toBe("100.00");
      expect(ledgerEntry.balanceAfter).toBe("100.00");

      // Verify Outbox event
      expect(mockEm.outbox.size).toBe(1);
    });

    it("should reject creating duplicate wallet for same player and currency", async () => {
      await createWalletUseCase.execute({
        playerId: "player-dup",
        initialBalance: { amount: "50.00", currency: "BRL" },
      });

      expect(
        createWalletUseCase.execute({
          playerId: "player-dup",
          initialBalance: { amount: "10.00", currency: "BRL" },
        }),
      ).rejects.toThrow(DuplicateWalletError);
    });
  });

  describe("ProcessWagerTransactionUseCase", () => {
    let walletId: string;

    beforeEach(async () => {
      const w = await createWalletUseCase.execute({
        playerId: "player-wagering",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      walletId = w.id;
    });

    it("should process BET successfully when balance is sufficient", async () => {
      const result = await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "bet-101",
        idempotencyKey: "provider-x:bet-101",
        playerId: "player-wagering",
        walletId,
        roundId: "round-1",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
      });

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe("75.00");
      expect(result.idempotentReplay).toBe(false);

      const wallet = mockEm.wallets.get(walletId)!;
      expect(wallet.balance).toBe("75.00");
      expect(wallet.version).toBe(2);
    });

    it("should reject BET when balance is insufficient without mutating balance or version", async () => {
      const result = await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "bet-too-high",
        idempotencyKey: "provider-x:bet-too-high",
        playerId: "player-wagering",
        walletId,
        roundId: "round-2",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "150.00", currency: "BRL" },
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
      expect(result.balance.amount).toBe("100.00");

      // Balance must NOT have changed
      const wallet = mockEm.wallets.get(walletId)!;
      expect(wallet.balance).toBe("100.00");
      expect(wallet.version).toBe(1);
    });

    it("should handle idempotent replay for identical request", async () => {
      const req = {
        providerId: "provider-x",
        externalTransactionId: "bet-idemp",
        idempotencyKey: "provider-x:bet-idemp",
        playerId: "player-wagering",
        walletId,
        roundId: "round-3",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      };

      const first = await processWagerUseCase.execute(req);
      expect(first.idempotentReplay).toBe(false);
      expect(first.balance.amount).toBe("70.00");

      // Send exact same request again
      const replay = await processWagerUseCase.execute(req);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transactionId).toBe(first.transactionId);
      expect(replay.balance.amount).toBe("70.00");

      // Balance must still be 70.00 (not debited twice!)
      const wallet = mockEm.wallets.get(walletId)!;
      expect(wallet.balance).toBe("70.00");
    });

    it("should throw IdempotencyConflictError when same key has different payload", async () => {
      await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "bet-conflict",
        idempotencyKey: "provider-x:conflict-key",
        playerId: "player-wagering",
        walletId,
        roundId: "round-4",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "20.00", currency: "BRL" },
      });

      // Same key, different amount -> 409 Conflict
      expect(
        processWagerUseCase.execute({
          providerId: "provider-x",
          externalTransactionId: "bet-conflict",
          idempotencyKey: "provider-x:conflict-key",
          playerId: "player-wagering",
          walletId,
          roundId: "round-4",
          gameId: "slots",
          kind: WagerTransactionKind.Bet,
          money: { amount: "50.00", currency: "BRL" },
        }),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it("should process REFUND for an existing BET and credit wallet back", async () => {
      // 1. Process Bet of 40.00 (Balance becomes 60.00)
      await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "bet-to-refund",
        idempotencyKey: "provider-x:bet-to-refund",
        playerId: "player-wagering",
        walletId,
        roundId: "round-ref",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "40.00", currency: "BRL" },
      });

      expect(mockEm.wallets.get(walletId)!.balance).toBe("60.00");

      // 2. Process Refund of 40.00 (Balance returns to 100.00)
      const refundResult = await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "refund-1",
        idempotencyKey: "provider-x:refund-1",
        playerId: "player-wagering",
        walletId,
        roundId: "round-ref",
        gameId: "slots",
        kind: WagerTransactionKind.Refund,
        money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-to-refund",
      });

      expect(refundResult.status).toBe(WagerTransactionStatus.Processed);
      expect(refundResult.balance.amount).toBe("100.00");
      expect(mockEm.wallets.get(walletId)!.balance).toBe("100.00");

      // 3. Prevent duplicate refund on the same bet
      const secondRefund = await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "refund-2",
        idempotencyKey: "provider-x:refund-2",
        playerId: "player-wagering",
        walletId,
        roundId: "round-ref",
        gameId: "slots",
        kind: WagerTransactionKind.Refund,
        money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-to-refund",
      });

      expect(secondRefund.status).toBe(WagerTransactionStatus.Rejected);
      expect(secondRefund.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
    });

    it("should set status PENDING_REFERENCE when reference is missing", async () => {
      const result = await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "refund-early",
        idempotencyKey: "provider-x:refund-early",
        playerId: "player-wagering",
        walletId,
        roundId: "round-future",
        gameId: "slots",
        kind: WagerTransactionKind.Refund,
        money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-not-yet-arrived",
      });

      expect(result.status).toBe(WagerTransactionStatus.PendingReference);
      // Balance remains unchanged
      expect(mockEm.wallets.get(walletId)!.balance).toBe("100.00");
    });

    it("should reject ROLLBACK with REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE if reversal produces negative balance", async () => {
      // 1. Process WIN of 50.00 (Balance becomes 150.00)
      await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "win-to-rollback",
        idempotencyKey: "provider-x:win-to-rollback",
        playerId: "player-wagering",
        walletId,
        roundId: "round-win-rb",
        gameId: "slots",
        kind: WagerTransactionKind.Win,
        money: { amount: "50.00", currency: "BRL" },
      });

      // 2. Player bets 140.00 (Balance drops to 10.00)
      await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "bet-drain",
        idempotencyKey: "provider-x:bet-drain",
        playerId: "player-wagering",
        walletId,
        roundId: "round-drain",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "140.00", currency: "BRL" },
      });

      expect(mockEm.wallets.get(walletId)!.balance).toBe("10.00");

      // 3. Provider sends ROLLBACK of the 50.00 WIN!
      // Since current balance is 10.00, debiting 50.00 would result in -40.00!
      const rollbackResult = await processWagerUseCase.execute({
        providerId: "provider-x",
        externalTransactionId: "rollback-1",
        idempotencyKey: "provider-x:rollback-1",
        playerId: "player-wagering",
        walletId,
        roundId: "round-win-rb",
        gameId: "slots",
        kind: WagerTransactionKind.Rollback,
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "win-to-rollback",
      });

      // Must be explicitly rejected with REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE (Rule 9)
      expect(rollbackResult.status).toBe(WagerTransactionStatus.Rejected);
      expect(rollbackResult.failureCode).toBe(FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE);
      expect(mockEm.wallets.get(walletId)!.balance).toBe("10.00");
    });
  });

  describe("ReconcileWalletUseCase", () => {
    it("should reconcile wallet and verify balance is consistent with ledger sum", async () => {
      const w = await createWalletUseCase.execute({
        playerId: "player-reconcile",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      await processWagerUseCase.execute({
        providerId: "prov",
        externalTransactionId: "tx-rec-1",
        idempotencyKey: "prov:tx-rec-1",
        playerId: "player-reconcile",
        walletId: w.id,
        roundId: "r-rec",
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
      });

      const reconciliation = await reconcileWalletUseCase.execute(w.id);
      expect(reconciliation.consistent).toBe(true);
      expect(reconciliation.storedBalance.amount).toBe("75.00");
      expect(reconciliation.calculatedBalance.amount).toBe("75.00");
      expect(reconciliation.difference.amount).toBe("0.00");
      expect(reconciliation.checkedEntries).toBe(2); // 1 OPENING credit + 1 BET debit
    });
  });
});
