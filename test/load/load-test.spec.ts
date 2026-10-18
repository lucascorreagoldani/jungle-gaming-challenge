import { describe, it, expect } from "bun:test";
import { EntityManager } from "@mikro-orm/postgresql";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/models/wager-transaction.entity";
import { WalletOrmEntity } from "../../src/infrastructure/database/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/database/entities/wager-transaction.orm-entity";
import { WalletLedgerEntryOrmEntity } from "../../src/infrastructure/database/entities/wallet-ledger-entry.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/database/entities/outbox-message.orm-entity";
import { InboxMessageOrmEntity } from "../../src/infrastructure/database/entities/inbox-message.orm-entity";

// High-Performance In-Memory Transaction Engine for Load Testing
class LoadBenchmarkEngine {
  public wallets = new Map<string, WalletOrmEntity>();
  public transactions = new Map<string, WagerTransactionOrmEntity>();
  public ledger = new Map<string, WalletLedgerEntryOrmEntity>();
  public outbox = new Map<string, OutboxMessageOrmEntity>();
  public inbox = new Map<string, InboxMessageOrmEntity>();

  private walletLocks = new Map<string, Promise<void>>();
  public lockContentionCount = 0;

  private async acquireWalletLock(walletId: string): Promise<() => void> {
    if (this.walletLocks.has(walletId)) {
      this.lockContentionCount++;
    }
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
      return null;
    }

    if (entityClass === InboxMessageOrmEntity) {
      return this.inbox.get(`${where.consumerName}:${where.messageId}`) || null;
    }

