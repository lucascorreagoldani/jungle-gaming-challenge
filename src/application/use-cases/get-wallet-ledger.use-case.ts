import { EntityManager } from "@mikro-orm/postgresql";
import { MikroWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-wallet-ledger.repository";
import { MoneyProps } from "../../domain/value-objects/money.vo";
import { LedgerDirection } from "../../domain/models/wallet-ledger-entry.entity";

export interface LedgerEntryItem {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface GetWalletLedgerOutput {
  items: LedgerEntryItem[];
  nextCursor?: string;
  hasMore: boolean;
}

export class GetWalletLedgerUseCase {
  constructor(private readonly em: EntityManager) { }

  async execute(walletId: string, cursor?: string, limit = 50): Promise<GetWalletLedgerOutput> {
    const ledgerRepo = new MikroWalletLedgerRepository(this.em);
    const result = await ledgerRepo.findByWalletId(walletId, cursor, limit);

    return {
      items: result.entries.map((e) => ({
        id: e.id,
        walletId: e.walletId,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }
}
