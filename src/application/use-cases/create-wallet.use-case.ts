import { EntityManager } from "@mikro-orm/postgresql";
import { v4 as uuidv4 } from "uuid";
import { CreateWalletInput, CreateWalletOutput } from "../dtos/wagering.dto";
import { Money } from "../../domain/value-objects/money.vo";
import { Wallet } from "../../domain/models/wallet.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/models/wager-transaction.entity";
import { WalletLedgerEntry, LedgerDirection } from "../../domain/models/wallet-ledger-entry.entity";
import { OutboxMessage } from "../../domain/models/outbox-message.entity";
import { WalletBalanceChanged } from "../../domain/events/integration-events";
import { MikroWalletRepository } from "../../infrastructure/database/repositories/mikro-wallet.repository";
import { MikrowagerTransactionRepository } from "../../infrastructure/database/repositories/mikro-wager-transaction.repository";
import { MikroWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-wallet-ledger.repository";
import { MikroOutboxRepository } from "../../infrastructure/database/repositories/mikro-outbox.repository";
import { DomainError, FailureCode } from "../../domain/errors/domain.error";
import { hashCanonicalPayload } from "../utils/canonical-json";

export class DuplicateWalletError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      `Wallet already exists for player '${playerId}' and currency '${currency}'`,
      FailureCode.INVALID_OPERATION,
    );
  }
}

export class CreateWalletUseCase {
  constructor(private readonly em: EntityManager) { }

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const initialMoney = Money.from(input.initialBalance);

    return await this.em.transactional(async (txEm) => {
      const walletRepo = new MikroWalletRepository(txEm);
      const txRepo = new MikrowagerTransactionRepository(txEm);
      const ledgerRepo = new MikroWalletLedgerRepository(txEm);
      const outboxRepo = new MikroOutboxRepository(txEm);

      // Invariante: no máximo uma wallet por playerId + currency
      const existing = await walletRepo.findByPlayerAndCurrency(input.playerId, initialMoney.currency);
      if (existing) {
        throw new DuplicateWalletError(input.playerId, initialMoney.currency);
      }

      const walletId = uuidv4();
      const now = new Date();

      const wallet = Wallet.open({
        id: walletId,
        playerId: input.playerId,
        initialBalance: initialMoney,
        createdAt: now,
      });

      await walletRepo.save(wallet);

      // O saldo inicial, quando maior que zero, gera uma transação interna OPENING
      // na mesma transação SQL, com lançamento CREDIT correspondente no ledger.
      if (!initialMoney.isZero()) {
        const openingTxId = uuidv4();
        const openingEntryId = uuidv4();
        const idempotencyKey = `internal:opening:${walletId}`;
        const payloadHash = hashCanonicalPayload({
          walletId,
          playerId: input.playerId,
          kind: WagerTransactionKind.Opening,
          amount: initialMoney.toString(),
          currency: initialMoney.currency,
        });

        const openingTx = WagerTransaction.create({
          id: openingTxId,
          providerId: "internal",
          externalTransactionId: `opening-${walletId}`,
          idempotencyKey,
          payloadHash,
          walletId,
          playerId: input.playerId,
          roundId: "system-opening",
          gameId: "system",
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
          createdAt: now,
        });

        openingTx.markProcessed(undefined, now);
        await txRepo.save(openingTx);

        const ledgerEntry = WalletLedgerEntry.create({
          id: openingEntryId,
          walletId,
          transactionId: openingTxId,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: Money.zero(initialMoney.currency),
          balanceAfter: initialMoney,
          createdAt: now,
        });

        await ledgerRepo.save(ledgerEntry);

        const balanceChangedEvent = WalletBalanceChanged.from(wallet, ledgerEntry, {
          eventId: uuidv4(),
          correlationId: `opening-${walletId}`,
          occurredAt: now,
        });

        await outboxRepo.save(OutboxMessage.enqueue(balanceChangedEvent));
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
