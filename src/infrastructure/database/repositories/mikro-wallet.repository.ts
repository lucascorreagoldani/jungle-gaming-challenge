import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { IWalletRepository } from "../../../domain/repositories/repository.ports";
import { Wallet } from "../../../domain/models/wallet.entity";
import { WalletOrmEntity } from "../entities/wallet.orm-entity";

export class MikroWalletRepository implements IWalletRepository {
  constructor(private readonly em: EntityManager) { }

  async findById(id: string, lock?: "pessimistic_write"): Promise<Wallet | null> {
    const lockMode = lock === "pessimistic_write" ? LockMode.PESSIMISTIC_WRITE : undefined;
    const entity = await this.em.findOne(
      WalletOrmEntity,
      { id },
      { lockMode },
    );

    return entity ? entity.toDomain() : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletOrmEntity, { playerId, currency });
    return entity ? entity.toDomain() : null;
  }

  async save(wallet: Wallet): Promise<void> {
    const existing = await this.em.findOne(WalletOrmEntity, { id: wallet.id });
    if (existing) {
      existing.balance = wallet.balance.toString();
      existing.version = wallet.version;
      existing.updatedAt = wallet.updatedAt;
      this.em.persist(existing);
    } else {
      const entity = WalletOrmEntity.fromDomain(wallet);
      this.em.persist(entity);
    }
  }
}
