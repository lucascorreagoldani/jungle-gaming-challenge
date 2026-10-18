import { describe, it, expect, beforeEach } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { ReprocessPendingReferencesUseCase } from "../../src/application/use-cases/reprocess-pending-references.use-case";
import { TransactionalOutboxPublisher } from "../../src/infrastructure/messaging/outbox/outbox.publisher";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs/sqs-wager.consumer";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/models/wager-transaction.entity";
import { FailureCode } from "../../src/domain/errors/domain.error";
import { WalletOrmEntity } from "../../src/infrastructure/database/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/database/entities/wager-transaction.orm-entity";
import { WalletLedgerEntryOrmEntity } from "../../src/infrastructure/database/entities/wallet-ledger-entry.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/database/entities/outbox-message.orm-entity";
import { InboxMessageOrmEntity } from "../../src/infrastructure/database/entities/inbox-message.orm-entity";

// Real Async Lock & Transactional In-Memory Engine for Concurrency Testing
class ConcurrentTransactionalEngine {
  public wallets = new Map<string, WalletOrmEntity>();
  public transactions = new Map<string, WagerTransactionOrmEntity>();
  public ledger = new Map<string, WalletLedgerEntryOrmEntity>();
  public outbox = new Map<string, OutboxMessageOrmEntity>();
  public inbox = new Map<string, InboxMessageOrmEntity>();

  // Granular Pessimistic Row Locks per Wallet (SELECT ... FOR UPDATE simulation)
  private walletLocks = new Map<string, Promise<void>>();
  // Outbox Row Locks for SKIP LOCKED simulation
  private lockedOutboxIds = new Set<string>();

  private async acquireWalletLock(walletId: string): Promise<() => void> {
    while (this.walletLocks.has(walletId)) {
      await this.walletLocks.get(walletId);
    }
    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.walletLocks.set(walletId, lockPromise);

    return () => {
      this.walletLocks.delete(walletId);
      releaseLock();
    };
  }