    return null;
  }

  async find(entityClass: any, where: any, options?: any) {
    return [];
  }

  getConnection() {
    return {
      execute: async (query?: string, params?: any[]) => {
        let totalCredits = 0;
        let totalDebits = 0;
        let count = 0;
        const targetWalletId = params?.[0];
        for (const l of this.ledger.values()) {
          if (targetWalletId && l.walletId !== targetWalletId) continue;
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

    const txContext = {
      persist: (entity: any) => {
        this.persist(entity);
        return txContext;
      },
      findOne: async (entityClass: any, where: any, options?: any) => {
        if (entityClass === WalletOrmEntity && where.id && options?.lockMode) {
          const release = await this.acquireWalletLock(where.id);
          locksToRelease.push(release);
          return this.wallets.get(where.id) || null;
        }
        return this.findOne(entityClass, where, options);
      },
      find: async (entityClass: any, where: any, options?: any) => {
        return this.find(entityClass, where, options);
      },
      getConnection: () => this.getConnection(),
    };

    try {
      return await cb(txContext);
    } finally {
      for (const release of locksToRelease) {
        release();
      }
    }
  }
}

describe("Reproducible High-Load Benchmark & Verification Suite", () => {
  it("executes 1,000 mixed distributed operations with concurrency, lock contention and ledger reconciliation", async () => {
    const engine = new LoadBenchmarkEngine();
    const createWalletUseCase = new CreateWalletUseCase(engine as unknown as EntityManager);
    const processWagerUseCase = new ProcessWagerTransactionUseCase(
      engine as unknown as EntityManager,
    );
    const reconcileWalletUseCase = new ReconcileWalletUseCase(engine as unknown as EntityManager);

    const WALLET_COUNT = 20;
    const TOTAL_REQUESTS = 1000;

    // 1. Setup Phase: Create wallets
    const wallets = await Promise.all(
      Array.from({ length: WALLET_COUNT }, (_, i) =>
        createWalletUseCase.execute({
          playerId: `load-player-${i}`,
          initialBalance: { amount: "1000.00", currency: "BRL" },
        }),
      ),
    );

    const latencies: number[] = [];
    let processedCount = 0;
    let rejectedCount = 0;
    let replayCount = 0;
    let errorCount = 0;

    // 2. Execution Phase: Generate 1,000 mixed requests
    // Mix:
    // - 65% BET (amount 10.00)
    // - 20% WIN (amount 15.00)
    // - 10% Idempotent replays (re-sending EXACT same transaction payload)
    // - 5% Overdraft BET (amount 50000.00 to force INSUFFICIENT_FUNDS)

    const startTime = performance.now();
    const createdPayloads: any[] = [];

    const tasks = Array.from({ length: TOTAL_REQUESTS }, async (_, idx) => {
      const wallet = wallets[idx % WALLET_COUNT]!;
      const opChoice = idx % 100;

      let payload: any;

      if (opChoice >= 85 && opChoice < 95 && createdPayloads.length > 20) {
        // Genuine Idempotent replay: reuse an earlier completed transaction's exact payload
        const pastIdx = (idx - 15) % createdPayloads.length;
        payload = createdPayloads[pastIdx]!;
      } else {
        let kind = WagerTransactionKind.Bet;
        let amount = "10.00";
        if (opChoice >= 65 && opChoice < 85) {
          kind = WagerTransactionKind.Win;
          amount = "15.00";
        } else if (opChoice >= 95) {
          // Overdraft to trigger Rule 9 rejection
          amount = "50000.00";
        }

        payload = {
          providerId: "prov-load",
          externalTransactionId: `load-tx-${idx}`,
          idempotencyKey: `prov-load:load-tx-${idx}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-${idx}`,
          gameId: "slots",
          kind,
          money: { amount, currency: "BRL" },
        };
        createdPayloads.push(payload);
      }

      const reqStart = performance.now();
      try {
        const res = await processWagerUseCase.execute(payload);

        const reqEnd = performance.now();
        latencies.push(reqEnd - reqStart);

        if (res.idempotentReplay) {
          replayCount++;
        } else if (res.status === WagerTransactionStatus.Processed) {
          processedCount++;
        } else if (res.status === WagerTransactionStatus.Rejected) {
          rejectedCount++;
        }
      } catch (err) {
        errorCount++;
      }
    });

    await Promise.all(tasks);
    const totalDurationMs = performance.now() - startTime;
    const rps = (TOTAL_REQUESTS / (totalDurationMs / 1000)).toFixed(1);

    // 3. Percentiles Calculation
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)]!.toFixed(2);
    const p90 = latencies[Math.floor(latencies.length * 0.9)]!.toFixed(2);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!.toFixed(2);
    const p99 = latencies[Math.floor(latencies.length * 0.99)]!.toFixed(2);

    // 4. Print Benchmark Report
    console.log(`
========================================================================
🚀 JUNGLE GAMING - DISTRIBUTED WAGERING PROCESSOR LOAD BENCHMARK
========================================================================
Total Requests:          ${TOTAL_REQUESTS}
Total Duration:          ${totalDurationMs.toFixed(2)} ms
Throughput:              ${rps} req/sec
------------------------------------------------------------------------
Latency Percentiles:
  - p50:                 ${p50} ms
  - p90:                 ${p90} ms
  - p95:                 ${p95} ms
  - p99:                 ${p99} ms
------------------------------------------------------------------------
Operation Breakdown:
  - Processed:           ${processedCount}
  - Idempotent Replays:  ${replayCount}
  - Rejected (Rule 9):   ${rejectedCount}
  - Errors (Exceptions): ${errorCount}
  - Lock Contentions:    ${engine.lockContentionCount}
========================================================================
`);

    expect(errorCount).toBe(0);
    expect(processedCount + replayCount + rejectedCount).toBe(TOTAL_REQUESTS);

    // 5. Post-Load Invariant Verification: 100% of wallets must have consistent ledgers!
    console.log(`🔍 Reconciling ${WALLET_COUNT} wallets after load test...`);
    for (const w of wallets) {
      const rec = await reconcileWalletUseCase.execute(w.id);
      expect(rec.consistent).toBe(true);
      expect(rec.difference.amount).toBe("0.00");
    }
    console.log(`✅ All ${WALLET_COUNT} wallets verified: 100% mathematical ledger consistency!`);
  });
});
