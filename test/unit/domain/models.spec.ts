import { describe, it, expect } from "bun:test";
import { Money } from "../../../src/domain/value-objects/money.vo";
import { Wallet } from "../../../src/domain/models/wallet.entity";
import { LedgerDirection, WalletLedgerEntry } from "../../../src/domain/models/wallet-ledger-entry.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/models/wager-transaction.entity";
import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientFundsError,
  InvalidTransactionStateError,
  ReferenceMismatchError,
  UnbalancedLedgerEntryError,
} from "../../../src/domain/errors/domain.error";
import { OutboxMessage } from "../../../src/domain/models/outbox-message.entity";
import { InboxMessage } from "../../../src/domain/models/inbox-message.entity";
import { WalletBalanceChanged } from "../../../src/domain/events/integration-events";

describe("Domain Models & Business Invariants", () => {
  describe("Wallet & WalletLedgerEntry", () => {
    it("should open wallet with initial balance and version 1", () => {
      const initial = Money.from({ amount: "100.00", currency: "BRL" });
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: initial,
      });

      expect(wallet.id).toBe("w-1");
      expect(wallet.playerId).toBe("p-1");
      expect(wallet.balance.toString()).toBe("100.00");
      expect(wallet.version).toBe(1);
    });

    it("should debit wallet and generate a balanced ledger entry", () => {
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      const entry = wallet.debit(
        Money.from({ amount: "25.00", currency: "BRL" }),
        "tx-1",
        "entry-1",
      );

      expect(wallet.balance.toString()).toBe("75.00");
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toString()).toBe("100.00");
      expect(entry.balanceAfter.toString()).toBe("75.00");
      expect(entry.money.toString()).toBe("25.00");
      expect(entry.isBalanced()).toBe(true);
    });

    it("should throw InsufficientFundsError when debit exceeds balance", () => {
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      expect(() =>
        wallet.debit(
          Money.from({ amount: "60.00", currency: "BRL" }),
          "tx-2",
          "entry-2",
        ),
      ).toThrow(InsufficientFundsError);

      // Invariant: balance and version must NOT change on failed debit
      expect(wallet.balance.toString()).toBe("50.00");
      expect(wallet.version).toBe(1);
    });

    it("should credit wallet and generate a balanced ledger entry", () => {
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      const entry = wallet.credit(
        Money.from({ amount: "30.00", currency: "BRL" }),
        "tx-3",
        "entry-3",
      );

      expect(wallet.balance.toString()).toBe("80.00");
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.toString()).toBe("50.00");
      expect(entry.balanceAfter.toString()).toBe("80.00");
    });

    it("should prevent credit or debit with mismatched currency", () => {
      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      const usd = Money.from({ amount: "10.00", currency: "USD" });
      expect(() => wallet.debit(usd, "tx-4", "entry-4")).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(usd, "tx-5", "entry-5")).toThrow(CurrencyMismatchError);
    });

    it("should throw UnbalancedLedgerEntryError if ledger entry arithmetic is inconsistent", () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: "entry-err",
          walletId: "w-1",
          transactionId: "tx-err",
          direction: LedgerDirection.Debit,
          money: Money.from({ amount: "10.00", currency: "BRL" }),
          balanceBefore: Money.from({ amount: "50.00", currency: "BRL" }),
          balanceAfter: Money.from({ amount: "45.00", currency: "BRL" }), // Should be 40.00!
        }),
      ).toThrow(UnbalancedLedgerEntryError);
    });
  });

  describe("WagerTransaction State Transitions & Rules", () => {
    it("should create BET transaction in PENDING status", () => {
      const tx = WagerTransaction.create({
        id: "tx-bet",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        idempotencyKey: "provider-a:ext-1",
        payloadHash: "hash-123",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "20.00", currency: "BRL" }),
      });

      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.affectsBalance()).toBe(true);
      expect(tx.requiresReference()).toBe(false);
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    });

    it("should enforce referenceExternalTransactionId for REFUND and ROLLBACK", () => {
      expect(() =>
        WagerTransaction.create({
          id: "tx-ref",
          providerId: "provider-a",
          externalTransactionId: "ext-ref",
          idempotencyKey: "provider-a:ext-ref",
          payloadHash: "hash-456",
          walletId: "w-1",
          playerId: "p-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Refund,
          money: Money.from({ amount: "20.00", currency: "BRL" }),
          // referenceExternalTransactionId missing!
        }),
      ).toThrow(ReferenceMismatchError);
    });

    it("should transition states properly and reject transitions once in terminal state", () => {
      const tx = WagerTransaction.create({
        id: "tx-test",
        providerId: "p-a",
        externalTransactionId: "ext-t",
        idempotencyKey: "p-a:ext-t",
        payloadHash: "hash-t",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Win,
        money: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      tx.markProcessed(undefined, new Date());
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);

      // Attempting to transition after PROCESSED must throw
      expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(FailureCode.INVALID_OPERATION)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
    });

    it("should properly invert ledger direction for ROLLBACK depending on reference", () => {
      const betTx = WagerTransaction.create({
        id: "tx-bet",
        providerId: "p-a",
        externalTransactionId: "ext-bet",
        idempotencyKey: "p-a:ext-bet",
        payloadHash: "hash-bet",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
      });

      const winTx = WagerTransaction.create({
        id: "tx-win",
        providerId: "p-a",
        externalTransactionId: "ext-win",
        idempotencyKey: "p-a:ext-win",
        payloadHash: "hash-win",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Win,
        money: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      const rollbackTx = WagerTransaction.create({
        id: "tx-rb",
        providerId: "p-a",
        externalTransactionId: "ext-rb",
        idempotencyKey: "p-a:ext-rb",
        payloadHash: "hash-rb",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Rollback,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        referenceExternalTransactionId: "ext-bet",
      });

      // Rollback of BET (debit) must be CREDIT
      expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
      // Rollback of WIN (credit) must be DEBIT
      expect(rollbackTx.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);
    });
  });

  describe("Inbox & Outbox Messaging", () => {
    it("should track InboxMessage reception and mark as processed", () => {
      const inbox = InboxMessage.receive({
        messageId: "msg-1",
        consumerName: "wager-consumer",
        payloadHash: "hash-msg-1",
      });

      expect(inbox.isProcessed()).toBe(false);
      inbox.markProcessed();
      expect(inbox.isProcessed()).toBe(true);
      expect(inbox.processedAt).toBeDefined();
    });

    it("should schedule exponential backoff retries on OutboxMessage", () => {
      const event = new WalletBalanceChanged({
        eventId: "evt-1",
        aggregateId: "w-1",
        correlationId: "corr-1",
        data: {
          walletId: "w-1",
          transactionId: "tx-1",
          direction: LedgerDirection.Debit,
          money: { amount: "10.00", currency: "BRL" },
          balanceBefore: { amount: "100.00", currency: "BRL" },
          balanceAfter: { amount: "90.00", currency: "BRL" },
          walletVersion: 2,
        },
      });

      const outbox = OutboxMessage.enqueue(event);
      expect(outbox.isPending()).toBe(true);
      expect(outbox.isDue()).toBe(true);
      expect(outbox.attempts).toBe(0);

      const now = new Date();
      outbox.scheduleRetry(now);
      expect(outbox.attempts).toBe(1);
      expect(outbox.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());

      outbox.markPublished();
      expect(outbox.isPending()).toBe(false);
      expect(outbox.publishedAt).toBeDefined();
    });
  });
});
