import { EntityManager } from "@mikro-orm/postgresql";
import { v4 as uuidv4 } from "uuid";
import {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from "../dtos/wagering.dto";
import { Money } from "../../domain/value-objects/money.vo";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/models/wager-transaction.entity";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/models/wallet-ledger-entry.entity";
import { InboxMessage } from "../../domain/models/inbox-message.entity";
import { OutboxMessage } from "../../domain/models/outbox-message.entity";
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/events/integration-events";
import { MikroWalletRepository } from "../../infrastructure/database/repositories/mikro-wallet.repository";
import { MikrowagerTransactionRepository } from "../../infrastructure/database/repositories/mikro-wager-transaction.repository";
import { MikroWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-wallet-ledger.repository";
import { MikroInboxRepository } from "../../infrastructure/database/repositories/mikro-inbox.repository";
import { MikroOutboxRepository } from "../../infrastructure/database/repositories/mikro-outbox.repository";
import { WalletLedgerEntryOrmEntity } from "../../infrastructure/database/entities/wallet-ledger-entry.orm-entity";
import { WagerTransactionOrmEntity } from "../../infrastructure/database/entities/wager-transaction.orm-entity";
import {
  CurrencyMismatchError,
  DomainError,
  FailureCode,
  IdempotencyConflictError,
  WalletNotFoundError,
} from "../../domain/errors/domain.error";
import { hashCanonicalPayload } from "../utils/canonical-json";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly metricsService?: MetricsService,
    private readonly logger?: StructuredLoggerService,
  ) { }

  async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionOutput> {
    const startTime = performance.now();
    const money = Money.from(input.money);
    const now = new Date();
    const correlationId = input.correlationId || uuidv4();

    // 1. JSON Canônico do subconjunto de negócio para hash determinístico
    const businessPayload = {
      externalTransactionId: input.externalTransactionId,
      gameId: input.gameId,
      kind: input.kind,
      money: {
        amount: money.toString(),
        currency: money.currency,
      },
      playerId: input.playerId,
      providerId: input.providerId,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      roundId: input.roundId,
      walletId: input.walletId,
    };
    const payloadHash = hashCanonicalPayload(businessPayload);

    try {
      const output = await this.em.transactional(async (txEm) => {
        const walletRepo = new MikroWalletRepository(txEm);
        const txRepo = new MikrowagerTransactionRepository(txEm);
        const ledgerRepo = new MikroWalletLedgerRepository(txEm);
        const inboxRepo = new MikroInboxRepository(txEm);
        const outboxRepo = new MikroOutboxRepository(txEm);

        // 2. Lock Pessimista na Carteira (SELECT ... FOR UPDATE no PostgreSQL)
        // A unidade de concorrência é a walletId: bloqueia imediatamente para garantir
        // que verificações de saldo e checagens de idempotência concorrentes sejam estritamente serializadas.
        const wallet = await walletRepo.findById(input.walletId, "pessimistic_write");
        if (!wallet) {
          throw new WalletNotFoundError(input.walletId);
        }

        if (wallet.playerId !== input.playerId) {
          throw new DomainError(
            `Wallet '${input.walletId}' does not belong to player '${input.playerId}'`,
            FailureCode.INVALID_PAYLOAD,
          );
        }

        if (wallet.currency !== money.currency) {
          throw new CurrencyMismatchError(
            `Wallet currency '${wallet.currency}' does not match operation currency '${money.currency}'`,
          );
        }

        // 3. Inbox deduplication para mensagens vindas do SQS
        let inboxMessage: InboxMessage | null = null;
        if (input.inboxMessageId) {
          const consumerName = input.consumerName || "wager-consumer";
          inboxMessage = await inboxRepo.findByMessageId(consumerName, input.inboxMessageId);

          if (inboxMessage && inboxMessage.isProcessed()) {
            const existingTx = await txRepo.findByIdempotencyKey(input.idempotencyKey);
            if (existingTx) {
              return {
                transactionId: existingTx.id,
                status: existingTx.status,
                balance: wallet.balance.toJSON(),
                idempotentReplay: true,
                failureCode: existingTx.failureCode,
              };
            }
          }

          if (!inboxMessage) {
            inboxMessage = InboxMessage.receive({
              consumerName,
              messageId: input.inboxMessageId,
              payloadHash,
              receivedAt: now,
            });
          }
        }

        // 4. Checagem de Idempotência Persistente por Idempotency-Key (protegida pelo lock da carteira)
        const existingByKey = await txRepo.findByIdempotencyKey(input.idempotencyKey);
        if (existingByKey) {
          // Se a mesma chave foi usada com payload diferente -> 409 CONFLICT
          if (!existingByKey.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }

          // Requisição idêntica -> Retornar o resultado original e o saldo observado naquele momento
          let observedBalance = input.money;
          const ledgerEntry = await txEm.findOne(WalletLedgerEntryOrmEntity, {
            transactionId: existingByKey.id,
          });

          if (ledgerEntry) {
            observedBalance = { amount: ledgerEntry.balanceAfter, currency: ledgerEntry.currency };
          } else {
            observedBalance = wallet.balance.toJSON();
          }

          if (inboxMessage && !inboxMessage.isProcessed()) {
            inboxMessage.markProcessed(now);
            await inboxRepo.save(inboxMessage);
          }

          return {
            transactionId: existingByKey.id,
            status: existingByKey.status,
            balance: observedBalance,
            idempotentReplay: true,
            failureCode: existingByKey.failureCode,
          };
        }

        // Checagem se (providerId, externalTransactionId) já existe sob outra idempotency key
        const existingByExternal = await txRepo.findByExternalId(
          input.providerId,
          input.externalTransactionId,
        );
        if (existingByExternal) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }

        // 5. Instanciar a WagerTransaction (nasce em PENDING)
        const txId = uuidv4();
        const wagerTx = WagerTransaction.create({
          id: txId,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          walletId: wallet.id,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: now,
        });

        const eventContext = {
          eventId: uuidv4(),
          correlationId,
          causationId: input.causationId,
          occurredAt: now,
        };

        let ledgerEntry: WalletLedgerEntry | undefined;

        // 6. Processamento conforme o Kind de Transação
        switch (input.kind) {
          case WagerTransactionKind.Bet: {
            // Validação de saldo suficiente
            if (wallet.balance.isLessThan(money)) {
              wagerTx.reject(FailureCode.INSUFFICIENT_FUNDS, now);
              await txRepo.save(wagerTx);

              const rejectedEvent = WagerTransactionRejected.from(
                wagerTx,
                FailureCode.INSUFFICIENT_FUNDS,
                eventContext,
              );
              await outboxRepo.save(OutboxMessage.enqueue(rejectedEvent));

              if (inboxMessage) {
                inboxMessage.markProcessed(now);
                await inboxRepo.save(inboxMessage);
              }

              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.INSUFFICIENT_FUNDS,
              };
            }

            ledgerEntry = wallet.debit(money, wagerTx.id, uuidv4(), now);
            wagerTx.markProcessed(undefined, now);
            break;
          }

          case WagerTransactionKind.Win: {
            let refTxId: string | undefined;
            if (input.referenceExternalTransactionId) {
              const refTx = await txRepo.findByExternalId(
                input.providerId,
                input.referenceExternalTransactionId,
              );
              refTxId = refTx?.id;
            }

            ledgerEntry = wallet.credit(money, wagerTx.id, uuidv4(), now);
            wagerTx.markProcessed(refTxId, now);
            break;
          }

          case WagerTransactionKind.Loss: {
            // LOSS não afeta saldo nem gera ledger
            wagerTx.markProcessed(undefined, now);
            break;
          }

          case WagerTransactionKind.Refund: {
            const refTx = await txRepo.findByExternalId(
              input.providerId,
              input.referenceExternalTransactionId!,
            );

            // Referência ausente -> PENDING_REFERENCE
            if (!refTx) {
              wagerTx.markPendingReference();
              await txRepo.save(wagerTx);

              const pendingEvent = WagerTransactionPendingReference.from(wagerTx, eventContext);
              await outboxRepo.save(OutboxMessage.enqueue(pendingEvent));

              if (inboxMessage) {
                inboxMessage.markProcessed(now);
                await inboxRepo.save(inboxMessage);
              }

              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.PendingReference,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            }

            // Validações da referência
            if (
              refTx.providerId !== input.providerId ||
              refTx.playerId !== input.playerId ||
              refTx.walletId !== input.walletId ||
              refTx.roundId !== input.roundId ||
              refTx.money.currency !== money.currency
            ) {
              wagerTx.reject(FailureCode.REFERENCE_MISMATCH, now);
              await txRepo.save(wagerTx);
              await outboxRepo.save(
                OutboxMessage.enqueue(
                  WagerTransactionRejected.from(wagerTx, FailureCode.REFERENCE_MISMATCH, eventContext),
                ),
              );

              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.REFERENCE_MISMATCH,
              };
            }

            if (refTx.kind !== WagerTransactionKind.Bet || refTx.status !== WagerTransactionStatus.Processed) {
              wagerTx.reject(FailureCode.REFERENCE_INVALID_STATE, now);
              await txRepo.save(wagerTx);
              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.REFERENCE_INVALID_STATE,
              };
            }

            if (!refTx.money.equals(money)) {
              wagerTx.reject(FailureCode.INVALID_PAYLOAD, now);
              await txRepo.save(wagerTx);
              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.INVALID_PAYLOAD,
              };
            }

            // Checar se já foi revertido por outro REFUND
            const existingRefund = await txEm.findOne(WagerTransactionOrmEntity, {
              referenceTransactionId: refTx.id,
              kind: WagerTransactionKind.Refund,
              status: WagerTransactionStatus.Processed,
            });

            if (existingRefund) {
              wagerTx.reject(FailureCode.REFERENCE_ALREADY_REVERSED, now);
              await txRepo.save(wagerTx);
              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
              };
            }

            ledgerEntry = wallet.credit(money, wagerTx.id, uuidv4(), now);
            wagerTx.markProcessed(refTx.id, now);
            break;
          }

          case WagerTransactionKind.Rollback: {
            const refTx = await txRepo.findByExternalId(
              input.providerId,
              input.referenceExternalTransactionId!,
            );

            // Referência ausente -> PENDING_REFERENCE
            if (!refTx) {
              wagerTx.markPendingReference();
              await txRepo.save(wagerTx);

              const pendingEvent = WagerTransactionPendingReference.from(wagerTx, eventContext);
              await outboxRepo.save(OutboxMessage.enqueue(pendingEvent));

              if (inboxMessage) {
                inboxMessage.markProcessed(now);
                await inboxRepo.save(inboxMessage);
              }

              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.PendingReference,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            }

            // Validações da referência
            if (
              refTx.providerId !== input.providerId ||
              refTx.playerId !== input.playerId ||
              refTx.walletId !== input.walletId ||
              refTx.roundId !== input.roundId ||
              refTx.money.currency !== money.currency
            ) {
              wagerTx.reject(FailureCode.REFERENCE_MISMATCH, now);
              await txRepo.save(wagerTx);
              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.REFERENCE_MISMATCH,
              };
            }

            if (refTx.status !== WagerTransactionStatus.Processed) {
              wagerTx.reject(FailureCode.REFERENCE_INVALID_STATE, now);
              await txRepo.save(wagerTx);
              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.REFERENCE_INVALID_STATE,
              };
            }

            // Checar se já foi revertido por outro ROLLBACK
            const existingRollback = await txEm.findOne(WagerTransactionOrmEntity, {
              referenceTransactionId: refTx.id,
              kind: WagerTransactionKind.Rollback,
              status: WagerTransactionStatus.Processed,
            });

            if (existingRollback) {
              wagerTx.reject(FailureCode.REFERENCE_ALREADY_REVERSED, now);
              await txRepo.save(wagerTx);
              return {
                transactionId: wagerTx.id,
                status: WagerTransactionStatus.Rejected,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
              };
            }

            const targetDirection = wagerTx.ledgerDirectionFor(refTx);

            if (targetDirection === LedgerDirection.Debit) {
              // Regra 9: Reversão que produziria saldo negativo é rejeitada com código específico
              if (wallet.balance.isLessThan(money)) {
                wagerTx.reject(FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE, now);
                await txRepo.save(wagerTx);

                const rejectedEvent = WagerTransactionRejected.from(
                  wagerTx,
                  FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
                  eventContext,
                );
                await outboxRepo.save(OutboxMessage.enqueue(rejectedEvent));

                return {
                  transactionId: wagerTx.id,
                  status: WagerTransactionStatus.Rejected,
                  balance: wallet.balance.toJSON(),
                  idempotentReplay: false,
                  failureCode: FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
                };
              }

              ledgerEntry = wallet.debit(money, wagerTx.id, uuidv4(), now);
            } else {
              ledgerEntry = wallet.credit(money, wagerTx.id, uuidv4(), now);
            }

            wagerTx.markProcessed(refTx.id, now);
            break;
          }

          default:
            throw new DomainError(`Unsupported transaction kind '${input.kind}'`, FailureCode.INVALID_OPERATION);
        }

        // 7. Salvar entidades modificadas
        await walletRepo.save(wallet);
        await txRepo.save(wagerTx);

        if (ledgerEntry) {
          await ledgerRepo.save(ledgerEntry);
        }

        // 8. Publicar eventos na Outbox
        const processedEvent = WagerTransactionProcessed.from(
          wagerTx,
          wallet.balance.toJSON(),
          eventContext,
        );
        await outboxRepo.save(OutboxMessage.enqueue(processedEvent));

        if (ledgerEntry) {
          const balanceChangedEvent = WalletBalanceChanged.from(wallet, ledgerEntry, eventContext);
          await outboxRepo.save(OutboxMessage.enqueue(balanceChangedEvent));
        }

        // 9. Marcar Inbox como processado (quando originado por mensageria)
        if (inboxMessage) {
          inboxMessage.markProcessed(now);
          await inboxRepo.save(inboxMessage);
        }

        return {
          transactionId: wagerTx.id,
          status: wagerTx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      });

      const durationMs = performance.now() - startTime;
      this.metricsService?.recordLatency(durationMs);
      this.metricsService?.incrementTransaction(output.status);
      if (output.idempotentReplay) {
        this.metricsService?.incrementDuplicate();
      }

      this.logger?.log("Wagering transaction processed", {
        correlationId,
        transactionId: output.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        status: output.status,
        durationMs: Number(durationMs.toFixed(2)),
      });

      return output;
    } catch (err: any) {
      const durationMs = performance.now() - startTime;
      this.metricsService?.recordLatency(durationMs);
      this.metricsService?.incrementTransaction("FAILED");
      this.logger?.error("Wagering transaction failed with exception", err?.stack, {
        correlationId,
        walletId: input.walletId,
        providerId: input.providerId,
        errorMessage: err?.message,
      });
      throw err;
    }
  }
}