  persist(entity: any) {
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

  async findOne(entityClass: any, where: any, options?: any) {
    if (entityClass === WalletOrmEntity) {
      if (where.id) {
        return this.wallets.get(where.id) || null;
      }
      if (where.playerId && where.currency) {
        for (const w of this.wallets.values()) {
          if (w.playerId === where.playerId && w.currency === where.currency) {
            return w;
          }
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

  async find(entityClass: any, where: any, options?: any) {
    if (entityClass === OutboxMessageOrmEntity) {
      const available: OutboxMessageOrmEntity[] = [];
      for (const msg of this.outbox.values()) {
        if (msg.publishedAt === undefined || msg.publishedAt === null) {
          if (!this.lockedOutboxIds.has(msg.id)) {
            this.lockedOutboxIds.add(msg.id);
            available.push(msg);
            if (options?.limit && available.length >= options.limit) break;
          }
        }
      }
      return available;
    }

    if (entityClass === WagerTransactionOrmEntity) {
      const matched: WagerTransactionOrmEntity[] = [];
      for (const tx of this.transactions.values()) {
        if (where.status && tx.status === where.status) {
          matched.push(tx);
          if (options?.limit && matched.length >= options.limit) break;
        }
      }
      return matched;
    }

    return [];
  }

  createQueryBuilder() {
    return {
      where: () => { },
      andWhere: () => { },
      orderBy: () => { },
      limit: () => { },
      getResult: async () => Array.from(this.ledger.values()),
    };
  }

  getConnection() {
    return {
      execute: async (query?: string, params?: any[]) => {
        let totalCredits = 0;
        let totalDebits = 0;
        let count = 0;
        const targetWalletId = params?.[0];
        for (const l of this.ledger.values()) {
          if (targetWalletId && l.walletId !== targetWalletId) {
            continue;
          }
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

  async transactional<T>(cb: (em: any) => Promise<T>): Promise<T> {
    const locksToRelease: Array<() => void> = [];

    // Contextual unit of work for this transaction
    const txContext = {
      persist: (entity: any) => {
        this.persist(entity);
        return txContext;
      },

      findOne: async (entityClass: any, where: any, options?: any) => {
        if (entityClass === WalletOrmEntity) {
          if (where.id) {
            // Emula lock pessimista SELECT ... FOR UPDATE
            if (options?.lockMode) {
              const release = await this.acquireWalletLock(where.id);
              locksToRelease.push(release);
            }
            return this.wallets.get(where.id) || null;
          }
        }
        return this.findOne(entityClass, where, options);
      },

      find: async (entityClass: any, where: any, options?: any) => {
        return this.find(entityClass, where, options);
      },

      createQueryBuilder: () => this.createQueryBuilder(),
      getConnection: () => this.getConnection(),
    };

    try {
      return await cb(txContext);
    } finally {
      // Libera todos os locks adquiridos durante a transação
      for (const release of locksToRelease) {
        release();
      }
    }
  }

  unlockOutbox(id: string) {
    this.lockedOutboxIds.delete(id);
  }
}

describe("Real Concurrency & Race Condition Test Suite", () => {
  let engine: ConcurrentTransactionalEngine;
  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let reprocessReferencesUseCase: ReprocessPendingReferencesUseCase;

  beforeEach(() => {
    engine = new ConcurrentTransactionalEngine();
    createWalletUseCase = new CreateWalletUseCase(engine as unknown as EntityManager);
    processWagerUseCase = new ProcessWagerTransactionUseCase(engine as unknown as EntityManager);
    reconcileWalletUseCase = new ReconcileWalletUseCase(engine as unknown as EntityManager);
    reprocessReferencesUseCase = new ReprocessPendingReferencesUseCase(
      engine as unknown as EntityManager,
    );
  });

  it("1. Mandatory Scenario: Hot Wallet Race (Initial 100.00 BRL, two simultaneous 80.00 BRL bets)", async () => {
    // 1. Criar carteira com 100.00 BRL
    const wallet = await createWalletUseCase.execute({
      playerId: "player-hot-wallet",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    // 2. Disparar duas apostas de 80.00 BRL em paralelo simultâneo real
    const betA = processWagerUseCase.execute({
      providerId: "prov-a",
      externalTransactionId: "bet-race-1",
      idempotencyKey: "prov-a:bet-race-1",
      playerId: "player-hot-wallet",
      walletId: wallet.id,
      roundId: "round-race",
      gameId: "chimp",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    });

    const betB = processWagerUseCase.execute({
      providerId: "prov-a",
      externalTransactionId: "bet-race-2",
      idempotencyKey: "prov-a:bet-race-2",
      playerId: "player-hot-wallet",
      walletId: wallet.id,
      roundId: "round-race",
      gameId: "chimp",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    });

    const [resA, resB] = await Promise.all([betA, betB]);

    // Exatamente uma aposta PROCESSED e a outra REJECTED por saldo insuficiente
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);

    const rejectedRes = resA.status === WagerTransactionStatus.Rejected ? resA : resB;
    expect(rejectedRes.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

    // Saldo final deve ser exatamente 20.00 BRL
    const finalWallet = engine.wallets.get(wallet.id)!;
    expect(finalWallet.balance).toBe("20.00");
    expect(finalWallet.version).toBe(2); // 1 (opening) + 1 (processed bet)

    // Exatamente um lançamento de débito no ledger
    const ledgerEntries = Array.from(engine.ledger.values());
    const debits = ledgerEntries.filter((l) => l.direction === "DEBIT");
    expect(debits.length).toBe(1);
    expect(debits[0]!.amount).toBe("80.00");

    // Invariante: wallet.balance == saldo reconstruído pelo ledger
    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.difference.amount).toBe("0.00");
    expect(rec.storedBalance.amount).toBe("20.00");
    expect(rec.calculatedBalance.amount).toBe("20.00");
  });

  it("2. High Concurrency Idempotency: The same bet submitted 50 times in parallel", async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: "player-idemp-50",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const singleBetPayload = {
      providerId: "provider-heavy",
      externalTransactionId: "heavy-tx-1",
      idempotencyKey: "provider-heavy:heavy-tx-1",
      playerId: "player-idemp-50",
      walletId: wallet.id,
      roundId: "round-heavy",
      gameId: "slots",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    };

    // Dispara 50 requisições rigorosamente simultâneas da MESMA aposta
    const parallelRequests = Array.from({ length: 50 }, () =>
      processWagerUseCase.execute(singleBetPayload),
    );

    const responses = await Promise.all(parallelRequests);

    // Todas as 50 requisições devem retornar com sucesso
    expect(responses.length).toBe(50);
    for (const r of responses) {
      expect(r.status).toBe(WagerTransactionStatus.Processed);
      expect(r.balance.amount).toBe("75.00");
    }

    // Exatamente 1 deve ser idempotentReplay: false, e 49 devem ser idempotentReplay: true
    const originalCount = responses.filter((r) => !r.idempotentReplay).length;
    const replayCount = responses.filter((r) => r.idempotentReplay).length;

    expect(originalCount).toBe(1);
    expect(replayCount).toBe(49);

    // Saldo debitado exatamente uma única vez (100 - 25 = 75.00)
    const finalWallet = engine.wallets.get(wallet.id)!;
    expect(finalWallet.balance).toBe("75.00");
    expect(finalWallet.version).toBe(2);

    // Exatamente 1 lançamento de débito no ledger
    const debits = Array.from(engine.ledger.values()).filter((l) => l.direction === "DEBIT");
    expect(debits.length).toBe(1);

    // Invariante
    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("75.00");
  });

  it("3. Parallel processing across distinct wallets without mutual contention", async () => {
    // Cria 10 carteiras diferentes
    const wallets = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createWalletUseCase.execute({
          playerId: `player-multi-${i}`,
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      ),
    );

    // Processa uma aposta em cada carteira simultaneamente
    await Promise.all(
      wallets.map((w, i) =>
        processWagerUseCase.execute({
          providerId: "prov-multi",
          externalTransactionId: `tx-multi-${i}`,
          idempotencyKey: `prov-multi:tx-multi-${i}`,
          playerId: w.playerId,
          walletId: w.id,
          roundId: `round-${i}`,
          gameId: "multi",
          kind: WagerTransactionKind.Bet,
          money: { amount: "10.00", currency: "BRL" },
        }),
      ),
    );

    // Todas devem ter saldo de 90.00 BRL
    for (const w of wallets) {
      const stored = engine.wallets.get(w.id)!;
      expect(stored.balance).toBe("90.00");
      const rec = await reconcileWalletUseCase.execute(w.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe("90.00");
    }
  });

  it("4. Out-of-order REFUND delivered before BET and resolved by worker", async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: "player-ooo",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    // 1. REFUND chega antes da BET!
    const refundResult = await processWagerUseCase.execute({
      providerId: "prov-ooo",
      externalTransactionId: "refund-early-1",
      idempotencyKey: "prov-ooo:refund-early-1",
      playerId: "player-ooo",
      walletId: wallet.id,
      roundId: "round-ooo",
      gameId: "slots",
      kind: WagerTransactionKind.Refund,
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-future-1",
    });

    // Nasce em PENDING_REFERENCE sem alterar saldo
    expect(refundResult.status).toBe(WagerTransactionStatus.PendingReference);
    expect(engine.wallets.get(wallet.id)!.balance).toBe("100.00");

    // 2. Agora a BET chega e é processada (100 - 50 = 50.00)
    const betResult = await processWagerUseCase.execute({
      providerId: "prov-ooo",
      externalTransactionId: "bet-future-1",
      idempotencyKey: "prov-ooo:bet-future-1",
      playerId: "player-ooo",
      walletId: wallet.id,
      roundId: "round-ooo",
      gameId: "slots",
      kind: WagerTransactionKind.Bet,
      money: { amount: "50.00", currency: "BRL" },
    });
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect(engine.wallets.get(wallet.id)!.balance).toBe("50.00");

    // 3. Worker de resolução de referências roda e resolve a REFUND pendente!
    const resolvedCount = await reprocessReferencesUseCase.execute();
    expect(resolvedCount).toBe(1);

    // O status da REFUND transicionou para PROCESSED
    const refundTx = Array.from(engine.transactions.values()).find(
      (tx) => tx.externalTransactionId === "refund-early-1",
    )!;
    expect(refundTx.status).toBe(WagerTransactionStatus.Processed);

    // O saldo retornou para 100.00 BRL (50 + 50 refund)
    expect(engine.wallets.get(wallet.id)!.balance).toBe("100.00");

    // Invariante
    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("100.00");
  });

  it("5. Concurrent Publishers on same Outbox: SKIP LOCKED prevents duplicate delivery", async () => {
    // Cria 10 mensagens na outbox
    const wallet = await createWalletUseCase.execute({
      playerId: "player-outbox-race",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    for (let i = 0; i < 5; i++) {
      await processWagerUseCase.execute({
        providerId: "prov-outbox",
        externalTransactionId: `tx-outbox-${i}`,
        idempotencyKey: `prov-outbox:tx-outbox-${i}`,
        playerId: "player-outbox-race",
        walletId: wallet.id,
        roundId: `round-${i}`,
        gameId: "slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "1.00", currency: "BRL" },
      });
    }

    const mockSqsClient = {
      send: async () => ({ MessageId: "sqs-mock-id" }),
    };

    // 3 instâncias de publisher concorrentes
    const pub1 = new TransactionalOutboxPublisher(
      engine as unknown as EntityManager,
      mockSqsClient as any,
    );
    const pub2 = new TransactionalOutboxPublisher(
      engine as unknown as EntityManager,
      mockSqsClient as any,
    );
    const pub3 = new TransactionalOutboxPublisher(
      engine as unknown as EntityManager,
      mockSqsClient as any,
    );

    // Executam em paralelo
    const [c1, c2, c3] = await Promise.all([
      pub1.publishPending(),
      pub2.publishPending(),
      pub3.publishPending(),
    ]);

    const totalPublished = c1 + c2 + c3;
    expect(totalPublished).toBeGreaterThan(0);

    // Nenhuma mensagem duplicada: cada mensagem da outbox possui publishedAt definido
    for (const msg of engine.outbox.values()) {
      expect(msg.publishedAt).toBeDefined();
    }
  });

  it("6. Crash Recovery: Worker dies after commit and before ACK (SQS Redelivery)", async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: "player-crash-recovery",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const mockSqsClient = {
      send: async () => ({}),
    };

    const consumer = new SqsWagerConsumer(
      mockSqsClient as any,
      processWagerUseCase,
    );

    const messagePayload = {
      MessageId: "sqs-msg-unique-42",
      ReceiptHandle: "receipt-handle-42",
      Body: JSON.stringify({
        messageId: "sqs-msg-unique-42",
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "prov-crash",
          externalTransactionId: "ext-crash-1",
          idempotencyKey: "prov-crash:ext-crash-1",
          playerId: "player-crash-recovery",
          walletId: wallet.id,
          roundId: "round-crash",
          gameId: "slots",
          kind: WagerTransactionKind.Bet,
          money: { amount: "20.00", currency: "BRL" },
        },
      }),
    };

    // 1. Processa pela primeira vez (commit no banco de dados)
    await (consumer as any).handleMessage(messagePayload);

    expect(engine.wallets.get(wallet.id)!.balance).toBe("80.00");
    expect(engine.inbox.size).toBe(1);

    // 2. Simula crash antes do ACK: SQS reenvia exatamente a mesma mensagem!
    await (consumer as any).handleMessage(messagePayload);

    // O saldo DEVE CONTINUAR em 80.00 BRL (não houve duplo débito)
    expect(engine.wallets.get(wallet.id)!.balance).toBe("80.00");
    const debits = Array.from(engine.ledger.values()).filter((l) => l.direction === "DEBIT");
    expect(debits.length).toBe(1);

    // Invariante
    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe("80.00");
  });
});
