import { EntityManager } from "@mikro-orm/postgresql";
import { ReconciliationOutput } from "../dtos/wagering.dto";
import { MikroWalletRepository } from "../../infrastructure/database/repositories/mikro-wallet.repository";
import { MikroWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-wallet-ledger.repository";
import { WalletNotFoundError } from "../../domain/errors/domain.error";

export class ReconcileWalletUseCase {
  constructor(private readonly em: EntityManager) { }

  async execute(walletId: string): Promise<ReconciliationOutput> {
    const walletRepo = new MikroWalletRepository(this.em);
    const ledgerRepo = new MikroWalletLedgerRepository(this.em);

    const wallet = await walletRepo.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const { totalCredits, totalDebits, count } = await ledgerRepo.sumByWalletId(
      walletId,
      wallet.currency,
    );

    // Saldo calculado = soma de créditos - soma de débitos
    const calculatedBalance = totalCredits.subtract(totalDebits);
    const difference = wallet.balance.subtract(calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      // Divergências não são corrigidas silenciosamente: devem ser logadas e sinalizadas
      console.warn(
        `[RECONCILIATION_MISMATCH] Wallet '${walletId}' has inconsistent balance! Stored: ${wallet.balance.toString()}, Calculated: ${calculatedBalance.toString()}, Diff: ${difference.toString()}`,
      );
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: count,
    };
  }
}
