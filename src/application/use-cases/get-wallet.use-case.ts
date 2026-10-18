import { EntityManager } from "@mikro-orm/postgresql";
import { MikroWalletRepository } from "../../infrastructure/database/repositories/mikro-wallet.repository";
import { WalletNotFoundError } from "../../domain/errors/domain.error";
import { MoneyProps } from "../../domain/value-objects/money.vo";

export interface GetWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class GetWalletUseCase {
  constructor(private readonly em: EntityManager) { }

  async execute(walletId: string): Promise<GetWalletOutput> {
    const walletRepo = new MikroWalletRepository(this.em);
    const wallet = await walletRepo.findById(walletId);

    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}
