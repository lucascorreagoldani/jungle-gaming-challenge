import { EntityManager } from "@mikro-orm/postgresql";
import { v4 as uuidv4 } from "uuid";
import { MikrowagerTransactionRepository } from "../../infrastructure/database/repositories/mikro-wager-transaction.repository";
import { MikroWalletRepository } from "../../infrastructure/database/repositories/mikro-wallet.repository";
import { MikroWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-wallet-ledger.repository";
import { MikroOutboxRepository } from "../../infrastructure/database/repositories/mikro-outbox.repository";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/models/wager-transaction.entity";
import { FailureCode } from "../../domain/errors/domain.error";
import { OutboxMessage } from "../../domain/models/outbox-message.entity";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/integration-events";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/models/wallet-ledger-entry.entity";
import { WagerTransactionOrmEntity } from "../../infrastructure/database/entities/wager-transaction.orm-entity";

export class ReprocessPendingReferencesUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly ttlMs: number = 10 * 60 * 1000, // 10 minutos de TTL
  ) { }

  async execute(limit = 50): Promise<number> {
    const txRepo = new MikrowagerTransactionRepository(this.em);
    const pendingTransactions = await txRepo.findPendingReferences(limit);

    if (pendingTransactions.length === 0) {
      return 0;
    }

    let processedCount = 0;
    const now = new Date();

    for (const pendingTx of pendingTransactions) {
      await this.em.transactional(async (txEm) => {
        const innerTxRepo = new MikrowagerTransactionRepository(txEm);
        const innerWalletRepo = new MikroWalletRepository(txEm);
        const innerLedgerRepo = new MikroWalletLedgerRepository(txEm);
        const innerOutboxRepo = new MikroOutboxRepository(txEm);

        // Verifica se excedeu o TTL (10 minutos)
        const ageMs = now.getTime() - pendingTx.createdAt.getTime();
        const isExpired = ageMs > this.ttlMs;

        if (!pendingTx.referenceExternalTransactionId) {
          return;
        }

        // Tenta encontrar a referência
        const refTx = await innerTxRepo.findByExternalId(
          pendingTx.providerId,
          pendingTx.referenceExternalTransactionId,
        );

        const eventCtx = {
          eventId: uuidv4(),
          correlationId: uuidv4(),
          occurredAt: now,
        };

        if (!refTx) {
          if (isExpired) {
            // Esgotado o limite: REJECTED com failureCode que identifique a referência inexistente
            pendingTx.reject(FailureCode.REFERENCE_NOT_FOUND, now);
            await innerTxRepo.save(pendingTx);

            const rejectedEvent = WagerTransactionRejected.from(
              pendingTx,
              FailureCode.REFERENCE_NOT_FOUND,
              eventCtx,
            );
            await innerOutboxRepo.save(OutboxMessage.enqueue(rejectedEvent));
            processedCount++;
          }
          return;
        }

        // A referência chegou! Bloqueia a carteira
        const wallet = await innerWalletRepo.findById(pendingTx.walletId, "pessimistic_write");
        if (!wallet) {
          pendingTx.fail(FailureCode.WALLET_NOT_FOUND, now);
          await innerTxRepo.save(pendingTx);
          return;
        }

        let ledgerEntry: WalletLedgerEntry | undefined;

        if (pendingTx.kind === WagerTransactionKind.Refund) {
          if (
            refTx.kind !== WagerTransactionKind.Bet ||
            refTx.status !== WagerTransactionStatus.Processed ||
            !refTx.money.equals(pendingTx.money)
          ) {
            pendingTx.reject(FailureCode.REFERENCE_INVALID_STATE, now);
            await innerTxRepo.save(pendingTx);
            return;
          }

          // Checar se já foi revertido
          const existingRefund = await txEm.findOne(WagerTransactionOrmEntity, {
            referenceTransactionId: refTx.id,
            kind: WagerTransactionKind.Refund,
            status: WagerTransactionStatus.Processed,
          });

          if (existingRefund) {
            pendingTx.reject(FailureCode.REFERENCE_ALREADY_REVERSED, now);
            await innerTxRepo.save(pendingTx);
            return;
          }

          ledgerEntry = wallet.credit(pendingTx.money, pendingTx.id, uuidv4(), now);
          pendingTx.markProcessed(refTx.id, now);
        } else if (pendingTx.kind === WagerTransactionKind.Rollback) {
          if (refTx.status !== WagerTransactionStatus.Processed) {
            pendingTx.reject(FailureCode.REFERENCE_INVALID_STATE, now);
            await innerTxRepo.save(pendingTx);
            return;
          }

          // Checar se já foi revertido
          const existingRollback = await txEm.findOne(WagerTransactionOrmEntity, {
            referenceTransactionId: refTx.id,
            kind: WagerTransactionKind.Rollback,
            status: WagerTransactionStatus.Processed,
          });

          if (existingRollback) {
            pendingTx.reject(FailureCode.REFERENCE_ALREADY_REVERSED, now);
            await innerTxRepo.save(pendingTx);
            return;
          }

          const targetDirection = pendingTx.ledgerDirectionFor(refTx);

          if (targetDirection === LedgerDirection.Debit) {
            if (wallet.balance.isLessThan(pendingTx.money)) {
              pendingTx.reject(FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE, now);
              await innerTxRepo.save(pendingTx);
              return;
            }
            ledgerEntry = wallet.debit(pendingTx.money, pendingTx.id, uuidv4(), now);
          } else {
            ledgerEntry = wallet.credit(pendingTx.money, pendingTx.id, uuidv4(), now);
          }

          pendingTx.markProcessed(refTx.id, now);
        }

        await innerWalletRepo.save(wallet);
        await innerTxRepo.save(pendingTx);

        if (ledgerEntry) {
          await innerLedgerRepo.save(ledgerEntry);
          const balanceChanged = WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx);
          await innerOutboxRepo.save(OutboxMessage.enqueue(balanceChanged));
        }

        const processedEvent = WagerTransactionProcessed.from(
          pendingTx,
          wallet.balance.toJSON(),
          eventCtx,
        );
        await innerOutboxRepo.save(OutboxMessage.enqueue(processedEvent));

        processedCount++;
      });
    }

    return processedCount;
  }
}
